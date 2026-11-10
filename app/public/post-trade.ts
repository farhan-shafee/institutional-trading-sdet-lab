import { z } from 'zod';
import { ownedSourceSchema, type OwnedPostTradeSnapshot } from '../domain/post-trade/source.js';
import {
  riskAssessmentSchema,
  pnlAssessmentSchema,
  postTradeMutationSchemas,
  postTradeFailureBodySchema,
  postTradeErrorSchema,
  commandReceiptSchema,
  postTradeHistorySchema,
  postTradeAuditSchema,
  type PostTradeOperation,
} from '../domain/post-trade/api-contracts.js';
import { keySchema } from '../domain/workflow/contracts.js';
import {
  PostTradeCommandJournal,
  postTradeIntentSchema,
  postTradeCommandPath,
  definitivePostTradeRejection,
  type RetainedPostTradeCommand,
} from '../domain/post-trade/journal.js';

type Api = (
  path: string,
  method?: string,
  body?: unknown,
  key?: string,
  current?: () => boolean,
) => Promise<{ response: Response; data: unknown }>;
type Context = {
  sandbox: string | undefined;
  token: string | null;
  epoch: number;
  canTrade: boolean;
  busy: boolean;
  blocked: boolean;
};
type Pnl = z.infer<typeof pnlAssessmentSchema>;
type Risk = z.infer<typeof riskAssessmentSchema>;
const statusSchema = z
  .object({ enabled: z.boolean(), state: z.enum(['ready', 'unavailable', 'disabled']) })
  .strict()
  .refine((value) => (value.enabled ? value.state !== 'disabled' : value.state === 'disabled'));
function wire<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new Error(
      'Server financial response did not match the expected contract; figures are unavailable.',
      { cause: result.error },
    );
  return result.data;
}
const canonical = (value: Record<string, unknown>) =>
  JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

/** Presentation and original-intent recovery only. All financial values come from validated server responses. */
export function postTradeView(
  api: Api,
  run: (work: () => Promise<void>) => Promise<void>,
  context: () => Context,
) {
  const node = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const panel = node('posttrade-panel'),
    selection = node<HTMLSelectElement>('posttrade-execution');
  const journal = new PostTradeCommandJournal(sessionStorage);
  const exposed = document.body.dataset.publicPosttrade === 'on';
  let enabled = false,
    version = 0,
    workspace: string | undefined,
    owner: string | null = null;
  let selectedExecution: string | undefined;
  let source: OwnedPostTradeSnapshot | undefined, pnl: Pnl | undefined, risk: Risk | undefined;
  let historical = false,
    auditCursor: string | null = null,
    auditSource: string | undefined;
  let auditEvents: z.infer<typeof postTradeAuditSchema>['events'] = [];
  const root = () => '/api/fixed-income/v1/sandboxes/' + context().sandbox + '/posttrade';
  const value = (id: string) => node<HTMLInputElement>(id).value;
  const selected = () => source?.roots.find((row) => row.execution_id === selection.value);
  const hasCutoffs = () => value('posttrade-raw-cutoff') !== '' || value('posttrade-cutoff') !== '';
  function capture(selectedId?: string) {
    const c = context(),
      epoch = version;
    return () => {
      const next = context();
      return (
        c.sandbox === next.sandbox &&
        c.token === next.token &&
        c.epoch === next.epoch &&
        epoch === version &&
        (selectedId === undefined || selection.value === selectedId)
      );
    };
  }
  function pending(): RetainedPostTradeCommand | undefined {
    return context().sandbox ? journal.load(context().sandbox!) : undefined;
  }
  function hasPending(): boolean {
    if (!exposed) return false;
    try {
      return !!pending();
    } catch {
      node('posttrade-error').textContent =
        'Retained financial request is invalid; its original material was preserved.';
      return true;
    }
  }
  function reset() {
    if (workspace && owner && context().token !== owner) {
      try {
        journal.forgetEndedSession(workspace);
      } catch {
        /* Session ownership already ended. */
      }
    }
    version++;
    enabled = false;
    source = undefined;
    pnl = undefined;
    risk = undefined;
    workspace = undefined;
    selectedExecution = undefined;
    owner = null;
    historical = false;
    auditCursor = null;
    auditSource = undefined;
    auditEvents = [];
    for (const id of ['posttrade-init', 'posttrade-assess']) node<HTMLFormElement>(id).reset();
    for (const id of [
      'posttrade-error',
      'posttrade-command-result',
      'posttrade-history',
      'posttrade-audit',
      'posttrade-provenance',
      'posttrade-receipt',
    ])
      node(id).textContent = '';
    node<HTMLInputElement>('posttrade-price').value = '100.880000000000';
    node<HTMLInputElement>('posttrade-processing').value = '2030-01-15';
    node<HTMLInputElement>('posttrade-receipt-key').value = '';
    panel.hidden = !exposed;
    render();
  }
  async function initialize() {
    if (!exposed) return;
    const current = capture();
    const result = await api(
      '/api/public-demo/posttrade/status',
      'GET',
      undefined,
      undefined,
      current,
    );
    if (!result.response.ok) throw new Error('Public financial status is unavailable.');
    const status = wire(statusSchema, result.data);
    if (!current()) return;
    enabled = status.enabled && status.state === 'ready';
    panel.hidden = !status.enabled;
    render();
  }
  async function load() {
    version++;
    if (exposed && context().sandbox && !enabled) await initialize();
    pnl = undefined;
    risk = undefined;
    source = undefined;
    auditCursor = null;
    auditSource = undefined;
    auditEvents = [];
    node('posttrade-audit').textContent = '';
    node('posttrade-history').textContent = '';
    if (!enabled || !context().sandbox) {
      render();
      return;
    }
    workspace = context().sandbox;
    owner = context().token;
    const current = capture(),
      query = new URLSearchParams();
    historical = hasCutoffs();
    if (value('posttrade-raw-cutoff')) query.set('raw_as_of_seq', value('posttrade-raw-cutoff'));
    if (value('posttrade-cutoff')) query.set('posttrade_as_of_seq', value('posttrade-cutoff'));
    render();
    const result = await api(
      root() + (query.size ? '?' + query.toString() : ''),
      'GET',
      undefined,
      undefined,
      current,
    );
    if (!result.response.ok)
      throw new Error(`Financial source unavailable (HTTP ${result.response.status}).`);
    const parsed = wire(ownedSourceSchema, result.data);
    if (parsed.sandbox_id !== workspace)
      throw new Error('Financial source does not match this workspace.');
    if (!current()) return;
    source = parsed;
    render();
    query.set('raw_as_of_seq', parsed.raw_command_seq);
    query.set('posttrade_as_of_seq', parsed.posttrade_command_seq);
    query.set('fixture_id', value('posttrade-fixture'));
    query.set('as_of_date', value('posttrade-asof'));
    const [r, p] = await Promise.all([
      api(root() + '/risk?' + query.toString(), 'GET', undefined, undefined, current),
      api(root() + '/pnl?' + query.toString(), 'GET', undefined, undefined, current),
    ]);
    if (!r.response.ok || !p.response.ok)
      throw new Error('Risk and P&L are unavailable for these inputs.');
    const nextRisk = wire(riskAssessmentSchema, r.data),
      nextPnl = wire(pnlAssessmentSchema, p.data);
    if (
      nextRisk.source.source_id !== nextPnl.source.source_id ||
      nextRisk.curve.snapshot_id !== nextPnl.curve.snapshot_id ||
      nextRisk.status !== nextPnl.status ||
      nextPnl.source.sandbox_id !== workspace ||
      nextPnl.source.generation !== parsed.generation ||
      nextPnl.source.raw_command_seq !== parsed.raw_command_seq ||
      nextPnl.source.posttrade_command_seq !== parsed.posttrade_command_seq ||
      nextPnl.curve.fixture_id !== query.get('fixture_id') ||
      nextPnl.as_of_date !== query.get('as_of_date')
    )
      throw new Error('Risk and P&L do not describe the same requested source and mark.');
    if (!current()) return;
    risk = nextRisk;
    pnl = nextPnl;
    render();
  }
  function render() {
    if (!exposed) {
      panel.hidden = true;
      return;
    }
    const c = context(),
      row = selected(),
      previous = selection.value || selectedExecution;
    selection.replaceChildren();
    for (const item of source?.roots ?? []) {
      const option = document.createElement('option');
      option.value = item.execution_id;
      option.textContent = `${item.side} ${item.instrument_id} par ${item.par_amount} · ${item.execution_id}`;
      selection.append(option);
    }
    if (previous && source?.roots.some((item) => item.execution_id === previous))
      selection.value = previous;
    if (selection.value) selectedExecution = selection.value;
    const active = selected() ?? row;
    node('posttrade-revision').textContent =
      active?.current_revision === null || active?.current_revision === undefined
        ? 'unregistered'
        : String(active.current_revision);
    node('posttrade-root-state').textContent = active
      ? `Original clean quote ${active.original_clean_price}; original consideration cents ${active.original_consideration_cents}; adjusted quote ${active.active_clean_price ?? 'unregistered'}; adjusted consideration cents ${active.active_consideration_cents ?? 'unregistered'}; value date ${active.value_date}; state ${active.settlement_state ?? 'unregistered'}${active.busted ? ' · terminal bust' : ''}`
      : 'No raw execution selected. Use the RFQ and execution controls above.';
    const retained = hasPending(),
      unconfirmed = retained || c.blocked,
      allowed =
        enabled &&
        !!c.sandbox &&
        c.canTrade &&
        !c.busy &&
        !c.blocked &&
        !retained &&
        !historical &&
        !hasCutoffs();
    node<HTMLButtonElement>('posttrade-initialize').disabled =
      !allowed || !source || source.initialized;
    const rootAllowed = allowed && !!source?.initialized && !!active && !active.busted;
    for (const id of [
      'posttrade-correct',
      'posttrade-bust',
      'posttrade-settle',
      'posttrade-reverse',
    ])
      node<HTMLButtonElement>(id).disabled = !rootAllowed || !active?.registered;
    node<HTMLButtonElement>('posttrade-register').disabled = !rootAllowed || !!active?.registered;
    if (active?.current_revision === 2)
      node<HTMLButtonElement>('posttrade-correct').disabled = true;
    if (active?.settlement_state === 'SETTLED') {
      node<HTMLButtonElement>('posttrade-settle').disabled = true;
      node<HTMLButtonElement>('posttrade-correct').disabled = true;
      node<HTMLButtonElement>('posttrade-bust').disabled = true;
    } else node<HTMLButtonElement>('posttrade-reverse').disabled = true;
    for (const id of ['posttrade-assess-submit', 'posttrade-audit-load', 'posttrade-receipt-load'])
      node<HTMLButtonElement>(id).disabled = !enabled || !c.sandbox || c.busy;
    node<HTMLButtonElement>('posttrade-refresh').disabled = !exposed || !c.sandbox || c.busy;
    node<HTMLButtonElement>('posttrade-history-load').disabled = !enabled || !active || c.busy;
    node<HTMLButtonElement>('posttrade-audit-more').disabled = !auditCursor || c.busy;
    let original: RetainedPostTradeCommand | undefined;
    try {
      original = pending();
    } catch {
      /* Preserve invalid original bytes and fail closed. */
    }
    for (const id of ['posttrade-recover', 'posttrade-inspect-retained'])
      node<HTMLButtonElement>(id).disabled = !enabled || !original || !c.canTrade || c.busy;
    selection.disabled = c.busy;
    for (const id of ['posttrade-start', 'posttrade-price', 'posttrade-processing'])
      node<HTMLInputElement>(id).disabled = c.busy || !c.canTrade || retained;
    node('posttrade-status').textContent = !enabled
      ? 'Public financial persistence is unavailable.'
      : !c.sandbox
        ? 'Start your private workspace first.'
        : retained
          ? 'Original financial request retained. Recover that request before another mutation.'
          : c.blocked
            ? 'Original RFQ or execution request retained. Recover it above before treating the financial source as current.'
            : historical || hasCutoffs()
              ? 'Historical source selected; return to current source before a new financial command.'
              : !c.canTrade
                ? 'Read-only workspace; paper funding remains an explicit trader action.'
                : `Financial source ${source?.posttrade_command_seq ?? 'unavailable'} · simulated economic dates are separate from recorded UTC.`;
    if (unconfirmed)
      node('posttrade-balances').textContent =
        'UNCONFIRMED · an original workflow request is unresolved. Recover its exact outcome before treating balances as current.';
    else if (!source?.initialized)
      node('posttrade-balances').textContent = source
        ? 'Uninitialized · no paper funding or available balance has been created.'
        : 'Financial balances unavailable.';
    else if (pnl?.status === 'AVAILABLE')
      node('posttrade-balances').textContent = [
        `Paper funding USD: ${pnl.pnl.opening_cash_usd}`,
        `Available cash USD: ${pnl.pnl.available_cash_usd}`,
        ...pnl.pnl.available_securities.map(
          (item) => `${item.instrument_id}: available par ${item.available_par}`,
        ),
        `Balance basis: recorded post-trade source ${source.posttrade_command_seq}; processing-date watermark: ${source.processing_date_watermark ?? 'none'}`,
      ].join('\n');
    else
      node('posttrade-balances').textContent =
        `Paper funding initialized. Source available cash cents: ${source.available_cash_cents ?? 'UNAVAILABLE'}; assessment unavailable.`;
    node('posttrade-obligations').textContent =
      source?.roots
        .filter((item) => item.registered && !item.busted && item.settlement_state !== 'SETTLED')
        .map(
          (item) =>
            `${item.side} ${item.instrument_id} par ${item.par_amount} · consideration cents ${item.active_consideration_cents} · value date ${item.value_date} · ${item.settlement_state}`,
        )
        .join('\n') ||
      (source ? 'No registered unsettled obligations in this source.' : 'Obligations unavailable.');
    node('posttrade-risk').textContent =
      risk?.status === 'AVAILABLE'
        ? [
            `Signed PV USD: ${risk.risk.total.pv_usd}`,
            `Parallel DV01 USD: ${risk.risk.total.parallel_dv01_usd}`,
            `Key-rate DV01 USD (1y, 2y, 5y, 10y): ${risk.risk.total.key_rate_dv01_usd.join(', ')}`,
            ...Object.entries(risk.risk.total.stress_pnl_usd).map(
              ([name, amount]) => `${name}: stress P&L USD ${amount}`,
            ),
            ...risk.risk.instruments.map(
              (item) =>
                `${item.instrument_id}: signed par ${item.signed_par}; PV USD ${item.pv_usd}; parallel DV01 USD ${item.parallel_dv01_usd}`,
            ),
          ].join('\n')
        : 'UNAVAILABLE' +
          (risk?.status === 'UNAVAILABLE'
            ? ': ' + risk.reasons.join(', ')
            : ' · refresh the financial book.');
    node('posttrade-pnl').textContent =
      pnl?.status === 'AVAILABLE'
        ? [
            `Realized P&L USD: ${pnl.pnl.realized_pnl_usd}`,
            `Unrealized P&L USD: ${pnl.pnl.unrealized_pnl_usd}`,
            `Total P&L USD: ${pnl.pnl.total_pnl_usd}`,
            `Equity USD: ${pnl.pnl.equity_usd}`,
            `Economic security mark USD: ${pnl.pnl.economic_security_mark_usd}; signed unsettled cash USD: ${pnl.pnl.signed_unsettled_cash_usd}`,
            `Displayed component rounding delta USD: ${pnl.pnl.presentation_rounding_delta_usd}; server money displays use 2 decimals, risk uses 8 decimals.`,
          ].join('\n')
        : 'UNAVAILABLE' +
          (pnl?.status === 'UNAVAILABLE'
            ? ': ' + pnl.reasons.join(', ')
            : ' · refresh the financial book.');
    node('posttrade-provenance').textContent = source
      ? JSON.stringify(
          {
            source,
            assessment: pnl
              ? {
                  assessment_id: pnl.assessment_id,
                  source: pnl.source,
                  curve: pnl.curve,
                  as_of_date: pnl.as_of_date,
                  models: pnl.models,
                  ...(pnl.status === 'AVAILABLE'
                    ? {
                        realized_exact_usd: pnl.pnl.realized_pnl_exact_usd,
                        fifo_lots: pnl.pnl.lots,
                      }
                    : { reasons: pnl.reasons }),
                }
              : null,
          },
          null,
          2,
        )
      : '';
    if (unconfirmed) {
      node('posttrade-obligations').textContent =
        'UNCONFIRMED · recover the original workflow request.';
      for (const id of ['posttrade-risk', 'posttrade-pnl'])
        node(id).textContent = 'UNAVAILABLE · the original workflow outcome is unconfirmed.';
    }
  }
  function showOutcome(
    intent: RetainedPostTradeCommand,
    data: unknown,
    status: number,
    replayed: boolean,
  ) {
    const expected = intent.operation === 'SETTLE' || intent.operation === 'REVERSE' ? 200 : 201;
    if (status !== expected && !(intent.operation === 'SETTLE' && status === 409))
      throw new Error('Financial receipt status does not match the original operation.');
    const body =
      status === 409
        ? wire(postTradeFailureBodySchema, data)
        : wire(postTradeMutationSchemas[intent.operation], data);
    if (intent.operation === 'INITIALIZE') {
      if (!('sandbox_id' in body) || body.sandbox_id !== intent.sandbox_id)
        throw new Error('Financial receipt workspace mismatch.');
    } else if (!('execution_id' in body) || body.execution_id !== intent.execution_id)
      throw new Error('Financial receipt execution mismatch.');
    node('posttrade-command-result').textContent =
      `${replayed ? 'Original command replayed. ' : ''}${'settlement_state' in body ? body.settlement_state : intent.operation} · ${status === 409 ? 'admitted outcome with retained receipt' : 'immutable receipt recorded'} (HTTP ${status}); command sequence ${body.posttrade_command_seq}.`;
    node('posttrade-receipt').textContent = JSON.stringify(
      { key: intent.key, operation: intent.operation, http_status: status, body },
      null,
      2,
    );
    node<HTMLInputElement>('posttrade-receipt-key').value = intent.key;
  }
  async function submit(intent: RetainedPostTradeCommand) {
    if (intent.sandbox_id !== context().sandbox || !context().canTrade)
      throw new Error('Current trader ownership is required to recover this original request.');
    try {
      const current = capture();
      const result = await api(
        postTradeCommandPath(intent),
        'POST',
        intent.body,
        intent.key,
        current,
      );
      if (!current()) return;
      const expected = intent.operation === 'SETTLE' || intent.operation === 'REVERSE' ? 200 : 201;
      if (
        result.response.status === expected ||
        (intent.operation === 'SETTLE' &&
          result.response.status === 409 &&
          postTradeFailureBodySchema.safeParse(result.data).success)
      ) {
        showOutcome(
          intent,
          result.data,
          result.response.status,
          result.response.headers.get('Idempotency-Replayed') === 'true',
        );
        journal.resolve(intent);
        await load();
        return;
      }
      const error = wire(postTradeErrorSchema, result.data).error;
      if (definitivePostTradeRejection(result.response.status, error.code)) {
        journal.resolve(intent);
        node('posttrade-command-result').textContent =
          `Rejected before admission: ${error.code}. No financial receipt was created for this key.`;
        await load();
        return;
      }
      throw new Error(
        `Financial request unresolved (HTTP ${result.response.status}, ${error.code}).`,
      );
    } catch (failure) {
      let retained = true;
      try {
        retained = !!journal.load(intent.sandbox_id);
      } catch {
        /* Preserve material. */
      }
      throw new Error(
        (failure instanceof Error ? failure.message : 'Financial request unavailable.') +
          (retained
            ? ' The original request retained; recover using its original payload and key.'
            : ''),
        { cause: failure },
      );
    }
  }
  async function command(operation: PostTradeOperation) {
    const c = context(),
      execution = selected();
    if (
      !enabled ||
      !c.sandbox ||
      !c.canTrade ||
      c.blocked ||
      hasPending() ||
      historical ||
      hasCutoffs()
    )
      throw new Error('A current writable financial workspace is required.');
    let body: object = {};
    if (operation === 'INITIALIZE') body = { economic_start_date: value('posttrade-start') };
    else {
      if (!execution) throw new Error('Select a raw execution first.');
      if (operation !== 'REGISTER') body = { expected_revision: execution.current_revision };
      if (operation === 'CORRECT_PRICE') body = { ...body, clean_price: value('posttrade-price') };
      if (operation === 'SETTLE' || operation === 'REVERSE')
        body = { ...body, processing_date: value('posttrade-processing') };
    }
    const parsed = postTradeIntentSchema.safeParse({
      version: 1,
      sandbox_id: c.sandbox,
      key: crypto.randomUUID(),
      operation,
      body,
      ...(operation === 'INITIALIZE' ? {} : { execution_id: execution!.execution_id }),
    });
    if (!parsed.success)
      throw new Error(
        'Check the simulated date, revision and 12-decimal clean quote. No financial request was submitted.',
      );
    const intent = parsed.data;
    try {
      journal.retain(intent);
    } catch (cause) {
      // Storage failure prevents HTTP submission.
      throw new Error(
        'The financial request could not be retained; no request was submitted. Existing material was preserved.',
        { cause },
      );
    }
    render();
    await submit(intent);
  }
  async function receipt(retained?: RetainedPostTradeCommand) {
    const key = retained?.key ?? keySchema.parse(value('posttrade-receipt-key'));
    const current = capture();
    node('posttrade-receipt').textContent = '';
    const result = await api(root() + '/commands/' + key, 'GET', undefined, undefined, current);
    if (!current() || (!retained && value('posttrade-receipt-key') !== key)) return;
    if (!result.response.ok)
      throw new Error(
        `Receipt not available (HTTP ${result.response.status}); any original request stays retained.`,
      );
    const command = wire(commandReceiptSchema, result.data).command;
    if (command.idempotency_key !== key) throw new Error('Receipt key mismatch.');
    if (command.http_status === 409) {
      if (command.operation !== 'SETTLE') throw new Error('Financial receipt operation mismatch.');
      wire(postTradeFailureBodySchema, command.response_body);
    } else {
      const expected =
        command.operation === 'SETTLE' || command.operation === 'REVERSE' ? 200 : 201;
      if (command.http_status !== expected) throw new Error('Financial receipt status mismatch.');
      wire(postTradeMutationSchemas[command.operation], command.response_body);
    }
    if (retained) {
      const payload = {
        ...retained.body,
        ...(retained.operation === 'INITIALIZE' ? {} : { execution_id: retained.execution_id }),
      };
      if (
        command.operation !== retained.operation ||
        canonical(command.request_payload) !== canonical(payload)
      )
        throw new Error(
          'Receipt does not match the original request; original material preserved.',
        );
      showOutcome(retained, command.response_body, command.http_status, false);
    }
    node('posttrade-receipt').textContent = JSON.stringify(command, null, 2);
    node<HTMLDetailsElement>('posttrade-receipt-details').open = true;
    if (retained) {
      journal.resolve(retained);
      await load();
    }
  }
  async function history() {
    const execution = selected();
    if (!execution) return;
    const current = capture(execution.execution_id);
    node('posttrade-history').textContent = '';
    const result = await api(
      root() + '/executions/' + execution.execution_id + '/history',
      'GET',
      undefined,
      undefined,
      current,
    );
    if (!current()) return;
    if (!result.response.ok) throw new Error('Execution history unavailable.');
    const body = wire(postTradeHistorySchema, result.data);
    if (body.original_execution.execution_id !== execution.execution_id)
      throw new Error('Execution history identity mismatch.');
    node('posttrade-history').textContent = JSON.stringify(body, null, 2);
    node<HTMLDetailsElement>('posttrade-history-details').open = true;
  }
  async function audit(more: boolean) {
    const query = more && auditCursor ? '?cursor=' + encodeURIComponent(auditCursor) : '?limit=25';
    const current = capture();
    const result = await api(
      root() + '/audit-events' + query,
      'GET',
      undefined,
      undefined,
      current,
    );
    if (!current()) return;
    if (!result.response.ok) throw new Error('Financial audit unavailable.');
    const body = wire(postTradeAuditSchema, result.data);
    if (more && body.source.source_id !== auditSource)
      throw new Error('Financial audit snapshot changed.');
    const events = more ? [...auditEvents, ...body.events] : body.events;
    if (
      events.length > 161 ||
      new Set(events.map((event) => event.command_seq + ':' + event.event_index)).size !==
        events.length
    )
      throw new Error('Financial audit exceeds its bounded snapshot.');
    auditSource = body.source.source_id;
    auditCursor = body.next_cursor;
    auditEvents = events;
    node('posttrade-audit').textContent = JSON.stringify(
      { source: body.source, as_of_seq: body.as_of_seq, events },
      null,
      2,
    );
    node<HTMLDetailsElement>('posttrade-audit-details').open = true;
    render();
  }
  for (const [id, operation] of Object.entries({
    'posttrade-register': 'REGISTER',
    'posttrade-correct': 'CORRECT_PRICE',
    'posttrade-bust': 'BUST',
    'posttrade-settle': 'SETTLE',
    'posttrade-reverse': 'REVERSE',
  } as const))
    node(id).addEventListener('click', () => {
      void run(() => command(operation));
    });
  node('posttrade-init').addEventListener('submit', (event) => {
    event.preventDefault();
    void run(() => command('INITIALIZE'));
  });
  node('posttrade-assess').addEventListener('submit', (event) => {
    event.preventDefault();
    void run(load);
  });
  node('posttrade-refresh').addEventListener('click', () => {
    void run(load);
  });
  node('posttrade-recover').addEventListener('click', () => {
    void run(async () => {
      const intent = pending();
      if (intent) await submit(intent);
    });
  });
  node('posttrade-inspect-retained').addEventListener('click', () => {
    void run(async () => {
      const intent = pending();
      if (intent) await receipt(intent);
    });
  });
  node('posttrade-receipt-load').addEventListener('click', () => {
    void run(() => receipt());
  });
  node('posttrade-history-load').addEventListener('click', () => {
    void run(history);
  });
  node('posttrade-audit-load').addEventListener('click', () => {
    void run(() => audit(false));
  });
  node('posttrade-audit-more').addEventListener('click', () => {
    void run(() => audit(true));
  });
  selection.addEventListener('change', () => {
    selectedExecution = selection.value;
    node('posttrade-history').textContent = '';
    render();
  });
  for (const id of ['posttrade-raw-cutoff', 'posttrade-cutoff'])
    node(id).addEventListener('input', render);
  return { reset, initialize, load, render, hasPending };
}
