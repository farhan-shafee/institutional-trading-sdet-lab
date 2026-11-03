import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { applicationFixture } from './fix-application-fixture.js';
import { FixApplicationService } from '../../app/server/fix/application.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { fixture, report } from './fix-fixture.js';
import { connection, owner } from './harness.js';
import { digest } from './rfq-fixture.js';
import type { ReconResult } from './reconciliation-fixture.js';
import { verificationManifest } from '../../app/server/reconciliation/manifest.js';
import { ReconciliationRunner } from '../../app/server/reconciliation/runner.js';
import { encodeFix44 } from '../../app/protocol/fix44/index.js';

// Every sandbox-scoped table deleted by installed schema-8 retention. A catalog assertion
// prevents a missing dependent table from passing vacuously.
const tables = [
  'fi.fix_unresolved_ingest',
  'fi.fix_protocol_observations',
  'fi_control.fix_apply_context',
  'fi.fix_consumptions',
  'fi.fix_applications',
  'fi_control.fix_writer_context',
  'fi.fix_events',
  'fi.fix_commands',
  'fi.fix_outcomes',
  'fi.fix_prepared',
  'fi.fix_work',
  'fi.fix_cancel_correlations',
  'fi.fix_dealer_correlations',
  'fi.fix_outbox',
  'fi.fix_attempts',
  'fi.fix_sequence_slots',
  'fi.fix_messages',
  'fi_control.fix_reservations',
  'fi.fix_lanes',
  'fi.fix_bindings',
  'fi.fix_channels',
  'fi.reconciliation_findings',
  'fi.reconciliation_events',
  'fi.reconciliation_runs',
  'fi.reconciliation_commands',
  'fi_control.reconciliation_capacity',
  'fi.positions',
  'fi.order_history',
  'fi.cancellation_outcomes',
  'fi.cancellation_requests',
  'fi.executions',
  'fi.order_states',
  'fi.orders',
  'fi.quotes',
  'fi.invitations',
  'fi.rfqs',
  'fi.audit_events',
  'fi.commands',
  'fi_control.sandbox_access',
  'fi_control.command_keys',
  'fi.sandboxes',
] as const;
type Snapshot = Record<string, Record<string, unknown>[]>;
type Client = Awaited<ReturnType<typeof connection>>;
type Sandbox = Awaited<ReturnType<typeof fixture>>;
const financialTables = [
  'fi.orders',
  'fi.order_states',
  'fi.executions',
  'fi.positions',
  'fi.cancellation_requests',
  'fi.cancellation_outcomes',
  'fi.order_history',
  'fi.rfqs',
  'fi.quotes',
  'fi.invitations',
  'fi.commands',
  'fi.audit_events',
];
async function snapshot(db: Client, id: string): Promise<Snapshot> {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const result: Snapshot = {};
    for (const table of tables) {
      const projection =
        table === 'fi.fix_prepared'
          ? "to_jsonb(t)||jsonb_build_object('payload_text',t.payload::text)"
          : 'to_jsonb(t)';
      result[table] = (
        await db.query<{ record: Record<string, unknown> }>(
          'SELECT ' +
            projection +
            ' AS record FROM ' +
            table +
            ' t WHERE ' +
            (table === 'fi.sandboxes' ? 'id' : 'sandbox_id') +
            '=$1 ORDER BY to_jsonb(t)::text',
          [id],
        )
      ).rows.map((row) => row.record);
    }
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
async function capacity(db: Client) {
  return (
    await db.query<{
      retained: number;
      sandboxes: number;
      reserved_commands: number;
      reserved_events: number;
    }>(
      'SELECT retained_count AS retained,(SELECT count(*)::int FROM fi.sandboxes) AS sandboxes,' +
        '(SELECT COALESCE(sum(commands),0)::int FROM fi_control.fix_reservations WHERE released_at IS NULL) AS reserved_commands,' +
        '(SELECT COALESCE(sum(events),0)::int FROM fi_control.fix_reservations WHERE released_at IS NULL) AS reserved_events ' +
        'FROM fi_control.service_capacity WHERE singleton',
    )
  ).rows[0]!;
}
async function tombstones(db: Client) {
  return (
    await db.query<{ record: Record<string, unknown> }>(
      'SELECT to_jsonb(t) AS record FROM fi_control.purged_sandboxes t ORDER BY id',
    )
  ).rows.map((row) => row.record);
}
async function expireReconciliation(db: Client, id: string) {
  // Existing owned retention-fixture instrumentation: age only test timestamps.
  // Immutable reconciliation guards otherwise prohibit aging a RUNNING row.
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL session_replication_role='replica'");
    await db.query(
      "UPDATE fi.reconciliation_runs SET requested_at=requested_at-interval '1 minute'," +
        "started_at=started_at-interval '1 minute'," +
        "lease_expires_at=CASE WHEN state='RUNNING' THEN clock_timestamp()-interval '1 second' ELSE lease_expires_at END " +
        "WHERE sandbox_id=$1 AND state IN ('REQUESTED','RUNNING')",
      [id],
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
async function populate(
  s: Sandbox,
  db: Client,
  runner: ReconciliationRunner,
  metadata: Awaited<ReturnType<typeof verificationManifest>>,
) {
  const financialOrder = await s.createOrder(),
    cancel = randomUUID();
  assert.equal(
    (await s.command('ACK_ORDER', { order_id: financialOrder, expected_version: '1' })).status,
    200,
  );
  assert.equal(
    (
      await s.command('REQUEST_CANCEL', {
        order_id: financialOrder,
        expected_version: '2',
        cancel_id: cancel,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await s.command('EXECUTE_ORDER', {
        order_id: financialOrder,
        expected_version: '3',
        execution_id: randomUUID(),
        source_event_id: randomUUID(),
        par_amount: '40.00',
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await s.command('ACK_CANCEL', {
        order_id: financialOrder,
        expected_version: '4',
        cancel_id: cancel,
      })
    ).status,
    200,
  );
  // Schema 8 keeps a legacy, unvalidated metadata outcome unresolved. Retain
  // that original protocol-only graph and prepare the ACK on an independent
  // pristine order/lane; no financial application is fabricated to unblock it.
  const ackOrder = await s.createOrder();
  const financial = await snapshot(db, s.id);
  async function requestReconciliation() {
    const run = randomUUID(),
      action = 'CREATE_RECONCILIATION',
      p = { run_id: run };
    const result = (
      await s.app.query<{ result: ReconResult }>(
        'SELECT fi_control.reconciliation_command($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
        [
          s.id,
          s.proof,
          '1',
          action,
          JSON.stringify(p),
          digest(JSON.stringify({ action, p })),
          randomUUID(),
          s.actor,
          JSON.stringify(metadata),
        ],
      )
    ).rows[0]!.result;
    assert.equal(result.status, 201);
    return run;
  }
  const completedRun = await requestReconciliation();
  const completed = await runner.execute(
    { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
    completedRun,
    metadata,
    () => {},
  );
  assert.equal(completed?.state, 'COMPLETED_CLEAN');
  assert.equal(completed.complete, true);
  assert.equal(completed.finding_count, 0);

  const receipts: { action: string; key: string; status: number; body: Record<string, unknown> }[] =
    [];
  async function fix(action: string, input: Record<string, unknown>, status: number) {
    const key = randomUUID(),
      result = await s.fix(action, input, key);
    assert.equal(result.status, status);
    assert.equal(result.replayed, false);
    receipts.push({ action, key, status, body: result.body });
    return result.body;
  }
  await fix('BIND', { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel }, 201);
  await fix('BIND', { order_id: ackOrder, dealer_id: 'ATLAS', channel_id: s.channel }, 201);
  const base: Record<string, string> = await report(s),
    protocolCancel = randomUUID(),
    pending = { ...base, '11': protocolCancel, '41': s.order, '150': '6', '39': '6' },
    physical: { id: string; message: string; raw: Buffer; direction: string }[] = [];
  async function record(fields: Record<string, string>, direction: string, order = s.order) {
    const raw = encodeFix44(fields),
      id = randomUUID(),
      result = await fix(
        'RECORD',
        { order_id: order, attempt_id: id, raw_hex: raw.toString('hex') },
        201,
      );
    assert.equal(result['financial_applied'], false);
    assert.equal(result['delivery_state'], 'NOT_IMPLEMENTED');
    const message = String(result['message_id']);
    physical.push({ id, message, raw, direction });
    return message;
  }
  const protocolMessage = await record(pending, 'IN');
  assert.equal(
    await record(
      { ...pending, '43': 'Y', '122': base['52']!, '52': '20261030-12:01:00.000' },
      'IN',
    ),
    protocolMessage,
  );
  const outbound = Object.fromEntries(
    [
      '35',
      '49',
      '56',
      '34',
      '52',
      '11',
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
      '60',
    ].map((tag) => [tag, base[tag]!]),
  );
  Object.assign(outbound, { '35': 'D', '49': 'TRADEFLOW', '56': 'ATLAS' });
  const outboundMessage = await record(outbound, 'OUT'),
    ackMessage = await record(
      await report({ ...s, order: ackOrder }, { '34': '2' }),
      'IN',
      ackOrder,
    ),
    work = randomUUID(),
    laterWork = randomUUID(),
    laneOwner = randomUUID(),
    financialKeys = [randomUUID(), randomUUID()];
  await fix('QUEUE', { order_id: s.order, message_id: protocolMessage, work_id: work }, 201);
  await fix('QUEUE', { order_id: ackOrder, message_id: ackMessage, work_id: laterWork }, 201);
  const claim = await fix('CLAIM', { order_id: s.order, owner_id: laneOwner }, 200);
  const lane = { order_id: s.order, owner_id: laneOwner, fence: claim['fence'] };
  await fix('PREPARE', { ...lane, work_id: work, financial_key: financialKeys[0] }, 201);
  const outcome = await fix('RESOLVE_METADATA', { ...lane, work_id: work }, 200);
  assert.equal(outcome['outcome'], 'METADATA_ONLY');
  assert.equal(outcome['financial_applied'], false);
  const ackClaim = await fix('CLAIM', { order_id: ackOrder, owner_id: laneOwner }, 200);
  await fix(
    'PREPARE',
    {
      order_id: ackOrder,
      owner_id: laneOwner,
      fence: ackClaim['fence'],
      work_id: laterWork,
      financial_key: financialKeys[1],
    },
    201,
  );
  await db.query(
    "UPDATE fi.fix_lanes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1 AND order_id=$2",
    [s.id, ackOrder],
  );
  async function refresh() {
    return fix('CLAIM', { order_id: s.order, owner_id: laneOwner }, 200);
  }
  await refresh();
  const data = await snapshot(db, s.id);
  for (const table of financialTables)
    assert.ok(isDeepStrictEqual(data[table], financial[table]), table + ': FIX changed finances.');
  for (const field of ['command_count', 'event_count', 'commit_seq', 'generation'])
    assert.equal(data['fi.sandboxes']![0]![field], financial['fi.sandboxes']![0]![field]);
  for (const [table, count] of [
    ['fi.fix_channels', 1],
    ['fi.fix_bindings', 2],
    ['fi_control.fix_reservations', 2],
    ['fi.fix_lanes', 2],
    ['fi.fix_messages', 3],
    ['fi.fix_attempts', 4],
    ['fi.fix_sequence_slots', 3],
    ['fi.fix_outbox', 1],
    ['fi.fix_dealer_correlations', 2],
    ['fi.fix_cancel_correlations', 1],
    ['fi.fix_work', 2],
    ['fi.fix_prepared', 2],
    ['fi.fix_outcomes', 1],
    ['fi.orders', 3],
    ['fi.executions', 1],
    ['fi.positions', 1],
    ['fi.cancellation_requests', 1],
    ['fi.cancellation_outcomes', 1],
    ['fi.reconciliation_runs', 1],
    ['fi.reconciliation_events', 3],
    ['fi.reconciliation_commands', 1],
    ['fi_control.reconciliation_capacity', 1],
  ] as const)
    assert.equal(data[table]!.length, count, table + ': missing positive graph precondition.');
  // These cannot truthfully be populated by a clean committed fixture:
  // rotation writer context is transaction-local; clean reconciliation has no findings.
  assert.equal(data['fi_control.fix_writer_context']!.length, 0);
  assert.equal(data['fi.reconciliation_findings']!.length, 0);
  assert.equal(
    data['fi.order_states']!.find((r) => r['order_id'] === s.order)!['status'],
    'PENDING_ACK',
  );
  assert.equal(
    data['fi.order_states']!.find((r) => r['order_id'] === financialOrder)!['status'],
    'CANCELED',
  );
  assert.equal(data['fi.sandboxes']![0]!['command_count'], data['fi.commands']!.length);
  assert.equal(data['fi.sandboxes']![0]!['event_count'], data['fi.audit_events']!.length);
  assert.equal(data['fi_control.fix_reservations']![0]!['commands'], 25);
  assert.equal(data['fi_control.fix_reservations']![0]!['events'], 43);
  assert.equal(data['fi_control.fix_reservations']![0]!['released_at'], null);
  for (const attempt of physical) {
    const row = data['fi.fix_attempts']!.find((r) => r['id'] === attempt.id)!;
    assert.ok(row);
    assert.equal(row['message_id'], attempt.message);
    assert.equal(row['raw_bytes'], '\\x' + attempt.raw.toString('hex'));
    assert.equal(row['raw_hash'], createHash('sha256').update(attempt.raw).digest('hex'));
    assert.equal(row['state'], attempt.direction === 'IN' ? 'RECEIVED' : 'STAGED');
  }
  assert.deepEqual(
    data['fi.fix_attempts']!.filter((r) => r['message_id'] === protocolMessage)
      .map((r) => r['attempt_no'])
      .sort(),
    [1, 2],
  );
  for (const slot of data['fi.fix_sequence_slots']!) {
    const message = data['fi.fix_messages']!.find((r) => r['id'] === slot['message_id'])!;
    assert.ok(message);
    assert.equal(slot['channel_id'], s.channel);
    assert.equal(slot['direction'], message['direction']);
    assert.equal(String(slot['message_seq']), (message['fields'] as Record<string, string>)['34']);
  }
  assert.equal(data['fi.fix_outbox']![0]!['message_id'], outboundMessage);
  assert.equal(data['fi.fix_outbox']![0]!['order_id'], s.order);
  assert.equal(data['fi.fix_outbox']![0]!['delivery_state'], 'NOT_IMPLEMENTED');
  const dealer = data['fi.fix_dealer_correlations']!.find((r) => r['order_id'] === s.order)!,
    cancellation = data['fi.fix_cancel_correlations']![0]!;
  assert.equal(dealer['first_message_id'], protocolMessage);
  assert.equal(dealer['dealer_order_id'], base['37']);
  assert.equal(cancellation['first_message_id'], protocolMessage);
  assert.equal(cancellation['cl_ord_id'], protocolCancel);
  assert.equal(cancellation['orig_cl_ord_id'], s.order);
  for (const [index, workId] of [work, laterWork].entries()) {
    const queued = data['fi.fix_work']!.find((r) => r['id'] === workId)!,
      prepared = data['fi.fix_prepared']!.find((r) => r['work_id'] === workId)!;
    assert.equal(queued['lane_seq'], 1);
    assert.equal(queued['order_id'], index === 0 ? s.order : ackOrder);
    assert.equal(queued['message_id'], index === 0 ? protocolMessage : ackMessage);
    assert.equal(queued['operation'], index === 0 ? 'PROTOCOL_ONLY' : 'ACK_ORDER');
    assert.equal(prepared['operation'], queued['operation']);
    assert.equal(prepared['financial_key'], financialKeys[index]);
    assert.equal(prepared['prepared_fence'], 1);
    assert.equal(prepared['prepared_generation'], 1);
    assert.deepEqual(prepared['payload'], {
      order_id: index === 0 ? s.order : ackOrder,
      expected_version: '1',
    });
    assert.equal(
      prepared['request_hash'],
      createHash('sha256').update(String(prepared['payload_text'])).digest('hex'),
    );
    assert.equal(
      data['fi_control.command_keys']!.find((r) => r['idempotency_key'] === financialKeys[index])![
        'domain'
      ],
      'FIX_PREPARED',
    );
  }
  assert.equal(data['fi.fix_outcomes']![0]!['work_id'], work);
  assert.equal(data['fi.fix_outcomes']![0]!['outcome'], 'METADATA_ONLY');
  assert.equal(data['fi.fix_outcomes']![0]!['financial_command_id'], null);
  assert.equal(data['fi.fix_outcomes']![0]!['financial_command_seq'], null);
  assert.equal(data['fi.fix_commands']!.length, receipts.length);
  assert.equal(data['fi.fix_events']!.length, receipts.length);
  for (const [index, expected] of receipts.entries()) {
    const receipt = data['fi.fix_commands']!.find((r) => r['idempotency_key'] === expected.key)!,
      event = data['fi.fix_events']!.find((r) => r['command_seq'] === index + 1)!;
    assert.equal(receipt['command_seq'], index + 1);
    assert.equal(receipt['operation'], expected.action);
    assert.equal(receipt['http_status'], expected.status);
    assert.ok(isDeepStrictEqual(receipt['response_body'], expected.body));
    assert.equal(event['event_type'], expected.action);
    assert.equal(event['event_index'], 0);
    assert.equal((event['payload'] as Record<string, unknown>)['financial_applied'], false);
    assert.equal(
      data['fi_control.command_keys']!.find((r) => r['idempotency_key'] === expected.key)![
        'domain'
      ],
      'FIX',
    );
  }
  assert.deepEqual([...new Set(data['fi_control.command_keys']!.map((r) => r['domain']))].sort(), [
    'FINANCIAL',
    'FIX',
    'FIX_PREPARED',
    'RECONCILIATION',
  ]);
  assert.equal(
    data['fi_control.command_keys']!.length,
    data['fi.commands']!.length +
      data['fi.fix_commands']!.length +
      data['fi.reconciliation_commands']!.length +
      data['fi.fix_prepared']!.length,
  );
  return { refresh, requestReconciliation };
}
for (const protection of ['FIX', 'reconciliation'] as const)
  void test(
    'complete FIX graph survives an active ' +
      protection +
      ' lease, then purges atomically without touching another sandbox',
    async () => {
      const s = await fixture(),
        other = await fixture(),
        admin = await connection('admin'),
        maintenance = await connection('maintenance'),
        reconciler = await connection('reconciler'),
        cfg = await owner(),
        runner = new ReconciliationRunner(cfg.reconcilerUrl!);
      try {
        const catalog = (
          await admin.query<{ name: string }>(
            "SELECT table_schema||'.'||table_name AS name FROM information_schema.columns " +
              "WHERE table_schema IN ('fi','fi_control') AND column_name='sandbox_id' ORDER BY name",
          )
        ).rows.map((row) => row.name);
        assert.deepEqual(catalog, tables.filter((t) => t !== 'fi.sandboxes').sort());
        const metadata = await verificationManifest(),
          graph = await populate(s, admin, runner, metadata);
        await populate(other, admin, runner, metadata);
        if (protection === 'FIX') {
          await graph.refresh();
        } else {
          const run = await graph.requestReconciliation();
          const claim = (
            await reconciler.query<{ result: ReconResult }>(
              'SELECT fi_control.claim_reconciliation($1,$2,$3,$4,$5,$6) AS result',
              [s.id, s.proof, '1', run, randomUUID(), JSON.stringify(metadata)],
            )
          ).rows[0]!.result;
          assert.equal(claim.status, 200);
          assert.equal(claim.body['state'], 'RUNNING');
          await admin.query(
            "UPDATE fi.fix_lanes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1",
            [s.id],
          );
        }
        await admin.query(
          "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
          [s.id],
        );
        const before = await snapshot(admin, s.id),
          untouched = await snapshot(admin, other.id),
          capacityBefore = await capacity(admin),
          tombstonesBefore = await tombstones(admin);
        assert.deepEqual(capacityBefore, {
          retained: 2,
          sandboxes: 2,
          reserved_commands: 100,
          reserved_events: 172,
        });
        async function protections() {
          return (
            await admin.query<{ eligible: boolean; fix: number; reconciliation: number }>(
              'SELECT retained_until<=clock_timestamp() AS eligible,' +
                '(SELECT count(*)::int FROM fi.fix_lanes WHERE sandbox_id=$1 AND lease_expires_at>clock_timestamp()) AS fix,' +
                '(SELECT count(*)::int FROM fi.reconciliation_runs WHERE sandbox_id=$1 AND ' +
                "((state='RUNNING' AND lease_expires_at>clock_timestamp()) OR " +
                "(state='REQUESTED' AND requested_at+interval '15 seconds'>clock_timestamp()))) AS reconciliation " +
                'FROM fi.sandboxes WHERE id=$1',
              [s.id],
            )
          ).rows[0]!;
        }
        const protectedState = {
          eligible: true,
          fix: protection === 'FIX' ? 1 : 0,
          reconciliation: protection === 'reconciliation' ? 1 : 0,
        };
        assert.deepEqual(await protections(), protectedState);
        const purge = async () =>
          (
            await maintenance.query<{ removed: number }>(
              'SELECT fi_control.purge_expired() AS removed',
            )
          ).rows[0]!.removed;
        assert.equal(await purge(), 0);
        assert.deepEqual(await protections(), protectedState);
        assert.ok(
          isDeepStrictEqual(await snapshot(admin, s.id), before),
          'Active lease failed to preserve the entire owned graph, bytes, receipts or reservations.',
        );
        assert.ok(
          isDeepStrictEqual(await snapshot(admin, other.id), untouched),
          'Protected purge changed the nonexpired sandbox.',
        );
        assert.deepEqual(await capacity(admin), capacityBefore);
        assert.ok(isDeepStrictEqual(await tombstones(admin), tombstonesBefore));

        // Expire only owned fixture timestamps; do not sleep or bypass maintenance.
        if (protection === 'FIX')
          await admin.query(
            "UPDATE fi.fix_lanes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1",
            [s.id],
          );
        else await expireReconciliation(admin, s.id);
        assert.deepEqual(await protections(), { eligible: true, fix: 0, reconciliation: 0 });
        assert.equal(await purge(), 1);
        const after = await snapshot(admin, s.id);
        for (const table of tables)
          assert.equal(after[table]!.length, 0, table + ': dangling expired-sandbox record.');
        assert.ok(
          isDeepStrictEqual(await snapshot(admin, other.id), untouched),
          'Eligible purge changed the nonexpired sandbox.',
        );
        const capacityAfter = {
          retained: 1,
          sandboxes: 1,
          reserved_commands: 50,
          reserved_events: 86,
        };
        assert.deepEqual(await capacity(admin), capacityAfter);
        const history = await tombstones(admin),
          tombstone = history.filter((row) => row['id'] === s.id);
        assert.equal(tombstone.length, 1);
        assert.equal(typeof tombstone[0]!['purged_at'], 'string');
        assert.ok(Number.isFinite(Date.parse(String(tombstone[0]!['purged_at']))));
        assert.ok(
          isDeepStrictEqual(
            history.filter((row) => row['id'] !== s.id),
            tombstonesBefore,
          ),
          'Purge history was overwritten.',
        );
        assert.equal(
          history.some((row) => row['id'] === other.id),
          false,
        );
        assert.equal(await purge(), 0);
        assert.ok(isDeepStrictEqual(await tombstones(admin), history));
        assert.deepEqual(await capacity(admin), capacityAfter);
        assert.ok(isDeepStrictEqual(await snapshot(admin, other.id), untouched));
        const repeated = await snapshot(admin, s.id);
        for (const table of tables) assert.equal(repeated[table]!.length, 0);
        console.log(
          'Complete FIX retention persisted evidence:',
          JSON.stringify({
            protection,
            preCounts: Object.fromEntries(tables.map((table) => [table, before[table]!.length])),
            postCounts: Object.fromEntries(tables.map((table) => [table, after[table]!.length])),
            protectedPurge: 0,
            eligiblePurge: 1,
            repeatedPurge: 0,
            capacityBefore,
            capacityAfter,
            tombstonesAdded: 1,
            otherSandboxUnchanged: true,
          }),
        );
      } finally {
        await expireReconciliation(admin, s.id);
        await expireReconciliation(admin, other.id);
        await runner.close();
        await reconciler.end();
        await maintenance.end();
        await admin.end();
        await s.close();
        await other.close();
      }
    },
  );

type ApplicationSandbox = Awaited<ReturnType<typeof applicationFixture>>;
async function scopedCatalog(db: Client) {
  const rows = (
    await db.query<{ name: string; identifier: string; column: string }>(
      "SELECT n.nspname||'.'||c.relname AS name,format('%I.%I',n.nspname,c.relname) AS identifier," +
        "CASE WHEN n.nspname='fi' AND c.relname='sandboxes' THEN 'id' ELSE 'sandbox_id' END AS column " +
        'FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace ' +
        "WHERE n.nspname IN ('fi','fi_control') AND c.relkind IN ('r','p') AND " +
        "((n.nspname='fi' AND c.relname='sandboxes') OR EXISTS " +
        "(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attname='sandbox_id' AND NOT a.attisdropped)) ORDER BY name",
    )
  ).rows;
  assert.deepEqual(
    rows.map((r) => r.name),
    [...tables].sort(),
  );
  assert.equal(rows.length, 41);
  return rows;
}
async function catalogCounts(db: Client, id: string) {
  const counts: Record<string, number> = {};
  // Identifiers come from pg_catalog format(%I), never from fixture input.
  for (const table of await scopedCatalog(db))
    counts[table.name] = (
      await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM ' + table.identifier + ' WHERE ' + table.column + '=$1',
        [id],
      )
    ).rows[0]!.count;
  return counts;
}
async function requestApplicationReconciliation(
  s: ApplicationSandbox,
  metadata: Awaited<ReturnType<typeof verificationManifest>>,
) {
  const run = randomUUID(),
    action = 'CREATE_RECONCILIATION',
    p = { run_id: run };
  const result = (
    await s.app.query<{ result: ReconResult }>(
      'SELECT fi_control.reconciliation_command($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
      [
        s.id,
        s.proof,
        '1',
        action,
        JSON.stringify(p),
        digest(JSON.stringify({ action, p })),
        randomUUID(),
        s.actor,
        JSON.stringify(metadata),
      ],
    )
  ).rows[0]!.result;
  assert.equal(result.status, 201);
  return run;
}
async function populateApplicationGraph(
  s: ApplicationSandbox,
  db: Client,
  runner: ReconciliationRunner,
  metadata: Awaited<ReturnType<typeof verificationManifest>>,
  service: FixApplicationService,
) {
  const initial = await snapshot(db, s.id);
  const applied: {
    work: string;
    message: string;
    financialKey: string;
    key: string;
    operation: string;
    result: Record<string, unknown>;
    events: number;
  }[] = [];
  async function apply(changes: Record<string, string>, operation: string, events: number) {
    const prepared = await s.prepare(changes),
      key = randomUUID();
    const result = await s.apply(prepared.work, key);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.replayed, false);
    assert.equal(result.body['financial_applied'], true);
    assert.equal(result.body['delivery_verified'], false);
    applied.push({ ...prepared, key, operation, result: result.body, events });
    return prepared;
  }
  const ack = await apply({}, 'ACK_ORDER', 1),
    price = ack.f['44']!;
  await apply(
    {
      '150': 'F',
      '39': '1',
      '14': '40.00',
      '151': '60.00',
      '32': '40.00',
      '31': price,
      '6': price,
    },
    'EXECUTE_ORDER',
    3,
  );
  const cancel = randomUUID(),
    cancellation = { '11': cancel, '41': s.order };
  await apply(
    { '35': 'F', '49': 'TRADEFLOW', '56': 'ATLAS', ...cancellation },
    'REQUEST_CANCEL',
    1,
  );
  const observation = await s.prepare({
    ...cancellation,
    '150': '6',
    '39': '6',
    '14': '40.00',
    '151': '60.00',
    '6': price,
  });
  const observationKey = randomUUID(),
    observed = await s.apply(observation.work, observationKey);
  assert.equal(observed.status, 200, JSON.stringify(observed.body));
  assert.equal(observed.replayed, false);
  assert.deepEqual(observed.body, {
    order_id: s.order,
    work_id: observation.work,
    financial_applied: false,
    delivery_verified: false,
    outcome: 'METADATA_ONLY',
    validated_pending_cancel: true,
  });
  const pending = await s.prepare({
    '150': 'F',
    '39': '6',
    '14': '60.00',
    '151': '40.00',
    '32': '20.00',
    '31': price,
    '6': price,
  });
  const attempt = randomUUID(),
    ingestKey = randomUUID(),
    rawHex = '61';
  const rejected = await service.ingest(
    { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
    s.actor,
    { order_id: s.order, attempt_id: attempt, raw_hex: rawHex },
    ingestKey,
    () => {},
  );
  const rawHash = createHash('sha256').update(Buffer.from(rawHex, 'hex')).digest('hex');
  assert.equal(rejected.status, 200);
  assert.equal(rejected.replayed, false);
  assert.deepEqual(rejected.body, {
    order_id: s.order,
    attempt_id: attempt,
    raw_hash: rawHash,
    reason: 'FIX_PROFILE_UNSUPPORTED',
    accepted: false,
    unresolved: true,
    financial_applied: false,
  });
  const completedRun = await requestApplicationReconciliation(s, metadata);
  const completed = await runner.execute(
    { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
    completedRun,
    metadata,
    () => {},
  );
  assert.equal(completed?.state, 'COMPLETED_CLEAN');
  assert.equal(completed.complete, true);
  assert.equal(completed.finding_count, 0);
  const data = await snapshot(db, s.id);
  for (const table of [
    'fi.fix_applications',
    'fi.fix_consumptions',
    'fi.fix_protocol_observations',
    'fi.fix_unresolved_ingest',
    'fi.commands',
    'fi.audit_events',
    'fi.order_history',
    'fi.executions',
    'fi.positions',
    'fi.cancellation_requests',
    'fi.fix_prepared',
    'fi.fix_messages',
    'fi.fix_attempts',
    'fi.fix_outbox',
    'fi.fix_work',
    'fi.fix_commands',
    'fi.fix_events',
    'fi_control.command_keys',
    'fi.reconciliation_runs',
  ])
    assert.ok(data[table]!.length > 0, table + ': required positive population.');
  assert.equal(
    data['fi_control.fix_apply_context']!.length,
    0,
    'Private promotion context must not persist.',
  );
  assert.equal(data['fi_control.fix_writer_context']!.length, 0);
  assert.equal(data['fi.fix_applications']!.length, 3);
  assert.equal(data['fi.fix_consumptions']!.length, 3);
  assert.equal(data['fi.fix_prepared']!.length, 5);
  assert.equal(data['fi.fix_work']!.length, 5);
  assert.equal(data['fi.fix_protocol_observations']!.length, 1);
  assert.equal(data['fi.fix_unresolved_ingest']!.length, 1);
  assert.equal(data['fi.executions']!.length, 1);
  assert.equal(data['fi.positions']!.length, 1);
  assert.equal(data['fi.cancellation_requests']!.length, 1);
  assert.equal(
    data['fi.cancellation_outcomes']!.length,
    0,
    'Validated observation does not acknowledge cancellation.',
  );
  assert.equal(data['fi.fix_outcomes']!.length, 1);
  const sandbox = data['fi.sandboxes']![0]!,
    oldSandbox = initial['fi.sandboxes']![0]!;
  assert.equal(Number(sandbox['command_count']) - Number(oldSandbox['command_count']), 3);
  assert.equal(Number(sandbox['event_count']) - Number(oldSandbox['event_count']), 5);
  assert.equal(Number(sandbox['command_count']), data['fi.commands']!.length);
  assert.equal(Number(sandbox['event_count']), data['fi.audit_events']!.length);
  const receipt = (key: string) => {
    const row = data['fi.fix_commands']!.find((r) => r['idempotency_key'] === key);
    assert.ok(row, 'Missing FIX receipt ' + key);
    return row;
  };
  for (const expected of applied) {
    const application = data['fi.fix_applications']!.find((r) => r['work_id'] === expected.work)!;
    const consumption = data['fi.fix_consumptions']!.find((r) => r['work_id'] === expected.work)!;
    const prepared = data['fi.fix_prepared']!.find((r) => r['work_id'] === expected.work)!;
    const financial = data['fi.commands']!.find(
      (r) => r['id'] === application['financial_command_id'],
    )!;
    const protocol = receipt(expected.key);
    assert.ok(application);
    assert.ok(consumption);
    assert.ok(prepared);
    assert.ok(financial);
    assert.equal(application['order_id'], s.order);
    assert.equal(application['message_id'], expected.message);
    assert.equal(application['financial_key'], expected.financialKey);
    assert.equal(application['financial_command_seq'], financial['command_seq']);
    assert.equal(application['financial_request_hash'], financial['request_hash']);
    assert.equal(application['protocol_command_seq'], protocol['command_seq']);
    assert.ok(isDeepStrictEqual(application['result'], expected.result));
    assert.equal(financial['operation'], expected.operation);
    assert.equal(financial['idempotency_key'], expected.financialKey);

    // The immutable prepared-payload hash and OrderService envelope hash are
    // separate contracts. Reconstruct the latter without a writer helper.
    const terms = prepared['payload'] as Record<string, string>;
    const payload: Record<string, string> = {
      order_id: terms['order_id']!,
      expected_version: terms['expected_version']!,
    };
    if (expected.operation === 'EXECUTE_ORDER')
      for (const field of ['execution_id', 'source_event_id', 'par_amount'])
        payload[field] = terms[field]!;
    else if (expected.operation === 'REQUEST_CANCEL') payload['cancel_id'] = terms['cancel_id']!;
    const financialHash = createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          method: 'POST',
          operation: expected.operation,
          sandbox_id: s.id,
          payload,
        }),
      )
      .digest('hex');
    assert.equal(financial['request_hash'], financialHash);
    assert.equal(financial['result_kind'], 'APPLIED');
    assert.equal(financial['http_status'], expected.operation === 'ACK_ORDER' ? 200 : 201);
    const financialResult = expected.result['financial_result'] as Record<string, unknown>;
    assert.equal(financialResult['status'], financial['http_status']);
    assert.ok(isDeepStrictEqual(financialResult['body'], financial['response_body']));

    assert.equal(
      data['fi.audit_events']!.filter((r) => r['command_seq'] === financial['command_seq']).length,
      expected.events,
    );
    assert.ok(data['fi.order_history']!.some((r) => r['command_seq'] === financial['command_seq']));
    assert.equal(consumption['order_id'], s.order);
    assert.equal(consumption['commands'], 1);
    assert.equal(consumption['events'], expected.events);
    assert.equal(protocol['operation'], 'APPLY');
    assert.equal(protocol['http_status'], 200);
    assert.ok(isDeepStrictEqual(protocol['response_body'], expected.result));
    const event = data['fi.fix_events']!.find((r) => r['command_seq'] === protocol['command_seq'])!;
    assert.equal(event['event_type'], 'APPLY');
    assert.ok(
      isDeepStrictEqual(event['payload'], { financial_applied: true, record: expected.result }),
    );
    assert.equal(
      data['fi_control.command_keys']!.find((r) => r['idempotency_key'] === expected.financialKey)![
        'domain'
      ],
      'FINANCIAL',
    );
    assert.equal(
      data['fi_control.command_keys']!.find((r) => r['idempotency_key'] === expected.key)![
        'domain'
      ],
      'FIX',
    );
  }
  const observationRow = data['fi.fix_protocol_observations']![0]!;
  assert.equal(observationRow['work_id'], observation.work);
  assert.equal(observationRow['order_id'], s.order);
  assert.equal(observationRow['cancel_id'], cancel);
  assert.equal(String(observationRow['financial_version']), '4');
  assert.equal(Number(observationRow['filled_par']), 40);
  assert.equal(Number(observationRow['remaining_par']), 60);
  assert.equal(observationRow['protocol_command_seq'], receipt(observationKey)['command_seq']);
  assert.ok(isDeepStrictEqual(receipt(observationKey)['response_body'], observed.body));
  assert.equal(data['fi.fix_outcomes']![0]!['work_id'], observation.work);
  assert.equal(data['fi.fix_outcomes']![0]!['outcome'], 'METADATA_ONLY');
  assert.equal(data['fi.fix_outcomes']![0]!['financial_command_id'], null);
  assert.equal(data['fi.fix_outcomes']![0]!['financial_command_seq'], null);
  for (const item of [observation, pending]) {
    assert.equal(
      data['fi_control.command_keys']!.find((r) => r['idempotency_key'] === item.financialKey)![
        'domain'
      ],
      'FIX_PREPARED',
    );
    assert.equal(
      data['fi.commands']!.some((r) => r['idempotency_key'] === item.financialKey),
      false,
    );
    assert.equal(
      data['fi.fix_applications']!.some((r) => r['work_id'] === item.work),
      false,
    );
    assert.equal(
      data['fi.fix_consumptions']!.some((r) => r['work_id'] === item.work),
      false,
    );
  }
  assert.equal(
    data['fi.fix_outcomes']!.some((r) => r['work_id'] === pending.work),
    false,
  );
  const pendingWork = data['fi.fix_work']!.find((r) => r['id'] === pending.work)!;
  assert.equal(pendingWork['message_id'], pending.message);
  assert.equal(pendingWork['operation'], 'EXECUTE_ORDER');
  assert.equal(pendingWork['lane_seq'], 5);
  const unresolved = data['fi.fix_unresolved_ingest']![0]!;
  assert.equal(unresolved['attempt_id'], attempt);
  assert.equal(unresolved['raw_hash'], rawHash);
  assert.equal(unresolved['reason'], 'FIX_PROFILE_UNSUPPORTED');
  assert.equal(unresolved['order_id'], s.order);
  assert.equal(unresolved['protocol_command_seq'], receipt(ingestKey)['command_seq']);
  assert.deepEqual(
    Object.keys(unresolved).sort(),
    [
      'sandbox_id',
      'order_id',
      'attempt_id',
      'raw_hash',
      'reason',
      'protocol_command_seq',
      'recorded_at',
    ].sort(),
  );
  assert.equal(
    data['fi.fix_attempts']!.some((r) => r['id'] === attempt),
    false,
  );
  assert.ok(isDeepStrictEqual(receipt(ingestKey)['response_body'], rejected.body));
  assert.equal(receipt(ingestKey)['operation'], 'INGEST_REJECTED');

  assert.equal(
    data['fi_control.command_keys']!.find((r) => r['idempotency_key'] === ingestKey)!['domain'],
    'FIX',
  );
  assert.equal(
    data['fi.fix_events']!.find((r) => r['command_seq'] === receipt(ingestKey)['command_seq'])![
      'event_type'
    ],
    'INGEST_REJECTED',
  );
  assert.ok(
    isDeepStrictEqual(
      data['fi.fix_events']!.find((r) => r['command_seq'] === receipt(ingestKey)['command_seq'])![
        'payload'
      ],
      { financial_applied: false, record: rejected.body },
    ),
  );
  assert.equal(receipt(observationKey)['operation'], 'APPLY');
  assert.equal(receipt(observationKey)['http_status'], 200);
  assert.ok(
    isDeepStrictEqual(
      data['fi.fix_events']!.find(
        (r) => r['command_seq'] === receipt(observationKey)['command_seq'],
      )!['payload'],
      { financial_applied: false, record: observed.body },
    ),
  );
  const state = data['fi.order_states']![0]!;
  assert.equal(state['status'], 'PARTIALLY_FILLED');
  assert.equal(String(state['version']), '4');
  assert.equal(Number(state['filled_par']), 40);
  assert.equal(Number(state['remaining_par']), 60);
  assert.equal(state['pending_cancel_id'], cancel);
  assert.equal(
    data['fi_control.command_keys']!.length,
    data['fi.commands']!.length +
      data['fi.fix_commands']!.length +
      data['fi.reconciliation_commands']!.length +
      2,
  );
  for (const physical of data['fi.fix_attempts']!) {
    const raw = Buffer.from(String(physical['raw_bytes']).slice(2), 'hex');
    assert.equal(createHash('sha256').update(raw).digest('hex'), physical['raw_hash']);
    assert.ok(data['fi.fix_messages']!.some((r) => r['id'] === physical['message_id']));
  }
  for (const prepared of data['fi.fix_prepared']!)
    assert.equal(
      createHash('sha256').update(String(prepared['payload_text'])).digest('hex'),
      prepared['request_hash'],
    );
  const reservation = data['fi_control.fix_reservations']![0]!;
  assert.equal(reservation['commands'], 25);
  assert.equal(reservation['events'], 43);
  assert.equal(reservation['released_at'], null);
  const consumedCommands = data['fi.fix_consumptions']!.reduce(
      (n, r) => n + Number(r['commands']),
      0,
    ),
    consumedEvents = data['fi.fix_consumptions']!.reduce((n, r) => n + Number(r['events']), 0);
  assert.equal(consumedCommands, 3);
  assert.equal(consumedEvents, 5);
  return { pending, observation, applied, consumedCommands, consumedEvents };
}

for (const protection of ['FIX', 'reconciliation'] as const)
  void test(
    'schema-8 applied, observed, unresolved and prepared graph survives ' +
      protection +
      ' protection and purges as one transaction',
    async () => {
      const s = await applicationFixture(),
        other = await applicationFixture(),
        admin = await connection('admin'),
        maintenance = await connection('maintenance'),
        reconciler = await connection('reconciler'),
        cfg = await owner(),
        runner = new ReconciliationRunner(cfg.reconcilerUrl!),
        database = new WorkflowDatabase(cfg.appUrl!),
        service = new FixApplicationService(database, true);
      try {
        await scopedCatalog(admin);
        const metadata = await verificationManifest();
        const graph = await populateApplicationGraph(s, admin, runner, metadata, service);
        await populateApplicationGraph(other, admin, runner, metadata, service);
        if (protection === 'FIX') await s.claim();
        else {
          const run = await requestApplicationReconciliation(s, metadata);
          const claim = (
            await reconciler.query<{ result: ReconResult }>(
              'SELECT fi_control.claim_reconciliation($1,$2,$3,$4,$5,$6) AS result',
              [s.id, s.proof, '1', run, randomUUID(), JSON.stringify(metadata)],
            )
          ).rows[0]!.result;
          assert.equal(claim.status, 200);
          assert.equal(claim.body['state'], 'RUNNING');
          await admin.query(
            "UPDATE fi.fix_lanes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1",
            [s.id],
          );
        }
        await admin.query(
          "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
          [s.id],
        );
        const before = await snapshot(admin, s.id),
          untouched = await snapshot(admin, other.id),
          capacityBefore = await capacity(admin),
          tombstonesBefore = await tombstones(admin);
        assert.deepEqual(
          await catalogCounts(admin, s.id),
          Object.fromEntries(tables.map((t) => [t, before[t]!.length])),
        );
        assert.deepEqual(capacityBefore, {
          retained: 2,
          sandboxes: 2,
          reserved_commands: 50,
          reserved_events: 86,
        });
        assert.equal(
          Number(before['fi_control.fix_reservations']![0]!['commands']) - graph.consumedCommands,
          22,
        );
        assert.equal(
          Number(before['fi_control.fix_reservations']![0]!['events']) - graph.consumedEvents,
          38,
        );
        async function protections() {
          return (
            await admin.query<{ eligible: boolean; fix: number; reconciliation: number }>(
              'SELECT retained_until<=clock_timestamp() AS eligible,' +
                '(SELECT count(*)::int FROM fi.fix_lanes WHERE sandbox_id=$1 AND lease_expires_at>clock_timestamp()) AS fix,' +
                "(SELECT count(*)::int FROM fi.reconciliation_runs WHERE sandbox_id=$1 AND ((state='RUNNING' AND lease_expires_at>clock_timestamp()) OR (state='REQUESTED' AND requested_at+interval '15 seconds'>clock_timestamp()))) AS reconciliation FROM fi.sandboxes WHERE id=$1",
              [s.id],
            )
          ).rows[0]!;
        }
        const protectedState = {
          eligible: true,
          fix: protection === 'FIX' ? 1 : 0,
          reconciliation: protection === 'reconciliation' ? 1 : 0,
        };
        assert.deepEqual(await protections(), protectedState);
        assert.equal(
          (
            await admin.query<{ live: boolean }>(
              'SELECT retained_until>clock_timestamp() AS live FROM fi.sandboxes WHERE id=$1',
              [other.id],
            )
          ).rows[0]!.live,
          true,
        );
        const purge = async () =>
          (
            await maintenance.query<{ removed: number }>(
              'SELECT fi_control.purge_expired() AS removed',
            )
          ).rows[0]!.removed;
        assert.equal(await purge(), 0);
        assert.deepEqual(await protections(), protectedState);
        assert.ok(
          isDeepStrictEqual(await snapshot(admin, s.id), before),
          'Protected B2 evidence changed.',
        );
        assert.ok(
          isDeepStrictEqual(await snapshot(admin, other.id), untouched),
          'Nonexpired graph changed.',
        );
        assert.deepEqual(await capacity(admin), capacityBefore);
        assert.ok(isDeepStrictEqual(await tombstones(admin), tombstonesBefore));
        if (protection === 'FIX')
          await admin.query(
            "UPDATE fi.fix_lanes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1",
            [s.id],
          );
        else await expireReconciliation(admin, s.id);
        assert.deepEqual(await protections(), { eligible: true, fix: 0, reconciliation: 0 });
        const eligible = await snapshot(admin, s.id);
        // Normal maintenance authority and MVCC prove no partial graph is visible,
        // and rolling back purge restores the complete graph, capacity and history.
        await maintenance.query('BEGIN');
        try {
          assert.equal(await purge(), 1);
          assert.ok(isDeepStrictEqual(await snapshot(admin, s.id), eligible));
          assert.ok(isDeepStrictEqual(await snapshot(admin, other.id), untouched));
          assert.deepEqual(await capacity(admin), capacityBefore);
          assert.ok(isDeepStrictEqual(await tombstones(admin), tombstonesBefore));
        } finally {
          await maintenance.query('ROLLBACK');
        }
        assert.ok(isDeepStrictEqual(await snapshot(admin, s.id), eligible));
        assert.deepEqual(await capacity(admin), capacityBefore);
        assert.ok(isDeepStrictEqual(await tombstones(admin), tombstonesBefore));
        assert.equal(await purge(), 1);
        const after = await snapshot(admin, s.id),
          counts = await catalogCounts(admin, s.id);
        for (const [table, count] of Object.entries(counts)) {
          assert.equal(count, 0, table + ': catalog-discovered orphan after purge.');
          assert.equal(after[table]!.length, 0);
        }
        assert.ok(isDeepStrictEqual(await snapshot(admin, other.id), untouched));
        const capacityAfter = {
          retained: 1,
          sandboxes: 1,
          reserved_commands: 25,
          reserved_events: 43,
        };
        assert.deepEqual(await capacity(admin), capacityAfter);
        const history = await tombstones(admin),
          tombstone = history.filter((r) => r['id'] === s.id);
        assert.equal(tombstone.length, 1);
        assert.equal(typeof tombstone[0]!['purged_at'], 'string');
        assert.ok(Number.isFinite(Date.parse(String(tombstone[0]!['purged_at']))));
        assert.ok(
          isDeepStrictEqual(
            history.filter((r) => r['id'] !== s.id),
            tombstonesBefore,
          ),
        );
        assert.equal(
          history.some((r) => r['id'] === other.id),
          false,
        );
        assert.equal(await purge(), 0);
        assert.ok(isDeepStrictEqual(await tombstones(admin), history));
        assert.deepEqual(await capacity(admin), capacityAfter);
        assert.ok(isDeepStrictEqual(await snapshot(admin, other.id), untouched));
        assert.deepEqual(await catalogCounts(admin, s.id), counts);
        console.log(
          'Schema-8 complete application retention evidence:',
          JSON.stringify({
            protection,
            sandbox: s.id,
            otherSandbox: other.id,
            preCounts: Object.fromEntries(tables.map((t) => [t, before[t]!.length])),
            postCounts: counts,
            financialCommands: before['fi.commands']!.length,
            financialEvents: before['fi.audit_events']!.length,
            applications: graph.applied.map((r) => ({
              work: r.work,
              message: r.message,
              financialKey: r.financialKey,
              operation: r.operation,
            })),
            unappliedWork: graph.pending.work,
            observationWork: graph.observation.work,
            consumedCommands: graph.consumedCommands,
            consumedEvents: graph.consumedEvents,
            protectedPurge: 0,
            rolledBackPurge: 1,
            eligiblePurge: 1,
            repeatedPurge: 0,
            capacityBefore,
            capacityAfter,
            tombstonesAdded: 1,
            otherSandboxUnchanged: true,
            protectedSnapshotHash: createHash('sha256')
              .update(JSON.stringify(before))
              .digest('hex'),
            otherSnapshotHash: createHash('sha256').update(JSON.stringify(untouched)).digest('hex'),
          }),
        );
      } finally {
        await maintenance.query('ROLLBACK');
        await expireReconciliation(admin, s.id);
        await expireReconciliation(admin, other.id);
        await database.close();
        await runner.close();
        await reconciler.end();
        await maintenance.end();
        await admin.end();
        await s.close();
        await other.close();
      }
    },
  );
