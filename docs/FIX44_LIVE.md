# Selected local FIX application — Phase3C2

The opt-in `live-fix-ingress-v1` path connects the pinned local QuickFIX/J3.0.2
and Go v0.9.12 peers to the existing owned SQL financial authority. The feature
remains disabled by default. The implementation is a candidate for human acceptance. Revision-bound
qualification evidence is recorded on its feature pull request.

The selected environment is Linux or WSL with Docker and Node24. Data, orders,
RFQs and dealer responses are synthetic. The peer session selects ATLAS; D/F
travel TRADEFLOW→ATLAS and8/9travel ATLAS→TRADEFLOW. External delivery and external
completeness remain unverified. Callback provenance is a trusted local controller
witness rather than cryptographic external provenance.

See the [design](superpowers/specs/2026-11-07-fix-live-ingress-design.md),
[plan](superpowers/plans/2026-11-07-fix-live-ingress.md) and versioned
[contract](../contracts/fix-live-application-v1.json).

## Boundaries

| Component                  | Responsibility                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live decoder               | Validate exact captured bytes, framing, dictionary/profile, ordered headers and business strings; retain bytes/SHA256 in its separate private provenance registry.                      |
| Private engine bridge      | Hold application wire before forwarding; emit a separate actual FromApp callback; preserve FIFO across application/admin frames and stop when evidence is unresolved.                   |
| Durable controller journal | Retain original observation, request, callback witness, work and financial keys before dispatch; permit one writer and read-only original-intent inspection after a crash.              |
| Opt-in schema9 SDK/SQL     | Verify current proof/generation, owned terms, immutable session/store/connection and byte/callback correlation; fence the lane and apply through the unchanged atomic financial kernel. |
| Independent verifier       | Use a SELECT-only schema9 client, pinned independent SQL, original journal and Python dictionary/rational oracle in one authorized repeatable-read snapshot.                            |

No public HTTP route or database credential is added to the peer container.
Migration009 is explicitly loaded from `db/live-migrations` after owned schema8
bootstrap. Default schema8 loaders/clients and historical reports retain their
existing contracts. Migrations001–008, financial fingerprints/kernel/effect bodies,
legacy byte trust and434 preserved files remain frozen.

Fresh header order is8,9,35,34,49,52,56. Retransmissions insert43=Yafter34 and122after56.
Header timestamps use real UTC calendar dates and exactly three fractional digits.
NewOrderSingle additionally requires21=1 as transport metadata. Original raw bytes
are never re-encoded to obtain admission. The20 literal corpus keeps the six old
captured transport probes as negative cases; only the new profile accepts its
fourteen authored valid vectors. The legacy decoder still rejects the captured
engine header layout with `FIELD_ORDER`.

## Ownership, replay and bounds

Each physical connection receives a fresh registered UUID. Verified process
restarts retain the session/store incarnation and native sequence progression.
SQL sequence slots use store/direction; legacy epoch1 remains offline metadata.
Repeated logical messages reuse their original work and financial key. Fresh work obtains a durable authorized CLAIM under the unchanged15-second
lease before retaining its work/fence. Existing work keeps its original fence and
financial keys. Current proof/generation is checked before original-key replay. New progress also needs
an authorized owner/fence. Missing callback evidence does not become eligibility.

The queue holds at most16 frames and one application per direction is in flight.
Both durable acknowledgment phases are bounded to five seconds. Wire remains
8192 bytes/64 fields/256 bytes per value; envelopes remain24576 bytes including LF.
The64MiB owned budget uses disjoint32MiB runtime,24MiB journal and8MiB host partitions.
Host bridge stdio is capped at7.5MiB with512KiB reserved for verification output.
Control envelopes share the runtime budget. Exhaustion retains existing evidence
and stops admission. Independent quota maxima are not simultaneously promised.

The guest has networknone, no published ports/binds, a read-only root, UID/GID1000,
capdropALL/no-new-privileges,1CPU,1GiB memory/swap,128PIDs,64MiBshm and64MiB state tmpfs.
The application SDK retains pool4/pending12 and the existing connection/query/
statement/lock/idle/transaction bounds. Retry is limited to known pre-COMMIT
40001/40P01 failures. Unknown COMMIT is recovered explicitly with the original key.
The independent reader retains the existing SELECT-only verifier's pool2/pending4
and transaction bounds.

Controlled reconnect first retires the exact old socket objects and drains their
bounded writer queues. Administrative bytes interrupted by that planned retirement
are retained as interrupted_admin_bytes, never as forwarded bytes. A retired
socket cannot supply an application frame to the next connection. Unexpected
socket errors remain unresolved; only named closure/reset errors on explicitly
retired sockets can complete the old read as a disconnect. The receipt retains
those error numbers and interrupted-admin counts. Complete transport evidence
accounts for those interruptions and does not establish delivery.

During replacement of the Go acceptor, the Java initiator is paused until the new
acceptor emits READY. Existing connection, acknowledgment and socket deadlines
remain unchanged. The mandatory native regression exercises immediate reconnect
and both peer restarts; four socket controls force retired-admin interruption and
check that unplanned I/O and retired application input remain fail-closed.

Shutdown closes new startup, send and reconnect admission synchronously. The
controller tracks each original bridge lifecycle promise before its first yield.
Callers still starting or retaining an undispatched send/reconnect intent reject
with FIX_LIVE_STOPPING before any later dispatch; original durable intent stays
retained. Already dispatched sends drain through their original callback and
application, and dispatched reconnects through CONNECT and ARMED, before STOP.
Startup cannot report readiness after shutdown begins. Caller settlement, event
draining and STOP confirmation share the existing 15-second shutdown budget;
process exit retains its five-second bound. An unexpected process exit with
outstanding bridge lifecycle callers fails closed. Explicit recoverKnown is the
separate durable SQL recovery path, including after engine failure; it does not
dispatch commands to the stopped bridge.

The two bridge directions can observe cancel and execution traffic for one order
before either callback is accepted. The controller retains and accepts those
callbacks without waiting inside the callback handler for financial application.
Only once all currently observed callbacks for that order are accepted does it
apply eligible work in original retained observation order. Independent orders
remain eligible; newly queued bridge events take priority between applications.
Original SQL admission guards and financial/request keys stay intact. Callers
settle after their original application, and unresolved frames block reconnect or
successful shutdown. Two real-native controls force both observation orders and
check the independent financial oracle.

The host budget observer counts bytes conservatively when an owned regular inode
is unlinked between pathname lookup and metadata collection. Such an inode has no
remaining links; its observed bytes are still charged. Retained hard links,
symlink files/directories and nonregular files remain rejected. Five mandatory
filesystem controls cover normal accounting, vanished paths, the real unlinked
inode state and unsafe paths. Rejections retain path/mode/link diagnostics. The
earlier EVIDENCE_PATH failure lacked that detail; the independently reproduced
unlink race is not presented as forensic proof of its exact inode.

## Crash outcomes

The process-kill controls target an actual fill after an owned acknowledgment.
They kill the controller with SIGKILL at a real transaction/callback barrier.

| Window                                 | Required observed outcome                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Durable SEND before wire write         | No observation/request exists; retained send forces INCOMPLETE and is not automatically resent.        |
| Captured frame before OBSERVE request  | Orphan original frame forces INCOMPLETE; missing callback/request is not reconstructed.                |
| Before observation COMMIT              | Original OBSERVE may commit once; the missing callback keeps the fill unapplied.                       |
| After observation COMMIT               | Original OBSERVE replays; raw evidence remains insufficient to apply.                                  |
| Native callback before durable journal | No original ACCEPT request exists; recovery refuses to reconstruct it and the fill remains unresolved. |
| ACCEPT COMMIT before acknowledgment    | Original ACCEPT replays; financial work remains incomplete.                                            |
| Before financial COMMIT                | Original APPLY uses the retained prepared financial key and produces one fill/cash/position effect.    |
| After financial COMMIT before response | Original APPLY replays the existing result with no second execution or capacity consumption.           |

`recoverLiveRequest` defaults off and reads retained intent without clearing a
stale writer lock. `LiveFixController.recoverKnown` uses the same admission.
Current authority and unchanged payload remain required. Store loss, missing
native evidence or an unrecoverable fence stays unresolved; a replacement store,
callback or financial key is never invented. An actual duplicate-order rejection
(103=6) also remains unresolved under the existing financial rule. A supported
synthetic rejection uses103=99 and the existing rejection reason.

## Running the complete gate

```sh
npm ci
npm run test:fix-live-application
```

Normal native shutdown disarms application admission and retires exact owned sockets before child STOP. Writers remain active until the bounded network-producer join completes, then drain within the existing two seconds and join within the existing one second each. Interrupted administrative bytes remain distinct from forwarded bytes; application holds, foreign socket errors, surviving producers/writers and partial received frames prevent a complete receipt. Ten regression controls cover these boundaries, including failed and partial startup.

The mandatory118-control gate builds a fresh pinned image, creates private owned
PostgreSQL instances, installs schema9 explicitly, checks runtime isolation,
freezes source inputs and retains failed attempts with ownership-checked cleanup.
Its groups are31 bridge/native,10 independent Python,5 host filesystem,30 SQL admission,14 controller,
14 independent application/reconciliation,8 real process-kill recovery and6
lifecycle controls. The lifecycle set includes both conventions/BUY/SELL fills,
rejection, cancel rejection/acknowledgment, partial cancel, pending-cancel fills,
too-late cancellation, logical replay and verified peer restarts.

The new CI workflow runs this gate independently. `npm run validate:all` includes
it after the unchanged legacy gates. Normal validation, repeated browsers, two
full PostgreSQL runs, workstation baseline/repeat, public-demo and the standalone
43-scenario/89-control runtime are still required for release qualification.
Gate logs/summary are under `artifacts/fix-live-application-*`; durable private
case evidence stays under ignored `.local/fix-live-gates`.

Independent live reports carry their own schema9/profile, SQL/source hashes,
snapshot ID and financial/protocol/live observation/live acceptance watermarks.
They reconcile retained SEND/frame/request evidence in both directions, including
crash windows before SQL requests exist. Each local send binds its command ID and
physical connection to exactly one observed frame. Unexplained intent remains
INCOMPLETE. They check accepted bytes against the journal's actual callback witness, correlate
original keys/work/effects and recompute each fill using rational arithmetic.
SQL and controlled corruption cases cover raw/callback bytes, process IDs, live
sequence slots, request/financial fingerprints, capacity and missing witnesses.
A report can establish observed local application consistency; external delivery
and external completeness remain false.
