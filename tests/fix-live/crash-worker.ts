/** Fault barriers around real commits. SIGKILL comes from the owning test parent. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readOwner } from '../../scripts/workflow-database.js';
import { LiveWorkflowDatabase } from '../../app/persistence/postgres/live-workflow.js';
import { LiveFixApplicationService } from '../../app/server/fix/live-application.js';
import { LiveFixController } from '../../app/server/fix/live-controller.js';
import { LiveJournal } from '../../app/server/fix/live-journal.js';
import { runtime, body } from './runtime-fixture.js';

const context = z
  .object({
    owner_file: z.string(),
    sandbox_id: z.uuid(),
    proof: z.string(),
    actor: z.uuid(),
    order: z.uuid(),
    channel: z.uuid(),
    lane_owner: z.uuid(),
    point: z.enum([
      'send-before-write',
      'observe-before-retain',
      'observe-before',
      'observe-after',
      'callback-before-retain',
      'accept-after',
      'apply-before',
      'apply-after',
    ]),
    fields: z.record(z.string(), z.string()),
    runtime: z
      .object({
        run_id: z.uuid(),
        session_id: z.uuid(),
        store_id: z.uuid(),
        connection_id: z.uuid(),
        runtime_hash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict()
  .parse(JSON.parse(await readFile(process.argv[2]!, 'utf8')));
const cfg = await readOwner(context.owner_file);
let target = false,
  action = '',
  currentKey = '';
function checkpoint(point: string, key: string): Promise<never> {
  process.send?.({ kind: 'CHECKPOINT', point, key });
  return new Promise<never>(() => {});
}
const db = new LiveWorkflowDatabase(cfg.appUrl!, {
  beforeCommit: async () => {
    if (target && context.point === action.toLowerCase() + '-before')
      await checkpoint(context.point, currentKey);
  },
  afterCommit: async () => {
    if (target && context.point === action.toLowerCase() + '-after')
      await checkpoint(context.point, currentKey);
  },
});
class Service extends LiveFixApplicationService {
  override async command(...args: Parameters<LiveFixApplicationService['command']>) {
    action = args[2];
    currentKey = args[4];
    return super.command(...args);
  }
  override async apply(...args: Parameters<LiveFixApplicationService['apply']>) {
    action = 'APPLY';
    currentKey = args[3];
    return super.apply(...args);
  }
}
const engine = await runtime(context.runtime);
const directory = join(process.cwd(), '.local', 'fix-live', context.runtime.run_id);
const identity = {
  run_id: context.runtime.run_id,
  session_id: context.runtime.session_id,
  store_id: context.runtime.store_id,
  runtime_hash: context.runtime.runtime_hash,
};
const journal = await LiveJournal.open(directory, identity);
const retain = journal.retain.bind(journal);
journal.retain = async (kind, key, value) => {
  if (target && context.point === 'send-before-write' && kind === 'send') {
    await retain(kind, key, value);
    await checkpoint(context.point, key);
  }
  if (
    target &&
    kind === 'request' &&
    typeof value === 'object' &&
    value !== null &&
    'action' in value &&
    ((context.point === 'callback-before-retain' && value.action === 'ACCEPT') ||
      (context.point === 'observe-before-retain' && value.action === 'OBSERVE'))
  )
    await checkpoint(context.point, key);
  return retain(kind, key, value);
};
const binding = {
  sandboxId: context.sandbox_id,
  digest: context.proof,
  scope: 'trade' as const,
  generation: '1',
};
const controller = new LiveFixController({
  service: new Service(db, true),
  journal,
  process: engine.child,
  runtime: context.runtime,
  enabled: true,
  contexts: [
    {
      binding,
      actor_id: context.actor,
      order_id: context.order,
      channel_id: context.channel,
      owner_id: context.lane_owner,
      verify: () => {},
    },
  ],
});
try {
  await controller.start();
  const order = body({ ...context.fields, '35': 'D', '21': '1' });
  for (const tag of ['37', '17', '150', '39', '14', '151', '6']) delete order[tag];
  await controller.send(context.order, order);
  await controller.send(context.order, body(context.fields));
  target = true;
  await controller.send(
    context.order,
    body({
      ...context.fields,
      '17': 'ATLAS-' + context.lane_owner.toUpperCase(),
      '150': 'F',
      '39': '2',
      '32': '100.00',
      '31': context.fields['44']!,
      '6': context.fields['44']!,
      '14': '100.00',
      '151': '0.00',
    }),
  );
  throw new Error('The requested crash barrier was not reached.');
} finally {
  await controller.stop().catch(() => undefined);
  await journal.close();
  await db.close();
  await engine.remove();
}
