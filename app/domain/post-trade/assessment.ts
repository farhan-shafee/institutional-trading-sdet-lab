import { createHash } from 'node:crypto';
import type { Decimal } from 'decimal.js';
import {
  curveSnapshot,
  type CurveFixtureId,
  type CurveSnapshot,
} from '../fixed-income-v3/curves.js';
import { curveDefinitionVersions } from '../fixed-income-v3/cash-flows.js';
import { roundCurveMark, NumericalAmbiguityError } from '../fixed-income-v3/analytics.js';
import { Rational, decimal80 } from '../fixed-income-v3/numbers.js';
import {
  aggregateDollarRisk,
  dollarRiskModel,
  dollarRiskWire,
  instrumentDollarRisk,
  type DollarRiskWire,
} from './risk.js';
import { fifo, fifoModel } from './fifo.js';
import {
  economicExecutionSchema,
  tradableInstrumentIds,
  type TradableInstrumentId,
} from './economics.js';
import { ownedSourceSchema, type OwnedPostTradeSnapshot } from './source.js';
import { settlementModel } from './contracts.js';

export const assessmentModel = 'OWNED_PORTFOLIO_ASSESSMENT_V1' as const;
export const assessmentReasons = [
  'POSTTRADE_NOT_INITIALIZED',
  'SOURCE_INCOMPLETE',
  'ROOT_LIMIT_EXCEEDED',
  'UNREGISTERED_EXECUTION',
  'EXECUTION_OUTSIDE_ECONOMIC_WINDOW',
  'SOURCE_CUTOFF_INCOHERENT',
  'UNSUPPORTED_DEFINITION',
  'VALUATION_OUTSIDE_ECONOMIC_WINDOW',
  'VALUATION_BEFORE_VALUE_DATE',
  'SOURCE_ACCOUNTING_MISMATCH',
  'NUMERICAL_AMBIGUITY',
] as const;
export type AssessmentReason = (typeof assessmentReasons)[number];
export interface AssessmentSource {
  readonly source_model_version: 'OWNED_POSTTRADE_SOURCE_V1';
  readonly source_id: string;
  readonly sandbox_id: string;
  readonly generation: string;
  readonly raw_command_seq: string;
  readonly last_execution_command_seq: string;
  readonly posttrade_command_seq: string;
  readonly last_adjustment_seq: string;
  readonly initialized: boolean;
  readonly raw_execution_count: number;
  readonly window: Readonly<NonNullable<OwnedPostTradeSnapshot['window']>> | null;
  readonly processing_date_watermark: string | null;
  readonly balance_basis: 'POSTTRADE_SOURCE_SEQUENCE';
}
interface Common {
  readonly model_version: typeof assessmentModel;
  readonly assessment_id: string;
  readonly source: AssessmentSource;
  readonly curve: CurveSnapshot;
  readonly as_of_date: string;
  readonly currency: 'USD';
  readonly models: {
    readonly risk: typeof dollarRiskModel;
    readonly fifo: typeof fifoModel;
    readonly settlement: typeof settlementModel;
  };
}
export interface PortfolioRisk {
  readonly total: DollarRiskWire;
  readonly instruments: readonly (DollarRiskWire & {
    readonly instrument_id: TradableInstrumentId;
    readonly definition_version: string;
    readonly signed_par: string;
  })[];
}
export interface PortfolioPnl {
  readonly opening_cash_usd: string;
  readonly available_cash_usd: string;
  readonly signed_unsettled_cash_usd: string;
  readonly economic_security_mark_usd: string;
  readonly equity_usd: string;
  readonly realized_pnl_usd: string;
  readonly realized_pnl_exact_usd: { readonly numerator: string; readonly denominator: string };
  readonly unrealized_pnl_usd: string;
  readonly total_pnl_usd: string;
  readonly presentation_rounding_delta_usd: string;
  readonly available_securities: readonly Readonly<
    NonNullable<OwnedPostTradeSnapshot['available_securities']>[number]
  >[];
  readonly lots: readonly {
    readonly opening_execution_id: string;
    readonly instrument_id: TradableInstrumentId;
    readonly side: 'LONG' | 'SHORT';
    readonly remaining_par: string;
    readonly remaining_basis_or_proceeds_exact_usd: {
      readonly numerator: string;
      readonly denominator: string;
    };
  }[];
}
export type Assessment =
  | (Common & { readonly status: 'UNAVAILABLE'; readonly reasons: readonly AssessmentReason[] })
  | (Common & {
      readonly status: 'AVAILABLE';
      readonly risk: PortfolioRisk;
      readonly pnl: PortfolioPnl;
    });
const zero = () => new Rational(0n);
const exact = (value: Rational) =>
  Object.freeze({
    numerator: value.numerator.toString(),
    denominator: value.denominator.toString(),
  });
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Undefined source fact.');
    return encoded;
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]))
      .join(',') +
    '}'
  );
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const tradable = (value: string): value is TradableInstrumentId =>
  tradableInstrumentIds.some((id) => id === value);
function nextCoupon(start: string): string {
  const year = Number(start.slice(0, 4));
  for (const candidate of [year + '-01-15', year + '-07-15', year + 1 + '-01-15'])
    if (candidate > start) return candidate;
  throw new Error('Missing next contractual coupon.');
}
const weekday = (date: string) => {
  const day = new Date(date + 'T00:00:00.000Z').getUTCDay();
  return day !== 0 && day !== 6;
};
const money = (value: Decimal) => roundCurveMark(value, decimal80('1e-50'));

export function ownedSourceIdentity(input: OwnedPostTradeSnapshot): AssessmentSource {
  const snapshot = ownedSourceSchema.parse(input);
  return Object.freeze({
    source_model_version: snapshot.model_version,
    source_id: digest(snapshot),
    sandbox_id: snapshot.sandbox_id,
    generation: snapshot.generation,
    raw_command_seq: snapshot.raw_command_seq,
    last_execution_command_seq: snapshot.last_execution_command_seq,
    posttrade_command_seq: snapshot.posttrade_command_seq,
    last_adjustment_seq: snapshot.last_adjustment_seq,
    initialized: snapshot.initialized,
    raw_execution_count: snapshot.raw_execution_count,
    window: snapshot.window ? Object.freeze({ ...snapshot.window }) : null,
    processing_date_watermark: snapshot.processing_date_watermark,
    balance_basis: 'POSTTRADE_SOURCE_SEQUENCE',
  });
}

/** Internal assessment of a validated server-owned SQL snapshot; HTTP accepts only fixture/date/cutoffs. */
export function assessOwned(
  input: OwnedPostTradeSnapshot,
  fixtureId: CurveFixtureId,
  asOf: string,
): Assessment {
  const snapshot = ownedSourceSchema.parse(input),
    curve = curveSnapshot(fixtureId, asOf);
  const source = ownedSourceIdentity(snapshot);
  const common: Common = Object.freeze({
    model_version: assessmentModel,
    assessment_id: digest({
      model: assessmentModel,
      source_id: source.source_id,
      curve_snapshot_id: curve.snapshot_id,
      risk: dollarRiskModel,
      fifo: fifoModel,
      settlement: settlementModel,
    }),
    source,
    curve,
    as_of_date: asOf,
    currency: 'USD',
    models: Object.freeze({ risk: dollarRiskModel, fifo: fifoModel, settlement: settlementModel }),
  });
  const reasons = new Set<AssessmentReason>(snapshot.coverage.reasons);
  const unavailable = (): Assessment =>
    Object.freeze({
      ...common,
      status: 'UNAVAILABLE',
      reasons: Object.freeze([...reasons].sort()),
    });
  if (!snapshot.initialized) reasons.add('POSTTRADE_NOT_INITIALIZED');
  if (!snapshot.coverage.complete) reasons.add('SOURCE_INCOMPLETE');
  if (snapshot.raw_execution_count > 8 || snapshot.inventory_truncated)
    reasons.add('ROOT_LIMIT_EXCEEDED');
  if (snapshot.roots.length !== snapshot.raw_execution_count) reasons.add('SOURCE_INCOMPLETE');
  if (
    new Set(snapshot.roots.map((root) => root.execution_id)).size !== snapshot.roots.length ||
    new Set(snapshot.roots.map((root) => root.command_seq)).size !== snapshot.roots.length
  )
    reasons.add('SOURCE_INCOMPLETE');
  if (BigInt(snapshot.last_adjustment_seq) > BigInt(snapshot.posttrade_command_seq))
    reasons.add('SOURCE_CUTOFF_INCOHERENT');
  const lastExecution = snapshot.roots.reduce(
    (last, root) => (BigInt(root.command_seq) > last ? BigInt(root.command_seq) : last),
    0n,
  );
  if (
    !snapshot.inventory_truncated &&
    lastExecution !== BigInt(snapshot.last_execution_command_seq)
  )
    reasons.add('SOURCE_INCOMPLETE');
  const window = snapshot.window;
  if (
    snapshot.initialized &&
    (!window ||
      snapshot.opening_cash_cents === null ||
      snapshot.available_cash_cents === null ||
      snapshot.available_securities === null)
  )
    reasons.add('SOURCE_INCOMPLETE');
  if (window) {
    if (window.end !== nextCoupon(window.start)) reasons.add('SOURCE_INCOMPLETE');
    if (asOf < window.start || asOf >= window.end) reasons.add('VALUATION_OUTSIDE_ECONOMIC_WINDOW');
    if (
      snapshot.processing_date_watermark !== null &&
      (!weekday(snapshot.processing_date_watermark) ||
        snapshot.processing_date_watermark < window.start ||
        snapshot.processing_date_watermark >= window.end)
    )
      reasons.add('SOURCE_INCOMPLETE');
  }
  for (const root of snapshot.roots) {
    if (!root.registered) reasons.add('UNREGISTERED_EXECUTION');
    if (
      root.registration_seq === null ||
      root.current_revision === null ||
      root.active_consideration_cents === null ||
      root.active_clean_price === null ||
      root.settlement_state === null
    )
      reasons.add('SOURCE_INCOMPLETE');
    if (
      !tradable(root.instrument_id) ||
      root.definition_version !== curveDefinitionVersions[root.instrument_id]
    )
      reasons.add('UNSUPPORTED_DEFINITION');
    if (
      BigInt(root.command_seq) > BigInt(snapshot.raw_command_seq) ||
      (root.registration_seq !== null &&
        BigInt(root.registration_seq) > BigInt(snapshot.posttrade_command_seq))
    )
      reasons.add('SOURCE_CUTOFF_INCOHERENT');
    if (root.busted !== (root.settlement_state === 'VOIDED')) reasons.add('SOURCE_INCOMPLETE');
    if (
      !weekday(root.value_date) ||
      (window && (root.value_date < window.start || root.value_date >= window.end))
    )
      reasons.add('EXECUTION_OUTSIDE_ECONOMIC_WINDOW');
    if (!root.busted && root.value_date > asOf) reasons.add('VALUATION_BEFORE_VALUE_DATE');
  }
  if (reasons.size) return unavailable();
  // Admission above proves each active row is registered, supported and complete;
  // the shared economic parser independently checks all financial bounds/versions.
  const active = snapshot.roots
    .filter((root) => !root.busted)
    .map((root) =>
      economicExecutionSchema.parse({
        execution_id: root.execution_id,
        command_seq: root.command_seq,
        instrument_id: root.instrument_id,
        definition_version: root.definition_version,
        side: root.side,
        par_amount: root.par_amount,
        consideration_cents: root.active_consideration_cents,
        value_date: root.value_date,
        revision: root.current_revision,
      }),
    );
  const inventory = fifo(active),
    opening = new Rational(BigInt(snapshot.opening_cash_cents!), 100n),
    availableCash = new Rational(BigInt(snapshot.available_cash_cents!), 100n);
  let economicCash = zero(),
    settledCash = zero();
  const settledPar = new Map<TradableInstrumentId, Rational>(
    tradableInstrumentIds.map((id) => [id, zero()]),
  );
  for (const root of active) {
    const sign = root.side === 'BUY' ? 1n : -1n;
    const cash = new Rational(-sign * BigInt(root.consideration_cents), 100n);
    economicCash = economicCash.add(cash);
    const state = snapshot.roots.find(
      (row) => row.execution_id === root.execution_id,
    )!.settlement_state;
    if (state === 'SETTLED') {
      settledCash = settledCash.add(cash);
      settledPar.set(
        root.instrument_id,
        settledPar
          .get(root.instrument_id)!
          .add(Rational.decimal(root.par_amount).mul(new Rational(sign))),
      );
    }
  }
  const unsettledCash = economicCash.sub(settledCash);
  if (!availableCash.add(unsettledCash).sub(opening.add(economicCash)).isZero())
    reasons.add('SOURCE_ACCOUNTING_MISMATCH');
  for (const account of snapshot.available_securities!)
    if (
      !Rational.decimal(account.available_par).sub(settledPar.get(account.instrument_id)!).isZero()
    )
      reasons.add('SOURCE_ACCOUNTING_MISMATCH');
  let openBasis = zero();
  for (const lot of inventory.lots)
    openBasis = openBasis.add(
      lot.side === 'LONG'
        ? lot.remaining_basis_or_proceeds_usd
        : lot.remaining_basis_or_proceeds_usd.neg(),
    );
  if (!economicCash.add(openBasis).sub(inventory.realized_usd).isZero())
    reasons.add('SOURCE_ACCOUNTING_MISMATCH');
  if (reasons.size) return unavailable();
  try {
    const vectors = tradableInstrumentIds.map((instrument_id) => {
      const signedPar =
        inventory.positions.find((position) => position.instrument_id === instrument_id)
          ?.signed_par ?? zero();
      return {
        instrument_id,
        signedPar,
        vector: instrumentDollarRisk(curve, instrument_id, signedPar),
      };
    });
    const total = aggregateDollarRisk(vectors.map((item) => item.vector));
    const unrealized = total.pv.sub(openBasis.toDecimal());
    const pnl = total.pv.add(economicCash.toDecimal());
    const equity = availableCash.toDecimal().add(unsettledCash.toDecimal()).add(total.pv);
    const realizedWire = inventory.realized_usd.fixed(2),
      unrealizedWire = money(unrealized),
      pnlWire = money(pnl);
    const presentation = Rational.decimal(pnlWire)
      .sub(Rational.decimal(realizedWire))
      .sub(Rational.decimal(unrealizedWire));
    return Object.freeze({
      ...common,
      status: 'AVAILABLE',
      risk: Object.freeze({
        total: dollarRiskWire(total),
        instruments: Object.freeze(
          vectors.map((item) =>
            Object.freeze({
              instrument_id: item.instrument_id,
              definition_version: curveDefinitionVersions[item.instrument_id],
              signed_par: item.signedPar.fixed(2),
              ...dollarRiskWire(item.vector),
            }),
          ),
        ),
      }),
      pnl: Object.freeze({
        opening_cash_usd: opening.fixed(2),
        available_cash_usd: availableCash.fixed(2),
        signed_unsettled_cash_usd: unsettledCash.fixed(2),
        economic_security_mark_usd: money(total.pv),
        equity_usd: money(equity),
        realized_pnl_usd: realizedWire,
        realized_pnl_exact_usd: exact(inventory.realized_usd),
        unrealized_pnl_usd: unrealizedWire,
        total_pnl_usd: pnlWire,
        presentation_rounding_delta_usd: presentation.fixed(2),
        available_securities: Object.freeze(
          snapshot.available_securities!.map((account) =>
            Object.freeze({
              ...account,
              available_par: Rational.decimal(account.available_par).fixed(2),
            }),
          ),
        ),
        lots: Object.freeze(
          inventory.lots.map((lot) =>
            Object.freeze({
              opening_execution_id: lot.opening_execution_id,
              instrument_id: lot.instrument_id,
              side: lot.side,
              remaining_par: lot.remaining_par.fixed(2),
              remaining_basis_or_proceeds_exact_usd: exact(lot.remaining_basis_or_proceeds_usd),
            }),
          ),
        ),
      }),
    });
  } catch (error) {
    if (!(error instanceof NumericalAmbiguityError)) throw error;
    reasons.add('NUMERICAL_AMBIGUITY');
    return unavailable();
  }
}
