import { z } from 'zod';
import {
  createOrderSchema,
  errorResponseSchema,
  orderResponseSchema,
  ordersResponseSchema,
  positionsResponseSchema,
  sessionResponseSchema,
  userSchema,
  type Order,
  type SessionResponse,
} from '../domain/schemas.js';
import { grossPositionNotional, summarizeOrders, type Position } from './presentation.js';

const TOKEN_KEY = 'tradeflow.token';
let token = localStorage.getItem(TOKEN_KEY);
let user: SessionResponse['user'] | undefined;
let selectedOrder: Order | undefined;
let orderRequestVersion = 0;
let detailRequestVersion = 0;
let bookRequestVersion = 0;
let positionsRequestVersion = 0;
let apiObservationVersion = 0;
let completeOrders: Order[] | undefined;
let sessionPositions: Position[] | undefined;
let completeBookLoading = false;
const pendingCancellations = new Set<string>();
const activity: { time: string; message: string }[] = [];
const views = ['overview', 'orders', 'positions', 'activity'] as const;
type View = (typeof views)[number];
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing application element ${id}`);
  return node as T;
}

function value(id: string): string {
  return element<HTMLInputElement | HTMLSelectElement>(id).value;
}

function clearMessages(): void {
  element('error-message').hidden = true;
  element('success-message').hidden = true;
}

function showError(error: unknown): void {
  const message = element('error-message');
  message.textContent = error instanceof Error ? error.message : 'An unexpected error occurred.';
  message.hidden = false;
}

function showSuccess(text: string): void {
  const message = element('success-message');
  message.textContent = text;
  message.hidden = false;
}

function showView(view: View): void {
  for (const candidate of views) {
    const selected = candidate === view;
    const tab = element<HTMLButtonElement>(`nav-${candidate}`);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    element(`view-${candidate}`).hidden = !selected;
  }
}

function renderOverview(): void {
  const summary = completeOrders === undefined ? undefined : summarizeOrders(completeOrders);
  for (const key of ['total', 'working', 'filled', 'closed'] as const) {
    element(`overview-${key}`).textContent = summary === undefined ? '—' : String(summary[key]);
  }
  element('overview-positions').textContent =
    sessionPositions === undefined ? '—' : String(sessionPositions.length);
  element('overview-notional').textContent =
    sessionPositions === undefined ? '—' : money.format(grossPositionNotional(sessionPositions));
  element('book-loading').hidden = completeOrders !== undefined || !token;
  element('book-loading').textContent = completeBookLoading
    ? 'Loading the complete session book…'
    : 'The complete session book is unavailable. Metrics are not shown as zero.';
}

function renderActivity(): void {
  const list = element('activity-list');
  list.replaceChildren();
  element('activity-empty').hidden = activity.length > 0;
  for (const entry of activity) {
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = entry.time;
    time.textContent = `${entry.time.slice(11, 19)} UTC`;
    const message = document.createElement('span');
    message.textContent = entry.message;
    item.append(time, message);
    list.append(item);
  }
}

function recordActivity(message: string): void {
  if (!token) return;
  activity.push({ time: new Date().toISOString(), message });
  if (activity.length > 50) activity.shift();
  renderActivity();
}

function resetSessionData(): void {
  selectedOrder = undefined;
  completeOrders = undefined;
  sessionPositions = undefined;
  completeBookLoading = false;
  orderRequestVersion++;
  detailRequestVersion++;
  bookRequestVersion++;
  positionsRequestVersion++;
  apiObservationVersion++;
  pendingCancellations.clear();
  activity.length = 0;
  element<HTMLFormElement>('order-form').reset();
  element('limit-price-field').hidden = true;
  element('orders-body').replaceChildren();
  element('positions-body').replaceChildren();
  element('order-count').textContent = '';
  element('detail-fields').replaceChildren();
  element('order-lifecycle').replaceChildren();
  element('book-loading').hidden = true;
  element('orders-loading').hidden = true;
  element('positions-loading').hidden = true;
  element('orders-body').setAttribute('aria-busy', 'false');
  element('positions-body').setAttribute('aria-busy', 'false');
  renderOverview();
  renderActivity();
}

function showLogin(): void {
  clearMessages();
  token = null;
  user = undefined;
  resetSessionData();
  localStorage.removeItem(TOKEN_KEY);
  element('user-label').textContent = '';
  element('session-role').textContent = '';
  element('session-state').textContent = 'Session: signed out';
  element('overview-session').textContent = 'Signed out';
  element<HTMLFieldSetElement>('order-entry-fields').disabled = false;
  const submit =
    element<HTMLFormElement>('order-form').querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
  if (submit) {
    submit.disabled = false;
    submit.setAttribute('aria-busy', 'false');
  }
  element<HTMLButtonElement>('cancel-order').disabled = false;
  element('cancel-order').setAttribute('aria-busy', 'false');
  element('sign-out').setAttribute('aria-busy', 'false');
  element('workspace').hidden = true;
  element('session-controls').hidden = true;
  element('login-screen').hidden = false;
  element('order-detail').hidden = true;
  showView('orders');
}

async function api<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const requestToken = token;
  const observation = ++apiObservationVersion;
  const requestLabel = `${init.method ?? 'GET'} ${path}`;
  const observe = (result: string) => {
    if (requestToken === token && observation === apiObservationVersion)
      element('api-state').textContent = `API: ${requestLabel} · ${result}`;
  };
  observe('pending');
  const headers = new Headers(init.headers);
  if (requestToken) headers.set('Authorization', `Bearer ${requestToken}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    observe('no response');
    throw new Error('The local server could not be reached.');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const result = errorResponseSchema.safeParse(body);
    observe(`${response.status}${result.success ? '' : ' · contract rejected'}`);
    const error = new HttpError(
      response.status,
      result.success
        ? result.data.error.message
        : 'Server response did not match the expected contract.',
    );
    if (response.status === 401 && path !== '/api/session' && requestToken === token) {
      showLogin();
      showError(error);
    }
    throw error;
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    observe(`${response.status} · contract rejected`);
    throw new Error('Server response did not match the expected contract.');
  }
  observe(`${response.status} · validated`);
  return result.data;
}

function cell(row: HTMLTableRowElement, text: string, className?: string): HTMLTableCellElement {
  const node = row.insertCell();
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function statusPill(status: Order['status']): HTMLSpanElement {
  const pill = document.createElement('span');
  pill.className = `status-pill status-${status}`;
  pill.textContent = status;
  return pill;
}

function renderOrders(orders: Order[]): void {
  const body = element<HTMLTableSectionElement>('orders-body');
  body.replaceChildren();
  element('order-count').textContent = `${orders.length} orders`;
  for (const order of orders) {
    const row = body.insertRow();
    row.dataset.testid = `order-row-${order.id}`;
    cell(row, order.id, 'order-id');
    cell(row, order.symbol, 'symbol');
    cell(row, order.side, order.side === 'BUY' ? 'buy' : 'sell');
    cell(row, String(order.quantity), 'numeric');
    cell(row, order.type);
    const status = row.insertCell();
    status.append(statusPill(order.status));
    cell(row, `${order.createdAt.slice(0, 16).replace('T', ' ')} UTC`, 'created-time');
    const actions = row.insertCell();
    const view = document.createElement('button');
    view.textContent = 'View';
    view.className = 'secondary';
    view.setAttribute('aria-label', `View order ${order.id}`);
    view.addEventListener('click', () => {
      clearMessages();
      void loadDetail(order.id).catch(showError);
    });
    actions.append(view);
  }
  if (orders.length === 0) {
    const empty = cell(body.insertRow(), 'No orders match these filters.', 'empty-state');
    empty.colSpan = 8;
  }
}

async function loadCompleteBook(): Promise<void> {
  if (completeBookLoading) return;
  const version = ++bookRequestVersion;
  const requestToken = token;
  completeBookLoading = true;
  renderOverview();
  try {
    const result = await api('/api/orders', ordersResponseSchema);
    if (version === bookRequestVersion && requestToken === token) {
      completeOrders = result.orders;
      renderOverview();
    }
  } catch (error) {
    if (version === bookRequestVersion && requestToken === token) throw error;
  } finally {
    if (version === bookRequestVersion && requestToken === token) {
      completeBookLoading = false;
      renderOverview();
    }
  }
}

async function refreshOrders(): Promise<void> {
  const version = ++orderRequestVersion;
  const requestToken = token;
  const filters = new URLSearchParams();
  for (const key of ['symbol', 'side', 'status']) {
    const filterValue = value(`filter-${key}`);
    if (filterValue) filters.set(key, filterValue);
  }
  const fullBookVersion = filters.size === 0 ? ++bookRequestVersion : undefined;
  if (fullBookVersion !== undefined) completeBookLoading = true;
  renderOverview();
  element('orders-loading').textContent = 'Loading session orders…';
  element('orders-loading').hidden = false;
  element('orders-body').setAttribute('aria-busy', 'true');
  const readList = async () => {
    const result = await api(
      `/api/orders${filters.size ? `?${filters.toString()}` : ''}`,
      ordersResponseSchema,
    );
    if (version === orderRequestVersion && requestToken === token) {
      renderOrders(result.orders);
      element('orders-loading').hidden = true;
    }
    if (fullBookVersion === bookRequestVersion && requestToken === token) {
      completeOrders = result.orders;
      renderOverview();
    }
  };
  try {
    await Promise.all([
      readList(),
      filters.size > 0 && completeOrders === undefined ? loadCompleteBook() : Promise.resolve(),
    ]);
  } catch (error) {
    if (version === orderRequestVersion && requestToken === token) {
      element('orders-loading').textContent =
        'Orders could not be refreshed. Displayed rows may be stale.';
      element('orders-loading').hidden = false;
      throw error;
    }
  } finally {
    if (version === orderRequestVersion && requestToken === token)
      element('orders-body').setAttribute('aria-busy', 'false');
    if (fullBookVersion === bookRequestVersion && requestToken === token) {
      completeBookLoading = false;
      renderOverview();
    }
  }
}

function updateCancelAction(): void {
  const cancel = element<HTMLButtonElement>('cancel-order');
  const eligible =
    selectedOrder !== undefined && ['NEW', 'PARTIALLY_FILLED'].includes(selectedOrder.status);
  const pending = selectedOrder !== undefined && pendingCancellations.has(selectedOrder.id);
  cancel.hidden = !eligible;
  cancel.disabled = user?.role !== 'trader' || pending;
  cancel.setAttribute('aria-busy', String(pending));
  cancel.title =
    user?.role === 'viewer' ? 'Read-only session: cancellation requires a trader.' : '';
}

function renderDetail(order: Order): void {
  detailRequestVersion++;
  selectedOrder = order;
  const fields = element('detail-fields');
  fields.replaceChildren();
  const values = [
    ['Order ID', order.id, 'detail-id'],
    ['Symbol', order.symbol],
    ['Side', order.side],
    ['Quantity', String(order.quantity)],
    ['Type', order.type],
    ['Status', order.status, 'detail-status'],
    [
      'Limit price',
      order.limitPrice === undefined ? '—' : String(order.limitPrice),
      'detail-limit-price',
    ],
    ['Created time', order.createdAt],
  ];
  for (const [label, text, testId] of values) {
    const group = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label ?? '';
    const description = document.createElement('dd');
    description.textContent = text ?? '';
    if (testId) description.dataset.testid = testId;
    group.append(term, description);
    fields.append(group);
  }
  const lifecycle = element('order-lifecycle');
  lifecycle.replaceChildren();
  const projection = document.createElement('ol');
  for (const text of [
    `Created time: ${order.createdAt}`,
    `Current synthetic state: ${order.status}`,
  ]) {
    const item = document.createElement('li');
    item.textContent = text;
    projection.append(item);
  }
  const explanation = document.createElement('p');
  explanation.textContent =
    'This is a state summary, not an event history. No exchange event history is recorded.';
  lifecycle.append(projection, explanation);
  element('order-detail').hidden = false;
  updateCancelAction();
}

async function loadDetail(id: string): Promise<void> {
  const version = ++detailRequestVersion;
  const requestToken = token;
  try {
    const result = await api(`/api/orders/${encodeURIComponent(id)}`, orderResponseSchema);
    if (version === detailRequestVersion && requestToken === token) {
      renderDetail(result.order);
      recordActivity(`Viewed order ${result.order.id}.`);
    }
  } catch (error) {
    if (version === detailRequestVersion && requestToken === token) throw error;
  }
}

async function loadPositions(): Promise<void> {
  const version = ++positionsRequestVersion;
  const requestToken = token;
  element('positions-loading').textContent = 'Loading synthetic positions…';
  element('positions-loading').hidden = false;
  element('positions-body').setAttribute('aria-busy', 'true');
  try {
    const result = await api('/api/positions', positionsResponseSchema);
    if (version !== positionsRequestVersion || requestToken !== token) return;
    sessionPositions = result.positions;
    const body = element<HTMLTableSectionElement>('positions-body');
    body.replaceChildren();
    for (const position of result.positions) {
      const row = body.insertRow();
      cell(row, position.symbol, 'symbol');
      cell(row, String(position.quantity), 'numeric');
      cell(row, money.format(position.averagePrice), 'numeric');
    }
    if (result.positions.length === 0) {
      const empty = cell(body.insertRow(), 'No synthetic positions are available.', 'empty-state');
      empty.colSpan = 3;
    }
    element('positions-loading').hidden = true;
    renderOverview();
  } catch (error) {
    if (version === positionsRequestVersion && requestToken === token) {
      element('positions-loading').textContent = 'Synthetic positions could not be loaded.';
      throw error;
    }
  } finally {
    if (version === positionsRequestVersion && requestToken === token)
      element('positions-body').setAttribute('aria-busy', 'false');
  }
}

async function openWorkspace(): Promise<void> {
  element('login-screen').hidden = true;
  element('workspace').hidden = false;
  element('session-controls').hidden = false;
  element('user-label').textContent = `${user?.username ?? ''} · ${user?.role ?? ''}`;
  const roleLabel = user?.role === 'viewer' ? 'read-only viewer' : 'trader';
  element('session-role').textContent = user?.role === 'viewer' ? 'Read-only viewer' : 'Trader';
  element('session-state').textContent = `Session: active · ${roleLabel}`;
  element('overview-session').textContent = `Active · ${roleLabel}`;
  element('order-form').hidden = false;
  element<HTMLFieldSetElement>('order-entry-fields').disabled = user?.role === 'viewer';
  element('viewer-note').hidden = user?.role !== 'viewer';
  showView('orders');
  await Promise.all([refreshOrders(), loadPositions()]);
}

async function signIn(): Promise<void> {
  clearMessages();
  const form = element<HTMLFormElement>('login-form');
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;
  let sessionToken: string | undefined;
  try {
    const result = await api('/api/session', sessionResponseSchema, {
      method: 'POST',
      body: JSON.stringify({ username: value('username'), password: value('password') }),
    });
    token = result.token;
    sessionToken = result.token;
    user = result.user;
    resetSessionData();
    localStorage.setItem(TOKEN_KEY, token);
    element<HTMLInputElement>('password').value = '';
    recordActivity(`Session opened: ${user.username} (${user.role}).`);
  } finally {
    if (submit) submit.disabled = false;
  }
  try {
    await openWorkspace();
  } catch (error) {
    if (sessionToken === token) throw error;
  }
}

function validationFailure(message: string): never {
  recordActivity(`Validation failed: ${message}`);
  throw new Error(message);
}

function acceptMutation(order: Order): void {
  // Invalidate reads begun before this accepted mutation, including same-session reads.
  bookRequestVersion++;
  orderRequestVersion++;
  completeBookLoading = false;
  if (completeOrders !== undefined) {
    const exists = completeOrders.some((candidate) => candidate.id === order.id);
    completeOrders = exists
      ? completeOrders.map((candidate) => (candidate.id === order.id ? order : candidate))
      : [...completeOrders, order];
    renderOverview();
  }
}

async function submitOrder(): Promise<void> {
  clearMessages();
  const quantityText = value('quantity');
  const quantity = Number(quantityText);
  if (!quantityText || !Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
    validationFailure('Quantity must be a whole number from 1 to 1,000,000.');
  }
  const type = value('order-type');
  const input = {
    symbol: value('symbol'),
    side: value('side'),
    quantity,
    type,
    ...(type === 'LIMIT' ? { limitPrice: Number(value('limit-price')) } : {}),
  };
  if (type === 'LIMIT' && (!Number.isFinite(input.limitPrice) || (input.limitPrice ?? 0) <= 0)) {
    validationFailure('Limit price must be greater than zero.');
  }
  const parsed = createOrderSchema.safeParse(input);
  if (!parsed.success) validationFailure('Order fields do not match the expected schema.');
  const submit =
    element<HTMLFormElement>('order-form').querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
  if (submit) {
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
  }
  const requestToken = token;
  try {
    const result = await api('/api/orders', orderResponseSchema, {
      method: 'POST',
      body: JSON.stringify(parsed.data),
    });
    if (requestToken !== token) return;
    acceptMutation(result.order);
    recordActivity(
      `Created order ${result.order.id}: ${result.order.symbol} ${result.order.side} ${result.order.quantity}, ${result.order.status}.`,
    );
    element<HTMLFormElement>('filters').reset();
    renderDetail(result.order);
    showSuccess('Order submitted.');
    await refreshOrders();
  } catch (error) {
    if (requestToken === token) throw error;
  } finally {
    if (submit && requestToken === token) {
      submit.disabled = false;
      submit.setAttribute('aria-busy', 'false');
    }
  }
}

async function cancelOrder(): Promise<void> {
  if (!selectedOrder) return;
  const target = selectedOrder;
  const version = detailRequestVersion;
  const requestToken = token;
  clearMessages();
  pendingCancellations.add(target.id);
  updateCancelAction();
  try {
    const result = await api(
      `/api/orders/${encodeURIComponent(target.id)}/cancel`,
      orderResponseSchema,
      { method: 'POST' },
    );
    if (requestToken !== token) return;
    acceptMutation(result.order);
    recordActivity(`Canceled order ${result.order.id}.`);
    if (version === detailRequestVersion && selectedOrder?.id === target.id)
      renderDetail(result.order);
    showSuccess('Order canceled.');
    await refreshOrders();
  } catch (error) {
    if (requestToken === token) throw error;
  } finally {
    if (requestToken === token) {
      pendingCancellations.delete(target.id);
      updateCancelAction();
    }
  }
}

async function signOut(): Promise<void> {
  clearMessages();
  const requestToken = token;
  const observation = ++apiObservationVersion;
  let responseReceived = false;
  element('api-state').textContent = 'API: DELETE /api/session · pending';
  element('sign-out').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/session', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${requestToken ?? ''}` },
    });
    responseReceived = true;
    if (requestToken !== token) return;
    if (observation === apiObservationVersion)
      element('api-state').textContent = `API: DELETE /api/session · ${response.status}`;
    if (!response.ok && response.status !== 401)
      throw new Error('The synthetic session could not be closed.');
    showLogin();
  } catch (error) {
    if (requestToken === token) {
      if (!responseReceived && observation === apiObservationVersion)
        element('api-state').textContent = 'API: DELETE /api/session · no response';
      throw error;
    }
  } finally {
    if (requestToken === token) element('sign-out').setAttribute('aria-busy', 'false');
  }
}

for (const view of views) {
  const tab = element<HTMLButtonElement>(`nav-${view}`);
  tab.addEventListener('click', () => showView(view));
  tab.addEventListener('keydown', (event) => {
    const index = views.indexOf(view);
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % views.length
        : event.key === 'ArrowLeft'
          ? (index + views.length - 1) % views.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? views.length - 1
              : undefined;
    const target = next === undefined ? undefined : views[next];
    if (target === undefined) return;
    event.preventDefault();
    showView(target);
    element(`nav-${target}`).focus();
  });
}

function renderMarketSnapshot(): void {
  const body = element<HTMLTableSectionElement>('market-body');
  const quotes = [
    ['AAPL', 185.2, 185.3, 185.25],
    ['MSFT', 410.4, 410.6, 410.5],
    ['NVDA', 138.7, 138.8, 138.75],
    ['SPY', 550.0, 550.1, 550.05],
  ] as const;
  body.replaceChildren();
  for (const [symbol, bid, ask, last] of quotes) {
    const row = body.insertRow();
    cell(row, symbol, 'symbol');
    for (const price of [bid, ask, last]) cell(row, money.format(price), 'numeric');
  }
}

element('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void signIn().catch(showError);
});
element('order-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void submitOrder().catch(showError);
});
element('filters').addEventListener('submit', (event) => event.preventDefault());
element('filters').addEventListener('change', () => {
  clearMessages();
  void refreshOrders().catch(showError);
});
element('order-type').addEventListener('change', () => {
  element('limit-price-field').hidden = value('order-type') !== 'LIMIT';
});
element('cancel-order').addEventListener('click', () => {
  void cancelOrder().catch(showError);
});
element('close-detail').addEventListener('click', () => {
  detailRequestVersion++;
  element('order-detail').hidden = true;
  selectedOrder = undefined;
});
element('sign-out').addEventListener('click', () => {
  void signOut().catch(showError);
});

async function restoreSession(): Promise<void> {
  if (!token) return;
  const requestToken = token;
  try {
    const result = await api('/api/session', z.object({ user: userSchema }).strict());
    if (requestToken !== token) return;
    user = result.user;
    recordActivity(`Session restored: ${user.username} (${user.role}).`);
    await openWorkspace();
  } catch (error) {
    if (requestToken !== token) return;
    if (error instanceof HttpError && error.status === 401) showLogin();
    showError(error);
  }
}

renderMarketSnapshot();
renderOverview();
void restoreSession();
