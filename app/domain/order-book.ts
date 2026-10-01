import { randomUUID } from 'node:crypto';
import { DomainError } from './errors.js';
import { createOrderSchema, type Order, type OrderFilters } from './schemas.js';

/** Fixed synthetic examples represent each lifecycle state; no market connectivity. */
const seeds: readonly Order[] = [
  {
    id: 'seed-new-aapl',
    symbol: 'AAPL',
    side: 'BUY',
    quantity: 100,
    type: 'LIMIT',
    limitPrice: 185.25,
    status: 'NEW',
    createdAt: '2026-01-05T14:30:00.000Z',
  },
  {
    id: 'seed-partial-msft',
    symbol: 'MSFT',
    side: 'SELL',
    quantity: 75,
    type: 'LIMIT',
    limitPrice: 410.5,
    status: 'PARTIALLY_FILLED',
    createdAt: '2026-01-05T14:31:00.000Z',
  },
  {
    id: 'seed-filled-nvda',
    symbol: 'NVDA',
    side: 'BUY',
    quantity: 40,
    type: 'MARKET',
    status: 'FILLED',
    createdAt: '2026-01-05T14:32:00.000Z',
  },
  {
    id: 'seed-canceled-spy',
    symbol: 'SPY',
    side: 'SELL',
    quantity: 200,
    type: 'LIMIT',
    limitPrice: 550,
    status: 'CANCELED',
    createdAt: '2026-01-05T14:33:00.000Z',
  },
  {
    id: 'seed-rejected-aapl',
    symbol: 'AAPL',
    side: 'SELL',
    quantity: 15,
    type: 'MARKET',
    status: 'REJECTED',
    createdAt: '2026-01-05T14:34:00.000Z',
  },
];

export const positions = Object.freeze([
  Object.freeze({ symbol: 'AAPL' as const, quantity: 250, averagePrice: 182.4 }),
  Object.freeze({ symbol: 'MSFT' as const, quantity: 125, averagePrice: 402.1 }),
  Object.freeze({ symbol: 'NVDA' as const, quantity: 80, averagePrice: 138.75 }),
  Object.freeze({ symbol: 'SPY' as const, quantity: 300, averagePrice: 545.2 }),
]);

export class OrderBook {
  private readonly orders = new Map(seeds.map((order) => [order.id, { ...order }]));

  list(filters: OrderFilters = {}): Order[] {
    return [...this.orders.values()]
      .filter(
        (order) =>
          (!filters.symbol || order.symbol === filters.symbol) &&
          (!filters.side || order.side === filters.side) &&
          (!filters.status || order.status === filters.status),
      )
      .map((order) => ({ ...order }));
  }

  get(id: string): Order {
    const order = this.orders.get(id);
    if (!order) {
      throw new DomainError(404, 'ORDER_NOT_FOUND', 'The synthetic order was not found.');
    }
    return { ...order };
  }

  create(input: unknown): Order {
    const parsed = createOrderSchema.safeParse(input);
    if (!parsed.success) {
      throw new DomainError(400, 'VALIDATION_ERROR', 'The synthetic order is invalid.');
    }
    const order: Order = {
      ...parsed.data,
      id: `order-${randomUUID()}`,
      status: 'NEW',
      createdAt: new Date().toISOString(),
    };
    this.orders.set(order.id, order);
    return { ...order };
  }

  cancel(id: string): Order {
    const order = this.get(id);
    if (order.status !== 'NEW' && order.status !== 'PARTIALLY_FILLED') {
      throw new DomainError(
        409,
        'ORDER_NOT_CANCELABLE',
        `${order.status} orders cannot be canceled.`,
      );
    }
    const canceled: Order = { ...order, status: 'CANCELED' };
    this.orders.set(id, canceled);
    return { ...canceled };
  }
}
