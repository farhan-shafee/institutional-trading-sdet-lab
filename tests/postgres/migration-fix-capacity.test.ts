import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { applicationFixture } from './fix-application-fixture.js';
import { startOwnedPostgres } from '../../scripts/owned-postgres.js';
import { bootstrap, readOwner, migrate } from '../../scripts/workflow-database.js';
import { verificationManifest } from '../../app/server/reconciliation/manifest.js';
import { metadataSchema } from '../../app/domain/workflow/reconciliation.js';
import { VerificationDatabase } from '../../app/server/reconciliation/database.js';
import { verifyFixApplication } from '../../app/server/fix/application-reconciliation.js';

void test('populated007→008 preserves old rows, profiles, kernel identity, prepared keys and Phase3B2 completion sources', async () => {
  const instance = await startOwnedPostgres(process.env.TF_PG_BIN),
    original = process.env.TF_DB_OWNER_FILE;
  let s: Awaited<ReturnType<typeof applicationFixture>> | undefined,
    admin: pg.Client | undefined,
    reader: pg.Client | undefined,
    verifier: VerificationDatabase | undefined;
  try {
    await bootstrap(instance.path, 7);
    const cfg = await readOwner(instance.path);
    process.env.TF_DB_OWNER_FILE = instance.path;
    admin = new pg.Client({ connectionString: cfg.adminUrl });
    await admin.connect();
    reader = new pg.Client({ connectionString: cfg.reconcilerUrl });
    await reader.connect();
    s = await applicationFixture();
    assert.equal((await s.apply((await s.prepare()).work)).status, 200);
    const px = (
      await s.app.query<{ contract: Record<string, string> }>(
        'SELECT contract FROM fi.orders WHERE sandbox_id=$1 AND id=$2',
        [s.id, s.order],
      )
    ).rows[0]!.contract['clean_price']!;
    const prepared = await s.prepare({
      '150': 'F',
      '39': '1',
      '14': '50.00',
      '151': '50.00',
      '32': '50.00',
      '31': px,
      '6': px,
    });
    const manifest = await verificationManifest(),
      historical = {
        ...manifest,
        engine_version: 'reconciliation-v3',
        schema_revision: 7,
        schema_checksums: manifest.schema_checksums!.slice(0, 7),
      };
    const run = randomUUID(),
      key = randomUUID();
    assert.equal(
      (
        await s.app.query<{ r: { status: number } }>(
          'SELECT fi_control.reconciliation_command($1,$2,1,$3,$4,$5,$6,$7,$8) r',
          [
            s.id,
            s.proof,
            'CREATE_RECONCILIATION',
            JSON.stringify({ run_id: run }),
            'a'.repeat(64),
            key,
            s.actor,
            JSON.stringify(historical),
          ],
        )
      ).rows[0]!.r.status,
      201,
    );
    const tables = [
      'orders',
      'order_states',
      'commands',
      'audit_events',
      'order_history',
      'executions',
      'positions',
      'fix_bindings',
      'fix_lanes',
      'fix_work',
      'fix_messages',
      'fix_prepared',
      'fix_commands',
      'fix_events',
      'fix_applications',
      'fix_consumptions',
      'fix_protocol_observations',
      'reconciliation_runs',
      'reconciliation_commands',
      'reconciliation_events',
    ];
    const hashes = async () => {
      const result: string[] = [];
      for (const name of tables)
        result.push(
          (
            await admin!.query<{ h: string }>(
              `SELECT md5(COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]')::text) h FROM fi.${name} x WHERE sandbox_id=$1`,
              [s!.id],
            )
          ).rows[0]!.h,
        );
      return result;
    };
    const functions = async (includeSource: boolean) =>
      (
        await admin!.query<Record<string, unknown>>(
          `SELECT oid::text,proowner::regrole::text owner,prosecdef,proconfig,proacl::text${includeSource ? ',prosrc' : ''} FROM pg_proc WHERE oid IN ('fi_control.fix_command(uuid,text,bigint,text,jsonb,text,uuid)'::regprocedure,'fi_control.order_command_kernel(uuid,text,bigint,text,jsonb,text,text,uuid)'::regprocedure,'fi_control.protect_fix_capacity()'::regprocedure) ORDER BY oid`,
        )
      ).rows;
    const before = await hashes(),
      attrs = await functions(false),
      sources = await functions(true),
      checks = (
        await admin.query(
          'SELECT version,checksum FROM fi_control.schema_migrations ORDER BY version',
        )
      ).rows;
    const legacy = async () => {
      const result: Record<string, unknown>[] = [];
      for (const file of ['fix_foundation', 'fix_application']) {
        const r = (
          await reader!.query<Record<string, unknown>>(
            await readFile(`verification/sql/${file}.sql`, 'utf8'),
            [s!.id],
          )
        ).rows[0]!;
        delete r.snapshot_id;
        delete r.snapshot_at;
        result.push(r);
      }
      return result;
    };
    const oldReports = await legacy();
    await migrate(cfg);
    assert.deepEqual(await hashes(), before);
    assert.deepEqual(await functions(false), attrs);
    const after = await functions(true);
    const kernel = (rows: typeof sources) =>
      rows.find((r) => String(r.prosrc).includes('events:=jsonb_build_array'))!;
    assert.ok(kernel(sources));
    assert.deepEqual(kernel(after), kernel(sources));
    const command = (rows: typeof sources) =>
      String(rows.find((r) => String(r.prosrc).includes("p_action='BIND'"))!.prosrc);
    const strip = (value: string) => {
      const lines = value.split('\n');
      const retained = lines.filter(
        (line) =>
          !line.includes('INTO c,e FROM fi_control.') && !line.includes('FIX_RESERVATION_CAPACITY'),
      );
      assert.equal(lines.length - retained.length, 2);
      const result = retained.join('\n');
      assert.ok(
        result.length > value.length * 0.8,
        'comparison must retain the installed Phase3B2 function',
      );
      return result;
    };
    assert.deepEqual(
      strip(command(after)),
      strip(command(sources)),
      'only the two BIND capacity lines may change',
    );
    assert.ok(command(after).includes('fi.fix_protocol_observations'));
    assert.ok(command(after).includes('fi.fix_applications'));
    assert.deepEqual(
      (
        await admin.query(
          'SELECT version,checksum FROM fi_control.schema_migrations WHERE version<=7 ORDER BY version',
        )
      ).rows,
      checks,
    );
    assert.deepEqual(
      await legacy(),
      oldReports,
      'legacy FIX profiles keep their original interpretations',
    );
    const stored = (
      await admin.query<{ source_metadata: unknown }>(
        'SELECT source_metadata FROM fi.reconciliation_runs WHERE sandbox_id=$1 AND id=$2',
        [s.id, run],
      )
    ).rows[0]!.source_metadata;
    assert.deepEqual(stored, historical);
    assert.equal(metadataSchema.parse(stored).schema_revision, 7);
    assert.equal(
      (
        await s.app.query<{ r: { replayed: boolean } }>(
          'SELECT fi_control.reconciliation_command($1,$2,1,$3,$4,$5,$6,$7,$8) r',
          [
            s.id,
            s.proof,
            'CREATE_RECONCILIATION',
            JSON.stringify({ run_id: run }),
            'a'.repeat(64),
            key,
            s.actor,
            JSON.stringify(historical),
          ],
        )
      ).rows[0]!.r.replayed,
      true,
    );
    assert.equal((await s.apply(prepared.work)).status, 200);
    const cancel = randomUUID(),
      base = { '11': cancel, '41': s.order };
    assert.equal(
      (
        await s.apply(
          (await s.prepare({ '35': 'F', '49': 'TRADEFLOW', '56': 'ATLAS', ...base })).work,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await s.apply(
          (
            await s.prepare({
              '150': '6',
              '39': '6',
              ...base,
              '14': '50.00',
              '151': '50.00',
              '6': px,
            })
          ).work,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await s.apply(
          (await s.prepare({ '35': '9', ...base, '39': '1', '434': '1', '102': '99' })).work,
        )
      ).status,
      200,
      'protocol-only completion must unblock the next work',
    );
    verifier = new VerificationDatabase(cfg.reconcilerUrl!);
    const current = await verifyFixApplication(
      verifier,
      { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
      () => {},
      true,
    );
    assert.equal(current.profile, 'fix-application-v2');
    assert.equal(current.physical_schema_revision, 8);
    assert.equal(current.total_findings, 0);
    assert.equal(current.financial_findings, 0);
    for (const role of ['tf_app', 'tf_reconciler', 'tf_maintenance'])
      assert.equal(
        (
          await admin.query<{ allowed: boolean }>(
            "SELECT has_function_privilege($1,'fi_control.fix_capacity_remaining(uuid)','EXECUTE') allowed",
            [role],
          )
        ).rows[0]!.allowed,
        false,
      );
    await assert.rejects(
      s.app.query('SELECT * FROM fi_control.fix_capacity_remaining($1)', [s.id]),
      (e: unknown) => (e as { code?: string }).code === '42501',
    );
    assert.equal(
      (
        await admin.query<{ n: number }>(
          "SELECT count(*)::int n FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='fi_control.fix_capacity_remaining(uuid)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'",
        )
      ).rows[0]!.n,
      0,
    );
    await migrate(cfg);
    assert.equal((await admin.query('SELECT * FROM fi_control.schema_migrations')).rowCount, 8);
  } finally {
    await verifier?.close();
    try {
      if (s && admin) {
        await admin.query('BEGIN');
        await admin.query("SET LOCAL session_replication_role='replica'");
        await admin.query(
          "UPDATE fi.reconciliation_runs SET requested_at=requested_at-interval '1 minute',lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1 AND state IN ('REQUESTED','RUNNING')",
          [s.id],
        );
        await admin.query('COMMIT');
      }
      await s?.close();
    } finally {
      process.env.TF_DB_OWNER_FILE = original;
      await reader?.end();
      await admin?.end();
      await instance.stop();
    }
  }
});

void test('008 fails closed and rolls back if installed Phase3B2 admission source is unexpected', async () => {
  const instance = await startOwnedPostgres(process.env.TF_PG_BIN);
  let admin: pg.Client | undefined;
  try {
    await bootstrap(instance.path, 7);
    const cfg = await readOwner(instance.path);
    admin = new pg.Client({ connectionString: cfg.adminUrl });
    await admin.connect();
    const source = (
      await admin.query<{ d: string }>(
        "SELECT pg_get_functiondef('fi_control.fix_command(uuid,text,bigint,text,jsonb,text,uuid)'::regprocedure) d",
      )
    ).rows[0]!.d;
    assert.ok(source.includes('s.command_count+c+25+2>512'));
    await admin.query(source.replace('s.command_count+c+25+2>512', 's.command_count+c+26+2>512'));
    await assert.rejects(migrate(cfg), /Unexpected Phase3B2/);
    assert.equal((await admin.query('SELECT * FROM fi_control.schema_migrations')).rowCount, 7);
    assert.equal(
      (
        await admin.query<{ f: string | null }>(
          "SELECT to_regprocedure('fi_control.fix_capacity_remaining(uuid)')::text f",
        )
      ).rows[0]!.f,
      null,
    );
  } finally {
    await admin?.end();
    await instance.stop();
  }
});
