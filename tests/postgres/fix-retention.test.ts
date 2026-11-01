import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { fixture, report } from './fix-fixture.js';
import { connection, owner } from './harness.js';
import { digest } from './rfq-fixture.js';
import type { ReconResult } from './reconciliation-fixture.js';
import { verificationManifest } from '../../app/server/reconciliation/manifest.js';
import { ReconciliationRunner } from '../../app/server/reconciliation/runner.js';
import { encodeFix44 } from '../../app/protocol/fix44/index.js';

// Every sandbox-scoped table deleted by schema 6 retention. A catalog assertion
// prevents a missing dependent table from passing vacuously.
const tables = [
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
  const base: Record<string, string> = await report(s),
    protocolCancel = randomUUID(),
    pending = { ...base, '11': protocolCancel, '41': s.order, '150': '6', '39': '6' },
    physical: { id: string; message: string; raw: Buffer; direction: string }[] = [];
  async function record(fields: Record<string, string>, direction: string) {
    const raw = encodeFix44(fields),
      id = randomUUID(),
      result = await fix(
        'RECORD',
        { order_id: s.order, attempt_id: id, raw_hex: raw.toString('hex') },
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
      { ...base, '34': '2', '17': 'ATLAS-' + randomUUID().toUpperCase() },
      'IN',
    ),
    work = randomUUID(),
    laterWork = randomUUID(),
    laneOwner = randomUUID(),
    financialKeys = [randomUUID(), randomUUID()];
  await fix('QUEUE', { order_id: s.order, message_id: protocolMessage, work_id: work }, 201);
  await fix('QUEUE', { order_id: s.order, message_id: ackMessage, work_id: laterWork }, 201);
  const claim = await fix('CLAIM', { order_id: s.order, owner_id: laneOwner }, 200);
  const lane = { order_id: s.order, owner_id: laneOwner, fence: claim['fence'] };
  await fix('PREPARE', { ...lane, work_id: work, financial_key: financialKeys[0] }, 201);
  const outcome = await fix('RESOLVE_METADATA', { ...lane, work_id: work }, 200);
  assert.equal(outcome['outcome'], 'METADATA_ONLY');
  assert.equal(outcome['financial_applied'], false);
  await fix('PREPARE', { ...lane, work_id: laterWork, financial_key: financialKeys[1] }, 201);
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
    ['fi.fix_bindings', 1],
    ['fi_control.fix_reservations', 1],
    ['fi.fix_lanes', 1],
    ['fi.fix_messages', 3],
    ['fi.fix_attempts', 4],
    ['fi.fix_sequence_slots', 3],
    ['fi.fix_outbox', 1],
    ['fi.fix_dealer_correlations', 1],
    ['fi.fix_cancel_correlations', 1],
    ['fi.fix_work', 2],
    ['fi.fix_prepared', 2],
    ['fi.fix_outcomes', 1],
    ['fi.orders', 2],
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
  const dealer = data['fi.fix_dealer_correlations']![0]!,
    cancellation = data['fi.fix_cancel_correlations']![0]!;
  assert.equal(dealer['first_message_id'], protocolMessage);
  assert.equal(dealer['dealer_order_id'], base['37']);
  assert.equal(cancellation['first_message_id'], protocolMessage);
  assert.equal(cancellation['cl_ord_id'], protocolCancel);
  assert.equal(cancellation['orig_cl_ord_id'], s.order);
  for (const [index, workId] of [work, laterWork].entries()) {
    const queued = data['fi.fix_work']!.find((r) => r['id'] === workId)!,
      prepared = data['fi.fix_prepared']!.find((r) => r['work_id'] === workId)!;
    assert.equal(queued['lane_seq'], index + 1);
    assert.equal(queued['message_id'], index === 0 ? protocolMessage : ackMessage);
    assert.equal(queued['operation'], index === 0 ? 'PROTOCOL_ONLY' : 'ACK_ORDER');
    assert.equal(prepared['operation'], queued['operation']);
    assert.equal(prepared['financial_key'], financialKeys[index]);
    assert.equal(prepared['prepared_fence'], 1);
    assert.equal(prepared['prepared_generation'], 1);
    assert.deepEqual(prepared['payload'], { order_id: s.order, expected_version: '1' });
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
          reserved_commands: 50,
          reserved_events: 86,
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
          reserved_commands: 25,
          reserved_events: 43,
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
