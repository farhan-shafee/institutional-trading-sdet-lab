import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkflowBindings } from '../../app/server/fixed-income-workflow/bindings.js';
import { DomainError } from '../../app/domain/errors.js';

const denied = (code: string) => (error: unknown) =>
  error instanceof DomainError && error.code === code;
const binding = {
  sandboxId: 'sandbox-a',
  digest: 'non-operational-test-digest',
  scope: 'trade' as const,
  generation: '1',
};

await test('workflow context capacity preserves existing contexts and reclaims only absolute expiry', () => {
  let time = 0;
  const registry = new WorkflowBindings(() => time, 2);
  const first = registry.context('a').actorId;
  registry.bind('a', binding);
  registry.context('b');
  assert.throws(() => registry.context('c'), denied('WORKFLOW_BINDING_CAPACITY'));
  assert.equal(registry.binding('a', 'sandbox-a').generation, '1');
  time = 1_799_999;
  registry.context('a');
  time = 1_800_000;
  assert.throws(() => registry.binding('a', 'sandbox-a'), denied('SANDBOX_BINDING_REQUIRED'));
  assert.notEqual(registry.context('a').actorId, first);
  assert.doesNotThrow(() => registry.context('c'));
});
await test('binding replacement and logout invalidate held authorization without clearing another context', () => {
  const registry = new WorkflowBindings();
  const actor = registry.context('a').actorId;
  registry.bind('a', binding);
  const held = registry.binding('a', 'sandbox-a');
  registry.bind('a', { ...binding, generation: '2' });
  assert.throws(() => registry.verify('a', actor, held), denied('WORKFLOW_BINDING_EXPIRED'));
  registry.bind('b', binding);
  registry.forget('a');
  assert.throws(() => registry.verify('a', actor), denied('WORKFLOW_BINDING_EXPIRED'));
  assert.equal(registry.binding('b', 'sandbox-a').generation, '1');
  assert.throws(() => registry.binding('b', 'sandbox-b'), denied('SANDBOX_NOT_FOUND'));
});
await test('read binding cannot authorize trade and per-session workflow mutation admission is bounded', () => {
  let time = 0;
  const registry = new WorkflowBindings(() => time);
  registry.bind('a', { ...binding, scope: 'read' });
  assert.throws(() => registry.binding('a', 'sandbox-a', true), denied('FORBIDDEN'));
  for (let index = 0; index < 30; index++) registry.admitMutation('a');
  assert.throws(() => registry.admitMutation('a'), denied('RATE_LIMITED'));
  time = 60_000;
  assert.doesNotThrow(() => registry.admitMutation('a'));
});
await test('workflow request and recovery proof limits are global and do not retain unbounded identities', () => {
  const registry = new WorkflowBindings();
  for (let index = 0; index < 600; index++) registry.admitRequest();
  assert.throws(() => registry.admitRequest(), denied('RATE_LIMITED'));
  const proof = new WorkflowBindings();
  for (let index = 0; index < 10; index++) proof.admitProof('a');
  assert.throws(() => proof.admitProof('a'), denied('RATE_LIMITED'));
  const global = new WorkflowBindings();
  for (let token = 0; token < 6; token++)
    for (let attempt = 0; attempt < 10; attempt++) global.admitProof(String(token));
  assert.throws(() => global.admitProof('next'), denied('RATE_LIMITED'));
});
