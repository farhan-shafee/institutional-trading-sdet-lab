import { z } from 'zod';
import { curveDate } from '../fixed-income-v3/cash-flows.js';
import { curveDefinitionVersions } from '../fixed-income-v3/cash-flows.js';
import { Rational } from '../fixed-income-v3/numbers.js';

export const tradableInstrumentIds = Object.freeze(['SYN-UST-2031', 'SYN-CORP-2031'] as const);
export type TradableInstrumentId = (typeof tradableInstrumentIds)[number];
const validDate = (date: string): boolean => {
  try {
    curveDate(date);
    return true;
  } catch {
    return false;
  }
};
export const economicExecutionSchema = z
  .object({
    execution_id: z.uuid().transform((value) => value.toLowerCase()),
    command_seq: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .refine((value) => BigInt(value) <= 512n),
    instrument_id: z.enum(tradableInstrumentIds),
    definition_version: z.string().min(1),
    side: z.enum(['BUY', 'SELL']),
    par_amount: z
      .string()
      .regex(/^\d{1,10}(?:\.\d{1,2})?$/)
      .refine((value) => {
        const par = Rational.decimal(value).toDecimal();
        return par.gte('0.01') && par.lte('1000000000');
      }),
    consideration_cents: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,13})$/)
      .refine((value) => BigInt(value) <= 10002000000000n),
    value_date: z.string().length(10).refine(validDate),
    revision: z.number().int().min(0).max(2),
  })
  .strict()
  .refine((value) => value.definition_version === curveDefinitionVersions[value.instrument_id]);
export type EconomicExecution = z.infer<typeof economicExecutionSchema>;
