import { createHash } from 'node:crypto';
import { DomainError } from '../../domain/errors.js';
import { workflowResultSchema } from '../../domain/workflow/contracts.js';
import {
  reconciliationReferenceSchema,
  reconciliationListSchema,
  reconciliationDetailSchema,
  reconciliationFindingsSchema,
  reconciliationReceiptSchema,
  type VerificationMetadata,
} from '../../domain/workflow/reconciliation.js';
import type { WorkflowDatabase } from '../../persistence/postgres/workflow.js';
import type { Binding } from '../fixed-income-workflow/bindings.js';
import { verificationManifest } from './manifest.js';
import { ReconciliationRunner, type RunnerHooks } from './runner.js';
export class ReconciliationService {
  readonly runner: ReconciliationRunner | undefined;
  private readonly metadata: Promise<VerificationMetadata | undefined>;
  constructor(
    readonly database: WorkflowDatabase,
    url?: string,
    hooks?: RunnerHooks,
  ) {
    this.runner = url ? new ReconciliationRunner(url, hooks) : undefined;
    this.metadata = url
      ? verificationManifest().catch(() => undefined)
      : Promise.resolve(undefined);
  }
  async close() {
    await this.runner?.close();
  }
  async command(
    binding: Binding,
    action: 'CREATE_RECONCILIATION' | 'RECOVER_RECONCILIATION',
    run: string,
    key: string,
    actor: string,
    verify: () => void,
  ) {
    const payload = { run_id: run },
      hash = createHash('sha256')
        .update(
          JSON.stringify({
            version: 1,
            method: 'POST',
            operation: action,
            sandbox_id: binding.sandboxId,
            payload,
          }),
        )
        .digest('hex');
    const rpc = (metadata: VerificationMetadata | Record<string, never> | null) =>
      this.database.transaction(false, verify, async (c) => {
        const r = workflowResultSchema.parse(
          (
            await c.query<{ result: unknown }>(
              'SELECT fi_control.reconciliation_command($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
              [
                binding.sandboxId,
                binding.digest,
                binding.generation,
                action,
                JSON.stringify(payload),
                hash,
                key,
                actor,
                metadata === null ? null : JSON.stringify(metadata),
              ],
            )
          ).rows[0]?.result,
        );
        if (r.status === 200 || r.status === 201)
          r.body = reconciliationReferenceSchema.parse(r.body);
        return r;
      });
    if (action === 'RECOVER_RECONCILIATION') return rpc({});
    // Resolve immutable receipts before requiring a configured or available scanner.
    const replay = await rpc(null);
    if (replay.status !== 503) return replay;
    if (action === 'CREATE_RECONCILIATION' && !this.runner)
      throw new DomainError(
        503,
        'RECONCILER_NOT_CONFIGURED',
        'Read-only reconciliation credentials are not configured.',
      );
    const metadata = action === 'CREATE_RECONCILIATION' ? await this.metadata : {};
    if (metadata === undefined)
      throw new DomainError(
        503,
        'SOURCE_UNAVAILABLE',
        'Reviewed reconciliation source metadata is unavailable.',
      );
    if (action === 'CREATE_RECONCILIATION')
      await this.runner!.database.transaction(true, verify, () => Promise.resolve());
    const result = await rpc(metadata);
    if (action === 'CREATE_RECONCILIATION' && result.status === 201 && !result.replayed)
      await this.runner!.execute(binding, run, awaitMetadata(metadata), verify);
    return result;
  }
  async receipt(binding: Binding, key: string, verify: () => void) {
    return this.database.transaction(true, verify, async (c) => {
      const r = workflowResultSchema.parse(
        (
          await c.query<{ result: unknown }>(
            'SELECT fi_control.read_reconciliation_command($1,$2,$3,$4,$5) AS result',
            [binding.sandboxId, binding.digest, binding.scope, binding.generation, key],
          )
        ).rows[0]?.result,
      );
      if (r.status === 200) r.body = reconciliationReceiptSchema.parse(r.body);
      return r;
    });
  }

  async read(
    binding: Binding,
    run: string | undefined,
    kind: 'list' | 'detail' | 'findings',
    after: number,
    asof: number | undefined,
    limit: number,
    category: string | undefined,
    verify: () => void,
  ) {
    return this.database.transaction(true, verify, async (c) => {
      const r = workflowResultSchema.parse(
        (
          await c.query<{ result: unknown }>(
            'SELECT fi_control.read_reconciliations($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
            [
              binding.sandboxId,
              binding.digest,
              binding.scope,
              binding.generation,
              run ?? null,
              kind,
              after,
              asof ?? null,
              limit,
              category ?? null,
            ],
          )
        ).rows[0]?.result,
      );
      if (r.status === 200)
        r.body = (
          kind === 'list'
            ? reconciliationListSchema
            : kind === 'detail'
              ? reconciliationDetailSchema
              : reconciliationFindingsSchema
        ).parse(r.body);
      return r;
    });
  }
}
import { metadataSchema } from '../../domain/workflow/reconciliation.js';
const awaitMetadata = (value: unknown) => metadataSchema.parse(value);
