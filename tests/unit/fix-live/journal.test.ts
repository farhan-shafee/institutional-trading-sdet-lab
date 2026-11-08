import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm, readFile, chmod, symlink, open as openFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LiveJournal } from '../../../app/server/fix/live-journal.js';
import { DomainError } from '../../../app/domain/errors.js';

const identity = () => ({
  run_id: randomUUID(),
  session_id: randomUUID(),
  store_id: randomUUID(),
  runtime_hash: 'a'.repeat(64),
});
const failure = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;
async function workspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tradeflow-live-journal-')),
    journals: LiveJournal[] = [];
  t.after(async () => {
    try {
      for (const journal of journals.reverse()) await journal.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    directory,
    open: async (
      owner: Parameters<typeof LiveJournal.open>[1],
      options: Parameters<typeof LiveJournal.open>[2] = {},
    ) => {
      const journal = await LiveJournal.open(directory, owner, options);
      journals.push(journal);
      return journal;
    },
  };
}

void test('original request and UUIDs survive close/reopen without another identity', async (t) => {
  const { open } = await workspace(t);
  const owner = identity(),
    key = randomUUID();
  const journal = await open(owner),
    intent = {
      operation: 'APPLY',
      key,
      order_id: randomUUID(),
      work_id: randomUUID(),
      financial_key: randomUUID(),
    };
  await journal.retain('request', key, intent);
  await journal.close();
  const recovered = await open(owner);
  assert.deepEqual(await recovered.read('request', key), intent);
  await recovered.retain('request', key, { ...intent });
  assert.deepEqual(await recovered.entries('request'), [{ id: key, value: intent }]);
});
void test('a changed intent or runtime identity never overwrites retained material', async (t) => {
  const { directory, open } = await workspace(t);
  const owner = identity(),
    journal = await open(owner);
  const key = randomUUID();
  await journal.retain('request', key, { raw_hex: '6162' });
  const original = await readFile(join(directory, `request-${key}.json`));
  await assert.rejects(
    () => journal.retain('request', key, { raw_hex: '6163' }),
    failure('LIVE_JOURNAL_INTENT_CONFLICT'),
  );
  await assert.rejects(
    () => open({ ...owner, store_id: randomUUID() }),
    failure('LIVE_JOURNAL_IDENTITY_CONFLICT'),
  );
  assert.deepEqual(await readFile(join(directory, `request-${key}.json`)), original);
});
void test('only one writer owns a journal; read-only recovery preserves the active lock', async (t) => {
  const { open } = await workspace(t);
  const owner = identity(),
    journal = await open(owner);
  const key = randomUUID();
  await journal.retain('work', key, { financial_key: randomUUID() });
  await assert.rejects(() => open(owner), failure('LIVE_JOURNAL_ALREADY_OWNED'));
  const inspect = await open(owner, { readOnly: true });
  assert.ok(await inspect.read('work', key));
  await assert.rejects(
    () => inspect.retain('request', randomUUID(), {}),
    failure('LIVE_JOURNAL_READ_ONLY'),
  );
  await assert.rejects(() => open(owner), failure('LIVE_JOURNAL_ALREADY_OWNED'));
});
void test('unsafe permissions and symlinks fail closed without replacing intent bytes', async (t) => {
  const { directory, open } = await workspace(t);
  const journal = await open(identity());
  const key = randomUUID();
  await journal.retain('request', key, { original: true });
  const path = join(directory, `request-${key}.json`);
  await chmod(path, 0o644);
  await assert.rejects(() => journal.read('request', key), failure('LIVE_JOURNAL_UNAVAILABLE'));
  await chmod(path, 0o600);
  const alias = randomUUID();
  await symlink(path, join(directory, `request-${alias}.json`));
  await assert.rejects(() => journal.read('request', alias), failure('LIVE_JOURNAL_UNAVAILABLE'));
  assert.deepEqual(await journal.read('request', key), { original: true });
});
void test('oversize, non-JSON and traversal inputs cannot create replacement requests', async (t) => {
  const { open } = await workspace(t);
  const journal = await open(identity());
  await assert.rejects(
    () => journal.retain('request', '../outside', { value: 'x' }),
    failure('LIVE_JOURNAL_INVALID'),
  );
  await assert.rejects(
    () => journal.retain('request', randomUUID(), { raw_hex: 'a'.repeat(24576) }),
    failure('LIVE_JOURNAL_BOUND'),
  );
  await assert.rejects(
    () => journal.retain('request', randomUUID(), { value: undefined }),
    failure('LIVE_JOURNAL_INVALID'),
  );
  assert.deepEqual(await journal.entries('request'), []);
});
void test('simultaneous callers retain one immutable original and expose the conflict', async (t) => {
  const { open } = await workspace(t);
  const journal = await open(identity());
  const key = randomUUID();
  const outcomes = await Promise.allSettled([
    journal.retain('request', key, { value: 'first' }),
    journal.retain('request', key, { value: 'second' }),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.deepEqual(await journal.read('request', key), { value: 'first' });
});
void test('journal exhaustion retains the original key and leaves the other run budget partitions available', async (t) => {
  const { directory, open } = await workspace(t);
  const journal = await open(identity()),
    key = randomUUID(),
    intent = { financial_key: randomUUID() };
  await journal.retain('request', key, intent);
  const filler = await openFile(join(directory, `frame-${randomUUID()}.json`), 'wx', 0o600);
  try {
    await filler.truncate(24 * 1024 * 1024);
  } finally {
    await filler.close();
  }
  await assert.rejects(
    () => journal.retain('request', randomUUID(), { later: true }),
    failure('LIVE_JOURNAL_BOUND'),
  );
  assert.deepEqual(await journal.read('request', key), intent);
  await journal.retain('request', key, intent);
});
