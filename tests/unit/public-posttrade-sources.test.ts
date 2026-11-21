import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { validatePublicPostTradeProfileSources } from '../../scripts/validate-public-posttrade-profile.js';

await test('public post-trade image rejects financial migration drift even with a matching image manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tradeflow-posttrade-image-'));
  const manifest = 'deployment/posttrade-postgres/SHA256SUMS';
  try {
    const lines = (await readFile(manifest, 'utf8')).trim().split('\n');
    for (const path of [...lines.map((line) => line.split('  ')[1]!), manifest]) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await copyFile(path, join(directory, path));
    }
    await validatePublicPostTradeProfileSources(directory);
    const migration = 'db/live-migrations/009_fix_live_ingress.sql';
    const bytes = (await readFile(join(directory, migration), 'utf8')) + '\n-- unreviewed drift\n';
    await writeFile(join(directory, migration), bytes);
    const replacement = createHash('sha256').update(bytes).digest('hex') + '  ' + migration;
    await writeFile(
      join(directory, manifest),
      lines.map((line) => (line.endsWith('  ' + migration) ? replacement : line)).join('\n') + '\n',
    );
    await assert.rejects(validatePublicPostTradeProfileSources(directory), /financial migration/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
