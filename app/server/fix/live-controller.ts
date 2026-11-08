/** Trusted local stdio controller. No HTTP route or financial calculations. */
import { createHash, randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import { liveProfile } from '../../domain/workflow/live-database-contract.js';
import type { workflowResultSchema } from '../../domain/workflow/contracts.js';
import { decodeLiveFix44, type LiveFixFrame } from '../../protocol/fix44-live/index.js';
import type { Binding } from '../fixed-income-workflow/bindings.js';
import type { LiveFixApplicationService, LiveFixOperation } from './live-application.js';
import type { LiveJournal } from './live-journal.js';
import { recoverLiveRequest } from './live-recovery.js';

const uuid = z.uuid();
const pid = z
  .string()
  .regex(/^[1-9][0-9]{0,9}$/)
  .refine((v) => BigInt(v) <= 2147483647n);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.string().regex(/^(?:[a-f0-9]{2}){1,8192}$/);
const identitySchema = z
  .object({
    run_id: uuid,
    session_id: uuid,
    store_id: uuid,
    connection_id: uuid,
    runtime_hash: hash,
  })
  .strict();
const base = {
  version: z.literal(1),
  profile: z.literal(liveProfile),
  session_id: uuid,
  store_id: uuid,
  connection_id: uuid,
};
const envelopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...base,
      kind: z.literal('READY'),
      run_id: uuid,
      runtime_hash: hash,
      store_hash: hash,
      go_pid: pid,
      java_pid: pid,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('CONNECTED'),
      previous_connection_id: uuid,
      run_id: uuid,
      runtime_hash: hash,
      store_hash: hash,
      go_pid: pid,
      java_pid: pid,
    })
    .strict(),
  z.object({ ...base, kind: z.literal('ARMED') }).strict(),
  z
    .object({
      ...base,
      kind: z.literal('OBSERVED'),
      observation_id: uuid,
      direction: z.enum(['J_TO_G', 'G_TO_J']),
      raw_hex: bytes,
      sender_pid: pid,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('CALLBACK'),
      observation_id: uuid,
      role: z.enum(['go', 'java']),
      event_seq: z
        .string()
        .regex(/^[1-9][0-9]{0,3}$/)
        .refine((v) => Number(v) <= 1024),
      callback_hex: bytes,
      receiver_pid: pid,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('STOPPED'),
      pending: z.number().int().min(0).max(16),
      financial_application_verified: z.literal(false),
      transport_evidence_complete: z.boolean(),
      child_exit_codes: z.object({ go: z.number().int(), java: z.number().int() }).strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      profile: z.literal(liveProfile),
      kind: z.literal('ERROR'),
      code: z.string().regex(/^[A-Z0-9_]{1,100}$/),
    })
    .strict(),
]);
type Envelope = z.infer<typeof envelopeSchema>;
/** Exact JSONL framing; reject ambiguous duplicate keys, including escaped aliases. */
export function decodeLiveBridgeEnvelope(input: Uint8Array): Envelope {
  try {
    if (
      !(input instanceof Uint8Array) ||
      input.byteLength < 1 ||
      input.byteLength > 24576 ||
      input[input.byteLength - 1] !== 10
    )
      throw new Error();
    const raw = Buffer.from(input);
    for (let i = 0; i < raw.length - 1; i++)
      if ((raw[i]! < 32 && raw[i] !== 13) || raw[i]! > 126) throw new Error();
    const text = raw.toString('ascii'),
      stack: Array<Set<string> | null> = [];
    for (let i = 0; i < text.length; i++) {
      const character = text[i];
      if (character === '{') stack.push(new Set());
      else if (character === '[') stack.push(null);
      else if (character === '}' || character === ']') stack.pop();
      else if (character === '"') {
        const start = i++;
        for (; i < text.length; i++) {
          if (text[i] === '\\') {
            i++;
            continue;
          }
          if (text[i] === '"') break;
        }
        const value: unknown = JSON.parse(text.slice(start, i + 1));
        let next = i + 1;
        while (next < text.length && /\s/.test(text[next]!)) next++;
        if (text[next] === ':') {
          const keys = stack[stack.length - 1];
          if (!(keys instanceof Set) || typeof value !== 'string' || keys.has(value))
            throw new Error();
          keys.add(value);
        }
      }
    }
    return envelopeSchema.parse(JSON.parse(text) as unknown);
  } catch {
    throw unavailable('FIX_LIVE_ENVELOPE');
  }
}

type Result = z.infer<typeof workflowResultSchema>;
type Params = Record<string, string>;
type Action = LiveFixOperation | 'APPLY';
const witnessSchema = z
  .object({
    profile: z.literal(liveProfile),
    runtime_hash: hash,
    session_id: uuid,
    store_id: uuid,
    connection_id: uuid,
    role: z.enum(['go', 'java']),
    pid,
    event_seq: z.string().regex(/^[1-9][0-9]{0,3}$/),
    callback_hash: hash,
  })
  .strict();
type Witness = z.infer<typeof witnessSchema>;
const workSchema = z
  .object({
    message_id: uuid,
    order_id: uuid,
    work_id: uuid,
    financial_key: uuid,
    queue_key: uuid,
    prepare_key: uuid,
    apply_key: uuid,
    owner_id: uuid,
    fence: z.string().regex(/^[1-9][0-9]{0,15}$/),
  })
  .strict();
type Work = z.infer<typeof workSchema>;
export type LiveControllerContext = {
  binding: Binding;
  actor_id: string;
  order_id: string;
  channel_id: string;
  owner_id: string;
  verify: () => void;
};
type Context = LiveControllerContext & { fence?: string };
type Runtime = z.infer<typeof identitySchema>;
type Ready = Extract<Envelope, { kind: 'READY' }>;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function unavailable(code = 'FIX_LIVE_UNRESOLVED') {
  return new DomainError(
    503,
    code,
    'Live FIX progress is unresolved. Retain and recover the original intent.',
  );
}
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(unavailable('FIX_LIVE_DEADLINE')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function fixedKey(...parts: string[]): string {
  const value = createHash('sha256').update(JSON.stringify(parts)).digest().subarray(0, 16);
  value[6] = (value[6]! & 15) | 128;
  value[8] = (value[8]! & 63) | 128;
  const h = value.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function object(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}
function semantic(fields: Readonly<Params>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(fields)
        .filter(([tag]) => !['8', '9', '10', '34', '43', '49', '52', '56', '122'].includes(tag))
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

export class LiveFixController {
  private readonly contexts = new Map<string, Context>();
  private readonly ready = deferred<void>();
  private readonly exited = deferred<number | null>();
  private readonly stopped = deferred<void>();
  private readyFrame: Ready | undefined;
  private connectionId: string;
  private reconnecting: ReturnType<typeof deferred<void>> | undefined;
  private readonly connections = new Set<string>();
  private failure: DomainError | undefined;
  private aborting = false;
  private buffer = Buffer.alloc(0);
  private outputBytes = 0;
  private readonly events: Envelope[] = [];
  private processing: Promise<void> = Promise.resolve();
  private processingActive = false;
  private stopping: Promise<void> | undefined;
  private readonly pendingOperations = new Set<Promise<unknown>>();
  private readonly active = new Map<
    'J_TO_G' | 'G_TO_J',
    {
      command_id: string;
      order_id: string;
      fields: Params;
      done: ReturnType<typeof deferred<Result>>;
    }
  >();
  private readonly frames = new Map<
    string,
    {
      context: Context;
      raw: Buffer;
      direction: 'J_TO_G' | 'G_TO_J';
      observe_key: string;
      accept_key: string;
      parsed: LiveFixFrame;
      send: ReturnType<LiveFixController['active']['get']>;
    }
  >();
  constructor(
    private readonly options: {
      service: LiveFixApplicationService;
      journal: LiveJournal;
      process: ChildProcessWithoutNullStreams;
      runtime: Runtime;
      contexts: LiveControllerContext[];
      enabled?: boolean;
    },
  ) {
    identitySchema.parse(options.runtime);
    this.connectionId = options.runtime.connection_id;
    this.connections.add(this.connectionId);
    if (options.contexts.length < 1 || options.contexts.length > 4)
      throw unavailable('FIX_LIVE_CONTEXT_BOUND');
    for (const context of options.contexts) {
      for (const id of [context.actor_id, context.order_id, context.channel_id, context.owner_id])
        uuid.parse(id);
      if (context.binding.scope !== 'trade' || this.contexts.has(context.order_id))
        throw unavailable('FIX_LIVE_CONTEXT');
      const prior = this.contexts.values().next().value;
      if (
        prior &&
        (prior.binding.sandboxId !== context.binding.sandboxId ||
          prior.binding.generation !== context.binding.generation ||
          prior.actor_id !== context.actor_id)
      )
        throw unavailable('FIX_LIVE_CONTEXT');
      this.contexts.set(context.order_id, { ...context, binding: { ...context.binding } });
    }
    options.process.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    options.process.stderr.on('data', (chunk: Buffer) => {
      this.outputBytes += chunk.length;
      if (this.outputBytes > 7864320) this.fail(unavailable('FIX_LIVE_OUTPUT_BOUND'));
    });
    options.process.stdin.on('error', () => this.fail(unavailable('FIX_LIVE_PIPE')));
    options.process.stdout.on('error', () => this.fail(unavailable('FIX_LIVE_PIPE')));
    options.process.stderr.on('error', () => this.fail(unavailable('FIX_LIVE_PIPE')));
    options.process.on('error', () => this.fail(unavailable('FIX_LIVE_PROCESS')));
    options.process.on('close', (code) => {
      this.exited.resolve(code);
      if (!this.stopping || code !== 0 || this.pendingOperations.size)
        this.fail(unavailable('FIX_LIVE_PROCESS_EXIT'));
    });
  }
  start(): Promise<void> {
    return this.admit(() => this.awaitReady());
  }
  private async awaitReady(): Promise<void> {
    if (!this.options.enabled) throw unavailable('FIX_LIVE_DISABLED');
    this.requireCommandAdmission();
    await bounded(this.ready.promise, 15000);
    this.requireCommandAdmission();
  }
  private healthy(): void {
    if (this.failure) throw this.failure;
  }
  private requireCommandAdmission(): void {
    this.healthy();
    if (this.stopping) throw unavailable('FIX_LIVE_STOPPING');
  }
  private admit<T>(operation: () => Promise<T>): Promise<T> {
    let pending: Promise<T>;
    try {
      this.requireCommandAdmission();
      pending = operation();
    } catch (error) {
      const failure = error instanceof DomainError ? error : unavailable();
      const rejected = Promise.reject<T>(failure);
      void rejected.catch(() => undefined);
      return rejected;
    }
    this.pendingOperations.add(pending);
    const settled = () => {
      this.pendingOperations.delete(pending);
    };
    // Track and observe the exact promise returned to each bridge lifecycle caller.
    void pending.then(settled, settled);
    return pending;
  }
  private fail(error: DomainError): void {
    this.failure ??= error;
    this.ready.reject(this.failure);
    this.stopped.reject(this.failure);
    this.reconnecting?.reject(this.failure);
    this.events.length = 0;
    for (const pending of this.active.values()) pending.done.reject(this.failure);
    if (
      !this.aborting &&
      this.options.process.exitCode === null &&
      !this.options.process.stdin.destroyed
    ) {
      this.aborting = true;
      void this.write('STOP')
        .catch(() => undefined)
        .finally(() => {
          this.options.process.stdin.end();
        });
    }
  }
  private receive(chunk: Buffer): void {
    try {
      this.outputBytes += chunk.length;
      if (this.outputBytes > 7864320) throw unavailable('FIX_LIVE_OUTPUT_BOUND');
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let end: number;
      while ((end = this.buffer.indexOf(10)) !== -1) {
        if (end + 1 > 24576) throw unavailable('FIX_LIVE_ENVELOPE_BOUND');
        const raw = this.buffer.subarray(0, end + 1);
        this.buffer = this.buffer.subarray(end + 1);
        const envelope = decodeLiveBridgeEnvelope(raw);
        if (this.events.length >= 16) throw unavailable('FIX_LIVE_QUEUE_BOUND');
        this.events.push(envelope);
      }
      if (this.buffer.length >= 24576) throw unavailable('FIX_LIVE_ENVELOPE_BOUND');
      if (!this.processingActive) {
        this.processingActive = true;
        this.processing = this.drain();
        void this.processing.catch(() => undefined);
      }
    } catch {
      this.fail(unavailable('FIX_LIVE_ENVELOPE'));
    }
  }
  private async drain(): Promise<void> {
    try {
      while (this.events.length && !this.failure) await this.handle(this.events.shift()!);
    } catch (error) {
      this.fail(error instanceof DomainError ? error : unavailable());
    } finally {
      this.processingActive = false;
    }
  }
  private async write(kind: string, fields: Record<string, unknown> = {}): Promise<void> {
    const raw = Buffer.from(
      JSON.stringify({
        version: 1,
        profile: liveProfile,
        kind,
        connection_id: this.connectionId,
        ...fields,
      }) + '\n',
    );
    if (raw.length > 24576) throw unavailable('FIX_LIVE_ENVELOPE_BOUND');
    await bounded(
      new Promise<void>((resolve, reject) =>
        this.options.process.stdin.write(raw, (error) =>
          error ? reject(unavailable('FIX_LIVE_PIPE')) : resolve(),
        ),
      ),
      5000,
    );
  }
  private context(order: string): Context {
    const context = this.contexts.get(order);
    if (!context) throw unavailable('FIX_LIVE_CONTEXT');
    context.verify();
    return context;
  }
  private async call(
    context: Context,
    action: Action,
    input: Params,
    key: string,
    witness?: Witness,
  ): Promise<Result> {
    const request = {
      kind: action === 'APPLY' ? 'APPLY' : 'COMMAND',
      action,
      order_id: context.order_id,
      sandbox_id: context.binding.sandboxId,
      actor_id: context.actor_id,
      input,
      ...(witness ? { witness: witnessSchema.parse(witness) } : {}),
    };
    await this.options.journal.retain('request', key, request);
    if ((await this.options.journal.usage()) + this.outputBytes > 7864320)
      throw unavailable('FIX_LIVE_EVIDENCE_BOUND');
    const verify = () => {
      context.verify();
      if (this.failure) throw this.failure;
    };
    try {
      const result =
        action === 'APPLY'
          ? await this.options.service.apply(context.binding, context.actor_id, input, key, verify)
          : await this.options.service.command(
              context.binding,
              context.actor_id,
              action,
              input,
              key,
              verify,
            );
      await this.options.journal.retain('result', key, {
        status: result.status,
        body: result.body,
      });
      return result;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'OUTCOME_UNKNOWN')
        await this.options.journal.retain('unknown', key, { code: 'OUTCOME_UNKNOWN' });
      throw error;
    }
  }
  private success(result: Result, status: number): Record<string, unknown> {
    if (result.status !== status) throw unavailable('FIX_LIVE_SQL_REJECTED');
    return object(result.body);
  }
  private async handle(envelope: Envelope): Promise<void> {
    if (!this.options.enabled) throw unavailable('FIX_LIVE_DISABLED');
    if (envelope.kind === 'ERROR') throw unavailable(envelope.code);
    const runtime = this.options.runtime;
    if (
      envelope.session_id !== runtime.session_id ||
      envelope.store_id !== runtime.store_id ||
      (envelope.kind !== 'CONNECTED' && envelope.connection_id !== this.connectionId)
    )
      throw unavailable('FIX_LIVE_RUNTIME_CORRESPONDENCE');
    if (envelope.kind === 'CONNECTED') {
      if (
        !this.reconnecting ||
        !this.readyFrame ||
        envelope.previous_connection_id !== this.connectionId ||
        this.connections.has(envelope.connection_id) ||
        this.connections.size >= 8 ||
        envelope.run_id !== runtime.run_id ||
        envelope.runtime_hash !== runtime.runtime_hash ||
        envelope.store_hash !== this.readyFrame.store_hash
      )
        throw unavailable('FIX_LIVE_RECONNECT_CORRESPONDENCE');
      const context = this.contexts.values().next().value;
      if (!context) throw unavailable('FIX_LIVE_CONTEXT');
      this.success(
        await this.call(
          context,
          'CONNECT',
          {
            order_id: context.order_id,
            connection_id: envelope.connection_id,
            go_pid: envelope.go_pid,
            java_pid: envelope.java_pid,
          },
          fixedKey('CONNECT', runtime.run_id, envelope.connection_id),
        ),
        201,
      );
      this.connectionId = envelope.connection_id;
      this.connections.add(this.connectionId);
      this.readyFrame = {
        ...this.readyFrame,
        connection_id: this.connectionId,
        go_pid: envelope.go_pid,
        java_pid: envelope.java_pid,
      };
      await this.write('ARM');
      return;
    }
    if (envelope.kind === 'READY') {
      if (
        this.readyFrame ||
        envelope.run_id !== runtime.run_id ||
        envelope.runtime_hash !== runtime.runtime_hash
      )
        throw unavailable('FIX_LIVE_RUNTIME_CORRESPONDENCE');
      const metadata = {
        version: 1,
        profile: liveProfile,
        run_id: runtime.run_id,
        session_id: runtime.session_id,
        store_id: runtime.store_id,
        runtime_hash: runtime.runtime_hash,
      };
      const expected = createHash('sha256')
        .update(
          JSON.stringify(
            Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b))),
          ),
        )
        .digest('hex');
      if (envelope.store_hash !== expected) throw unavailable('FIX_LIVE_STORE_CORRESPONDENCE');
      this.readyFrame = envelope;
      for (const context of this.contexts.values()) {
        this.success(
          await this.call(
            context,
            'BIND',
            {
              order_id: context.order_id,
              dealer_id: 'ATLAS',
              channel_id: context.channel_id,
              session_id: runtime.session_id,
              store_id: runtime.store_id,
              connection_id: runtime.connection_id,
              runtime_hash: runtime.runtime_hash,
              store_hash: envelope.store_hash,
              go_pid: envelope.go_pid,
              java_pid: envelope.java_pid,
            },
            fixedKey('BIND', runtime.run_id, context.order_id),
          ),
          201,
        );
        const claimed = this.success(
          await this.call(
            context,
            'CLAIM',
            { order_id: context.order_id, owner_id: context.owner_id },
            fixedKey('CLAIM', runtime.run_id, context.order_id),
          ),
          200,
        );
        context.fence = z.union([z.string(), z.number()]).parse(claimed['fence']).toString();
      }
      await this.write('ARM');
      return;
    }
    if (!this.readyFrame) throw unavailable('FIX_LIVE_NOT_READY');
    if (envelope.kind === 'ARMED') {
      if (this.reconnecting) this.reconnecting.resolve();
      else this.ready.resolve();
      return;
    }
    if (envelope.kind === 'STOPPED') {
      if (
        envelope.pending !== 0 ||
        !envelope.transport_evidence_complete ||
        envelope.child_exit_codes.go !== 0 ||
        envelope.child_exit_codes.java !== 0
      )
        throw unavailable('FIX_LIVE_STOP_UNRESOLVED');
      this.stopped.resolve();
      return;
    }
    if (envelope.kind === 'OBSERVED') {
      const pending = this.active.get(envelope.direction);
      const raw = Buffer.from(envelope.raw_hex, 'hex');
      let parsed: LiveFixFrame | undefined;
      try {
        parsed = decodeLiveFix44(raw);
      } catch {
        /* SQL still observes raw for a known owned send. */
      }
      const reference = pending?.order_id ?? parsed?.fields['41'] ?? parsed?.fields['11'];
      if (!reference) throw unavailable('FIX_LIVE_UNBOUND_OBSERVATION');
      const context = this.context(reference),
        observe_key = randomUUID(),
        accept_key = randomUUID();
      const sender =
        envelope.direction === 'J_TO_G' ? this.readyFrame.java_pid : this.readyFrame.go_pid;
      if (
        envelope.sender_pid !== sender ||
        this.frames.has(envelope.observation_id) ||
        this.frames.size >= 640
      )
        throw unavailable('FIX_LIVE_OBSERVATION_CORRESPONDENCE');
      await this.options.journal.retain('frame', envelope.observation_id, {
        ...(pending ? { command_id: pending.command_id } : {}),
        order_id: context.order_id,
        raw_hex: envelope.raw_hex,
        connection_id: this.connectionId,
        direction: envelope.direction,
        sender_pid: envelope.sender_pid,
        observe_key,
        accept_key,
      });
      const observed = this.success(
        await this.call(
          context,
          'OBSERVE',
          {
            order_id: context.order_id,
            observation_id: envelope.observation_id,
            connection_id: this.connectionId,
            direction: envelope.direction === 'J_TO_G' ? 'OUT' : 'IN',
            raw_hex: envelope.raw_hex,
          },
          observe_key,
        ),
        201,
      );
      if (
        observed['profile_valid'] !== true ||
        !parsed ||
        (pending && semantic(parsed.fields) !== semantic(pending.fields))
      )
        throw unavailable('FIX_LIVE_PROFILE_UNRESOLVED');
      if (observed['raw_hash'] !== parsed.sha256) throw unavailable('FIX_LIVE_RAW_HASH');
      this.frames.set(envelope.observation_id, {
        context,
        raw,
        direction: envelope.direction,
        observe_key,
        accept_key,
        parsed,
        send: pending,
      });
      await this.write('ACK', { observation_id: envelope.observation_id, phase: 'OBSERVE' });
      return;
    }
    const frame = this.frames.get(envelope.observation_id);
    if (!frame) throw unavailable('FIX_LIVE_CALLBACK_UNRESOLVED');
    const receiver = frame.direction === 'J_TO_G' ? 'go' : 'java',
      receiverPid = receiver === 'go' ? this.readyFrame.go_pid : this.readyFrame.java_pid;
    if (envelope.role !== receiver || envelope.receiver_pid !== receiverPid)
      throw unavailable('FIX_LIVE_CALLBACK_PROCESS');
    const callback = decodeLiveFix44(Buffer.from(envelope.callback_hex, 'hex'));
    if (semantic(callback.fields) !== semantic(frame.parsed.fields))
      throw unavailable('FIX_LIVE_CALLBACK_CORRESPONDENCE');
    const accepted = await this.call(
      frame.context,
      'ACCEPT',
      {
        order_id: frame.context.order_id,
        observation_id: envelope.observation_id,
        connection_id: this.connectionId,
        role: envelope.role,
        event_seq: envelope.event_seq,
        callback_hex: envelope.callback_hex,
      },
      frame.accept_key,
      {
        profile: liveProfile,
        runtime_hash: runtime.runtime_hash,
        session_id: runtime.session_id,
        store_id: runtime.store_id,
        connection_id: this.connectionId,
        role: envelope.role,
        pid: envelope.receiver_pid,
        event_seq: envelope.event_seq,
        callback_hash: createHash('sha256')
          .update(Buffer.from(envelope.callback_hex, 'hex'))
          .digest('hex'),
      },
    );
    const evidence = this.success(accepted, 201);
    const message = uuid.parse(evidence['message_id']);
    await this.write('ACK', { observation_id: envelope.observation_id, phase: 'ACCEPT' });
    const result =
      frame.parsed.type === 'D' ? accepted : await this.applyMessage(frame.context, message);
    if (frame.send) {
      if (this.active.get(frame.direction) === frame.send) this.active.delete(frame.direction);
      frame.send.done.resolve(result);
    }
  }
  private async applyMessage(context: Context, message_id: string): Promise<Result> {
    const retained = await this.options.journal.read('work', message_id);
    let work: Work;
    if (retained === undefined) {
      const state = this.success(
        await this.options.service.read(context.binding, 'STATE', context.order_id, context.verify),
        200,
      );
      const rows = z.array(z.object({ message_id: uuid }).passthrough()).parse(state['work']);
      if (rows.some((row) => row.message_id === message_id))
        throw unavailable('FIX_LIVE_ORIGINAL_INTENT_REQUIRED');
      if (!context.fence) throw unavailable('FIX_LIVE_FENCE_REQUIRED');
      // A SQL lease lasts15s; every new work item starts with a durable current CLAIM.
      // Retained work below keeps its original fence and financial/request identities.
      const claimed = this.success(
        await this.call(
          context,
          'CLAIM',
          { order_id: context.order_id, owner_id: context.owner_id },
          fixedKey('CLAIM', this.options.runtime.run_id, message_id),
        ),
        200,
      );
      context.fence = z.union([z.string(), z.number()]).parse(claimed['fence']).toString();
      work = {
        message_id,
        order_id: context.order_id,
        work_id: randomUUID(),
        financial_key: randomUUID(),
        queue_key: randomUUID(),
        prepare_key: randomUUID(),
        apply_key: randomUUID(),
        owner_id: context.owner_id,
        fence: context.fence,
      };
      await this.options.journal.retain('work', message_id, work);
    } else work = workSchema.parse(retained);
    if (work.order_id !== context.order_id || work.message_id !== message_id)
      throw unavailable('FIX_LIVE_ORIGINAL_INTENT_REQUIRED');
    this.success(
      await this.call(
        context,
        'QUEUE',
        { order_id: context.order_id, message_id, work_id: work.work_id },
        work.queue_key,
      ),
      201,
    );
    this.success(
      await this.call(
        context,
        'PREPARE',
        {
          order_id: context.order_id,
          owner_id: work.owner_id,
          fence: work.fence,
          work_id: work.work_id,
          financial_key: work.financial_key,
        },
        work.prepare_key,
      ),
      201,
    );
    const result = await this.call(
      context,
      'APPLY',
      {
        order_id: context.order_id,
        owner_id: work.owner_id,
        fence: work.fence,
        work_id: work.work_id,
      },
      work.apply_key,
    );
    this.success(result, 200);
    return result;
  }
  send(order_id: string, fields: Params): Promise<Result> {
    return this.admit(() => this.sendFrame(order_id, fields));
  }
  private async sendFrame(order_id: string, fields: Params): Promise<Result> {
    await this.awaitReady();
    this.requireCommandAdmission();
    if (this.reconnecting) throw unavailable('FIX_LIVE_RECONNECTING');
    const context = this.context(order_id);
    const direction = fields['35'] === 'D' || fields['35'] === 'F' ? 'J_TO_G' : 'G_TO_J';
    if (this.active.has(direction)) throw unavailable('FIX_LIVE_BACKPRESSURE');
    const parsed = z
      .record(z.string().regex(/^[1-9][0-9]{0,4}$/), z.string().regex(/^[ -~]{1,256}$/))
      .parse(fields);
    if (
      !['D', '8', 'F', '9'].includes(parsed['35'] ?? '') ||
      ['8', '9', '10', '34', '43', '49', '52', '56', '122'].some((tag) => tag in parsed)
    )
      throw unavailable('FIX_LIVE_SEND_PROFILE');
    if ((parsed['41'] ?? parsed['11']) !== order_id)
      throw unavailable('FIX_LIVE_SEND_CORRESPONDENCE');
    const command_id = randomUUID(),
      done = deferred<Result>(),
      copy = { ...parsed };
    // Reserve ownership before the first durable write yields to another caller.
    const pending = { command_id, order_id, fields: copy, done };
    this.active.set(direction, pending);
    try {
      await this.options.journal.retain('send', command_id, {
        order_id: context.order_id,
        command_id,
        connection_id: this.connectionId,
        direction,
        fields: copy,
      });
      this.requireCommandAdmission();
      await this.write('SEND', {
        command_id,
        role: direction === 'J_TO_G' ? 'java' : 'go',
        fields: copy,
      });
    } catch (error) {
      const failure = error instanceof DomainError ? error : unavailable();
      if (this.stopping && failure.code === 'FIX_LIVE_STOPPING') {
        if (this.active.get(direction) === pending) this.active.delete(direction);
        done.reject(failure);
      } else this.fail(failure);
    }
    return done.promise;
  }
  reconnect(restartRole: 'none' | 'go' | 'java' = 'none'): Promise<void> {
    return this.admit(() => this.reconnectSession(restartRole));
  }
  private async reconnectSession(restartRole: 'none' | 'go' | 'java'): Promise<void> {
    await this.awaitReady();
    this.requireCommandAdmission();
    if (this.reconnecting || this.active.size || this.events.length)
      throw unavailable('FIX_LIVE_RECONNECT_UNRESOLVED');
    if (this.connections.size >= 8 || !['none', 'go', 'java'].includes(restartRole))
      throw unavailable('FIX_LIVE_RECONNECT_BOUND');
    const pending = deferred<void>();
    this.reconnecting = pending;
    try {
      await this.processing;
      this.requireCommandAdmission();
      const command_id = randomUUID();
      await this.options.journal.retain('send', command_id, {
        kind: 'RECONNECT',
        command_id,
        connection_id: this.connectionId,
        restart_role: restartRole,
      });
      this.requireCommandAdmission();
      await this.write('RECONNECT', { command_id, restart_role: restartRole });
      await bounded(pending.promise, 15000);
    } catch (error) {
      const failure = error instanceof DomainError ? error : unavailable();
      if (this.stopping && failure.code === 'FIX_LIVE_STOPPING') pending.reject(failure);
      else this.fail(failure);
      throw failure;
    } finally {
      if (this.reconnecting === pending) this.reconnecting = undefined;
    }
  }
  async recoverKnown(key: string): Promise<Result> {
    if (!this.options.enabled) throw unavailable('FIX_LIVE_DISABLED');
    const retained = z
      .object({ order_id: uuid })
      .passthrough()
      .safeParse(await this.options.journal.read('request', key));
    if (!retained.success) throw unavailable('FIX_LIVE_ORIGINAL_INTENT_REQUIRED');
    const context = this.context(retained.data.order_id);
    return recoverLiveRequest(
      this.options.service,
      context.binding,
      context.actor_id,
      this.options.journal,
      key,
      context.verify,
      true,
    );
  }

  stop(): Promise<void> {
    return (this.stopping ??= this.finish());
  }
  private async finish(): Promise<void> {
    // Startup, send and reconnect admission closes synchronously in stop().
    // Draining their original caller promises, event handling
    // and STOP confirmation share the original15s budget; process exit keeps5s.
    const deadline = performance.now() + 15000;
    const remaining = () => {
      const milliseconds = deadline - performance.now();
      if (milliseconds <= 0) throw unavailable('FIX_LIVE_DEADLINE');
      return milliseconds;
    };
    try {
      await bounded(Promise.allSettled([...this.pendingOperations]), remaining());
      await bounded(this.processing, remaining());
      this.healthy();
      if (this.options.process.exitCode !== null) {
        if (this.options.process.exitCode !== 0) throw unavailable('FIX_LIVE_PROCESS_EXIT');
        return;
      }
      await bounded(this.write('STOP'), remaining());
      await bounded(this.stopped.promise, remaining());
      const code = await bounded(this.exited.promise, 5000);
      if (code !== 0) throw unavailable('FIX_LIVE_PROCESS_EXIT');
    } catch (error) {
      const failure = error instanceof DomainError ? error : unavailable();
      this.fail(failure);
      throw this.failure ?? failure;
    } finally {
      this.options.process.stdin.end();
    }
    this.healthy();
  }
}
