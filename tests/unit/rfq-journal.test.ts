import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  RfqCommandJournal,
  definitiveRfqRejection,
  type RetainedRfqCommand,
} from '../../app/domain/workflow/rfq-journal.js';

function fixture() {
  const values = new Map<string, string>();
  const journal = new RfqCommandJournal({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  });
  const command = (sandbox_id: string = randomUUID()): RetainedRfqCommand => ({
    sandbox_id,
    key: randomUUID(),
    path: `/api/fixed-income/v1/sandboxes/${sandbox_id}/rfqs/${randomUUID()}/accept`,
    body: { expected_version: '2', quote_id: randomUUID() },
  });
  return { values, journal, command };
}
await test('an unresolved or unavailable sandbox cannot block a different sandbox journal', () => {
  const f = fixture(),
    a = f.command(),
    b = f.command();
  f.journal.retain(a);
  assert.deepEqual(f.journal.load(a.sandbox_id), a);
  assert.equal(f.journal.load(b.sandbox_id), undefined);
  f.journal.retain(b);
  f.journal.resolve(b);
  assert.deepEqual(f.journal.load(a.sandbox_id), a);
  assert.equal(f.journal.load(b.sandbox_id), undefined);
  assert.equal(f.values.size, 1);
});
await test('retaining another request never overwrites an unresolved original and stale resolution cannot erase it', () => {
  const f = fixture(),
    a = f.command(),
    replacement = f.command(a.sandbox_id);
  f.journal.retain(a);
  assert.throws(() => f.journal.retain(replacement), /retained/);
  f.journal.resolve(replacement);
  assert.deepEqual(f.journal.load(a.sandbox_id), a);
  f.journal.resolve(a);
  assert.equal(f.journal.load(a.sandbox_id), undefined);
});
await test('only explicit permanent database quotas and definitive state rejections resolve the original command', () => {
  assert.equal(definitiveRfqRejection(429, 'RFQ_CAPACITY_REACHED'), true);
  assert.equal(definitiveRfqRejection(429, 'SANDBOX_QUOTA_REACHED'), true);
  assert.equal(definitiveRfqRejection(409, 'RFQ_VERSION_CONFLICT'), true);
  for (const [status, code] of [
    [429, 'RATE_LIMITED'],
    [503, 'OUTCOME_UNKNOWN'],
    [404, 'SANDBOX_NOT_FOUND'],
    [403, 'FORBIDDEN'],
    [409, 'IDEMPOTENCY_KEY_REUSED'],
  ] as const)
    assert.equal(definitiveRfqRejection(status, code), false);
});
await test('journal storage failure prevents retention and capabilities are not accepted as command fields', () => {
  const f = fixture(),
    a = f.command();
  const broken = new RfqCommandJournal({
    getItem: () => null,
    setItem: () => {
      throw new Error('Storage unavailable.');
    },
    removeItem: () => {},
  });
  assert.throws(() => broken.retain(a), /Storage unavailable/);
  assert.throws(() =>
    f.journal.retain({
      ...a,
      body: { ...a.body, trade_capability: 'private-test-marker' },
    } as unknown as RetainedRfqCommand),
  );
  assert.equal(f.values.size, 0);
});

await test('legacy journal adoption retains the original bytes in its sandbox before removal', () => {
  const f = fixture(),
    a = f.command(),
    b = f.command();
  const raw = JSON.stringify(a);
  f.values.set('tradeflow.rfq.command.v1', raw);
  assert.equal(f.journal.load(b.sandbox_id), undefined);
  assert.equal(f.values.get('tradeflow.rfq.command.v1'), raw);
  assert.deepEqual(f.journal.load(a.sandbox_id), a);
  assert.equal(f.values.get(`tradeflow.rfq.command.v1.${a.sandbox_id}`), raw);
  assert.equal(f.values.has('tradeflow.rfq.command.v1'), false);
});
await test('shared non-secret lifecycle journal retains exact fill identity and blocks competing RFQ work', () => {
  const f = fixture(),
    sid = randomUUID();
  const fill = {
    sandbox_id: sid,
    key: randomUUID(),
    path: `/api/fixed-income/v1/sandboxes/${sid}/orders/${randomUUID()}/executions`,
    body: {
      expected_version: '2',
      execution_id: randomUUID(),
      source_event_id: randomUUID(),
      par_amount: '50.00',
    },
  };
  const retained = f.journal.retain(fill);
  assert.deepEqual(f.journal.load(sid), retained);
  assert.throws(() => f.journal.retain(f.command(sid)), /retained/);
  assert.equal(definitiveRfqRejection(503, 'OUTCOME_UNKNOWN'), false);
  assert.deepEqual(f.journal.load(sid), retained);
  f.journal.resolve(retained);
  assert.equal(f.journal.has(sid), false);
});

await test('reconciliation retains its original non-secret run request and quota decisions are definitive', () => {
  const f = fixture(),
    sid = randomUUID(),
    run = randomUUID();
  const saved = f.journal.retain({
    sandbox_id: sid,
    key: randomUUID(),
    path: `/api/fixed-income/v1/sandboxes/${sid}/reconciliation-runs`,
    body: { run_id: run },
  });
  assert.deepEqual(f.journal.load(sid), saved);
  assert.equal(definitiveRfqRejection(429, 'RECONCILIATION_QUOTA'), true);
  assert.equal(definitiveRfqRejection(429, 'RECONCILIATION_CAPACITY'), true);
  f.journal.resolve(saved);
  const recovery = f.journal.retain({
    sandbox_id: sid,
    key: randomUUID(),
    path: `/api/fixed-income/v1/sandboxes/${sid}/reconciliation-runs/${run}/recover`,
    body: {},
  });
  assert.deepEqual(f.journal.load(sid), recovery);
});
