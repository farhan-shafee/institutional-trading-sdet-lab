import { createHash } from 'node:crypto';
import {
  orderCommandResultSchema,
  orderDetailSchema,
  orderListSchema,
  positionsSchema,
} from '../../domain/workflow/execution.js';
import { workflowResultSchema } from '../../domain/workflow/contracts.js';
import type { WorkflowDatabase } from '../../persistence/postgres/workflow.js';
import type { Binding } from './bindings.js';
export class OrderService {
  constructor(readonly database: WorkflowDatabase) {}
  async command(
    binding: Binding,
    action: string,
    payload: unknown,
    key: string,
    actor: string,
    verify: () => void,
  ) {
    const hash = createHash('sha256')
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
    return this.database.transaction(false, verify, async (db) => {
      const r = await db.query<{ result: unknown }>(
        'SELECT fi_control.order_command($1,$2,$3,$4,$5,$6,$7,$8) AS result',
        [
          binding.sandboxId,
          binding.digest,
          binding.generation,
          action,
          JSON.stringify(payload),
          hash,
          key,
          actor,
        ],
      );
      const result = workflowResultSchema.parse(r.rows[0]?.result);
      if (result.status === 200 || result.status === 201)
        result.body = orderCommandResultSchema.parse(result.body);
      return result;
    });
  }
  async read(
    binding: Binding,
    kind: 'orders' | 'positions',
    order: string | undefined,
    verify: () => void,
  ) {
    return this.database.transaction(true, verify, async (db) => {
      const r = await db.query<{ result: unknown }>(
        kind === 'positions'
          ? 'SELECT fi_control.read_positions($1,$2,$3,$4) AS result'
          : 'SELECT fi_control.read_orders($1,$2,$3,$4,$5) AS result',
        [
          binding.sandboxId,
          binding.digest,
          binding.scope,
          binding.generation,
          ...(kind === 'orders' ? [order ?? null] : []),
        ],
      );
      const result = workflowResultSchema.parse(r.rows[0]?.result);
      if (result.status === 200)
        result.body = (
          kind === 'positions' ? positionsSchema : order ? orderDetailSchema : orderListSchema
        ).parse(result.body);
      return result;
    });
  }
}
