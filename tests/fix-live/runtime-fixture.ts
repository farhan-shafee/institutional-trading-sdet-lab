/** Actual private engine container + owned PostgreSQL. No venue or public route. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { savePrivate } from '../../scripts/private-state.js';
import { rm, writeFile } from 'node:fs/promises';
import { startOwnedPostgres } from '../../scripts/owned-postgres.js';
import { bootstrap, readOwner } from '../../scripts/workflow-database.js';
import { migrateLive } from '../../scripts/live-workflow-database.js';
import { LiveWorkflowDatabase } from '../../app/persistence/postgres/live-workflow.js';
import { LiveFixApplicationService } from '../../app/server/fix/live-application.js';
import { LiveFixController } from '../../app/server/fix/live-controller.js';
import { LiveJournal } from '../../app/server/fix/live-journal.js';
import { fixture } from '../postgres/fix-fixture.js';

const execute = promisify(execFile);
const docker = (...args: string[]) =>
  execute('docker', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 131072 });
const image = process.env['TF_FIX_LIVE_IMAGE'] ?? '';
export async function startLiveTestDatabase() {
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const prior = process.env['TF_DB_OWNER_FILE'];
  const owned = await startOwnedPostgres(process.env['TF_PG_BIN'], {
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
    throw error;
  }
  return {
    owned,
    close: async () => {
      try {
        await owned.stop(true);
      } finally {
        if (prior === undefined) delete process.env['TF_DB_OWNER_FILE'];
        else process.env['TF_DB_OWNER_FILE'] = prior;
      }
    },
  };
}
export async function liveScenario(
  owned: Awaited<ReturnType<typeof startOwnedPostgres>>,
  ...args: Parameters<typeof fixture>
) {
  assert.ok(owned);
  const s = await fixture(...args),
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
      enabled: true,
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
    return { s, controller, journal, binding, cfg, nativeReady, close };
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

export async function runtime(
  identity: {
    run_id: string;
    session_id: string;
    store_id: string;
    connection_id: string;
    runtime_hash: string;
  } = {
    run_id: randomUUID(),
    session_id: randomUUID(),
    store_id: randomUUID(),
    connection_id: randomUUID(),
    runtime_hash: image.slice(7),
  },
) {
  const name = 'tradeflow-live-integration-' + identity.run_id;
  const parent = process.env['TF_LIVE_PARENT_RUN'],
    parentLabels: string[] = [];
  if (parent) {
    assert.match(parent, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const evidence = process.env['TF_LIVE_EVIDENCE_DIR'];
    assert.ok(evidence);
    await savePrivate(join(evidence, 'engine-intents', identity.run_id + '.json'), {
      version: 1,
      scope: 'synthetic-fix-live-integration',
      run_id: identity.run_id,
      parent_run_id: parent,
      image,
      name,
    });
    parentLabels.push('--label', 'tradeflow.parent_run_id=' + parent);
  }

  const remove = () => removeLiveRuntime(identity.run_id);
  try {
    const created = await docker(
      'create',
      '--interactive',
      '--name',
      name,
      '--label',
      'tradeflow.run_id=' + identity.run_id,
      '--label',
      'tradeflow.scope=synthetic-fix-live-integration',
      ...parentLabels,
      '--log-driver',
      'none',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--cpus',
      '1',
      '--memory',
      '1g',
      '--memory-swap',
      '1g',
      '--pids-limit',
      '128',
      '--shm-size',
      '64m',
      '--tmpfs',
      '/state:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700',
      image,
      'python',
      'tools/fix-session/runtime/live_bridge.py',
      '--root',
      '/state/' + identity.run_id,
      '--run-id',
      identity.run_id,
      '--session-id',
      identity.session_id,
      '--store-id',
      identity.store_id,
      '--connection-id',
      identity.connection_id,
      '--runtime-hash',
      identity.runtime_hash,
    );
    const id = created.stdout.trim();
    assert.match(id, /^[a-f0-9]{64}$/);
    const inspected = JSON.parse((await docker('inspect', id)).stdout) as Array<{
      Image: string;
      HostConfig: {
        NetworkMode: string;
        ReadonlyRootfs: boolean;
        Binds: unknown;
        PortBindings: unknown;
        CapDrop: string[];
        Memory: number;
        MemorySwap: number;
        NanoCpus: number;
        PidsLimit: number;
        ShmSize: number;
        SecurityOpt: string[];
        LogConfig: { Type: string; Config: unknown };
      };
      Config: { User: string };
      Mounts: Array<{ Type: string }>;
    }>;
    const item = inspected[0]!;
    assert.equal(item.Image, image);
    const h = item.HostConfig;
    assert.equal(h.NetworkMode, 'none');
    assert.equal(h.ReadonlyRootfs, true);
    assert.deepEqual(h.Binds ?? [], []);
    assert.deepEqual(h.PortBindings ?? {}, {});
    assert.deepEqual(h.CapDrop, ['ALL']);
    assert.equal(h.Memory, 1073741824);
    assert.equal(h.MemorySwap, 1073741824);
    assert.equal(h.NanoCpus, 1000000000);
    assert.equal(h.PidsLimit, 128);
    assert.equal(h.ShmSize, 67108864);
    assert.ok(h.SecurityOpt.includes('no-new-privileges'));
    assert.equal(h.LogConfig.Type, 'none');
    assert.deepEqual(h.LogConfig.Config, {});
    assert.equal(item.Config.User, '1000:1000');
    assert.ok(item.Mounts.every((m) => m.Type !== 'bind'));
    const child = spawn('docker', ['start', '--attach', '--interactive', id], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { identity, child, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}
export function body(fields: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([tag]) => !['8', '9', '10', '34', '43', '49', '52', '56', '122'].includes(tag),
    ),
  );
}

export async function removeLiveRuntime(run_id: string) {
  let inspected: unknown;
  try {
    inspected = JSON.parse(
      (await docker('inspect', 'tradeflow-live-integration-' + run_id)).stdout,
    ) as unknown;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      /No such|no such/.test(error.stderr)
    )
      return;
    throw error;
  }
  assert.ok(Array.isArray(inspected));
  const item = inspected[0] as {
    Id: string;
    Name: string;
    Image: string;
    Config: { Labels: Record<string, string> };
  };
  assert.equal(item.Name, '/tradeflow-live-integration-' + run_id);
  assert.equal(item.Config.Labels['tradeflow.run_id'], run_id);
  assert.equal(item.Config.Labels['tradeflow.scope'], 'synthetic-fix-live-integration');
  if (process.env['TF_LIVE_PARENT_RUN'])
    assert.equal(item.Config.Labels['tradeflow.parent_run_id'], process.env['TF_LIVE_PARENT_RUN']);
  assert.equal(item.Image, image);
  await docker('rm', '--force', item.Id);
}
