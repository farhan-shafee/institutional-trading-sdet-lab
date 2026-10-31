import { z } from 'zod';
const uuid = z.uuid();
const digits = z.string().regex(/^\d{1,3}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.iso.datetime();
export const requestReconciliationSchema = z
  .object({ run_id: uuid.transform((v) => v.toLowerCase()) })
  .strict();
export const recoverReconciliationSchema = z.object({}).strict();
export const verificationNames = ['foundation', 'rfq', 'executions', 'comparisons'] as const;
export const findingCategories = [
  'FOUNDATION',
  'RFQ_CONTRACT',
  'ORDER_QUANTITY',
  'EXECUTION_FINANCE',
  'POSITION',
  'CANCELLATION',
  'AUDIT_HISTORY',
  'REFERENCE',
  'INSTRUMENT_SOURCE',
] as const;
const values = z.record(
  z.string().max(64),
  z.union([z.string().max(4096), z.number().int().safe(), z.boolean(), z.null()]),
);
export const findingSchema = z
  .object({
    category: z.enum(findingCategories),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    record_kind: z.enum([
      'SANDBOX',
      'COMMAND',
      'RFQ',
      'QUOTE',
      'ORDER',
      'EXECUTION',
      'POSITION',
      'CANCELLATION',
      'INSTRUMENT',
    ]),
    record_id: z.string().min(1).max(128),
    related: z.record(z.string().max(64), z.string().max(128).nullable()),
    expected: values,
    observed: values,
  })
  .strict();
export const coverageSchema = z
  .object({
    name: z.enum(verificationNames),
    hash,
    status: z.enum(['COMPLETE', 'FAILED', 'NOT_RUN']),
    rows: z.number().int().min(0).max(100000),
  })
  .strict();
export const metadataSchema = z
  .object({
    engine_version: z.literal('reconciliation-v1'),
    source_revision: z.string().regex(/^[a-f0-9]{40}$/),
    source_tree: z.string().regex(/^[a-f0-9]{40}$/),
    source_state: z.enum(['CLEAN', 'DIRTY']),
    schema_revision: z.literal(5),
    financial_source: z.literal('6016fb700840d081fe1fba651c918f0a7e709383'),
    valuation_model: z.literal('phase1-regular-coupon-v1'),
    quotation_model: z.literal('synthetic-dealer-grid-v1'),
    conventions: z.tuple([z.literal('ACT_ACT_ICMA'), z.literal('THIRTY_360_US')]),
    query_hashes: z
      .object({ foundation: hash, rfq: hash, executions: hash, comparisons: hash })
      .strict(),
    schema_checksums: z
      .array(z.object({ version: z.number().int(), checksum: hash }).strict())
      .length(5)
      .optional(),
  })
  .strict();
export const snapshotSchema = z
  .object({
    id: z
      .string()
      .regex(/^\d+:\d+:[\d,]*$/)
      .max(4096),
    at: time,
    watermark: digits,
  })
  .strict();
export const failureReasonSchema = z.enum([
  'INTERRUPTED_BEFORE_START',
  'INTERRUPTED_SCAN',
  'REQUEST_EXPIRED',
  'LEASE_EXPIRED',
  'FINDING_LIMIT',
  'SQL_FAILURE',
  'DATABASE_UNAVAILABLE',
  'ENGINE_CHANGED',
  'SOURCE_CHANGED',
  'VERIFICATION_TIMEOUT',
]);
export const reconciliationReportSchema = z
  .object({
    status: z.enum(['COMPLETED_CLEAN', 'COMPLETED_WITH_FINDINGS', 'INCOMPLETE', 'FAILED']),
    snapshot: snapshotSchema.nullable(),
    coverage: z.array(coverageSchema).length(4),
    findings: z.array(findingSchema).max(128),
    total_findings: z.number().int().min(0).max(100000),
    failure_reason: failureReasonSchema.nullable(),
  })
  .strict()
  .superRefine((v, c) => {
    if (new Set(v.coverage.map((x) => x.name)).size !== 4)
      c.addIssue({ code: 'custom', message: 'Coverage must name every verifier exactly once.' });
    if (v.total_findings < v.findings.length)
      c.addIssue({ code: 'custom', message: 'Invalid finding count.' });
    if (v.status === 'COMPLETED_CLEAN' || v.status === 'COMPLETED_WITH_FINDINGS') {
      if (
        !v.snapshot ||
        v.coverage.some((x) => x.status !== 'COMPLETE') ||
        v.failure_reason !== null ||
        v.total_findings !== v.findings.length ||
        (v.status === 'COMPLETED_CLEAN') !== (v.findings.length === 0)
      )
        c.addIssue({ code: 'custom', message: 'Incomplete verification cannot be complete.' });
    } else if (v.failure_reason === null)
      c.addIssue({ code: 'custom', message: 'An incomplete/failed result requires a reason.' });
  });
export const reconciliationReferenceSchema = z
  .object({ run_id: uuid, request_command_seq: digits, requested_at: time })
  .strict();
export const reconciliationRunSchema = z
  .object({
    id: uuid,
    run_no: z.number().int().min(1).max(20),
    state: z.enum([
      'REQUESTED',
      'RUNNING',
      'COMPLETED_CLEAN',
      'COMPLETED_WITH_FINDINGS',
      'INCOMPLETE',
      'FAILED',
    ]),
    version: z.number().int().min(1).max(3),
    request_command_id: uuid,
    request_command_seq: digits,
    source_metadata: metadataSchema,
    requested_at: time,
    started_at: time.nullable(),
    lease_expires_at: time.nullable(),
    completed_at: time.nullable(),
    snapshot_id: snapshotSchema.shape.id.nullable(),
    snapshot_at: time.nullable(),
    source_watermark: digits.nullable(),
    coverage: z.array(coverageSchema).max(4),
    complete: z.boolean(),
    finding_count: z.number().int().min(0).max(128),
    total_findings: z.number().int().min(0).max(100000),
    failure_reason: failureReasonSchema.nullable(),
    report_hash: hash.nullable(),
  })
  .strict();
const page = {
  as_of: z.number().int().min(0).max(128),
  next_after: z.number().int().min(1).max(128).nullable(),
};
export const reconciliationListSchema = z
  .object({
    runs: z.array(reconciliationRunSchema).max(20),
    ...page,
    observed_command_seq: digits,
    latest_completed_run_id: uuid.nullable(),
  })
  .strict();
export const reconciliationDetailSchema = z
  .object({
    run: reconciliationRunSchema,
    events: z
      .array(
        z
          .object({
            event_no: z.number().int().min(1).max(3),
            state: reconciliationRunSchema.shape.state,
            decided_at: time,
            reason: failureReasonSchema.nullable(),
            report_hash: hash.nullable(),
          })
          .strict(),
      )
      .max(3),
    observed_command_seq: digits,
    latest_completed_run_id: uuid.nullable(),
  })
  .strict();
export const reconciliationFindingsSchema = z
  .object({
    run_id: uuid,
    findings: z
      .array(findingSchema.extend({ ordinal: z.number().int().min(1).max(128) }).strict())
      .max(20),
    ...page,
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;
export type VerificationMetadata = z.infer<typeof metadataSchema>;
export type ReconciliationReport = z.infer<typeof reconciliationReportSchema>;
export type ReconciliationDetail = z.infer<typeof reconciliationDetailSchema>;

export const reconciliationReceiptSchema = z
  .object({
    command: z
      .object({
        id: uuid,
        idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
        operation: z.enum(['CREATE_RECONCILIATION', 'RECOVER_RECONCILIATION']),
        receipt_seq: digits,
        http_status: z.union([z.literal(200), z.literal(201), z.literal(409)]),
        response_body: z.union([
          reconciliationReferenceSchema,
          z
            .object({ error: z.object({ code: z.string(), message: z.string() }).strict() })
            .strict(),
        ]),
        actor_id: uuid,
        created_at: time,
      })
      .strict(),
  })
  .strict();
