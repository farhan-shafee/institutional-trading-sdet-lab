# Phase 4A Zero-Coupon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and qualify the additional immutable synthetic zero-coupon instrument without changing accepted v1 analytics.

**Architecture:** Separate v2 domain module and authenticated read-only routes. Exact rational cash arithmetic and an independently authored Python Fraction verifier protect the financial boundary. Follow-on Phase4B-F work remains separately tracked in the economic contract.

**Tech Stack:** Node24, strict TypeScript, existing Decimal.js/Zod, Node tests, Python standard library, existing OpenAPI/HTTP server.

**Spec:** docs/PHASE4_ECONOMICS.md, section 4A.

## Global Constraints

- No existing v1 instrument, formula, response or historical golden changes.
- No historical migration, financial capacity reservation, retry, timeout or admission changes.
- Synthetic local/CI candidate only; no financial writer or deployment.
- Exact rational cash, HALF_EVEN, strict bounded decimal/date inputs.
- Every behavior change and generated test needs human review before acceptance.

## Review Focus

- A rounded displayed price must not decide a cash penny.
- A valid inverse boundary must survive wire price rounding without accepting materially out-of-range yield.
- A caller cannot mutate a definition or one result to change later calculations.
- Authentication, repeated fields and malformed/unsupported inputs fail closed.
- Existing v1 callers continue to receive exactly the accepted catalogue and shapes.

### Task 1: domain and independent oracle

**Files:** Create app/domain/fixed-income-v2/zero.ts; tests/unit/fixed-income-zero.test.ts; verification/python/zero_coupon.py.
**Interfaces:** zeroAnalytics(input: unknown): ZeroAnalytics; zeroInstruments readonly catalogue; cashFlows(settlement: string) returns the single immutable redemption.

- [ ] Write literal schedule, one-year price/inverse, exact cash tie, leap-day, invalid-domain and immutable-definition tests.
- [ ] Run the tests and record the expected missing-module RED.
- [ ] Implement the separate versioned model, strict parser and exact rational consideration.
- [ ] Run focused tests, independent Fraction oracle, then the complete unit suite.
- [ ] Commit the coherent domain/oracle slice.

### Task 2: authenticated API and schema

**Files:** Modify app/server/fixed-income.ts and contracts/openapi.yaml; add tests/unit/fixed-income-zero-http.test.ts.
**Interfaces:** GET /api/fixed-income/v2/instruments and /api/fixed-income/v2/analytics; same authenticated session and request admission as v1.

- [ ] Write real loopback HTTP tests for both roles, missing/revoked auth, repeated/unknown fields, full shape and unchanged v1 catalogue.
- [ ] Run tests RED, implement only the route/schema extension, run tests GREEN.
- [ ] Run typecheck, lint, format, independent contract validation, financial verification and required baseline/repeated tests.
- [ ] Commit the API integration.

### Task 3: qualification and review

**Files:** Update docs/CURRENT_STATE.md only with actual supported scope; record exact source-bound evidence.
**Interfaces:** existing full gate commands remain unchanged; new tests must be discovered by them.

- [ ] Run all applicable mandatory gates and preserve failures.
- [ ] Obtain a fresh independent source/evidence review and fix material findings with RED/GREEN tests.
- [ ] Open a concrete draft PR for human financial-model acceptance; do not self-accept new conventions.
- [ ] Record that 4B-F/final Phase4 closeout remain unfinished and production unchanged.
