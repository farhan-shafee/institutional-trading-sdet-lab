import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { sandbox, rfqInput, digest } from './rfq-fixture.js';
export type Life = {
  status: string;
  version: string;
  filled_par: string;
  remaining_par: string;
  executed_cents: string;
  execution_count: number;
  pending_cancel_id: string | null;
};
export type Execution = {
  id: string;
  source_event_id: string;
  order_id: string;
  fill_sequence: number;
  par_amount: string;
  consideration_cents: string;
  clean_price: string;
  instrument_revision: string;
  settlement_date: string;
  [key: string]: unknown;
};
export type OrderResult = {
  status: number;
  replayed: boolean;
  body: {
    order_id: string;
    lifecycle: Life;
    execution?: Execution;
    cancellation?: { id: string; state: string };
    error?: { code: string };
  };
};
export async function executionSandbox(
  par = '100.00',
  side = 'BUY',
  instrument = 'SYN-UST-2031',
  date = '2028-02-29',
) {
  const s = await sandbox();
  async function createOrder(
    quantity = par,
    direction = side,
    asset = instrument,
    settlement = date,
  ) {
    const input = {
      ...rfqInput(direction, asset),
      par_amount: quantity,
      settlement_date: settlement,
    };
    assert.equal((await s.command('CREATE_RFQ', input)).status, 201);
    const quoted = await s.command('RESPOND_DEALER', {
      rfq_id: input.rfq_id,
      expected_version: '1',
      dealer_id: 'ATLAS',
      response: 'QUOTE',
    });
    const accepted = await s.command('ACCEPT_QUOTE', {
      rfq_id: input.rfq_id,
      expected_version: '2',
      quote_id: quoted.body.quotes[0]!.id,
    });
    assert.equal(accepted.status, 201);
    return accepted.body.order!.id;
  }
  const order = await createOrder();
  async function command(
    action: string,
    input: Record<string, unknown>,
    key = randomUUID(),
    db: pg.Client = s.app,
    generation = '1',
  ): Promise<OrderResult> {
    const payload = { order_id: order, ...input };
    const result = await db.query<{ result: OrderResult }>(
      'SELECT fi_control.order_command($1,$2,$3,$4,$5,$6,$7,$8) AS result',
      [
        s.id,
        s.proof,
        generation,
        action,
        JSON.stringify(payload),
        digest(JSON.stringify({ action, payload })),
        key,
        s.actor,
      ],
    );
    return result.rows[0]!.result;
  }
  const fill = (
    version: string,
    quantity: string,
    event = randomUUID(),
    extra: Record<string, unknown> = {},
  ) =>
    command('EXECUTE_ORDER', {
      expected_version: version,
      source_event_id: event,
      execution_id: randomUUID(),
      par_amount: quantity,
      ...extra,
    });
  return { ...s, order, createOrder, command, fill };
}
