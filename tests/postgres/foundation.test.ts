import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connection, scalar } from './harness.js';

await test('owned database contains the additive foundation and append-only ledger', async () => {
  const db = await connection('admin');
  try {
    assert.equal(await scalar(db, "SELECT to_regclass('fi.sandboxes')::text"), 'fi.sandboxes');
    assert.equal(await scalar(db, "SELECT to_regclass('fi.commands')::text"), 'fi.commands');
    assert.equal(
      await scalar(db, "SELECT to_regclass('fi.audit_events')::text"),
      'fi.audit_events',
    );
    assert.equal(await scalar(db, 'SELECT max(version) FROM fi_control.schema_migrations'), 2);
  } finally {
    await db.end();
  }
});

await test('application role cannot alter immutable audit or receipt records or become owner', async () => {
  const db = await connection('app');
  try {
    assert.equal(await scalar(db, 'SELECT current_user'), 'tf_app');
    assert.equal(
      await scalar(
        db,
        'SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname=current_user',
      ),
      false,
    );
    for (const table of ['audit_events', 'commands']) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const result = await db.query<{ allowed: boolean }>(
          'SELECT has_table_privilege(current_user,$1,$2) AS allowed',
          [`fi.${table}`, privilege],
        );
        assert.equal(result.rows[0]?.allowed, false);
      }
    }
    await assert.rejects(db.query('UPDATE fi.audit_events SET event_type=event_type'), {
      code: '42501',
    });
    await assert.rejects(db.query('SET ROLE tf_owner'), { code: '42501' });
    await assert.rejects(db.query('SELECT * FROM fi_control.sandbox_access'), { code: '42501' });
    await assert.rejects(db.query('SELECT fi_control.purge_expired()'), { code: '42501' });
  } finally {
    await db.end();
  }
});

await test('sandbox tables force RLS and a missing application context sees no rows', async () => {
  const admin = await connection('admin');
  const app = await connection('app');
  try {
    const result = await admin.query<{ secured: boolean }>(
      "SELECT bool_and(relrowsecurity AND relforcerowsecurity) AS secured FROM pg_class WHERE oid IN ('fi.sandboxes'::regclass,'fi.commands'::regclass,'fi.audit_events'::regclass)",
    );
    assert.equal(result.rows[0]?.secured, true);
    for (const table of ['sandboxes', 'commands', 'audit_events']) {
      assert.equal(await scalar(app, `SELECT count(*)::int FROM fi.${table}`), 0);
    }
  } finally {
    await app.end();
    await admin.end();
  }
});
