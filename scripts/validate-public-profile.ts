import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicProfileChecksum } from '../app/server/public-demo/profile.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export async function validatePublicProfileSources(root = repositoryRoot): Promise<void> {
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    digest(await readFile(resolve(root, 'db/public-demo/001_profile.sql'))),
    publicProfileChecksum,
    'Public profile SQL must match its reviewed runtime checksum.',
  );
  const migrations = (await readdir(resolve(root, 'db/migrations')))
    .filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name))
    .sort()
    .map((name) => 'db/migrations/' + name);
  const paths = [...migrations, 'db/public-demo/001_profile.sql', 'db/public-demo/roles.sql'];
  const lines = (await readFile(resolve(root, 'deployment/postgres/SHA256SUMS'), 'utf8'))
    .trim()
    .split('\n');
  assert.equal(
    lines.length,
    paths.length,
    'Database image manifest must cover every reviewed source exactly once.',
  );
  for (const [index, path] of paths.entries()) {
    assert.equal(
      lines[index],
      digest(await readFile(resolve(root, path))) + '  ' + path,
      'Database image source/checksum drift.',
    );
  }
}
