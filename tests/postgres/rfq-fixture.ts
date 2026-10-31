import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { connection } from './harness.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export type RfqDetail = {
  rfq: { id: string; version: string; state: string; accepted_quote_id: string | null };
  invitations: { dealer_id: string; state: string }[];
  quotes: {
    id: string;
    dealer_id: string;
    status: string;
    bid_clean_price: string;
    ask_clean_price: string;
    snapshot: Record<string, unknown>;
  }[];
  order: null | { id: string; status: string; contract: Record<string, unknown> };
};
export type RfqResult = {
  status: number;
  replayed: boolean;
  body: RfqDetail & { error?: { code: string } };
};
export function rfqInput(side = 'BUY', instrument = 'SYN-UST-2031') {
  return {
    rfq_id: randomUUID(),
    instrument_id: instrument,
    side,
    par_amount: '1000000.25',
    settlement_date: '2028-02-29',
    invited_dealers: ['ATLAS', 'BIRCH', 'CEDAR'],
  };
}
export async function sandbox() {
  const app = await connection('app');
  const id = randomUUID(),
    proof = digest('trade-' + id),
    actor = randomUUID();
  const created = await app.query<{ result: { status: number } }>(
    'SELECT fi_control.create_sandbox($1,$2,$3,$4,$5,$6) AS result',
    [id, digest('read-' + id), proof, digest('create-' + id), randomUUID(), actor],
  );
  assert.equal(created.rows[0]?.result.status, 201);
  async function command(
    action: string,
    payload: unknown,
    key = randomUUID(),
    db: pg.Client = app,
    generation = '1',
  ): Promise<RfqResult> {
    const result = await db.query<{ result: RfqResult }>(
      'SELECT fi_control.rfq_command($1,$2,$3,$4,$5,$6,$7,$8) AS result',
      [
        id,
        proof,
        generation,
        action,
        JSON.stringify(payload),
        digest(JSON.stringify({ action, payload })),
        key,
        actor,
      ],
    );
    return result.rows[0]!.result;
  }
  return {
    app,
    id,
    proof,
    actor,
    command,
    async close() {
      await app.end();
      const admin = await connection('admin'),
        maint = await connection('maintenance');
      try {
        await admin.query(
          "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
          [id],
        );
        await maint.query('SELECT fi_control.purge_expired()');
      } finally {
        await maint.end();
        await admin.end();
      }
    },
  };
}
