# FIX response guard implementation plan

> Execute directly, task by task, with one fresh whole-change review. Existing
> owner authorization to continue implementation is preserved; no workflow-choice
> prompt. Use the established isolated feature worktree and retain its ledger.

**Goal:** Resolve the selected-profile response blocker without modifying either
upstream engine or the required timer assertion, then resume original runtime
acceptance work.

**Architecture:** A one-request monotonic response guard in each wrapper
consumes public validated callbacks. The wrapper's command/timer controller
owns Acceptor.Stop; the proxy remains a fault/evidence component.

**Tech stack:** Existing Go1.27.3, QuickFIX/Go v0.9.12, QuickFIX/J3.0.2 and
Python orchestration; no new package/toolchain dependency.

**Spec:** docs/superpowers/specs/2026-11-07-fix-response-guard-design.md.

## Global constraints

- Preserve all existing engine/compiler/container pins, old app/SQL/migrations,
  dictionary/goldens and historical timer-failure evidence.
- Local synthetic only; one runtime container, networknone/nohostports,
  readonlyroot,1CPU/1GiB/128PIDs/64MiBshm/64MiBwritable state.
- HeartBtInt30, response deadline36seconds, ticker10ms; no timeout/retry
  expansion, weakened assertion or byte normalization.
- Existing new gate budgets: ordinary60s, live timer150s, build/fullcollection
  900s. Existing project gates remain unchanged.

## Review focus

1. Invalid/high/low-sequence matching responses must not clear pending state.
2. An extra request or ordinary traffic must not move the first deadline.
3. Callback/timer races must not revive an expired request or deadlock Stop.
4. Reset across reconnect must not reset FIX sequences or conceal old evidence.
5. Missing guard configuration/version/evidence must fail admission, not claim
   upstream compliance.

## Task 1: Deterministic response guard

Files: create verification/fix-peer/go/response_guard.go and
response_guard_test.go. No engine edits.

Interfaces: newResponseGuard() returns *responseGuard. Methods
request(now time.Time,id string) bool;
acknowledge(now time.Time,id string,sendingTime time.Time) bool;
expire(now time.Time)(string,bool); reset(). Exactly one pending ID.

- [x] Add literal tests at0,35.999999999,36and37seconds: missing/ordinary and
      wrong ID cannot clear; correct ID before36clears; at/after36cannot revive;
      repeated same ID cannot extend; competing ID fails closed; invalid ID denied;
      reset clears connection state.
      SendingTime exactly120seconds stale/future cannot clear a pending request,
      including when the engine is in resend recovery.
- [x] Run pinned Go package tests RED for missing guard; inspect actual output.
- [x] Implement the minimal bounded, mutex-protected guard; run tests GREEN.
- [x] Commit guard/tests plus spec/plan with actual RED/GREEN ledger evidence.

## Task 2: Real wrapper integration

Files: modify Go main.go, Java SessionMain.java, Dockerfile, driver.py; create
Java ResponseGuard.java and src/test/java/tradeflow/ResponseGuardCheck.java,
and new guard runtime controls.

Interfaces: ToAdmin calls request for35=1; validated FromAdmin calls acknowledge
for35=0only; main loop select owns bounded stdin and10ms expiry checks; OnLogon/
OnLogout reset. VERSION and required wrapper config name guardv1 explicitly.
Java mirrors this policy using nanoTime/Instant and a one-element input queue;
its main control loop owns SocketInitiator.stop(true).

- [x] Add failing guard-version/config and matching-response integration tests;
      retain the original failing timer test unchanged.
- [x] Compile all Go files with package tests; wire callbacks/controller safely.
- [x] Observe symmetric Java live control RED and missing Java guard unit
      compile RED; implement and run eight literal Java checks GREEN; wire its
      public callbacks/controller and run the same matching-ID acceptance GREEN.
- [x] Run original missing-response control and new matching-response controls
      over real engines; assert PROFILE_TIMEOUT/PROFILE_ACK attribution.
- [ ] Run full new collection, source checks, typecheck/lint/format and current
      full regression policy. Update documentation and PR#34 with actual results.
- [ ] Fresh whole-change review, fix material findings with RED→GREEN, retain
      remaining original-plan gaps explicitly. Do not claim3C1closure yet.

## Task 3: Resume original plan

- [ ] Reconcile original Tasks2-5 and43declared cases against real discovery.
- [ ] Finish remaining process/store/fault/time/quota/failure cases, portable
      mandatory runner and CI; run complete original gates and review.
- [ ] Produce a concrete3C2financial adapter contract only after3C1evidence is
      complete; preserve current SQL/SDK authority and financial semantics.
