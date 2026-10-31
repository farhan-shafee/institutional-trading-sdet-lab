import { once } from 'node:events';
import { createApplicationServer } from '../../app/server/index.js';
import type { ApplicationConfiguration } from '../../app/server/configuration.js';
import type { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';

export async function httpLab(
  configuration?: ApplicationConfiguration,
  database?: WorkflowDatabase,
  now?: () => number,
) {
  const server = createApplicationServer({
    ...(configuration ? { configuration } : {}),
    ...(database ? { workflowDatabase: database } : {}),
    ...(now ? { now } : {}),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback listener.');
  const origin = `http://127.0.0.1:${address.port}`;
  async function login(viewer = false): Promise<string> {
    const response = await fetch(`${origin}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: viewer ? 'qa.viewer' : 'qa.user',
        password: 'Password123!',
      }),
    });
    if (response.status !== 200) throw new Error('Synthetic test login failed.');
    return ((await response.json()) as { token: string }).token;
  }
  async function request(
    path: string,
    token?: string,
    method = 'GET',
    body?: unknown,
    key?: string,
  ) {
    return fetch(origin + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  return {
    server,
    origin,
    login,
    request,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
      await database?.close();
    },
  };
}
