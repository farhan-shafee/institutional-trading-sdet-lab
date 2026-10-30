import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { request } from '@playwright/test';
import { OpenApiContracts } from '../contract/openapi-validator.js';
import { readConfiguration } from '../../app/server/configuration.js';
import { owner, connection } from './harness.js';
import { httpLab } from './http.js';

await test('actual PostgreSQL workflow responses satisfy independently authored OpenAPI and reject malformed success bodies', async () => {
  const owned = await owner();
  if (!owned.appUrl) throw new Error('Application role required.');
  const lab = await httpLab(
    readConfiguration({
      TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
      TRADEFLOW_FIXED_INCOME_DATABASE_URL: owned.appUrl,
    }),
  );
  const document = await request.newContext({ baseURL: lab.origin });
  const input = {
    sandbox_id: randomUUID(),
    read_capability: randomBytes(32).toString('base64url'),
    trade_capability: randomBytes(32).toString('base64url'),
  };
  const root = '/api/fixed-income/v1';
  try {
    const contracts = await OpenApiContracts.load(document);
    const token = await lab.login();
    const key = randomUUID();
    const status = await lab.request(`${root}/workflow/status`, token);
    const statusBody: unknown = await status.json();
    const statusValidator = contracts.response('get', `${root}/workflow/status`, 200);
    assert.equal(statusValidator(statusBody), true);
    assert.equal(statusValidator({ enabled: false, state: 'ready' }), false);
    const created = await lab.request(`${root}/sandboxes`, token, 'POST', input, key);
    assert.equal(created.status, 201);
    const body = (await created.json()) as { sandbox: Record<string, unknown>; scope: string };
    const validate = contracts.response('post', `${root}/sandboxes`, 201);
    assert.equal(validate(body), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...body, scope: 'owner' }), false);
    assert.equal(validate({ ...body, sandbox: { ...body.sandbox, generation: 1 } }), false);
    for (const [path, contract] of [
      [`${root}/sandboxes/${input.sandbox_id}`, `${root}/sandboxes/{sid}`],
      [
        `${root}/sandboxes/${input.sandbox_id}/commands/${key}`,
        `${root}/sandboxes/{sid}/commands/{key}`,
      ],
      [
        `${root}/sandboxes/${input.sandbox_id}/audit-events`,
        `${root}/sandboxes/{sid}/audit-events`,
      ],
    ]) {
      const response = await lab.request(path!, token);
      assert.equal(response.status, 200);
      const validator = contracts.response('get', contract!, 200);
      assert.equal(validator(await response.json()), true, JSON.stringify(validator.errors));
    }
    const invalid = await lab.request(
      `${root}/sandboxes`,
      token,
      'POST',
      { ...input, unexpected: true },
      randomUUID(),
    );
    assert.equal(invalid.status, 400);
    assert.equal(contracts.response('post', `${root}/sandboxes`, 400)(await invalid.json()), true);
    const unauthenticated = await lab.request(`${root}/workflow/status`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(
      contracts.response('get', `${root}/workflow/status`, 401)(await unauthenticated.json()),
      true,
    );
  } finally {
    await document.dispose();
    await lab.close();
    const admin = await connection('admin');
    const maint = await connection('maintenance');
    try {
      await admin.query(
        "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
        [input.sandbox_id],
      );
      await maint.query('SELECT fi_control.purge_expired()');
    } finally {
      await maint.end();
      await admin.end();
    }
  }
});
