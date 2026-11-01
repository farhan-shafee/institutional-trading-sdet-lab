import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  metadataSchema,
  verificationNames,
  type VerificationMetadata,
} from '../../domain/workflow/reconciliation.js';
import { migrationChecksums, financialSource } from '../../domain/workflow/database-contract.js';
export const verificationSources = {
  foundation: {
    file: 'foundation.sql',
    hash: '25744f24ab04d19c9ebc8afa3510d5cc78d853fce234ee710067e0f10be1e745',
  },
  rfq: {
    file: 'rfq.sql',
    hash: '7dc1499dcc8173996df9efe0b22daf92aa06bdf82cd8513c4a61115a141b11e3',
  },
  executions: {
    file: 'executions.sql',
    hash: 'b5f6308e13d3d9ca47e147b202c51691eed47329ff6878c06cfa21b2b6f9caca',
  },
  comparisons: {
    file: 'reconciliation.sql',
    hash: '296b390b28639d4857dcaf5796de736f05f91a1eb48c4ad4cd883cad70277b1e',
  },
} as const;
const execute = promisify(execFile);
export async function verificationQueries() {
  const queries = {} as Record<(typeof verificationNames)[number], string>;
  for (const name of verificationNames) {
    const source = verificationSources[name],
      sql = await readFile(resolve('verification/sql', source.file), 'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== source.hash)
      throw new Error('Reviewed verification source mismatch.');
    queries[name] = sql.trim().replace(/;$/, '');
  }
  return queries;
}
export async function verificationManifest(): Promise<VerificationMetadata> {
  await verificationQueries();
  const git = async (args: string[]) =>
    (await execute('git', args, { timeout: 1000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const [revision, tree, status] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['rev-parse', 'HEAD^{tree}']),
    git(['status', '--porcelain', '--untracked-files=all']),
  ]);
  return metadataSchema.parse({
    engine_version: 'reconciliation-v2',
    source_revision: revision,
    source_tree: tree,
    source_state: status ? 'DIRTY' : 'CLEAN',
    schema_revision: 6,
    financial_source: financialSource,
    valuation_model: 'phase1-regular-coupon-v1',
    quotation_model: 'synthetic-dealer-grid-v1',
    conventions: ['ACT_ACT_ICMA', 'THIRTY_360_US'],
    query_hashes: Object.fromEntries(
      verificationNames.map((n) => [n, verificationSources[n].hash]),
    ),
    schema_checksums: migrationChecksums,
  });
}
