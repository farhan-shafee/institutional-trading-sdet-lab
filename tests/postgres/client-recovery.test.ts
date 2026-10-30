import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { test } from 'node:test';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { readConfiguration } from '../../app/server/configuration.js';
import { runClient, journalSchema } from '../../scripts/sandbox-client.js';
import { loadPrivate } from '../../scripts/private-state.js';
import { owner, connection } from './harness.js';
import { httpLab } from './http.js';

async function labWithDrop(operation: 'create' | 'rotate', journal: string) {
  const owned = await owner();
  if (!owned.appUrl) throw new Error('Application role required.');
  const config = readConfiguration({
    TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
    TRADEFLOW_FIXED_INCOME_DATABASE_URL: owned.appUrl,
  });
  let response: ServerResponse | undefined;
  let dropped = false;
  let retained = false;
  const db = new WorkflowDatabase(owned.appUrl, {
    afterCommit: () => {
      if (response && !dropped) {
        dropped = true;
        response.destroy();
      }
    },
  });
  const lab = await httpLab(config, db);
  lab.server.on('request', (request, reply) => {
    const matches =
      operation === 'create'
        ? request.url === '/api/fixed-income/v1/sandboxes'
        : request.url?.endsWith('/recovery-keys/rotate');
    if (request.method === 'POST' && matches && !dropped) {
      retained = existsSync(journal) && (statSync(journal).mode & 0o777) === 0o600;
      response = reply;
    } else response = undefined;
  });
  return {
    lab,
    config,
    get dropped() {
      return dropped;
    },
    get retained() {
      return retained;
    },
  };
}
async function cleanup(id: string) {
  const admin = await connection('admin');
  const maint = await connection('maintenance');
  try {
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
      [id],
    );
    await maint.query('SELECT fi_control.purge_expired()');
  } finally {
    await maint.end();
    await admin.end();
  }
}

await test('lost successful creation response survives an application restart using the unchanged private journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tradeflow-bootstrap-'));
  const journal = join(dir, 'create.json');
  const dropping = await labWithDrop('create', journal);
  let id: string | undefined;
  try {
    await assert.rejects(runClient('create', journal, dropping.lab.origin));
    assert.equal(dropping.dropped, true);
    assert.equal(dropping.retained, true);
    const material = journalSchema.parse(await loadPrivate(journal));
    id = material.sandbox_id;
    const before = await readFile(journal, 'utf8');
    await dropping.lab.close();
    const restarted = await httpLab(dropping.config);
    try {
      const result = await runClient('create', journal, restarted.origin);
      assert.equal(result.confirmed, true);
      assert.equal(result.replayed, true);
      assert.equal(result.sandbox_id, id);
      assert.equal(digest(await readFile(journal, 'utf8')), digest(before));
      assert.equal(JSON.stringify(result).includes(material.trade_capability), false);
      const observer = await connection('reconciler');
      try {
        assert.equal(
          (await observer.query('SELECT id FROM fi.commands WHERE sandbox_id=$1', [id])).rowCount,
          1,
        );
      } finally {
        await observer.end();
      }
    } finally {
      await restarted.close();
    }
  } finally {
    if (dropping.lab.server.listening) await dropping.lab.close();
    if (id) await cleanup(id);
    await rm(dir, { recursive: true, force: true });
  }
});

await test('lost successful rotation response recovers with the retained new key after restart without rotating twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tradeflow-rotation-'));
  const source = join(dir, 'create.json'),
    journal = join(dir, 'rotate.json');
  const dropping = await labWithDrop('rotate', journal);
  let id: string | undefined;
  try {
    id = (await runClient('create', source, dropping.lab.origin)).sandbox_id;
    await assert.rejects(runClient('rotate', journal, dropping.lab.origin, source));
    assert.equal(dropping.dropped, true);
    assert.equal(dropping.retained, true);
    const material = journalSchema.parse(await loadPrivate(journal));
    assert.equal(material.operation, 'rotate');
    const before = await readFile(journal, 'utf8');
    await dropping.lab.close();
    const restarted = await httpLab(dropping.config);
    try {
      const result = await runClient('rotate', journal, restarted.origin);
      assert.equal(result.confirmed, true);
      assert.equal(result.replayed, true);
      assert.equal(digest(await readFile(journal, 'utf8')), digest(before));
      assert.equal(JSON.stringify(result).includes(material.trade_capability), false);
      const observer = await connection('reconciler');
      try {
        assert.equal(
          (
            await observer.query<{ generation: string }>(
              'SELECT generation FROM fi.sandboxes WHERE id=$1',
              [id],
            )
          ).rows[0]?.generation,
          '2',
        );
        assert.equal(
          (await observer.query('SELECT id FROM fi.commands WHERE sandbox_id=$1', [id])).rowCount,
          2,
        );
        assert.equal(
          (await observer.query('SELECT command_id FROM fi.audit_events WHERE sandbox_id=$1', [id]))
            .rowCount,
          2,
        );
      } finally {
        await observer.end();
      }
    } finally {
      await restarted.close();
    }
  } finally {
    if (dropping.lab.server.listening) await dropping.lab.close();
    if (id) await cleanup(id);
    await rm(dir, { recursive: true, force: true });
  }
});
