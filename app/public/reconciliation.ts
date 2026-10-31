import { z } from 'zod';
import {
  reconciliationListSchema,
  reconciliationDetailSchema,
  reconciliationFindingsSchema,
  reconciliationReferenceSchema,
  findingCategories,
  type ReconciliationDetail,
  type Finding,
} from '../domain/workflow/reconciliation.js';
import type { RetainedRfqCommand } from '../domain/workflow/rfq-journal.js';
type Api = (
  path: string,
  method?: string,
  body?: unknown,
  key?: string,
  stillCurrent?: () => boolean,
  signal?: AbortSignal,
) => Promise<{ response: Response; data: unknown }>;
type Context = { sandbox: string | undefined; token: string | null; epoch: number };
type Identity = {
  context: Context;
  sandbox: string;
  run: string | undefined;
  generation: number;
  listing?: number;
  investigation: number | undefined;
  signal: AbortSignal;
};
class StaleRead extends Error {}
/** Investigation uses a pre-existing binding; all retained material is non-secret. */
export function reconciliationView(
  api: Api,
  mutate: (path: string, body: RetainedRfqCommand['body']) => Promise<void>,
  run: (work: () => Promise<void>, stillCurrent: () => boolean) => Promise<void>,
  canMutate: () => boolean,
  getContext: () => Context,
) {
  const node = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const selection = node<HTMLSelectElement>('recon-selection'),
    category = node<HTMLSelectElement>('recon-category'),
    record = node<HTMLInputElement>('recon-record');
  let sandbox: string | undefined,
    configured = false,
    selected: string | undefined,
    detail: ReconciliationDetail | undefined,
    findings: (Finding & { ordinal: number })[] = [],
    shown = 5,
    generation = 0,
    investigation = 0,
    listGeneration = 0,
    readState: 'idle' | 'loading' | 'unavailable' = 'idle',
    errorSource: 'read' | 'trace' | undefined;
  let mainController = new AbortController(),
    traceController = new AbortController();
  function invalidateMain() {
    mainController.abort();
    traceController.abort();
    mainController = new AbortController();
    traceController = new AbortController();
    generation++;
    investigation++;
  }
  function invalidateTrace() {
    traceController.abort();
    traceController = new AbortController();
    investigation++;
  }
  const root = (id: string) => `/api/fixed-income/v1/sandboxes/${id}`;
  const identity = (trace?: number): Identity | undefined =>
    sandbox
      ? {
          context: getContext(),
          sandbox,
          run: selected,
          generation,
          investigation: trace,
          signal: trace === undefined ? mainController.signal : traceController.signal,
        }
      : undefined;
  function current(id: Identity) {
    const context = getContext();
    return (
      sandbox === id.sandbox &&
      context.sandbox === id.sandbox &&
      selected === id.run &&
      generation === id.generation &&
      (id.listing === undefined || id.listing === listGeneration) &&
      context.epoch === id.context.epoch &&
      context.token === id.context.token &&
      !id.signal.aborted &&
      (id.investigation === undefined || id.investigation === investigation)
    );
  }
  function launch(id: Identity, work: () => Promise<void>, mainRead = true) {
    void work().catch((error: unknown) => {
      if (!(error instanceof StaleRead) && current(id)) {
        if (mainRead) {
          readState = 'unavailable';
          render();
        }
        errorSource = mainRead ? 'read' : 'trace';
        node('recon-error').textContent =
          error instanceof Error ? error.message : 'Reconciliation unavailable.';
      }
    });
  }
  const read = async (id: Identity, path: string) => {
    if (!current(id)) throw new StaleRead();
    let r: Awaited<ReturnType<Api>>;
    try {
      r = await api(path, 'GET', undefined, undefined, () => current(id), id.signal);
    } catch (error) {
      if (!current(id)) throw new StaleRead();
      throw error;
    }
    if (!current(id)) throw new StaleRead();
    if (!r.response.ok)
      throw new Error(`Reconciliation read unavailable (HTTP ${r.response.status}).`);
    return r.data;
  };
  function reset() {
    invalidateMain();
    readState = 'idle';
    errorSource = undefined;
    sandbox = undefined;
    configured = false;
    selected = undefined;
    detail = undefined;
    findings = [];
    selection.replaceChildren();
    node('recon-panel').hidden = true;
    node('recon-summary').textContent = '';
    node('recon-error').textContent = '';
    node('recon-provenance').textContent = '';
    node('recon-trace').textContent = '';
    node('recon-findings').replaceChildren();
    category.value = '';
    record.value = '';
  }
  async function loadDetail(id: Identity) {
    if (!id.run) return;
    const nextDetail = reconciliationDetailSchema.parse(
      await read(id, `${root(id.sandbox)}/reconciliation-runs/${id.run}`),
    );
    if (nextDetail.run.id !== id.run) throw new Error('Reconciliation run mismatch.');
    const nextFindings: (Finding & { ordinal: number })[] = [];
    let after = 0,
      asOf: number | undefined;
    do {
      const page = reconciliationFindingsSchema.parse(
        await read(
          id,
          `${root(id.sandbox)}/reconciliation-runs/${id.run}/findings?limit=20&after=${after}`,
        ),
      );
      if (page.run_id !== id.run || (asOf !== undefined && asOf !== page.as_of))
        throw new Error('Reconciliation finding snapshot changed.');
      asOf = page.as_of;
      for (const finding of page.findings) {
        if (finding.ordinal !== nextFindings.length + 1) throw new Error('Invalid finding page.');
        nextFindings.push(finding);
      }
      if (page.next_after === null) {
        if (nextFindings.length !== page.as_of) throw new Error('Invalid finding page.');
        break;
      }
      if (
        page.next_after <= after ||
        page.next_after !== nextFindings.length ||
        page.next_after >= page.as_of
      )
        throw new Error('Invalid finding page.');
      after = page.next_after;
      if (nextFindings.length >= 128) throw new Error('Finding retention bound exceeded.');
    } while (nextFindings.length < 128);
    if (
      nextDetail.run.finding_count !== asOf ||
      nextDetail.run.finding_count !== nextFindings.length
    )
      throw new Error('Reconciliation finding count changed.');
    if (!current(id)) throw new StaleRead();
    detail = nextDetail;
    findings = nextFindings;
    readState = 'idle';
    shown = 5;
    node('recon-trace').textContent = '';
    render();
  }
  function load(sandboxId: string | undefined, preservePresentation = false) {
    if (sandbox !== sandboxId) {
      reset();
      sandbox = sandboxId;
      preservePresentation = false;
    }
    node('recon-panel').hidden = !sandboxId;
    if (!sandboxId) return;
    // A replacement list must also own detail retrieval if no validated selection
    // exists yet, or it supersedes the list belonging to a full refresh.
    if (readState === 'loading' || !selected) preservePresentation = false;
    if (!preservePresentation) {
      invalidateMain();
      readState = 'loading';
      errorSource = undefined;
      node('recon-error').textContent = '';
      detail = undefined;
      findings = [];
      node('recon-trace').textContent = '';
    }
    const id = identity();
    if (!id) return;
    id.listing = ++listGeneration;
    render();
    launch(id, async () => {
      const nextConfigured = z
        .object({ configured: z.boolean() })
        .strict()
        .parse(await read(id, '/api/fixed-income/v1/reconciliation/status')).configured;
      const list = reconciliationListSchema.parse(
        await read(id, `${root(id.sandbox)}/reconciliation-runs?limit=20`),
      );
      if (!current(id)) throw new StaleRead();
      if (preservePresentation && selected && !list.runs.some((r) => r.id === selected))
        throw new Error('Selected reconciliation run missing from refreshed list.');
      configured = nextConfigured;
      selection.replaceChildren();
      for (const item of list.runs) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `Run ${item.run_no} · ${item.state} · ${item.id}`;
        selection.append(option);
      }
      if (!list.runs.some((r) => r.id === selected)) {
        selected = list.runs.at(-1)?.id;
        generation++;
        detail = undefined;
        findings = [];
      }
      selection.value = selected ?? '';
      if (preservePresentation) return;
      const next = identity();
      if (selected && next) launch(next, () => loadDetail(next));
      else {
        detail = undefined;
        findings = [];
        readState = 'idle';
        render();
      }
    });
  }
  function captureSelection() {
    const captured = identity(investigation);
    return () => captured !== undefined && current(captured);
  }
  function validate(value: unknown, stillSelected: () => boolean) {
    const reference = reconciliationReferenceSchema.parse(value);
    if (!stillSelected()) return;
    selected = reference.run_id;
    invalidateMain();
    readState = 'loading';
    errorSource = undefined;
    detail = undefined;
    findings = [];
    node('recon-error').textContent = '';
    node('recon-trace').textContent = '';
    render();
  }
  async function trace(id: Identity, f: Finding) {
    const records: Record<string, unknown> = {
      historical_finding: f,
      current_records_observed_separately: true,
    };
    if (f.related.rfq_id)
      records.rfq = await read(id, `${root(id.sandbox)}/rfqs/${f.related.rfq_id}`);
    if (f.related.order_id)
      records.order = await read(id, `${root(id.sandbox)}/orders/${f.related.order_id}`);
    records.positions = await read(id, `${root(id.sandbox)}/positions`);
    const auditSchema = z
      .object({
        events: z
          .array(
            z
              .object({
                command_seq: z.string().regex(/^\d{1,3}$/),
                event_index: z.number().int(),
                payload: z.record(z.string(), z.unknown()),
              })
              .passthrough(),
          )
          .max(100),
        as_of_seq: z.string(),
        next_cursor: z.string().nullable(),
      })
      .strict();
    const events: z.infer<typeof auditSchema>['events'] = [];
    let cursor: string | null = null,
      asof: string | undefined;
    for (let page = 0; page < 11; page++) {
      const result = auditSchema.parse(
        await read(
          id,
          `${root(id.sandbox)}/audit-events?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
        ),
      );
      if (asof !== undefined && asof !== result.as_of_seq)
        throw new Error('Audit snapshot changed.');
      asof = result.as_of_seq;
      events.push(...result.events);
      cursor = result.next_cursor;
      if (cursor === null) break;
    }
    if (cursor !== null) throw new Error('Audit retention bound exceeded.');
    records.audit_as_of_seq = asof;
    records.audit_events = events.filter((e) =>
      f.related.command_seq
        ? e.command_seq === f.related.command_seq
        : f.related.order_id
          ? e.payload.order_id === f.related.order_id
          : f.related.rfq_id
            ? e.payload.rfq_id === f.related.rfq_id
            : true,
    );

    if (!current(id)) throw new StaleRead();
    node('recon-trace').textContent = JSON.stringify(records, null, 2);
  }
  function render() {
    const context = getContext();
    const active = detail?.run.id === selected && context.sandbox === sandbox ? detail : undefined;
    node<HTMLButtonElement>('recon-request').disabled =
      !sandbox ||
      !configured ||
      !canMutate() ||
      (!!selected && !active) ||
      active?.run.state === 'RUNNING' ||
      active?.run.state === 'REQUESTED';
    node<HTMLButtonElement>('recon-recover').hidden = !canMutate();
    node<HTMLButtonElement>('recon-recover').disabled =
      !sandbox ||
      !configured ||
      !selected ||
      !canMutate() ||
      !['RUNNING', 'REQUESTED'].includes(active?.run.state ?? '');
    node<HTMLButtonElement>('recon-refresh').disabled = !sandbox;
    const r = active?.run;
    node('recon-summary').textContent = !sandbox
      ? ''
      : r
        ? `Synthetic historical/as-of assessment · ${r.state} · ${r.complete ? 'Verification complete' : 'NOT a passing result: incomplete or in progress'} · snapshot watermark ${r.source_watermark ?? 'not captured'} · currently observed financial command ${active.observed_command_seq} · ${r.id === active.latest_completed_run_id ? 'latest completed run' : 'prior or non-completed run'} · findings ${r.finding_count}/${r.total_findings} · ${r.failure_reason ?? 'no failure reason'}. Commands after the watermark require a newer run.`
        : readState === 'unavailable'
          ? 'Reconciliation read unavailable.'
          : readState === 'loading' || selected
            ? 'Loading selected reconciliation run.'
            : 'No retained reconciliation runs. Request a synthetic assessment of this authorized sandbox.';
    node('recon-provenance').textContent = active
      ? JSON.stringify(
          {
            run_id: r!.id,
            snapshot_id: r!.snapshot_id,
            snapshot_at: r!.snapshot_at,
            source: r!.source_metadata,
            coverage: r!.coverage,
            events: active.events,
            report_hash: r!.report_hash,
          },
          null,
          2,
        )
      : '';
    const list = node('recon-findings');
    list.replaceChildren();
    const filtered = findings.filter(
      (f) =>
        (!category.value || f.category === category.value) &&
        (!record.value ||
          JSON.stringify({ record_id: f.record_id, related: f.related }).includes(
            record.value.trim(),
          )),
    );
    for (const f of filtered.slice(0, shown)) {
      const row = document.createElement('section'),
        heading = document.createElement('h4'),
        values = document.createElement('pre'),
        button = document.createElement('button');
      heading.textContent = `${f.ordinal} · ${f.category} · ${f.code} · ${f.record_kind} ${f.record_id}`;
      values.textContent = JSON.stringify(
        { expected: f.expected, recorded: f.observed, immutable_evidence: f.related },
        null,
        2,
      );
      button.type = 'button';
      button.textContent = `Trace finding ${f.ordinal}`;
      button.addEventListener('click', () => {
        invalidateTrace();
        node('recon-trace').textContent = '';
        node('recon-error').textContent = '';
        errorSource = undefined;
        const id = identity(investigation);
        if (id && current(id) && detail?.run.id === id.run) launch(id, () => trace(id, f), false);
      });
      row.append(heading, values, button);
      list.append(row);
    }
    node<HTMLButtonElement>('recon-more').disabled = shown >= filtered.length;
    node('recon-filter-count').textContent =
      `${filtered.length} of ${findings.length} retained findings match. Findings are immutable evidence from this run.`;
  }
  for (const value of findingCategories) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    category.append(option);
  }
  selection.addEventListener('change', () => {
    selected = selection.value;
    invalidateMain();
    readState = selected ? 'loading' : 'idle';
    errorSource = undefined;
    detail = undefined;
    findings = [];
    node('recon-error').textContent = '';
    node('recon-trace').textContent = '';
    render();
    const id = identity();
    if (id && id.run) launch(id, () => loadDetail(id));
  });
  category.addEventListener('change', () => {
    invalidateTrace();
    node('recon-trace').textContent = '';
    if (errorSource === 'trace') {
      node('recon-error').textContent = '';
      errorSource = undefined;
    }
    shown = 5;
    render();
  });
  record.addEventListener('input', () => {
    invalidateTrace();
    node('recon-trace').textContent = '';
    if (errorSource === 'trace') {
      node('recon-error').textContent = '';
      errorSource = undefined;
    }
    shown = 5;
    render();
  });
  node('recon-more').addEventListener('click', () => {
    shown += 5;
    render();
  });
  node('recon-refresh').addEventListener('click', () => {
    load(sandbox);
  });
  node('recon-request').addEventListener('click', () => {
    const id = identity();
    if (!id || !current(id) || !configured || !canMutate()) return;
    const runId = crypto.randomUUID();
    void run(async () => {
      if (current(id)) await mutate(`${root(id.sandbox)}/reconciliation-runs`, { run_id: runId });
    }, captureSelection());
  });
  node('recon-recover').addEventListener('click', () => {
    const id = identity();
    if (
      !id?.run ||
      !current(id) ||
      !configured ||
      !canMutate() ||
      detail?.run.id !== id.run ||
      !['RUNNING', 'REQUESTED'].includes(detail.run.state)
    )
      return;
    void run(async () => {
      if (current(id))
        await mutate(`${root(id.sandbox)}/reconciliation-runs/${id.run}/recover`, {});
    }, captureSelection());
  });
  return { reset, load, render, validate, captureSelection };
}
