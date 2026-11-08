# Owned post-trade candidate

This is an isolated local/CI schema10 candidate under Phase4 final financial, model and test acceptance. It is off in the standard application, the hosted pool profile and production. There is no public UI or deployment step.

## Financial scope

Only original SYN-UST-2031 (phase1-ust-1) and SYN-CORP-2031 (phase1-corp-1) executions qualify. The zero-coupon instrument is analytics-only. Register at most eight complete original execution roots. A root can have two price-only corrections followed by a terminal full bust. Each adjustment appends records; original execution cash, par, side, instrument, agreed date, order and FIX evidence remain immutable.

Explicit initialization funds USD100000000 cash and zero securities against opposite funding. The fixed economic window starts on the selected date and ends at the exclusive next contractual coupon. Every root must fit that window, including closed, offset and busted roots. Income, redemption, fees, FX, external deposits, borrowing, netting and partial settlement are outside this finite model.

Settlement is full gross delivery versus payment on an explicit weekday at or after the original agreed due date, inside the fixed window. Insufficient funds create a FAILED receipt with no balance postings. The same failed key replays that failure; a new key can retry. A root has at most two failed attempts and each revision can post and reverse once. Reverse settled revisions before correcting or busting. Reversal also requires nonnegative cash and securities.

**Proposed for final owner acceptance:** admitted processing dates, including FAILED attempts, are nondecreasing; reversal cannot precede its posting. Available balances use POSTTRADE_SOURCE_SEQUENCE, separately from the valuation date and actual UTC audit timestamp. This prevents assets obtained in a later simulated state from funding an earlier state.

## Owned API

All paths below are relative to /api/fixed-income/v1/sandboxes/{sandboxId}/posttrade. They require a current authenticated session and current owned read or trade capability. Writers require the trader role, trade scope and Idempotency-Key. All request objects are strict; duplicate and reserved object keys are rejected within the existing16384-byte body limit.

| Method | Path                                  | Accepted fields / result                                        |
| ------ | ------------------------------------- | --------------------------------------------------------------- |
| GET    | /                                     | Complete source; optional raw_as_of_seq and posttrade_as_of_seq |
| POST   | /initialize                           | economic_start_date; immutable window and funding               |
| GET    | /risk                                 | fixture_id, as_of_date, optional source cutoffs                 |
| GET    | /pnl                                  | Same bounded query; exact FIFO and equity bridge                |
| GET    | /commands/{key}                       | Original immutable financial command receipt                    |
| GET    | /audit-events                         | limit1..100 and opaque cursor                                   |
| POST   | /executions/{executionId}/register    | Empty object; full original filled root                         |
| POST   | /executions/{executionId}/corrections | expected_revision, clean_price (12 decimal places)              |
| POST   | /executions/{executionId}/busts       | expected_revision                                               |
| POST   | /executions/{executionId}/settlements | expected_revision, processing_date                              |
| POST   | /executions/{executionId}/reversals   | expected_revision, processing_date                              |
| GET    | /executions/{executionId}/history     | Original identity, revisions, bust and settlement outcomes      |

Initialization, registration, correction and bust return201; successful settlement and reversal return200. An admitted FAILED settlement returns409 with a typed immutable financial outcome. Ordinary rejections return the error envelope and consume no financial key. After503 OUTCOME_UNKNOWN, recover the original key through the command endpoint or replay the same operation and payload. Never generate a replacement key to resolve an uncertain commit. Authentication precedes receipt recovery; capability rotation does not grant old credentials access to historical receipts.

Audit cursors bind sandbox, generation, raw and post-trade source cutoffs, position and original page limit. They expire after300seconds and are local to the running service. A restart requires beginning a new page traversal.

## Assessments and accounting

Curves are BASE_UP_V1, FLAT_V1 and NEGATIVE_V1 under DISCOUNT_LOG_LINEAR_ACT365F_V1. Risk uses signed full par, unrounded cash-flow PV, central one-basis-point parallel/four-node shifts and fixed +100/-100/steepener stresses. Dollar risk displays eight decimal places; money displays two using HALF_EVEN. Key-rate sums are not required to equal parallel risk exactly.

FIFO_DIRTY_USD_V1 sorts corrected roots by original command sequence and stable identity. Corrections replace economics at the original order; busts remove the full root. Partial allocations retain exact fractions and aggregate rounding occurs only for display. Settlement and reversal change available balances, never realize the same execution twice.

Equity equals available cash plus signed unsettled cash plus adjusted economic security marks. Equity less opening funding equals exact realized plus unrounded unrealized P&L. The response separately exposes settled security availability, exact realized P&L and remaining lot basis/proceeds, and presentation rounding delta.

Risk and P&L identities bind sandbox, current generation, both source sequences, adjustment sequence, economic window, instrument definitions, valuation date, curve identity and model versions. They are deterministic content identities, not externally signed custody proofs. Read assessments do not write durable receipts.

UNAVAILABLE responses contain explicit reasons and no invented risk/P&L zeros. Uninitialized, missing, unregistered, unsupported, ninth, out-of-window and incoherent historical roots fail complete-book admission. As-of must be inside the fixed window and not before any nonbusted valued root's agreed date.

## Bounds and evidence

The original shared512-command/1024-event ceilings and existing admission, pool, deadlines, retries and security headroom remain fixed. Initialization reserves the exact maximum97 financial commands and161 financial events, including funding. Schema001-009 and original tests are preserved; new010 uses forced RLS, restricted RPCs, exact checksum admission and complete owned cleanup.

New real PostgreSQL suites cover SQL reconstruction, concurrency, settlement chronology, exact capacity, current ownership and uncertain-commit recovery. Independent Python Decimal125/Fraction calculations check risk, corrected execution cash and exact FIFO/equity. Actual HTTP bodies are validated against separately authored additive OpenAPI schemas.

Native FIX integration, complete qualification, final model/test acceptance and any later exact source-preservation exception remain pending. A source-preservation refusal must remain visible; it is not a passing native journey.
