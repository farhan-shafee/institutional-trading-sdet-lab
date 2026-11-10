import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { z } from 'zod';
import { postTradeHttp } from './http-fixture.js';
import { stopOwnedPostgres, restartOwnedPostgres } from '../../scripts/owned-postgres.js';

await test('explicit owned local CLI serves loopback schema10 and a fresh process recovers original financial receipts', async () => {
  const s = await postTradeHttp(),
    key = randomUUID(),
    payload = { economic_start_date: '2030-01-15' };
  let child: ReturnType<typeof spawn> | undefined;
  try {
    assert.equal(
      (await s.lab.request(s.path + '/initialize', s.token, 'POST', payload, key)).status,
      201,
    );
    await s.lab.close();
    for (let iteration = 0; iteration < 2; iteration++) {
      child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/posttrade-local.ts',
          'serve',
          process.env['TF_DB_OWNER_FILE']!,
          '0',
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, TRADEFLOW_MODE: 'hosted-demo', TRADEFLOW_HOST: '0.0.0.0' },
        },
      );
      const running = child,
        exited = once(running, 'exit');
      let diagnostic = '',
        buffer = '';
      running.stderr?.on('data', (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-2000);
      });
      const origin = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Owned local ready deadline: ' + diagnostic)),
          10000,
        );
        running.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('Owned local process exited before readiness: ' + diagnostic));
        });
        running.stdout?.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          if (buffer.length > 4096) {
            clearTimeout(timer);
            reject(new Error('Unexpected local CLI output bound.'));
            return;
          }
          const match = /^OWNED_POSTTRADE_READY (http:\/\/127\.0\.0\.1:[0-9]+)$/m.exec(buffer);
          if (match) {
            clearTimeout(timer);
            resolve(match[1]!);
          }
        });
      });
      async function request(
        path: string,
        token?: string,
        method = 'GET',
        body?: unknown,
        commandKey?: string,
      ) {
        return fetch(origin + path, {
          method,
          headers: {
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(commandKey ? { 'Idempotency-Key': commandKey } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      }
      const login = await request('/api/session', undefined, 'POST', {
        username: 'qa.user',
        password: 'Password123!',
      });
      assert.equal(login.status, 200);
      const token = ((await login.json()) as { token: string }).token;
      assert.equal(
        (
          await request('/api/fixed-income/v1/sandboxes/recover', token, 'POST', {
            sandbox_id: s.keys.sandbox_id,
            scope: 'trade',
            capability: s.keys.trade_capability,
          })
        ).status,
        200,
      );
      assert.equal((await request(s.path + '/commands/' + key, token)).status, 200);
      const replay = await request(s.path + '/initialize', token, 'POST', payload, key);
      assert.equal(replay.status, 201);
      assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
      const source = await request(s.path, token);
      assert.equal(source.status, 200);
      assert.equal(
        ((await source.json()) as { posttrade_command_seq: string }).posttrade_command_seq,
        '1',
      );
      running.kill('SIGTERM');
      const [code] = z
        .tuple([z.number().int().nullable(), z.string().nullable()])
        .parse(await exited);
      assert.equal(code, 0);
      child = undefined;
      if (iteration === 0) {
        await stopOwnedPostgres(process.env['TF_DB_OWNER_FILE']!, false);
        await restartOwnedPostgres(process.env['TF_DB_OWNER_FILE']!);
      }
    }
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    await s.close();
  }
});
