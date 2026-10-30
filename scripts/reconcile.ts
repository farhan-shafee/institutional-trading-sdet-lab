import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { readOwner } from './workflow-database.js';
import { loadPrivate, savePrivate } from './private-state.js';
import { journalSchema } from './sandbox-client.js';
import { readConfiguration } from '../app/server/configuration.js';
import { WorkflowDatabase } from '../app/persistence/postgres/workflow.js';
import { WorkflowService } from '../app/server/fixed-income-workflow/service.js';
import { ReconciliationService } from '../app/server/reconciliation/service.js';
import { reconciliationDetailSchema } from '../app/domain/workflow/reconciliation.js';
const operationSchema = z
  .object({
    version: z.literal(1),
    operation: z.enum(['create', 'recover']),
    sandbox_id: z.uuid(),
    run_id: z.uuid(),
    key: z.uuid(),
    actor: z.uuid(),
  })
  .strict();
/** Native local runner. Private files are never printed and no HTTP/browser session is involved. */
export async function reconcile(
  ownerPath: string,
  ownershipPath: string,
  operationPath: string,
  operation: 'create' | 'recover' = 'create',
  recoveryRun?: string,
) {
  const owner = await readOwner(ownerPath),
    ownership = journalSchema.parse(await loadPrivate(ownershipPath));
  const config = readConfiguration({
    TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
    TRADEFLOW_FIXED_INCOME_DATABASE_URL: owner.appUrl!,
    TRADEFLOW_FIXED_INCOME_RECONCILER_URL: owner.reconcilerUrl!,
  });
  if (!config.workflow?.reconcilerUrl)
    throw new Error('Owned reconciliation configuration unavailable.');
  let saved: z.infer<typeof operationSchema> | undefined;
  try {
    await lstat(operationPath);
    saved = operationSchema.parse(await loadPrivate(operationPath));
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  if (!saved) {
    saved = {
      version: 1,
      operation,
      sandbox_id: ownership.sandbox_id,
      run_id: operation === 'recover' ? z.uuid().parse(recoveryRun) : randomUUID(),
      key: randomUUID(),
      actor: randomUUID(),
    };
    await savePrivate(operationPath, saved);
  }
  if (
    saved.sandbox_id !== ownership.sandbox_id ||
    saved.operation !== operation ||
    (recoveryRun && saved.run_id !== recoveryRun)
  )
    throw new Error('Retained operation mismatch.');
  const database = new WorkflowDatabase(config.workflow.databaseUrl),
    service = new ReconciliationService(database, config.workflow.reconcilerUrl);
  try {
    const { binding } = await new WorkflowService(database).recover(
      ownership.sandbox_id,
      'trade',
      ownership.trade_capability,
      () => undefined,
    );
    if (!binding) throw new Error('Current ownership journal required.');
    const result = await service.command(
      binding,
      operation === 'create' ? 'CREATE_RECONCILIATION' : 'RECOVER_RECONCILIATION',
      saved.run_id,
      saved.key,
      saved.actor,
      () => undefined,
    );
    if (![200, 201].includes(result.status))
      throw new Error('Retained reconciliation operation not confirmed.');
    const detail = await service.read(
      binding,
      saved.run_id,
      'detail',
      0,
      undefined,
      20,
      undefined,
      () => undefined,
    );
    if (detail.status !== 200) throw new Error('Authoritative result unavailable.');
    return {
      run_id: saved.run_id,
      replayed: result.replayed,
      result: reconciliationDetailSchema.parse(detail.body),
    };
  } finally {
    await service.close();
    await database.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [owner, ownership, journal, operation = 'create', run, ...extra] = process.argv.slice(2);
  if (
    !owner ||
    !ownership ||
    !journal ||
    !['create', 'recover'].includes(operation) ||
    extra.length
  )
    throw new Error(
      'Use OWNER_FILE OWNERSHIP_JOURNAL OPERATION_JOURNAL [create|recover [RUN_ID]].',
    );
  void reconcile(owner, ownership, journal, operation as 'create' | 'recover', run)
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        'Reconciliation not confirmed. Retain and retry the same private operation journal; sensitive details omitted.',
      );
      process.exitCode = 1;
    });
}
