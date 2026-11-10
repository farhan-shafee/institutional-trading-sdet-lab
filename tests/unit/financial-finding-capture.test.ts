import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FinancialFindingRecorder,
  captureWorker,
  loadCaptureSources,
  privateCaptureSink,
} from '../../scripts/financial-finding-capture.js';
import { postgresCaptureArguments } from '../../scripts/postgres-capture-runner.js';

const sandbox = '11111111-1111-4111-8111-111111111111';
const snapshot = {
  profile: 'fix-application-v2',
  physical_schema_revision: 8,
  snapshot_id: '100:105:101',
  snapshot_at: new Date('2026-11-08T12:00:00.000Z'),
  financial_watermark: '4',
  protocol_watermark: '9',
  protocol_ingest_watermark: '5',
  protocol_prepare_watermark: '8',
  protocol_application_watermark: '9',
};
const row = {
  category: 'lifecycle',
  code: 'LIFECYCLE_TRANSITION',
  record_kind: 'order',
  record_id: sandbox,
  related: { version: 2 },
  expected: { ordered: true },
  observed: {
    ordered: false,
    contract: JSON.stringify({
      instrument_id: 'SYN-UST-2031',
      par_amount: '1000000.00',
      side: 'BUY',
    }),
    terms: JSON.stringify([1, true, null, 'USD']),
  },
};

void test('capture admits only the exact capacity worker and separate diagnostic demo', () => {
  assert.equal(captureWorker('/repo/tests/postgres/fix-capacity-admission.test.ts', '/repo'), true);
  assert.equal(
    captureWorker('/repo/tests/diagnostics/financial-finding-capture.demo.ts', '/repo'),
    true,
  );
  for (const path of [
    undefined,
    '/repo/tests/postgres/other.test.ts',
    '/other/tests/postgres/fix-capacity-admission.test.ts',
  ])
    assert.equal(captureWorker(path, '/repo'), false);
});

void test('capture retains actual financial rows and snapshot before returning the same query result', async () => {
  const sources = await loadCaptureSources();
  const events: string[] = [];
  const recorder = new FinancialFindingRecorder(sources, (json) => events.push(json));
  const client = {};
  const result = { rows: [row] };
  const parameters = [sandbox];
  const argsSeen: unknown[][] = [];
  const query = recorder.wrap(function (this: object, ...args: unknown[]) {
    assert.equal(this, client);
    argsSeen.push(args);
    return Promise.resolve(args[0] === sources.snapshotSql ? { rows: [snapshot] } : result);
  });
  await query.call(client, sources.snapshotSql, parameters);
  assert.equal(await query.call(client, sources.financial[3]!.sql, parameters), result);
  assert.equal(argsSeen[1]![1], parameters);
  assert.equal(events.length, 1);
  const captured = JSON.parse(events[0]!) as Record<string, unknown>;
  assert.equal(captured['status'], 'COMPLETE');
  assert.equal(captured['layer'], 'comparisons');
  assert.equal(captured['query_sha256'], sources.financial[3]!.sha256);
  assert.equal(captured['sandbox_id'], sandbox);
  assert.deepEqual(captured['rows'], [row]);
  assert.deepEqual(captured['snapshot'], JSON.parse(JSON.stringify(snapshot)));
  assert.equal(captured['finding_count'], 1);
});

void test('capture preserves rejections, callbacks, query objects, unknown queries and healthy results', async () => {
  const sources = await loadCaptureSources();
  const events: string[] = [];
  const recorder = new FinancialFindingRecorder(sources, (json) => events.push(json));
  const failure = new Error('original query failure');
  await assert.rejects(
    Promise.resolve(
      recorder.wrap(() => Promise.reject(failure)).call({}, sources.financial[0]!.sql, [sandbox]),
    ),
    (e) => e === failure,
  );
  const marker = {};
  const callback = () => {};
  const original = (...args: unknown[]) => {
    assert.equal(args[2], callback);
    return marker;
  };
  assert.equal(
    recorder.wrap(original).call({}, sources.financial[0]!.sql, [sandbox], callback),
    marker,
  );
  const pending = Promise.resolve({ rows: [row] });
  const passthrough = recorder.wrap(() => pending);
  assert.equal(
    passthrough.call({}, { text: sources.financial[0]!.sql, values: [sandbox] }),
    pending,
  );
  assert.equal(passthrough.call({}, 'SELECT unrelated', [sandbox]), pending);
  assert.equal(
    passthrough.call({}, sources.financial[0]!.sql, [sandbox, 'private-proof']),
    pending,
  );
  assert.equal(passthrough.call({}, sources.financial[0]!.sql + ' ', [sandbox]), pending);
  await recorder
    .wrap(() => Promise.resolve({ rows: [] }))
    .call({}, sources.financial[0]!.sql, [sandbox]);
  assert.equal(events.length, 0);
});

void test('capture marks missing context and unsafe or oversize rows incomplete without leaking them', async () => {
  const sources = await loadCaptureSources();
  for (const unsafe of [
    { ...row, observed: { password: 'DO-NOT-LOG' } },
    { ...row, observed: { nonce: 'DO-NOT-LOG' } },
    { ...row, observed: { contract: JSON.stringify({ proof: 'DO-NOT-LOG' }) } },
    { ...row, observed: { terms: JSON.stringify({ password: 'DO-NOT-LOG' }) } },
    { ...row, observed: JSON.stringify(JSON.stringify({ nonce: 'DO-NOT-LOG' })) },
    { ...row, observed: 'postgresql://user:DO-NOT-LOG@host/db' },
    { ...row, observed: 'x'.repeat(70000) },
    { ...row, unexpected: 'DO-NOT-LOG' },
    {
      ...row,
      get observed() {
        throw new Error('DO-NOT-LOG');
      },
    },
  ]) {
    const events: string[] = [];
    const recorder = new FinancialFindingRecorder(sources, (json) => events.push(json));
    const original = { rows: [unsafe] };
    assert.equal(
      await recorder
        .wrap(() => Promise.resolve(original))
        .call({}, sources.financial[3]!.sql, [sandbox]),
      original,
    );
    const captured = JSON.parse(events[0]!) as Record<string, unknown>;
    assert.equal(captured['status'], 'INCOMPLETE');
    assert.equal(captured['omitted_rows'], 1);
    assert.deepEqual(captured['rows'], []);
    assert.ok(!events[0]!.includes('DO-NOT-LOG'));
    assert.ok(Buffer.byteLength(events[0]!) <= 65536);
  }
  const events: string[] = [];
  const recorder = new FinancialFindingRecorder(sources, (json) => events.push(json));
  await recorder
    .wrap(() => Promise.resolve({ rows: [row] }))
    .call({}, sources.financial[3]!.sql, [sandbox]);
  assert.equal((JSON.parse(events[0]!) as { status: string }).status, 'INCOMPLETE');
});

void test('capture bounds the whole worker and forgets snapshot context at transaction boundaries', async () => {
  const sources = await loadCaptureSources();
  const events: string[] = [];
  const recorder = new FinancialFindingRecorder(sources, (json) => events.push(json));
  const client = {};
  const query = recorder.wrap((sql: unknown) =>
    Promise.resolve({ rows: sql === sources.snapshotSql ? [snapshot] : [row] }),
  );
  await query.call(client, sources.snapshotSql, [sandbox]);
  await query.call(client, 'COMMIT');
  await query.call(client, sources.financial[3]!.sql, [sandbox]);
  assert.equal((JSON.parse(events[0]!) as { snapshot: unknown }).snapshot, null);
  for (let i = 0; i < 40; i++) await query.call(client, sources.financial[3]!.sql, [sandbox]);
  assert.equal(events.length, 16);
  assert.ok(events.reduce((n, value) => n + Buffer.byteLength(value), 0) <= 1048576);
  assert.equal((JSON.parse(events[15]!) as { reason: string }).reason, 'WORKER_CAPTURE_LIMIT');
});

void test('private capture creates no healthy artifact and writes private bounded findings independently of cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'tf-capture-'));
  try {
    const logs: string[] = [];
    const sink = privateCaptureSink(root, (json) => logs.push(json));
    assert.deepEqual(readdirSync(root), []);
    sink('{"status":"COMPLETE","rows":[]}\n');
    const directory = join(root, readdirSync(root)[0]!);
    const file = join(directory, readdirSync(directory)[0]!);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, 'utf8'), logs[0]);
    assert.ok(Buffer.byteLength(logs[0]!) <= 65536);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('capture sink failures never replace the financial query result', async () => {
  const sources = await loadCaptureSources();
  const recorder = new FinancialFindingRecorder(sources, () => {
    throw new Error('private path omitted');
  });
  const result = { rows: [row] };
  assert.equal(
    await recorder
      .wrap(() => Promise.resolve(result))
      .call({}, sources.financial[3]!.sql, [sandbox]),
    result,
  );
});

void test('capture admission failure preserves the original query promise', async () => {
  const sources = await loadCaptureSources();
  const recorder = new FinancialFindingRecorder(sources, () => assert.fail('No capture admitted'));
  const result = Promise.resolve({ rows: [row] });
  const query = recorder.wrap(
    () => result,
    () => {
      throw new Error('private admission material');
    },
  );
  assert.equal(query.call({}, sources.financial[3]!.sql, [sandbox]), result);
});

void test('captured runner preserves exact original discovery and test limits, rejecting unknown selections', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir('tests/postgres'))
    .filter((f) => f.endsWith('.test.ts'))
    .sort()
    .map((f) => 'tests/postgres/' + f);
  const args = await postgresCaptureArguments();
  assert.deepEqual(args, [
    '--import',
    'tsx',
    '--import',
    './scripts/financial-finding-preload.ts',
    '--test',
    '--test-concurrency=1',
    '--test-timeout=30000',
    ...files,
  ]);
  assert.deepEqual((await postgresCaptureArguments(['fix-capacity-admission.test.ts'])).slice(7), [
    'tests/postgres/fix-capacity-admission.test.ts',
  ]);
  await assert.rejects(
    postgresCaptureArguments(['../diagnostics/financial-finding-capture.demo.ts']),
  );
  await assert.rejects(
    postgresCaptureArguments(['fix-capacity-admission.test.ts', 'fix-capacity-admission.test.ts']),
  );
});
