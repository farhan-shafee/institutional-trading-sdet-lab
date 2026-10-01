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

const TOKEN_KEY = 'tradeflow.token';
let token = localStorage.getItem(TOKEN_KEY);
let user: SessionResponse['user'] | undefined;
let selectedOrder: Order | undefined;
let orderRequestVersion = 0;
let detailRequestVersion = 0;

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

function showLogin(): void {
  token = null;
  user = undefined;
  selectedOrder = undefined;
  orderRequestVersion++;
  detailRequestVersion++;
  localStorage.removeItem(TOKEN_KEY);
  element('workspace').hidden = true;
  element('session-controls').hidden = true;
  element('login-screen').hidden = false;
  element('order-detail').hidden = true;
}

async function api<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const requestToken = token;
  const headers = new Headers(init.headers);
  if (requestToken) headers.set('Authorization', `Bearer ${requestToken}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
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
    if (response.status === 401 && path !== '/api/session' && requestToken === token) showLogin();
    throw new HttpError(
      response.status,
      result.success
        ? result.data.error.message
        : 'Server response did not match the expected contract.',
    );
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new Error('Server response did not match the expected contract.');
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
    cell(row, order.id);
    cell(row, order.symbol, 'symbol');
    cell(row, order.side, order.side === 'BUY' ? 'buy' : 'sell');
    cell(row, String(order.quantity));
    cell(row, order.type);
    const status = row.insertCell();
    status.append(statusPill(order.status));
    cell(row, `${order.createdAt.slice(0, 16).replace('T', ' ')} UTC`);
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

async function refreshOrders(): Promise<void> {
  const version = ++orderRequestVersion;
  const filters = new URLSearchParams();
  for (const key of ['symbol', 'side', 'status']) {
    const filterValue = value(`filter-${key}`);
    if (filterValue) filters.set(key, filterValue);
  }
  const result = await api(
    `/api/orders${filters.size ? `?${filters.toString()}` : ''}`,
    ordersResponseSchema,
  );
  if (version === orderRequestVersion) renderOrders(result.orders);
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
  element('order-detail').hidden = false;
  element('cancel-order').hidden =
    user?.role !== 'trader' || !['NEW', 'PARTIALLY_FILLED'].includes(order.status);
}

async function loadDetail(id: string): Promise<void> {
  const version = ++detailRequestVersion;
  const requestToken = token;
  try {
    const result = await api(`/api/orders/${encodeURIComponent(id)}`, orderResponseSchema);
    if (version === detailRequestVersion && requestToken === token) renderDetail(result.order);
  } catch (error) {
    if (version === detailRequestVersion && requestToken === token) throw error;
  }
}

async function loadPositions(): Promise<void> {
  const result = await api('/api/positions', positionsResponseSchema);
  const body = element<HTMLTableSectionElement>('positions-body');
  body.replaceChildren();
  for (const position of result.positions) {
    const row = body.insertRow();
    cell(row, position.symbol);
    cell(row, String(position.quantity));
    cell(row, `$${position.averagePrice.toFixed(2)}`);
  }
}

async function openWorkspace(): Promise<void> {
  element('login-screen').hidden = true;
  element('workspace').hidden = false;
  element('session-controls').hidden = false;
  element('user-label').textContent = `${user?.username ?? ''} · ${user?.role ?? ''}`;
  element('order-form').hidden = user?.role === 'viewer';
  element('viewer-note').hidden = user?.role !== 'viewer';
  await Promise.all([refreshOrders(), loadPositions()]);
}

async function signIn(): Promise<void> {
  clearMessages();
  const form = element<HTMLFormElement>('login-form');
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const result = await api('/api/session', sessionResponseSchema, {
      method: 'POST',
      body: JSON.stringify({ username: value('username'), password: value('password') }),
    });
    token = result.token;
    user = result.user;
    localStorage.setItem(TOKEN_KEY, token);
    element<HTMLInputElement>('password').value = '';
    await openWorkspace();
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function submitOrder(): Promise<void> {
  clearMessages();
  const quantityText = value('quantity');
  const quantity = Number(quantityText);
  if (!quantityText || !Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
    throw new Error('Quantity must be a whole number from 1 to 1,000,000.');
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
    throw new Error('Limit price must be greater than zero.');
  }
  const parsed = createOrderSchema.safeParse(input);
  if (!parsed.success) throw new Error('Order fields do not match the expected schema.');
  const submit =
    element<HTMLFormElement>('order-form').querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
  if (submit) submit.disabled = true;
  try {
    const result = await api('/api/orders', orderResponseSchema, {
      method: 'POST',
      body: JSON.stringify(parsed.data),
    });
    element<HTMLFormElement>('filters').reset();
    await refreshOrders();
    renderDetail(result.order);
    showSuccess('Order submitted.');
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function cancelOrder(): Promise<void> {
  if (!selectedOrder) return;
  const target = selectedOrder;
  const version = detailRequestVersion;
  const requestToken = token;
  clearMessages();
  const cancel = element<HTMLButtonElement>('cancel-order');
  cancel.disabled = true;
  try {
    const result = await api(
      `/api/orders/${encodeURIComponent(target.id)}/cancel`,
      orderResponseSchema,
      { method: 'POST' },
    );
    if (requestToken !== token) return;
    if (version === detailRequestVersion && selectedOrder?.id === target.id)
      renderDetail(result.order);
    await refreshOrders();
    if (requestToken === token) showSuccess('Order canceled.');
  } catch (error) {
    if (requestToken === token) throw error;
  } finally {
    cancel.disabled = false;
  }
}

async function signOut(): Promise<void> {
  clearMessages();
  const response = await fetch('/api/session', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token ?? ''}` },
  });
  if (!response.ok && response.status !== 401)
    throw new Error('The synthetic session could not be closed.');
  showLogin();
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
    await openWorkspace();
  } catch (error) {
    if (requestToken !== token) return;
    if (error instanceof HttpError && error.status === 401) showLogin();
    showError(error);
  }
}

void restoreSession();
