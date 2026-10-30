import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import { keySchema, parseWorkflow } from '../../domain/workflow/contracts.js';
import {
  requestReconciliationSchema,
  recoverReconciliationSchema,
  findingCategories,
} from '../../domain/workflow/reconciliation.js';
import type { WorkflowBindings } from '../fixed-income-workflow/bindings.js';
import type { WorkflowContext } from '../fixed-income-workflow/routes.js';
import type { ReconciliationService } from './service.js';
export async function handleReconciliation(
  context: WorkflowContext,
  bindings: WorkflowBindings,
  service: ReconciliationService,
): Promise<boolean> {
  if (
    context.url.pathname === '/api/fixed-income/v1/reconciliation/status' &&
    context.request.method === 'GET'
  ) {
    if (context.url.search)
      throw new DomainError(400, 'VALIDATION_ERROR', 'Status takes no query parameters.');
    bindings.admitRequest();
    context.authenticate();
    context.respond(200, { configured: service.runner !== undefined });
    return true;
  }

  const receipt = context.url.pathname.match(
    /^\/api\/fixed-income\/v1\/sandboxes\/([^/]+)\/reconciliation-commands\/([^/]+)$/,
  );
  if (receipt && context.request.method === 'GET') {
    bindings.admitRequest();
    if (context.url.search)
      throw new DomainError(400, 'VALIDATION_ERROR', 'Receipt reads take no query parameters.');
    const sid = parseWorkflow(z.uuid(), receipt[1]).toLowerCase(),
      key = parseWorkflow(keySchema, receipt[2]);
    const actor = bindings.context(context.token).actorId,
      binding = bindings.binding(context.token, sid);
    const verify = () => {
      context.authenticate();
      bindings.verify(context.token, actor, binding);
    };
    verify();
    const r = await service.receipt(binding, key, verify);
    verify();
    context.respond(r.status, r.body);
    return true;
  }
  const match = context.url.pathname.match(
    /^\/api\/fixed-income\/v1\/sandboxes\/([^/]+)\/reconciliation-runs(?:\/([^/]+)(?:\/(findings|recover))?)?$/,
  );
  if (!match) return false;
  const method = context.request.method,
    action = match[3];
  if (!(
    (method === 'GET' && action !== 'recover') ||
    (method === 'POST' && (!match[2] || action === 'recover'))
  ))
    return false;
  bindings.admitRequest();
  const sid = parseWorkflow(z.uuid(), match[1]).toLowerCase(),
    rid = match[2] ? parseWorkflow(z.uuid(), match[2]).toLowerCase() : undefined;
  const actor = bindings.context(context.token).actorId,
    binding = bindings.binding(context.token, sid, method === 'POST');
  const verify = () => {
    if (context.authenticate().role !== 'trader' && method === 'POST')
      throw new DomainError(403, 'FORBIDDEN', 'Viewer sessions cannot request reconciliation.');
    bindings.verify(context.token, actor, binding);
  };
  verify();
  let result;
  if (method === 'POST') {
    if (context.url.search)
      throw new DomainError(400, 'VALIDATION_ERROR', 'Commands take no query parameters.');
    context.admitLegacyMutation();
    bindings.admitMutation(context.token);
    const key = parseWorkflow(keySchema, context.request.headers['idempotency-key']);
    const raw = await context.readJson();
    verify();
    const run = rid
      ? (parseWorkflow(recoverReconciliationSchema, raw), rid)
      : parseWorkflow(requestReconciliationSchema, raw).run_id;
    result = await service.command(
      binding,
      rid ? 'RECOVER_RECONCILIATION' : 'CREATE_RECONCILIATION',
      run,
      key,
      actor,
      verify,
    );
    if (result.status === 201)
      context.response.setHeader(
        'Location',
        `/api/fixed-income/v1/sandboxes/${sid}/reconciliation-runs/${run}`,
      );
  } else {
    const kind = !rid ? 'list' : action === 'findings' ? 'findings' : 'detail';
    const allowed =
      kind === 'list'
        ? ['after', 'as_of', 'limit']
        : kind === 'findings'
          ? ['after', 'limit', 'category']
          : [];
    const values: Record<string, string> = {};
    for (const [k, v] of context.url.searchParams) {
      if (!allowed.includes(k) || Object.hasOwn(values, k))
        throw new DomainError(400, 'VALIDATION_ERROR', 'Unknown or repeated reconciliation query.');
      values[k] = v;
    }
    const count = (name: string, fallback: number, max: number) =>
      values[name] === undefined
        ? fallback
        : parseWorkflow(
            z
              .string()
              .regex(/^\d{1,3}$/)
              .transform(Number)
              .pipe(
                z
                  .number()
                  .int()
                  .min(name === 'limit' ? 1 : 0)
                  .max(max),
              ),
            values[name],
          );
    const after = count('after', 0, 128),
      asof = values.as_of === undefined ? undefined : count('as_of', 0, 20),
      limit = count('limit', 20, 20);
    if (asof !== undefined && after > asof)
      throw new DomainError(400, 'VALIDATION_ERROR', 'Pagination bounds are inconsistent.');
    const category =
      values.category === undefined
        ? undefined
        : parseWorkflow(z.enum(findingCategories), values.category);
    result = await service.read(binding, rid, kind, after, asof, limit, category, verify);
  }
  verify();
  if (result.replayed) context.response.setHeader('Idempotency-Replayed', 'true');
  if (result.status === 429 || result.status === 503)
    context.response.setHeader('Retry-After', '1');
  context.respond(result.status, result.body);
  return true;
}
