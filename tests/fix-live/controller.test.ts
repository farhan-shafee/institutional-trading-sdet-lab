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
import { LiveVerificationDatabase } from '../../app/server/fix/live-verification-database.js';
import { verifyLiveApplication } from '../../app/server/fix/live-reconciliation.js';
import { LiveFixController } from '../../app/server/fix/live-controller.js';
import { LiveJournal } from '../../app/server/fix/live-journal.js';
import { DomainError } from '../../app/domain/errors.js';
import { setTimeout as waitForLease, setImmediate as yieldTurn } from 'node:timers/promises';
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

async function scenario(enabled: boolean, beforeController?: (journal: LiveJournal) => void) {
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
    beforeController?.(journal);
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
    return { s, controller, journal, nativeReady, close, child, cfg, binding };
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

function stopBarrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function observeSend<T>(pending: Promise<T>) {
  return pending.then(
    (value) => ({ state: 'resolved' as const, value }),
    (error: unknown) => ({ state: 'rejected' as const, error }),
  );
}
async function settledSend<T>(observed: ReturnType<typeof observeSend<T>>) {
  return Promise.race([observed, Promise.resolve({ state: 'pending' as const })]);
}
async function outgoingOrder(h: Awaited<ReturnType<typeof scenario>>) {
  const order = body(await report(h.s, { '35': 'D', '21': '1' }));
  for (const tag of ['37', '17', '150', '39', '14', '151', '6']) delete order[tag];
  return order;
}

void test('stop settles a send still yielding in startup without dispatching it afterward', async () => {
  const h = await scenario(true);
  try {
    await h.controller.start();
    const order = await outgoingOrder(h);
    const sending = observeSend(h.controller.send(h.s.order, order));
    await h.controller.stop();
    const result = await settledSend(sending);
    assert.equal(result.state, 'rejected', 'Shutdown must settle the admitted caller.');
    if (result.state !== 'rejected') throw new Error('The send did not reject before shutdown.');
    assert.ok(result.error instanceof DomainError);
    assert.equal(result.error.code, 'FIX_LIVE_STOPPING');
    assert.equal((await h.journal.entries('send')).length, 0);
    assert.equal(
      (
        await h.s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_live_observations WHERE sandbox_id=$1',
          [h.s.id],
        )
      ).rows[0]!.n,
      0,
    );
  } finally {
    await h.close();
  }
});

void test('stop waits for durable send admission and rejects it before any wire dispatch', async () => {
  const h = await scenario(true);
  const entered = stopBarrier(),
    release = stopBarrier();
  const retain = h.journal.retain.bind(h.journal);
  try {
    await h.controller.start();
    const order = await outgoingOrder(h);
    h.journal.retain = async (...args: Parameters<LiveJournal['retain']>) => {
      if (args[0] === 'send') {
        entered.release();
        await release.promise;
      }
      return retain(...args);
    };
    const sending = observeSend(h.controller.send(h.s.order, order));
    await entered.promise;
    const stopping = h.controller.stop();
    release.release();
    await stopping;
    const result = await settledSend(sending);
    assert.equal(result.state, 'rejected', 'The original caller cannot remain pending.');
    if (result.state !== 'rejected') throw new Error('The retained send was not rejected.');
    assert.ok(result.error instanceof DomainError);
    assert.equal(result.error.code, 'FIX_LIVE_STOPPING');
    assert.equal((await h.journal.entries('send')).length, 1, 'Keep the original durable intent.');
    assert.equal(
      (
        await h.s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_live_observations WHERE sandbox_id=$1',
          [h.s.id],
        )
      ).rows[0]!.n,
      0,
    );
  } finally {
    release.release();
    h.journal.retain = retain;
    await h.close();
  }
});

void test('stop drains an already dispatched application through its original callback before exiting', async () => {
  const h = await scenario(true);
  const entered = stopBarrier(),
    release = stopBarrier();
  const retain = h.journal.retain.bind(h.journal);
  try {
    await h.controller.start();
    const order = await outgoingOrder(h);
    h.journal.retain = async (...args: Parameters<LiveJournal['retain']>) => {
      if (args[0] === 'frame') {
        entered.release();
        await release.promise;
      }
      return retain(...args);
    };
    const sending = observeSend(h.controller.send(h.s.order, order));
    await entered.promise;
    const stopping = h.controller.stop();
    release.release();
    await stopping;
    const result = await settledSend(sending);
    assert.equal(result.state, 'resolved', 'A dispatched application must finish before STOP.');
    if (result.state !== 'resolved') throw new Error('The dispatched send did not complete.');
    assert.equal(result.value.status, 201);
    assert.equal((await h.journal.entries('send')).length, 1);
    assert.equal(
      (
        await h.s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_live_callbacks WHERE sandbox_id=$1',
          [h.s.id],
        )
      ).rows[0]!.n,
      1,
    );
  } finally {
    release.release();
    h.journal.retain = retain;
    await h.close();
  }
});

void test('stop settles a reconnect still yielding in startup and refuses later reconnect admission', async () => {
  const h = await scenario(true);
  try {
    await h.controller.start();
    const connecting = observeSend(h.controller.reconnect());
    await h.controller.stop();
    const result = await settledSend(connecting);
    assert.equal(result.state, 'rejected');
    if (result.state !== 'rejected') throw new Error('The reconnect caller did not settle.');
    assert.ok(result.error instanceof DomainError);
    assert.equal(result.error.code, 'FIX_LIVE_STOPPING');
    await assert.rejects(
      () => h.controller.reconnect(),
      (error: unknown) => error instanceof DomainError && error.code === 'FIX_LIVE_STOPPING',
    );
    assert.equal((await h.journal.entries('send')).length, 0);
  } finally {
    await h.close();
  }
});

void test('stop keeps the bridge open until a durable reconnect intent settles without late dispatch', async () => {
  const h = await scenario(true);
  const entered = stopBarrier(),
    release = stopBarrier();
  const retain = h.journal.retain.bind(h.journal);
  const originalWrite = h.child.stdin.write.bind(h.child.stdin);
  const commands: string[] = [];
  let connecting: ReturnType<typeof observeSend<void>> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    await h.controller.start();
    h.child.stdin.write = ((...args: Parameters<typeof originalWrite>) => {
      commands.push(
        z
          .object({ kind: z.string() })
          .passthrough()
          .parse(JSON.parse(Buffer.from(args[0] as Uint8Array).toString('ascii'))).kind,
      );
      return originalWrite(...args);
    }) as typeof h.child.stdin.write;
    h.journal.retain = async (...args: Parameters<LiveJournal['retain']>) => {
      if (args[0] === 'send') {
        entered.release();
        await release.promise;
      }
      return retain(...args);
    };
    connecting = observeSend(h.controller.reconnect());
    await entered.promise;
    stopping = h.controller.stop();
    // One host turn flushes stop's ready microtasks, without a timed sleep or
    // replacing the real engine. STOP cannot pass the retained-intent barrier.
    await yieldTurn();
    assert.deepEqual(commands, [], 'Shutdown cannot overtake a reconnect journal write.');
    release.release();
    await stopping;
    const result = await settledSend(connecting);
    assert.equal(result.state, 'rejected');
    if (result.state !== 'rejected') throw new Error('The retained reconnect did not settle.');
    assert.ok(result.error instanceof DomainError);
    assert.equal(result.error.code, 'FIX_LIVE_STOPPING');
    assert.deepEqual(commands, ['STOP']);
    const intent = await h.journal.entries('send');
    assert.equal(intent.length, 1);
    assert.equal(
      z.object({ kind: z.string() }).passthrough().parse(intent[0]!.value).kind,
      'RECONNECT',
    );
  } finally {
    release.release();
    await stopping?.catch(() => undefined);
    await connecting;
    h.child.stdin.write = originalWrite;
    h.journal.retain = retain;
    await h.close();
  }
});

void test('stop drains a dispatched reconnect through its original CONNECT and ARMED before exiting', async () => {
  const h = await scenario(true);
  const entered = stopBarrier(),
    release = stopBarrier();
  const retain = h.journal.retain.bind(h.journal);
  try {
    await h.controller.start();
    h.journal.retain = async (...args: Parameters<LiveJournal['retain']>) => {
      const request = z.object({ action: z.string() }).passthrough().safeParse(args[2]);
      if (args[0] === 'request' && request.success && request.data.action === 'CONNECT') {
        entered.release();
        await release.promise;
      }
      return retain(...args);
    };
    const connecting = observeSend(h.controller.reconnect());
    await entered.promise;
    const stopping = h.controller.stop();
    release.release();
    await stopping;
    const result = await settledSend(connecting);
    assert.equal(
      result.state,
      'resolved',
      'An already dispatched reconnect must complete before STOP.',
    );
    assert.equal((await h.journal.entries('send')).length, 1);
    const connects = (await h.journal.entries('request')).filter(
      (entry) =>
        z.object({ action: z.string() }).passthrough().parse(entry.value).action === 'CONNECT',
    );
    assert.equal(connects.length, 1);
    const resultEntry = await h.journal.read('result', connects[0]!.id);
    assert.equal(z.object({ status: z.number() }).passthrough().parse(resultEntry).status, 201);
  } finally {
    release.release();
    h.journal.retain = retain;
    await h.close();
  }
});

void test('stop settles startup registration without reporting readiness after stopping begins', async () => {
  const entered = stopBarrier(),
    release = stopBarrier();
  let retain: LiveJournal['retain'] | undefined;
  const h = await scenario(true, (journal) => {
    retain = journal.retain.bind(journal);
    const original = retain;
    journal.retain = async (...args: Parameters<LiveJournal['retain']>) => {
      const request = z.object({ action: z.string() }).passthrough().safeParse(args[2]);
      if (args[0] === 'request' && request.success && request.data.action === 'BIND') {
        entered.release();
        await release.promise;
      }
      return original(...args);
    };
  });
  try {
    const starting = observeSend(h.controller.start());
    await entered.promise;
    const stopping = h.controller.stop();
    release.release();
    await stopping;
    const result = await settledSend(starting);
    assert.equal(
      result.state,
      'rejected',
      'Startup cannot report readiness after shutdown starts.',
    );
    if (result.state !== 'rejected') throw new Error('Startup was not rejected during shutdown.');
    assert.ok(result.error instanceof DomainError);
    assert.equal(result.error.code, 'FIX_LIVE_STOPPING');
    await assert.rejects(
      () => h.controller.start(),
      (error: unknown) => error instanceof DomainError && error.code === 'FIX_LIVE_STOPPING',
    );
  } finally {
    release.release();
    if (retain) h.journal.retain = retain;
    await h.close();
  }
});

for (const first of ['cancel', 'fill'] as const)
  void test(
    'same-order duplex callbacks apply original work after both acceptances: ' +
      first +
      ' observed first',
    async () => {
      const h = await scenario(true);
      const reader = new LiveVerificationDatabase(h.cfg.reconcilerUrl!);
      const firstObserved = stopBarrier(),
        bothObserved = stopBarrier(),
        releaseFrames = stopBarrier();
      const retain = h.journal.retain.bind(h.journal);
      const sending: Array<Promise<unknown>> = [];
      const observedDirections: string[] = [],
        events: string[] = [];
      let buffered = '',
        held = false;
      const observe = (chunk: Buffer) => {
        buffered += chunk.toString('ascii');
        let end: number;
        while ((end = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          const envelope = z
            .object({ kind: z.string(), direction: z.string().optional() })
            .passthrough()
            .parse(JSON.parse(line));
          if (envelope.kind === 'OBSERVED') {
            observedDirections.push(envelope.direction!);
            events.push('OBSERVED');
            if (observedDirections.length === 1) firstObserved.release();
            if (observedDirections.length === 2) bothObserved.release();
          } else if (envelope.kind === 'CALLBACK') events.push('CALLBACK');
        }
      };
      try {
        await h.controller.start();
        await h.controller.send(h.s.order, await outgoingOrder(h));
        await h.controller.send(h.s.order, body(await report(h.s)));
        const terms = await report(h.s),
          cancelId = randomUUID();
        const cancel = {
          '35': 'F',
          '11': cancelId,
          '41': h.s.order,
          '37': terms['37'],
          '55': terms['55'],
          '167': terms['167'],
          '54': terms['54'],
          '38': terms['38'],
          '60': new Date().toISOString().replaceAll('-', '').replace('T', '-').replace('Z', ''),
          '58': 'SYNTHETIC_CANCEL_REQUEST',
        };
        const fill = body(
          await report(h.s, {
            '150': 'F',
            '39': '1',
            '32': '40.00',
            '31': terms['44'],
            '6': terms['44'],
            '14': '40.00',
            '151': '60.00',
          }),
        );
        h.journal.retain = async (...args: Parameters<LiveJournal['retain']>) => {
          if (args[0] === 'frame' && !held) {
            held = true;
            await releaseFrames.promise;
          }
          return retain(...args);
        };
        h.child.stdout.on('data', observe);
        const firstSend = observeSend(
          h.controller.send(h.s.order, first === 'cancel' ? cancel : fill),
        );
        sending.push(firstSend);
        await Promise.race([
          firstObserved.promise,
          firstSend.then((result) => {
            throw new Error('First send settled before its observation: ' + result.state);
          }),
        ]);
        const secondSend = observeSend(
          h.controller.send(h.s.order, first === 'cancel' ? fill : cancel),
        );
        sending.push(secondSend);
        await Promise.race([
          bothObserved.promise,
          firstSend.then((result) => {
            throw new Error('First send settled before both observations: ' + result.state);
          }),
          secondSend.then((result) => {
            throw new Error('Second send settled before both observations: ' + result.state);
          }),
        ]);
        assert.deepEqual(
          observedDirections,
          first === 'cancel' ? ['J_TO_G', 'G_TO_J'] : ['G_TO_J', 'J_TO_G'],
        );
        releaseFrames.release();
        const results = await Promise.all([firstSend, secondSend]);
        for (const result of results) {
          assert.equal(result.state, 'resolved', JSON.stringify(result));
          if (result.state !== 'resolved') throw new Error('A duplex caller did not resolve.');
          assert.equal(result.value.status, 200);
        }
        await h.controller.stop();
        assert.deepEqual(events.slice(0, 2), ['OBSERVED', 'OBSERVED']);
        assert.equal(events.filter((event) => event === 'CALLBACK').length, 2);
        const state = (
          await h.s.app.query<{
            filled_par: string;
            execution_count: number;
            pending_cancel_id: string | null;
          }>(
            'SELECT filled_par::text,execution_count,pending_cancel_id FROM fi.order_states WHERE sandbox_id=$1 AND order_id=$2',
            [h.s.id, h.s.order],
          )
        ).rows[0];
        assert.deepEqual(state, {
          filled_par: '40.00',
          execution_count: 1,
          pending_cancel_id: cancelId,
        });
        const verified = await verifyLiveApplication(reader, h.binding, h.journal, () => {}, true);
        assert.equal(verified.total_findings, 0, JSON.stringify(verified.findings));
        assert.equal(verified.financial_application_verified, true);
        assert.equal(verified.oracle.executions, 1);
        assert.equal(verified.live_callbacks, 4);
        assert.equal((await h.journal.entries('work')).length, 3);
        const expectedOperations = [
          'ACK_ORDER',
          ...(first === 'cancel'
            ? ['REQUEST_CANCEL', 'EXECUTE_ORDER']
            : ['EXECUTE_ORDER', 'REQUEST_CANCEL']),
        ];
        const workOrder = await h.s.app.query<{ operation: string }>(
          'SELECT operation FROM fi.fix_work WHERE sandbox_id=$1 AND order_id=$2 ORDER BY lane_seq',
          [h.s.id, h.s.order],
        );
        assert.deepEqual(
          workOrder.rows.map((row) => row.operation),
          expectedOperations,
        );
        const applicationOrder = await h.s.app.query<{ operation: string }>(
          'SELECT w.operation FROM fi.fix_applications a JOIN fi.fix_work w ON w.sandbox_id=a.sandbox_id AND w.id=a.work_id WHERE a.sandbox_id=$1 AND a.order_id=$2 ORDER BY a.financial_command_seq',
          [h.s.id, h.s.order],
        );
        assert.deepEqual(
          applicationOrder.rows.map((row) => row.operation),
          expectedOperations,
        );
      } finally {
        releaseFrames.release();
        await Promise.allSettled(sending);
        h.child.stdout.removeListener('data', observe);
        h.journal.retain = retain;
        await reader.close();
        await h.close();
      }
    },
  );
