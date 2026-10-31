import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { applicationFixture } from './fix-application-fixture.js';
import { connection } from './harness.js';

// Secondary adversarial-verifier cases only. Primary admission tests construct
// every quota from real receipts/audits and never falsify financial counters.
for (const column of ['command_count', 'event_count'] as const)
  void test(`schema8 independent FIX queries detect controlled ${column} budget corruption`, async () => {
    const s = await applicationFixture(),
      admin = await connection('admin'),
      reader = await connection('reconciler');
    try {
      assert.equal((await s.apply((await s.prepare()).work)).status, 200);
      const queries = await Promise.all(
        ['fix_foundation_v2', 'fix_application_v2'].map((file) =>
          readFile(`verification/sql/${file}.sql`, 'utf8'),
        ),
      );
      for (const sql of queries)
        assert.equal(
          (
            await reader.query<{ findings: { code: string }[] }>(sql, [s.id])
          ).rows[0]!.findings.some((f) => f.code === 'EFFECTIVE_CAPACITY'),
          false,
        );
      await admin.query('BEGIN');
      await admin.query("SET LOCAL session_replication_role='replica'");
      await admin.query(
        `UPDATE fi.sandboxes SET ${column}=$2::integer${column === 'command_count' ? ',commit_seq=$2::integer' : ''} WHERE id=$1`,
        [s.id, column === 'command_count' ? 512 : 1024],
      );
      await admin.query('COMMIT');
      for (const sql of queries)
        assert.equal(
          (
            await reader.query<{ findings: { code: string }[] }>(sql, [s.id])
          ).rows[0]!.findings.some((f) => f.code === 'EFFECTIVE_CAPACITY'),
          true,
        );
    } finally {
      await admin.end();
      await reader.end();
      await s.close();
    }
  });
