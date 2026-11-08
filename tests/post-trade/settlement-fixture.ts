import assert from 'node:assert/strict';
import type pg from 'pg';
import { executionSandbox, randomUUID } from './fixture.js';
export type SettlementRoot = {
  execution_id: string;
  current_revision: number;
  active_consideration_cents: string;
  active_clean_price: string;
  par_amount: string;
  side: string;
  value_date: string;
  busted: boolean;
  settlement_state: string;
};
export type SettlementSource = {
  roots: SettlementRoot[];
  available_cash_cents: string;
  available_securities: { instrument_id: string; available_par: string }[];
  posttrade_command_seq: string;
  processing_date_watermark: string | null;
  coverage: { complete: boolean; reasons: string[] };
};
export async function fundedBook(
  options: {
    parentPar?: string;
    fillPar?: string;
    side?: string;
    instrument?: string;
    dueDate?: string;
    windowStart?: string;
  } = {},
) {
  const parent = options.parentPar ?? '100.00',
    side = options.side ?? 'BUY',
    instrument = options.instrument ?? 'SYN-UST-2031',
    due = options.dueDate ?? '2030-01-15';
  const s = await executionSandbox(parent, side, instrument, due);
  async function post(
    operation: string,
    payload: unknown,
    key: string = randomUUID(),
    db: pg.Client = s.app,
    generation = '1',
    proof = s.proof,
  ) {
    return (
      await db.query<{ r: { status: number; replayed: boolean; body: Record<string, unknown> } }>(
        'SELECT fi_control.posttrade_command($1,$2,$3,$4,$5,$6,$7) r',
        [s.id, proof, generation, operation, JSON.stringify(payload), key, s.actor],
      )
    ).rows[0]!.r;
  }
  async function read(postSeq: string | null = null) {
    return (
      await s.app.query<{ r: { status: number; body: SettlementSource } }>(
        "SELECT fi_control.read_posttrade($1,$2,'trade',1,NULL,$3) r",
        [s.id, s.proof, postSeq],
      )
    ).rows[0]!.r.body;
  }
  async function additional(par: string, direction = 'BUY', asset = instrument, date = due) {
    const id = await s.createOrder(par, direction, asset, date);
    assert.equal(
      (await s.command('ACK_ORDER', { order_id: id, expected_version: '1' })).status,
      200,
    );
    const fill = await s.command('EXECUTE_ORDER', {
      order_id: id,
      expected_version: '2',
      execution_id: randomUUID(),
      source_event_id: randomUUID(),
      par_amount: par,
    });
    assert.equal(fill.status, 201);
    const raw = fill.body.execution!;
    assert.equal((await post('REGISTER', { execution_id: raw.id })).status, 201);
    return raw;
  }
  try {
    assert.equal((await s.command('ACK_ORDER', { expected_version: '1' })).status, 200);
    const fill = await s.fill('2', options.fillPar ?? parent);
    assert.equal(fill.status, 201);
    const raw = fill.body.execution!;
    assert.equal(
      (await post('INITIALIZE', { economic_start_date: options.windowStart ?? due })).status,
      201,
    );
    assert.equal((await post('REGISTER', { execution_id: raw.id })).status, 201);
    return { ...s, raw, post, read, additional };
  } catch (error) {
    await s.close();
    throw error;
  }
}
export function available(source: SettlementSource, instrument = 'SYN-UST-2031') {
  const row = source.available_securities.find((item) => item.instrument_id === instrument);
  assert.ok(row);
  return row.available_par;
}
export function duePayload(executionId: string, revision = 0, processingDate = '2030-01-15') {
  return {
    execution_id: executionId,
    expected_revision: revision,
    processing_date: processingDate,
  };
}
