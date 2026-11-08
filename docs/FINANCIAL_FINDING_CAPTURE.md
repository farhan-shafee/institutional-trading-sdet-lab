# Bounded financial-finding capture

This test-only diagnostic preserves the actual financial SQL rows before the original capacity assertion and fixture cleanup discard them. It changes no financial SQL, application behavior, assertions, retries, discovery or database limits. The earlier one-row capacity failure remains unexplained.

## Normal verification

`npm run test:postgres` delegates to the original owned-PostgreSQL supervisor. It uses the same sorted `tests/postgres/*.test.ts` discovery, concurrency 1 and 30-second per-test timeout, adding a result observer only in the exact original capacity-admission worker. The first legacy pass in `npm run test:posttrade` uses that same runner; the separate complete post-trade pass is unchanged.

Admission requires the private owned-loopback descriptor and the reconciler endpoint of that same database. The immutable supervisor has checked the live database nonce during bootstrap. Only the exact capacity worker and the separately named failure demo install the observer. The five original SQL fingerprints must match. Only existing promise query results from that owned reconciler are observed; callback and query-object calls pass through. No diagnostic SELECTs run.

A nonempty financial result emits `TF_FINANCIAL_FINDING` JSON before the result reaches the original assertion. It contains the exact allowed financial rows, query fingerprint, sandbox ID, and snapshot/watermarks observed from the existing protocol query on the same client and sandbox. Transaction boundaries clear context. Healthy results create no files.

Captures are private files (0600) in private directories (0700) under `artifacts/financial-findings-*/`, separate from database cleanup. Each record is bounded to 64 KiB. A worker can emit at most 16 records (at most 1 MiB); the last slot is reserved for an explicit incomplete-budget notice. Unknown fields, unsafe values, missing context and size limits produce an explicit INCOMPLETE result. Unsafe/oversize rows are omitted as whole rows and counted. No query arguments beyond the sandbox UUID, connection configuration, ownership nonce, proof or credentials are serialized. Capture/admission/write failures never replace a query result or error; they report incomplete evidence.

The existing persistence/session/live workflow files are unchanged. Their original job output retains bounded finding JSON. The additional post-trade workflow also uploads matching finding files on failure, with seven-day retention.

## Controlled failure proof

```sh
npm run verify:financial-capture
```

This separate verifier provisions a fresh nonce-verified owned synthetic database. Its demo first verifies a clean original ACK, then changes only version-2 order-history `recorded_at` to one microsecond before `decided_at`, using the existing privileged oracle-corruption mechanism. Ordinary CHECK, NOT NULL and unique constraints stay enabled; triggers are restored before commit.

The unchanged financial SQL must produce exactly one AUDIT_HISTORY/LIFECYCLE_TRANSITION row. The unchanged `assertCleanCapacity` must fail at its original financial-findings assertion with actual 1 and expected 0. The demo propagates that failure and its child remains exit 1. Cleanup must return retained capacity and sandboxes to zero.

The outer proof verifier succeeds only after checking that exact original failure, the real private capture and its snapshot, capture-before-assertion ordering, and capture persistence after cleanup. Its success is a diagnostic proof, never a normal regression pass or a waiver. Demo artifacts live separately under `artifacts/financial-capture-demo/`. The demo is outside all original normal test discovery.

This intentional timestamp corruption proves the capture mechanism. It does not identify or reproduce the historical failure's root cause. A future real finding must be investigated from its own captured evidence; green reruns do not close the historical finding.
