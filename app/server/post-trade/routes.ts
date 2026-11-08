import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import { keySchema, parseWorkflow, type WorkflowResult } from '../../domain/workflow/contracts.js';
import {
  initializePostTradeSchema,
  correctPriceSchema,
  bustExecutionSchema,
  settleExecutionSchema,
  reverseSettlementSchema,
} from '../../domain/post-trade/contracts.js';
import {
  portfolioQuerySchema,
  postTradeSourceQuerySchema,
  postTradeAuditQuerySchema,
  type PostTradeOperation,
} from '../../domain/post-trade/api-contracts.js';
import type { WorkflowBindings } from '../fixed-income-workflow/bindings.js';
import type { WorkflowContext } from '../fixed-income-workflow/routes.js';
import type { PostTradeService } from './service.js';
import { readPostTradeJson } from './read-body.js';

function query(parameters: URLSearchParams): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  for (const [key, value] of parameters) {
    if (Object.hasOwn(result, key))
      throw new DomainError(400, 'VALIDATION_ERROR', 'Duplicate query field.');
    result[key] = value;
  }
  return result;
}
export async function handlePostTrade(
  context: WorkflowContext,
  bindings: WorkflowBindings,
  service: PostTradeService,
): Promise<boolean> {
  const match = context.url.pathname.match(
    /^\/api\/fixed-income\/v1\/sandboxes\/([^/]+)\/posttrade(.*)$/,
  );
  if (!match) return false;
  const tail = match[2] ?? '',
    method = context.request.method ?? 'GET';
  const root = tail.match(
    /^\/executions\/([^/]+)\/(register|corrections|busts|settlements|reversals|history)$/,
  );
  const command = tail.match(/^\/commands\/([^/]+)$/);
  const writing = method === 'POST' && (tail === '/initialize' || (root && root[2] !== 'history'));
  const reading =
    method === 'GET' &&
    (['', '/risk', '/pnl', '/audit-events'].includes(tail) || command || root?.[2] === 'history');
  if (!writing && !reading) return false;
  bindings.admitRequest();
  const id = parseWorkflow(z.uuid(), match[1]).toLowerCase(),
    actor = bindings.context(context.token).actorId;
  const binding = bindings.binding(context.token, id, Boolean(writing));
  const verify = () => {
    if (context.authenticate().role !== 'trader' && writing)
      throw new DomainError(
        403,
        'FORBIDDEN',
        'Viewer sessions cannot change owned post-trade books.',
      );
    bindings.verify(context.token, actor, binding);
  };
  verify();
  const execution = root ? parseWorkflow(z.uuid(), root[1]).toLowerCase() : undefined;
  let result: WorkflowResult;
  if (writing) {
    if (context.url.search)
      throw new DomainError(
        400,
        'VALIDATION_ERROR',
        'Post-trade writers take no query parameters.',
      );
    context.admitLegacyMutation();
    bindings.admitMutation(context.token);
    const key = parseWorkflow(keySchema, context.request.headers['idempotency-key']);
    const body = await readPostTradeJson(context.request);
    verify();
    let operation: PostTradeOperation, payload: Record<string, unknown>;
    if (tail === '/initialize') {
      operation = 'INITIALIZE';
      payload = parseWorkflow(initializePostTradeSchema, body);
    } else {
      const base = { execution_id: execution };
      switch (root![2]) {
        case 'register':
          parseWorkflow(z.object({}).strict(), body);
          operation = 'REGISTER';
          payload = base;
          break;
        case 'corrections':
          operation = 'CORRECT_PRICE';
          payload = {
            ...base,
            ...parseWorkflow(correctPriceSchema.omit({ execution_id: true }), body),
          };
          break;
        case 'busts':
          operation = 'BUST';
          payload = {
            ...base,
            ...parseWorkflow(bustExecutionSchema.omit({ execution_id: true }), body),
          };
          break;
        case 'settlements':
          operation = 'SETTLE';
          payload = {
            ...base,
            ...parseWorkflow(settleExecutionSchema.omit({ execution_id: true }), body),
          };
          break;
        case 'reversals':
          operation = 'REVERSE';
          payload = {
            ...base,
            ...parseWorkflow(reverseSettlementSchema.omit({ execution_id: true }), body),
          };
          break;
        default:
          return false;
      }
    }
    result = await service.command(binding, operation, payload, key, actor, verify);
  } else if (tail === '/risk' || tail === '/pnl') {
    result = await service.assessment(
      binding,
      parseWorkflow(portfolioQuerySchema, query(context.url.searchParams)),
      tail === '/risk' ? 'risk' : 'pnl',
      verify,
    );
  } else if (tail === '/audit-events') {
    result = await service.audit(
      binding,
      parseWorkflow(postTradeAuditQuerySchema, query(context.url.searchParams)),
      verify,
    );
  } else if (command) {
    if (context.url.search)
      throw new DomainError(400, 'VALIDATION_ERROR', 'Receipt reads take no query parameters.');
    result = await service.receipt(binding, parseWorkflow(keySchema, command[1]), verify);
  } else if (root) {
    if (context.url.search)
      throw new DomainError(400, 'VALIDATION_ERROR', 'Root history takes no query parameters.');
    result = await service.history(binding, execution!, verify);
  } else {
    result = await service.source(
      binding,
      parseWorkflow(postTradeSourceQuerySchema, query(context.url.searchParams)),
      verify,
    );
  }
  verify();
  if (result.replayed) context.response.setHeader('Idempotency-Replayed', 'true');
  if (result.status === 429 || result.status === 503)
    context.response.setHeader('Retry-After', '1');
  if (result.status === 201 && tail === '/initialize')
    context.response.setHeader('Location', '/api/fixed-income/v1/sandboxes/' + id + '/posttrade');
  context.respond(result.status, result.body);
  return true;
}
