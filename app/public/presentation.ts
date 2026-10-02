import type { z } from 'zod';
import type { Order, positionsResponseSchema } from '../domain/schemas.js';

export type Position = z.infer<typeof positionsResponseSchema>['positions'][number];

export function summarizeOrders(orders: readonly Order[]) {
  return {
    total: orders.length,
    working: orders.filter((order) => ['NEW', 'PARTIALLY_FILLED'].includes(order.status)).length,
    filled: orders.filter((order) => order.status === 'FILLED').length,
    closed: orders.filter((order) => ['CANCELED', 'REJECTED'].includes(order.status)).length,
  };
}

export function grossPositionNotional(positions: readonly Position[]): number {
  return positions.reduce(
    (total, position) => total + Math.abs(position.quantity) * position.averagePrice,
    0,
  );
}
