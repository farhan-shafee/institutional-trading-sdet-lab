# Reproduce the institutional interview demonstration

November 5, 2026 interview-pack candidate. The accepted application baseline is `8cf67f960c467e982897dea4c063cdd49e971fd7` (Phase 3C0 implementation checkpoint `f31f6e2`). New rehearsal tooling must be reviewed in its PR; it is not a production release. Use [current state](CURRENT_STATE.md), [scripts](INTERVIEW_DEMO.md), [requirements](TRADEWEB_SDET_MATRIX.md), and [study guide](INTERVIEW_STUDY_GUIDE.md).

## Prerequisites and clean installation

Use Linux or WSL Ubuntu, Node 24.x, npm, Python 3.12+, Docker with a running daemon, and Playwright's browser/system libraries. Python has no additional package requirement. The database tool uses its existing digest-pinned PostgreSQL 17 image and private ownership descriptors. Windows-native financial ownership journaling is not claimed; keep source and private files on the WSL Linux filesystem, not an NTFS checkout.

Start from a clean current clone or a separate worktree of the approved revision. Preserve existing untracked plans and evidence. The PR branch is a candidate until approved; record the exact revision you actually use.

```sh
git status --short
git rev-parse HEAD
node --version
npm --version
python3 --version
docker version
npm ci
npm run browsers:install
# On a new Ubuntu installation only, install the trusted Playwright OS dependencies:
npx --no-install playwright install --with-deps chromium firefox webkit
npm run build:ui
npm run interview:verify
```

Do installation and acceptance before the interview, not inside its five-minute timer. A missing daemon/browser/system library is a setup failure, not a skipped passing test. Do not use `sudo npm`, print credentials, or point the app at an unrelated database.

`interview:verify` runs one real Chromium journey in a fresh owned PostgreSQL instance. It starts the real application on an automatically allocated loopback port, authenticates the published synthetic trader natively, creates and binds a synthetic sandbox, and supplies only the ordinary session token to browser localStorage in memory. Capabilities and database credentials do not enter browser storage, URLs or output. Existing tests use the same supported native bootstrap; this is not a graphical ownership-creation feature.

The journey checks an exact equity order's cancellation, the literal analytics cash example, dealer-ask acceptance, a partial execution, cancellation of the remainder, actual read-only SQL ledger values, clean historical reconciliation, raw FIX application decoding/checksum rejection, and 59 offline session expectations. It does not make the FIX checker cause the financial execution. These are deliberately separate demonstrations.

## Interactive presentation

From the same Linux/WSL source directory, with a graphical desktop/WSLg available:

```sh
npm run interview:demo
```

Playwright Inspector opens a real Chromium window. If initially paused, press **Resume** to start. At each labeled checkpoint, inspect the visible state and explain it; press **Resume** for the next checkpoint. The four stops cover analytics; RFQ/execution/reconciliation; terminal FIX output; and architecture/CI discussion. The UI remains a trading workstation: FIX output is in the terminal, code and CI are separate tabs, and there is no invented FIX control panel.

Interactive mode explicitly uses Playwright's debugger, which suspends normal test timing while you inspect the page. It is exploration, not an acceptance result. It is rejected in CI. `interview:verify` rejects ambient `PWDEBUG`/`TF_INTERVIEW_MANUAL`, uses a 30-second test timeout, zero retries and one worker. Existing reliability gates are unchanged. Browser traces, video and screenshots are OFF for both interview modes because workflow sessions carry private material. Do not turn them on for presentation evidence.

Resume through the last checkpoint to complete assertions, purge only this test's retained graph using the existing test fixture, close its server and browser, assert retained capacity zero, and destroy its descriptor-owned disposable database. Exit 0 plus the cleanup line is the automated success result. The tested runtime belongs in the PR evidence; it is not a promise that every machine completes inside an interview slot.

## Stop, interruption and recovery

Ctrl+C requests the existing owned supervisor's cancellation path. It terminates its child process group, then destroys only the allocated instance. Cancellation is nonzero (normally 130), never a completed demonstration. SIGKILL or machine loss cannot guarantee cleanup.

At allocation the runner prints `Interview recovery descriptor: /absolute/path/owner.json`. This identifies only that allocation; it contains no connection material. If interrupted cleanup did not finish, use that invocation's printed path, without displaying the descriptor's contents:

```sh
npm run db:local -- destroy /absolute/owned/private/descriptor.json
```

That command verifies ownership and rejects foreign resources. Never run global Docker prune, remove shared volumes, expire an unrelated sandbox, or search for and delete every `.local` directory. Keep evidence and original checkouts intact. If the owner path is uncertain, inspect ownership read-only and stop before removal.

## Independent and complete acceptance

Stop any manually started `npm start` first: legacy Playwright owns port 3000 and deliberately refuses reuse. The interview helper owns an independent ephemeral port; it does not attach to an arbitrary running app.

```sh
npm run typecheck
npm run lint
npm run validate
npm test -- --repeat-each=2
npm run test:postgres
npm run test:postgres
npm run build:ui
npm run test:workflow-browser
npm run test:workflow-browser -- --repeat-each=2
npm run interview:verify
```

`validate` includes locked dependency audits, formatting, OpenAPI/workflow checks, Node units, independent Python financial/FIX checks, build, production loopback smoke and normal API/browser tests. The two PostgreSQL invocations each allocate a fresh owned instance. Never replace them with a rerun against a retained shared database. The CI baseline-workstation job additionally requires the separate interview rehearsal; its existing timeout and controls remain intact.

For intentional failure investigation, run separately, retain the expected nonzero exit and inspect only its own artifacts:

```sh
# Run this whole guarded block from the repository root.
(
  umask 077
  if [ -L .local ]; then echo 'Refusing symlinked .local' >&2; exit 1; fi
  mkdir -p -m 700 .local || exit 1
  interview_evidence="$(mktemp -d "$PWD/.local/interview-evidence-XXXXXXXX")" || exit 1
  [ -n "$interview_evidence" ] && [ -d "$interview_evidence" ] || exit 1
  case "$interview_evidence" in "$PWD"/.local/interview-evidence-*) ;; *) exit 1 ;; esac
  printf 'Private failure evidence: %s\n' "$interview_evidence"
  if PLAYWRIGHT_HTML_OUTPUT_DIR="$interview_evidence/ui-report" npm run demo:failure -- --output="$interview_evidence/ui-results"; then
    echo 'Expected UI failure was not observed' >&2; exit 1
  else
    interview_exit=$?; [ "$interview_exit" -eq 1 ] || exit "$interview_exit"
  fi
  if PLAYWRIGHT_HTML_OUTPUT_DIR="$interview_evidence/contract-report" npm run demo:contract -- --output="$interview_evidence/contract-results"; then
    echo 'Expected contract failure was not observed' >&2; exit 1
  else
    interview_exit=$?; [ "$interview_exit" -eq 1 ] || exit "$interview_exit"
  fi
  printf 'Both intentional commands exited 1; inspect both reports in %s\n' "$interview_evidence"
)
# Use the exact printed directory to inspect a report afterward:
# npx --no-install playwright show-report /absolute/printed/directory/ui-report
```

The block stops before invoking Playwright if the parent is a symlink or directory creation fails. Exit 1 is required from each intentional demo; another exit is a setup/runtime failure, and exit 0 means the expected failure disappeared. Inspect the failed assertions and attachments as well as the exit codes. The legacy failure demos are different from the private PostgreSQL workflow. Their explicit artifact policy does not authorize capturing private workflow browser state. Keep the new evidence directory private and do not publish raw traces or browser state. The explicit output paths keep earlier evidence intact.

## Capability surfaces

| Capability                                                       | Actual surface                                                             | Public equities pin `265c9e0`                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Equities entry, cancellation, trader/viewer restrictions         | Existing UI and REST; process-local session book                           | Yes, bounded older equities release                |
| Two fictional fixed-coupon bond analytics                        | Accepted-source collapsible UI and stateless REST                          | Not claimed for the pinned equities release        |
| Dealer RFQ, response, accept, controlled lifecycle/fills/cancels | Local PostgreSQL RFQ UI and REST, after native ownership bootstrap         | No                                                 |
| Immutable execution ledger and execution-derived par/cash        | Local RFQ UI/read endpoints; PostgreSQL tables; read-only verification     | No                                                 |
| Reconciliation investigation                                     | Local RFQ UI/REST; native `reconcile:local`; independent SQL               | No                                                 |
| FIX application codec (D/8/F/9)                                  | TypeScript API/SDK and executable tests; terminal demonstration            | No GUI or socket implied                           |
| Retained FIX/application SDK                                     | Opt-in server-side/native SDK and PostgreSQL tests; not browser activation | No                                                 |
| Selected A/0/1/5 session rules                                   | Offline Python classifier, raw corpus, Node contract tests                 | No runtime engine or FIX UI                        |
| UI/API/contract/integration testing                              | Playwright CLI, source, reports and GitHub Actions                         | Test evidence, not a public test-control interface |
| CI/debugging                                                     | GitHub Actions and local terminal/reports                                  | Not an application screen                          |

Do not conflate the two fixed-income instruments with coverage of all credit/rates products, or local transactional persistence with production durability/identity/HA. See the matrix for role-specific remaining gaps.
