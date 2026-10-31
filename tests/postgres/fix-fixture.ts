import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { executionSandbox } from './execution-fixture.js';
import { connection } from './harness.js';
export async function fixture(...args: Parameters<typeof executionSandbox>) {
  const s = await executionSandbox(...args);
  await s.app.query("SELECT set_config('tradeflow.sandbox_id',$1,false)", [s.id]);
  const channel = randomUUID();
  async function command(
    action: string,
    p: Record<string, unknown>,
    key = randomUUID(),
    db: pg.Client = s.app,
    generation = '1',
  ) {
    return (
      await db.query<{
        result: { status: number; replayed: boolean; body: Record<string, unknown> };
      }>('SELECT fi_control.fix_command($1,$2,$3,$4,$5,$6,$7) AS result', [
        s.id,
        s.proof,
        generation,
        action,
        JSON.stringify(p),
        key,
        s.actor,
      ])
    ).rows[0]!.result;
  }
  const bind = () =>
    command('BIND', { order_id: s.order, dealer_id: 'ATLAS', channel_id: channel });
  return {
    ...s,
    channel,
    fix: command,
    bind,
    async close() {
      const admin = await connection('admin');
      try {
        await admin.query(
          "UPDATE fi.fix_lanes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1 AND lease_expires_at IS NOT NULL",
          [s.id],
        );
      } finally {
        await admin.end();
      }
      await s.close();
    },
  };
}
import { encodeFix44 } from '../../app/protocol/fix44/index.js';
export async function report(
  s: Awaited<ReturnType<typeof fixture>>,
  changes: Record<string, string> = {},
) {
  const c = (
    await s.app.query<{ contract: Record<string, string> }>(
      'SELECT contract FROM fi.orders WHERE sandbox_id=$1 AND id=$2',
      [s.id, s.order],
    )
  ).rows[0]!.contract;
  return {
    '35': '8',
    '49': 'ATLAS',
    '56': 'TRADEFLOW',
    '34': '1',
    '52': '20261030-12:00:00.000',
    '11': s.order,
    '37': 'ATLAS-' + s.order.toUpperCase(),
    '17': 'ATLAS-' + randomUUID().toUpperCase(),
    '150': '0',
    '39': '0',
    '55': c['instrument_id']!,
    '167': c['instrument_id'] === 'SYN-UST-2031' ? 'TNOTE' : 'CORP',
    '54': c['side'] === 'BUY' ? '1' : '2',
    '854': '0',
    '38': c['par_amount']!,
    '40': '2',
    '59': '1',
    '423': '1',
    '44': c['clean_price']!,
    '15': 'USD',
    '64': c['settlement_date']!.replaceAll('-', ''),
    '14': '0.00',
    '151': c['par_amount']!,
    '6': '0.000000000000',
    '60': '20261030-12:00:00.000',
    ...changes,
  };
}
export function record(
  s: Awaited<ReturnType<typeof fixture>>,
  f: Record<string, string>,
  key = randomUUID(),
  attempt = randomUUID(),
  db = s.app,
) {
  return s.fix(
    'RECORD',
    { order_id: s.order, raw_hex: encodeFix44(f).toString('hex'), attempt_id: attempt },
    key,
    db,
  );
}
