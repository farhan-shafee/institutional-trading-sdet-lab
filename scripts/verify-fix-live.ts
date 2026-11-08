/** Authored/captured wire corpus only; no socket, SDK activation or financial effect. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  decodeLiveFix44,
  liveFix44Bytes,
  LiveFix44Error,
} from '../app/protocol/fix44-live/index.js';

type Row = {
  name: string;
  raw_hex: string;
  sha256: string;
  accepted: boolean;
  error?: string;
  fields?: Record<string, string>;
};
const rows = JSON.parse(readFileSync('test-data/fix44/live/manifest.json', 'utf8')) as Row[];
assert.equal(rows.length, 20);
assert.equal(new Set(rows.map((r) => r.name)).size, 20);
const observed = rows.map((row) => {
  assert.match(row.raw_hex, /^(?:[a-f0-9]{2}){1,8192}$/);
  const raw = Buffer.from(row.raw_hex, 'hex');
  const sha256 = createHash('sha256').update(raw).digest('hex');
  assert.equal(sha256, row.sha256);
  try {
    const parsed = decodeLiveFix44(raw);
    assert.equal(row.accepted, true, row.name);
    assert.deepEqual({ ...parsed.fields }, row.fields);
    assert.deepEqual(liveFix44Bytes(parsed), raw);
    return { name: row.name, accepted: true, sha256, fields: parsed.fields };
  } catch (error: unknown) {
    if (!(error instanceof LiveFix44Error)) throw error;
    assert.equal(row.accepted, false, row.name);
    assert.equal(error.code, row.error);
    return { name: row.name, accepted: false, sha256 };
  }
});
const python = process.env['PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3');
const oracle = spawnSync(python, ['verification/python/fix_live.py'], {
  input: JSON.stringify(observed),
  encoding: 'utf8',
  timeout: 15000,
  maxBuffer: 65536,
});
if (oracle.error || oracle.signal || oracle.status !== 0) {
  process.stderr.write(oracle.stderr);
  throw new Error('LIVE_ORACLE_FAILED');
}
process.stdout.write(oracle.stdout);
console.log(
  'Selected live decoder:20/20 corpus verdicts; original wire retained; no financial handoff claim.',
);
