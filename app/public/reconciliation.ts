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
type Api = (path: string) => Promise<{ response: Response; data: unknown }>;
/** Investigation uses a pre-existing binding; all retained material is non-secret. */
export function reconciliationView(
  api: Api,
  mutate: (path: string, body: RetainedRfqCommand['body']) => Promise<void>,
  run: (work: () => Promise<void>) => Promise<void>,
  canMutate: () => boolean,
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
    shown = 5;
  const root = () => `/api/fixed-income/v1/sandboxes/${sandbox}`;
  const read = async (path: string) => {
    const r = await api(path);
    if (!r.response.ok)
      throw new Error(`Reconciliation read unavailable (HTTP ${r.response.status}).`);
    return r.data;
  };
  function reset() {
    sandbox = undefined;
    selected = undefined;
    detail = undefined;
    findings = [];
    selection.replaceChildren();
    node('recon-panel').hidden = true;
    node('recon-summary').textContent = '';
    node('recon-provenance').textContent = '';
    node('recon-trace').textContent = '';
    node('recon-findings').replaceChildren();
    category.value = '';
    record.value = '';
  }
  async function loadDetail() {
    if (!selected) return;
    detail = reconciliationDetailSchema.parse(
      await read(`${root()}/reconciliation-runs/${selected}`),
    );
    findings = [];
    let after = 0;
    do {
      const page = reconciliationFindingsSchema.parse(
        await read(`${root()}/reconciliation-runs/${selected}/findings?limit=20&after=${after}`),
      );
      findings.push(...page.findings);
      if (page.next_after === null) break;
      if (page.next_after <= after) throw new Error('Invalid finding page.');
      after = page.next_after;
    } while (findings.length < 128);
    shown = 5;
    node('recon-trace').textContent = '';
    render();
  }
  async function load(id: string | undefined) {
    if (sandbox !== id) {
      reset();
      sandbox = id;
    }
    node('recon-panel').hidden = !id;
    if (!id) return;
    configured = z
      .object({ configured: z.boolean() })
      .strict()
      .parse(await read('/api/fixed-income/v1/reconciliation/status')).configured;
    const list = reconciliationListSchema.parse(
      await read(`${root()}/reconciliation-runs?limit=20`),
    );
    selection.replaceChildren();
    for (const item of list.runs) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `Run ${item.run_no} · ${item.state} · ${item.id}`;
      selection.append(option);
    }
    if (!list.runs.some((r) => r.id === selected)) selected = list.runs.at(-1)?.id;
    selection.value = selected ?? '';
    if (selected) await loadDetail();
    else {
      detail = undefined;
      findings = [];
      render();
    }
  }
  function validate(value: unknown) {
    selected = reconciliationReferenceSchema.parse(value).run_id;
  }
  async function trace(f: Finding) {
    const records: Record<string, unknown> = {
      historical_finding: f,
      current_records_observed_separately: true,
    };
    if (f.related.rfq_id) records.rfq = await read(`${root()}/rfqs/${f.related.rfq_id}`);
    if (f.related.order_id) records.order = await read(`${root()}/orders/${f.related.order_id}`);
    records.positions = await read(`${root()}/positions`);
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
          `${root()}/audit-events?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
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

    node('recon-trace').textContent = JSON.stringify(records, null, 2);
  }
  function render() {
    node<HTMLButtonElement>('recon-request').disabled =
      !sandbox ||
      !configured ||
      !canMutate() ||
      detail?.run.state === 'RUNNING' ||
      detail?.run.state === 'REQUESTED';
    node<HTMLButtonElement>('recon-recover').hidden = !canMutate();
    node<HTMLButtonElement>('recon-recover').disabled =
      !sandbox ||
      !selected ||
      !canMutate() ||
      !['RUNNING', 'REQUESTED'].includes(detail?.run.state ?? '');
    node<HTMLButtonElement>('recon-refresh').disabled = !sandbox;
    const r = detail?.run;
    node('recon-summary').textContent = r
      ? `Synthetic historical/as-of assessment · ${r.state} · ${r.complete ? 'Verification complete' : 'NOT a passing result: incomplete or in progress'} · snapshot watermark ${r.source_watermark ?? 'not captured'} · currently observed financial command ${detail!.observed_command_seq} · ${r.id === detail!.latest_completed_run_id ? 'latest completed run' : 'prior or non-completed run'} · findings ${r.finding_count}/${r.total_findings} · ${r.failure_reason ?? 'no failure reason'}. Commands after the watermark require a newer run.`
      : 'No retained reconciliation runs. Request a synthetic assessment of this authorized sandbox.';
    node('recon-provenance').textContent = detail
      ? JSON.stringify(
          {
            run_id: r!.id,
            snapshot_id: r!.snapshot_id,
            snapshot_at: r!.snapshot_at,
            source: r!.source_metadata,
            coverage: r!.coverage,
            events: detail.events,
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
        void run(() => trace(f));
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
    void run(loadDetail);
  });
  category.addEventListener('change', () => {
    shown = 5;
    render();
  });
  record.addEventListener('input', () => {
    shown = 5;
    render();
  });
  node('recon-more').addEventListener('click', () => {
    shown += 5;
    render();
  });
  node('recon-refresh').addEventListener('click', () => {
    void run(() => load(sandbox));
  });
  node('recon-request').addEventListener('click', () => {
    void run(() => mutate(`${root()}/reconciliation-runs`, { run_id: crypto.randomUUID() }));
  });
  node('recon-recover').addEventListener('click', () => {
    void run(() => mutate(`${root()}/reconciliation-runs/${selected}/recover`, {}));
  });
  return { reset, load, render, validate };
}
