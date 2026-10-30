import { ReconciliationRunner } from '../../app/server/reconciliation/runner.js';
import type { VerificationMetadata } from '../../app/domain/workflow/reconciliation.js';
import type { Binding } from '../../app/server/fixed-income-workflow/bindings.js';
import { owner } from './harness.js';
process.once(
  'message',
  (data: { binding: Binding; run: string; metadata: VerificationMetadata; stage: string }) => {
    void (async () => {
      const hold = async () => {
        process.send?.({ phase: data.stage });
        await new Promise(() => {});
      };
      const runner = new ReconciliationRunner((await owner()).reconcilerUrl!, {
        ...(data.stage === 'afterScan' ? { afterScan: hold } : {}),
        ...(data.stage === 'beforeCommit' ? { beforeResultCommit: hold } : {}),
        ...(data.stage === 'afterCommit' ? { afterResultCommit: hold } : {}),
      });
      await runner.execute(data.binding, data.run, data.metadata, () => undefined);
    })().catch(() => {
      process.send?.({ phase: 'failed' });
      process.exitCode = 1;
    });
  },
);
