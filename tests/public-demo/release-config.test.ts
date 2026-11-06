import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readConfiguration } from '../../app/server/configuration.js';

const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
await test('release preparation retains five distinct private credentials before any deployment and never replaces an existing journal', async () => {
  await assert.doesNotReject(() => import('../../scripts/public-demo-release-config.js'));
  const api = await import('../../scripts/public-demo-release-config.js');
  const directory = await mkdtemp(join(tmpdir(), 'tradeflow-private-release-'));
  try {
    const target = join(directory, 'prepared.json');
    await api.preparePublicRelease(target, {
      hostname: 'public-postgres.railway.internal',
      sourceSha: '1'.repeat(40),
      sourceTree: '2'.repeat(40),
    });
    const text = await readFile(target, 'utf8');
    const data = api.releaseConfigurationSchema.parse(JSON.parse(text));
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal(data.phase, 'PREPARED');
    assert.equal(
      new Set(
        [
          'POSTGRES_PASSWORD',
          'TF_APP_PASSWORD',
          'TF_MIGRATOR_PASSWORD',
          'TF_RECONCILER_PASSWORD',
          'TF_MAINTENANCE_PASSWORD',
        ].map((key) => data.databaseEnvironment[key]),
      ).size,
      5,
    );
    assert.equal(data.applicationEnvironment.TRADEFLOW_PUBLIC_DEMO, 'on');
    assert.throws(() => readConfiguration(data.applicationEnvironment));
    await assert.rejects(
      api.preparePublicRelease(target, {
        hostname: 'public-postgres.railway.internal',
        sourceSha: '1'.repeat(40),
        sourceTree: '2'.repeat(40),
      }),
    );
    assert.equal(fingerprint(await readFile(target, 'utf8')), fingerprint(text));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test('binding the public CA creates a new release journal while preserving private preparation and rejecting private keys', async () => {
  await assert.doesNotReject(() => import('../../scripts/public-demo-release-config.js'));
  const api = await import('../../scripts/public-demo-release-config.js');
  const directory = await mkdtemp(join(tmpdir(), 'tradeflow-private-ca-binding-'));
  try {
    const prepared = join(directory, 'prepared.json'),
      bound = join(directory, 'bound.json');
    await api.preparePublicRelease(prepared, {
      hostname: 'public-postgres.railway.internal',
      sourceSha: '1'.repeat(40),
      sourceTree: '2'.repeat(40),
    });
    const original = fingerprint(await readFile(prepared, 'utf8'));
    const ca = await readFile(
      new URL('../../test-data/public-demo/test-ca.pem', import.meta.url),
      'utf8',
    );
    await api.bindPublicReleaseCa(prepared, ca, bound);
    const data = api.releaseConfigurationSchema.parse(JSON.parse(await readFile(bound, 'utf8')));
    assert.equal(data.phase, 'CA_SUPPLIED');
    assert.equal(readConfiguration(data.applicationEnvironment).mode, 'hosted-demo');
    assert.equal(fingerprint(await readFile(prepared, 'utf8')), original);
    await assert.rejects(
      api.bindPublicReleaseCa(
        prepared,
        ca + '\n-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n',
        join(directory, 'invalid.json'),
      ),
    );
    await assert.rejects(stat(join(directory, 'invalid.json')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
