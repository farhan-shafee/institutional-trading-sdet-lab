import { z } from 'zod';

export const symbols = ['AAPL', 'MSFT', 'NVDA', 'SPY'] as const;
export const sides = ['BUY', 'SELL'] as const;
export const statuses = ['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED'] as const;

const orderInputFields = {
  symbol: z.enum(symbols),
  side: z.enum(sides),
  quantity: z.number().int().min(1).max(1_000_000),
};

export const createOrderSchema = z.discriminatedUnion('type', [
  z.object({ ...orderInputFields, type: z.literal('MARKET') }).strict(),
  z
    .object({
      ...orderInputFields,
      type: z.literal('LIMIT'),
      limitPrice: z.number().finite().positive(),
    })
    .strict(),
]);

export const orderSchema = z
  .object({
    ...orderInputFields,
    id: z.string().min(1),
    type: z.enum(['MARKET', 'LIMIT']),
    limitPrice: z.number().finite().positive().optional(),
    status: z.enum(statuses),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((order, ctx) => {
    if (order.type === 'LIMIT' && order.limitPrice === undefined) {
      ctx.addIssue({ code: 'custom', path: ['limitPrice'], message: 'LIMIT requires a price.' });
    }
    if (order.type === 'MARKET' && order.limitPrice !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['limitPrice'], message: 'MARKET forbids a price.' });
    }
  });

export const orderResponseSchema = z.object({ order: orderSchema }).strict();
export const ordersResponseSchema = z.object({ orders: z.array(orderSchema) }).strict();
export const positionsResponseSchema = z
  .object({
    positions: z.array(
      z
        .object({
          symbol: z.enum(symbols),
          quantity: z.number().int(),
          averagePrice: z.number().finite().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export const errorResponseSchema = z
  .object({ error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict() })
  .strict();
export const userSchema = z
  .object({ username: z.enum(['qa.user', 'qa.viewer']), role: z.enum(['trader', 'viewer']) })
  .strict();
export const sessionResponseSchema = z
  .object({ token: z.string().min(1), user: userSchema })
  .strict();
export const sessionRequestSchema = z
  .object({ username: z.string().min(1).max(100), password: z.string().min(1).max(100) })
  .strict();
export const filtersSchema = z
  .object({
    symbol: z.enum(symbols).optional(),
    side: z.enum(sides).optional(),
    status: z.enum(statuses).optional(),
  })
  .strict();

export type Order = z.infer<typeof orderSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type OrderFilters = z.infer<typeof filtersSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
