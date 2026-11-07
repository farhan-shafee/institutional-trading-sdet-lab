/** Authored SQL callback witnesses test database admission; real-engine proof is a later gate. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { startOwnedPostgres } from '../../scripts/owned-postgres.js';
import { bootstrap, readOwner } from '../../scripts/workflow-database.js';
import { fixture, report } from '../postgres/fix-fixture.js';
import { connection } from '../postgres/harness.js';
import { migrateLive } from '../../scripts/live-workflow-database.js';
import { LiveWorkflowDatabase } from '../../app/persistence/postgres/live-workflow.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { LiveFixApplicationService } from '../../app/server/fix/live-application.js';
import { DomainError } from '../../app/domain/errors.js';

let owned: Awaited<ReturnType<typeof startOwnedPostgres>> | undefined;
const prior = process.env['TF_DB_OWNER_FILE'];
before(async () => {
  owned = await startOwnedPostgres(process.env['TF_PG_BIN']);
  try {
    await bootstrap(owned.path);
    process.env['TF_DB_OWNER_FILE'] = owned.path;
    await migrateLive(owned.path);
  } catch (error) {
    await owned.stop(true);
    owned = undefined;
    throw error;
  }
});
after(async () => {
  try {
    await owned?.stop(true);
  } finally {
    if (prior === undefined) delete process.env['TF_DB_OWNER_FILE'];
    else process.env['TF_DB_OWNER_FILE'] = prior;
  }
});

type Outcome = { status: number; replayed: boolean; body: Record<string, unknown> };
type Params = Record<string, string>;
const now = () => new Date().toISOString().replaceAll('-', '').replace('T', '-').replace('Z', '');
function wire(f: Params): Buffer {
  const header = [
    '35',
    '34',
    ...(f['43'] ? ['43'] : []),
    '49',
    '52',
    '56',
    ...(f['122'] ? ['122'] : []),
  ];
  const body = Buffer.from(
    [
      ...header,
      ...Object.keys(f)
        .filter((k) => !header.includes(k))
        .sort((a, b) => Number(a) - Number(b)),
    ]
      .map((k) => `${k}=${f[k]}\x01`)
      .join(''),
    'ascii',
  );
  const start = Buffer.concat([Buffer.from(`8=FIX.4.4\x019=${body.length}\x01`), body]);
  return Buffer.concat([
    start,
    Buffer.from(`10=${String([...start].reduce((s, b) => s + b, 0) % 256).padStart(3, '0')}\x01`),
  ]);
}
async function liveFixture(...args: Parameters<typeof fixture>) {
  const s = await fixture(...args);
  const session = randomUUID(),
    store = randomUUID(),
    conn = randomUUID(),
    laneOwner = randomUUID();
  async function command(
    action: string,
    p: Params,
    key = randomUUID(),
    generation = '1',
    proof = s.proof,
  ) {
    return (
      await s.app.query<{ r: Outcome }>(
        'SELECT fi_control.fix_live_command($1,$2,$3,$4,$5,$6,$7) r',
        [s.id, proof, generation, action, JSON.stringify(p), key, s.actor],
      )
    ).rows[0]!.r;
  }
  const bindInput = {
    order_id: s.order,
    dealer_id: 'ATLAS',
    channel_id: s.channel,
    session_id: session,
    store_id: store,
    connection_id: conn,
    runtime_hash: 'a'.repeat(64),
    store_hash: 'b'.repeat(64),
    go_pid: '100',
    java_pid: '101',
  };
  async function observe(raw: Buffer, id = randomUUID(), key = randomUUID()) {
    return {
      id,
      key,
      result: await command(
        'OBSERVE',
        {
          order_id: s.order,
          observation_id: id,
          connection_id: conn,
          direction: 'IN',
          raw_hex: raw.toString('hex'),
        },
        key,
      ),
    };
  }
  async function accept(id: string, raw: Buffer, event = '1', key = randomUUID()) {
    const p = {
      order_id: s.order,
      observation_id: id,
      connection_id: conn,
      role: 'java',
      event_seq: event,
      callback_hex: raw.toString('hex'),
    };
    return { key, p, result: await command('ACCEPT', p, key) };
  }
  return { ...s, session, store, conn, laneOwner, live: command, bindInput, observe, accept };
}

void test('SQL selected profile independently matches all20 literal wire verdicts', async () => {
  const app = await connection('app');
  try {
    const rows = JSON.parse(await readFile('test-data/fix44/live/manifest.json', 'utf8')) as {
      name: string;
      raw_hex: string;
      accepted: boolean;
      fields?: Params;
    }[];
    for (const row of rows)
      assert.deepEqual(
        (
          await app.query<{ f: Params | null }>('SELECT fi_control.fix_live_fields($1::bytea) f', [
            Buffer.from(row.raw_hex, 'hex'),
          ])
        ).rows[0]?.f,
        row.accepted ? row.fields : null,
        row.name,
      );
    for (const raw of [null, Buffer.alloc(0), Buffer.alloc(8193), Buffer.from('8=FIX.4.4\x01')])
      assert.equal(
        (
          await app.query<{ f: Params | null }>('SELECT fi_control.fix_live_fields($1::bytea) f', [
            raw,
          ])
        ).rows[0]?.f,
        null,
      );
  } finally {
    await app.end();
  }
});
void test('a new live binding reserves existing capacity and seals its profile', async (t) => {
  const s = await liveFixture();
  t.after(() => s.close());
  const key = randomUUID();
  const bound = await s.live('BIND', s.bindInput, key);
  assert.equal(bound.status, 201);
  assert.equal(bound.body['reserved_commands'], 25);
  assert.equal(bound.body['reserved_events'], 43);
  assert.equal((await s.live('BIND', s.bindInput, key)).replayed, true);
  const changed = await s.live('BIND', { ...s.bindInput, store_id: randomUUID() }, key);
  assert.equal(changed.status, 409);
  const legacy = await s.fix('CLAIM', { order_id: s.order, owner_id: s.laneOwner });
  assert.equal(legacy.status, 409);
  assert.equal((legacy.body['error'] as { code: string }).code, 'FIX_LIVE_PROFILE_REQUIRED');
});
void test('raw observation cannot create trusted messages or financial eligibility', async (t) => {
  const s = await liveFixture();
  t.after(() => s.close());
  assert.equal((await s.live('BIND', s.bindInput)).status, 201);
  const fields = await report(s, { '52': now() });
  const raw = wire(fields);
  const observed = await s.observe(raw);
  assert.equal(observed.result.status, 201);
  assert.equal(observed.result.body['financial_applied'], false);
  assert.equal(observed.result.body['accepted'], false);
  assert.equal(observed.result.body['profile_valid'], true);
  assert.equal(
    (
      await s.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_messages WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]?.n,
    0,
  );
  const queued = await s.live('QUEUE', {
    order_id: s.order,
    message_id: observed.id,
    work_id: randomUUID(),
  });
  assert.equal(queued.status, 409);
  const supplied = await s.live('OBSERVE', {
    order_id: s.order,
    observation_id: randomUUID(),
    connection_id: s.conn,
    direction: 'IN',
    raw_hex: raw.toString('hex'),
    accepted: 'true',
  });
  assert.equal(supplied.status, 400);
});
void test('accepted callback preserves actual bytes and uses live store slots only', async (t) => {
  const s = await liveFixture();
  t.after(() => s.close());
  assert.equal((await s.live('BIND', s.bindInput)).status, 201);
  const raw = wire(await report(s, { '52': now() }));
  const observed = await s.observe(raw);
  const accepted = await s.accept(observed.id, raw);
  assert.equal(accepted.result.status, 201);
  assert.equal(accepted.result.body['financial_applied'], false);
  assert.equal((await s.live('ACCEPT', accepted.p, accepted.key)).replayed, true);
  const attempt = await s.app.query<{ raw_bytes: Buffer; raw_hash: string }>(
    'SELECT raw_bytes,raw_hash FROM fi.fix_attempts WHERE sandbox_id=$1 AND id=$2',
    [s.id, observed.id],
  );
  assert.deepEqual(attempt.rows[0]?.raw_bytes, raw);
  assert.equal(attempt.rows[0]?.raw_hash, createHash('sha256').update(raw).digest('hex'));
  assert.equal(
    (
      await s.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_sequence_slots WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]?.n,
    0,
  );
  assert.equal(
    (
      await s.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_live_sequence_slots WHERE sandbox_id=$1 AND store_id=$2',
        [s.id, s.store],
      )
    ).rows[0]?.n,
    1,
  );
});
void test('a different callback cannot authorize the observed frame', async (t) => {
  const s = await liveFixture();
  t.after(() => s.close());
  assert.equal((await s.live('BIND', s.bindInput)).status, 201);
  const fields = await report(s, { '52': now() });
  const observed = await s.observe(wire(fields));
  assert.equal(
    (await s.accept(observed.id, wire({ ...fields, '17': 'ATLAS-DIFFERENT' }))).result.status,
    409,
  );
  assert.equal(
    (
      await s.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_messages WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]?.n,
    0,
  );
});
void test('correlated SQL evidence reaches the unchanged financial kernel once', async (t) => {
  const s = await liveFixture();
  t.after(() => s.close());
  assert.equal((await s.live('BIND', s.bindInput)).status, 201);
  const claimed = await s.live('CLAIM', { order_id: s.order, owner_id: s.laneOwner });
  assert.equal(claimed.status, 200);
  const fence = String(claimed.body['fence']);
  const ack = await report(s, { '52': now() });
  const order = Object.fromEntries(
    Object.entries({ ...ack, '35': 'D', '49': 'TRADEFLOW', '56': 'ATLAS', '21': '1' }).filter(
      ([k]) => !['37', '17', '150', '39', '14', '151', '6'].includes(k),
    ),
  );
  const orderRaw = wire(order),
    orderObservation = randomUUID();
  assert.equal(
    (
      await s.live('OBSERVE', {
        order_id: s.order,
        observation_id: orderObservation,
        connection_id: s.conn,
        direction: 'OUT',
        raw_hex: orderRaw.toString('hex'),
      })
    ).status,
    201,
  );
  const orderAccepted = await s.live('ACCEPT', {
    order_id: s.order,
    observation_id: orderObservation,
    connection_id: s.conn,
    role: 'go',
    event_seq: '1',
    callback_hex: orderRaw.toString('hex'),
  });
  assert.equal(orderAccepted.status, 201, JSON.stringify(orderAccepted));

  const raw = wire(await report(s, { '52': now() }));
  const observed = await s.observe(raw);
  const accepted = await s.accept(observed.id, raw);
  assert.equal(accepted.result.status, 201);
  const work = randomUUID(),
    financialKey = randomUUID();
  assert.equal(
    (
      await s.live('QUEUE', {
        order_id: s.order,
        message_id: String(accepted.result.body['message_id']),
        work_id: work,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await s.live('PREPARE', {
        order_id: s.order,
        owner_id: s.laneOwner,
        fence,
        work_id: work,
        financial_key: financialKey,
      })
    ).status,
    201,
  );
  const key = randomUUID(),
    p = { order_id: s.order, owner_id: s.laneOwner, fence, work_id: work };
  const apply = async () =>
    (
      await s.app.query<{ r: Outcome }>('SELECT fi_control.apply_live_fix($1,$2,$3,$4,$5,$6) r', [
        s.id,
        s.proof,
        '1',
        JSON.stringify(p),
        key,
        s.actor,
      ])
    ).rows[0]!.r;
  const result = await apply();
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body['financial_applied'], true);
  assert.equal((await apply()).replayed, true);
  assert.equal(
    (
      await s.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_consumptions WHERE sandbox_id=$1 AND work_id=$2',
        [s.id, work],
      )
    ).rows[0]?.n,
    1,
  );
  assert.equal(
    (
      await s.app.query<{ status: string }>(
        'SELECT status FROM fi.order_states WHERE sandbox_id=$1 AND order_id=$2',
        [s.id, s.order],
      )
    ).rows[0]?.status,
    'NEW',
  );
});

async function applicationScenario(...args: Parameters<typeof fixture>) {
  const s = await liveFixture(...args);
  let inSeq = 0,
    outSeq = 0,
    inEvent = 0,
    outEvent = 0;
  assert.equal((await s.live('BIND', s.bindInput)).status, 201);
  const claim = await s.live('CLAIM', { order_id: s.order, owner_id: s.laneOwner });
  assert.equal(claim.status, 200);
  const fence = String(claim.body['fence']);
  async function stage(changes: Params = {}) {
    const outbound = ['D', 'F'].includes(changes['35'] ?? '8');
    const f: Params = await report(s, {
      '52': now(),
      '60': now(),
      '34': String(outbound ? ++outSeq : ++inSeq),
      ...changes,
    });
    if (f['35'] === 'D') {
      f['21'] = '1';
      for (const k of ['37', '17', '150', '39', '14', '151', '6']) delete f[k];
    }
    if (f['35'] === 'F')
      for (const k of [
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
        delete f[k];
    if (f['35'] === '9')
      for (const k of [
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
        delete f[k];
    const raw = wire(f),
      id = randomUUID();
    const observed = await s.live('OBSERVE', {
      order_id: s.order,
      observation_id: id,
      connection_id: s.conn,
      direction: outbound ? 'OUT' : 'IN',
      raw_hex: raw.toString('hex'),
    });
    assert.equal(observed.status, 201, JSON.stringify(observed));
    assert.equal(observed.body['profile_valid'], true);
    const accepted = await s.live('ACCEPT', {
      order_id: s.order,
      observation_id: id,
      connection_id: s.conn,
      role: outbound ? 'go' : 'java',
      event_seq: String(outbound ? ++outEvent : ++inEvent),
      callback_hex: raw.toString('hex'),
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted));
    return { f, raw, id, message: String(accepted.body['message_id']) };
  }
  await stage({ '35': 'D', '49': 'TRADEFLOW', '56': 'ATLAS' });
  async function prepare(changes: Params = {}) {
    const staged = await stage(changes),
      work = randomUUID(),
      financialKey = randomUUID();
    const queued = await s.live('QUEUE', {
      order_id: s.order,
      message_id: staged.message,
      work_id: work,
    });
    assert.equal(queued.status, 201, JSON.stringify(queued));
    const prepared = await s.live('PREPARE', {
      order_id: s.order,
      owner_id: s.laneOwner,
      fence,
      work_id: work,
      financial_key: financialKey,
    });
    assert.equal(prepared.status, 201, JSON.stringify(prepared));
    return { ...staged, work, financialKey, prepared };
  }
  async function apply(work: string, key = randomUUID(), overrides: Params = {}) {
    const p = { order_id: s.order, owner_id: s.laneOwner, fence, work_id: work, ...overrides };
    return (
      await s.app.query<{ r: Outcome }>('SELECT fi_control.apply_live_fix($1,$2,$3,$4,$5,$6) r', [
        s.id,
        s.proof,
        '1',
        JSON.stringify(p),
        key,
        s.actor,
      ])
    ).rows[0]!.r;
  }
  return { ...s, stage, prepare, apply, fence };
}

void test('one store cannot be relabeled as another session and partial binding rolls back', async (t) => {
  const s = await liveFixture();
  t.after(() => s.close());
  assert.equal((await s.live('BIND', s.bindInput)).status, 201);
  const other = await s.createOrder();
  const result = await s.live('BIND', {
    ...s.bindInput,
    order_id: other,
    session_id: randomUUID(),
    connection_id: randomUUID(),
    channel_id: randomUUID(),
  });
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.equal(
    (
      await s.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_bindings WHERE sandbox_id=$1 AND order_id=$2',
        [s.id, other],
      )
    ).rows[0]!.n,
    0,
  );
});
void test('SQL proves ownership, generation and callback terms independently', async (t) => {
  const s = await liveFixture(),
    other = await liveFixture();
  t.after(() => s.close());
  t.after(() => other.close());
  assert.equal((await s.live('BIND', s.bindInput, randomUUID(), '1', other.proof)).status, 404);
  assert.equal((await s.live('BIND', s.bindInput, randomUUID(), '2')).status, 404);
  assert.equal((await s.live('BIND', s.bindInput)).status, 201);
  for (const raw of [
    Buffer.from('not FIX'),
    wire(await report(s, { '52': now(), '38': '99.00' })),
    wire(await report(s, { '52': '20261030-12:00:00.000' })),
  ]) {
    const observed = await s.observe(raw);
    assert.equal(observed.result.status, 201);
    assert.equal(observed.result.body['profile_valid'], false);
    assert.equal((await s.accept(observed.id, raw)).result.status, 409);
  }
  assert.equal(
    (
      await s.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_messages WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.n,
    0,
  );
});
void test('app cannot mutate evidence or execute private legacy writers', async (t) => {
  const s = await liveFixture();
  t.after(() => s.close());
  assert.equal((await s.live('BIND', s.bindInput)).status, 201);
  for (const table of [
    'sessions',
    'bindings',
    'connections',
    'observations',
    'callbacks',
    'sequence_slots',
    'requests',
  ]) {
    const access = (
      await s.app.query<{ write: boolean; rls: boolean }>(
        "SELECT has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE') write,c.relrowsecurity AND c.relforcerowsecurity rls FROM pg_class c WHERE c.oid=$1::regclass",
        [`fi.fix_live_${table}`],
      )
    ).rows[0]!;
    assert.equal(access.write, false);
    assert.equal(access.rls, true);
  }
  for (const signature of [
    'fix_command_legacy_v8(uuid,text,bigint,text,jsonb,text,uuid)',
    'apply_fix_legacy_v8(uuid,text,bigint,jsonb,text,uuid)',
    'ingest_fix_legacy_v8(uuid,text,bigint,jsonb,text,uuid,boolean)',
  ])
    assert.equal(
      (
        await s.app.query<{ allowed: boolean }>(
          "SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",
          [`fi_control.${signature}`],
        )
      ).rows[0]!.allowed,
      false,
    );
  for (const signature of [
    'fix_live_command(uuid,text,bigint,text,jsonb,text,uuid)',
    'apply_live_fix(uuid,text,bigint,jsonb,text,uuid)',
    'read_live_fix(uuid,text,text,bigint,text,text)',
  ])
    for (const role of ['tf_reconciler', 'tf_maintenance'])
      assert.equal(
        (
          await s.app.query<{ allowed: boolean }>(
            "SELECT has_function_privilege($1,$2,'EXECUTE') allowed",
            [role, `fi_control.${signature}`],
          )
        ).rows[0]!.allowed,
        false,
      );
  const other = await liveFixture();
  t.after(() => other.close());
  assert.equal(
    (
      await other.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_live_bindings WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.n,
    0,
  );
});
void test('legacy ingest and application cannot bypass the sealed live profile', async (t) => {
  const s = await applicationScenario();
  t.after(() => s.close());
  const staged = await s.prepare();
  for (const fn of ['apply_fix', 'ingest_fix']) {
    const p =
      fn === 'apply_fix'
        ? { order_id: s.order, owner_id: s.laneOwner, fence: s.fence, work_id: staged.work }
        : { order_id: s.order, attempt_id: randomUUID(), raw_hex: staged.raw.toString('hex') };
    const q = `SELECT fi_control.${fn}($1,$2,1,$3,$4,$5${fn === 'ingest_fix' ? ',true' : ''}) r`;
    const r = (
      await s.app.query<{ r: Outcome }>(q, [
        s.id,
        s.proof,
        JSON.stringify(p),
        randomUUID(),
        s.actor,
      ])
    ).rows[0]!.r;
    assert.equal(r.status, 409);
    assert.equal((r.body['error'] as { code: string }).code, 'FIX_LIVE_PROFILE_REQUIRED');
  }
  assert.equal(
    (
      await s.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_applications WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.n,
    0,
  );
  assert.equal((await s.apply(staged.work)).status, 200);
});
void test('unaccepted observations block prepared financial work without losing the original intent', async (t) => {
  const s = await applicationScenario();
  t.after(() => s.close());
  const staged = await s.prepare();
  const held = await s.observe(wire(await report(s, { '52': now(), '34': '2' })));
  assert.equal(held.result.status, 201);
  const key = randomUUID();
  assert.equal((await s.apply(staged.work, key)).status, 409);
  assert.equal(
    (
      await s.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_applications WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.n,
    0,
  );
  assert.equal(
    (
      await s.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_prepared WHERE sandbox_id=$1 AND work_id=$2',
        [s.id, staged.work],
      )
    ).rows[0]!.n,
    1,
  );
});
void test('bounded raw admission preserves original-key recovery at the pending limit', async (t) => {
  const s = await liveFixture();
  t.after(() => s.close());
  assert.equal((await s.live('BIND', s.bindInput)).status, 201);
  const raw = Buffer.from('invalid');
  let first: Awaited<ReturnType<typeof s.observe>> | undefined;
  for (let i = 0; i < 8; i++) {
    const r = await s.observe(raw);
    assert.equal(r.result.status, 201);
    first ??= r;
  }
  assert.equal((await s.observe(raw)).result.status, 429);
  assert.equal((await s.observe(raw, first!.id, first!.key)).result.replayed, true);
  assert.equal((await s.observe(Buffer.from('changed'), first!.id, first!.key)).result.status, 409);
  assert.equal(
    (
      await s.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_live_observations WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.n,
    8,
  );
});
void test('a new connection fences the previous incarnation without resetting the store', async (t) => {
  const s = await liveFixture();
  t.after(() => s.close());
  assert.equal((await s.live('BIND', s.bindInput)).status, 201);
  const connection = randomUUID();
  assert.equal(
    (
      await s.live('CONNECT', {
        order_id: s.order,
        connection_id: connection,
        go_pid: '102',
        java_pid: '103',
      })
    ).status,
    201,
  );
  const raw = wire(await report(s, { '52': now() }));
  assert.equal((await s.observe(raw)).result.status, 409);
  const observed = await s.live('OBSERVE', {
    order_id: s.order,
    observation_id: randomUUID(),
    connection_id: connection,
    direction: 'IN',
    raw_hex: raw.toString('hex'),
  });
  assert.equal(observed.status, 201);
  assert.equal(
    (
      await s.app.query<{ store_id: string }>(
        'SELECT store_id FROM fi.fix_live_sessions WHERE sandbox_id=$1 AND id=$2',
        [s.id, s.session],
      )
    ).rows[0]!.store_id,
    s.store,
  );
});
void test('callback ordinal reuse rolls back its candidate message, correlation and attempt', async (t) => {
  const s = await liveFixture();
  t.after(() => s.close());
  assert.equal((await s.live('BIND', s.bindInput)).status, 201);
  const first = wire(await report(s, { '52': now() })),
    one = await s.observe(first);
  assert.equal((await s.accept(one.id, first)).result.status, 201);
  const second = wire(await report(s, { '52': now(), '34': '2' })),
    two = await s.observe(second);
  assert.equal((await s.accept(two.id, second)).result.status, 409);
  for (const table of ['messages', 'attempts', 'live_callbacks', 'live_sequence_slots'])
    assert.equal(
      (
        await s.app.query<{ n: number }>(
          `SELECT count(*)::int n FROM fi.fix_${table} WHERE sandbox_id=$1`,
          [s.id],
        )
      ).rows[0]!.n,
      1,
    );
  assert.equal((await s.accept(two.id, second, '2')).result.status, 201);
});
void test('an expired lease cannot apply and a reclaimed fence retains the original financial key', async (t) => {
  const s = await applicationScenario();
  t.after(() => s.close());
  const staged = await s.prepare(),
    admin = await connection('admin');
  t.after(() => admin.end());
  await admin.query(
    "UPDATE fi.fix_lanes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1 AND order_id=$2",
    [s.id, s.order],
  );
  const applyKey = randomUUID();
  assert.equal((await s.apply(staged.work, applyKey)).status, 409);
  const reclaimed = await s.live('CLAIM', { order_id: s.order, owner_id: s.laneOwner });
  assert.equal(reclaimed.status, 200);
  assert.notEqual(String(reclaimed.body['fence']), s.fence);
  assert.equal((await s.apply(staged.work, applyKey)).status, 409);
  const applied = await s.apply(staged.work, applyKey, { fence: String(reclaimed.body['fence']) });
  assert.equal(applied.status, 200, JSON.stringify(applied));
  assert.equal(
    (
      await s.app.query<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM fi.commands WHERE sandbox_id=$1 AND operation='ACK_ORDER'",
        [s.id],
      )
    ).rows[0]!.idempotency_key,
    staged.financialKey,
  );
});
for (const side of ['BUY', 'SELL'])
  for (const instrument of ['SYN-UST-2031', 'SYN-CORP-2031'])
    void test(`unchanged ${instrument} ${side} kernel applies partial and final fills exactly once`, async (t) => {
      const s = await applicationScenario('100.00', side, instrument);
      t.after(() => s.close());
      assert.equal((await s.apply((await s.prepare()).work)).status, 200);
      for (const [quantity, cumulative, leaves, status] of [
        ['40.00', '40.00', '60.00', '1'],
        ['60.00', '100.00', '0.00', '2'],
      ]) {
        const p = await s.prepare({
          '150': 'F',
          '39': status!,
          '32': quantity!,
          '31': (await report(s))['44'],
          '6': (await report(s))['44'],
          '14': cumulative!,
          '151': leaves!,
        });
        const key = randomUUID(),
          applied = await s.apply(p.work, key);
        assert.equal(applied.status, 200, JSON.stringify(applied));
        assert.equal(applied.body['financial_applied'], true);
        assert.equal((await s.apply(p.work, key)).replayed, true);
      }
      const life = (
        await s.app.query<{ status: string; filled_par: string; execution_count: number }>(
          'SELECT status,filled_par,execution_count FROM fi.order_states WHERE sandbox_id=$1 AND order_id=$2',
          [s.id, s.order],
        )
      ).rows[0]!;
      assert.deepEqual(life, { status: 'FILLED', filled_par: '100.00', execution_count: 2 });
      assert.equal(
        (
          await s.app.query<{ n: number }>(
            'SELECT count(*)::int n FROM fi.fix_consumptions WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.n,
        3,
      );
    });
void test('accepted cancel request and cancel rejection use the same owned order correlation', async (t) => {
  const s = await applicationScenario();
  t.after(() => s.close());
  assert.equal((await s.apply((await s.prepare()).work)).status, 200);
  const cancel = randomUUID();
  const requested = await s.prepare({
    '35': 'F',
    '49': 'TRADEFLOW',
    '56': 'ATLAS',
    '11': cancel,
    '41': s.order,
  });
  assert.equal((await s.apply(requested.work)).status, 200);
  const rejected = await s.prepare({
    '35': '9',
    '11': cancel,
    '41': s.order,
    '39': '0',
    '434': '1',
    '102': '99',
  });
  const result = await s.apply(rejected.work);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(
    (
      await s.app.query<{ pending_cancel_id: string | null }>(
        'SELECT pending_cancel_id FROM fi.order_states WHERE sandbox_id=$1 AND order_id=$2',
        [s.id, s.order],
      )
    ).rows[0]!.pending_cancel_id,
    null,
  );
});
void test('live schema is explicit and its migration is idempotent; the default client rejects schema9', async (t) => {
  assert.ok(owned);
  await migrateLive(owned.path);
  const cfg = await readOwner(owned.path),
    legacy = new WorkflowDatabase(cfg.appUrl!),
    live = new LiveWorkflowDatabase(cfg.appUrl!);
  t.after(() => legacy.close());
  t.after(() => live.close());
  await assert.rejects(
    () =>
      legacy.transaction(
        true,
        () => {},
        () => Promise.resolve(null),
      ),
    (e: unknown) => e instanceof DomainError && e.code === 'SCHEMA_INCOMPATIBLE',
  );
  assert.equal(
    await live.transaction(
      true,
      () => {},
      async (db) => (await db.query<{ n: number }>('SELECT 1::int n')).rows[0]!.n,
    ),
    1,
  );
});
void test('the live SDK is off by default, rejects viewer writes and never trusts caller acceptance flags', async (t) => {
  assert.ok(owned);
  const cfg = await readOwner(owned.path),
    db = new LiveWorkflowDatabase(cfg.appUrl!);
  t.after(() => db.close());
  const s = await liveFixture();
  t.after(() => s.close());
  const binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' },
    off = new LiveFixApplicationService(db),
    service = new LiveFixApplicationService(db, true);
  const rejected = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;
  await assert.rejects(
    () => off.command(binding, s.actor, 'BIND', s.bindInput, randomUUID(), () => {}),
    rejected('FIX_LIVE_DISABLED'),
  );
  await assert.rejects(
    () =>
      service.command(
        { ...binding, scope: 'read' },
        s.actor,
        'BIND',
        s.bindInput,
        randomUUID(),
        () => {},
      ),
    rejected('FORBIDDEN'),
  );
  assert.equal(
    (await service.command(binding, s.actor, 'BIND', s.bindInput, randomUUID(), () => {})).status,
    201,
  );
  await assert.rejects(
    () =>
      service.command(
        binding,
        s.actor,
        'OBSERVE',
        {
          order_id: s.order,
          observation_id: randomUUID(),
          connection_id: s.conn,
          direction: 'IN',
          raw_hex: '61',
          accepted: true,
        },
        randomUUID(),
        () => {},
      ),
    rejected('VALIDATION_ERROR'),
  );
  const observed = await service.command(
    binding,
    s.actor,
    'OBSERVE',
    {
      order_id: s.order,
      observation_id: randomUUID(),
      connection_id: s.conn,
      direction: 'IN',
      raw_hex: '61',
    },
    randomUUID(),
    () => {},
  );
  assert.equal(observed.status, 201);
  assert.ok(
    typeof observed.body === 'object' && observed.body !== null && 'profile_valid' in observed.body,
  );
  assert.equal(observed.body.profile_valid, false);
  const state = await service.read(binding, 'STATE', s.order, () => {});
  assert.equal(state.status, 200);
  assert.ok(
    typeof state.body === 'object' &&
      state.body !== null &&
      'profile' in state.body &&
      'delivery_verified' in state.body,
  );
  assert.equal(state.body.profile, 'live-fix-ingress-v1');
  assert.equal(state.body.delivery_verified, false);
});
void test('lost financial COMMIT response is outcome-unknown and only the original intent recovers', async (t) => {
  assert.ok(owned);
  const cfg = await readOwner(owned.path),
    s = await applicationScenario();
  t.after(() => s.close());
  const staged = await s.prepare();
  let commits = 0;
  const db = new LiveWorkflowDatabase(cfg.appUrl!, {
    afterCommit: () => {
      commits++;
      throw new Error('synthetic lost response');
    },
  });
  t.after(() => db.close());
  const service = new LiveFixApplicationService(db, true),
    binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' },
    key = randomUUID(),
    input = { order_id: s.order, owner_id: s.laneOwner, fence: s.fence, work_id: staged.work };
  await assert.rejects(
    () => service.apply(binding, s.actor, input, key, () => {}),
    (e: unknown) => e instanceof DomainError && e.code === 'OUTCOME_UNKNOWN',
  );
  assert.equal(commits, 1);
  const recovery = new LiveWorkflowDatabase(cfg.appUrl!);
  t.after(() => recovery.close());
  const recovered = await new LiveFixApplicationService(recovery, true).apply(
    binding,
    s.actor,
    input,
    key,
    () => {},
  );
  assert.equal(recovered.status, 200);
  assert.equal(recovered.replayed, true);
  assert.equal(
    (
      await s.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_consumptions WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.n,
    1,
  );
});
void test('before-COMMIT rollback leaves no application, money or capacity consumption', async (t) => {
  assert.ok(owned);
  const cfg = await readOwner(owned.path),
    s = await applicationScenario();
  t.after(() => s.close());
  const staged = await s.prepare();
  const db = new LiveWorkflowDatabase(cfg.appUrl!, {
    beforeCommit: () => {
      throw new Error('synthetic rollback');
    },
  });
  t.after(() => db.close());
  const binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' },
    key = randomUUID(),
    input = { order_id: s.order, owner_id: s.laneOwner, fence: s.fence, work_id: staged.work };
  await assert.rejects(
    () => new LiveFixApplicationService(db, true).apply(binding, s.actor, input, key, () => {}),
    (e: unknown) => e instanceof DomainError && e.code === 'DATABASE_UNAVAILABLE',
  );
  for (const table of ['applications', 'consumptions'])
    assert.equal(
      (
        await s.app.query<{ n: number }>(
          `SELECT count(*)::int n FROM fi.fix_${table} WHERE sandbox_id=$1`,
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
  assert.equal(
    (
      await s.app.query<{ status: string }>(
        'SELECT status FROM fi.order_states WHERE sandbox_id=$1 AND order_id=$2',
        [s.id, s.order],
      )
    ).rows[0]!.status,
    'PENDING_ACK',
  );
  assert.equal((await s.apply(staged.work, key)).status, 200);
});
void test('the schema9 client retains pool4, pending12 and bounded known precommit retries', async (t) => {
  assert.ok(owned);
  const cfg = await readOwner(owned.path),
    db = new LiveWorkflowDatabase(cfg.appUrl!);
  t.after(() => db.close());
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests = Array.from({ length: 12 }, () =>
    db.transaction(
      false,
      () => {},
      async () => {
        await held;
        return true;
      },
    ),
  );
  await assert.rejects(
    () =>
      db.transaction(
        false,
        () => {},
        () => Promise.resolve(true),
      ),
    (e: unknown) => e instanceof DomainError && e.code === 'DATABASE_UNAVAILABLE',
  );
  release();
  assert.deepEqual(await Promise.all(requests), Array<boolean>(12).fill(true));
  assert.ok(db.pool.totalCount <= 4);
  for (const code of ['40P01', '40001']) {
    let calls = 0;
    const result = await db.transaction(
      false,
      () => {},
      async (client) => {
        calls++;
        if (calls < 3)
          await client.query(
            `DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='${code}',MESSAGE='synthetic retry'; END $$`,
          );
        return 'done';
      },
    );
    assert.equal(result, 'done');
    assert.equal(calls, 3);
  }
  let failures = 0;
  await assert.rejects(
    () =>
      db.transaction(
        false,
        () => {},
        async (client) => {
          failures++;
          await client.query(
            "DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='synthetic persistent conflict'; END $$",
          );
        },
      ),
    (e: unknown) => e instanceof DomainError && e.code === 'DATABASE_UNAVAILABLE',
  );
  assert.equal(failures, 3);
});
void test('live state and receipt reads never relabel a legacy binding', async (t) => {
  assert.ok(owned);
  const cfg = await readOwner(owned.path),
    s = await fixture();
  t.after(() => s.close());
  const key = randomUUID();
  assert.equal(
    (await s.fix('BIND', { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel }, key))
      .status,
    201,
  );
  const db = new LiveWorkflowDatabase(cfg.appUrl!);
  t.after(() => db.close());
  const service = new LiveFixApplicationService(db, true),
    binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' };
  assert.equal((await service.read(binding, 'STATE', s.order, () => {})).status, 404);
  assert.equal((await service.read(binding, 'RECEIPT', key, () => {})).status, 404);
});
void test('rotation rejects old proofs and connections while the new fence recovers the prepared financial intent', async (t) => {
  const s = await applicationScenario();
  t.after(() => s.close());
  const staged = await s.prepare(),
    newProof = 'b'.repeat(64);
  const rotated = (
    await s.app.query<{ r: Outcome }>(
      'SELECT fi_control.rotate_capabilities($1,$2,1,1,$3,$4,$5,$6,$7) r',
      [s.id, s.proof, 'a'.repeat(64), newProof, 'c'.repeat(64), randomUUID(), s.actor],
    )
  ).rows[0]!.r;
  assert.equal(rotated.status, 200);
  assert.equal((await s.apply(staged.work)).status, 404);
  const raw = wire(await report(s, { '52': now(), '34': '2' }));
  assert.equal(
    (
      await s.live(
        'OBSERVE',
        {
          order_id: s.order,
          observation_id: randomUUID(),
          connection_id: s.conn,
          direction: 'IN',
          raw_hex: raw.toString('hex'),
        },
        randomUUID(),
        '2',
        newProof,
      )
    ).status,
    409,
  );
  const claimed = await s.live(
    'CLAIM',
    { order_id: s.order, owner_id: s.laneOwner },
    randomUUID(),
    '2',
    newProof,
  );
  assert.equal(claimed.status, 200);
  const input = {
    order_id: s.order,
    owner_id: s.laneOwner,
    fence: String(claimed.body['fence']),
    work_id: staged.work,
  };
  const applied = (
    await s.app.query<{ r: Outcome }>('SELECT fi_control.apply_live_fix($1,$2,2,$3,$4,$5) r', [
      s.id,
      newProof,
      JSON.stringify(input),
      randomUUID(),
      s.actor,
    ])
  ).rows[0]!.r;
  assert.equal(applied.status, 200, JSON.stringify(applied));
  assert.equal(
    (
      await s.app.query<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM fi.commands WHERE sandbox_id=$1 AND operation='ACK_ORDER'",
        [s.id],
      )
    ).rows[0]!.idempotency_key,
    staged.financialKey,
  );
});
void test('a validated synthetic order rejection reaches the original kernel once', async (t) => {
  const s = await applicationScenario();
  t.after(() => s.close());
  const p = await s.prepare({
    '150': '8',
    '39': '8',
    '151': '0.00',
    '103': '99',
    '58': 'SYNTHETIC_REJECTION',
  });
  const key = randomUUID(),
    r = await s.apply(p.work, key);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal((await s.apply(p.work, key)).replayed, true);
  assert.equal(
    (
      await s.app.query<{ status: string }>(
        'SELECT status FROM fi.order_states WHERE sandbox_id=$1 AND order_id=$2',
        [s.id, s.order],
      )
    ).rows[0]!.status,
    'REJECTED',
  );
});
void test('an accepted cancel acknowledgment closes only its correlated pending request', async (t) => {
  const s = await applicationScenario();
  t.after(() => s.close());
  assert.equal((await s.apply((await s.prepare()).work)).status, 200);
  const cancel = randomUUID();
  assert.equal(
    (
      await s.apply(
        (
          await s.prepare({
            '35': 'F',
            '49': 'TRADEFLOW',
            '56': 'ATLAS',
            '11': cancel,
            '41': s.order,
          })
        ).work,
      )
    ).status,
    200,
  );
  const p = await s.prepare({ '150': '4', '39': '4', '11': cancel, '41': s.order, '151': '0.00' }),
    r = await s.apply(p.work);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(
    (
      await s.app.query<{ status: string }>(
        'SELECT status FROM fi.order_states WHERE sandbox_id=$1 AND order_id=$2',
        [s.id, s.order],
      )
    ).rows[0]!.status,
    'CANCELED',
  );
});
void test('the fourth physical attempt is the last admitted witness for a logical message', async (t) => {
  const s = await liveFixture();
  t.after(() => s.close());
  assert.equal((await s.live('BIND', s.bindInput)).status, 201);
  const fields = await report(s, { '52': now() });
  let originalMessage = '';
  for (let n = 1; n <= 5; n++) {
    const raw = wire(n === 1 ? fields : { ...fields, '43': 'Y', '122': fields['52'], '52': now() }),
      o = await s.observe(raw);
    assert.equal(o.result.status, 201);
    const a = await s.accept(o.id, raw, String(n));
    assert.equal(a.result.status, n <= 4 ? 201 : 429, JSON.stringify(a));
    if (n === 1) originalMessage = String(a.result.body['message_id']);
    else if (n <= 4) assert.equal(a.result.body['message_id'], originalMessage);
  }
  assert.equal(
    (
      await s.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_attempts WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.n,
    4,
  );
  assert.equal(
    (
      await s.app.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi.fix_live_callbacks WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.n,
    4,
  );
});
