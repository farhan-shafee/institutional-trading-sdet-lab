import { randomUUID } from 'node:crypto';
import { AdmissionWindow } from '../../domain/admission.js';
import { DomainError } from '../../domain/errors.js';
import type { Scope } from '../../domain/workflow/contracts.js';

export type Binding = { sandboxId: string; digest: string; scope: Scope; generation: string };
type Context = {
  actorId: string;
  expiresAt: number;
  mutations: AdmissionWindow;
  proofs: AdmissionWindow;
  binding?: Binding;
};

export class WorkflowBindings {
  private readonly contexts = new Map<string, Context>();
  private readonly requests: AdmissionWindow;
  private readonly mutations: AdmissionWindow;
  private readonly proofs: AdmissionWindow;
  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly capacity = 50,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 50)
      throw new RangeError('Invalid workflow context capacity.');
    this.requests = new AdmissionWindow(600, 60_000, now);
    this.mutations = new AdmissionWindow(120, 60_000, now);
    this.proofs = new AdmissionWindow(60, 60_000, now);
  }
  admitRequest(): void {
    this.requests.take();
  }
  context(token: string): Context {
    this.prune();
    let context = this.contexts.get(token);
    if (!context) {
      if (this.contexts.size >= this.capacity)
        throw new DomainError(
          503,
          'WORKFLOW_BINDING_CAPACITY',
          'Workflow authorization capacity reached.',
        );
      context = {
        actorId: randomUUID(),
        expiresAt: this.now() + 1_800_000,
        mutations: new AdmissionWindow(30, 60_000, this.now),
        proofs: new AdmissionWindow(10, 60_000, this.now),
      };
      this.contexts.set(token, context);
    }
    return context;
  }
  admitMutation(token: string): void {
    this.mutations.take();
    this.context(token).mutations.take();
  }
  admitProof(token: string): void {
    this.proofs.take();
    this.context(token).proofs.take();
  }
  bind(token: string, binding: Binding): void {
    this.context(token).binding = { ...binding };
  }
  binding(token: string, sandboxId: string, trade = false): Binding {
    this.prune();
    const binding = this.contexts.get(token)?.binding;
    if (!binding)
      throw new DomainError(
        403,
        'SANDBOX_BINDING_REQUIRED',
        'Explicit sandbox recovery is required.',
      );
    if (binding.sandboxId !== sandboxId)
      throw new DomainError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found.');
    if (trade && binding.scope !== 'trade')
      throw new DomainError(403, 'FORBIDDEN', 'A trade capability is required.');
    return binding;
  }
  verify(token: string, actorId: string, binding?: Binding): void {
    this.prune();
    const context = this.contexts.get(token);
    if (!context || context.actorId !== actorId || (binding && context.binding !== binding))
      throw new DomainError(
        403,
        'WORKFLOW_BINDING_EXPIRED',
        'Workflow authorization expired or was replaced.',
      );
  }
  forget(token: string): void {
    this.contexts.delete(token);
  }
  unbind(token: string): void {
    const context = this.contexts.get(token);
    if (context) delete context.binding;
  }
  clear(): void {
    this.contexts.clear();
  }
  prune(): void {
    for (const [token, context] of this.contexts)
      if (this.now() >= context.expiresAt) this.contexts.delete(token);
  }
}
