import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inspectRuntimeFrames } from '../../../scripts/verify-fix-session-compatibility.js';

const frames = JSON.parse(
  readFileSync('test-data/fix44/runtime/captured-compatibility.json', 'utf8'),
) as { raw_hex: string; sha256: string; direction: string }[];

void test('actual Java/Go D8F9 bytes expose the original strict-header mismatch', () => {
  const before = JSON.stringify(frames);
  const result = inspectRuntimeFrames(frames);
  assert.deepEqual(
    result.results.map((value) => value.original_codec_result),
    ['FIELD_ORDER', 'FIELD_ORDER', 'FIELD_ORDER', 'FIELD_ORDER'],
  );
  assert.equal(result.financial_application_verified, false);
  assert.equal(result.wire_normalized, false);
  assert.equal(JSON.stringify(frames), before);
});

void test('wire identity and complete D8F9 discovery are required', () => {
  assert.throws(() => inspectRuntimeFrames([]), /COMPATIBILITY_CASES/);
  assert.throws(
    () => inspectRuntimeFrames(frames.map((frame) => ({ ...frame, sha256: '0'.repeat(64) }))),
    /COMPATIBILITY_HASH/,
  );
  assert.throws(() => inspectRuntimeFrames([frames[0]]), /COMPATIBILITY_DISCOVERY/);
});
