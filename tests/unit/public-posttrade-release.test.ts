import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  preparePublicRelease,
  bindPublicReleaseCa,
} from '../../scripts/public-demo-release-config.js';

await test('post-trade release sealing requires a CA-bound original journal, explicit profile and unchanged credentials', async () => {
  const api = await import('../../scripts/public-posttrade-release-config.js');
  const directory = await mkdtemp(join(tmpdir(), 'tradeflow-posttrade-release-'));
  try {
    const prepared = join(directory, 'prepared.json'),
      bound = join(directory, 'bound.json'),
      sealed = join(directory, 'sealed.json');
    await preparePublicRelease(prepared, {
      hostname: 'posttrade-db.railway.internal',
      sourceSha: '1'.repeat(40),
      sourceTree: '2'.repeat(40),
    });
    await assert.rejects(api.sealPublicPostTradeRelease(prepared, sealed));
    await assert.rejects(stat(sealed), { code: 'ENOENT' });
    await bindPublicReleaseCa(
      prepared,
      await readFile(new URL('../../test-data/public-demo/test-ca.pem', import.meta.url), 'utf8'),
      bound,
    );
    const original = await readFile(bound, 'utf8');
    await api.sealPublicPostTradeRelease(bound, sealed);
    const data = api.publicPostTradeReleaseSchema.parse(JSON.parse(await readFile(sealed, 'utf8')));
    assert.equal(data.applicationEnvironment.TRADEFLOW_PUBLIC_POSTTRADE, 'on');
    assert.deepEqual(data.applicationEnvironment, {
      ...data.release.applicationEnvironment,
      TRADEFLOW_PUBLIC_POSTTRADE: 'on',
    });
    assert.equal(data.databaseImageDirectory, 'deployment/posttrade-postgres');
    assert.equal((await stat(sealed)).mode & 0o777, 0o600);
    assert.equal(await readFile(bound, 'utf8'), original);
    for (const changed of [
      { ...data, profile: 'public-workflow-v1' },
      { ...data, profileChecksum: '0'.repeat(64) },
      { ...data, databaseImageDirectory: 'deployment/demo-postgres' },
      {
        ...data,
        applicationEnvironment: {
          ...data.applicationEnvironment,
          TRADEFLOW_PUBLIC_POSTTRADE: 'off',
        },
      },
      {
        ...data,
        applicationEnvironment: {
          ...data.applicationEnvironment,
          TRADEFLOW_PUBLIC_DEMO_DATABASE_URL: 'postgresql://foreign',
        },
      },
    ])
      assert.equal(api.publicPostTradeReleaseSchema.safeParse(changed).success, false);
    const bytes = await readFile(sealed, 'utf8');
    await assert.rejects(api.sealPublicPostTradeRelease(bound, sealed));
    assert.equal(await readFile(sealed, 'utf8'), bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
