import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPostTradeReport } from '../../scripts/posttrade-report.js';
import { savePrivate } from '../../scripts/private-state.js';
import { fundedBook, duePayload } from './settlement-fixture.js';

await test('independent immutable history and event reconstruction agrees through correction, failed DVP, posting, reversal and bust', async () => {
  const s = await fundedBook();
  try {
    const input = {
      version: 1,
      owner_file: process.env['TF_DB_OWNER_FILE'],
      sandbox_id: s.id,
      proof: s.proof,
      scope: 'trade',
      generation: '1',
      fixture_id: 'FLAT_V1',
      as_of_date: '2030-01-15',
    };
    const reports: unknown[] = [];
    async function capture() {
      const before = await s.read();
      const report = await buildPostTradeReport(input);
      assert.equal(report.assessment.status, 'AVAILABLE');
      reports.push(report);
      assert.deepEqual(await s.read(), before);
      const repeat = await buildPostTradeReport(input);
      assert.deepEqual(repeat, report);
      return report;
    }
    await capture();
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: s.raw.id,
          expected_revision: 0,
          clean_price: '100.880000000000',
        })
      ).status,
      201,
    );
    const sell = await s.additional('40.00', 'SELL');
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: sell.id,
          expected_revision: 0,
          clean_price: '109.500000000000',
        })
      ).status,
      201,
    );
    const beforeSettlement = await capture();
    assert.equal((await s.post('SETTLE', duePayload(sell.id, 1))).status, 409);
    await capture();
    assert.equal((await s.post('SETTLE', duePayload(s.raw.id, 1))).status, 200);
    assert.equal((await s.post('SETTLE', duePayload(sell.id, 1))).status, 200);
    const posted = await capture();
    assert.equal(posted.assessment.status, 'AVAILABLE');
    assert.equal(beforeSettlement.assessment.status, 'AVAILABLE');
    if (
      posted.assessment.status === 'AVAILABLE' &&
      beforeSettlement.assessment.status === 'AVAILABLE'
    )
      assert.deepEqual(
        posted.assessment.pnl.total_pnl_usd,
        beforeSettlement.assessment.pnl.total_pnl_usd,
      );
    assert.equal((await s.post('REVERSE', duePayload(sell.id, 1))).status, 200);
    assert.equal((await s.post('REVERSE', duePayload(s.raw.id, 1))).status, 200);
    await capture();
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: s.raw.id,
          expected_revision: 1,
          clean_price: '101.000000000000',
        })
      ).status,
      201,
    );
    await capture();
    assert.equal(
      (await s.post('BUST', { execution_id: s.raw.id, expected_revision: 2 })).status,
      201,
    );
    await capture();
    const oracle = spawnSync('python3', ['verification/python/posttrade_reconstruct.py'], {
      input: JSON.stringify(reports),
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 262144,
    });
    assert.equal(oracle.status, 0, oracle.stderr);
    const receipt = JSON.parse(oracle.stdout) as {
      reports: number;
      financial_events_checked: number;
      status: string;
    };
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.reports, 7);
    assert.ok(receipt.financial_events_checked > 30);
    function canonical(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(canonical);
      if (value !== null && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, entry]) => [key, canonical(entry)]),
        );
      return value;
    }
    const corruptions: ((report: Record<string, unknown>) => void)[] = [
      (report) => {
        (report['events'] as unknown[]).shift();
      },
      (report) => {
        const event = (report['events'] as Record<string, unknown>[]).find(
          (row) => row['event_type'] === 'REGISTERED',
        )!;
        event['economic_cash_cents'] = (
          BigInt(event['economic_cash_cents'] as string) + 1n
        ).toString();
      },
      (report) => {
        const first = (report['history'] as Record<string, unknown>[])[0]!;
        const revision = (first['revisions'] as Record<string, unknown>[])[0]!;
        revision['consideration_cents'] = (
          BigInt(revision['consideration_cents'] as string) + 1n
        ).toString();
      },
      (report) => {
        const assessment = report['assessment'] as Record<string, unknown>;
        (assessment['pnl'] as Record<string, unknown>)['total_pnl_usd'] = '999999999999.99';
      },
      (report) => {
        const source = report['source'] as Record<string, unknown>;
        source['available_cash_cents'] = (
          BigInt(source['available_cash_cents'] as string) - 1n
        ).toString();
      },
    ];
    for (const corrupt of corruptions) {
      const altered = JSON.parse(JSON.stringify(reports.at(-1))) as Record<string, unknown>;
      corrupt(altered);
      delete altered['report_id'];
      altered['report_id'] = createHash('sha256')
        .update(JSON.stringify(canonical(altered)))
        .digest('hex');
      const rejected = spawnSync('python3', ['verification/python/posttrade_reconstruct.py'], {
        input: JSON.stringify([altered]),
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 262144,
      });
      assert.equal(
        rejected.status,
        1,
        'Independent reconstruction accepted altered financial records.',
      );
    }
  } finally {
    await s.close();
  }
});

await test('private report CLI reads current owned source, filters historical records and rejects foreign proof or unsafe context', async () => {
  const s = await fundedBook(),
    directory = await mkdtemp(join(tmpdir(), 'tradeflow-posttrade-report-'));
  try {
    const input = {
      version: 1,
      owner_file: process.env['TF_DB_OWNER_FILE'],
      sandbox_id: s.id,
      proof: s.proof,
      scope: 'trade',
      generation: '1',
      fixture_id: 'BASE_UP_V1',
      as_of_date: '2030-01-15',
    };
    const original = await buildPostTradeReport(input);
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: s.raw.id,
          expected_revision: 0,
          clean_price: '100.880000000000',
        })
      ).status,
      201,
    );
    const historical = await buildPostTradeReport({
      ...input,
      raw_as_of_seq: original.source.raw_command_seq,
      posttrade_as_of_seq: original.source.posttrade_command_seq,
    });
    assert.deepEqual(historical, original);
    await assert.rejects(() => buildPostTradeReport({ ...input, proof: 'f'.repeat(64) }));
    await assert.rejects(() => buildPostTradeReport({ ...input, positions: [] }));
    const context = join(directory, randomUUID() + '.json');
    await savePrivate(context, input);
    const good = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/posttrade-report.ts', context],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 262144 },
    );
    assert.equal(good.status, 0, good.stderr);
    const current = await buildPostTradeReport(input);
    assert.deepEqual(JSON.parse(good.stdout), current);
    assert.ok(!good.stdout.includes(s.proof));
    assert.ok(!good.stdout.includes('postgresql:'));
    await chmod(context, 0o644);
    const bad = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/posttrade-report.ts', context],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 262144 },
    );
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, '');
    assert.ok(!bad.stderr.includes(s.proof));
    assert.ok(!bad.stderr.includes('postgresql:'));
  } finally {
    await s.close();
    await rm(directory, { recursive: true, force: true });
  }
});
