import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ownedSourceSchema } from '../../app/domain/post-trade/source.js';
import {
  riskAssessmentSchema,
  pnlAssessmentSchema,
  postTradeHistorySchema,
  postTradeAuditSchema,
} from '../../app/domain/post-trade/api-contracts.js';
import type { publicPostTradeHttp } from './http-fixture.js';
import { connection } from '../public-demo/database.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const reportDigest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

/** Test transport adapter only: no application assessment or financial calculations. */
export async function publicWireReport(
  lab: Awaited<ReturnType<typeof publicPostTradeHttp>>,
  token: string,
  path: string,
) {
  async function get(suffix: string) {
    const response = await lab.request(path + suffix, token);
    assert.equal(response.status, 200);
    return (await response.json()) as unknown;
  }
  const source = ownedSourceSchema.parse(await get(''));
  const query =
    '?fixture_id=FLAT_V1&as_of_date=2030-01-15&raw_as_of_seq=' +
    source.raw_command_seq +
    '&posttrade_as_of_seq=' +
    source.posttrade_command_seq;
  const risk = riskAssessmentSchema.parse(await get('/risk' + query)),
    pnl = pnlAssessmentSchema.parse(await get('/pnl' + query));
  assert.equal(risk.status, 'AVAILABLE');
  assert.equal(pnl.status, 'AVAILABLE');
  if (risk.status !== 'AVAILABLE' || pnl.status !== 'AVAILABLE')
    throw new Error('Complete public assessment required.');
  assert.deepEqual(risk.source, pnl.source);
  assert.deepEqual(risk.curve, pnl.curve);
  assert.equal(risk.assessment_id, pnl.assessment_id);
  assert.equal(pnl.source.source_id, reportDigest(source));
  const history = [];
  for (const root of source.roots) {
    const row = postTradeHistorySchema.parse(
      await get('/executions/' + root.execution_id + '/history'),
    );
    assert.deepEqual(row.source, pnl.source);
    history.push(row);
  }
  const events = [];
  let cursor: string | null = null;
  for (let page = 0; page < 2; page++) {
    const result = postTradeAuditSchema.parse(
      await get(
        '/audit-events?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      ),
    );
    assert.deepEqual(result.source, pnl.source);
    assert.equal(result.as_of_seq, source.posttrade_command_seq);
    events.push(...result.events);
    cursor = result.next_cursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null);
  assert.ok(events.length <= 161);
  const bundle = {
    version: 1,
    kind: 'OWNED_POSTTRADE_REPORT_V1',
    scope: 'LOCAL_SYNTHETIC_ONLY',
    source,
    assessment: { ...pnl, risk: risk.risk },
    history,
    events,
  };
  const report = { ...bundle, report_id: reportDigest(bundle) };
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 262144);
  const admin = await connection('admin');
  try {
    await admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const legs = `WITH legs AS (
      SELECT r.instrument_revision,
        (CASE r.side WHEN 'BUY' THEN -1 ELSE 1 END)*v.consideration_cents*(CASE o.outcome WHEN 'SETTLED' THEN 1 WHEN 'REVERSED' THEN -1 ELSE 0 END) AS cash,
        (CASE r.side WHEN 'BUY' THEN 1 ELSE -1 END)*r.par_amount*(CASE o.outcome WHEN 'SETTLED' THEN 1 WHEN 'REVERSED' THEN -1 ELSE 0 END) AS par
      FROM fi.posttrade_settlement_outcomes o JOIN fi.posttrade_roots r USING(sandbox_id,execution_id)
      JOIN fi.posttrade_revisions v USING(sandbox_id,execution_id,revision) WHERE o.sandbox_id=$1)`;
    const cash = (
      await admin.query<{ stored: string; derived: string; events: string; counterparty: string }>(
        legs +
          ` SELECT b.cash_cents::text AS stored,
      (10000000000+COALESCE((SELECT sum(cash) FROM legs),0))::text AS derived,
      (SELECT sum(cash_cents)::text FROM fi.posttrade_events WHERE sandbox_id=$1) AS events,
      b.counterparty_cash_cents::text AS counterparty FROM fi.posttrade_books b WHERE sandbox_id=$1`,
        [source.sandbox_id],
      )
    ).rows[0]!;
    assert.equal(cash.stored, source.available_cash_cents);
    assert.equal(cash.derived, cash.stored);
    assert.equal(cash.events, cash.stored);
    assert.equal(BigInt(cash.counterparty), -BigInt(cash.stored));
    const balances = (
      await admin.query<{
        instrument_revision: string;
        stored: string;
        derived: string;
        events: string;
        balanced: boolean;
      }>(
        legs +
          ` SELECT b.instrument_revision,b.available_par::text AS stored,
      COALESCE((SELECT sum(par) FROM legs WHERE instrument_revision=b.instrument_revision),0)::numeric(14,2)::text AS derived,
      COALESCE((SELECT sum(par_amount) FROM fi.posttrade_events e WHERE e.sandbox_id=b.sandbox_id AND e.instrument_revision=b.instrument_revision),0)::numeric(14,2)::text AS events,
      (b.counterparty_par+b.available_par=0) AS balanced FROM fi.posttrade_security_balances b WHERE b.sandbox_id=$1 ORDER BY b.instrument_revision`,
        [source.sandbox_id],
      )
    ).rows;
    assert.equal(balances.length, 2);
    for (const row of balances) {
      const id = row.instrument_revision === 'phase1-ust-1' ? 'SYN-UST-2031' : 'SYN-CORP-2031';
      // Source quantities allow either "0" or "0.00"; compare exact PostgreSQL numerics.
      assert.equal(
        (
          await admin.query<{ same: boolean }>('SELECT $1::numeric=$2::numeric AS same', [
            row.stored,
            source.available_securities!.find((s) => s.instrument_id === id)!.available_par,
          ])
        ).rows[0]!.same,
        true,
      );
      assert.equal(row.derived, row.stored);
      assert.equal(row.events, row.stored);
      assert.equal(row.balanced, true);
    }
    await admin.query('COMMIT');
  } finally {
    await admin.end();
  }
  return report;
}

export function verifyPublicReports(reports: unknown[]) {
  const input = JSON.stringify(reports);
  if (reports.length < 1 || reports.length > 8 || Buffer.byteLength(input) > 1048576)
    throw new Error('Independent public accounting reconstruction failed: input bound.');
  const result = spawnSync('python3', ['verification/python/posttrade_reconstruct.py'], {
    input,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 262144,
  });
  if (result.status !== 0 || result.error)
    throw new Error('Independent public accounting reconstruction failed: ' + result.stderr, {
      cause: result.error,
    });
  const receipt = JSON.parse(result.stdout) as {
    status: string;
    reports: number;
    financial_events_checked: number;
  };
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.reports, reports.length);
  assert.ok(
    Number.isSafeInteger(receipt.financial_events_checked) && receipt.financial_events_checked > 0,
  );
  return receipt;
}
