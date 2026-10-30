import {
  orderDetailSchema,
  orderCommandResultSchema,
  executionCommandSchema,
  positionsSchema,
  type OrderDetail,
} from '../domain/workflow/execution.js';
import type { RetainedRfqCommand } from '../domain/workflow/rfq-journal.js';
type Api = (path: string) => Promise<{ response: Response; data: unknown }>;
export function orderView(
  api: Api,
  mutate: (path: string, body: RetainedRfqCommand['body']) => Promise<void>,
  run: (work: () => Promise<void>) => Promise<void>,
  allowed: () => boolean,
) {
  const node = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  let detail: OrderDetail | undefined,
    root: string | undefined,
    positions = 'No executed positions.';
  function reset() {
    detail = undefined;
    root = undefined;
    positions = 'No executed positions.';
    render();
  }
  async function load(sandbox: string | undefined, order: string | undefined) {
    detail = undefined;
    positions = 'Execution-derived positions unavailable until refreshed.';
    root = sandbox ? `/api/fixed-income/v1/sandboxes/${sandbox}` : undefined;
    if (!root) {
      reset();
      return;
    }
    if (order) {
      const r = await api(`${root}/orders/${order}`);
      if (!r.response.ok) throw new Error(`Order history unavailable (HTTP ${r.response.status}).`);
      detail = orderDetailSchema.parse(r.data);
    }
    const p = await api(`${root}/positions`);
    if (!p.response.ok)
      throw new Error(`Execution-derived positions unavailable (HTTP ${p.response.status}).`);
    positions =
      positionsSchema
        .parse(p.data)
        .positions.map(
          (v) =>
            `${v.instrument_id} (${v.instrument_revision}) · signed par ${v.signed_par} · signed execution cash USD cents ${v.signed_cash_cents} · execution count ${v.execution_count}`,
        )
        .join('\n') || 'No executed positions.';
    render();
  }
  function button(label: string, disabled: boolean, action: () => Promise<void>) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.disabled = disabled || !allowed();
    b.addEventListener('click', () => {
      void run(action);
    });
    return b;
  }
  async function command(action: string, body: RetainedRfqCommand['body']) {
    if (!detail || !root) throw new Error('Load an owned order first.');
    await mutate(`${root}/orders/${detail.order.id}/${action}`, body);
  }
  function render() {
    const panel = node('fi-order-panel'),
      controls = node('fi-order-controls');
    panel.hidden = !root;
    controls.replaceChildren();
    node('fi-execution-positions').textContent = positions;
    const state = detail?.lifecycle;
    node('fi-order-lifecycle').textContent = state
      ? `${detail!.order.id} · ${state.status} · version ${state.version} · filled par ${state.filled_par} · remaining par ${state.remaining_par} · executed USD cents ${state.executed_cents} · execution count ${state.execution_count}`
      : 'No persistent order selected.';
    node('fi-order-executions').textContent =
      detail?.executions
        .map(
          (e) =>
            `Fill ${e.fill_sequence} · ${e.id} · source ${e.source_event_id} · par ${e.par_amount} · exact clean ${e.clean_price} per100 · USD cents ${e.consideration_cents} · settlement ${e.settlement_date}`,
        )
        .join('\n') || 'No committed executions.';
    node('fi-order-cancellations').textContent =
      detail?.cancellations
        .map((c) => `${c.id} · ${c.state} · ${c.reason ?? 'awaiting simulated outcome'}`)
        .join('\n') || 'No cancellation request.';
    node('fi-order-history').textContent =
      detail?.history
        .map((h) => `version ${h.version} · ${h.operation} · ${h.state.status} · ${h.decided_at}`)
        .join('\n') || 'No lifecycle history.';
    node<HTMLInputElement>('fi-execution-par').disabled =
      !state || !allowed() || !['NEW', 'PARTIALLY_FILLED'].includes(state.status);
    if (!state) return;
    for (const [label, action] of [
      ['Simulate order acknowledgment', 'acknowledgment'],
      ['Simulate business rejection', 'rejection'],
    ])
      controls.append(
        button(label!, state.status !== 'PENDING_ACK', () =>
          command(action!, { expected_version: state.version }),
        ),
      );
    controls.append(
      button(
        'Simulate execution',
        !['NEW', 'PARTIALLY_FILLED'].includes(state.status),
        async () => {
          const input = executionCommandSchema.parse({
            expected_version: state.version,
            execution_id: crypto.randomUUID(),
            source_event_id: crypto.randomUUID(),
            par_amount: node<HTMLInputElement>('fi-execution-par').value,
          });
          await command('executions', input);
        },
      ),
    );
    controls.append(
      button(
        'Request order cancellation',
        !['NEW', 'PARTIALLY_FILLED'].includes(state.status) || state.pending_cancel_id !== null,
        () =>
          command('cancellation-requests', {
            expected_version: state.version,
            cancel_id: crypto.randomUUID(),
          }),
      ),
    );
    for (const [label, action] of [
      ['Simulate cancellation acknowledgment', 'acknowledgment'],
      ['Simulate cancellation rejection', 'rejection'],
    ])
      controls.append(
        button(label!, state.pending_cancel_id === null, () =>
          command(`cancellations/${state.pending_cancel_id}/${action}`, {
            expected_version: state.version,
          }),
        ),
      );
  }
  return {
    reset,
    load,
    render,
    validate: (value: unknown) => orderCommandResultSchema.parse(value),
  };
}
