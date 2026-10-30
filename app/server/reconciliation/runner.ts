import { randomUUID } from 'node:crypto';
import { DomainError } from '../../domain/errors.js';
import { workflowResultSchema } from '../../domain/workflow/contracts.js';
import {
  reconciliationRunSchema,
  type VerificationMetadata,
} from '../../domain/workflow/reconciliation.js';
import type { Binding } from '../fixed-income-workflow/bindings.js';
import { VerificationDatabase, type VerificationHooks } from './database.js';
import { scanSnapshot, type ScanHooks } from './scanner.js';
export type RunnerHooks = ScanHooks & {
  beforeResultCommit?: VerificationHooks['beforeCommit'];
  afterResultCommit?: VerificationHooks['afterCommit'];
  afterScan?: () => void | Promise<void>;
};
export class ReconciliationRunner {
  readonly database: VerificationDatabase;
  constructor(
    url: string,
    private readonly hooks: RunnerHooks = {},
  ) {
    this.database = new VerificationDatabase(url);
  }
  close() {
    return this.database.close();
  }
  async execute(binding: Binding, run: string, metadata: VerificationMetadata, verify: () => void) {
    const worker = randomUUID();
    const claim = await this.database.transaction(false, verify, async (c) =>
      workflowResultSchema.parse(
        (
          await c.query<{ result: unknown }>(
            'SELECT fi_control.claim_reconciliation($1,$2,$3,$4,$5,$6) AS result',
            [
              binding.sandboxId,
              binding.digest,
              binding.generation,
              run,
              worker,
              JSON.stringify(metadata),
            ],
          )
        ).rows[0]?.result,
      ),
    );
    if (claim.status === 409) return;
    if (claim.status !== 200)
      throw new DomainError(
        claim.status,
        'RECONCILIATION_UNAVAILABLE',
        'Reconciliation authorization or state changed.',
      );
    const owned = reconciliationRunSchema.parse(claim.body);
    if (owned.state !== 'RUNNING') return;
    const report = await scanSnapshot(
      this.database,
      binding,
      run,
      worker,
      metadata,
      verify,
      this.hooks,
    );
    await this.hooks.afterScan?.();
    const result = await this.database.transaction(
      false,
      verify,
      async (c) =>
        workflowResultSchema.parse(
          (
            await c.query<{ result: unknown }>(
              'SELECT fi_control.finish_reconciliation($1,$2,$3,$4,$5,$6) AS result',
              [
                binding.sandboxId,
                binding.digest,
                binding.generation,
                run,
                worker,
                JSON.stringify(report),
              ],
            )
          ).rows[0]?.result,
        ),
      {
        ...(this.hooks.beforeResultCommit ? { beforeCommit: this.hooks.beforeResultCommit } : {}),
        ...(this.hooks.afterResultCommit ? { afterCommit: this.hooks.afterResultCommit } : {}),
      },
    );
    if (result.status !== 200)
      throw new DomainError(
        result.status,
        'RECONCILIATION_UNAVAILABLE',
        'Reconciliation result was not accepted.',
      );
    return reconciliationRunSchema.parse(result.body);
  }
}
