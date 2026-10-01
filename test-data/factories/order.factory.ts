import { createOrderSchema, type CreateOrderInput } from '../../app/domain/schemas.js';

/** Reproducible values; the server assigns unique IDs inside an isolated test session. */
export function buildOrder(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return createOrderSchema.parse({
    symbol: 'AAPL',
    side: 'BUY',
    quantity: 10,
    type: 'MARKET',
    ...overrides,
  });
}
