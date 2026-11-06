import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { owner, roleTarget, imageMode } from './database.js';
import { postgresTlsProxy } from './tls-fixture.js';

await test('real PostgreSQL transport accepts the trusted name and rejects wrong CA, wrong hostname and plaintext before SQL', async () => {
  const owned = await owner();
  const proxy = imageMode ? undefined : await postgresTlsProxy(owned.appUrl!);
  try {
    const target = imageMode ? await roleTarget('app') : proxy!.target(owned.appUrl!);
    const client = new pg.Client({ ...target, connectionTimeoutMillis: 2000 });
    await client.connect();
    assert.equal(
      (await client.query<{ role: string }>('SELECT current_user AS role')).rows[0]!.role,
      'tf_app',
    );
    await client.end();
    if (proxy) assert.equal(proxy.stats.backendStarts, 1);
    const ca = await readFile(
      new URL('../../test-data/public-demo/test-ca.pem', import.meta.url),
      'utf8',
    );
    for (const [ssl, code] of [
      [
        { ...(target.ssl as object), servername: 'wrong-name.railway.internal' },
        'ERR_TLS_CERT_ALTNAME_INVALID',
      ],
      [{ ...(target.ssl as object), ca }, 'SELF_SIGNED_CERT_IN_CHAIN'],
    ] as const) {
      const rejected = new pg.Client({ ...target, ssl, connectionTimeoutMillis: 2000 });
      try {
        await assert.rejects(
          rejected.connect(),
          (error: unknown) =>
            error instanceof Error &&
            'code' in error &&
            (error.code === code ||
              (code === 'SELF_SIGNED_CERT_IN_CHAIN' &&
                error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')),
        );
      } finally {
        await rejected.end();
      }
      if (proxy) assert.equal(proxy.stats.backendStarts, 1);
    }
    const plaintext = new pg.Client({ ...target, ssl: false, connectionTimeoutMillis: 2000 });
    try {
      await assert.rejects(
        plaintext.connect(),
        imageMode ? /pg_hba|no encryption/ : /Connection terminated/,
      );
    } finally {
      await plaintext.end();
    }
    if (proxy) assert.equal(proxy.stats.backendStarts, 1);
  } finally {
    await proxy?.close();
  }
});
