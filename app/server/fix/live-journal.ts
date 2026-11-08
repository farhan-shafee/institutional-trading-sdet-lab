/** Durable local request evidence only. SQL remains the financial authority. */
import { randomUUID } from 'node:crypto';
import { readdir, lstat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { loadPrivate, savePrivate } from '../../../scripts/private-state.js';
import { DomainError } from '../../domain/errors.js';
import { liveProfile } from '../../domain/workflow/live-database-contract.js';

const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const ownerSchema = z
  .object({
    run_id: uuid,
    session_id: uuid,
    store_id: uuid,
    runtime_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Identity = z.infer<typeof ownerSchema>;
const kinds = ['request', 'result', 'frame', 'work', 'send', 'unknown'] as const;
export type LiveJournalKind = (typeof kinds)[number];
// Disjoint run budgets: engine32MiB, journal24MiB, host stdio8MiB.
const maxBytes = 24 * 1024 * 1024,
  maxFiles = 4096,
  maxRecord = 24576;
function error(code: string): DomainError {
  return new DomainError(
    503,
    code,
    'Live FIX ownership evidence is unavailable. Retain the original journal.',
  );
}
function missing(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT';
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 16) throw error('LIVE_JOURNAL_INVALID');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => canonical(v, depth + 1)).join(',') + ']';
  if (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    const keys = Reflect.ownKeys(value);
    if (keys.some((k) => typeof k !== 'string')) throw error('LIVE_JOURNAL_INVALID');
    const fields = Object.getOwnPropertyDescriptors(value);
    return (
      '{' +
      Object.keys(fields)
        .sort()
        .map((k) => {
          const d = fields[k]!;
          if (!d.enumerable || !('value' in d)) throw error('LIVE_JOURNAL_INVALID');
          return JSON.stringify(k) + ':' + canonical(d.value, depth + 1);
        })
        .join(',') +
      '}'
    );
  }
  throw error('LIVE_JOURNAL_INVALID');
}

export class LiveJournal {
  private writes: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private closed = false;
  private readonly nonce = randomUUID();
  private constructor(
    readonly directory: string,
    readonly identity: Identity,
    private readonly readOnly: boolean,
  ) {}

  static async open(
    directory: string,
    identity: Identity,
    options: { readOnly?: boolean } = {},
  ): Promise<LiveJournal> {
    const parsed = ownerSchema.safeParse(identity);
    if (!parsed.success) throw error('LIVE_JOURNAL_INVALID');
    const journal = new LiveJournal(
      resolve(directory),
      Object.freeze({ ...parsed.data }),
      options.readOnly ?? false,
    );
    const ownerPath = join(journal.directory, 'owner.json');
    const expected = { version: 1, profile: liveProfile, ...parsed.data };
    try {
      let owner: unknown;
      try {
        owner = await loadPrivate(ownerPath);
      } catch (e) {
        if (!missing(e)) throw e;
      }
      if (owner === undefined) {
        if (journal.readOnly) throw error('LIVE_JOURNAL_UNAVAILABLE');
        const names = await readdir(journal.directory);
        if (names.length) throw error('LIVE_JOURNAL_UNAVAILABLE');
        await savePrivate(ownerPath, expected);
      } else if (canonical(owner) !== canonical(expected))
        throw error('LIVE_JOURNAL_IDENTITY_CONFLICT');
      await journal.usage();
      if (!journal.readOnly) {
        try {
          await savePrivate(join(journal.directory, '.writer.json'), {
            version: 1,
            run_id: parsed.data.run_id,
            nonce: journal.nonce,
            pid: process.pid,
          });
        } catch (e) {
          if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'EEXIST')
            throw error('LIVE_JOURNAL_ALREADY_OWNED');
          throw e;
        }
      }
      return journal;
    } catch (e) {
      if (e instanceof DomainError) throw e;
      throw error('LIVE_JOURNAL_UNAVAILABLE');
    }
  }

  private path(kind: LiveJournalKind, id: string): string {
    if (!kinds.includes(kind) || !uuid.safeParse(id).success) throw error('LIVE_JOURNAL_INVALID');
    return join(this.directory, `${kind}-${id}.json`);
  }
  async usage(): Promise<number> {
    const names = await readdir(this.directory);
    if (names.length > maxFiles) throw error('LIVE_JOURNAL_BOUND');
    let bytes = 0;
    for (const name of names) {
      if (
        name !== 'owner.json' &&
        name !== '.writer.json' &&
        !/^(request|result|frame|work|send|unknown)-[a-f0-9-]{36}\.json$/.test(name)
      )
        throw error('LIVE_JOURNAL_UNAVAILABLE');
      const info = await lstat(join(this.directory, name));
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0
      )
        throw error('LIVE_JOURNAL_UNAVAILABLE');
      bytes += info.size;
      if (bytes > maxBytes) throw error('LIVE_JOURNAL_BOUND');
    }
    return bytes;
  }
  retain(kind: LiveJournalKind, id: string, value: unknown): Promise<void> {
    if (this.readOnly) return Promise.reject(error('LIVE_JOURNAL_READ_ONLY'));
    if (this.closed || this.closing) return Promise.reject(error('LIVE_JOURNAL_UNAVAILABLE'));
    const retained = this.writes.then(async () => {
      const path = this.path(kind, id),
        normalized = canonical(value);
      const record = {
        version: 1,
        profile: liveProfile,
        run_id: this.identity.run_id,
        kind,
        id,
        value: JSON.parse(normalized) as unknown,
      };
      const bytes = Buffer.byteLength(JSON.stringify(record, null, 2) + '\n');
      if (bytes > maxRecord) throw error('LIVE_JOURNAL_BOUND');
      try {
        let prior: unknown;
        try {
          prior = await loadPrivate(path);
        } catch (e) {
          if (!missing(e)) throw e;
        }
        if (prior !== undefined) {
          if (canonical(prior) !== canonical(record)) throw error('LIVE_JOURNAL_INTENT_CONFLICT');
          return;
        }
        if (
          (await this.usage()) + bytes > maxBytes ||
          (await readdir(this.directory)).length >= maxFiles
        )
          throw error('LIVE_JOURNAL_BOUND');
        await savePrivate(path, record);
      } catch (e) {
        if (e instanceof DomainError) throw e;
        throw error('LIVE_JOURNAL_UNAVAILABLE');
      }
    });
    this.writes = retained.then(
      () => undefined,
      () => undefined,
    );
    return retained;
  }
  async read(kind: LiveJournalKind, id: string): Promise<unknown> {
    await this.writes;
    if (this.closed) throw error('LIVE_JOURNAL_UNAVAILABLE');
    const path = this.path(kind, id);
    try {
      const record = z
        .object({
          version: z.literal(1),
          profile: z.literal(liveProfile),
          run_id: z.literal(this.identity.run_id),
          kind: z.literal(kind),
          id: z.literal(id),
          value: z.unknown(),
        })
        .strict()
        .parse(await loadPrivate(path));
      canonical(record.value);
      return record.value;
    } catch (e) {
      if (missing(e)) return undefined;
      throw error('LIVE_JOURNAL_UNAVAILABLE');
    }
  }
  async entries(kind: LiveJournalKind): Promise<Array<{ id: string; value: unknown }>> {
    await this.writes;
    await this.usage();
    const rows = [];
    for (const name of (await readdir(this.directory)).sort())
      if (name.startsWith(kind + '-')) {
        const id = name.slice(kind.length + 1, -5);
        rows.push({ id, value: await this.read(kind, id) });
      }
    return rows;
  }
  close(): Promise<void> {
    return (this.closing ??= this.release());
  }
  private async release(): Promise<void> {
    await this.writes;
    try {
      if (!this.readOnly) {
        const path = join(this.directory, '.writer.json');
        const lock = z
          .object({
            version: z.literal(1),
            run_id: z.literal(this.identity.run_id),
            nonce: z.literal(this.nonce),
            pid: z.literal(process.pid),
          })
          .strict()
          .parse(await loadPrivate(path));
        if (lock.nonce !== this.nonce) throw error('LIVE_JOURNAL_UNAVAILABLE');
        await unlink(path);
      }
    } catch {
      throw error('LIVE_JOURNAL_UNAVAILABLE');
    } finally {
      this.closed = true;
    }
  }
}
