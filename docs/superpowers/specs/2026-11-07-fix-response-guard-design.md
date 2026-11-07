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

1. **Selected: explicit TradeFlow response guards around the unmodified
   engines.** Use public validated callbacks and monotonic deadlines.
   Avoids an upstream fork, adds a small independently tested profile policy.
2. Patch/fork Go. Fixes internal behavior but makes this lab responsible for
   upstream state-machine and timer maintenance, including resend transitions.
3. Replace the peer implementation. Requires a new toolchain, dependency,
   compatibility and complete protocol qualification; no replacement has been
   established as correct for this profile.

The selected option does not claim that either unmodified engine itself meets this
matching-ID requirement. Acceptance belongs to the explicitly named composite
of the engine and TradeFlow guard. It neither alters peer bytes nor substitutes
for engine sequence, dictionary or store validation.

## Guard contract

Each wrapper owns one pending request per connection. Go uses
verification/fix-peer/go/response_guard.go; Java uses
tools/fix-session/java/src/main/java/tradeflow/ResponseGuard.java. Neither has
networking, SDK, DB, floating-point or store imports. Decisions take explicit
clock observations: Go time.Time with monotonic component, Java nanoTime plus
Instant for freshness; deterministic tests use literal instants.

- ToAdmin observes a TestRequest with a nonempty printable ASCII112 of at most
  256bytes. The first request anchors the profile's36second response deadline:
  30second HeartBtInt plus the published test's20% allowance. Repeating the same request
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
- Each wrapper's main control loop checks deadlines at10ms intervals. Expiry
  emits one PROFILE_TIMEOUT event then stops only its own engine through its
  public API (Go Acceptor.Stop; Java SocketInitiator.stop(true)). Stop runs
  outside callbacks so it cannot wait on itself.
- OnLogon and OnLogout clear connection-scoped pending state. Sequence stores,
  original run identity and automatic-reset settings remain unchanged.
- A bounded one-element stdin command queue replaces each blocking main input
  loop. One Go reader goroutine or Java daemon reader feeds it. Java's reader
  enforces12000characters while reading, not only after an unbounded readLine.
- VERSION reports each unchanged engine version and profile_guard=matching-testreq-v1
  separately. Both wrappers require TradeFlowResponseGuard=matching-testreq-v1,
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

The initial Go live blocker passed unchanged after integration; Java's pinned
source also clears test-request bookkeeping on general verified traffic. A
symmetric live acceptance control is required before claiming both directions.
Java source archive3.0.2 SHA256:
4ad70989c631f4e05db5b05e5d9f50d84ce2fb90c2c10624161aa578453a37cf.
Do not change initial engine timer multipliers to make these controls pass;
record their actual elapsed behavior. Only the response-guard deadline is36s.

The Java guard has eight explicit standard-library checks compiled and run by
the locked Maven image, without adding a test-framework dependency. The image
build invokes these checks and Go package tests explicitly.

This revision resolves only the named response-policy blocker. Existing Tasks2-5 still
require the remaining43-case matrix, actual crash/restart, deterministic
calendar/resource/failure controls, portable gate/CI, full original regressions
and final review. Financial mapping in3C2 requires its own concrete contract.
