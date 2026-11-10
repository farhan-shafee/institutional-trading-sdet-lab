import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { sandbox, digest } from '../postgres/rfq-fixture.js';
import { executionSandbox } from '../postgres/execution-fixture.js';
import { connection } from '../postgres/harness.js';

export interface PostTradeReply {
  status: number;
  replayed: boolean;
  body: Record<string, unknown>;
}
export async function postTradeSandbox(par?: string) {
  const base =
    par === undefined
      ? await sandbox()
      : await executionSandbox(par, 'BUY', 'SYN-UST-2031', '2030-01-15');
  const actor = base.actor;
  async function command(
    operation: string,
    payload: unknown,
    key: string = randomUUID(),
    proof = base.proof,
    generation = '1',
    db: pg.Client = base.app,
  ): Promise<PostTradeReply> {
    return (
      await db.query<{ result: PostTradeReply }>(
        'SELECT fi_control.posttrade_command($1,$2,$3,$4,$5,$6,$7) AS result',
        [base.id, proof, generation, operation, JSON.stringify(payload), key, actor],
      )
    ).rows[0]!.result;
  }
  async function read(
    proof = base.proof,
    generation = '1',
    raw: string | null = null,
    post: string | null = null,
  ): Promise<PostTradeReply> {
    return (
      await base.app.query<{ result: PostTradeReply }>(
        'SELECT fi_control.read_posttrade($1,$2,$3,$4,$5,$6) AS result',
        [base.id, proof, 'trade', generation, raw, post],
      )
    ).rows[0]!.result;
  }
  return { ...base, command, read };
}
export { connection, executionSandbox, randomUUID, digest };
