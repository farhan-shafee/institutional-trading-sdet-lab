/** Actual private engine container + owned PostgreSQL. No venue or public route. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { startOwnedPostgres } from '../../scripts/owned-postgres.js';
import { bootstrap, readOwner } from '../../scripts/workflow-database.js';
import { migrateLive } from '../../scripts/live-workflow-database.js';
import { LiveWorkflowDatabase } from '../../app/persistence/postgres/live-workflow.js';
import { LiveFixApplicationService } from '../../app/server/fix/live-application.js';
import { LiveFixController } from '../../app/server/fix/live-controller.js';
import { LiveJournal } from '../../app/server/fix/live-journal.js';
import { DomainError } from '../../app/domain/errors.js';
import { setTimeout as waitForLease } from 'node:timers/promises';
import { z } from 'zod';
import { runtime as createLiveRuntime } from './runtime-fixture.js';
import { fixture, report } from '../postgres/fix-fixture.js';

let owned: Awaited<ReturnType<typeof startOwnedPostgres>> | undefined;
const previousOwner = process.env['TF_DB_OWNER_FILE'];
const image = process.env['TF_FIX_LIVE_IMAGE'] ?? '';
before(async () => {
  assert.match(
    image,
    /^sha256:[a-f0-9]{64}$/,
    'The mandatory live gate requires its freshly built image.',
  );
  owned = await startOwnedPostgres(process.env['TF_PG_BIN'], {
    onAllocated: async (path) => {
      const pointer = process.env['TF_LIVE_OWNER_POINTER'];
      if (pointer) await writeFile(pointer, path + '\n', { mode: 0o600 });
    },
  });
  try {
    await bootstrap(owned.path);
    await migrateLive(owned.path);
    process.env['TF_DB_OWNER_FILE'] = owned.path;
  } catch (error) {
    await owned.stop(true);
    owned = undefined;
    throw error;
  }
});

async function scenario(enabled: boolean) {
  assert.ok(owned);
  const s = await fixture(),
    cfg = await readOwner(owned.path),
    db = new LiveWorkflowDatabase(cfg.appUrl!);
  let engine: Awaited<ReturnType<typeof runtime>> | undefined,
    journal: LiveJournal | undefined,
    controller: LiveFixController | undefined;
  let directory = '';
  async function close() {
    const failures: unknown[] = [];
    for (const cleanup of [
      async () => {
        await controller?.stop().catch(() => undefined);
      },
      async () => {
        await journal?.close();
      },
      () => db.close(),
      async () => {
        await engine?.remove();
      },
      () => s.close(),
      async () => {
        if (directory) await rm(directory, { recursive: true, force: true });
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Owned live scenario cleanup did not complete.');
  }
  try {
    engine = await runtime();
    directory = join(process.cwd(), '.local', 'fix-live', engine.identity.run_id);
    journal = await LiveJournal.open(directory, {
      run_id: engine.identity.run_id,
      session_id: engine.identity.session_id,
      store_id: engine.identity.store_id,
      runtime_hash: engine.identity.runtime_hash,
    });
    const binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' };
    controller = new LiveFixController({
      service: new LiveFixApplicationService(db, true),
      journal,
      process: engine.child,
      runtime: engine.identity,
      contexts: [
        {
          binding,
          actor_id: s.actor,
          order_id: s.order,
          channel_id: s.channel,
          owner_id: randomUUID(),
          verify: () => {},
        },
      ],
      ...(enabled ? { enabled: true } : {}),
    });
    const child = engine.child;
    const nativeReady = new Promise<void>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('Native READY was not observed.')), 15000);
      const observe = (chunk: Buffer) => {
        buffer += chunk.toString('ascii');
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          const event = JSON.parse(line) as { kind?: string };
          if (event.kind === 'READY') {
            clearTimeout(timer);
            child.stdout.removeListener('data', observe);
            resolve();
          }
        }
      };
      child.stdout.on('data', observe);
      child.once('close', () => {
        clearTimeout(timer);
        child.stdout.removeListener('data', observe);
        reject(new Error('Runtime exited before READY.'));
      });
    });
    void nativeReady.catch(() => undefined);
    return { s, controller, journal, nativeReady, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Owned scenario setup or cleanup failed.', {
        cause: cleanup,
      });
    }
    throw error;
  }
}

void test('an off controller does not register or claim even when its real engine emits READY', async () => {
  const h = await scenario(false);
  try {
    await assert.rejects(
      () => h.controller.start(),
      (e: unknown) => e instanceof DomainError && e.code === 'FIX_LIVE_DISABLED',
    );
    await h.nativeReady;
    await h.controller.stop().catch(() => undefined);
    assert.equal(
      (
        await h.s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_live_bindings WHERE sandbox_id=$1',
          [h.s.id],
        )
      ).rows[0]!.n,
      0,
    );
  } finally {
    await h.close();
  }
});
void test('a concurrent send cannot replace the first in-flight frame or its completion', async () => {
  const h = await scenario(true);
  try {
    await h.controller.start();
    const order = body(await report(h.s, { '35': 'D', '21': '1' }));
    for (const tag of ['37', '17', '150', '39', '14', '151', '6']) delete order[tag];
    const first = h.controller.send(h.s.order, order);
    void first.catch(() => undefined);
    await assert.rejects(
      () =>
        Promise.race([
          h.controller.send(h.s.order, order),
          first.then(() => {
            throw new Error('The first frame completed before the concurrent call was refused.');
          }),
        ]),
      (e: unknown) => e instanceof DomainError && e.code === 'FIX_LIVE_BACKPRESSURE',
    );
    assert.equal((await first).status, 201);
  } finally {
    await h.close();
  }
});
after(async () => {
  try {
    await owned?.stop(true);
  } finally {
    if (previousOwner === undefined) delete process.env['TF_DB_OWNER_FILE'];
    else process.env['TF_DB_OWNER_FILE'] = previousOwner;
  }
});

async function runtime() {
  return createLiveRuntime();
}

function body(fields: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([tag]) => !['8', '9', '10', '34', '43', '49', '52', '56', '122'].includes(tag),
    ),
  );
}

void test('fresh work after the actual 15-second lease expires reclaims durably without changing original fill intent', async () => {
  const h = await scenario(true);
  try {
    await h.controller.start();
    const order = body(await report(h.s, { '35': 'D', '21': '1' }));
    for (const tag of ['37', '17', '150', '39', '14', '151', '6']) delete order[tag];
    assert.equal((await h.controller.send(h.s.order, order)).status, 201);
    assert.equal((await h.controller.send(h.s.order, body(await report(h.s)))).status, 200);
    const oldWork = await h.journal.entries('work');
    const claims = (await h.journal.entries('request')).filter(
      (entry) => z.object({ action: z.string() }).parse(entry.value).action === 'CLAIM',
    );
    const lease = (
      await h.s.app.query<{ remaining_ms: number; fence: string }>(
        'SELECT ceil(greatest(0,extract(epoch FROM lease_expires_at-clock_timestamp())*1000))::int remaining_ms,fence::text FROM fi.fix_lanes WHERE sandbox_id=$1 AND order_id=$2',
        [h.s.id, h.s.order],
      )
    ).rows[0]!;
    assert.ok(lease.remaining_ms > 0 && lease.remaining_ms <= 15000);
    await waitForLease(lease.remaining_ms + 1);
    assert.equal(
      (
        await h.s.app.query<{ expired: boolean }>(
          'SELECT lease_expires_at<=clock_timestamp() expired FROM fi.fix_lanes WHERE sandbox_id=$1 AND order_id=$2',
          [h.s.id, h.s.order],
        )
      ).rows[0]!.expired,
      true,
    );
    await h.controller.reconnect('go');
    const terms = await report(h.s);
    const fill = body(
      await report(h.s, {
        '17': 'ATLAS-' + randomUUID().toUpperCase(),
        '150': 'F',
        '39': '2',
        '32': '100.00',
        '31': terms['44'],
        '6': terms['44'],
        '14': '100.00',
        '151': '0.00',
      }),
    );
    assert.equal((await h.controller.send(h.s.order, fill)).status, 200);
    const newWork = await h.journal.entries('work');
    for (const original of oldWork)
      assert.deepEqual(await h.journal.read('work', original.id), original.value);
    assert.equal(newWork.length, oldWork.length + 1);
    const fillIntent = newWork.find((entry) => !oldWork.some((old) => old.id === entry.id))!;
    assert.ok(
      BigInt(z.object({ fence: z.string() }).parse(fillIntent.value).fence) > BigInt(lease.fence),
    );
    const afterClaims = (await h.journal.entries('request')).filter(
      (entry) => z.object({ action: z.string() }).parse(entry.value).action === 'CLAIM',
    );
    assert.equal(afterClaims.length, claims.length + 1);
    assert.equal((await h.controller.send(h.s.order, fill)).replayed, true);
    assert.deepEqual(await h.journal.read('work', fillIntent.id), fillIntent.value);
    assert.equal(
      (await h.journal.entries('request')).filter(
        (entry) => z.object({ action: z.string() }).parse(entry.value).action === 'CLAIM',
      ).length,
      afterClaims.length,
    );
    assert.equal(
      (
        await h.s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.executions WHERE sandbox_id=$1 AND order_id=$2',
          [h.s.id, h.s.order],
        )
      ).rows[0]!.n,
      1,
    );
  } finally {
    await h.close();
  }
});

void test('real engine callbacks apply the owned acknowledgment and partial/final fills through SQL exactly once', async () => {
  assert.ok(owned);
  const s = await fixture(),
    cfg = await readOwner(owned.path),
    db = new LiveWorkflowDatabase(cfg.appUrl!);
  let engine: Awaited<ReturnType<typeof runtime>> | undefined,
    journal: LiveJournal | undefined,
    controller: LiveFixController | undefined;
  let directory = '';
  try {
    engine = await runtime();
    directory = join(process.cwd(), '.local', 'fix-live', engine.identity.run_id);
    journal = await LiveJournal.open(directory, {
      run_id: engine.identity.run_id,
      session_id: engine.identity.session_id,
      store_id: engine.identity.store_id,
      runtime_hash: engine.identity.runtime_hash,
    });
    const binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' };
    controller = new LiveFixController({
      service: new LiveFixApplicationService(db, true),
      journal,
      process: engine.child,
      runtime: engine.identity,
      contexts: [
        {
          binding,
          actor_id: s.actor,
          order_id: s.order,
          channel_id: s.channel,
          owner_id: randomUUID(),
          verify: () => {},
        },
      ],
      enabled: true,
    });
    await controller.start();
    const order = body(
      await report(s, {
        '35': 'D',
        '60': new Date().toISOString().replaceAll('-', '').replace('T', '-').replace('Z', ''),
        '21': '1',
      }),
    );
    for (const tag of ['37', '17', '150', '39', '14', '151', '6']) delete order[tag];
    assert.equal((await controller.send(s.order, order)).status, 201);
    const ack = await controller.send(s.order, body(await report(s)));
    assert.equal(ack.status, 200, JSON.stringify(ack));
    for (const [par, cum, leaves, status] of [
      ['40.00', '40.00', '60.00', '1'],
      ['60.00', '100.00', '0.00', '2'],
    ]) {
      const price = (await report(s))['44'];
      const fill: Awaited<ReturnType<LiveFixController['send']>> = await controller.send(
        s.order,
        body(
          await report(s, {
            '150': 'F',
            '39': status!,
            '32': par!,
            '31': price,
            '6': price,
            '14': cum!,
            '151': leaves!,
          }),
        ),
      );
      assert.equal(fill.status, 200, JSON.stringify(fill));
    }
    const requests = await journal.entries('request');
    const applies = requests.filter(
      (r) =>
        typeof r.value === 'object' &&
        r.value !== null &&
        'kind' in r.value &&
        r.value.kind === 'APPLY',
    );
    assert.equal(applies.length, 3);
    const recovered = await controller.recoverKnown(applies[2]!.id);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.replayed, true);
    assert.deepEqual(
      (
        await s.app.query<{ status: string; execution_count: number; filled_par: string }>(
          'SELECT status,execution_count,filled_par FROM fi.order_states WHERE sandbox_id=$1 AND order_id=$2',
          [s.id, s.order],
        )
      ).rows[0],
      { status: 'FILLED', execution_count: 2, filled_par: '100.00' },
    );
    assert.equal(
      (
        await s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_consumptions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      3,
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
    await controller.stop();
  } finally {
    await controller?.stop().catch(() => undefined);
    await journal?.close();
    await db.close();
    await engine?.remove();
    await s.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

void test('real reconnect and both process restarts fence connections without replacing financial work', async () => {
  const h = await scenario(true);
  try {
    await h.controller.start();
    const order = body(await report(h.s, { '35': 'D', '21': '1' }));
    for (const tag of ['37', '17', '150', '39', '14', '151', '6']) delete order[tag];
    await h.controller.send(h.s.order, order);
    const ack = body(await report(h.s));
    await h.controller.send(h.s.order, ack);
    type Connection = {
      id: string;
      session_id: string;
      connection_no: number;
      go_pid: number;
      java_pid: number;
    };
    const connections = async () =>
      (
        await h.s.app.query<Connection>(
          'SELECT id,session_id,connection_no,go_pid,java_pid FROM fi.fix_live_connections WHERE sandbox_id=$1 ORDER BY connection_no',
          [h.s.id],
        )
      ).rows;
    const work = (await h.journal.entries('work')).map((r) => r.value);
    assert.equal(work.length, 1);
    let previous = (await connections())[0]!;
    let priorSequence = Number(
      (
        await h.s.app.query<{ n: string }>(
          "SELECT max(message_seq)::text n FROM fi.fix_live_sequence_slots WHERE sandbox_id=$1 AND direction='IN'",
          [h.s.id],
        )
      ).rows[0]!.n,
    );
    for (const role of ['none', 'go', 'java'] as const) {
      await h.controller.reconnect(role);
      const rows = await connections(),
        current = rows.at(-1)!;
      assert.equal(rows.length, previous.connection_no + 1);
      assert.equal(current.session_id, previous.session_id);
      assert.notEqual(current.id, previous.id);
      assert.equal(current.connection_no, previous.connection_no + 1);
      if (role === 'go') assert.notEqual(current.go_pid, previous.go_pid);
      else assert.equal(current.go_pid, previous.go_pid);
      if (role === 'java') assert.notEqual(current.java_pid, previous.java_pid);
      else assert.equal(current.java_pid, previous.java_pid);
      assert.equal((await h.controller.send(h.s.order, ack)).status, 200);
      assert.deepEqual(
        (await h.journal.entries('work')).map((r) => r.value),
        work,
      );
      const seq = Number(
        (
          await h.s.app.query<{ n: string }>(
            "SELECT max(message_seq)::text n FROM fi.fix_live_sequence_slots WHERE sandbox_id=$1 AND direction='IN'",
            [h.s.id],
          )
        ).rows[0]!.n,
      );
      assert.ok(seq > priorSequence, 'physical FIX sequence must survive the reconnect');
      priorSequence = seq;
      previous = current;
    }
    assert.equal(
      (
        await h.s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_live_sessions WHERE sandbox_id=$1',
          [h.s.id],
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await h.s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_consumptions WHERE sandbox_id=$1',
          [h.s.id],
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await h.s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_live_callbacks WHERE sandbox_id=$1',
          [h.s.id],
        )
      ).rows[0]!.n,
      5,
    );
    assert.equal(
      (
        await h.s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_live_sequence_slots WHERE sandbox_id=$1',
          [h.s.id],
        )
      ).rows[0]!.n,
      5,
    );
  } finally {
    await h.close();
  }
});
