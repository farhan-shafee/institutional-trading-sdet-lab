import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metadataSchema } from '../../../app/domain/workflow/reconciliation.js';
import { manifest } from '../../postgres/reconciliation-fixture.js';
void test('new physical schema6 manifests and historical schema5 financial profiles remain distinct', () => {
  assert.equal(metadataSchema.safeParse(manifest).success, true);
  const checks = Array.from({ length: 6 }, (_, i) => ({
    version: i + 1,
    checksum: 'a'.repeat(64),
  }));
  assert.equal(
    metadataSchema.safeParse({
      ...manifest,
      engine_version: 'reconciliation-v2',
      schema_revision: 6,
      schema_checksums: checks,
    }).success,
    true,
  );
  assert.equal(
    metadataSchema.safeParse({ ...manifest, schema_revision: 6, schema_checksums: checks }).success,
    false,
  );
  assert.equal(
    metadataSchema.safeParse({
      ...manifest,
      engine_version: 'reconciliation-v2',
      schema_revision: 5,
      schema_checksums: checks,
    }).success,
    false,
  );
});
void test('foundation contract has no financial application or transport activation', async () => {
  const { readFile } = await import('node:fs/promises');
  const { parse } = await import('yaml');
  const c = parse(await readFile('contracts/fix-foundation-v1.yaml', 'utf8')) as {
    schema_revision: number;
    transport: string;
    financial_application: string;
    operations: Record<string, unknown>;
    reconciliation: { complete: boolean; delivery_verified: boolean };
  };
  assert.equal(c.schema_revision, 6);
  assert.equal(c.transport, 'NONE');
  assert.equal(c.financial_application, 'NOT_IMPLEMENTED');
  assert.deepEqual(Object.keys(c.operations).sort(), [
    'BIND',
    'CLAIM',
    'PREPARE',
    'QUEUE',
    'RECORD',
    'RELEASE',
    'RESOLVE_METADATA',
  ]);
  assert.equal(c.reconciliation.complete, false);
  assert.equal(c.reconciliation.delivery_verified, false);
});

import type pg from 'pg';
import { DomainError } from '../../../app/domain/errors.js';
import {
  FixFoundationService,
  type FoundationOperation,
} from '../../../app/server/fix/foundation.js';
import type { WorkflowDatabase } from '../../../app/persistence/postgres/workflow.js';
import type { Binding } from '../../../app/server/fixed-income-workflow/bindings.js';
import type { WorkflowResult } from '../../../app/domain/workflow/contracts.js';

const actionBinding: Binding = {
  sandboxId: '11111111-1111-4111-8111-111111111111',
  digest: 'synthetic-unit-digest',
  scope: 'trade',
  generation: '1',
};
const actionActor = '22222222-2222-4222-8222-222222222222';
const actionOrder = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actionKey = 'synthetic-operation-key';
const bindInput = {
  order_id: actionOrder,
  dealer_id: 'ATLAS',
  channel_id: '33333333-3333-4333-8333-333333333333',
};
function operationDatabase(
  response: WorkflowResult = { status: 200, body: { synthetic: true }, replayed: false },
) {
  const transactions: { readOnly: boolean }[] = [];
  const queries: { sql: string; parameters: unknown[] }[] = [];
  const client = {
    query(sql: string, parameters: unknown[]) {
      queries.push({ sql, parameters });
      return Promise.resolve({ rows: [{ result: response }] });
    },
  } as unknown as pg.PoolClient;
  const database = {
    async transaction<T>(
      readOnly: boolean,
      verify: () => void,
      work: (db: pg.PoolClient) => Promise<T>,
    ): Promise<T> {
      transactions.push({ readOnly });
      verify();
      return work(client);
    },
  } satisfies Pick<WorkflowDatabase, 'transaction'>;
  return { database: database as unknown as WorkflowDatabase, transactions, queries };
}
// The cast is restricted to this test boundary; production retains FoundationOperation.
function runtimeAction(
  service: FixFoundationService,
  action: unknown,
  verify: () => void,
  binding = actionBinding,
) {
  return service.command(
    binding,
    actionActor,
    action as FoundationOperation,
    bindInput,
    actionKey,
    verify,
  );
}
const validationError = (error: unknown) =>
  error instanceof DomainError &&
  error.status === 400 &&
  error.code === 'VALIDATION_ERROR' &&
  error.message === 'Invalid FIX metadata command.';
const inheritedActions = ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'];
void test('inherited operation names return deterministic validation errors before database access', async () => {
  const spy = operationDatabase(),
    service = new FixFoundationService(spy.database, true);
  const outcomes: { action: string; name: string; status?: number; code?: string }[] = [];
  let authorizations = 0;
  for (const action of inheritedActions) {
    try {
      await runtimeAction(service, action, () => {
        authorizations++;
      });
      outcomes.push({ action, name: 'unexpected success' });
    } catch (error) {
      if (error instanceof DomainError)
        outcomes.push({ action, name: error.name, status: error.status, code: error.code });
      else
        outcomes.push({
          action,
          name: error instanceof Error ? error.name : 'unexpected rejection',
        });
    }
  }
  console.log(
    'Inherited-operation boundary evidence:',
    JSON.stringify({
      outcomes,
      transactions: spy.transactions.length,
      queries: spy.queries.length,
      authorizations,
    }),
  );
  assert.deepEqual(
    outcomes,
    inheritedActions.map((action) => ({
      action,
      name: 'DomainError',
      status: 400,
      code: 'VALIDATION_ERROR',
    })),
  );
  assert.equal(authorizations, inheritedActions.length);
  assert.equal(spy.transactions.length, 0);
  assert.equal(spy.queries.length, 0);
});

void test('unknown and malformed runtime actions reject without property coercion or database access', async () => {
  let coercions = 0;
  const coercible = {
    toString() {
      coercions++;
      return 'BIND';
    },
  };
  const throwing = {
    [Symbol.toPrimitive]() {
      coercions++;
      throw new Error('Action must not be coerced.');
    },
  };
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const invalid: { label: string; value: unknown }[] = [
    { label: 'empty', value: '' },
    { label: 'unknown', value: 'UNKNOWN' },
    { label: 'lowercase', value: 'bind' },
    { label: 'leading whitespace', value: ' BIND' },
    { label: 'trailing whitespace', value: 'BIND ' },
    { label: 'unregistered own-looking name', value: 'prototype' },
    { label: 'undefined', value: undefined },
    { label: 'null', value: null },
    { label: 'zero', value: 0 },
    { label: 'number', value: 1 },
    { label: 'NaN', value: NaN },
    { label: 'infinity', value: Infinity },
    { label: 'bigint', value: 1n },
    { label: 'true', value: true },
    { label: 'false', value: false },
    { label: 'symbol', value: Symbol('BIND') },
    { label: 'array that stringifies to BIND', value: ['BIND'] },
    { label: 'boxed string', value: Reflect.construct(String, ['BIND']) },
    { label: 'coercible object', value: coercible },
    { label: 'throwing coercion', value: throwing },
    { label: 'null-prototype object', value: Object.create(null) as unknown },
    { label: 'function', value: () => 'BIND' },
    { label: 'revoked proxy', value: revoked.proxy },
  ];
  for (const { label, value } of invalid) {
    const spy = operationDatabase(),
      service = new FixFoundationService(spy.database, true);
    let verified = 0;
    await assert.rejects(
      runtimeAction(service, value, () => {
        verified++;
      }),
      validationError,
      label,
    );
    assert.equal(verified, 1, label);
    assert.equal(spy.transactions.length, 0, label);
    assert.equal(spy.queries.length, 0, label);
  }
  assert.equal(coercions, 0);
  console.log(
    'Malformed-operation boundary evidence:',
    JSON.stringify({
      cases: invalid.map((entry) => entry.label),
      coercions,
      transactions: 0,
      queries: 0,
    }),
  );
});
void test('FIX foundation remains default OFF before validation, authorization callbacks or database access', async () => {
  const spy = operationDatabase(),
    service = new FixFoundationService(spy.database);
  let verified = 0;
  const disabled = (error: unknown) =>
    error instanceof DomainError &&
    error.status === 503 &&
    error.code === 'FIX_FOUNDATION_DISABLED';
  for (const action of ['BIND', 'constructor', null])
    await assert.rejects(
      runtimeAction(service, action, () => {
        verified++;
      }),
      disabled,
    );
  await assert.rejects(
    service.read(actionBinding, 'STATE', actionOrder, () => {
      verified++;
    }),
    disabled,
  );
  assert.equal(verified, 0);
  assert.equal(spy.transactions.length, 0);
  assert.equal(spy.queries.length, 0);
});
void test('existing scope and session authorization still precede operation validation', async () => {
  const spy = operationDatabase(),
    service = new FixFoundationService(spy.database, true);
  let verified = 0;
  for (const action of ['BIND', 'constructor'])
    await assert.rejects(
      runtimeAction(
        service,
        action,
        () => {
          verified++;
        },
        { ...actionBinding, scope: 'read' },
      ),
      (error: unknown) =>
        error instanceof DomainError && error.status === 403 && error.code === 'FORBIDDEN',
    );
  assert.equal(verified, 2);
  const expired = new DomainError(401, 'SESSION_EXPIRED', 'Synthetic expired session.');
  await assert.rejects(
    runtimeAction(service, 'constructor', () => {
      throw expired;
    }),
    (error: unknown) => error === expired,
  );
  assert.equal(spy.transactions.length, 0);
  assert.equal(spy.queries.length, 0);
});
async function supportedInputs(): Promise<Record<FoundationOperation, Record<string, unknown>>> {
  const { readFile } = await import('node:fs/promises');
  const order = { order_id: actionOrder };
  const lease = {
    ...order,
    owner_id: '55555555-5555-4555-8555-555555555555',
    fence: '1',
    work_id: '77777777-7777-4777-8777-777777777777',
  };
  return {
    BIND: { ...bindInput },
    RECORD: {
      ...order,
      attempt_id: '44444444-4444-4444-8444-444444444444',
      raw_hex: (await readFile('test-data/fix44/new-buy-ust.fix')).toString('hex'),
    },
    CLAIM: { ...order, owner_id: lease.owner_id },
    QUEUE: { ...order, message_id: '66666666-6666-4666-8666-666666666666', work_id: lease.work_id },
    PREPARE: { ...lease, financial_key: 'synthetic-financial-key' },
    RESOLVE_METADATA: { ...lease },
    RELEASE: { ...order },
  };
}
const supportedActions: FoundationOperation[] = [
  'BIND',
  'RECORD',
  'CLAIM',
  'QUEUE',
  'PREPARE',
  'RESOLVE_METADATA',
  'RELEASE',
];
void test('all seven supported operations retain validation, normalized payload and transaction dispatch', async () => {
  const inputs = await supportedInputs();
  assert.deepEqual(Object.keys(inputs).sort(), [...supportedActions].sort());
  for (const action of supportedActions) {
    const expected: WorkflowResult = {
      status: ['BIND', 'RECORD', 'QUEUE', 'PREPARE'].includes(action) ? 201 : 200,
      body: { synthetic: true, operation: action },
      replayed: false,
    };
    const spy = operationDatabase(expected),
      service = new FixFoundationService(spy.database, true);
    let verified = 0;
    const result = await service.command(
      actionBinding,
      actionActor,
      action,
      { ...inputs[action], order_id: actionOrder.toUpperCase() },
      actionKey,
      () => {
        verified++;
      },
    );
    assert.deepEqual(result, expected);
    assert.equal(verified, 2);
    assert.deepEqual(spy.transactions, [{ readOnly: false }]);
    assert.equal(spy.queries.length, 1);
    assert.equal(
      spy.queries[0]!.sql,
      'SELECT fi_control.fix_command($1,$2,$3,$4,$5,$6,$7) AS result',
    );
    const params = spy.queries[0]!.parameters;
    assert.deepEqual(params.slice(0, 4), [
      actionBinding.sandboxId,
      actionBinding.digest,
      actionBinding.generation,
      action,
    ]);
    assert.deepEqual(JSON.parse(String(params[4])), inputs[action]);
    assert.deepEqual(params.slice(5), [actionKey, actionActor]);
  }
  console.log(
    'Supported-operation dispatch evidence:',
    JSON.stringify({ actions: supportedActions, validated: 7 }),
  );
});
void test('supported operation schemas and existing actor/key validation still reject malformed inputs before transactions', async () => {
  const inputs = await supportedInputs();
  const spy = operationDatabase(),
    service = new FixFoundationService(spy.database, true);
  for (const action of supportedActions)
    for (const input of [
      { ...inputs[action], unexpected: 'synthetic' },
      { ...inputs[action], order_id: 'not-a-uuid' },
    ])
      await assert.rejects(
        service.command(actionBinding, actionActor, action, input, actionKey, () => {}),
        validationError,
      );
  for (const [actor, key] of [
    [actionActor, ''],
    [actionActor, 'invalid key'],
    ['not-a-uuid', actionKey],
  ])
    await assert.rejects(
      service.command(actionBinding, actor!, 'BIND', bindInput, key!, () => {}),
      validationError,
    );
  assert.equal(spy.transactions.length, 0);
  assert.equal(spy.queries.length, 0);
});
void test('RECORD retains validation versus FIX-profile errors without opening a transaction', async () => {
  const inputs = await supportedInputs(),
    spy = operationDatabase(),
    service = new FixFoundationService(spy.database, true);
  await assert.rejects(
    service.command(
      actionBinding,
      actionActor,
      'RECORD',
      { ...inputs.RECORD, raw_hex: 'zz' },
      actionKey,
      () => {},
    ),
    validationError,
  );
  await assert.rejects(
    service.command(
      actionBinding,
      actionActor,
      'RECORD',
      { ...inputs.RECORD, raw_hex: '00' },
      actionKey,
      () => {},
    ),
    (error: unknown) =>
      error instanceof DomainError &&
      error.status === 400 &&
      error.code === 'FIX_PROFILE_VIOLATION',
  );
  assert.equal(spy.transactions.length, 0);
  assert.equal(spy.queries.length, 0);
});
void test('a valid operation still rechecks authorization at the transaction boundary', async () => {
  const spy = operationDatabase(),
    service = new FixFoundationService(spy.database, true);
  const expired = new DomainError(401, 'SESSION_EXPIRED', 'Synthetic revoked session.');
  let verified = 0;
  await assert.rejects(
    runtimeAction(service, 'BIND', () => {
      if (++verified === 2) throw expired;
    }),
    (error: unknown) => error === expired,
  );
  assert.equal(verified, 2);
  assert.equal(spy.transactions.length, 1);
  assert.equal(spy.queries.length, 0);
});
