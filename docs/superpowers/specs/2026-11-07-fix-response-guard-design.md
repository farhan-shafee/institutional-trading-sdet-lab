# FIX response guard: peer-design revision

The owner requested the next described work, including a concrete peer-design
revision and continued runtime implementation, on November 7, 2026. The guard
below is the assistant's engineering choice within that request, not a claim
that the owner previously selected this mechanism. Final acceptance still
requires human review. This work is synthetic/local and authorizes no merge,
deployment, real trading or Phase4 implementation.

## Problem and alternatives

At source59eddb4, Go v0.9.12 leaves its TestRequest pending-timeout state after
an ordinary heartbeat without112. Its latest release and main head are both
eff945dd59a41caeaed20f71916f08d37e0fda99; November7 read-only retrieval found no
newer upstream implementation. Historical failed acceptance remains retained.

1. **Selected: explicit TradeFlow response guard around the unmodified Go
   engine.** Uses its public validated callbacks and a monotonic deadline.
   Avoids an upstream fork, adds a small independently tested profile policy.
2. Patch/fork Go. Fixes internal behavior but makes this lab responsible for
   upstream state-machine and timer maintenance, including resend transitions.
3. Replace the peer implementation. Requires a new toolchain, dependency,
   compatibility and complete protocol qualification; no replacement has been
   established as correct for this profile.

The selected option does not claim that unmodified Go itself now meets this
matching-ID requirement. Acceptance belongs to the explicitly named composite
of the engine and TradeFlow guard. It neither alters peer bytes nor substitutes
for engine sequence, dictionary or store validation.

## Guard contract

File verification/fix-peer/go/response_guard.go owns one pending request per
connection. It has no networking, SDK, DB, floating-point or store imports.
All guard decisions take an explicit time.Time; runtime calls use time.Now's
monotonic component, deterministic tests use literal instants.

- ToAdmin observes a TestRequest with a nonempty printable ASCII112 of at most
  256bytes. The first request anchors a36second response deadline:30second
  HeartBtInt plus the pinned1.2 response allowance. Repeating the same request
  cannot extend it. A different request while one is pending fails closed.
- Only a Heartbeat delivered to FromAdmin with matching112 strictly before
  that deadline clears it. The wrapper additionally requires its SendingTime
  strictly within120seconds of the observed current wall clock, even during
  resend recovery; missing/invalid/stale/future timestamps cannot clear it.
  Missing/wrong112 and unrelated messages do nothing.
  At the deadline, or later, the response cannot revive the request.
- Pinned Go validates identity, sequence and dictionary before delivering a
  heartbeat callback. It normally checks SendingTime but skips that check in
  resendState. The wrapper's explicit freshness check closes that exception;
  FromAdmin is not described as unconditional freshness assurance. Configuration
  requires CheckLatency=Y and MaxLatency=120. The adapter never treats raw proxy
  bytes alone as an accepted response.
- The wrapper's main control loop checks deadlines with a10ms ticker. Expiry
  emits one PROFILE_TIMEOUT event then stops only its own Acceptor through the
  public Stop API. Stop runs outside callbacks so it cannot wait on itself.
- OnLogon and OnLogout clear connection-scoped pending state. Sequence stores,
  original run identity and automatic-reset settings remain unchanged.
- A bounded one-element stdin command channel replaces the blocking main
  Scanner loop. One reader goroutine feeds it; command/line limits remain.
- VERSION reports engine=v0.9.12 and profile_guard=matching-testreq-v1
  separately. Configuration requires TradeFlowResponseGuard=matching-testreq-v1,
  consumed by the wrapper, not claimed as an upstream engine setting.

No externally configurable timeout is added. No response is manufactured.
Existing timer acceptance assertions and50-test checkpoint expectations remain
in place. Historical observed failure JSON is preserved unchanged.

## Evidence and verification

Write guard tests first and observe missing behavior fail. Independently
specified controls cover ordinary/wrong-ID responses, just-before/at-deadline,
same-ID repetition, competing requests, late response, ID bounds and reset.
Include stale/future SendingTime at the exact120second boundaries and a
matching response accepted through the wrapper's callback with stale time.
Then prove the public callback integration over the actual pinned engines:
the old ordinary-heartbeat case must pass without modifying that test; a valid
matching response must cancel the guard; request/timeout events remain visible.

The existing no-heartbeat control continues to prove the underlying engine's
live timer path. Runtime evidence identifies which component initiates closure.
Preserve source/dictionary/goldens, limits, no-network/no-host-port isolation,
and financial_application_verified=false. Build all Go source files and run
its package tests; no test skipping or compiler/engine pin replacement.

This revision resolves only the named peer blocker. Existing Tasks2-5 still
require the remaining43-case matrix, actual crash/restart, deterministic
calendar/resource/failure controls, portable gate/CI, full original regressions
and final review. Financial mapping in3C2 requires its own concrete contract.
