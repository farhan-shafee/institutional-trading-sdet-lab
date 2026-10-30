import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import { keySchema, parseWorkflow } from '../../domain/workflow/contracts.js';
import {
  orderVersionSchema,
  executionCommandSchema,
  cancelCommandSchema,
} from '../../domain/workflow/execution.js';
import type { WorkflowBindings } from './bindings.js';
import type { WorkflowContext } from './routes.js';
import type { OrderService } from './order-service.js';
export async function handleOrder(
  context: WorkflowContext,
  bindings: WorkflowBindings,
  service: OrderService,
): Promise<boolean> {
  const match = context.url.pathname.match(
    /^\/api\/fixed-income\/v1\/sandboxes\/([^/]+)\/(orders|positions)(?:\/([^/]+)(?:\/(acknowledgment|rejection|executions|cancellation-requests|cancellations\/([^/]+)\/(acknowledgment|rejection)))?)?$/,
  );
  if (!match) return false;
  const method = context.request.method,
    action = match[4],
    kind = match[2] as 'orders' | 'positions';
  if (!((method === 'GET' && !action) || (method === 'POST' && kind === 'orders' && action)))
    return false;
  if (kind === 'positions' && match[3]) return false;
  bindings.admitRequest();
  if (context.url.search)
    throw new DomainError(400, 'VALIDATION_ERROR', 'Order operations take no query parameters.');
  const id = parseWorkflow(z.uuid(), match[1]).toLowerCase(),
    order = match[3] ? parseWorkflow(z.uuid(), match[3]).toLowerCase() : undefined;
  const actor = bindings.context(context.token).actorId,
    binding = bindings.binding(context.token, id, method === 'POST');
  const verify = () => {
    if (context.authenticate().role !== 'trader' && method === 'POST')
      throw new DomainError(403, 'FORBIDDEN', 'Viewer sessions cannot simulate order events.');
    bindings.verify(context.token, actor, binding);
  };
  verify();
  let result;
  if (method === 'POST') {
    context.admitLegacyMutation();
    bindings.admitMutation(context.token);
    const key = parseWorkflow(keySchema, context.request.headers['idempotency-key']),
      raw = await context.readJson();
    verify();
    let payload: Record<string, unknown>, operation: string;
    if (match[5]) {
      payload = {
        order_id: order,
        ...parseWorkflow(orderVersionSchema, raw),
        cancel_id: parseWorkflow(z.uuid(), match[5]).toLowerCase(),
      };
      operation = match[6] === 'acknowledgment' ? 'ACK_CANCEL' : 'REJECT_CANCEL';
    } else if (action === 'executions') {
      payload = { order_id: order, ...parseWorkflow(executionCommandSchema, raw) };
      operation = 'EXECUTE_ORDER';
    } else if (action === 'cancellation-requests') {
      payload = { order_id: order, ...parseWorkflow(cancelCommandSchema, raw) };
      operation = 'REQUEST_CANCEL';
    } else {
      payload = { order_id: order, ...parseWorkflow(orderVersionSchema, raw) };
      operation = action === 'acknowledgment' ? 'ACK_ORDER' : 'REJECT_ORDER';
    }
    result = await service.command(binding, operation, payload, key, actor, verify);
  } else result = await service.read(binding, kind, order, verify);
  verify();
  if (result.replayed) context.response.setHeader('Idempotency-Replayed', 'true');
  if (result.status === 429 || result.status === 503)
    context.response.setHeader('Retry-After', '1');
  context.respond(result.status, result.body);
  return true;
}
