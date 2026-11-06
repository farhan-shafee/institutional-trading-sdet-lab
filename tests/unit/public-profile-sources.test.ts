import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { validatePublicProfileSources } from '../../scripts/validate-public-profile.js';

await test('public source validation rejects changed SQL before it can initialize a database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tradeflow-profile-integrity-'));
  try {
    const paths = [
      ...(await readdir('db/migrations')).map((name) => 'db/migrations/' + name),
      'db/public-demo/001_profile.sql',
      'db/public-demo/roles.sql',
      'deployment/postgres/SHA256SUMS',
    ];
    for (const path of paths) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await copyFile(path, join(directory, path));
    }
    await validatePublicProfileSources(directory);
    await writeFile(
      join(directory, 'db/public-demo/001_profile.sql'),
      (await readFile(join(directory, 'db/public-demo/001_profile.sql'), 'utf8')) +
        '\n-- unexpected source drift\n',
    );
    await assert.rejects(validatePublicProfileSources(directory), /reviewed runtime checksum/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test('public deployment manifest validation rejects omission of a source even when the remaining hashes match', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tradeflow-image-manifest-'));
  try {
    const paths = [
      ...(await readdir('db/migrations')).map((name) => 'db/migrations/' + name),
      'db/public-demo/001_profile.sql',
      'db/public-demo/roles.sql',
      'deployment/postgres/SHA256SUMS',
    ];
    for (const path of paths) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await copyFile(path, join(directory, path));
    }
    const manifest = join(directory, 'deployment/postgres/SHA256SUMS');
    await writeFile(
      manifest,
      (await readFile(manifest, 'utf8')).trim().split('\n').slice(1).join('\n') + '\n',
    );
    await assert.rejects(validatePublicProfileSources(directory), /every reviewed source/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
