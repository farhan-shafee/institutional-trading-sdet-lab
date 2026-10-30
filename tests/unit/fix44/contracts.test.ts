import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { HEADER, PROFILES } from '../../../app/protocol/fix44/profile.js';
import { FIX44_LIMITS } from '../../../app/protocol/fix44/index.js';
interface Contract {
  standard: string;
  version: number;
  limits: Record<string, number>;
  wire: { header_order: string[] };
  fields: Record<string, unknown>;
  messages: Record<string, { required: string[]; optional: string[]; canonical_order: string[] }>;
}
void test('independently authored bilateral YAML covers every supported field and rule set', () => {
  const profile = parse(readFileSync('contracts/fix44-profile-v1.yaml', 'utf8')) as Contract;
  assert.equal(profile.standard, 'FIX.4.4');
  assert.equal(profile.version, 1);
  assert.deepEqual(profile.wire.header_order, ['8', '9', ...HEADER]);
  assert.deepEqual(Object.keys(profile.messages).sort(), ['8', '9', 'D', 'F']);
  for (const [type, message] of Object.entries(PROFILES)) {
    assert.deepEqual(profile.messages[type]!.required, [...message.required]);
    assert.deepEqual(profile.messages[type]!.canonical_order, [...message.order]);
    assert.deepEqual(
      [
        ...new Set([...profile.messages[type]!.required, ...profile.messages[type]!.optional]),
      ].sort(),
      [...message.order].sort(),
    );
    for (const tag of [...HEADER, ...message.order, '8', '9', '10']) assert.ok(profile.fields[tag]);
  }
  assert.equal(profile.limits['frame_bytes'], FIX44_LIMITS.maxFrame);
  assert.equal(profile.limits['retained_buffer_bytes'], FIX44_LIMITS.maxBuffer);
  assert.equal(profile.limits['fields'], FIX44_LIMITS.maxFields);
  assert.equal(profile.limits['emitted_batch'], FIX44_LIMITS.maxBatch);
  assert.equal(profile.limits['value_bytes'], FIX44_LIMITS.maxValue);
});
void test('protocol runtime imports only protocol modules, with no financial or delivery side effects', () => {
  for (const file of ['index.ts', 'profile.ts']) {
    const source = readFileSync(`app/protocol/fix44/${file}`, 'utf8');
    for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g))
      assert.ok(match[1]!.startsWith('./'));
    assert.doesNotMatch(source, /\b(?:fetch|listen|connect|query|spawn|setTimeout)\s*\(/);
  }
});
