/** Owned test worker; actual process death at the database transaction hooks. */
import { z } from 'zod';
import { loadPrivate } from '../../scripts/private-state.js';
import { verifyOwned } from '../../scripts/owned-postgres.js';
import { PostTradeWorkflowDatabase } from '../../app/persistence/postgres/post-trade-workflow.js';
import { PostTradeService } from '../../app/server/post-trade/service.js';
const schema = z
  .object({
    owner_file: z.string().min(1).max(4096),
    sandbox_id: z.uuid(),
    proof: z.string().regex(/^[a-f0-9]{64}$/),
    actor: z.uuid(),
    execution_id: z.uuid(),
    key: z.uuid(),
    point: z.enum(['before', 'after']),
  })
  .strict();
let database: PostTradeWorkflowDatabase | undefined;
try {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length || !process.send)
    throw new Error('Private owned IPC worker context required.');
  const context = schema.parse(await loadPrivate(path)),
    owner = await verifyOwned(context.owner_file);
  if (!owner.appUrl) throw new Error('Owned app target required.');
  const checkpoint = async () => {
    process.send!({ kind: 'CHECKPOINT', point: context.point, key: context.key });
    await new Promise<void>(() => undefined);
  };
  database = new PostTradeWorkflowDatabase(
    owner.appUrl,
    context.point === 'before' ? { beforeCommit: checkpoint } : { afterCommit: checkpoint },
  );
  const service = new PostTradeService(database);
  await service.command(
    { sandboxId: context.sandbox_id, digest: context.proof, scope: 'trade', generation: '1' },
    'SETTLE',
    { execution_id: context.execution_id, expected_revision: 0, processing_date: '2030-01-15' },
    context.key,
    context.actor,
    () => {},
  );
  throw new Error('Controlled transaction hook was not reached.');
} catch {
  console.error('Owned post-trade crash worker did not reach its controlled checkpoint.');
  process.exitCode = 1;
} finally {
  await database?.close();
}
