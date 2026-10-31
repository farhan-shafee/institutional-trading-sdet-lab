import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { startOwnedPostgres } from '../../scripts/owned-postgres.js';
import { bootstrap, migrate, readOwner } from '../../scripts/workflow-database.js';
import { rfqInput, digest } from './rfq-fixture.js';
import { manifest as oldMetadata } from './reconciliation-fixture.js';
import {
  verificationQueries,
  verificationSources,
  verificationManifest,
} from '../../app/server/reconciliation/manifest.js';
import { metadataSchema } from '../../app/domain/workflow/reconciliation.js';
void test('006 upgrades populated exact schema5, preserves all financial/historical bytes and public OIDs, private kernel body remains authoritative', async () => {
  const instance = await startOwnedPostgres(process.env.TF_PG_BIN);
  const clients: pg.Client[] = [];
  try {
    await bootstrap(instance.path, 5);
    const cfg = await readOwner(instance.path);
    const app = new pg.Client({ connectionString: cfg.appUrl }),
      admin = new pg.Client({ connectionString: cfg.adminUrl }),
      reader = new pg.Client({ connectionString: cfg.reconcilerUrl });
    clients.push(app, admin, reader);
    await Promise.all(clients.map((c) => c.connect()));
    const sid = randomUUID(),
      proof = digest(randomUUID()),
      actor = randomUUID();
    await app.query<Record<string, unknown>>(
      'SELECT fi_control.create_sandbox($1,$2,$3,$4,$5,$6)',
      [sid, digest(randomUUID()), proof, digest('create'), randomUUID(), actor],
    );
    const call = async (fn: string, action: string, p: unknown, key = randomUUID()) =>
      (
        await app.query<{
          r: {
            status: number;
            replayed: boolean;
            body: { order: { id: string }; quotes: { id: string }[] };
          };
        }>(`SELECT fi_control.${fn}($1,$2,1,$3,$4,$5,$6,$7) r`, [
          sid,
          proof,
          action,
          JSON.stringify(p),
          digest(JSON.stringify({ action, p })),
          key,
          actor,
        ])
      ).rows[0]!.r;
    async function order() {
      const input = rfqInput();
      await call('rfq_command', 'CREATE_RFQ', input);
      const q = await call('rfq_command', 'RESPOND_DEALER', {
        rfq_id: input.rfq_id,
        expected_version: '1',
        dealer_id: 'ATLAS',
        response: 'QUOTE',
      });
      return (
        await call('rfq_command', 'ACCEPT_QUOTE', {
          rfq_id: input.rfq_id,
          expected_version: '2',
          quote_id: q.body.quotes[0]!.id,
        })
      ).body.order.id;
    }
    const first = await order(),
      pending = await order(),
      ackKey = randomUUID(),
      payload = { order_id: first, expected_version: '1' };
    const prepared = {
      name: 'pre006-financial-command',
      text: 'SELECT fi_control.order_command($1,$2,1,$3,$4,$5,$6,$7) r',
      values: [
        sid,
        proof,
        'ACK_ORDER',
        JSON.stringify(payload),
        digest(JSON.stringify({ action: 'ACK_ORDER', p: payload })),
        ackKey,
        actor,
      ],
    };
    assert.equal((await app.query<{ r: { status: number } }>(prepared)).rows[0]!.r.status, 200);
    assert.equal(
      (
        await call('order_command', 'EXECUTE_ORDER', {
          order_id: first,
          expected_version: '2',
          execution_id: randomUUID(),
          source_event_id: randomUUID(),
          par_amount: '40.00',
        })
      ).status,
      201,
    );
    const metadata = {
        ...oldMetadata,
        query_hashes: Object.fromEntries(
          Object.entries(verificationSources).map(([n, s]) => [n, s.hash]),
        ),
      },
      run = randomUUID(),
      worker = randomUUID();
    const request = await app.query<{ r: { status: number } }>(
      'SELECT fi_control.reconciliation_command($1,$2,1,$3,$4,$5,$6,$7,$8) r',
      [
        sid,
        proof,
        'CREATE_RECONCILIATION',
        JSON.stringify({ run_id: run }),
        digest('old-run'),
        randomUUID(),
        actor,
        JSON.stringify(metadata),
      ],
    );
    assert.equal(request.rows[0]!.r.status, 201);
    await reader.query<Record<string, unknown>>(
      'SELECT fi_control.claim_reconciliation($1,$2,1,$3,$4,$5)',
      [sid, proof, run, worker, JSON.stringify(metadata)],
    );
    await reader.query<Record<string, unknown>>('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (
      await reader.query<{ id: string; at: Date; watermark: string }>(
        'SELECT pg_current_snapshot()::text id,clock_timestamp() at,(SELECT max(command_seq)::text FROM fi.commands WHERE sandbox_id=$1) watermark',
        [sid],
      )
    ).rows[0]!;
    const queries = await verificationQueries();
    for (const [name, sql] of Object.entries(queries))
      assert.equal(
        (
          await reader.query<Record<string, unknown>>(
            name === 'comparisons' ? sql : `SELECT * FROM (${sql}) v WHERE sandbox_id=$1`,
            [sid],
          )
        ).rows.length,
        0,
      );
    await reader.query<Record<string, unknown>>('COMMIT');
    const report = {
      status: 'COMPLETED_CLEAN',
      snapshot: { id: snapshot.id, at: snapshot.at.toISOString(), watermark: snapshot.watermark },
      coverage: Object.entries(verificationSources).map(([name, s]) => ({
        name,
        hash: s.hash,
        status: 'COMPLETE',
        rows: 0,
      })),
      findings: [],
      total_findings: 0,
      failure_reason: null,
    };
    assert.equal(
      (
        await reader.query<{ r: { status: number } }>(
          'SELECT fi_control.finish_reconciliation($1,$2,1,$3,$4,$5) r',
          [sid, proof, run, worker, JSON.stringify(report)],
        )
      ).rows[0]!.r.status,
      200,
    );
    const tables = [
      'orders',
      'order_states',
      'commands',
      'audit_events',
      'executions',
      'positions',
      'order_history',
      'cancellation_requests',
      'cancellation_outcomes',
      'reconciliation_runs',
      'reconciliation_commands',
      'reconciliation_events',
      'reconciliation_findings',
    ];
    async function hashes() {
      const results: string[] = [];
      for (const t of tables)
        results.push(
          (
            await admin.query<{ h: string }>(
              `SELECT md5(COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]')::text) h FROM fi.${t} x WHERE sandbox_id=$1`,
              [sid],
            )
          ).rows[0]!.h,
        );
      return results;
    }
    const before = await hashes(),
      kernel = (
        await admin.query<{ prosrc: string; id: string }>(
          "SELECT prosrc,oid::text id FROM pg_proc WHERE oid='fi_control.order_command(uuid,text,bigint,text,jsonb,text,text,uuid)'::regprocedure",
        )
      ).rows[0]!;
    const checks = (
      await admin.query<Record<string, unknown>>(
        'SELECT version,checksum FROM fi_control.schema_migrations ORDER BY version',
      )
    ).rows;
    await migrate(cfg, undefined, 6);
    assert.deepEqual(await hashes(), before);
    assert.deepEqual(
      (
        await admin.query<Record<string, unknown>>(
          'SELECT version,checksum FROM fi_control.schema_migrations WHERE version<=5 ORDER BY version',
        )
      ).rows,
      checks,
    );
    const after = (
      await admin.query<{ prosrc: string }>(
        "SELECT prosrc FROM pg_proc WHERE oid='fi_control.order_command_kernel(uuid,text,bigint,text,jsonb,text,text,uuid)'::regprocedure",
      )
    ).rows[0]!;
    assert.equal(after.prosrc, kernel.prosrc);
    assert.equal(
      (
        await admin.query<{ id: string }>(
          "SELECT 'fi_control.order_command(uuid,text,bigint,text,jsonb,text,text,uuid)'::regprocedure::oid::text id",
        )
      ).rows[0]!.id,
      kernel.id,
    );
    const replay = (await app.query<{ r: { status: number; replayed: boolean } }>(prepared))
      .rows[0]!.r;
    assert.equal(replay.status, 200);
    assert.equal(replay.replayed, true);
    const historical = (
      await admin.query<{ source_metadata: unknown; state: string }>(
        'SELECT source_metadata,state FROM fi.reconciliation_runs WHERE sandbox_id=$1',
        [sid],
      )
    ).rows[0]!;
    assert.equal(historical.state, 'COMPLETED_CLEAN');
    assert.equal(metadataSchema.parse(historical.source_metadata).schema_revision, 5);
    const physical = await verificationManifest();
    const current = {
      ...physical,
      engine_version: 'reconciliation-v2',
      schema_revision: 6,
      schema_checksums: physical.schema_checksums!.slice(0, 6),
    };
    assert.equal(current.engine_version, 'reconciliation-v2');
    assert.equal(current.schema_revision, 6);
    assert.equal(current.schema_checksums?.length, 6);
    assert.equal(
      (
        await app.query<{ r: { status: number } }>(
          'SELECT fi_control.reconciliation_command($1,$2,1,$3,$4,$5,$6,$7,$8) r',
          [
            sid,
            proof,
            'CREATE_RECONCILIATION',
            JSON.stringify({ run_id: randomUUID() }),
            digest('new-run'),
            randomUUID(),
            actor,
            JSON.stringify(current),
          ],
        )
      ).rows[0]!.r.status,
      201,
    );
    assert.equal(
      (
        await app.query<{ r: { status: number } }>(
          'SELECT fi_control.fix_command($1,$2,1,$3,$4,$5,$6) r',
          [
            sid,
            proof,
            'BIND',
            JSON.stringify({ order_id: pending, dealer_id: 'ATLAS', channel_id: randomUUID() }),
            randomUUID(),
            actor,
          ],
        )
      ).rows[0]!.r.status,
      201,
    );
    const migration = await readFile('db/migrations/006_fix_adapter.sql', 'utf8');
    assert.ok(!migration.includes('CREATE TABLE fi.orders'));
    assert.equal(
      (
        await admin.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.executions WHERE sandbox_id=$1',
          [sid],
        )
      ).rows[0]!.n,
      1,
    );
  } finally {
    await Promise.all(clients.map((c) => c.end()));
    await instance.stop();
  }
});
