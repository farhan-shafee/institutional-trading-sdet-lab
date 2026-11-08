import { z } from 'zod';
import { Rational } from '../fixed-income-v3/numbers.js';
import {
  economicExecutionSchema,
  tradableInstrumentIds,
  type EconomicExecution,
  type TradableInstrumentId,
} from './economics.js';

export const fifoModel = 'FIFO_DIRTY_USD_V1' as const;
export interface FifoLot {
  readonly opening_execution_id: string;
  readonly instrument_id: TradableInstrumentId;
  readonly side: 'LONG' | 'SHORT';
  readonly remaining_par: Rational;
  readonly remaining_basis_or_proceeds_usd: Rational;
}
export interface FifoResult {
  readonly realized_usd: Rational;
  readonly lots: readonly FifoLot[];
  readonly positions: readonly {
    readonly instrument_id: TradableInstrumentId;
    readonly signed_par: Rational;
  }[];
}
type WorkingLot = { -readonly [K in keyof FifoLot]: FifoLot[K] };
const smaller = (a: Rational, b: Rational): Rational =>
  a.numerator * b.denominator < b.numerator * a.denominator ? a : b;

/** FIFO over already resolved economics; no date inference, intermediate cent rounding or source mutation. */
export function fifo(input: readonly EconomicExecution[]): FifoResult {
  const executions = z.array(economicExecutionSchema).max(8).parse(input);
  if (new Set(executions.map((e) => e.execution_id)).size !== executions.length)
    throw new Error('Duplicate economic execution root.');
  executions.sort((a, b) => {
    const first = BigInt(a.command_seq),
      second = BigInt(b.command_seq);
    if (first !== second) return first < second ? -1 : 1;
    return a.execution_id < b.execution_id ? -1 : a.execution_id > b.execution_id ? 1 : 0;
  });
  const lots: WorkingLot[] = [];
  const positions = new Map<TradableInstrumentId, Rational>();
  let realized = new Rational(0n);
  for (const execution of executions) {
    const par = Rational.decimal(execution.par_amount);
    const cash = new Rational(BigInt(execution.consideration_cents), 100n);
    const openingSide = execution.side === 'BUY' ? 'LONG' : 'SHORT';
    positions.set(
      execution.instrument_id,
      (positions.get(execution.instrument_id) ?? new Rational(0n)).add(
        execution.side === 'BUY' ? par : par.neg(),
      ),
    );
    let remaining = par;
    for (const lot of lots) {
      if (remaining.isZero()) break;
      if (
        lot.instrument_id !== execution.instrument_id ||
        lot.side === openingSide ||
        lot.remaining_par.isZero()
      )
        continue;
      const matched = smaller(remaining, lot.remaining_par);
      const historical = lot.remaining_basis_or_proceeds_usd.mul(matched).div(lot.remaining_par);
      const current = cash.mul(matched).div(par);
      realized = realized.add(
        execution.side === 'SELL' ? current.sub(historical) : historical.sub(current),
      );
      lot.remaining_par = lot.remaining_par.sub(matched);
      lot.remaining_basis_or_proceeds_usd = lot.remaining_basis_or_proceeds_usd.sub(historical);
      remaining = remaining.sub(matched);
    }
    if (!remaining.isZero())
      lots.push({
        opening_execution_id: execution.execution_id,
        instrument_id: execution.instrument_id,
        side: openingSide,
        remaining_par: remaining,
        remaining_basis_or_proceeds_usd: cash.mul(remaining).div(par),
      });
  }
  return Object.freeze({
    realized_usd: realized,
    lots: Object.freeze(
      lots.filter((lot) => !lot.remaining_par.isZero()).map((lot) => Object.freeze({ ...lot })),
    ),
    positions: Object.freeze(
      tradableInstrumentIds.flatMap((instrument_id) => {
        const signed_par = positions.get(instrument_id);
        return signed_par === undefined ? [] : [Object.freeze({ instrument_id, signed_par })];
      }),
    ),
  });
}
