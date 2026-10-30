import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { connection } from './harness.js';
import { executionSandbox } from './execution-fixture.js';
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
await test('independent Python verifies committed partial execution cash for both conventions and actual per-fill rounding', async () => {
  for (const instrument of ['SYN-UST-2031', 'SYN-CORP-2031'])
    for (const date of ['2028-01-15', '2028-02-29', '2031-01-14']) {
      const s = await executionSandbox(
        '100.00',
        instrument === 'SYN-UST-2031' ? 'BUY' : 'SELL',
        instrument,
        date,
      );
      try {
        await s.command('ACK_ORDER', { expected_version: '1' });
        const a = await s.fill('2', '50.00'),
          b = await s.fill('3', '50.00');
        assert.equal(b.status, 201);
        const r = await s.app.query<{ result: { body: unknown } }>(
          'SELECT fi_control.read_orders($1,$2,$3,$4,$5) AS result',
          [s.id, s.proof, 'trade', '1', s.order],
        );
        const oracle = spawnSync(python, ['verification/python/execution_reference.py'], {
          input: JSON.stringify(r.rows[0]!.result.body),
          encoding: 'utf8',
          timeout: 10000,
        });
        assert.equal(oracle.status, 0, oracle.stderr);
        assert.match(oracle.stdout, /Independent execution cash verified/);
        if (date === '2028-01-15' && instrument === 'SYN-UST-2031') {
          assert.equal(a.body.execution?.consideration_cents, '5003');
          assert.equal(b.body.lifecycle.executed_cents, '10006');
        }
      } finally {
        await s.close();
      }
    }
});
await test('independent SQL reconstructs quantities, positions, exact rational cents, counts and audit without application helpers', async () => {
  const s = await executionSandbox();
  const reader = await connection('reconciler'),
    admin = await connection('admin');
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    await s.fill('2', '100.00');
    const sql = await readFile('verification/sql/executions.sql', 'utf8');
    assert.equal((await reader.query<Record<string, unknown>>(sql)).rowCount, 0);
    for (const defect of ['quantity', 'position', 'cash', 'count', 'matching-cash']) {
      await admin.query<Record<string, unknown>>('BEGIN');
      await admin.query<Record<string, unknown>>("SET LOCAL session_replication_role='replica'");
      try {
        if (defect === 'quantity')
          await admin.query<Record<string, unknown>>(
            'UPDATE fi.order_states SET filled_par=filled_par-1 WHERE sandbox_id=$1',
            [s.id],
          );
        if (defect === 'position')
          await admin.query<Record<string, unknown>>(
            'UPDATE fi.positions SET signed_par=signed_par-1 WHERE sandbox_id=$1',
            [s.id],
          );
        if (defect === 'cash')
          await admin.query<Record<string, unknown>>(
            'UPDATE fi.positions SET signed_cash_cents=signed_cash_cents-1 WHERE sandbox_id=$1',
            [s.id],
          );
        if (defect === 'count')
          await admin.query<Record<string, unknown>>(
            'UPDATE fi.positions SET execution_count=execution_count+1 WHERE sandbox_id=$1',
            [s.id],
          );
        if (defect === 'matching-cash') {
          await admin.query<Record<string, unknown>>(
            'UPDATE fi.executions SET consideration_cents=consideration_cents+1 WHERE sandbox_id=$1',
            [s.id],
          );
          await admin.query<Record<string, unknown>>(
            'UPDATE fi.order_states SET executed_cents=executed_cents+1 WHERE sandbox_id=$1',
            [s.id],
          );
          await admin.query<Record<string, unknown>>(
            'UPDATE fi.positions SET signed_cash_cents=signed_cash_cents-1 WHERE sandbox_id=$1',
            [s.id],
          );
        }
        const bad = await admin.query<{ invariant: string }>(sql);
        assert.ok(bad.rowCount! > 0, `Must detect ${defect}`);
        if (defect === 'matching-cash')
          assert.ok(bad.rows.some((r) => r.invariant === 'EXECUTION_CASH'));
      } finally {
        await admin.query<Record<string, unknown>>('ROLLBACK');
      }
    }
    assert.equal((await reader.query<Record<string, unknown>>(sql)).rowCount, 0);
  } finally {
    await reader.end();
    await admin.end();
    await s.close();
  }
});
