import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import { keySchema, parseWorkflow } from '../../domain/workflow/contracts.js';
import {
  createRfqSchema,
  dealerResponseSchema,
  quoteCommandSchema,
} from '../../domain/workflow/rfq.js';
import type { WorkflowBindings } from './bindings.js';
import type { WorkflowContext } from './routes.js';
import type { RfqService } from './rfq-service.js';

export async function handleRfq(
  context: WorkflowContext,
  bindings: WorkflowBindings,
  service: RfqService,
): Promise<boolean> {
  const match = context.url.pathname.match(
    /^\/api\/fixed-income\/v1\/sandboxes\/([^/]+)\/rfqs(?:\/([^/]+)(?:\/(dealer-responses|withdraw|accept))?)?$/,
  );
  if (!match) return false;
  const method = context.request.method;
  const action = match[3];
  if (!((method === 'GET' && !action) || (method === 'POST' && (!match[2] || action))))
    return false;
  bindings.admitRequest();
  if (context.url.search)
    throw new DomainError(400, 'VALIDATION_ERROR', 'RFQ operations take no query parameters.');
  const id = parseWorkflow(z.uuid(), match[1]).toLowerCase();
  const rfq = match[2] ? parseWorkflow(z.uuid(), match[2]).toLowerCase() : undefined;
  const actor = bindings.context(context.token).actorId;
  const binding = bindings.binding(context.token, id, method === 'POST');
  const verify = () => {
    if (context.authenticate().role !== 'trader' && method === 'POST')
      throw new DomainError(403, 'FORBIDDEN', 'Viewer sessions cannot change RFQs.');
    bindings.verify(context.token, actor, binding);
  };
  verify();
  let result;
  if (method === 'POST') {
    context.admitLegacyMutation();
    bindings.admitMutation(context.token);
    const key = parseWorkflow(keySchema, context.request.headers['idempotency-key']);
    const raw = await context.readJson();
    verify();
    const payload = !rfq
      ? parseWorkflow(createRfqSchema, raw)
      : {
          rfq_id: rfq,
          ...(action === 'dealer-responses'
            ? parseWorkflow(dealerResponseSchema, raw)
            : parseWorkflow(quoteCommandSchema, raw)),
        };
    const operation = !rfq
      ? 'CREATE_RFQ'
      : action === 'dealer-responses'
        ? 'RESPOND_DEALER'
        : action === 'withdraw'
          ? 'WITHDRAW_QUOTE'
          : 'ACCEPT_QUOTE';
    result = await service.command(binding, operation, payload, key, actor, verify);
  } else result = await service.read(binding, rfq, verify);
  verify();
  if (result.replayed) context.response.setHeader('Idempotency-Replayed', 'true');
  if (result.status === 201 && !rfq) {
    const body = rfqDetailLocation(result.body);
    context.response.setHeader('Location', `/api/fixed-income/v1/sandboxes/${id}/rfqs/${body}`);
  }
  if (result.status === 429 || result.status === 503)
    context.response.setHeader('Retry-After', '1');
  context.respond(result.status, result.body);
  return true;
}
function rfqDetailLocation(body: unknown): string {
  return z.object({ rfq: z.object({ id: z.uuid() }) }).parse(body).rfq.id;
}
