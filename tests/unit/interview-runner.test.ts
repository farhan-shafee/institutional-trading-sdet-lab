import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// These boundaries must reject unsafe/ambiguous operation before allocating a database.
function invoke(args: string[], ci = '') {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/interview.ts', ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, CI: ci, PWDEBUG: '' },
  });
}
void test('interview help works without Docker or database allocation', () => {
  const result = invoke(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--verify/);
  assert.match(result.stdout, /--manual/);
  assert.doesNotMatch(result.stdout, /Owned local PostgreSQL ready/);
});
void test('unknown interview arguments fail closed before database allocation', () => {
  const result = invoke(['--verify', '--base-url', 'https://example.com']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use --verify, --manual or --help/);
  assert.doesNotMatch(result.stdout, /Owned local PostgreSQL ready/);
});
void test('interactive interview mode cannot enter CI', () => {
  const result = invoke(['--manual'], 'true');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Interactive interview mode is unavailable in CI/);
  assert.doesNotMatch(result.stdout, /Owned local PostgreSQL ready/);
});
