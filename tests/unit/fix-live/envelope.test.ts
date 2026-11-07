/** Literal protocol admission controls; these do not claim callback provenance. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { decodeLiveBridgeEnvelope } from '../../../app/server/fix/live-controller.js';
import { DomainError } from '../../../app/domain/errors.js';
const rejected = (value: unknown) =>
  value instanceof DomainError && value.code === 'FIX_LIVE_ENVELOPE';
void test('a literal bounded error envelope is parsed without another claim', () => {
  const value = { version: 1, profile: 'live-fix-ingress-v1', kind: 'ERROR', code: 'INPUT_EOF' };
  assert.deepEqual(decodeLiveBridgeEnvelope(Buffer.from(JSON.stringify(value) + '\n')), value);
});
void test('duplicate and escaped-alias keys are rejected before profile validation', () => {
  for (const duplicate of ['"version":1,', '"version" : 1,', '"\\u0076ersion":1,'])
    assert.throws(
      () =>
        decodeLiveBridgeEnvelope(
          Buffer.from(
            '{"version":1,' +
              duplicate +
              '"profile":"live-fix-ingress-v1","kind":"ERROR","code":"INPUT_EOF"}\n',
          ),
        ),
      rejected,
    );
  const base = {
    version: 1,
    profile: 'live-fix-ingress-v1',
    kind: 'STOPPED',
    session_id: randomUUID(),
    store_id: randomUUID(),
    connection_id: randomUUID(),
    pending: 0,
    financial_application_verified: false,
    transport_evidence_complete: true,
  };
  const raw = JSON.stringify(base).slice(0, -1) + ',"child_exit_codes":{"go":0,"go":1,"java":0}}\n';
  assert.throws(() => decodeLiveBridgeEnvelope(Buffer.from(raw)), rejected);
});
void test('oversize, partial, non-ASCII and wrong-profile envelopes fail closed', () => {
  for (const raw of [
    Buffer.alloc(24577, 32),
    Buffer.from('{}'),
    Buffer.from([255, 10]),
    Buffer.from(
      '{"version":2,"profile":"live-fix-ingress-v1","kind":"ERROR","code":"INPUT_EOF"}\n',
    ),
    Buffer.from('{"version":1,"profile":"legacy","kind":"ERROR","code":"INPUT_EOF"}\n'),
  ])
    assert.throws(() => decodeLiveBridgeEnvelope(raw), rejected);
});
