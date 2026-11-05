# Explain TradeFlow independently

Candidate study guide, November 5, 2026. Read with [the runnable setup](INTERVIEW_SETUP.md), [timed demonstration](INTERVIEW_DEMO.md), [role matrix](TRADEWEB_SDET_MATRIX.md) and the [accepted-state index](CURRENT_STATE.md). Answers describe the implemented synthetic system; broader industry concepts are qualified. Study the linked implementation before repeating an answer. A working project or green CI does not prove that its owner can explain or change it.

## Trading and valuation

### 1. How does an RFQ differ from an order-driven market?

An RFQ asks selected dealers to quote specified economic terms; a customer can accept an eligible dealer quote. An order-driven market typically matches orders according to venue rules. TradeFlow implements a bounded dealer-to-client simulator with three fictional dealers, not an exchange book/matching engine. The old equities order book is session-local CRUD/lifecycle testing, not order matching. Evidence: `app/server/fixed-income-workflow/rfq-service.ts`, migration 003 and `docs/FIXED_INCOME_RFQ.md`.

**Senior follow-up:** Who authenticates the dealer? Here the synthetic trader invokes explicitly simulated dealer controls; there is no independent dealer identity or external response. What would a real counterparty/firm-price boundary need to establish?

### 2. Which side of a dealer quote does the customer take?

A customer BUY accepts the dealer's ask; SELL accepts its bid. Quantity is USD par and price is per 100 par. For SYN-UST-2031 ATLAS has bid `99.950000000123` and ask `100.050000000123`. The server generates this invented grid; it does not discover market liquidity. Acceptance freezes the exact selected twelve-decimal price, economic terms and model revisions. Python independently checks literal grid values. Evidence: migration 003, `verification/python/rfq_reference.py`, RFQ UI tests.

**Senior follow-up:** Why can a visually rounded quote not be the acceptance input? Because display precision could change contractual cash; the original exact snapshot is authoritative.

### 3. What are clean price, accrued interest and dirty price?

Clean excludes the accrued coupon. Dirty adds accrued interest per 100 par. On the declared Treasury-style example at 2026-10-15, AI is 1 and clean 99.875 gives dirty 100.875. At USD 1,000,000 par, consideration is USD 1,008,750. That is a modeled amount, not a posted settlement. The two regular-coupon instruments are fictional, share a 4% annual coupon and differ in accrual convention. Evidence: `docs/FIXED_INCOME_CONVENTIONS.md`, `app/domain/fixed-income/cash.ts` and the independent goldens.

**Senior follow-up:** What happens on coupon date? AI resets to zero; a settlement-day coupon is excluded from remaining cash flows. Maturity/post-maturity analytics are rejected rather than manufacturing a yield.

### 4. Which day-count conventions are supported?

The Treasury-style profile uses Actual/Actual ICMA for regular semiannual periods; the corporate-style profile uses US/NASD 30/360, not 30E/360. On 2028-02-29 the declared fractions are 45/182 and 44/180. Both schedules use unadjusted contractual dates. Business-day calendars, stubs, ex-dividend periods, default, callable, floating and inflation-linked instruments are outside the model. Evidence: `app/domain/fixed-income/dates.ts` and the conventions.

**Senior follow-up:** Why not copy a different Treasury auction formula? Similar product labels do not establish equivalent valuation conventions. State the selected model and test it independently.

### 5. What does yield mean here?

It is the annual yield parameter of the selected semiannual compound cash-flow model. With `b = 1 + y/2`, dirty price discounts remaining coupon/principal flows by the declared fractional-period exponents. A clean-price input is inverted with bounded bisection and a residual/convergence rule. The independent Python oracle uses a different inversion/numerical approach. Accepted yield inputs are decimal fractions in [-0.10, 1.00]; 0.04 means 4%, not 0.04%. Evidence: `app/domain/fixed-income/analytics.ts`, `verification/python/reference.py` and the conventions.

**Senior follow-up:** Why allow negative yields, and why is the bracket finite? Negative yield can be mathematically valid within the declared discount domain; bounds are an explicit simulator contract, not a universal market limit.

### 6. Explain duration, convexity and DV01 precisely.

For dirty price P and annual decimal yield y, modified duration is `-P'/P`, Macaulay duration is `modified * (1 + y/2)`, and convexity is `P''/P`. Duration is displayed in years and convexity in years squared under this declared model. Dollar DV01 is `[P(y-0.0001)-P(y+0.0001)]/2 * par/100`; AI is held fixed. This is a symmetric finite-bump cash sensitivity, not merely duration times a rounded clean price. Evidence: analytics implementation and independent Greek checks.

**Senior follow-up:** Does DV01 certify portfolio risk or credit-spread risk? No. There is no curve engine, spread/default calibration, economic portfolio aggregation or risk-limit system. Explain the selected parallel scalar-yield sensitivity only.

### 7. Why avoid binary floating point for financial inputs?

Wire values are decimal strings. Analytics uses an isolated 50-significant-digit Decimal context; cash midpoint decisions use exact rational/integer comparisons. Quotes preserve twelve decimal places, analytics has declared display scales, and cash rounds once to cents using HALF_EVEN. Display values are not fed back as unrounded economic inputs. Evidence: `cash.ts`, `contracts.ts`, migration 004 and independent Python/SQL execution oracles.

**Senior follow-up:** Is arbitrary precision alone enough? No. Units, convention choice, midpoint policy, boundary behavior and independent expected values still matter.

### 8. Why can split fills differ from one whole fill?

Each real retained execution is rounded once. At the chosen coupon-date settlement and exact ATLAS ask, two 50-par fills each round to 5,003 cents, summing to 10,006; one 100-par fill rounds to 10,005. Reconciliation reconstructs and sums the actual fills. It must not rewrite the execution history to equal a hypothetical full-order calculation. Evidence: `tests/workflow-browser/executions.spec.ts`, `verification/python/execution_reference.py`, `verification/sql/executions.sql`.

**Senior follow-up:** What if UI totals differ by a cent? Check source units, accepted price precision, settlement/accrual and per-fill rounding before attributing it to a race or forcing equality.

## RFQ, lifecycle and transactional evidence

### 9. Why do accepted order status and lifecycle look different?

The frozen RFQ contract keeps its original `PENDING_ACK` status. A separate current lifecycle and immutable version history represent later acknowledgments, rejection, fills and cancellation. Do not mutate a signed-off historical contract to make its initial status look current. Evidence: `db/migrations/004_execution.sql`, `app/server/fixed-income-workflow/order-service.ts`, execution read schemas.

**Senior follow-up:** Which field should a consumer use for present executable state? The explicit lifecycle projection plus its version, not the initial contract field. Test that both remain consistent with their different meanings.

### 10. Which state transitions actually exist?

Acknowledgment takes PENDING_ACK to NEW; business rejection makes it terminal REJECTED. Controlled execution advances NEW/eligible partial state toward PARTIALLY_FILLED or FILLED. A cancellation request creates a pending request, while execution may still win. Its acknowledgment cancels executable remainder without erasing fills; rejection leaves eligible execution possible. Terminal states do not reopen. These controls are synthetic, not peer acknowledgments. Evidence: the transition table in `docs/FIXED_INCOME_EXECUTIONS.md` and migration 004.

**Senior follow-up:** Can the old public equities demo simulate new fills? No. New equity submissions start NEW; seeded statuses and cancellation test bounded behavior. Controlled financial executions belong to the separate local fixed-income workflow.

### 11. What is the hard partial-fill/cancel race?

An in-flight cancellation request does not guarantee that a fill stops. Locks, current version and state decide commit order. If the order fully fills first, resolving the pending cancellation records REJECTED/TOO_LATE while the order remains FILLED. Existing independently connected concurrency tests use lock barriers and assert ledger/state/history, not arbitrary sleep timing. Evidence: `tests/postgres/execution-concurrency.test.ts`, workflow execution tests.

**Senior follow-up:** Is there cancel/replace, correction or trade bust? No. There are explicit finite fill/cancel bounds and no amendment/reopening model. The eighth admitted fill must consume the remaining par.

### 12. What makes quote acceptance atomic?

The controlled transaction locks ownership and RFQ/invitation state, then verifies authority, version, expiry and capacity. It writes RFQ acceptance, exactly one frozen order, an immutable completed receipt and ordered audit events together. Uniqueness/deferred invariants prevent duplicate or inconsistent acceptance. DB time is checked after locks are acquired. Evidence: migration 003, RFQ concurrency/crash/invariant tests.

**Senior follow-up:** Why is transaction-start time dangerous for expiry? A request could wait behind a lock until the quote is no longer firm; checking a stale timestamp could admit an expired quote. RFQ lifetime is 300 seconds; a firm quote lasts at most 30 seconds and never past RFQ expiry.

### 13. Explain idempotency and an unknown outcome.

Before submission the caller retains the original operation identity/key and request. A committed response lost in transit is not proof of failure. Retry/resolution uses the same identity and canonical request, returning its retained receipt without a second economic effect. Different content under the same key conflicts. Current authority/generation is checked before replay; idempotency is not an authorization bypass. Evidence: sandbox client/private journal, RFQ/execution recovery tests and command receipts.

**Senior follow-up:** Why not retry with a new key? It could create a new effect. Why not treat an absent receipt as proof of rollback? The original operation may still be running or its outcome may be uncertain.

### 14. What transaction isolation is used, and where?

Do not give one label to every path. Financial writes use explicit checked-out-client transactions, row locks, version checks, uniqueness and deferred guards. Reconciliation uses a separate REPEATABLE READ READ ONLY transaction for a consistent multi-query snapshot. Local pool/query/lock/precommit bounds limit stalled work. Only declared precommit serialization/deadlock cases receive bounded retry; uncertain commit is not blindly retried as a new operation. Evidence: `app/persistence/postgres/workflow.ts`, migrations and reconciliation scanner.

**Senior follow-up:** How do you prove rollback versus uncertainty? Use actual connection/process termination around COMMIT and resolve retained operation identities; a mocked 500 response alone is insufficient.

### 15. How are ownership and database roles separated?

Synthetic login alone does not create durable ownership. Native bootstrap creates private capabilities; a recovered current binding authorizes a sandbox scope. `tf_app` has scoped reads and narrow controlled entry points, not unrestricted business-table writes. Forced RLS and composite ownership keys add defense. The service reconciler can read retained synthetic financial rows but cannot repair them; its credential never belongs in a browser. Evidence: ownership/bindings services, migrations 001–005 and PostgreSQL role tests.

**Senior follow-up:** Does RLS survive a fully compromised application credential or malicious database owner? Those are outside the claimed assurance; owners can alter guards. This is not production identity or WORM storage.

### 16. What survives restart?

PostgreSQL retains the local financial graph and immutable receipts, subject to the declared retention contract. Equity sessions/books and browser-observed Activity are ephemeral; server session/binding state is lost on restart. Native private ownership/operation journals support explicit recovery. Browser sessionStorage commands are tab-scoped and do not promise closed-tab/power-loss recovery. Evidence: persistence/execution restart tests and private-state/sandbox client.

**Senior follow-up:** Does restarting reset quotas or revive expired ownership? No; retained capacity/lifetimes and current-generation checks remain authoritative. A restart is not permission to replay under stale authority.

## Reconciliation and FIX

### 17. What does a CLEAN reconciliation establish?

Four reviewed hash-bound independent SQL checks completed in one historical snapshot, with valid scope/watermark and no recorded discrepancies, followed by a valid atomic completion. It independently reconstructs receipts/audits, RFQ terms, executions, projections and retained reconciliation metadata as declared. A later transaction can make the report historical. CLEAN does not prove external trade completeness, venue delivery, settlement or financial repair. Evidence: `app/server/reconciliation/`, `verification/sql/` and reconciliation tests.

**Senior follow-up:** What if a checker times out or exceeds the finding bound? FAILED/INCOMPLETE is explicit; partial work cannot be called clean. More than 128 findings retains bounded detail and the known total rather than silently truncating into success.

### 18. Why not repair inconsistencies automatically?

A finding is an assessment, not authorization to modify an economic record. The source may be wrong, the projection may be wrong or external evidence may be incomplete. The implemented reconciler cannot repair financial tables. New assessment IDs preserve earlier results; an interrupted snapshot is not resumed as if no gap occurred. Evidence: read-only scanner, scoped functions and recovery tests.

**Senior follow-up:** Could coherently forged source and projection records evade a consistency check? Internal consistency cannot prove independent real-world truth. Be explicit about threat boundaries and external completeness remaining unverified.

### 19. Which FIX application messages are supported?

A bounded FIX 4.4 profile supports D (NewOrderSingle), 8 (ExecutionReport), F (OrderCancelRequest) and 9 (OrderCancelReject), with selected directions, required tags, symbols, types, values and limits. This is not a full dictionary implementation. In this profile quantities represent USD face/par with tag 854=0, not a generic assumption that tag 38 means equity shares. Evidence: `app/protocol/fix44/profile.ts`, codec, pinned dictionary/provenance and 14 application goldens.

**Senior follow-up:** Do tags 8 and 35=8 mean the same thing? No. Tag 8 is BeginString; the value 8 in tag 35 denotes ExecutionReport. Context and framing matter.

### 20. How do BodyLength and CheckSum work?

Real SOH bytes delimit fields; a displayed pipe is not the wire separator. BodyLength counts bytes after the tag-9 delimiter through the delimiter immediately before tag 10. CheckSum is the modulo-256 byte sum preceding tag 10, rendered in three decimal digits. This detects selected corruption/framing errors; it is not authentication, encryption or cryptographic integrity. The parser has strict frame/field/buffer/value/batch limits and no silent resynchronization. Evidence: `app/protocol/fix44/index.ts` and malformed/fragmented frame tests.

**Senior follow-up:** Why not split on `|` or normalize damaged input? It changes the bytes being validated and can conceal the defect the test is meant to detect.

### 21. What proves sequence behavior?

Parsing canonical tag 34 alone is not session state management. The offline administrative evaluator starts independent I→A and A→I counters at 1 per declared case and advances only an accepted in-sequence direction. C12_SEQUENCE_GAP is OUT_OF_SCOPE/RECOVERY_REQUIRED; C13_SEQUENCE_TOO_LOW is INVALID/SEQUENCE_TOO_LOW. It does not buffer, skip or repair the gap. Evidence: `verification/python/fix_session_reference.py`, session manifest and contract tests.

**Senior follow-up:** Are retained application-lane counters and offline I/A session counters the same runtime engine? No. They serve separate declared models and must not be presented as a connected live session.

### 22. Explain Logon, Heartbeat, TestRequest and Logout in this pack.

Logon A establishes the selected fresh-session handshake with 98=0 and 108=30, with reset absent/N. Heartbeat 0 is ordinary or echoes an outstanding request via 112. TestRequest 1 requires a case-unique 112; one probe per requester may be pending, including crossed probes. An ordinary heartbeat does not clear it. Logout 5 completes the orderly selected exchange after outstanding probes are resolved. Evidence: session contract/guide, Python evaluator and literal transcripts.

**Senior follow-up:** Does 108=30 mean the project actually schedules a 30-second heartbeat? No. This is offline transcript classification; scheduling, elapsed deadlines and current-clock freshness are NOT_EVALUATED.

### 23. What are the recovery limitations?

Marked replay is OUT_OF_SCOPE/REPLAY_UNSUPPORTED. ResendRequest, SequenceReset and reconnect receive explicit unsupported classifications. A missing Logon reply is INCOMPLETE/LOGON_REPLY_MISSING. A new independent offline case is not authorization to reset a real peer session. There is no socket, runtime session engine, durable session store or peer certification. Financial idempotent recovery is a different capability. Evidence: C14/C17/C18/C23/C25 cases and `docs/FIX44_SESSION.md`.

**Senior follow-up:** When should a real engine resend versus gap-fill or reset? Describe only knowledge you can defend from the applicable negotiated/session standard; the lab does not implement or certify those choices.

### 24. What does “59 cases matched” mean?

Each positive, invalid, incomplete and out-of-scope transcript matched its separately authored expected report. It does not mean 59 successful interoperable sessions. Every report keeps peer interoperability, delivery, financial application and external completeness false. Raw hashes, corpus admission and pinned references fail closed; unexpected cases or changed malformed bytes are not automatically accepted. Evidence: corpus verifier, manifest and Node/Python tests.

**Senior follow-up:** Can you pass by replacing all expected outcomes with your parser output? That destroys oracle independence. Expected reports and goldens need separate derivation/review, and known admitted inventories protect the gate.

### 25. What does the controlled FIX application SDK add?

It ties retained protocol work, ownership/fencing and an original financial operation identity to narrow supported application actions. PREPARE is not proof of a financial commit or peer delivery; APPLY and retained receipts have distinct outcomes. Replays must preserve the original identity and cannot bypass current lease/authorization. The offline administrative classifier never invokes this SDK. Evidence: `app/server/fix/application.ts`, `docs/FIX44_APPLICATION.md` and the PostgreSQL application recovery/reconciliation tests.

**Senior follow-up:** Where is the receiving broker? There is none. The simulator's recorded observations and financial effects are not independent venue evidence.

## Automation, debugging and delivery

### 26. What is test-scoped versus worker-scoped?

Each test owns its mutable synthetic session, exact created IDs and browser state, with teardown. A worker fixture shares only immutable health/reference information. Projects select coverage; workers select concurrency. Browser-free API/contract cases run once, while UI/integration journeys cover Chromium, Firefox and WebKit. Shared mutable worker login/reset would create cross-test interference. Evidence: `tests/fixtures/tradeflow.fixture.ts`, factories and `playwright.config.ts`.

**Senior follow-up:** What changes if workers double? Independence should hold; resource limits and measured execution time still need checking. Repetition increases confidence but does not prove the absence of races.

### 27. Why are runtime schemas and independent OpenAPI checks both used?

TypeScript types do not validate network bytes. Runtime schemas reject malformed responses at the client/server boundaries. The independently authored OpenAPI/AJV oracle interprets the wire contract separately, so an HTTP 200 with missing/wrong fields can fail. Exact business assertions still inspect status, code, identity and retained state; schema validity alone cannot prove the right economic result. Evidence: contracts, response schemas, contract tests and malformed-200 UI cases.

**Senior follow-up:** Is independence absolute? Shared written assumptions can still be wrong. Explain how literal goldens, independent Python/SQL, negative cases and review reduce distinct failure risks.

### 28. What is a strong negative test?

It targets the business rule and checks the precise outcome and state. A cancellation of a FILLED equity order asserts the specific 409/error code and a subsequent unchanged FILLED record. A viewer mutation verifies 403. “Any non-2xx” could pass on an unrelated server crash and is insufficient. Invalid inputs should not be silently repaired by a valid-data factory. Evidence: API/contract/integration suites.

**Senior follow-up:** Could a test pass against the wrong seeded record? Yes; own and follow the exact ID rather than taking the first visible AAPL row.

### 29. How do you investigate a flaky test?

Preserve the first failure, source hash, environment, exact request/record and assertion. Separate application, contract, test, data, environment and timing hypotheses. Reproduce the smallest case using controlled request/response or database lock barriers. Confirm with independent state queries; fix the responsible layer and rerun the necessary gates. Later green results alone do not establish the cause or fix of a historical timeout/lifecycle incident. Evidence: existing delayed-session tests, concurrency tests and retained failure records.

**Senior follow-up:** When would you add a sleep or increase retries? Not to conceal an unexplained failure. The existing finite bounds/retry policy are acceptance controls; change them only with independent justification and review.

### 30. What are the reliability gates?

Locked install/audits, types/lint/format, OpenAPI/workflow validation, units, independent financial/FIX oracles, build/smoke and normal/repeated API/browser suites. Persistence additionally requires two fresh owned PostgreSQL executions and baseline/repeated three-browser workstation checks with child-result aggregates. The interview candidate adds one separately owned Chromium rehearsal to workstation-baseline. PostgreSQL/workstation/interview retries remain zero; legacy CI allows a diagnostic retry but rejects a flaky result. Evidence: workflow YAML, strict workflow validator and actual exact-revision run/job results.

**Senior follow-up:** Does successful CI deploy the public TradeFlow app? No. Its separate reviewed public pin is not advanced by source merges; portfolio publication is a different service/release path.

### 31. Why disable authenticated workflow traces/screenshots/video?

They can retain bearer headers, capabilities or browser state. The workflow and interview configurations disable them; native bootstrap keeps capabilities outside the browser. Safe stdout consists of fixed explanations, public expected values and aggregate results. Intentional equities-only failure demonstrations have a separate explicit artifact scope; never use that exception to record the private financial workflow. Evidence: Playwright configs and the setup guide.

**Senior follow-up:** How do you debug with capture off? Use scoped non-secret statuses/identities, controlled independent queries and the reproduced assertion, retaining only reviewed non-secret evidence. Do not print descriptors or connection strings.

### 32. What can you claim about performance and operations?

The optional smoke provides a finite local signal. Capacity/concurrency/recovery tests exercise explicit quotas, bounded work, consistency and cleanup; they do not certify production throughput, latency, availability, HA or DR. Local database persistence is not a tested production backup/restore policy. The rehearsal destroys only its descriptor-owned instance and preserves all unrelated resources and evidence. Evidence: `scripts/perf-smoke.ts`, owned supervisor and resource/restart tests.

**Senior follow-up:** What would a defensible load claim require? A separately specified workload, environment, metrics, dataset, failure criteria and reviewed execution. Do not invent a p95 or volume number to answer an interview question.

## Owner readiness checklist

Before presenting, be able to:

- Reproduce the 99.875/1/100.875 cash example and explain yield, duration, convexity and DV01 units without reading this page.
- Explain bid/ask from the customer perspective; why a quote snapshot, initial contract and current lifecycle differ; and why fills can beat cancellation.
- Write/read a scoped SQL query, explain transaction/snapshot boundaries and resolve an unknown outcome with its original key.
- Inspect a raw SOH FIX frame and distinguish application validation, retained SDK work and offline session classification.
- Explain the independent oracle's assumptions and limitations, and diagnose one real preserved failed assertion without hiding it behind retries.
- Run setup, headless acceptance, interactive checkpoints and owned cleanup, then demonstrate one small code change independently.
- Use truthful employment examples for seniority, production troubleshooting, collaboration and Jenkins/GitLab exposure. Do not replace them with portfolio test counts.

The interviewer's difficult follow-up is an invitation to reason from the implemented contract. If a behavior is outside it, say so and explain the smallest additional evidence needed; do not improvise a feature or production claim.
