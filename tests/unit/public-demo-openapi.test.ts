import assert from 'node:assert/strict';
import { test } from 'node:test';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';

await test('public wire contracts reject ownership material and malformed status values independently of app types', async () => {
  const document = await SwaggerParser.dereference('contracts/openapi.yaml');
  const paths = document.paths as Record<
    string,
    Record<string, { responses: Record<string, { content?: Record<string, { schema?: object }> }> }>
  >;
  const statusSchema =
    paths['/api/public-demo/status']?.get?.responses['200']?.content?.['application/json']?.schema;
  const workspaceSchema =
    paths['/api/public-demo/workspace']?.post?.responses['201']?.content?.['application/json']
      ?.schema;
  assert.ok(statusSchema, 'Public status must have an independently published wire contract.');
  assert.ok(
    workspaceSchema,
    'Public workspace must have an independently published wire contract.',
  );
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const status = ajv.compile(statusSchema);
  assert.equal(
    status({ enabled: true, state: 'ready', write_minutes: 30, retention_minutes: 60 }),
    true,
  );
  assert.equal(
    status({ enabled: true, state: 'ready', write_minutes: '30', retention_minutes: 60 }),
    false,
  );
  assert.equal(
    status({ enabled: true, state: 'disabled', write_minutes: 30, retention_minutes: 60 }),
    false,
  );
  const workspace = ajv.compile(workspaceSchema);
  const body = {
    sandbox: {
      id: '830d3d08-c652-4ffd-8a29-288db74a2643',
      created_at: '2026-11-05T12:00:00Z',
      write_expires_at: '2026-11-05T12:30:00Z',
      retained_until: '2026-11-05T13:00:00Z',
      generation: '1',
      commit_seq: '1',
      read_only: false,
    },
    scope: 'trade',
  };
  assert.equal(workspace(body), true);
  assert.equal(workspace({ ...body, trade_capability: 'browser-secret-must-never-appear' }), false);
  assert.equal(workspace({ ...body, sandbox: { ...body.sandbox, generation: 1 } }), false);
});
