import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import {
  createSandboxSchema,
  recoverSandboxSchema,
  rotateSchema,
  keySchema,
  parseWorkflow,
  type WorkflowResult,
} from '../../domain/workflow/contracts.js';
import { WorkflowDatabase } from '../../persistence/postgres/workflow.js';
import { WorkflowBindings, type Binding } from './bindings.js';
import { WorkflowService } from './service.js';
import { RfqService } from './rfq-service.js';
import { OrderService } from './order-service.js';
import { handleOrder } from './order-routes.js';
import { handleRfq } from './rfq-routes.js';

export type WorkflowContext = {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  token: string;
  authenticate: () => { role: 'trader' | 'viewer' };
  readJson: () => Promise<unknown>;
  admitLegacyMutation: () => void;
  respond: (status: number, body: unknown) => void;
};
const root = '/api/fixed-income/v1';

export class WorkflowRoutes {
  readonly bindings: WorkflowBindings;
  readonly service: WorkflowService | undefined;
  constructor(databaseUrl?: string, now?: () => number, database?: WorkflowDatabase) {
    this.bindings = new WorkflowBindings(now);
    this.service = databaseUrl
      ? new WorkflowService(database ?? new WorkflowDatabase(databaseUrl))
      : undefined;
  }
  async close(): Promise<void> {
    this.bindings.clear();
    await this.service?.database.close();
  }
  async handle(context: WorkflowContext): Promise<boolean> {
    const { request, response, url, token, authenticate, respond } = context;
    const method = request.method ?? 'GET';
    if (
      this.service &&
      (await handleOrder(context, this.bindings, new OrderService(this.service.database)))
    )
      return true;
    if (
      this.service &&
      (await handleRfq(context, this.bindings, new RfqService(this.service.database)))
    )
      return true;
    if (url.pathname === `${root}/workflow/status` && method === 'GET') {
      if (url.search)
        throw new DomainError(400, 'VALIDATION_ERROR', 'Status takes no query parameters.');
      if (!this.service) {
        respond(200, { enabled: false, state: 'disabled' });
        return true;
      }
      this.bindings.admitRequest();
      respond(
        200,
        await this.service.status(() => {
          authenticate();
        }),
      );
      return true;
    }
    const create = url.pathname === `${root}/sandboxes` && method === 'POST';
    const recover = url.pathname === `${root}/sandboxes/recover` && method === 'POST';
    const detail = url.pathname.match(
      /^\/api\/fixed-income\/v1\/sandboxes\/([^/]+)(?:\/(recovery-keys\/rotate|audit-events|commands\/[^/]+))?$/,
    );
    const action = detail?.[2];
    const supported =
      detail &&
      ((method === 'GET' && action !== 'recovery-keys/rotate') ||
        (method === 'POST' && action === 'recovery-keys/rotate'));
    if (!create && !recover && !supported) return false;
    if (!this.service) return false;
    this.bindings.admitRequest();
    const actor = this.bindings.context(token).actorId;
    const isTrade = create || action === 'recovery-keys/rotate';
    const verify = (binding?: Binding) => {
      const current = authenticate();
      if (isTrade && current.role !== 'trader')
        throw new DomainError(
          403,
          'FORBIDDEN',
          'Viewer sessions cannot change fixed-income sandboxes.',
        );
      this.bindings.verify(token, actor, binding);
    };
    verify();
    if (action !== 'audit-events' && url.search)
      throw new DomainError(400, 'VALIDATION_ERROR', 'This operation takes no query parameters.');
    if (method === 'POST') {
      context.admitLegacyMutation();
      this.bindings.admitMutation(token);
    }
    const send = (result: WorkflowResult) => {
      verify();
      if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
      if (
        result.status === 201 &&
        create &&
        typeof result.body === 'object' &&
        result.body !== null &&
        'sandbox' in result.body
      ) {
        const body = result.body as { sandbox: { id: string } };
        response.setHeader('Location', `${root}/sandboxes/${body.sandbox.id}`);
      }
      if (result.status === 429 || result.status === 503) response.setHeader('Retry-After', '1');
      respond(result.status, result.body);
    };
    if (create) {
      this.bindings.admitProof(token);
      const key = parseWorkflow(keySchema, request.headers['idempotency-key']);
      const input = parseWorkflow(createSandboxSchema, await context.readJson());
      verify();
      const { result, binding } = await this.service.create(input, key, actor, () => verify());
      if (binding) this.bindings.bind(token, binding);
      send(result);
      return true;
    }
    if (recover) {
      this.bindings.admitProof(token);
      const input = parseWorkflow(recoverSandboxSchema, await context.readJson());
      verify();
      if (input.scope === 'trade' && authenticate().role !== 'trader')
        throw new DomainError(403, 'FORBIDDEN', 'Viewer sessions require a read capability.');
      const { result, binding } = await this.service.recover(
        input.sandbox_id.toLowerCase(),
        input.scope,
        input.capability,
        () => verify(),
      );
      if (binding) this.bindings.bind(token, binding);
      send(result);
      return true;
    }
    const id = parseWorkflow(z.uuid(), detail![1]).toLowerCase();
    const binding = this.bindings.binding(token, id, isTrade);
    if (action === 'recovery-keys/rotate') {
      const key = parseWorkflow(keySchema, request.headers['idempotency-key']);
      const input = parseWorkflow(rotateSchema, await context.readJson());
      verify(binding);
      const result = await this.service.rotate(binding, input, key, actor, () => verify(binding));
      send(result);
      if (result.status === 200) this.bindings.unbind(token);
    } else if (action === 'audit-events') {
      send(await this.service.audit(binding, url.searchParams, () => verify(binding)));
    } else if (action?.startsWith('commands/')) {
      const key = parseWorkflow(keySchema, action.slice('commands/'.length));
      send(await this.service.command(binding, key, () => verify(binding)));
    } else send(await this.service.read(binding, () => verify(binding)));
    return true;
  }
}
