import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import pg from 'pg';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { VerificationDatabase } from '../../app/server/reconciliation/database.js';
import {
  financialSource,
  migrationChecksums,
} from '../../app/domain/workflow/database-contract.js';
import { DomainError } from '../../app/domain/errors.js';

const adapter = process.argv[2],
  scenario = process.argv[3];
assert(['workflow', 'verification'].includes(adapter ?? ''));
assert(
  [
    'acquire',
    'before-commit',
    'after-commit',
    'readonly',
    'readonly-commit',
    'late-destroy',
    'healthy',
  ].includes(scenario ?? ''),
);
const client = new pg.Client() as pg.Client & {
  release: (destroy?: Error | boolean) => void;
  _handleErrorMessage: (error: Error) => void;
};
const query = client.query.bind(client);
let delivered = false;
const releases: boolean[] = [];
const idleError = () => {};
function disconnect() {
  delivered = true;
  // Actual installed driver's protocol dispatch, without a database or socket.
  client._handleErrorMessage(
    Object.assign(new Error('Synthetic backend termination'), { code: '57P01' }),
  );
}
const inject = () =>
  new Promise<void>((resolve) =>
    queueMicrotask(() => {
      disconnect();
      resolve();
    }),
  );
client.query = ((text: string) => {
  if (text === 'COMMIT' && scenario === 'readonly-commit') {
    const protocol = client as unknown as {
      connection: { query: () => void };
      readyForQuery: boolean;
    };
    protocol.connection.query = () => {};
    protocol.readyForQuery = true;
    const pending = query(text);
    queueMicrotask(disconnect);
    return pending;
  }
  if (delivered) return query(text);
  const rows = text.includes('current_user=')
    ? [{ valid: true }]
    : text.includes('schema_migrations')
      ? migrationChecksums
      : text.includes('compatibility')
        ? [{ schema_version: 1, financial_source: financialSource }]
        : [{ value: 'owned result' }];
  return Promise.resolve({ rows, rowCount: rows.length, command: 'SELECT', fields: [], oid: 0 });
}) as typeof client.query;
client.release = (destroy) => {
  releases.push(Boolean(destroy));
  // Model healthy pool handoff. Discard deliberately removes pool ownership so
  // this conservative fixture requires the lease itself to guard late errors.
  client.on('error', idleError);
  if (destroy) {
    client.removeListener('error', idleError);
    queueMicrotask(() => {
      if (scenario === 'late-destroy') disconnect();
      client.emit('end');
    });
  }
};
const hooks =
  scenario === 'before-commit'
    ? { beforeCommit: inject }
    : scenario === 'after-commit'
      ? { afterCommit: inject }
      : {};
const db =
  adapter === 'workflow'
    ? new WorkflowDatabase('postgresql://tf_app@127.0.0.1:1/unused', hooks)
    : new VerificationDatabase('postgresql://tf_reconciler@127.0.0.1:1/unused', hooks);
db.pool.connect = ((callback?: (error: Error | undefined, value?: pg.PoolClient) => void) => {
  client.removeListener('error', idleError);
  const value = client as unknown as pg.PoolClient;
  if (callback) {
    callback(undefined, value);
    // This dispatch is BEFORE the await continuation: checkout must own errors
    // synchronously in the pool callback, not after awaiting its promise.
    if (scenario === 'acquire') disconnect();
    return;
  }
  const pending = Promise.resolve(value);
  if (scenario === 'acquire') disconnect();
  return pending;
}) as typeof db.pool.connect;
try {
  const readOnly = scenario === 'readonly' || scenario === 'readonly-commit';
  const work = async () => {
    if (scenario === 'readonly') await inject();
    if (scenario === 'late-destroy') throw new Error('Synthetic SQL failure');
    return 'owned result';
  };
  if (scenario === 'healthy') {
    for (let i = 0; i < 20; i++) {
      assert.equal(await db.transaction(true, () => {}, work), 'owned result');
      assert.equal(client.listenerCount('error'), 1, 'only pool idle ownership remains');
      assert.equal(client.listenerCount('end'), 0, 'no transaction listeners accumulate');
    }
    assert.deepEqual(releases, Array<boolean>(20).fill(false));
  } else {
    const expected = ['before-commit', 'after-commit'].includes(scenario!)
      ? 'OUTCOME_UNKNOWN'
      : adapter === 'workflow'
        ? 'DATABASE_UNAVAILABLE'
        : scenario === 'late-destroy'
          ? 'RECONCILIATION_SQL_FAILURE'
          : 'RECONCILER_UNAVAILABLE';
    await assert.rejects(
      db.transaction(readOnly, () => {}, work),
      (error: unknown) => {
        assert(error instanceof DomainError);
        assert.equal(error.status, 503);
        assert.equal(error.code, expected);
        assert(!error.message.includes('Synthetic'));
        return true;
      },
    );
    await nextTurn();
    assert.deepEqual(releases, [true], 'faulted client is discarded exactly once');
    assert.equal(client.listenerCount('error'), 0, 'ended client relinquishes ownership');
    assert.equal(client.listenerCount('end'), 0);
  }
  console.log(JSON.stringify({ adapter, scenario, passed: true, releases }));
} finally {
  await db.close();
}
