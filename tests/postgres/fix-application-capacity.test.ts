import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applicationFixture } from './fix-application-fixture.js';
import { connection } from './harness.js';
import { assertCleanCapacity, capacityEvidence } from './fix-capacity-oracle.js';

type ApplicationSandbox = Awaited<ReturnType<typeof applicationFixture>>;
type FinancialOperation =
  | 'ACK_ORDER'
  | 'REJECT_ORDER'
  | 'EXECUTE_ORDER'
  | 'REQUEST_CANCEL'
  | 'ACK_CANCEL'
  | 'REJECT_CANCEL';

async function applyWithCapacityEvidence(
  s: ApplicationSandbox,
  admin: Awaited<ReturnType<typeof connection>>,
  work: string,
  operation: FinancialOperation,
  events = 1,
) {
  const before = await capacityEvidence(admin, s.id),
    key = randomUUID(),
    applied = await s.apply(work, key);
  assert.equal(applied.status, 200);
  assert.equal(applied.replayed, false);
  assert.equal(applied.body['financial_applied'], true);
  const after = await capacityEvidence(admin, s.id);
  assert.equal(after.C, before.C + 1);
  assert.equal(after.E, before.E + events);
  assert.equal(after.R, before.R - 1);
  assert.equal(after.S, before.S - events);
  assert.equal(after.C + after.R, before.C + before.R);
  assert.equal(after.E + after.S, before.E + before.S);
  assert.equal(after.N, before.N);
  assert.equal(after.H, before.H);
  assert.equal(after.bindings, before.bindings);
  assert.equal(after.active, before.active);
  const prepared = after.state['fi.fix_prepared']!.find((row) => row['work_id'] === work)!;
  assert.ok(prepared);
  assert.equal(prepared['operation'], operation);
  const financial = after.state['fi.commands']!.filter(
    (row) => row['idempotency_key'] === prepared['financial_key'],
  );
  assert.equal(financial.length, 1);
  assert.equal(financial[0]!['operation'], operation);
  assert.equal(financial[0]!['result_kind'], 'APPLIED');
  const consumption = after.state['fi.fix_consumptions']!.filter((row) => row['work_id'] === work);
  assert.equal(consumption.length, 1);
  assert.equal(consumption[0]!['commands'], 1);
  assert.equal(consumption[0]!['events'], events);
  const replay = await s.apply(work, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, applied.body);
  assert.deepEqual(await capacityEvidence(admin, s.id), after);
  return applied;
}

void test('entire25-command41-audit lifecycle spends only actual effects at protected512 boundary; manual writer and rotation retain safeguards', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin');
  try {
    const other = await s.createOrder();
    const actual = (
      await admin.query<{ n: number }>('SELECT command_count n FROM fi.sandboxes WHERE id=$1', [
        s.id,
      ])
    ).rows[0]!.n;
    for (let i = actual; i < 485; i++)
      assert.equal(
        (await s.command('ACK_ORDER', { order_id: other, expected_version: '999' })).status,
        409,
      );
    await s.claim();
    const protectedStart = await capacityEvidence(admin, s.id);
    assert.equal(protectedStart.C, 485);
    assert.equal(protectedStart.R, 25);
    assert.equal(protectedStart.S, 43);
    assert.equal(protectedStart.N, 0);
    assert.equal(protectedStart.H, 2);
    assert.equal(protectedStart.C + protectedStart.R + protectedStart.H, 512);
    await assertCleanCapacity(admin, {
      sandboxId: s.id,
      digest: s.proof,
      generation: '1',
      scope: 'trade',
    });
    const checkedApply = (work: string, operation: FinancialOperation, events = 1) =>
      applyWithCapacityEvidence(s, admin, work, operation, events);
    assert.equal((await checkedApply((await s.prepare()).work, 'ACK_ORDER')).status, 200);
    const px = (
      await s.app.query<{ contract: Record<string, string> }>(
        'SELECT contract FROM fi.orders WHERE sandbox_id=$1 AND id=$2',
        [s.id, s.order],
      )
    ).rows[0]!.contract['clean_price']!;
    for (let i = 1; i <= 8; i++) {
      const cancel = randomUUID(),
        base = { '11': cancel, '41': s.order };
      assert.equal(
        (
          await checkedApply(
            (await s.prepare({ '35': 'F', '49': 'TRADEFLOW', '56': 'ATLAS', ...base })).work,
            'REQUEST_CANCEL',
          )
        ).status,
        200,
      );
      const cum = (BigInt(i) * 1250n).toString().padStart(3, '0'),
        left = (10000n - BigInt(i) * 1250n).toString().padStart(3, '0');
      const fmt = (v: string) => v.slice(0, -2) + '.' + v.slice(-2);
      assert.equal(
        (
          await checkedApply(
            (
              await s.prepare({
                '150': 'F',
                '39': i === 8 ? '2' : '1',
                '14': fmt(cum),
                '151': fmt(left),
                '32': '12.50',
                '31': px,
                '6': px,
              })
            ).work,
            'EXECUTE_ORDER',
            3,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await checkedApply(
            (
              await s.prepare({
                '35': '9',
                ...base,
                '39': i === 8 ? '2' : '1',
                '434': '1',
                '102': i === 8 ? '0' : '99',
              })
            ).work,
            'REJECT_CANCEL',
          )
        ).status,
        200,
      );
    }
    assert.deepEqual(
      (
        await admin.query(
          'SELECT count(*)::int commands,sum(events)::int events FROM fi.fix_consumptions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows,
      [{ commands: 25, events: 41 }],
    );
    assert.equal(
      (
        await admin.query<{ command_count: number }>(
          'SELECT command_count FROM fi.sandboxes WHERE id=$1',
          [s.id],
        )
      ).rows[0]!.command_count,
      510,
    );
    const completed = await capacityEvidence(admin, s.id);
    assert.equal(completed.C, protectedStart.C + 25);
    assert.equal(completed.E, protectedStart.E + 41);
    assert.equal(completed.R, 0);
    assert.equal(completed.S, 2);
    assert.equal(completed.N, 0);
    assert.equal(completed.H, 2);
    assert.equal(completed.state['fi.fix_applications']!.length, 25);
    assert.equal(completed.state['fi.fix_consumptions']!.length, 25);
    const observed = await assertCleanCapacity(admin, {
      sandboxId: s.id,
      digest: s.proof,
      generation: '1',
      scope: 'trade',
    });
    assert.equal(observed.applied_work_count, 25);
    assert.equal(observed.unresolved_message_count, 0);
    assert.equal(observed.assessment, 'OBSERVED_APPLICATION_CONSISTENT');
    assert.equal(observed.financial_application_verified, true);
    console.log(
      'Complete capacity lifecycle evidence:',
      JSON.stringify({
        C: completed.C,
        E: completed.E,
        R: completed.R,
        S: completed.S,
        N: completed.N,
        H: completed.H,
        applied: observed.applied_work_count,
        unresolved: observed.unresolved_message_count,
        assessment: observed.assessment,
      }),
    );
    const manual = await s.command('ACK_ORDER', { order_id: other, expected_version: '1' });
    assert.equal(manual.status, 429);
    assert.equal(manual.body.error?.code, 'PROTECTED_FINANCIAL_CAPACITY');
    assert.deepEqual(await capacityEvidence(admin, s.id), completed);
    const rotated = (
      await s.app.query<{ r: { status: number } }>(
        'SELECT fi_control.rotate_capabilities($1,$2,1,1,$3,$4,$5,$6,$7) r',
        [s.id, s.proof, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), randomUUID(), s.actor],
      )
    ).rows[0]!.r;
    assert.equal(rotated.status, 200);
    assert.equal(
      (
        await admin.query<{ n: number }>('SELECT command_count n FROM fi.sandboxes WHERE id=$1', [
          s.id,
        ])
      ).rows[0]!.n,
      511,
    );
    const once = await capacityEvidence(admin, s.id);
    assert.equal(once.C, 511);
    assert.equal(once.E, completed.E + 1);
    assert.equal(once.R, 0);
    assert.equal(once.S, 2);
    assert.equal(once.N, 1);
    assert.equal(once.H, 1);
    await assertCleanCapacity(admin, {
      sandboxId: s.id,
      digest: 'b'.repeat(64),
      generation: '2',
      scope: 'trade',
    });
    const secondRotation = (
      await s.app.query<{ r: { status: number; replayed: boolean } }>(
        'SELECT fi_control.rotate_capabilities($1,$2,2,2,$3,$4,$5,$6,$7) r',
        [
          s.id,
          'b'.repeat(64),
          'd'.repeat(64),
          'e'.repeat(64),
          'f'.repeat(64),
          randomUUID(),
          s.actor,
        ],
      )
    ).rows[0]!.r;
    assert.equal(secondRotation.status, 200);
    assert.equal(secondRotation.replayed, false);
    const full = await capacityEvidence(admin, s.id);
    assert.equal(full.C, 512);
    assert.equal(full.E, completed.E + 2);
    assert.equal(full.R, 0);
    assert.equal(full.S, 2);
    assert.equal(full.N, 2);
    assert.equal(full.H, 0);
    assert.ok(full.E + full.S < 1024, 'The actual command ceiling must be decisive.');
    await assertCleanCapacity(admin, {
      sandboxId: s.id,
      digest: 'e'.repeat(64),
      generation: '3',
      scope: 'trade',
    });
    const blockedRotation = (
      await s.app.query<{
        r: { status: number; replayed: boolean; body: { error: { code: string } } };
      }>('SELECT fi_control.rotate_capabilities($1,$2,3,3,$3,$4,$5,$6,$7) r', [
        s.id,
        'e'.repeat(64),
        '1'.repeat(64),
        '2'.repeat(64),
        '3'.repeat(64),
        randomUUID(),
        s.actor,
      ])
    ).rows[0]!.r;
    assert.equal(blockedRotation.status, 429);
    assert.equal(blockedRotation.replayed, false);
    assert.equal(blockedRotation.body.error.code, 'SANDBOX_QUOTA_REACHED');
    assert.deepEqual(await capacityEvidence(admin, s.id), full);
    await assertCleanCapacity(admin, {
      sandboxId: s.id,
      digest: 'e'.repeat(64),
      generation: '3',
      scope: 'trade',
    });
  } finally {
    await admin.end();
    await s.close();
  }
});
void test('rotation spends one shared recovery slot without stranding already protected prepared financial work at quota', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin');
  try {
    const other = await s.createOrder(),
      p = await s.prepare();
    const actual = (
      await admin.query<{ n: number }>('SELECT command_count n FROM fi.sandboxes WHERE id=$1', [
        s.id,
      ])
    ).rows[0]!.n;
    for (let i = actual; i < 485; i++)
      assert.equal(
        (await s.command('ACK_ORDER', { order_id: other, expected_version: '999' })).status,
        409,
      );
    const proof = 'b'.repeat(64);
    assert.equal(
      (
        await s.app.query<{ r: { status: number } }>(
          'SELECT fi_control.rotate_capabilities($1,$2,1,1,$3,$4,$5,$6,$7) r',
          [s.id, s.proof, 'a'.repeat(64), proof, 'c'.repeat(64), randomUUID(), s.actor],
        )
      ).rows[0]!.r.status,
      200,
    );
    const owner = randomUUID(),
      lease = (
        await s.app.query<{ r: { body: { fence: string } } }>(
          'SELECT fi_control.fix_command($1,$2,2,$3,$4,$5,$6) r',
          [
            s.id,
            proof,
            'CLAIM',
            JSON.stringify({ order_id: s.order, owner_id: owner }),
            randomUUID(),
            s.actor,
          ],
        )
      ).rows[0]!.r.body;
    const before = await capacityEvidence(admin, s.id);
    assert.equal(before.C, 486);
    assert.equal(before.R, 25);
    assert.equal(before.S, 43);
    assert.equal(before.N, 1);
    assert.equal(before.H, 1);
    await assertCleanCapacity(admin, {
      sandboxId: s.id,
      digest: proof,
      generation: '2',
      scope: 'trade',
    });
    const args = [
      s.id,
      proof,
      JSON.stringify({
        order_id: s.order,
        owner_id: owner,
        fence: lease.fence,
        work_id: p.work,
      }),
      randomUUID(),
      s.actor,
    ];
    const r = (
      await s.app.query<{
        r: { status: number; replayed: boolean; body: Record<string, unknown> };
      }>('SELECT fi_control.apply_fix($1,$2,2,$3,$4,$5) r', args)
    ).rows[0]!.r;
    assert.equal(r.status, 200);
    assert.equal(r.replayed, false);
    const after = await capacityEvidence(admin, s.id);
    assert.equal(after.C, before.C + 1);
    assert.equal(after.E, before.E + 1);
    assert.equal(after.R, before.R - 1);
    assert.equal(after.S, before.S - 1);
    assert.equal(after.C + after.R + after.H, 512);
    assert.equal(after.E + after.S, before.E + before.S);
    assert.equal(after.N, before.N);
    assert.equal(after.H, before.H);
    const replay = (
      await s.app.query<{
        r: { status: number; replayed: boolean; body: Record<string, unknown> };
      }>('SELECT fi_control.apply_fix($1,$2,2,$3,$4,$5) r', args)
    ).rows[0]!.r;
    assert.equal(replay.status, 200);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, r.body);
    assert.deepEqual(await capacityEvidence(admin, s.id), after);
    await assertCleanCapacity(admin, {
      sandboxId: s.id,
      digest: proof,
      generation: '2',
      scope: 'trade',
    });
  } finally {
    await admin.end();
    await s.close();
  }
});

void test('REJECT_ORDER consumes one protected command and audit with exact replay conservation', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin');
  try {
    const before = await capacityEvidence(admin, s.id);
    assert.equal(before.R, 25);
    assert.equal(before.S, 43);
    const prepared = await s.prepare({
      '150': '8',
      '39': '8',
      '151': '0.00',
      '103': '99',
      '58': 'SYNTHETIC_REJECTION',
    });
    assert.equal(
      (await applyWithCapacityEvidence(s, admin, prepared.work, 'REJECT_ORDER')).status,
      200,
    );
    const after = await capacityEvidence(admin, s.id);
    assert.equal(after.R, 24);
    assert.equal(after.S, 42);
    const state = after.state['fi.order_states']!.find((row) => row['order_id'] === s.order)!;
    assert.equal(state['status'], 'REJECTED');
    assert.equal(Number(state['remaining_par']), 0);
    await assertCleanCapacity(admin, {
      sandboxId: s.id,
      digest: s.proof,
      generation: '1',
      scope: 'trade',
    });
  } finally {
    await admin.end();
    await s.close();
  }
});

void test('ACK_CANCEL consumes one protected command and audit after request without creating an execution', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin');
  try {
    assert.equal(
      (await applyWithCapacityEvidence(s, admin, (await s.prepare()).work, 'ACK_ORDER')).status,
      200,
    );
    const cancel = randomUUID(),
      base = { '11': cancel, '41': s.order };
    const request = await s.prepare({ '35': 'F', '49': 'TRADEFLOW', '56': 'ATLAS', ...base });
    assert.equal(
      (await applyWithCapacityEvidence(s, admin, request.work, 'REQUEST_CANCEL')).status,
      200,
    );
    const before = await capacityEvidence(admin, s.id);
    const acknowledged = await s.prepare({
      ...base,
      '150': '4',
      '39': '4',
      '151': '0.00',
    });
    assert.equal(
      (await applyWithCapacityEvidence(s, admin, acknowledged.work, 'ACK_CANCEL')).status,
      200,
    );
    const after = await capacityEvidence(admin, s.id);
    assert.equal(after.R, 22);
    assert.equal(after.S, 40);
    const state = after.state['fi.order_states']!.find((row) => row['order_id'] === s.order)!;
    assert.equal(state['status'], 'CANCELED');
    assert.equal(state['pending_cancel_id'], null);
    assert.equal(Number(state['remaining_par']), 0);
    const outcomes = after.state['fi.cancellation_outcomes']!.filter(
      (row) => row['cancel_id'] === cancel,
    );
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!['outcome'], 'ACKNOWLEDGED');
    assert.deepEqual(after.state['fi.executions'], before.state['fi.executions']);
    assert.deepEqual(after.state['fi.positions'], before.state['fi.positions']);
    await assertCleanCapacity(admin, {
      sandboxId: s.id,
      digest: s.proof,
      generation: '1',
      scope: 'trade',
    });
  } finally {
    await admin.end();
    await s.close();
  }
});
