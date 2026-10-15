import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrderBook } from '../../app/domain/order-book.js';
import { SessionStore, type SessionLimits } from '../../app/domain/session-store.js';

const limits: SessionLimits = {
  ttlMs: 1_000,
  maxSessions: 2,
  maxOrdersPerSession: 6,
  mutationsPerMinute: 2,
};
const orderInput = { symbol: 'SPY', side: 'BUY', quantity: 7, type: 'MARKET' };

await test('hosted sessions expire at the absolute boundary without sliding on access', () => {
  let time = 1_000;
  const store = new SessionStore({ limits, now: () => time });
  const session = store.login('qa.user', 'Password123!');
  time = 1_999;
  assert.equal(store.authenticate(session.token).user.username, 'qa.user');
  time = 2_000;
  assert.throws(() => store.authenticate(session.token), { code: 'UNAUTHORIZED', status: 401 });
});

await test('session capacity rejects new logins without evicting or changing live books', () => {
  const store = new SessionStore({ limits, now: () => 0 });
  const first = store.login('qa.user', 'Password123!');
  const second = store.login('qa.user', 'Password123!');
  store.authenticate(first.token).book.cancel('seed-new-aapl');
  assert.throws(() => store.login('qa.user', 'wrong'), {
    code: 'INVALID_CREDENTIALS',
    status: 401,
  });
  assert.throws(() => store.login('qa.user', 'Password123!'), {
    code: 'SESSION_CAPACITY_REACHED',
    status: 503,
  });
  assert.equal(store.authenticate(first.token).book.get('seed-new-aapl').status, 'CANCELED');
  assert.equal(store.authenticate(second.token).book.get('seed-new-aapl').status, 'NEW');
});

await test('login reclaims expired capacity and gives the replacement a fresh cloned book', () => {
  let time = 0;
  const store = new SessionStore({ limits, now: () => time });
  const expired = store.login('qa.user', 'Password123!');
  const created = store.authenticate(expired.token).book.create(orderInput);
  store.authenticate(expired.token).book.cancel('seed-new-aapl');
  time = 500;
  const live = store.login('qa.user', 'Password123!');
  time = 1_000;
  const replacement = store.login('qa.user', 'Password123!');
  assert.throws(() => store.authenticate(expired.token), { code: 'UNAUTHORIZED', status: 401 });
  assert.equal(store.authenticate(live.token).book.get('seed-new-aapl').status, 'NEW');
  const replacementBook = store.authenticate(replacement.token).book;
  assert.equal(replacementBook.list().length, 5);
  assert.equal(replacementBook.get('seed-new-aapl').status, 'NEW');
  assert.throws(() => replacementBook.get(created.id), { code: 'ORDER_NOT_FOUND', status: 404 });
});

await test('explicit expiry pruning preserves live sessions and reclaims expired slots', () => {
  let time = 0;
  const store = new SessionStore({ limits, now: () => time });
  const expired = store.login('qa.user', 'Password123!');
  time = 500;
  const live = store.login('qa.viewer', 'Password123!');
  time = 1_000;
  store.pruneExpired();
  const replacement = store.login('qa.user', 'Password123!');
  assert.throws(() => store.authenticate(expired.token), { code: 'UNAUTHORIZED', status: 401 });
  assert.equal(store.authenticate(live.token).user.role, 'viewer');
  assert.equal(store.authenticate(replacement.token).book.list().length, 5);
});

await test('session deletion releases capacity without restoring the revoked token', () => {
  const store = new SessionStore({ limits: { ...limits, maxSessions: 1 }, now: () => 0 });
  const previous = store.login('qa.user', 'Password123!');
  store.authenticate(previous.token).book.cancel('seed-new-aapl');
  store.delete(previous.token);
  const replacement = store.login('qa.user', 'Password123!');
  assert.notEqual(replacement.token, previous.token);
  assert.throws(() => store.authenticate(previous.token), { code: 'UNAUTHORIZED', status: 401 });
  assert.equal(store.authenticate(replacement.token).book.get('seed-new-aapl').status, 'NEW');
});

await test('shutdown clearing revokes every session and releases capacity for fresh books', () => {
  const store = new SessionStore({ limits, now: () => 0 });
  const first = store.login('qa.user', 'Password123!');
  const second = store.login('qa.viewer', 'Password123!');
  store.authenticate(first.token).book.cancel('seed-new-aapl');
  store.clear();
  for (const token of [first.token, second.token]) {
    assert.throws(() => store.authenticate(token), { code: 'UNAUTHORIZED', status: 401 });
  }
  const replacement = store.login('qa.user', 'Password123!');
  assert.equal(store.authenticate(replacement.token).book.get('seed-new-aapl').status, 'NEW');
});

await test('local sessions retain unlimited lifetime, books, and mutation admission', () => {
  let time = 0;
  const store = new SessionStore({ now: () => time });
  const session = store.login('qa.user', 'Password123!');
  for (let index = 0; index < 50; index += 1) store.login('qa.viewer', 'Password123!');
  const book = store.authenticate(session.token).book;
  for (let index = 0; index < 96; index += 1) book.create(orderInput);
  for (let index = 0; index < 31; index += 1) store.admitMutation(session.token);
  time = 1_800_001;
  assert.equal(store.authenticate(session.token).book.list().length, 101);
});

await test('order capacity includes seeds and rejects creation without changing existing records', () => {
  const book = new OrderBook(6);
  const created = book.create(orderInput);
  const before = book.list();
  assert.equal(before.length, 6);
  assert.throws(() => book.create(orderInput), { code: 'ORDER_CAPACITY_REACHED', status: 409 });
  assert.deepEqual(book.list(), before);
  assert.deepEqual(book.get(created.id), created);
});

await test('cancellation remains usable at order capacity and does not reclaim a record slot', () => {
  const book = new OrderBook(5);
  assert.equal(book.cancel('seed-new-aapl').status, 'CANCELED');
  assert.throws(() => book.create(orderInput), { code: 'ORDER_CAPACITY_REACHED', status: 409 });
  assert.equal(book.list().length, 5);
  assert.equal(book.get('seed-new-aapl').status, 'CANCELED');
});

await test('invalid order input retains validation priority when the book is full', () => {
  const book = new OrderBook(5);
  const before = book.list();
  assert.throws(() => book.create({ ...orderInput, quantity: 0 }), {
    code: 'VALIDATION_ERROR',
    status: 400,
  });
  assert.deepEqual(book.list(), before);
});

await test('the hosted order cap belongs to each cloned session book', () => {
  const store = new SessionStore({ limits, now: () => 0 });
  const first = store.login('qa.user', 'Password123!');
  const second = store.login('qa.user', 'Password123!');
  const firstBook = store.authenticate(first.token).book;
  const secondBook = store.authenticate(second.token).book;
  const firstOrder = firstBook.create(orderInput);
  assert.throws(() => firstBook.create(orderInput), {
    code: 'ORDER_CAPACITY_REACHED',
    status: 409,
  });
  assert.equal(secondBook.list().length, 5);
  const secondOrder = secondBook.create(orderInput);
  assert.notEqual(secondOrder.id, firstOrder.id);
  assert.equal(secondBook.list().length, 6);
  assert.throws(() => secondBook.get(firstOrder.id), { code: 'ORDER_NOT_FOUND', status: 404 });
});

await test('session mutation windows isolate budgets and recover at the fixed minute boundary', () => {
  let time = 0;
  const store = new SessionStore({ limits: { ...limits, ttlMs: 120_000 }, now: () => time });
  const first = store.login('qa.user', 'Password123!');
  const second = store.login('qa.user', 'Password123!');
  store.admitMutation(first.token);
  store.admitMutation(first.token);
  assert.throws(() => store.admitMutation(first.token), {
    code: 'RATE_LIMITED',
    status: 429,
    retryAfterSeconds: 60,
  });
  store.admitMutation(second.token);
  store.admitMutation(second.token);
  time = 59_999;
  assert.throws(() => store.admitMutation(first.token), {
    code: 'RATE_LIMITED',
    status: 429,
    retryAfterSeconds: 1,
  });
  time = 60_000;
  store.admitMutation(first.token);
  store.admitMutation(first.token);
  assert.throws(() => store.admitMutation(first.token), {
    code: 'RATE_LIMITED',
    status: 429,
    retryAfterSeconds: 60,
  });
});

await test('mutation admission requires a current valid session before consuming its budget', () => {
  let time = 0;
  const store = new SessionStore({ limits, now: () => time });
  for (const token of [undefined, 'unknown-token']) {
    assert.throws(() => store.admitMutation(token), { code: 'UNAUTHORIZED', status: 401 });
  }
  const session = store.login('qa.user', 'Password123!');
  store.admitMutation(session.token);
  time = 1_000;
  assert.throws(() => store.admitMutation(session.token), { code: 'UNAUTHORIZED', status: 401 });
});

await test('admission rejects excess work with rounded retry seconds and recovers without sliding', async () => {
  const { AdmissionWindow } = await import('../../app/domain/admission.js');
  let time = 100;
  const window = new AdmissionWindow(2, 2_500, () => time);
  window.take();
  window.take();
  time = 101;
  assert.throws(() => window.take(), {
    code: 'RATE_LIMITED',
    status: 429,
    retryAfterSeconds: 3,
  });
  time = 1_600;
  assert.throws(() => window.take(), {
    code: 'RATE_LIMITED',
    status: 429,
    retryAfterSeconds: 1,
  });
  time = 2_599;
  assert.throws(() => window.take(), {
    code: 'RATE_LIMITED',
    status: 429,
    retryAfterSeconds: 1,
  });
  time = 2_600;
  window.take();
  window.take();
  assert.throws(() => window.take(), {
    code: 'RATE_LIMITED',
    status: 429,
    retryAfterSeconds: 3,
  });
  time = 10_000;
  window.take();
});

await test('invalid finite hosted bounds fail construction before admitting resources', async () => {
  const { AdmissionWindow } = await import('../../app/domain/admission.js');
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => new AdmissionWindow(value), RangeError);
  }
  for (const value of [0, -1, NaN, Infinity]) {
    assert.throws(() => new AdmissionWindow(1, value), RangeError);
  }
  for (const value of [0, -1, 4, 5.5, NaN, -Infinity]) {
    assert.throws(() => new OrderBook(value), RangeError);
  }
  for (const invalid of [
    { ...limits, ttlMs: 0 },
    { ...limits, ttlMs: Infinity },
    { ...limits, maxSessions: 0 },
    { ...limits, maxSessions: 1.5 },
    { ...limits, maxOrdersPerSession: 4 },
    { ...limits, maxOrdersPerSession: Infinity },
    { ...limits, mutationsPerMinute: 0 },
    { ...limits, mutationsPerMinute: Infinity },
  ]) {
    assert.throws(() => new SessionStore({ limits: invalid }), RangeError);
  }
});
