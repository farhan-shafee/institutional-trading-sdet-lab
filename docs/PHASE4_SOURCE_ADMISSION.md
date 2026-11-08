# Phase4 source admission for native qualification

The owner approved exactly the three additional source hashes in draft PR38 on November8,2026, after reviewing candidate b875714bd50bfe1c12ac4254372c681fe122dd6f. This approval permits native qualification. The unresolved local financial finding, final financial/model/test acceptance, protected integration and public release remain separate.

## Immutable approval chain

The original434-file manifest remains byte-identical (SHA256 d75f72090bafb12f51990bbe8e95aaba5a72c014fed291a3a8199c2303fc5f07). The Phase4A v2 contract remains byte-identical (SHA256 d9bc9d63bdf286952fb009a4d478a3d714678705ceec03b15741ad73783649e9), as do its loader and13 controls.

The v3 contract has fixed SHA256 2950d631d256e715935938bbc253af92aaa565537a48e79bcadf7630037d00ab. It requires the exact v1/v2 chain and replaces only these three effective approved hashes:

| Path                                       | Approved Phase4A SHA256                                          | Approved candidate SHA256                                        |
| ------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| app/server/fixed-income-workflow/routes.ts | 86be2fb8393218a7d1eb7d53d879e56d524f995c5a5fd02bf060ea39e98ab18f | 01758c9baeeb1e00d70240543dad53f83b361e5837c2c6193c556524b35c704f |
| app/server/fixed-income.ts                 | cca68918c45ecac3fce25649211466b30a1dc76c7759e89656ded72a5868fcf6 | 83c6a36eea9eaa9b7ae6b09884d4b99edb105ce7a6d11b5991d2681ebe016f13 |
| contracts/openapi.yaml                     | dfb15fb8ddef03b35950c9fdb1276e860a280bf111209ea2164341b5522154c9 | cc8266a374c8b0455836dd84824a10e3bdfc5a74ff463e022b9b9f1b27baf3ca |

All other431 original hashes remain unchanged. Missing, modified or symlinked metadata fails closed. There is no fallback to an earlier version, live-file hash refresh or general exception rule.

## Historical controls and current controls

The v2 controls correctly expect Phase4A bytes. A20,267-byte ZIP fixture retains exactly the three earlier files from accepted main52c76da; its SHA256 is484d01c4a404eae9726940ba1568682e084c87c96643497ceec546bacecdfe3a. Its entries are verified against the unchanged v2 hash map. The original13 controls run unchanged in a private temporary historical root. This root never supplies native build or runtime source. The historical source ZIP is excluded from the peer image; its14 daemon-boundary fixtures use an isolated synthetic marker for that host-only input.

The current gate then requires eight v3 preservation controls, one additional typed-receipt control and two entry-point controls covering all three native orchestrators. The final typed receipt requires24 passes:18 preservation and6 admission controls, zero failures/errors/skips/expected failures/unexpected successes. Missing discovery cannot pass. Real isolated child probes exercise missing, skipped, expected-failure and unexpected-success controls.

The existing14 daemon-boundary controls retain their behavior, status and cleanup assertions. Only their preservation fixture/receipt and literal metadata expectations advance to431 original files,3 replacements and version3. The session matrix remains43 cases/89 controls, the application matrix118 controls and the additional post-trade journey1 test.

All three orchestrators and direct post-trade test admission use v3. Source/dependency inputs are frozen and rechecked after execution; the session gate explicitly freezes the added metadata, fixture and test files. Native deadlines, retries, isolation, evidence and resource ceilings are unchanged. Source admission alone is not a native pass.

## Financial finding retained

At b875714,20 non-native push/PR jobs passed on first attempts; six native jobs refused the then-unapproved source and two dependent aggregate jobs failed. All refusal artifacts remain retained.

One separate local original-suite run failed454/455 with one financial SQL finding in the FIX-capacity boundary case. Its detailed row was not captured before the original test cleaned up. Bounded follow-up diagnostics, including a full455-plus77 pass and198 concurrent workstation cases, did not reproduce it; all328 observed financial-query results were clear. Root cause remains unknown. No source correction, retry relaxation or qualification waiver has been made. This remains an integration blocker even if native qualification passes.
