import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { fixture, report, record } from './fix-fixture.js';
export async function applicationFixture(...args: Parameters<typeof fixture>) {
  const s = await fixture(...args);
  assert.equal((await s.bind()).status, 201);
  const owner = randomUUID();
  let fence = '';
  let seq = 0;
  async function claim() {
    const r = await s.fix('CLAIM', { order_id: s.order, owner_id: owner });
    assert.equal(r.status, 200);
    fence = String(r.body['fence']);
    return fence;
  }
  await claim();
  const original: Record<string, string> = await report(s, {
    '35': 'D',
    '49': 'TRADEFLOW',
    '56': 'ATLAS',
  });
  for (const tag of ['37', '17', '150', '39', '14', '151', '6']) delete original[tag];
  assert.equal((await record(s, original)).status, 201);
  async function stage(changes: Record<string, string> = {}) {
    const f: Record<string, string> = await report(s, { '34': String(++seq), ...changes });
    if (f['35'] === 'F')
      for (const tag of [
        '17',
        '150',
        '39',
        '854',
        '40',
        '59',
        '423',
        '44',
        '15',
        '64',
        '14',
        '151',
        '6',
      ])
        delete f[tag];
    if (f['35'] === '9')
      for (const tag of [
        '17',
        '150',
        '55',
        '167',
        '54',
        '854',
        '38',
        '40',
        '59',
        '423',
        '44',
        '15',
        '64',
        '14',
        '151',
        '6',
      ])
        delete f[tag];
    const r = await record(s, f);
    assert.equal(r.status, 201);
    return { f, message: String(r.body['message_id']) };
  }
  async function prepare(changes: Record<string, string> = {}) {
    const staged = await stage(changes),
      work = randomUUID(),
      financialKey = randomUUID();
    assert.equal(
      (await s.fix('QUEUE', { order_id: s.order, message_id: staged.message, work_id: work }))
        .status,
      201,
    );
    const p = {
      order_id: s.order,
      owner_id: owner,
      fence,
      work_id: work,
      financial_key: financialKey,
    };
    const prepared = await s.fix('PREPARE', p);
    assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
    return { ...staged, work, financialKey, prepared: prepared.body };
  }
  async function apply(
    work: string,
    key = randomUUID(),
    db: pg.Client = s.app,
    generation = '1',
    proof = s.proof,
  ) {
    return (
      await db.query<{ r: { status: number; replayed: boolean; body: Record<string, unknown> } }>(
        'SELECT fi_control.apply_fix($1,$2,$3,$4,$5,$6) r',
        [
          s.id,
          proof,
          generation,
          JSON.stringify({ order_id: s.order, owner_id: owner, fence, work_id: work }),
          key,
          s.actor,
        ],
      )
    ).rows[0]!.r;
  }
  return {
    ...s,
    owner,
    claim,
    stage,
    prepare,
    apply,
    get fence() {
      return fence;
    },
  };
}
