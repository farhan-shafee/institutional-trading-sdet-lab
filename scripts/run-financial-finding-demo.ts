/** Accepts only the separately demonstrated, exact original assertion failure; never regular tests. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = 'artifacts/financial-capture-demo';
const before = new Set(await readdir(root).catch(() => [] as string[]));
const child = spawn(
  process.execPath,
  [
    '--import',
    'tsx',
    '--import',
    './scripts/financial-finding-preload.ts',
    '--test',
    '--test-concurrency=1',
    '--test-timeout=30000',
    'tests/diagnostics/financial-finding-capture.demo.ts',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '',
  overflow = false;
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (chunk: Buffer) => {
    if (overflow) return;
    if (Buffer.byteLength(output) + chunk.length > 262144) {
      overflow = true;
      child.kill('SIGTERM');
      return;
    }
    output += chunk.toString('utf8');
    process.stdout.write(chunk);
  });
const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
  (resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  },
);
assert.equal(overflow, false);
assert.equal(exit.signal, null);
assert.equal(exit.code, 1, 'The original deliberate-failure child must remain exit 1.');
assert.ok(!output.includes('TF_FINANCIAL_CAPTURE_INCOMPLETE'));
function marker(prefix: string): Record<string, unknown> {
  const lines = output.split('\n').filter((line) => line.startsWith(prefix + ' '));
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]!.slice(prefix.length + 1)) as Record<string, unknown>;
}
const assertion = marker('TF_CAPTURE_DEMO_ASSERTION');
const cleanup = marker('TF_CAPTURE_DEMO_CLEANUP');
assert.equal(assertion['code'], 'ERR_ASSERTION');
assert.equal(assertion['actual'], 1);
assert.equal(assertion['expected'], 0);
assert.equal(assertion['original_assertion'], 'tests/postgres/fix-capacity-oracle.ts:299');
assert.equal(cleanup['clean'], true);
assert.equal(cleanup['sandbox_id'], assertion['sandbox_id']);
const directories = (await readdir(root)).filter((name) => !before.has(name));
assert.equal(directories.length, 1);
const directory = join(root, directories[0]!);
assert.equal((await stat(directory)).mode & 0o777, 0o700);
const files = await readdir(directory);
assert.deepEqual(files, ['finding-1.json']);
const path = join(directory, files[0]!);
const info = await stat(path);
assert.equal(info.mode & 0o777, 0o600);
assert.ok(info.size <= 65536);
const json = await readFile(path, 'utf8');
const event = JSON.parse(json) as Record<string, unknown>;
assert.equal(event['status'], 'COMPLETE');
assert.equal(event['layer'], 'comparisons');
assert.equal(
  event['query_sha256'],
  '296b390b28639d4857dcaf5796de736f05f91a1eb48c4ad4cd883cad70277b1e',
);
assert.equal(event['sandbox_id'], assertion['sandbox_id']);
assert.equal(event['finding_count'], 1);
assert.equal(event['omitted_rows'], 0);
const rows = event['rows'] as Record<string, unknown>[];
assert.equal(rows.length, 1);
assert.equal(rows[0]!['category'], 'AUDIT_HISTORY');
assert.equal(rows[0]!['code'], 'LIFECYCLE_TRANSITION');
assert.equal(rows[0]!['record_kind'], 'ORDER');
assert.equal(rows[0]!['record_id'], assertion['order_id']);
const snapshot = event['snapshot'] as Record<string, unknown>;
assert.equal(snapshot['profile'], 'fix-application-v2');
assert.equal(snapshot['physical_schema_revision'], 8);
assert.ok(typeof snapshot['snapshot_id'] === 'string');
const findingPosition = output.indexOf('TF_FINANCIAL_FINDING ' + json.trim());
assert.ok(findingPosition >= 0);
assert.ok(findingPosition < output.indexOf('TF_CAPTURE_DEMO_ASSERTION '));
assert.ok(
  output.indexOf('TF_CAPTURE_DEMO_ASSERTION ') < output.indexOf('TF_CAPTURE_DEMO_CLEANUP '),
);
await writeFile(
  join(directory, 'proof.json'),
  JSON.stringify(
    {
      version: 1,
      controlled_failure_only: true,
      historical_root_cause: 'UNKNOWN',
      child_exit: exit.code,
      original_assertion: assertion['original_assertion'],
      retained_capacity_zero: true,
      capture_survived_cleanup: true,
      capture: files[0],
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600, flag: 'wx' },
);
console.log(
  'Controlled capture proof passed; deliberate child exit 1 and exact original financial failure preserved; cleanup verified. Historical root cause remains unknown.',
);
