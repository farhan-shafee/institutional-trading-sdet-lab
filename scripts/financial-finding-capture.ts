/** Test-only observation of existing query results. No additional SQL or financial decisions. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const MAX_RECORD = 65536;
const MAX_EVENTS = 16; // Reserve the last event for an explicit incomplete-budget notice.
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Query = (this: object, ...args: unknown[]) => unknown;
type Sink = (json: string) => void;
type FinancialSource = { name: string; sql: string; sha256: string; keys: string[] };
type CaptureSources = { snapshotSql: string; financial: FinancialSource[] };
const pinned = [
  [
    'foundation',
    'foundation.sql',
    '25744f24ab04d19c9ebc8afa3510d5cc78d853fce234ee710067e0f10be1e745',
    ['sandbox_id', 'invariant'],
  ],
  [
    'rfq',
    'rfq.sql',
    '7dc1499dcc8173996df9efe0b22daf92aa06bdf82cd8513c4a61115a141b11e3',
    ['sandbox_id', 'rfq_id', 'invariant'],
  ],
  [
    'executions',
    'executions.sql',
    'b5f6308e13d3d9ca47e147b202c51691eed47329ff6878c06cfa21b2b6f9caca',
    ['sandbox_id', 'order_id', 'invariant'],
  ],
  [
    'comparisons',
    'reconciliation.sql',
    '296b390b28639d4857dcaf5796de736f05f91a1eb48c4ad4cd883cad70277b1e',
    ['category', 'code', 'record_kind', 'record_id', 'related', 'expected', 'observed'],
  ],
] as const;

export function captureWorker(worker: string | undefined, root = process.cwd()): boolean {
  if (!worker) return false;
  return [
    'tests/postgres/fix-capacity-admission.test.ts',
    'tests/diagnostics/financial-finding-capture.demo.ts',
  ].includes(relative(resolve(root), resolve(root, worker)));
}

export async function loadCaptureSources(): Promise<CaptureSources> {
  async function checked(file: string, sha256: string) {
    const sql = await readFile(new URL('../verification/sql/' + file, import.meta.url), 'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== sha256)
      throw new Error('Financial capture SQL fingerprint mismatch.');
    return sql;
  }
  const snapshotSql = await checked(
    'fix_application_v2.sql',
    '169fda4ea6ec828721fe551b3843daf802870ecf82839453d10dcc10a7979211',
  );
  const financial = await Promise.all(
    pinned.map(async ([name, file, sha256, keys]) => {
      const query = (await checked(file, sha256)).trim().replace(/;$/, '');
      return {
        name,
        sha256,
        keys: [...keys],
        sql: name === 'comparisons' ? query : `SELECT * FROM (${query}) v WHERE sandbox_id=$1`,
      };
    }),
  );
  return { snapshotSql, financial };
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

// Reject unsafe/unknown data rather than silently redacting a row and calling it exact.
function safeRows(rows: unknown[], keys: string[]): unknown[] {
  let nodes = 0;
  const seen = new Set<object>();
  function copy(value: unknown, depth = 0): unknown {
    if (++nodes > 2048 || depth > 8) throw new Error('bounded');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      if (
        value.length > 4096 ||
        /(?:postgres(?:ql)?:\/\/|https?:\/\/|bearer\s+|(?:password|token|secret|proof|digest|nonce|authorization)\s*[:=])/i.test(
          value,
        )
      )
        throw new Error('unsafe');
      // Original comparisons can contain contract/terms JSON encoded as strings.
      // Validate decoded content under the same bounds, retaining safe string bytes exactly.
      if (/^[{["]/.test(value.trimStart())) {
        const decoded: unknown = JSON.parse(value);
        copy(decoded, depth + 1);
      }
      return value;
    }
    if ((!record(value) && !Array.isArray(value)) || seen.has(value)) throw new Error('unsafe');
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.keys(descriptors);
    if (names.length > 128) throw new Error('bounded');
    const output = Object.create(null) as Record<string, unknown>;
    for (const name of names) {
      const d = descriptors[name]!;
      if (Array.isArray(value) && name === 'length') continue;
      if (
        !d.enumerable ||
        !('value' in d) ||
        /(?:proof|digest|token|secret|password|nonce|authorization|connection|raw_hex)/i.test(name)
      )
        throw new Error('unsafe');
      output[name] = copy(d.value as unknown, depth + 1);
    }
    seen.delete(value);
    return Array.isArray(value) ? Object.values(output) : output;
  }
  return rows.map((row) => {
    if (!record(row) || Object.keys(row).sort().join() !== [...keys].sort().join())
      throw new Error('shape');
    return copy(row);
  });
}

function snapshotContext(value: unknown): Record<string, unknown> | undefined {
  if (!record(value)) return;
  const names = [
    'profile',
    'physical_schema_revision',
    'snapshot_id',
    'snapshot_at',
    'financial_watermark',
    'protocol_watermark',
    'protocol_ingest_watermark',
    'protocol_prepare_watermark',
    'protocol_application_watermark',
  ];
  const context: Record<string, unknown> = {};
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const name of names) {
    const d = descriptors[name];
    if (!d || !('value' in d)) return;
    context[name] = d.value as unknown;
  }
  if (
    context['profile'] !== 'fix-application-v2' ||
    context['physical_schema_revision'] !== 8 ||
    typeof context['snapshot_id'] !== 'string' ||
    !/^[0-9:,]{1,4096}$/.test(context['snapshot_id']) ||
    !(context['snapshot_at'] instanceof Date) ||
    !Number.isFinite(context['snapshot_at'].getTime()) ||
    names
      .slice(4)
      .some((key) => typeof context[key] !== 'string' || !/^[0-9]{1,4}$/.test(context[key]))
  )
    return;
  context['snapshot_at'] = context['snapshot_at'].toISOString();
  return context;
}

export class FinancialFindingRecorder {
  private readonly contexts = new WeakMap<
    object,
    { sandbox: string; value: Record<string, unknown> }
  >();
  private events = 0;
  private warned = false;
  constructor(
    private readonly sources: CaptureSources,
    private readonly sink: Sink,
  ) {}

  wrap(original: Query, allowed: (client: object) => boolean = () => true): Query {
    const observe = this.observe.bind(this),
      incomplete = this.incomplete.bind(this),
      contexts = this.contexts,
      sources = this.sources;
    return function (this: object, ...args: unknown[]): unknown {
      const result: unknown = Reflect.apply(original, this, args);
      if (args.length > 2 || typeof args[0] !== 'string' || !(result instanceof Promise))
        return result;
      try {
        if (!allowed(this)) return result;
      } catch {
        incomplete();
        return result;
      }
      const sql = args[0];
      if (/^(?:BEGIN|COMMIT|ROLLBACK)(?:\s|$)/.test(sql)) contexts.delete(this);
      const source = sources.financial.find((entry) => entry.sql === sql);
      if (!source && sql !== sources.snapshotSql) return result;
      const values = args[1];
      if (
        !Array.isArray(values) ||
        values.length !== 1 ||
        typeof values[0] !== 'string' ||
        !uuid.test(values[0])
      )
        return result;
      const sandbox = values[0];
      return result.then((value: unknown) => {
        try {
          observe(this, sandbox, source, value);
        } catch {
          incomplete();
        }
        return value;
      });
    };
  }

  private incomplete() {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write(
      'TF_FINANCIAL_CAPTURE_INCOMPLETE: observer or sink failed; original query outcome preserved.\n',
    );
  }

  private observe(
    client: object,
    sandbox: string,
    source: FinancialSource | undefined,
    result: unknown,
  ) {
    if (typeof result !== 'object' || result === null) return;
    const descriptor = Object.getOwnPropertyDescriptor(result, 'rows');
    if (!descriptor || !('value' in descriptor) || !Array.isArray(descriptor.value)) return;
    const rows: unknown[] = descriptor.value;
    if (!source) {
      this.contexts.delete(client);
      const context = rows.length === 1 ? snapshotContext(rows[0]) : undefined;
      if (context) this.contexts.set(client, { sandbox, value: context });
      return;
    }
    if (!rows.length || this.events >= MAX_EVENTS) return;
    this.events++;
    if (this.events === MAX_EVENTS) {
      this.sink(
        JSON.stringify({
          version: 1,
          status: 'INCOMPLETE',
          reason: 'WORKER_CAPTURE_LIMIT',
          rows: [],
          finding_count: rows.length,
          omitted_rows: rows.length,
        }) + '\n',
      );
      return;
    }
    const context = this.contexts.get(client);
    const snapshot = context?.sandbox === sandbox ? context.value : null;
    let copied: unknown[] = [],
      reason = snapshot ? null : 'MISSING_SNAPSHOT_CONTEXT';
    try {
      copied = safeRows(rows, source.keys);
    } catch {
      reason = 'UNSAFE_OR_OVERSIZE_ROWS';
    }
    const event: Record<string, unknown> = {
      version: 1,
      status: reason ? 'INCOMPLETE' : 'COMPLETE',
      reason,
      layer: source.name,
      query_sha256: source.sha256,
      sandbox_id: sandbox,
      snapshot,
      finding_count: rows.length,
      omitted_rows: rows.length - copied.length,
      rows: copied,
    };
    let json = JSON.stringify(event) + '\n';
    // Leave room for the private sink's persistence status. No partial row serialization.
    if (Buffer.byteLength(json) > MAX_RECORD - 1024) {
      event['status'] = 'INCOMPLETE';
      event['reason'] = 'RECORD_SIZE_LIMIT';
      event['rows'] = [];
      event['omitted_rows'] = rows.length;
      json = JSON.stringify(event) + '\n';
    }
    this.sink(json);
  }
}

export function privateCaptureSink(
  root = resolve('artifacts'),
  log: Sink = (json) => process.stdout.write('TF_FINANCIAL_FINDING ' + json),
): Sink {
  let directory: string | undefined;
  let index = 0;
  return (json) => {
    if (Buffer.byteLength(json) > MAX_RECORD - 1024)
      throw new Error('Capture record exceeded bound.');
    try {
      root = resolve(root);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const info = lstatSync(root);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o022) !== 0 ||
        realpathSync(root) !== root
      )
        throw new Error('unsafe');
      directory ??= mkdtempSync(join(root, 'financial-findings-'));
      writeFileSync(join(directory, `finding-${++index}.json`), json, {
        mode: 0o600,
        flag: 'wx',
        flush: true,
      });
      log(json);
    } catch {
      const event = JSON.parse(json) as Record<string, unknown>;
      log(JSON.stringify({ ...event, status: 'INCOMPLETE', persistence: 'FAILED' }) + '\n');
    }
  };
}
