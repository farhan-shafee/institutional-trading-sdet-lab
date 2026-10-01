import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionStore } from '../../app/domain/session-store.js';

await test('synthetic trader and viewer logins expose the correct authorization role', () => {
  const store = new SessionStore();
  assert.equal(store.login('qa.user', 'Password123!').user.role, 'trader');
  assert.equal(store.login('qa.viewer', 'Password123!').user.role, 'viewer');
});

await test('invalid username or password does not create an authenticated session', () => {
  const store = new SessionStore();
  for (const [username, password] of [
    ['qa.user', 'wrong'],
    ['not-a-user', 'Password123!'],
  ]) {
    assert.throws(() => store.login(username ?? '', password ?? ''), {
      code: 'INVALID_CREDENTIALS',
      status: 401,
    });
  }
});

await test('each login isolates mutations even when credentials match', () => {
  const store = new SessionStore();
  const first = store.login('qa.user', 'Password123!');
  const second = store.login('qa.user', 'Password123!');
  assert.notEqual(first.token, second.token);
  store.authenticate(first.token).book.cancel('seed-new-aapl');
  assert.equal(store.authenticate(second.token).book.get('seed-new-aapl').status, 'NEW');
});

await test('session deletion revokes authentication and releases that book', () => {
  const store = new SessionStore();
  const session = store.login('qa.user', 'Password123!');
  store.delete(session.token);
  assert.throws(() => store.authenticate(session.token), { code: 'UNAUTHORIZED', status: 401 });
});

await test('an absent or invalid token fails authentication', () => {
  const store = new SessionStore();
  assert.throws(() => store.authenticate(undefined), { code: 'UNAUTHORIZED', status: 401 });
  assert.throws(() => store.authenticate('invalid-token'), { code: 'UNAUTHORIZED', status: 401 });
});
