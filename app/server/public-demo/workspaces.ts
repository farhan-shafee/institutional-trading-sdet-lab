import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import {
  keySchema,
  parseWorkflow,
  sandboxBodySchema,
  workflowResultSchema,
  type WorkflowResult,
} from '../../domain/workflow/contracts.js';
import { capabilityDigest } from '../fixed-income-workflow/service.js';
import type { WorkflowContext, WorkflowRoutes } from '../fixed-income-workflow/routes.js';
import { verifyPublicProfile, type PublicProfileKind } from './profile.js';
import type { PublicDemoMaintenance } from './maintenance.js';

type Intent = {
  id: string;
  read: string;
  trade: string;
  hash: string;
  key: string;
  actor: string;
  response?: WorkflowResult;
  pending?: Promise<WorkflowResult>;
};

/** Only ephemeral synthetic session ownership; restart recovery is deliberately unavailable. */
export class PublicDemoWorkspaces {
  private readonly intents = new Map<string, Intent>();
  constructor(
    private readonly workflow: WorkflowRoutes,
    private readonly maintenance: PublicDemoMaintenance,
    private readonly authenticate: (token: string) => unknown,
    private readonly profileKind: PublicProfileKind = 'workflow',
  ) {}
  forget(token: string): void {
    this.intents.delete(token);
    this.workflow.bindings.forget(token);
  }
  prune(): void {
    for (const token of this.intents.keys()) {
      try {
        this.authenticate(token);
      } catch {
        this.forget(token);
      }
    }
  }
  clear(): void {
    this.intents.clear();
  }
  private async profile(verify: () => void): Promise<void> {
    if (!this.workflow.service)
      throw new DomainError(
        503,
        'PUBLIC_DEMO_PROFILE_UNAVAILABLE',
        'Public persistence is unavailable.',
      );
    await this.workflow.service.database.transaction(true, verify, (db) =>
      verifyPublicProfile(db, this.profileKind),
    );
  }
  async handle(context: WorkflowContext): Promise<boolean> {
    const { request, url, token, respond } = context;
    const method = request.method ?? 'GET';
    const status =
      url.pathname === '/api/public-demo/status' ||
      url.pathname === '/api/fixed-income/v1/workflow/status';
    const postTradeStatus = url.pathname === '/api/public-demo/posttrade/status';
    const workspace = url.pathname === '/api/public-demo/workspace';
    const nativeOwnership =
      method === 'POST' &&
      (url.pathname === '/api/fixed-income/v1/sandboxes' ||
        url.pathname === '/api/fixed-income/v1/sandboxes/recover' ||
        /^\/api\/fixed-income\/v1\/sandboxes\/[^/]+\/recovery-keys\/rotate$/.test(url.pathname));
    if (nativeOwnership)
      throw new DomainError(
        404,
        'ROUTE_NOT_FOUND',
        'Native ownership is unavailable in the public demo.',
      );
    if ((status || postTradeStatus) && method === 'GET') {
      if (url.search)
        throw new DomainError(400, 'VALIDATION_ERROR', 'Status takes no query parameters.');
      if (postTradeStatus && this.profileKind !== 'posttrade') {
        respond(200, { enabled: false, state: 'disabled' });
        return true;
      }
      let state: 'ready' | 'unavailable' = 'ready';
      try {
        await this.profile(() => {
          context.authenticate();
        });
        await this.maintenance.ensure();
      } catch (error) {
        if (error instanceof DomainError && error.status !== 503) throw error;
        state = 'unavailable';
      }
      respond(
        200,
        url.pathname === '/api/public-demo/status'
          ? { enabled: true, state, write_minutes: 30, retention_minutes: 60 }
          : { enabled: true, state },
      );
      return true;
    }
    if (!workspace) {
      if (
        url.pathname.startsWith('/api/fixed-income/v1/sandboxes') ||
        url.pathname === '/api/fixed-income/v1/reconciliation/status'
      )
        await this.profile(() => {
          context.authenticate();
        });
      return false;
    }
    if (url.search || !['GET', 'POST'].includes(method))
      throw new DomainError(400, 'VALIDATION_ERROR', 'Invalid public workspace request.');
    this.prune();
    this.workflow.bindings.admitRequest();
    const current = this.workflow.bindings.context(token);
    const verify = () => {
      context.authenticate();
      this.workflow.bindings.verify(token, current.actorId);
    };
    if (method === 'GET') {
      const intent = this.intents.get(token);
      if (!intent)
        throw new DomainError(404, 'WORKSPACE_NOT_STARTED', 'Start a private workspace first.');
      if (!intent.response)
        throw new DomainError(
          503,
          'OUTCOME_UNKNOWN',
          'Retry workspace creation using the original retained key.',
        );
      await this.profile(verify);
      const binding = this.workflow.bindings.binding(token, intent.id);
      const result = await this.workflow.service!.read(binding, verify);
      respond(result.status, result.body);
      return true;
    }
    this.workflow.bindings.admitProof(token);
    context.admitLegacyMutation();
    const key = parseWorkflow(keySchema, request.headers['idempotency-key']);
    parseWorkflow(z.object({}).strict(), await context.readJson());
    verify();
    await this.profile(verify);
    await this.maintenance.ensure();
    verify();
    let intent = this.intents.get(token);
    if (intent && intent.key !== key)
      throw new DomainError(
        409,
        'WORKSPACE_ALREADY_STARTED',
        'Retry the original workspace request.',
      );
    if (!intent) {
      if (this.intents.size >= 50)
        throw new DomainError(
          503,
          'WORKSPACE_CAPACITY_REACHED',
          'Public workspace capacity is temporarily unavailable.',
        );
      const id = randomUUID();
      const read = capabilityDigest(id, 'read', randomBytes(32).toString('base64url'));
      const trade = capabilityDigest(id, 'trade', randomBytes(32).toString('base64url'));
      const hash = createHash('sha256')
        .update(
          JSON.stringify({
            profile:
              this.profileKind === 'posttrade' ? 'public-posttrade-v1' : 'public-workflow-v1',
            id,
            read,
            trade,
          }),
        )
        .digest('hex');
      intent = { id, read, trade, hash, key, actor: current.actorId };
      this.intents.set(token, intent);
    }
    const retained = intent;
    let result: WorkflowResult;
    if (retained.response) result = { ...retained.response, replayed: true };
    else if (retained.pending) result = { ...(await retained.pending), replayed: true };
    else {
      const execute = async (): Promise<WorkflowResult> => {
        const raw = await this.workflow.service!.database.transaction(false, verify, async (db) => {
          await verifyPublicProfile(db, this.profileKind);
          const record = await db.query<{ result: unknown }>(
            'SELECT fi_control.create_public_demo_sandbox($1,$2,$3,$4,$5,$6) AS result',
            [
              retained.id,
              retained.read,
              retained.trade,
              retained.hash,
              retained.key,
              retained.actor,
            ],
          );
          return workflowResultSchema.parse(record.rows[0]?.result);
        });
        verify();
        if (raw.status !== 201) return raw;
        const body = sandboxBodySchema.parse(raw.body);
        const scope = context.authenticate().role === 'trader' ? 'trade' : 'read';
        body.scope = scope;
        this.workflow.bindings.bind(token, {
          sandboxId: retained.id,
          digest: scope === 'trade' ? retained.trade : retained.read,
          scope,
          generation: body.sandbox.generation,
        });
        const confirmed = { ...raw, body };
        retained.response = confirmed;
        return confirmed;
      };
      retained.pending = execute();
      try {
        result = await retained.pending;
      } finally {
        delete retained.pending;
      }
    }
    verify();
    if (result.replayed) context.response.setHeader('Idempotency-Replayed', 'true');
    if (result.status === 201)
      context.response.setHeader('Location', `/api/fixed-income/v1/sandboxes/${retained.id}`);
    if (result.status === 429 || result.status === 503)
      context.response.setHeader('Retry-After', '1');
    respond(result.status, result.body);
    return true;
  }
}
