import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { migrationChecksums } from '../app/domain/workflow/database-contract.js';

const directory = new URL('../db/migrations/', import.meta.url);
const migrations = (await readdir(directory))
  .filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name))
  .sort();
const actual = await Promise.all(
  migrations.map(async (name) => ({
    version: Number(name.slice(0, 3)),
    checksum: createHash('sha256')
      .update(await readFile(new URL(name, directory)))
      .digest('hex'),
  })),
);
assert.deepEqual(
  actual,
  migrationChecksums,
  'Runtime database contract must bind the exact migration sources.',
);
console.log('Runtime migration checksums match reviewed SQL sources.');
