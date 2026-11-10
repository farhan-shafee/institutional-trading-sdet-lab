import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { publicPostTradeHttp, publicExecution } from './http-fixture.js';
import { connection } from '../public-demo/database.js';
import {
  pnlAssessmentSchema,
  commandReceiptSchema,
  postTradeHistorySchema,
} from '../../app/domain/post-trade/api-contracts.js';
import { ownedSourceSchema } from '../../app/domain/post-trade/source.js';
import { publicWireReport, verifyPublicReports, reportDigest } from './independent.js';

const query = '?fixture_id=FLAT_V1&as_of_date=2030-01-15';

await test('public BUY100/SELL40 retains failed receipts, exact FIFO, source balances and reversal conservation', async () => {
  const lab = await publicPostTradeHttp();
  try {
    const { token, root, body } = await lab.workspace(),
      path = root + '/posttrade';
    const status = await lab.request('/api/public-demo/posttrade/status', token);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { enabled: true, state: 'ready' });
    const post = (suffix: string, payload: object, key = randomUUID()) =>
      lab.request(path + suffix, token, 'POST', payload, key);
    assert.equal((await post('/initialize', { economic_start_date: '2030-01-15' })).status, 201);
    const buy = await publicExecution(lab, token, root),
      sell = await publicExecution(lab, token, root, '40.00', 'SELL');
    for (const [id, clean] of [
      [buy, '100.880000000000'],
      [sell, '109.500000000000'],
    ]) {
      assert.equal((await post('/executions/' + id + '/register', {})).status, 201);
      assert.equal(
        (
          await post('/executions/' + id + '/corrections', {
            expected_revision: 0,
            clean_price: clean,
          })
        ).status,
        201,
      );
    }
    const failedKey = randomUUID(),
      failedPayload = { expected_revision: 1, processing_date: '2030-01-15' };
    const failed = await post('/executions/' + sell + '/settlements', failedPayload, failedKey);
    assert.equal(failed.status, 409);
    const failedBody: unknown = await failed.json();
    assert.equal((failedBody as { settlement_state: string }).settlement_state, 'FAILED');
    const failedReceipt = await lab.request(path + '/commands/' + failedKey, token);
    assert.equal(failedReceipt.status, 200);
    const receipt = commandReceiptSchema.parse(await failedReceipt.json());
    assert.equal(receipt.command.http_status, 409);
    assert.deepEqual(receipt.command.response_body, failedBody);

    const rejectedKey = randomUUID();
    assert.equal(
      (
        await post(
          '/executions/' + buy + '/settlements',
          { expected_revision: 0, processing_date: '2030-01-15' },
          rejectedKey,
        )
      ).status,
      409,
    );
    assert.equal((await lab.request(path + '/commands/' + rejectedKey, token)).status, 404);
    const admin = await connection('admin');
    try {
      assert.equal(
        (
          await admin.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM fi_control.command_keys WHERE sandbox_id=$1 AND idempotency_key=$2',
            [body.sandbox.id, rejectedKey],
          )
        ).rows[0]!.count,
        0,
      );
    } finally {
      await admin.end();
    }

    for (const id of [buy, sell])
      assert.equal(
        (
          await post('/executions/' + id + '/settlements', {
            expected_revision: 1,
            processing_date: '2030-01-16',
          })
        ).status,
        200,
      );
    const assessment = await lab.request(path + '/pnl' + query, token);
    assert.equal(assessment.status, 200);
    const pnl = pnlAssessmentSchema.parse(await assessment.json());
    assert.equal(pnl.status, 'AVAILABLE');
    if (pnl.status !== 'AVAILABLE') throw new Error('Missing owned marks.');
    assert.equal(pnl.source.processing_date_watermark, '2030-01-16');
    assert.equal(pnl.as_of_date, '2030-01-15');
    assert.equal(pnl.pnl.available_cash_usd, '99999942.92');
    assert.equal(
      pnl.pnl.available_securities.find((row) => row.instrument_id === 'SYN-UST-2031')
        ?.available_par,
      '60.00',
    );
    assert.equal(pnl.pnl.total_pnl_usd, '3.49');
    assert.equal(pnl.pnl.equity_usd, '100000003.49');
    const realized = pnl.pnl.realized_pnl_exact_usd,
      basis = pnl.pnl.lots[0]!.remaining_basis_or_proceeds_exact_usd;
    assert.equal(BigInt(realized.numerator) * 1000n, 3448n * BigInt(realized.denominator));
    assert.equal(BigInt(basis.numerator) * 1000n, 60528n * BigInt(basis.denominator));
    const settledReport = await publicWireReport(lab, token, path);
    const cutoff = await lab.request(
      path + '/pnl' + query + '&posttrade_as_of_seq=' + receipt.command.command_seq,
      token,
    );
    assert.equal(cutoff.status, 200);
    const previous = pnlAssessmentSchema.parse(await cutoff.json());
    assert.equal(previous.status, 'AVAILABLE');
    if (previous.status === 'AVAILABLE')
      assert.equal(previous.pnl.available_cash_usd, '100000000.00');
    const replay = await post('/executions/' + sell + '/settlements', failedPayload, failedKey);
    assert.equal(replay.status, 409);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(await replay.json(), failedBody);
    const backward = await post('/executions/' + sell + '/reversals', failedPayload);
    assert.equal(backward.status, 409);
    for (const id of [sell, buy])
      assert.equal(
        (
          await post('/executions/' + id + '/reversals', {
            expected_revision: 1,
            processing_date: '2030-01-16',
          })
        ).status,
        200,
      );
    const reversed = pnlAssessmentSchema.parse(
      await (await lab.request(path + '/pnl' + query, token)).json(),
    );
    assert.equal(reversed.status, 'AVAILABLE');
    if (reversed.status === 'AVAILABLE') {
      assert.equal(reversed.pnl.available_cash_usd, '100000000.00');
      for (const instrument of ['SYN-UST-2031', 'SYN-CORP-2031'])
        assert.equal(
          reversed.pnl.available_securities.find((row) => row.instrument_id === instrument)
            ?.available_par,
          '0.00',
          instrument,
        );
      assert.equal(reversed.pnl.total_pnl_usd, pnl.pnl.total_pnl_usd);
      assert.equal(reversed.pnl.equity_usd, pnl.pnl.equity_usd);
    }
    const reversedReport = await publicWireReport(lab, token, path);
    const corrupt = structuredClone(reversedReport);
    corrupt.source.available_securities!.find(
      (row) => row.instrument_id === 'SYN-UST-2031',
    )!.available_par = '1.00';
    const { report_id: ignored, ...corruptBundle } = corrupt;
    void ignored;
    corrupt.report_id = reportDigest(corruptBundle);
    assert.throws(
      () => verifyPublicReports([corrupt]),
      /Independent public accounting reconstruction failed/,
    );
    const independent = verifyPublicReports([settledReport, reversedReport]);
    assert.equal(independent.status, 'passed');
    assert.equal(independent.reports, 2);
    assert.ok(independent.financial_events_checked > 20);
    const history = postTradeHistorySchema.parse(
      await (await lab.request(path + '/executions/' + sell + '/history', token)).json(),
    );
    assert.deepEqual(
      history.settlement_outcomes.map((row) => row.outcome),
      ['FAILED', 'SETTLED', 'REVERSED'],
    );
    assert.equal(history.original_execution.par_amount, '40.00');
    assert.equal(history.revisions[1]!.consideration_cents, '4380');
    for (const id of [buy, sell])
      assert.equal(
        (await post('/executions/' + id + '/busts', { expected_revision: 1 })).status,
        201,
      );
    const source = ownedSourceSchema.parse(await (await lab.request(path, token)).json());
    assert.ok(source.roots.every((row) => row.busted && row.settlement_state === 'VOIDED'));
  } finally {
    await lab.close();
  }
});

await test('public viewers, foreign sessions, logout and native ownership cannot authorize a financial receipt or replay', async () => {
  const lab = await publicPostTradeHttp();
  try {
    const trader = await lab.workspace(),
      viewer = await lab.workspace(true);
    const path = trader.root + '/posttrade',
      key = randomUUID(),
      payload = { economic_start_date: '2030-01-15' };
    assert.equal(
      (await lab.request(path + '/initialize', trader.token, 'POST', payload, key)).status,
      201,
    );
    assert.equal((await lab.request(path + '/commands/' + key, viewer.token)).status, 404);
    assert.equal(
      (await lab.request(path + '/initialize', viewer.token, 'POST', payload, key)).status,
      404,
    );
    assert.equal(
      (await lab.request(viewer.root + '/posttrade/initialize', viewer.token, 'POST', payload, key))
        .status,
      403,
    );
    const own = ownedSourceSchema.parse(
      await (await lab.request(viewer.root + '/posttrade', viewer.token)).json(),
    );
    assert.equal(own.initialized, false);
    for (const native of [
      '/api/fixed-income/v1/sandboxes',
      '/api/fixed-income/v1/sandboxes/recover',
      trader.root + '/recovery-keys/rotate',
    ])
      assert.equal((await lab.request(native, trader.token, 'POST', {}, randomUUID())).status, 404);
    assert.equal((await lab.request('/api/session', trader.token, 'DELETE')).status, 204);
    assert.equal((await lab.request(path + '/commands/' + key, trader.token)).status, 401);
    assert.equal(
      (await lab.request(path + '/initialize', trader.token, 'POST', payload, key)).status,
      401,
    );
    const next = await lab.login();
    assert.equal((await lab.request(path, next)).status, 403);
  } finally {
    await lab.close();
  }
});

await test('public unknown commit recovers the original request once and reauthorizes before a retained receipt', async () => {
  let armed = false;
  const lab = await publicPostTradeHttp({
    afterCommit: () => {
      if (armed) {
        armed = false;
        throw new Error('CONTROLLED_AFTER_COMMIT_LOSS');
      }
    },
  });
  try {
    const { token, root } = await lab.workspace(),
      path = root + '/posttrade';
    const key = randomUUID(),
      payload = { economic_start_date: '2030-01-15' };
    armed = true;
    const unknown = await lab.request(path + '/initialize', token, 'POST', payload, key);
    assert.equal(unknown.status, 503);
    assert.equal(
      ((await unknown.json()) as { error: { code: string } }).error.code,
      'OUTCOME_UNKNOWN',
    );
    const recovered = await lab.request(path + '/commands/' + key, token);
    assert.equal(recovered.status, 200);
    assert.equal(commandReceiptSchema.parse(await recovered.json()).command.http_status, 201);
    const replay = await lab.request(path + '/initialize', token, 'POST', payload, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    const source = ownedSourceSchema.parse(await (await lab.request(path, token)).json());
    assert.equal(source.posttrade_command_seq, '1');
    assert.equal(source.available_cash_cents, '10000000000');
  } finally {
    await lab.close();
  }
});
