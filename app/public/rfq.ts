import { z } from 'zod';
import { reconciliationView } from './reconciliation.js';
import { orderView } from './order.js';
import { postTradeView } from './post-trade.js';
import { sandboxBodySchema } from '../domain/workflow/contracts.js';
import {
  createRfqSchema,
  rfqDetailSchema,
  rfqListSchema,
  type RfqDetail,
} from '../domain/workflow/rfq.js';

import {
  RfqCommandJournal,
  definitiveRfqRejection,
  type RetainedRfqCommand as Retained,
} from '../domain/workflow/rfq-journal.js';

/** No ownership bootstrap or capability storage. Only an already bound session may act. */
export function rfqView(
  getToken: () => string | null,
  getRole: () => string | undefined,
  expired: () => void,
) {
  const node = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const panel = node<HTMLDetailsElement>('rfq-panel'),
    form = node<HTMLFormElement>('rfq-form');
  const status = node('rfq-status'),
    message = node('rfq-error');
  const selector = node<HTMLSelectElement>('rfq-selection');
  let epoch = 0,
    busy = false,
    initializing = false,
    sandboxId: string | undefined,
    detail: RfqDetail | undefined;
  let scope: 'read' | 'trade' | undefined;
  const publicMode = document.body.dataset.publicWorkflow === 'on';
  let publicJournalStorageKey: string | undefined;
  const journal = new RfqCommandJournal(sessionStorage);
  const financial = postTradeView(
    api,
    (work) => run(work, node('posttrade-error')),
    () => ({
      sandbox: sandboxId,
      token: getToken(),
      epoch,
      canTrade: getRole() === 'trader' && scope === 'trade',
      busy: busy || initializing,
      blocked: journal.has(sandboxId),
    }),
  );
  const lifecycle = orderView(
    api,
    mutate,
    run,
    () =>
      !busy &&
      !initializing &&
      getRole() === 'trader' &&
      scope === 'trade' &&
      !journal.has(sandboxId) &&
      !financial.hasPending(),
  );
  const reconciliation = reconciliationView(
    api,
    mutate,
    (work, stillCurrent) => run(work, node('recon-error'), stillCurrent),
    () =>
      !busy &&
      !initializing &&
      getRole() === 'trader' &&
      scope === 'trade' &&
      !journal.has(sandboxId) &&
      !financial.hasPending(),
    () => ({ sandbox: sandboxId, token: getToken(), epoch }),
  );
  const root = () => `/api/fixed-income/v1/sandboxes/${sandboxId}/rfqs`;
  const retained = () => (sandboxId ? journal.load(sandboxId) : undefined);
  const reset = () => {
    epoch++;
    busy = false;
    initializing = false;
    sandboxId = undefined;
    detail = undefined;
    scope = undefined;
    if (publicJournalStorageKey) {
      try {
        sessionStorage.removeItem(publicJournalStorageKey);
      } catch {
        /* Session is already revoked. */
      }
      publicJournalStorageKey = undefined;
    }
    lifecycle.reset();
    reconciliation.reset();
    financial.reset();
    panel.hidden = true;
    panel.open = false;
    form.reset();
    selector.replaceChildren();
    node<HTMLInputElement>('rfq-sandbox').value = '';
    status.textContent = '';
    message.textContent = '';
    node('rfq-native-ownership').hidden = publicMode;
    node('public-workspace-start').hidden = !publicMode;
    node('public-workspace-policy').hidden = !publicMode;
    node('public-workspace-id').textContent = '';
    node('public-workspace-id').hidden = true;
    render();
  };
  async function initialize() {
    const owner = getToken(),
      version = epoch;
    if (!owner) return;
    initializing = true;
    render();
    try {
      const response = await fetch('/api/fixed-income/v1/workflow/status', {
        headers: { Authorization: `Bearer ${owner}` },
      });
      const result = z
        .object({ enabled: z.boolean(), state: z.enum(['ready', 'unavailable', 'disabled']) })
        .strict()
        .parse(await response.json());
      if (owner !== getToken() || version !== epoch) return;
      await financial.initialize();
      if (owner !== getToken() || version !== epoch) return;
      if (document.body.dataset.publicPosttrade === 'on')
        (form.elements.namedItem('settlement_date') as HTMLInputElement).value = '2030-01-15';
      panel.hidden = !response.ok || !result.enabled;
      node('rfq-native-ownership').hidden = publicMode;
      node('public-workspace-start').hidden = !publicMode;
      node('public-workspace-policy').hidden = !publicMode;
      status.textContent =
        result.state === 'ready'
          ? publicMode
            ? 'Start a private synthetic workspace.'
            : 'Load an already authorized sandbox. Recovery stays outside this browser.'
          : 'Fixed-income persistence is unavailable.';
      if (publicMode && result.state === 'ready') {
        const existing = await api('/api/public-demo/workspace');
        if (owner !== getToken() || version !== epoch) return;
        if (existing.response.ok) await loadPublicWorkspace(existing.data);
        else if (existing.response.status !== 404 && existing.response.status !== 503)
          throw new Error('Public workspace status is unavailable.');
      }
      render();
    } catch {
      if (owner === getToken() && version === epoch) {
        panel.hidden = !publicMode;
        if (publicMode)
          status.textContent = 'Public workflow is unavailable. Retry when service returns.';
      }
    } finally {
      if (owner === getToken() && version === epoch) {
        initializing = false;
        render();
      }
    }
  }
  async function loadPublicWorkspace(data: unknown) {
    const owner = getToken(),
      version = epoch;
    const body = sandboxBodySchema.parse(data);
    sandboxId = body.sandbox.id;
    scope = body.scope;
    node<HTMLInputElement>('rfq-sandbox').value = sandboxId;
    const identity = node('public-workspace-id');
    identity.textContent = `Private workspace ${sandboxId}`;
    identity.hidden = false;
    await refresh();
    if (owner !== getToken() || version !== epoch || sandboxId !== body.sandbox.id) return;
    status.textContent = 'Private demo workspace ready.';
  }
  async function publicWorkspaceKey(owner: string, version: number): Promise<string> {
    try {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(owner));
      const name =
        'tradeflow.public.workspace.v1.' +
        Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (owner !== getToken() || version !== epoch) throw new Error();
      publicJournalStorageKey = name;
      const previous = sessionStorage.getItem(name);
      if (previous !== null)
        return z
          .object({ version: z.literal(1), key: z.uuid() })
          .strict()
          .parse(JSON.parse(previous)).key;
      const key = crypto.randomUUID();
      sessionStorage.setItem(name, JSON.stringify({ version: 1, key }));
      return key;
    } catch {
      throw new Error(
        'The private workspace request could not be retained. Existing browser data was preserved.',
      );
    }
  }
  async function api(
    path: string,
    method = 'GET',
    body?: unknown,
    key?: string,
    stillCurrent?: () => boolean,
    signal?: AbortSignal,
    authorizationCurrent = stillCurrent,
  ) {
    const owner = getToken(),
      version = epoch,
      ownerSandbox = sandboxId;
    if (!owner) throw new Error('Sign in first.');
    const response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${owner}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const data: unknown = await response.json();
    if (
      owner !== getToken() ||
      version !== epoch ||
      ownerSandbox !== sandboxId ||
      (stillCurrent && !stillCurrent())
    )
      throw new Error('RFQ session changed.');
    if (response.status === 401) {
      if (!authorizationCurrent || authorizationCurrent()) expired();
      throw new Error('Session expired.');
    }
    return { response, data };
  }
  async function run(
    work: () => Promise<void>,
    errorTarget = message,
    stillCurrent?: () => boolean,
  ) {
    if (busy || initializing) return;
    const owner = getToken(),
      version = epoch;
    busy = true;
    if (!stillCurrent || stillCurrent()) errorTarget.textContent = '';
    render();
    try {
      await work();
    } catch (error) {
      if (owner === getToken() && version === epoch && (!stillCurrent || stillCurrent()))
        errorTarget.textContent =
          error instanceof Error ? error.message : 'Workflow operation unavailable.';
    } finally {
      if (owner === getToken() && version === epoch) {
        busy = false;
        render();
      }
    }
  }
  async function loadSelected() {
    if (!selector.value || !sandboxId) {
      detail = undefined;
      await lifecycle.load(sandboxId, undefined);
      render();
      return;
    }
    const result = await api(`${root()}/${selector.value}`);
    if (!result.response.ok)
      throw new Error(`RFQ read unavailable (HTTP ${result.response.status}).`);
    detail = rfqDetailSchema.parse(result.data);
    await lifecycle.load(sandboxId, detail.order?.id);
    render();
  }
  async function refresh() {
    if (!sandboxId) return;
    const metadata = await api(`/api/fixed-income/v1/sandboxes/${sandboxId}`);
    if (!metadata.response.ok) {
      scope = undefined;
      throw new Error(
        `An authorized sandbox binding is required (HTTP ${metadata.response.status}).`,
      );
    }
    scope = sandboxBodySchema.parse(metadata.data).scope;
    const previous = detail?.rfq.id ?? selector.value;
    const result = await api(root());
    if (!result.response.ok)
      throw new Error(
        `An authorized sandbox binding is required (HTTP ${result.response.status}).`,
      );
    const list = rfqListSchema.parse(result.data);
    selector.replaceChildren();
    for (const rfq of list.rfqs) {
      const option = document.createElement('option');
      option.value = rfq.id;
      option.textContent = `${rfq.side} ${rfq.instrument_id} ${rfq.state} ${rfq.id}`;
      selector.append(option);
    }
    if (list.rfqs.some((r) => r.id === previous)) selector.value = previous!;
    await loadSelected();
    reconciliation.load(sandboxId);
    await financial.load();
  }
  async function submit(saved: Retained) {
    if (saved.sandbox_id !== sandboxId)
      throw new Error('Load the sandbox belonging to the retained command.');
    const stillSelected = reconciliation.captureSelection();
    const reconciliationCommand = saved.path.includes('/reconciliation-runs');
    // A stale success still resolves its original journal entry; only authorization side
    // effects and presentation depend on the investigation that originated the command.
    const result = await api(
      saved.path,
      'POST',
      saved.body,
      saved.key,
      undefined,
      undefined,
      reconciliationCommand ? stillSelected : undefined,
    );
    if (!result.response.ok) {
      const error = z
        .object({ error: z.object({ code: z.string(), message: z.string() }).strict() })
        .strict()
        .parse(result.data);
      if (definitiveRfqRejection(result.response.status, error.error.code)) {
        journal.resolve(saved);
        if (!reconciliationCommand) await refresh();
      }
      throw new Error(
        `${reconciliationCommand ? 'Reconciliation' : 'RFQ'} command rejected or unresolved (HTTP ${result.response.status}). Refresh state; retry only the retained command for an uncertain result.`,
      );
    }
    if (reconciliationCommand) {
      const applyPresentation = stillSelected();
      reconciliation.validate(result.data, () => applyPresentation);
      journal.resolve(saved);
      reconciliation.load(sandboxId, !applyPresentation);
    } else {
      if (saved.path.includes('/orders/')) lifecycle.validate(result.data);
      else detail = rfqDetailSchema.parse(result.data);
      journal.resolve(saved);
      await refresh();
    }
    status.textContent =
      result.response.headers.get('Idempotency-Replayed') === 'true'
        ? 'Original command replayed.'
        : 'RFQ command committed.';
  }
  async function mutate(path: string, body: Retained['body']) {
    if (!sandboxId || getRole() !== 'trader' || scope !== 'trade')
      throw new Error('An authorized trade binding is required.');
    if (retained()) throw new Error('Resolve the retained command before another mutation.');
    if (financial.hasPending())
      throw new Error('Recover the original financial request before another mutation.');
    const saved = journal.retain({
      sandbox_id: sandboxId,
      path,
      body,
      key: crypto.randomUUID(),
    });
    // Only non-secret command IDs and synthetic economic inputs. Storage failure prevents submission.
    await submit(saved);
  }
  function button(label: string, disabled: boolean, work: () => Promise<void>) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.disabled =
      disabled ||
      busy ||
      initializing ||
      getRole() !== 'trader' ||
      scope !== 'trade' ||
      journal.has(sandboxId) ||
      financial.hasPending();
    b.addEventListener('click', () => {
      void run(work);
    });
    return b;
  }
  function render() {
    lifecycle.render();
    reconciliation.render();
    financial.render();
    node('rfq-state').textContent = detail
      ? `${detail.rfq.id} · ${detail.rfq.state} · version ${detail.rfq.version} · expires ${detail.rfq.expires_at}`
      : 'No RFQ selected.';
    const invitations = node('rfq-invitations'),
      quotes = node('rfq-quotes');
    invitations.replaceChildren();
    quotes.replaceChildren();
    const open = detail?.rfq.state === 'OPEN';
    for (const invitation of detail?.invitations ?? []) {
      const row = document.createElement('div');
      row.textContent = `${invitation.dealer_id}: ${invitation.state} `;
      for (const response of ['QUOTE', 'DECLINE'] as const)
        row.append(
          button(
            response === 'QUOTE'
              ? `Request ${invitation.dealer_id} quote`
              : `Decline ${invitation.dealer_id}`,
            !open || invitation.state !== 'INVITED',
            async () => {
              const active = detail!;
              await mutate(`${root()}/${active.rfq.id}/dealer-responses`, {
                expected_version: active.rfq.version,
                dealer_id: invitation.dealer_id,
                response,
              });
            },
          ),
        );
      invitations.append(row);
    }
    for (const quote of detail?.quotes ?? []) {
      const row = document.createElement('div');
      row.textContent = `${quote.dealer_id} · ${quote.status} · bid ${quote.bid_clean_price} / ask ${quote.ask_clean_price} per 100 par · firm until ${quote.expires_at} `;
      for (const action of ['accept', 'withdraw'] as const)
        row.append(
          button(
            `${action === 'accept' ? 'Accept' : 'Withdraw'} ${quote.dealer_id} quote`,
            !open || quote.status !== 'QUOTED',
            async () => {
              const active = detail!;
              await mutate(`${root()}/${active.rfq.id}/${action}`, {
                expected_version: active.rfq.version,
                quote_id: quote.id,
              });
            },
          ),
        );
      quotes.append(row);
    }
    const order = node('rfq-order');
    order.textContent = detail?.order
      ? `Order ${detail.order.id} · PENDING_ACK · ${detail.order.contract.side} · USD par ${detail.order.contract.par_amount} · exact clean price ${detail.order.contract.clean_price} per 100 par · settlement ${detail.order.contract.settlement_date} · ${detail.order.contract.instrument_revision} · ${detail.order.contract.model_version}. This immutable contract retains its initial status; the lifecycle below reports subsequent events.`
      : 'No persistent fixed-income order.';
    node<HTMLFieldSetElement>('rfq-fields').disabled =
      busy ||
      initializing ||
      !sandboxId ||
      getRole() !== 'trader' ||
      scope !== 'trade' ||
      journal.has(sandboxId) ||
      financial.hasPending();
    node<HTMLButtonElement>('rfq-load').disabled = busy || initializing;
    node<HTMLButtonElement>('public-workspace-start').disabled =
      busy || !!sandboxId || initializing;
    node<HTMLButtonElement>('rfq-refresh').disabled = busy || initializing || !sandboxId;
    selector.disabled = busy || initializing;
    node<HTMLButtonElement>('rfq-retry').disabled =
      busy ||
      initializing ||
      !sandboxId ||
      !journal.has(sandboxId) ||
      getRole() !== 'trader' ||
      scope !== 'trade';
  }
  node('rfq-load').addEventListener('click', () => {
    void run(async () => {
      const next = z.uuid().parse(node<HTMLInputElement>('rfq-sandbox').value).toLowerCase();
      reconciliation.reset();
      sandboxId = next;
      detail = undefined;
      await refresh();
      status.textContent = 'Authorized sandbox loaded.';
    });
  });
  node('public-workspace-start').addEventListener('click', () => {
    void run(async () => {
      if (!publicMode) throw new Error('Public workspace setup is unavailable.');
      const owner = getToken(),
        version = epoch;
      if (!owner) throw new Error('Sign in first.');
      const key = await publicWorkspaceKey(owner, version);
      if (owner !== getToken() || version !== epoch) throw new Error('Session changed.');
      const result = await api('/api/public-demo/workspace', 'POST', {}, key);
      if (!result.response.ok)
        throw new Error(
          `Workspace setup unavailable (HTTP ${result.response.status}). Retry this same request.`,
        );
      await loadPublicWorkspace(result.data);
    });
  });
  node('rfq-refresh').addEventListener('click', () => {
    void run(refresh);
  });
  selector.addEventListener('change', () => {
    void run(loadSelected);
  });
  node('rfq-retry').addEventListener('click', () => {
    const saved = retained();
    if (!saved) return;
    const reconciliationCommand = saved.path.includes('/reconciliation-runs');
    void run(
      () => submit(saved),
      reconciliationCommand ? node('recon-error') : message,
      reconciliationCommand ? reconciliation.captureSelection() : undefined,
    );
  });
  node('rfq-use-analytics').addEventListener('click', () => {
    const source = node<HTMLFormElement>('fi-form');
    if (
      (source.elements.namedItem('instrument_id') as HTMLSelectElement).value === 'SYN-ZERO-2031'
    ) {
      message.textContent =
        'This zero-coupon instrument is analytics only. Select an original coupon bond for RFQ entry.';
      return;
    }
    message.textContent = '';
    for (const name of ['instrument_id', 'settlement_date', 'par_amount'])
      (form.elements.namedItem(name) as HTMLInputElement).value = (
        source.elements.namedItem(name) as HTMLInputElement
      ).value;
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // Capture successful controls before run() disables the fieldset during submission.
    const fields = new FormData(form);
    void run(async () => {
      const input = createRfqSchema.parse({
        rfq_id: crypto.randomUUID(),
        instrument_id: fields.get('instrument_id'),
        side: fields.get('side'),
        par_amount: fields.get('par_amount'),
        settlement_date: fields.get('settlement_date'),
        invited_dealers: fields.getAll('invited_dealers'),
      });
      await mutate(root(), input);
    });
  });
  return { reset, initialize };
}
