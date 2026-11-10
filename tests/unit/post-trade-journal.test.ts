import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  PostTradeCommandJournal,
  definitivePostTradeRejection,
  postTradeCommandPath,
  type RetainedPostTradeCommand,
} from '../../app/domain/post-trade/journal.js';

await test('only identified pre-admission financial rejections can release an original intent', () => {
  for (const [status, code] of [
    [400, 'PROCESSING_DATE_NOT_WEEKDAY'],
    [400, 'VALIDATION_ERROR'],
    [409, 'PROCESSING_DATE_CONFLICT'],
    [409, 'ADJUSTMENT_REVISION_CONFLICT'],
    [404, 'EXECUTION_NOT_REGISTERED'],
    [429, 'SETTLEMENT_FAILURE_LIMIT'],
  ] as const)
    assert.equal(definitivePostTradeRejection(status, code), true, code);
  for (const [status, code] of [
    [503, 'OUTCOME_UNKNOWN'],
    [503, 'DATABASE_UNAVAILABLE'],
    [429, 'RATE_LIMITED'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'SANDBOX_NOT_FOUND'],
    [409, 'IDEMPOTENCY_KEY_REUSED'],
    [409, 'INSUFFICIENT_SECURITIES'],
    [409, 'UNKNOWN_FUTURE_CODE'],
  ] as const)
    assert.equal(definitivePostTradeRejection(status, code), false, code);
});

function fixture() {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
  const journal = new PostTradeCommandJournal(storage);
  const intent: RetainedPostTradeCommand = {
    version: 1,
    sandbox_id: randomUUID(),
    key: randomUUID(),
    operation: 'SETTLE',
    execution_id: randomUUID(),
    body: { expected_revision: 1, processing_date: '2030-01-15' },
  };
  return { entries, storage, journal, intent };
}

await test('uncertain financial requests retain the exact original payload and key across a browser reload', () => {
  const { storage, journal, intent } = fixture();
  journal.retain(intent);
  assert.deepEqual(new PostTradeCommandJournal(storage).load(intent.sandbox_id), intent);
  assert.equal(
    postTradeCommandPath(intent),
    '/api/fixed-income/v1/sandboxes/' +
      intent.sandbox_id +
      '/posttrade/executions/' +
      intent.execution_id +
      '/settlements',
  );
  assert.throws(() => journal.retain({ ...intent, key: randomUUID() }), /original/);
  assert.deepEqual(journal.load(intent.sandbox_id), intent);
  assert.equal(journal.load(randomUUID()), undefined);
});

await test('resolving a different key or changed payload cannot discard an unresolved original financial request', () => {
  const { journal, intent } = fixture();
  journal.retain(intent);
  journal.resolve({ ...intent, key: randomUUID() });
  assert.deepEqual(journal.load(intent.sandbox_id), intent);
  journal.resolve({ ...intent, body: { ...intent.body, processing_date: '2030-01-16' } });
  assert.deepEqual(journal.load(intent.sandbox_id), intent);
  journal.resolve(intent);
  assert.equal(journal.load(intent.sandbox_id), undefined);
});

await test('unsafe retained material stays preserved and storage failure prevents retaining a new command', () => {
  const { entries, journal, intent } = fixture();
  const key = 'tradeflow.posttrade.command.v1.' + intent.sandbox_id;
  for (const raw of [
    'invalid-json',
    JSON.stringify({ ...intent, actor_id: randomUUID() }),
    'x'.repeat(4097),
  ]) {
    entries.set(key, raw);
    assert.throws(() => journal.load(intent.sandbox_id));
    assert.equal(entries.get(key), raw);
    assert.throws(() => journal.retain(intent));
    assert.equal(entries.get(key), raw);
  }
  const unavailable = new PostTradeCommandJournal({
    getItem: () => null,
    setItem: () => {
      throw new Error('STORAGE_UNAVAILABLE');
    },
    removeItem: () => {},
  });
  assert.throws(() => unavailable.retain(intent), /STORAGE_UNAVAILABLE/);
});
