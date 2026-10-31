import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, stat, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

async function invoke(journal: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve('scripts/sandbox-client.ts'),
      'create',
      '--journal',
      journal,
      '--base-url',
      'http://127.0.0.1:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (b: Buffer) => {
    output += b.toString();
  });
  child.stderr.on('data', (b: Buffer) => {
    output += b.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return { code, output };
}

await test('private creation journal is durably retained before any unavailable-server request and reused unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tradeflow-journal-'));
  const path = join(dir, 'operation.json');
  try {
    const first = await invoke(path);
    assert.notEqual(first.code, 0);
    assert.equal(existsSync(path), true);
    const bytes = await readFile(path, 'utf8');
    const material = JSON.parse(bytes) as {
      read_capability: string;
      trade_capability: string;
      sandbox_id: string;
      idempotency_key: string;
    };
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(material.read_capability.length, 43);
    assert.equal(material.trade_capability.length, 43);
    assert.equal(first.output.includes(material.read_capability), false);
    assert.equal(first.output.includes(material.trade_capability), false);
    const second = await invoke(path);
    assert.notEqual(second.code, 0);
    assert.equal(digest(await readFile(path, 'utf8')), digest(bytes));
    assert.equal(second.output.includes(material.trade_capability), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('unsafe permissions and symbolic-link journals fail closed without overwriting retained material', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tradeflow-journal-'));
  const path = join(dir, 'operation.json');
  const link = join(dir, 'link.json');
  try {
    await invoke(path);
    assert.equal(existsSync(path), true);
    const bytes = await readFile(path, 'utf8');
    await chmod(path, 0o644);
    assert.notEqual((await invoke(path)).code, 0);
    assert.equal(digest(await readFile(path, 'utf8')), digest(bytes));
    await chmod(path, 0o600);
    await symlink(path, link);
    assert.notEqual((await invoke(link)).code, 0);
    assert.equal(digest(await readFile(path, 'utf8')), digest(bytes));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
