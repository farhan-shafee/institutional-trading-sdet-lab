import pg from 'pg';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  recoveryState,
  recoveryOracle,
  oracleEvidence,
} from './fix-application-recovery-support.js';
import { FixFoundationService } from '../../app/server/fix/foundation.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applicationFixture } from './fix-application-fixture.js';
import { owner, connection } from './harness.js';
import { restartOwnedPostgres, verifyOwned } from '../../scripts/owned-postgres.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { FixApplicationService } from '../../app/server/fix/application.js';
import { DomainError } from '../../app/domain/errors.js';
void test('actual database stop/restart preserves prepared execution identity and financial application, outage fails closed', async () => {
  const s = await applicationFixture(),
    cfg = await owner(),
    db = new WorkflowDatabase(cfg.appUrl!),
    service = new FixApplicationService(db, true);
  let admin: pg.Client | undefined = await connection('admin');
  s.app.on('error', () => {});
  try {
    await s.apply((await s.prepare()).work);
    const px = (
      await s.app.query<{ contract: Record<string, string> }>(
        'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.contract['clean_price']!;
    const p = await s.prepare({
        '150': 'F',
        '39': '2',
        '14': '100.00',
        '151': '0.00',
        '32': '100.00',
        '31': px,
        '6': px,
      }),
      key = randomUUID(),
      binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' },
      input = { order_id: s.order, owner_id: s.owner, fence: s.fence, work_id: p.work };
    const applied = await service.apply(binding, s.actor, input, key, () => {});
    assert.equal(applied.status, 200);
    const committed = await recoveryState(admin, s.id);
    await admin.end();
    admin = undefined;
    await restartOwnedPostgres(process.env.TF_DB_OWNER_FILE!, async () => {
      await assert.rejects(
        service.apply(binding, s.actor, input, key, () => {}),
        (e: unknown) =>
          e instanceof DomainError && e.status === 503 && e.code === 'DATABASE_UNAVAILABLE',
      );
    });
    admin = new pg.Client({ connectionString: cfg.adminUrl });
    await admin.connect();
    assert.deepEqual(await recoveryState(admin, s.id), committed);
    const replay = await service.apply(binding, s.actor, input, key, () => {});
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, applied.body);
    assert.deepEqual(await recoveryState(admin, s.id), committed);
    const oracle = await recoveryOracle(admin, s.id);
    assert.equal(oracle.status, 0, oracle.stderr);
    assert.equal(oracleEvidence(oracle.stdout).executions, 1);
    assert.equal(oracleEvidence(oracle.stdout).frames, 3);
  } finally {
    await admin?.end();
    await db.close();
    await s.close();
  }
});

void test('prepared but unapplied execution survives the same owned database restart and applies once through the retained endpoint after lease reclaim', async () => {
  const s = await applicationFixture(),
    cfg = await owner(),
    db = new WorkflowDatabase(cfg.appUrl!),
    service = new FixApplicationService(db, true),
    foundation = new FixFoundationService(db, true),
    binding = { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' as const };
  let admin: pg.Client | undefined = await connection('admin');
  s.app.on('error', () => {});
  try {
    assert.equal((await s.apply((await s.prepare()).work)).status, 200);
    const contract = (
      await s.app.query<{ contract: Record<string, string> }>(
        'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.contract;
    const p = await s.prepare({
        '150': 'F',
        '39': '2',
        '14': '100.00',
        '151': '0.00',
        '32': '100.00',
        '31': contract['clean_price']!,
        '6': contract['clean_price']!,
      }),
      key = randomUUID(),
      descriptorPath = process.env.TF_DB_OWNER_FILE!;
    // Warm the retained service's pool; it must reconnect using its original URL.
    assert.equal((await foundation.read(binding, 'STATE', s.order, () => {})).status, 200);
    await admin.query(
      "UPDATE fi.fix_lanes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1 AND order_id=$2",
      [s.id, s.order],
    );
    const before = await recoveryState(admin, s.id),
      immutablePrepared = before['fi.fix_prepared']!.find((r) => r['work_id'] === p.work)!,
      payload = immutablePrepared['payload'] as Record<string, string>,
      ownedBefore = await verifyOwned(descriptorPath),
      descriptorHash = createHash('sha256')
        .update(await readFile(descriptorPath))
        .digest('hex');
    assert.equal(
      before['fi.fix_applications']!.some((r) => r['work_id'] === p.work),
      false,
    );
    assert.equal(
      before['fi.fix_consumptions']!.some((r) => r['work_id'] === p.work),
      false,
    );
    assert.equal(before['fi.executions']!.length, 0);
    assert.equal(
      before['fi.commands']!.some((r) => r['idempotency_key'] === p.financialKey),
      false,
    );
    assert.equal(
      before['fi_control.command_keys']!.find((r) => r['idempotency_key'] === p.financialKey)![
        'domain'
      ],
      'FIX_PREPARED',
    );
    const message = before['fi.fix_messages']!.find((r) => r['id'] === p.message)!;
    assert.equal(message['execution_id'], payload['execution_id']);
    assert.equal(message['source_event_id'], payload['source_event_id']);
    assert.equal(immutablePrepared['financial_key'], p.financialKey);
    assert.equal(Number(immutablePrepared['prepared_fence']), 1);
    assert.equal(Number(immutablePrepared['prepared_generation']), 1);
    await admin.end();
    admin = undefined;
    await restartOwnedPostgres(descriptorPath, async () => {
      await assert.rejects(
        service.apply(
          binding,
          s.actor,
          {
            order_id: s.order,
            owner_id: s.owner,
            fence: s.fence,
            work_id: p.work,
          },
          key,
          () => {},
        ),
        (error: unknown) =>
          error instanceof DomainError &&
          error.status === 503 &&
          error.code === 'DATABASE_UNAVAILABLE',
      );
    });
    const ownedAfter = await verifyOwned(descriptorPath);
    assert.equal(ownedAfter.container === ownedBefore.container, true);
    assert.equal(ownedAfter.volume === ownedBefore.volume, true);
    assert.equal(ownedAfter.nonce === ownedBefore.nonce, true);
    assert.equal(ownedAfter.appUrl === cfg.appUrl, true, 'Retained application endpoint changed.');
    assert.equal(
      createHash('sha256')
        .update(await readFile(descriptorPath))
        .digest('hex'),
      descriptorHash,
    );
    // Reconnect the observer with its ORIGINAL endpoint, not a refreshed URL.
    admin = new pg.Client({ connectionString: cfg.adminUrl });
    await admin.connect();
    assert.deepEqual(await recoveryState(admin, s.id), before);
    const nextOwner = randomUUID(),
      claimed = await foundation.command(
        binding,
        s.actor,
        'CLAIM',
        { order_id: s.order, owner_id: nextOwner },
        randomUUID(),
        () => {},
      );
    assert.equal(claimed.status, 200);
    assert.ok(claimed.body !== null && typeof claimed.body === 'object');
    const fence = String((claimed.body as Record<string, unknown>)['fence']);
    assert.ok(Number(fence) > Number(immutablePrepared['prepared_fence']));
    const input = { order_id: s.order, owner_id: nextOwner, fence, work_id: p.work },
      afterClaim = await recoveryState(admin, s.id);
    assert.deepEqual(afterClaim['fi.fix_prepared'], before['fi.fix_prepared']);
    const applied = await service.apply(binding, s.actor, input, key, () => {});
    assert.equal(applied.status, 200);
    assert.equal(applied.replayed, false);
    const committed = await recoveryState(admin, s.id),
      commands = committed['fi.commands']!.filter((r) => r['idempotency_key'] === p.financialKey),
      applications = committed['fi.fix_applications']!.filter((r) => r['work_id'] === p.work),
      consumption = committed['fi.fix_consumptions']!.filter((r) => r['work_id'] === p.work);
    assert.equal(commands.length, 1);
    assert.equal(applications.length, 1);
    assert.equal(consumption.length, 1);
    const command = commands[0]!,
      application = applications[0]!;
    assert.equal(command['operation'], 'EXECUTE_ORDER');
    assert.equal(command['result_kind'], 'APPLIED');
    assert.equal(application['financial_command_id'], command['id']);
    assert.equal(application['financial_command_seq'], command['command_seq']);
    assert.equal(application['message_id'], p.message);
    assert.equal(application['financial_key'], p.financialKey);
    assert.equal(String(application['applied_fence']), fence);
    assert.equal(Number(application['applied_generation']), 1);
    assert.equal(consumption[0]!['commands'], 1);
    assert.equal(consumption[0]!['events'], 3);
    assert.equal(committed['fi.executions']!.length, 1);
    assert.equal(committed['fi.executions']![0]!['id'], payload['execution_id']);
    assert.equal(committed['fi.executions']![0]!['source_event_id'], payload['source_event_id']);
    assert.equal(Number(committed['fi.positions']![0]!['signed_par']), 100);
    assert.equal(committed['fi.positions']![0]!['execution_count'], 1);
    const history = committed['fi.order_history']!.filter((r) => r['command_id'] === command['id']);
    assert.equal(history.length, 1);
    assert.equal(Number(history[0]!['version']), 3);
    const audits = committed['fi.audit_events']!.filter((r) => r['command_id'] === command['id']);
    assert.deepEqual(audits.map((r) => r['event_type']).sort(), [
      'EXECUTION_RECORDED',
      'ORDER_STATE_CHANGED',
      'POSITION_UPDATED',
    ]);
    const receipt = committed['fi.fix_commands']!.filter((r) => r['idempotency_key'] === key);
    assert.equal(receipt.length, 1);
    assert.equal(receipt[0]!['operation'], 'APPLY');
    assert.equal(receipt[0]!['http_status'], 200);
    assert.equal(application['protocol_command_seq'], receipt[0]!['command_seq']);
    assert.deepEqual(receipt[0]!['response_body'], applied.body);
    assert.deepEqual(application['result'], applied.body);
    const events = committed['fi.fix_events']!.filter(
      (r) => r['command_seq'] === receipt[0]!['command_seq'],
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!['event_type'], 'APPLY');
    assert.deepEqual(events[0]!['payload'], { financial_applied: true, record: applied.body });
    assert.equal(
      committed['fi_control.command_keys']!.find((r) => r['idempotency_key'] === p.financialKey)![
        'domain'
      ],
      'FINANCIAL',
    );
    assert.equal(
      committed['fi_control.command_keys']!.find((r) => r['idempotency_key'] === key)!['domain'],
      'FIX',
    );
    assert.deepEqual(committed['fi.fix_prepared'], before['fi.fix_prepared']);
    assert.deepEqual(
      committed['fi_control.fix_reservations'],
      before['fi_control.fix_reservations'],
    );
    assert.equal(committed['fi_control.fix_apply_context']!.length, 0);
    assert.equal(committed['fi.commands']!.length, afterClaim['fi.commands']!.length + 1);
    assert.equal(committed['fi.audit_events']!.length, afterClaim['fi.audit_events']!.length + 3);
    assert.equal(committed['fi.order_history']!.length, afterClaim['fi.order_history']!.length + 1);
    assert.equal(
      committed['financial_counters']![0]!['command_count'],
      Number(afterClaim['financial_counters']![0]!['command_count']) + 1,
    );
    assert.equal(
      committed['financial_counters']![0]!['event_count'],
      Number(afterClaim['financial_counters']![0]!['event_count']) + 3,
    );
    const oracle = await recoveryOracle(admin, s.id);
    assert.equal(oracle.status, 0, oracle.stderr);
    assert.equal(oracleEvidence(oracle.stdout).executions, 1);
    assert.equal(oracleEvidence(oracle.stdout).frames, 3);
    const replay = await service.apply(binding, s.actor, input, key, () => {});
    assert.equal(replay.status, 200);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, applied.body);
    assert.deepEqual(await recoveryState(admin, s.id), committed);
    console.log(
      'Unapplied execution restart evidence:',
      JSON.stringify({
        work: p.work,
        message: p.message,
        financialKey: p.financialKey,
        originalKey: key,
        execution: payload['execution_id'],
        sourceEvent: payload['source_event_id'],
        sameContainer: true,
        sameVolume: true,
        sameNonce: true,
        sameDescriptor: true,
        retainedEndpoint: true,
        preparedFence: 1,
        appliedFence: fence,
        financialEffects: 1,
        oracle: oracleEvidence(oracle.stdout),
      }),
    );
  } finally {
    await admin?.end();
    await db.close();
    await s.close();
  }
});
