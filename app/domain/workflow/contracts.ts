import { z } from 'zod';
import { DomainError } from '../errors.js';

export const scopeSchema = z.enum(['read', 'trade']);
export type Scope = z.infer<typeof scopeSchema>;
export const capabilitySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value);
export const keySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const keys = { read_capability: capabilitySchema, trade_capability: capabilitySchema };
export const createSandboxSchema = z
  .object({ sandbox_id: z.uuid(), ...keys })
  .strict()
  .refine((value) => value.read_capability !== value.trade_capability);
export const recoverSandboxSchema = z
  .object({ sandbox_id: z.uuid(), capability: capabilitySchema, scope: scopeSchema })
  .strict();
export const rotateSchema = z
  .object({ expected_generation: z.string().regex(/^[1-9][0-9]{0,8}$/), ...keys })
  .strict()
  .refine((value) => value.read_capability !== value.trade_capability);
export const sandboxBodySchema = z
  .object({
    sandbox: z
      .object({
        id: z.uuid(),
        created_at: z.iso.datetime(),
        write_expires_at: z.iso.datetime(),
        retained_until: z.iso.datetime(),
        generation: z.string().regex(/^[1-9][0-9]*$/),
        commit_seq: z.string().regex(/^[0-9]+$/),
        read_only: z.boolean(),
      })
      .strict(),
    scope: scopeSchema,
  })
  .strict();
export type SandboxBody = z.infer<typeof sandboxBodySchema>;
export type WorkflowResult = { status: number; body: unknown; replayed: boolean };
export const workflowResultSchema = z
  .object({ status: z.number().int(), body: z.unknown(), replayed: z.boolean() })
  .strict();

export function parseWorkflow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new DomainError(400, 'VALIDATION_ERROR', 'Invalid fixed-income workflow request.');
  return result.data;
}
