import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
void test(
  'failed provisioning announces only its own recovery path before cleanup',
  {
    skip: process.platform === 'win32' ? 'Owned PostgreSQL requires POSIX/WSL.' : false,
  },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'tradeflow-interview-recovery-'));
    try {
      // A genuinely unavailable provisioning tool fails before Docker allocates anything.
      const result = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), resolve('scripts/interview.ts'), '--verify'],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...process.env, PATH: '', TF_PG_BIN: '', PWDEBUG: '', TF_INTERVIEW_MANUAL: '' },
        },
      );
      assert.equal(result.status, 1, result.stderr);
      const matches = [...result.stdout.matchAll(/^Interview recovery descriptor: (.+)$/gm)];
      assert.equal(matches.length, 1, result.stdout);
      const path = matches[0]![1]!;
      assert.match(
        path.slice(directory.length),
        /^\/\.local\/postgres\/[0-9a-f-]{36}\/owner\.json$/,
      );
      assert.ok(path.startsWith(directory + '/'));
      assert.equal(
        existsSync(path),
        false,
        'Failed pre-resource allocation must clean its descriptor.',
      );
      assert.doesNotMatch(result.stdout + result.stderr, /postgresql:\/\/|adminUrl|password|nonce/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
