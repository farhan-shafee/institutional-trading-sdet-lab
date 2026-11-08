import { z } from 'zod';
import { curveDate } from '../fixed-income-v3/cash-flows.js';
export const initializePostTradeSchema = z
  .object({
    economic_start_date: z.string().refine((value) => {
      try {
        curveDate(value);
        return true;
      } catch {
        return false;
      }
    }),
  })
  .strict();
export const registerExecutionSchema = z.object({ execution_id: z.string().uuid() }).strict();
export type InitializePostTrade = z.infer<typeof initializePostTradeSchema>;
export type RegisterExecution = z.infer<typeof registerExecutionSchema>;

export const correctPriceSchema = z
  .object({
    execution_id: z.string().uuid(),
    expected_revision: z.number().int().min(0).max(2),
    clean_price: z.string().regex(/^(0|[1-9][0-9]{0,4})\.[0-9]{12}$/),
  })
  .strict();
export const bustExecutionSchema = z
  .object({ execution_id: z.string().uuid(), expected_revision: z.number().int().min(0).max(2) })
  .strict();
