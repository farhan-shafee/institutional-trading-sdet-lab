import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicPostTradeProfileChecksum } from '../app/server/public-demo/posttrade-profile.js';
import { postTradeMigrationChecksums } from '../app/domain/post-trade/database-contract.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export async function validatePublicPostTradeProfileSources(root = repositoryRoot): Promise<void> {
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    digest(await readFile(resolve(root, 'db/public-posttrade/001_profile.sql'))),
    publicPostTradeProfileChecksum,
    'Public profile SQL must match its reviewed runtime checksum.',
  );
  const migrations = (await readdir(resolve(root, 'db/migrations')))
    .filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name))
    .sort()
    .map((name) => 'db/migrations/' + name);
  const paths = [
    ...migrations,
    'db/live-migrations/009_fix_live_ingress.sql',
    'db/posttrade-migrations/010_post_trade.sql',
    'db/public-posttrade/001_profile.sql',
    'db/public-demo/roles.sql',
  ];
  assert.deepEqual(
    await Promise.all(
      paths.slice(0, 10).map(async (path, index) => ({
        version: index + 1,
        checksum: digest(await readFile(resolve(root, path))),
      })),
    ),
    postTradeMigrationChecksums,
    'Public financial migration bytes must match the original reviewed runtime contract.',
  );
  const lines = (await readFile(resolve(root, 'deployment/posttrade-postgres/SHA256SUMS'), 'utf8'))
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
