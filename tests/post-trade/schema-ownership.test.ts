import assert from 'node:assert/strict';
import { test } from 'node:test';
import { owner } from '../postgres/harness.js';
import { PostTradeWorkflowDatabase } from '../../app/persistence/postgres/post-trade-workflow.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { LiveWorkflowDatabase } from '../../app/persistence/postgres/live-workflow.js';
import { postTradeMigrationChecksums } from '../../app/domain/post-trade/database-contract.js';
import { postTradeSandbox, executionSandbox, connection, randomUUID } from './fixture.js';

await test('explicit schema10 client matches exact source while default8 and9 remain fail-closed', async () => {
  const config = await owner();
  assert.ok(config.appUrl);
  const clients = [
    new WorkflowDatabase(config.appUrl),
    new LiveWorkflowDatabase(config.appUrl),
    new PostTradeWorkflowDatabase(config.appUrl),
  ];
  try {
    for (const old of clients.slice(0, 2))
      await assert.rejects(
        old.transaction(
          true,
          () => undefined,
          async (db) => db.query('SELECT 1'),
        ),
        { code: 'SCHEMA_INCOMPATIBLE' },
      );
    const result = await clients[2]!.transaction(
      true,
      () => undefined,
      async (db) => (await db.query<{ role: string }>('SELECT current_user AS role')).rows[0]!.role,
    );
    assert.equal(result, 'tf_app');
    const admin = await connection('admin');
    try {
      assert.deepEqual(
        (
          await admin.query(
            'SELECT version,checksum FROM fi_control.schema_migrations ORDER BY version',
          )
        ).rows,
        postTradeMigrationChecksums,
      );
    } finally {
      await admin.end();
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});

await test('new tables force RLS and expose only least-privilege RPCs to app', async () => {
  const admin = await connection('admin'),
    app = await connection('app');
  try {
    const names = [
      'posttrade_books',
      'posttrade_security_balances',
      'posttrade_roots',
      'posttrade_revisions',
      'posttrade_busts',
      'posttrade_settlement_outcomes',
      'posttrade_commands',
      'posttrade_events',
    ];
    for (const name of names) {
      const flags = await admin.query<{ secured: boolean }>(
        'SELECT relrowsecurity AND relforcerowsecurity AS secured FROM pg_class WHERE oid=$1::regclass',
        ['fi.' + name],
      );
      assert.equal(flags.rows[0]?.secured, true, name);
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const allowed = await app.query<{ allowed: boolean }>(
          'SELECT has_table_privilege(current_user,$1,$2) AS allowed',
          ['fi.' + name, privilege],
        );
        assert.equal(allowed.rows[0]?.allowed, false, name + '/' + privilege);
      }
    }
    await assert.rejects(app.query('SELECT * FROM fi.posttrade_books'), { code: '42501' });
    await assert.rejects(app.query('SET ROLE tf_owner'), { code: '42501' });
    assert.equal(
      (
        await app.query<{ allowed: boolean }>(
          "SELECT has_function_privilege(current_user,'fi_control.posttrade_command(uuid,text,bigint,text,jsonb,text,uuid)','EXECUTE') AS allowed",
        )
      ).rows[0]?.allowed,
      true,
    );
  } finally {
    await app.end();
    await admin.end();
  }
});

await test('post-trade database constructor rejects hosted and non-owned targets before use', () => {
  for (const target of [
    'postgresql://tf_app:x@example.com/tradeflow_local_0123456789abcdef',
    'postgresql://tf_app:x@127.0.0.1/other',
    'postgresql://tf_owner:x@127.0.0.1/tradeflow_local_0123456789abcdef',
  ])
    assert.throws(() => new PostTradeWorkflowDatabase(target));
});

await test('owned source starts explicitly uninitialized and original-key init replay reauthorizes', async () => {
  const s = await postTradeSandbox();
  try {
    const disabled = await s.read();
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.initialized, false);
    const key: string = randomUUID(),
      payload = { economic_start_date: '2030-01-15' };
    const created = await s.command('INITIALIZE', payload, key);
    assert.equal(created.status, 201);
    const replay = await s.command('INITIALIZE', payload, key);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, created.body);
    assert.equal((await s.command('INITIALIZE', payload, key, '0'.repeat(64))).status, 404);
    assert.equal((await s.command('INITIALIZE', payload, key, s.proof, '2')).status, 404);
    assert.equal(
      (await s.command('INITIALIZE', { economic_start_date: '2030-01-16' }, key)).status,
      409,
    );
    const current = await s.read();
    assert.equal(current.body.initialized, true);
    assert.deepEqual(current.body.window, { start: '2030-01-15', end: '2030-07-15' });
    assert.equal(current.body.available_cash_cents, '10000000000');
    const historical = await s.read(s.proof, '1', null, '0');
    assert.equal(historical.body.initialized, false);
  } finally {
    await s.close();
  }
});

await test('register copies actual owned immutable execution and never changes its raw ledger', async () => {
  const s = await executionSandbox('100.00', 'BUY', 'SYN-UST-2031', '2030-01-15');
  const app = s.app,
    admin = await connection('admin');
  const command = async (op: string, payload: unknown, key: string = randomUUID()) =>
    (
      await app.query<{ result: { status: number; body: Record<string, unknown> } }>(
        'SELECT fi_control.posttrade_command($1,$2,$3,$4,$5,$6,$7) AS result',
        [s.id, s.proof, '1', op, JSON.stringify(payload), key, s.actor],
      )
    ).rows[0]!.result;
  try {
    assert.equal((await s.command('ACK_ORDER', { expected_version: '1' })).status, 200);
    const execution = (await s.fill('2', '100.00')).body.execution!;
    assert.ok(execution);
    const before = (
      await admin.query<{ raw: string; c: number; e: number }>(
        'SELECT row_to_json(x)::text AS raw,s.command_count AS c,s.event_count AS e FROM fi.executions x JOIN fi.sandboxes s ON s.id=x.sandbox_id WHERE x.sandbox_id=$1 AND x.id=$2',
        [s.id, execution.id],
      )
    ).rows[0]!;
    assert.equal((await command('INITIALIZE', { economic_start_date: '2030-01-15' })).status, 201);
    assert.equal((await command('REGISTER', { execution_id: execution.id })).status, 201);
    const source = (
      await app.query<{
        result: {
          status: number;
          body: {
            coverage: { complete: boolean };
            roots: {
              execution_id: string;
              registered: boolean;
              active_consideration_cents: string;
              definition_version: string;
            }[];
          };
        };
      }>("SELECT fi_control.read_posttrade($1,$2,'trade',1,NULL,NULL) AS result", [s.id, s.proof])
    ).rows[0]!.result;
    assert.equal(source.status, 200);
    assert.equal(source.body.coverage.complete, true);
    assert.equal(source.body.roots[0]!.execution_id, execution.id);
    assert.equal(source.body.roots[0]!.registered, true);
    assert.equal(source.body.roots[0]!.definition_version, 'phase1-ust-1');
    assert.equal(source.body.roots[0]!.active_consideration_cents, execution.consideration_cents);
    const after = (
      await admin.query<{ raw: string; c: number; e: number }>(
        'SELECT row_to_json(x)::text AS raw,s.command_count AS c,s.event_count AS e FROM fi.executions x JOIN fi.sandboxes s ON s.id=x.sandbox_id WHERE x.sandbox_id=$1 AND x.id=$2',
        [s.id, execution.id],
      )
    ).rows[0];
    assert.deepEqual(after, before);
  } finally {
    await admin.end();
    await s.close();
  }
});

await test('shared key namespace rejects old/new family reuse with no partial effects', async () => {
  const s = await postTradeSandbox(),
    admin = await connection('admin');
  try {
    const oldKey = (
      await admin.query<{ idempotency_key: string }>(
        'SELECT idempotency_key FROM fi.commands WHERE sandbox_id=$1 ORDER BY command_seq LIMIT 1',
        [s.id],
      )
    ).rows[0]!.idempotency_key;
    assert.equal(
      (await s.command('INITIALIZE', { economic_start_date: '2030-01-15' }, oldKey)).status,
      409,
    );
    assert.equal(
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM fi.posttrade_books WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
    const key: string = randomUUID();
    assert.equal(
      (await s.command('INITIALIZE', { economic_start_date: '2030-01-15' }, key)).status,
      201,
    );
    const conflict = await admin.query<{ domain: string }>(
      'SELECT domain FROM fi_control.command_keys WHERE sandbox_id=$1 AND idempotency_key=$2',
      [s.id, key],
    );
    assert.equal(conflict.rows[0]!.domain, 'POSTTRADE');
    await assert.rejects(
      s.app.query('SELECT fi_control.rfq_command($1,$2,1,$3,$4,$5,$6,$7)', [
        s.id,
        s.proof,
        'CREATE_RFQ',
        JSON.stringify({
          rfq_id: randomUUID(),
          instrument_id: 'SYN-UST-2031',
          side: 'BUY',
          par_amount: '100.00',
          settlement_date: '2030-01-15',
          invited_dealers: ['ATLAS', 'BIRCH', 'CEDAR'],
        }),
        'a'.repeat(64),
        key,
        s.actor,
      ]),
      { code: 'TF409' },
    );
  } finally {
    await admin.end();
    await s.close();
  }
});

await test('unknown installed checksum fails closed without returning source or balances', async () => {
  const config = await owner();
  assert.ok(config.appUrl);
  const database = new PostTradeWorkflowDatabase(config.appUrl),
    admin = await connection('admin');
  const checksum = postTradeMigrationChecksums[9]!.checksum;
  try {
    await admin.query(
      "UPDATE fi_control.schema_migrations SET checksum=repeat('0',64) WHERE version=10",
    );
    await assert.rejects(
      database.transaction(
        true,
        () => undefined,
        async (db) => db.query('SELECT 1'),
      ),
      { code: 'SCHEMA_INCOMPATIBLE' },
    );
  } finally {
    await admin.query('UPDATE fi_control.schema_migrations SET checksum=$1 WHERE version=10', [
      checksum,
    ]);
    await database.close();
    await admin.end();
  }
});
await test('uninitialized source never presents invented zero available securities', async () => {
  const disabled = await postTradeSandbox();
  try {
    const source = (await disabled.read()).body;
    assert.equal(source.available_cash_cents, null);
    assert.equal(source.available_securities, null);
    assert.equal((source.coverage as { complete: boolean }).complete, false);
  } finally {
    await disabled.close();
  }
});
await test('historical source pairs cannot hide causal raw roots', async () => {
  const s = await executionSandbox('1.00', 'BUY', 'SYN-UST-2031', '2030-01-15');
  try {
    assert.equal((await s.command('ACK_ORDER', { expected_version: '1' })).status, 200);
    const x = (await s.fill('2', '1.00')).body.execution!;
    for (const [op, payload] of [
      ['INITIALIZE', { economic_start_date: '2030-01-15' }],
      ['REGISTER', { execution_id: x.id }],
    ] as const)
      assert.equal(
        (
          await s.app.query<{ r: { status: number } }>(
            'SELECT fi_control.posttrade_command($1,$2,1,$3,$4,$5,$6) r',
            [s.id, s.proof, op, JSON.stringify(payload), randomUUID(), s.actor],
          )
        ).rows[0]!.r.status,
        201,
      );
    const source = (
      await s.app.query<{ r: { body: { coverage: { complete: boolean; reasons: string[] } } } }>(
        "SELECT fi_control.read_posttrade($1,$2,'trade',1,0,2) r",
        [s.id, s.proof],
      )
    ).rows[0]!.r.body;
    assert.equal(source.coverage.complete, false);
    assert.ok(source.coverage.reasons.includes('SOURCE_CUTOFF_INCOHERENT'));
  } finally {
    await s.close();
  }
});
