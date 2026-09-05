# Stage A/B execution-host audit

Date: 2026-09-05. Reviewed HEAD: `33f9d34f4`; local main: `5b458457a94b689713491d158e751553d676be6a`. Main is an ancestor of this branch. The working tree was clean at audit start. This audit changes no production code, committed tests, migrations, or normative specifications.

Review result: **ERROR / fail**. The architecture provides useful boundaries, but the implementation does not satisfy several accepted Stage A/B durability, fencing, migration, and security requirements. The findings below concern existing scope. Deferred Stage C/D features are identified separately.

## Scope and stage naming

Stage A baseline: `06aa7f7e137773cb31d55610148fe138f14c7be8`, [completed plan](.ai-factory/plans/claude-stage-a-execution-host-plan-6d70f9.md). Stage B: [accepted plan](.ai-factory/plans/feature-stage-b-durable-execution-host-data-plane.md), [ADR-167](docs/decisions/adr-167.md). [ADR-023](docs/decisions/adr-023.md) governs the filesystem boundary together with actual call paths.

The phrase “B2. Workspace/Git ownership cut” does not name the B2 increment in this repository. B2 means [manager projections, browser SSE, and canonical run lifecycle](.ai-factory/plans/feature-stage-b-durable-execution-host-data-plane.md:1658). The accepted plan [defers repository/workspace ownership and multi-host placement](.ai-factory/plans/feature-stage-b-durable-execution-host-data-plane.md:85) to Stage C. [ADR-166 D12](docs/decisions/adr-166.md:229) preserves this sequence.

| Capability | As built | Stage |
| --- | --- | --- |
| Host identity, boot identity, assignment IDs/epochs, command receipts, opaque adopted WorkspaceHandle | Implemented foundations; late-ACK fencing and retention defects below | A, with corrections required |
| SQLite host outbox, Postgres canonical events, durable ACK/replay metadata, browser DB replay | Implemented; pressure and autonomous projection recovery incomplete | B |
| Accepted prompt command and serializable PromptHandle | Implemented wire seam; durable owner continuation incomplete | B |
| Host-owned runtime objects with manager metadata and authorized content proxy | Implemented; event-before-ACK, content safety/integrity and import defects below | B |
| Host-owned clone, worktree lifecycle, CLI/check execution, Git effects, capability/context materialization and workspace GC | Not implemented as an ownership cut | C |
| Two isolated local hosts, placement, drain, per-host capacity and lease renewal | Not implemented | C, after ownership cut |
| Trusted remote enrollment/authentication, relay and remote secret delivery | Not implemented | D |

## Filesystem and execution ownership inventory

The following are existing product paths, not reasons to expand Stage B retroactively.

| Interaction | Current owner and concrete implementation | Required next-stage treatment |
| --- | --- | --- |
| Clone/cache/source resolution | Web: [cloneRepo](web/lib/repo-source.ts:237), Git clone at line 287, resolveProjectSource at line 432 | Host materialization from a server-derived repository specification; central source identity remains manager-owned |
| Fetch/remote access | Web: [fetchRemote](web/lib/worktree.ts:1190), [sync target](web/lib/runs/sync-target.ts:874), [delivery scan](web/lib/scheduler/handlers/repo-delivery-scan.ts:138) | Host-bound commands and credential-profile references |
| Worktree creation | Web: [run admission](web/lib/services/runs.ts:1457), [scratch launch](web/lib/scratch-runs/service.ts:886) | Durable materialization intent before remote effect; cleanup/reconciliation after uncertain acknowledgement |
| Workspace adoption/release | Web supplies [path and repoPath](web/lib/execution-host/adoption.ts:54); supervisor [registers existing paths](supervisor/src/workspace-registry.ts:129), release marks the handle released | Evolve to host-created opaque workspace; bounded adoption only for migration |
| CLI and checks | Web [spawns CLI](web/lib/flows/runner-cli.ts:78) with [local worktree cwd](web/lib/flows/runner-cli.ts:265); check/command_check share this path | Host-owned child process, timeout/cancel/result/evidence contracts; web retains Flow decision policy |
| Git status/diff/log | Web [worktree wrappers](web/lib/worktree.ts:1862), [artifact-content resolver](web/lib/flows/graph/artifact-content.ts:203) | Typed bounded queries/projections, no browser/web path transport |
| Git checkpoint/rewind | Web [captureCheckpoint](web/lib/flows/graph/workspace-checkpoint.ts:120) writes Git tree/commit/ref | Host-owned Git operations; distinct from ACP session checkpoint |
| Sync/push/promotion | Web [sync/rebase](web/lib/runs/sync-target.ts:927), [promotion side effect](web/lib/runs/promote.ts:901), push at lines 1019/1370 | Manager authorization, review and target policy; host Git effects fenced by durable workspace operation |
| Capability/skill files | Web [materialize-bundle](web/lib/capabilities/materialize-bundle.ts:198), [materialize](web/lib/capabilities/materialize.ts:232); B publishes profile/instructions objects | Freeze approved bundle and materialize on selected host; keep catalog/trust/authoring policy central |
| Context repositories | Web [context worktrees](web/lib/context-mounts/service.ts:146), release at line 176 | Host materialization, immutable source revision and consent snapshot |
| Workspace modes | Web [agent launch](web/lib/agents/launch.ts:3501) prepares plain, own/shared, repo-read workspaces | Explicit mode matrix, including workspace-less execution and scratch |
| Filesystem GC/reconciliation | Web [workspace GC](web/lib/gc/workspace-gc.ts:450), [reconciler](web/lib/gc/workspace-reconciler.ts:432), [boot recovery](web/lib/reconcile.ts:1355) | Preserve-before-delete host command, owner-scoped reconciliation and retained archive/result metadata |
| Runtime events/logs/transcripts/costs | B stores canonical events/read models centrally; raw ACP files stay host-owned | Fix R01–R06 and retention. Do not restore event-file authority |
| Runtime evidence/attachments | B object registry and content proxy; manager-authored evaluation/inline/gate/HITL/CLI evidence retains separate ownership | Fix R09/R11–R15; migrate CLI-produced bytes with CLI execution, retain manager-authored content centrally |

The web runtime-data mount removal is narrower than removal of web repository access. The same-host filesystem dependency still permits web Git/CLI operations while supervisor adopts the resulting workspace.

Two-host operation also requires changes beyond URL configuration:

- [schema.ts](web/lib/db/schema.ts:2113) permits only one non-retired `local_direct` host.
- [placement.ts](web/lib/execution-host/placement.ts:42) always selects the local host; [resolver.ts](web/lib/execution-host/resolver.ts:171) validates assignments against that singleton.
- [local-direct transport](web/lib/execution-host/transports/local-direct.ts:21) uses the global wire client, which reads one [MAISTER_SUPERVISOR_URL](web/lib/supervisor-client.ts:495).
- [lease_expires_at](web/lib/db/schema.ts:2151) is reserved; [mintAssignment](web/lib/execution-host/assignments.ts:180) does not activate renewal/expiry.
- [scheduler](web/lib/scheduler.ts:110) enforces global caps and shared-writer constraints, not per-host resource capacity.
- [supervisor heartbeat](supervisor/src/heartbeat.ts:16) tracks ACP child exit/orphans. It is not a host-registry liveness protocol.

## Findings

P1 denotes a release-blocking correctness/security/durability defect in accepted A/B scope. P2 denotes a required correction with a narrower impact or a verification gap. “Code trace” means a confirmed reachable implementation path, not a completed end-to-end reproduction. Tests proposed below are acceptance tests for subsequent fixes; this audit does not claim they already pass.

### R01 · P1 · A valid-sized ACP stdout line can terminate the supervisor

**Evidence:** [spawn limit](supervisor/src/spawn.ts:22), [stdout callback](supervisor/src/spawn.ts:296), [synchronous publish](supervisor/src/spawn.ts:320), [registry](supervisor/src/registry.ts:78), [event validator](supervisor/src/runtime-events.ts:163), [publisher](supervisor/src/runtime-event-publisher.ts:130).

Spawn permits a line up to 1 MiB. Canonical payload validation rejects an individual string above 65,536 bytes. The synchronous registry/publisher callback propagates the error out of the stdout data handler. A JSON-RPC result or tool notification within the existing stdout limit can therefore terminate the supervisor and disrupt its other sessions.

**Dynamic evidence:** a real SessionRegistry + RuntimeEventPublisher + in-memory SQLite HostState, receiving a 65,537-byte `session.line`, emitted `uncaughtException: runtime event payload string exceeds maximum bytes`.

**Required correction:** define bounded canonical summaries/object references for large raw output and isolate publication failures at the process boundary. Preserve raw bytes where required. Neither silent truncation nor a process-wide catch-and-ignore satisfies EVT-02/08/09.

**Acceptance:** real ACP child emits boundary-sized and oversized lines/tool results; supervisor and a parallel session survive; sequence continuity holds; the result exposes an explicit typed object/error outcome.

### R02 · P1 · Outbox admission and storage pressure disagree; active execution has no safe backpressure

**Evidence:** [limits](supervisor/src/host-state.ts:34), [admission](supervisor/src/host-state.ts:1077), [append capacity](supervisor/src/host-state.ts:1288), [ACK grace pruning](supervisor/src/host-state.ts:1597).

Admission checks unacknowledged bytes. Append checks all retained bytes, including ACKed events retained for 24 hours. The regular partition is 56 MiB. Continuous successful delivery can fill that partition while admission still accepts commands. Existing ACP output then throws `event_outbox_hard_limit` through the R01 path. There is no producer pause/resume mechanism that preserves the event and terminal reserve.

**Dynamic evidence:** append 60-KiB lines and ACK each immediately. After 948 events: retained bytes 58,702,894; unacknowledged count/bytes 0; next append rejects with hard limit; `assertCanAcceptMutatingCommand()` still accepts.

**Specification drift:** the [accepted budget table](.ai-factory/plans/feature-stage-b-durable-execution-host-data-plane.md:317) specifies 400/512 MiB, 16 MiB reserve and row limits; code uses 48/56/64 MiB and no corresponding row limits. Choosing different numbers requires an explicit reconciled decision, not a claim that the original acceptance passed.

**Acceptance:** saturate retained and unACKed partitions independently; prove bounded memory/disk and safe producer pause/resume, admission refusal, cancellation/checkpoint/terminal progress, and no missing events. Wire the chosen settings through runtime validation and all deployment/configuration surfaces.

### R03 · P1 · ACKed events can remain unprojected forever after restart or transient failure

**Evidence:** [batch default](web/lib/execution-host/events/projector.ts:80), [boot calls](web/instrumentation.ts:95), [prompt catch-up](web/lib/execution-host/events/prompt-projector.ts:278), [lifecycle catch-up](web/lib/execution-host/events/lifecycle-projector.ts:270), [object catch-up](web/lib/execution-host/events/runtime-object-projector.ts:381), [ingest trigger](web/lib/execution-host/events/consumer.ts:333).

Boot applies one batch of 100 events per run/consumer. It does not drain the backlog. Further production wakeups depend on a newly accepted event; duplicate replay does not trigger projection. No autonomous worker services these consumers' `nextRetryAt`.

Crash after ingest+ACK but before projection of 250 events leaves the tail unapplied after restart if the host emits nothing else. A transient error on the last event can remain in `retrying` past its deadline. Filling a shared-stream gap can also release events for another run without waking that run's projector.

**Impact:** command completion, session lifecycle and object catalog can stay stale despite durable canonical evidence. This violates T1.4, EVT-07/10 and PRM-11.

**Acceptance:** real Postgres backlog >2 batches with terminal event after event 200, restart and no new ingest; transient last-event failure followed by backoff; two-run gap promotion. All reach their durable cursors through a bounded worker with fair scheduling and shutdown behavior. No filesystem polling.

### R04 · P2 · Failure of the first projection batch loses durable poison/retry state

**Evidence:** [transactional consumer initialization](web/lib/execution-host/events/projector.ts:84), [failure handler](web/lib/execution-host/events/projector.ts:222), [missing-row exception](web/lib/execution-host/events/projector.ts:265).

The first projection transaction creates the cursor and applies events. An apply failure rolls back the cursor insertion. The separate failure transaction expects that row to exist and throws `execution event consumer row disappeared after projection failure`. It loses the original event error, attempts, poison ID and backoff.

**Dynamic evidence:** real Postgres probe reproduced this exception for the first pending-object event. The existing [poison test](web/lib/execution-host/events/__tests__/ingest.integration.test.ts:464) first creates a successful cursor and misses this case.

**Acceptance:** deterministic and transient failures on a previously absent consumer persist the original failure and correct retry/poison fields; independent consumers progress. A delayed failure recorder must not poison a cursor another worker has already advanced.

### R05 · P1 · PromptHandle has no durable owner continuation

**Evidence:** unused owner/application columns in [schema](web/lib/db/schema.ts:2227); [prompt issue](web/lib/execution-host/client.ts:461); [new command UUID](web/lib/execution-host/ledger.ts:120); [command insertion](web/lib/execution-host/commands.ts:49).

Runtime code does not write/read `ownerKind`, `ownerRef`, `logicalOperationKey`, `requestSchema`, `requestSha256` or `completionAppliedAt`. The nullable check/partial unique index therefore cannot enforce PRM-02/04. A serializable `{commandId}` identifies evidence but does not recover the domain operation that must apply it.

Reachable owner failures:

- **Scratch:** [message/status commit](web/lib/scratch-runs/service.ts:2110) stores Running; [events caller](web/lib/scratch-runs/events.ts:751) holds the handle on the stack; [post-wait transition](web/lib/scratch-runs/service.ts:2219) alone returns WaitingForUser. Web restart followed by a completed turn with a still-live session loses that continuation. [Reconcile](web/lib/reconcile.ts:350) skips the live scratch session and [dialog permission](web/lib/scratch-runs/dialog.ts:119) denies the next message.
- **Gate chat:** [wait](web/lib/services/gate-chat.ts:1181) precedes [reply persistence](web/lib/services/gate-chat.ts:1258). Restart loses this caller; [expired-turn recovery](web/lib/services/gate-chat.ts:435) aborts the turn with LEASE_EXPIRED instead of applying its completed command.
- **Flow recovery:** [reconcile](web/lib/reconcile.ts:1735) can redispatch through [resume-driver](web/lib/runs/resume-driver.ts:522) instead of attaching to the original accepted operation. Recovery must distinguish continuation of an existing command from a new prompt.

**Acceptance:** persist typed owner/logical request identity before dispatch; enforce request-bound idempotency; apply terminal result and owner completion marker under a transaction/fence; provide a restart worker. Test scratch, gate chat, Flow/node attempt, agent and sync owners independently at restart-before-terminal and terminal-before-apply boundaries. One owner test cannot prove another owner's persistence path. T3.2/T3.3 and PRM-04/11 remain incomplete.

### R06 · P1 · Receipt recovery is a second prompt terminal writer and creates false conflicts

**Evidence:** [receipt folding](web/lib/execution-host/recovery.ts:130), [error flattening](web/lib/execution-host/recovery.ts:208), [recovery dispatch](web/lib/execution-host/recovery.ts:386), [boot order](web/instrumentation.ts:75), [canonical equality check](web/lib/execution-host/events/prompt-projector.ts:219), [wait equality](web/lib/execution-host/deliverer.ts:794).

Generic Stage A recovery still settles prompt commands from receipts before their canonical terminal event. For rejected receipt `{code,message,details:{reason:"turn_lost",runId}}`, it stores `{code,message,reason}`. The subsequent valid canonical event differs and triggers permanent `prompt_terminal_conflict`. An agreeing success receipt can also settle a wait before canonical terminal evidence, contrary to PRM-03/06.

The [old V3 assertion](web/lib/execution-host/__tests__/command-recovery.integration.test.ts:340) expects receipt-only failure and therefore preserves the weaker behavior.

**Acceptance:** one terminal reducer; preserve exact validated receipt evidence; receipt-first completed and rejected cases wait for canonical agreement; no legitimate event poisons a consumer because another writer normalized the body differently. Historical command settlement must not mutate a current owner.

### R07 · P1 · Exhausted network retries falsely terminalize an executing prompt

**Evidence:** [startAsyncPrompt receipt lookup failure](web/lib/execution-host/deliverer.ts:464), [terminal write](web/lib/execution-host/deliverer.ts:477), [projector terminal conflict](web/lib/execution-host/events/prompt-projector.ts:205).

Host accepts the first prompt and starts ACP; the 202 is lost. A partition blocks receipt/SSE lookup beyond the retry budget. The manager records `failed/receipt_lookup_failed`, although it has no evidence that the side effect failed. On reconnect, accepted events cannot reopen the failed command and a valid success conflicts with that fabricated terminal state.

**Acceptance:** retain an explicit recoverable unknown-admission outcome using the same command ID; return an actionable transport status without declaring domain execution failed. Hold ACK, receipt and SSE past retries while ACP completes, then reconnect: exactly one ACP action and one correct owner application.

### R08 · P1 · A late session.create ACK from an old epoch overwrites the current session binding

**Evidence:** [unconditional onAck](web/lib/execution-host/deliverer.ts:353), [applyCreateAck](web/lib/execution-host/create-ack.ts:24), [unconditional binding upsert](web/lib/runs/active-run-session.ts:197).

A successful create for epoch N can have a delayed response. The manager installs epoch N+1 and a new logical session; receipt recovery or the late response for N then upserts the same `(runId,sessionName)` without checking the current assignment. `onAck` also ignores whether the command-state CAS changed.

**Impact:** current `run_sessions` points to the superseded host session; later input/cancel/resume targets the wrong incarnation. This is a Stage A fencing defect even on one host.

**Acceptance:** delayed ACK and recovery fold for N may settle historical command evidence but cannot replace N+1's binding. Guard binding application under the authoritative assignment transaction. Exercise both live delivery and restart recovery.

### R09 · P1 · Pending runtime-object availability cannot project before the HTTP ACK

**Evidence:** [pending catalog insert](web/lib/execution-host/client.ts:694), [sameBinding predicate](web/lib/execution-host/events/runtime-object-projector.ts:168), [matchesPendingIntent](web/lib/execution-host/events/runtime-object-projector.ts:232).

Pending rows contain null size/hash. `sameBinding` requires size/hash to equal the sealed event; `matchesPendingIntent` also requires both fields to be null. No pending row can satisfy this conjunction.

**Dynamic evidence:** real Postgres, event-before-ACK and an existing cursor produced `projected:0, poisoned:true`; catalog remained pending, with `runtime object available event conflicts with immutable metadata`. A new cursor exposes R04 instead. Both expected-correctness probes failed, confirming the two defects; [JSON evidence](/private/tmp/stage-ab-review-runtime-object-race.json).

**Acceptance:** compare identity/declarations separately from sealed metadata; event-before-ACK, ACK-before-event, ACK loss, replay and conflicting immutable metadata behave consistently. Catalog becomes available exactly once without poison for a valid pending intent.

### R10 · P1 · Age-only receipt and command pruning deletes recovery/idempotency evidence

**Evidence:** [7-day receipt TTL](supervisor/src/host-state.ts:26), [prune query](supervisor/src/host-state.ts:765), [startup prune](supervisor/src/host-state.ts:1145), [accepted-turn recovery startup](supervisor/src/http-api.ts:501), [manager prune](web/lib/execution-host/commands.ts:344), [missing-receipt wait](web/lib/execution-host/deliverer.ts:781).

Host pruning includes accepted receipts. Startup deletes them before recovering accepted prompts, so an old accepted turn can disappear without `turn_lost`. Manager terminal commands also prune by age without ACK/owner/run eligibility. An aged command retried within a still-valid binding can lose deduplication evidence; a terminal wait with no receipt can remain pending without a reconciliation outcome.

**Acceptance:** PRM-12 eligibility must include terminal ACK, owner application, terminal run and replay grace, with a durable protocol for host knowledge of eligibility. Test accepted commands, long pauses/outages, completed-but-unapplied owners and eligible tombstones with controlled time. Derive expiry from state, not seven days alone.

### R11 · P1 · Historical Stage A runtime bytes have no complete import path

**Evidence:** [legacy file allow-list](web/scripts/import-legacy-execution-data-plane.ts:303), [unpreserved file refusal](web/scripts/import-legacy-execution-data-plane.ts:340), [file-locator refusal](web/scripts/import-legacy-execution-data-plane.ts:603), [zero-object proof](web/scripts/import-legacy-execution-data-plane.ts:758).

The importer imports event/cost facts but refuses residual logs, session/checkpoint files, nested evidence and `locator.kind=file`. It does not transfer their bytes or migrate their locators; the runtime-object proof records importedCount 0.

The Stage A baseline's workspace registry derives a step log path and spawn opens it for ordinary sessions. Thus a normal historical ACP run can block migration 0135, not merely a malformed fixture. Failing loudly protects data, but operators lack an implemented preservation workflow to resolve that refusal.

**Acceptance:** full Stage A history fixture containing logs, transcripts, session/checkpoint metadata, uploads and evidence/file locators; resumable idempotent import; real migration; remove legacy mount; history and content remain accessible. Keep missing/conflicting bytes explicit and block destructive cutover. Do not delete source files or manufacture proofs to pass preflight. T4.1 and CUT-03/07/09 need this positive path.

### R12 · P1 · Runtime-object content can execute stored HTML/SVG in the web origin

**Evidence:** [raw uploaded MIME/bytes](web/lib/scratch-runs/request.ts:34), [upload persistence](web/lib/scratch-runs/service.ts:441), [content response](web/app/api/runs/[runId]/runtime-objects/[objectId]/content/route.ts:93).

Multipart parsing checks size. The service validates names/size and stores supplied MIME and bytes; it does not reject or sanitize active HTML/SVG. The authorized content route serves the MIME inline without attachment disposition, nosniff or a sandbox CSP. No general web CSP/nosniff policy was found in the inspected code.

A permitted uploader can store active content and send its object URL to another authorized reader. Opening it can execute JavaScript in MAIster's origin under the reader's session. Run/project authorization does not neutralize active document content.

**Evidence level:** complete source-path validation; no exploit was executed against a user's browser/session.

**Acceptance:** browser tests open uploaded HTML and script-bearing SVG and prove no script execution or authenticated side effect. Arbitrary content uses safe download headers; inline previews require an explicit safe MIME/sandbox policy. Preserve filenames without header injection and keep the existing authorization boundary.

### R13 · P2 · Object reads trust old metadata without validating the current file

**Evidence:** [readable object lookup](supervisor/src/runtime-objects.ts:469), [stream setup](supervisor/src/http-api.ts:1392), [file stream](supervisor/src/http-api.ts:1427), [manager header checks](web/lib/execution-host/runtime-objects.ts:301).

After seal, a same-size byte change returns new content with the stored SHA. Manager checks matching headers, not body integrity. File unlink or post-seal symlink replacement also bypasses a defined missing/corrupt state transition on this path. A private pathname in SQLite does not establish immutable file identity.

**Acceptance:** define a practical immutable-file/read-validation policy that preserves bounded streaming; test same-size tamper, truncation, unlink and symlink replacement. Return typed missing/corrupt outcomes and durable catalog evidence; do not label unverified bytes with an obsolete digest. OBJ-04/07/12 must hold.

### R14 · P2 · Runtime-object retention can starve objects beyond its first batch

**Evidence:** [candidate LIMIT](web/lib/execution-host/runtime-object-retention.ts:142), [post-limit eligibility checks](web/lib/execution-host/runtime-object-retention.ts:154).

The sweep selects at most 100 expired available objects before testing durable references/live sessions. It has no cursor/order/attempt marker. A stable protected first batch can consume every sweep while later eligible objects accumulate.

**Acceptance:** >100 expired objects with a protected first page and deletable later pages; bounded sweeps reach later eligible rows. Use a progressing keyset/eligibility strategy, preserve references and retryable deletion commands, and expose deferred/failure metrics.

### R15 · P2 · Content-Digest on HTTP 206 describes the wrong bytes

**Evidence:** [response header](supervisor/src/http-api.ts:1419), [test requiring whole-object digest on a partial body](supervisor/src/__tests__/runtime-objects.integration.test.ts:489).

The range body contains only the requested slice, but Content-Digest contains the SHA of the whole object. RFC 9530 distinguishes message content from representation data; a partial response can use Content-Digest for its transferred slice and Repr-Digest for the whole representation. [RFC 9530 §B.3](https://www.rfc-editor.org/rfc/rfc9530.html#appendix-B.3).

**Acceptance:** hash the actual 206 body and compare it to Content-Digest; expose whole-object digest through the correct separate metadata/representation field. Reconcile transport types, OpenAPI, proxy validation and tests. Header equality between manager and host is insufficient evidence.

### R16 · P2 · Boundary and lifecycle tests do not prove the advertised isolation/restart guarantees

**Evidence:** [filesystem inventory scanner](web/lib/execution-host/__tests__/runtime-data-boundary-inventory.test.ts:12), [file-level whitelist assertion](web/lib/execution-host/__tests__/runtime-data-boundary-inventory.test.ts:70), [lifecycle E2E](web/e2e/execution-host-contract.spec.ts).

The inventory asserts filenames/classes, not individual filesystem operations. A new host-runtime read in an already-whitelisted mixed file stays green; scanner scope omits .tsx, scripts and instrumentation. The E2E uses the test supervisor and covers one launch/HITL/checkpoint/resume flow. It does not prove web cannot access host private directories or owner continuation across actual process death. Two-host qualification is a separate future Stage C gate, not a missing A/B acceptance case.

**Acceptance:** operation/function-scoped ownership inventory plus a real supervisor integration lane with disjoint private roots and denied web access. Cover real restart/ACK-loss races at the owner boundary. Keep a small pure protocol test layer; avoid duplicate mock tests that repeat one happy path. A static guard is supplementary evidence.

### R17 · P1 · Binary runtime-object upload fails on a documented Node 24 runtime

**Evidence:** [Undici import](web/lib/supervisor-client.ts:13), [native fetch binary path](web/lib/supervisor-client.ts:1407), [explicit content-length](web/lib/supervisor-client.ts:1458), [documented Node prerequisite](docs/getting-started.md:44).

The binary helper uses native fetch while the same module imports Undici 8.4.1. The installed dependency initializes its global dispatcher and legacy Dispatcher1Wrapper. On Node 24.15.0, a valid 16-byte Uint8Array upload fails before supervisor receives it: `fetch failed` → `InvalidArgumentError: invalid content-length header`, `UND_ERR_INVALID_ARG`, in Undici `lib/core/request.js:503`. The existing V7b integration test reproduces the failure both in the focused group and in isolation. A temporary cause-capture probe confirmed the body type/length; this is not a demonstrated cross-realm Uint8Array problem.

The unchanged isolated test passes on Node 24.19.0. Documentation advertises Node 24.x without a patch-level compatibility restriction; the default Docker image uses the floating `24-bookworm-slim` tag. This finding concerns the confirmed failing runtime combination, not a claim that every Node 24 installation fails.

**Acceptance:** choose one compatible binary HTTP stack and/or an explicit supported runtime/dependency range; enforce and document that range across development, CI and image configuration. Real host reserve/upload/read must pass on the minimum supported runtime and the default image. Preserve streaming, timeout, digest and error semantics. Do not retry an invalid local header construction as if a remote side effect had an unknown network outcome.

## Specification, schema and analytics consistency

The defect descriptions above compare executable code with accepted requirements; weakening safety promises to match broken behavior is not a substitute for fixing them.

| Surface inspected | Review result |
| --- | --- |
| ADR-023/166/167 and Stage A/B scopes | Scope sequence is coherent: ownership cut is C, remote trust D. ADR-167's owner/reconciliation/retention guarantees are stronger than implementation (R03/R05/R06/R10) |
| execution-event-plane.md | EVT-07/09/10 incomplete: catch-up, pressure and initial poison persistence |
| execution-prompt-lifecycle.md | “Implemented” overstates typed owner, request identity, canonical authority and retention: PRM-02/03/04/06/11/12 |
| execution-runtime-objects.md | OBJ-04/06/07/12 incomplete or inconsistent: pending transition, active content, corruption, digest and retention |
| execution-data-cutover.md | “Implemented” and T4.1 completion lack a positive full historical-byte migration (R11). Traceability test IDs do not prove scenarios exist |
| execution-hosts.md | Current single-host seam matches code; lease/capacity/drain must remain labelled C |
| runs.md, sessions.md, scratch-runs.md, hitl.md, reconciliation-gc.md | Reviewed against continuation/checkpoint/recovery call paths; missing owner-apply recovery and late ACK fencing must be reconciled in these lifecycle diagrams and expectations |
| artifacts.md and capabilities.md | Distinguish manager-authored content/catalog/trust from host runtime bytes and Stage C materialization; reflect R09/R11/R13/R15 |
| OpenAPI supervisor/web and AsyncAPI host/browser streams | Wire schemas exist; semantics of terminal authority, download safety, 206 integrity, poison and unknown outcome need correction. Parser success alone cannot verify those semantics |
| Drizzle schema, migrations 0131–0136, journal/snapshots, execution-host DB domain/ERD | Structures exist and targeted real-Postgres tests apply migrations. Nullable owner fields leave PRM-04 unenforced; destructive guards cannot compensate for absent importer. No claim of exhaustive SQL performance review |
| Deployment/configuration and compose/Docker boundary | Supported single-host topology is intentional. Correct pressure settings must be mirrored across validation/runtime/image/base compose/production compose/env/docs. Separate-root runtime tests remain missing |
| Stage B plan | Checked T3.2/T3.3/T4.1 overstate completion. The rollback section still labels object/cleanup migrations “provisional 0132/0133”; actual cutover uses 0135/0136. Preserve historical planning context but add an unambiguous as-built mapping before operators use it |
| AI context/rules and roadmap | Architecture scope agrees. Backend rules still describe file/ring-buffer mechanisms and need Stage B alignment. No explicit Stage A/B milestone linkage found in ROADMAP; non-blocking linkage warning |

Peripheral changed analytics (assistant activity, studio assistant, graph, guardrail hooks, model catalog and outbound webhooks) were inspected through their Stage B references/call sites, not certified as complete independent domain reviews. No pixel-level UI/UX audit or external-provider qualification was performed. Existing user-visible failure effects include stuck Scratch Running, lost gate replies and unsafe artifact navigation; a host-administration UI remains outside A/B scope.

## Verification performed in this audit

- Native SQLite outbox diagnostics reproduced R01/R02, including an uncaught exception on the real registry/publisher chain.
- Temporary real-Postgres expected-correctness probes reproduced R04/R09 (0/2 passed as expected for unfixed defects). The probes were removed; disposable containers stopped.
- Node 24.15.0 supervisor focused integration: **7/7 passed** (outbox and runtime-object transport).
- Node 24.15.0 web focused integration: **21/22 passed** (canonical ingest, command recovery, runtime-object retention). V7b runtime-object upload failed with `fetch failed` and repeated when isolated. A cause-capture probe identified the Undici invalid-content-length compatibility defect in R17. The unchanged isolated test passed on Node 24.19.0; this does not erase the supported-runtime failure.
- Initial sandbox attempts could not bind loopback/use Docker; reruns used approved local access. Direct Vitest avoided pnpm's attempted dependency reinstall. No dependency changes were made.
- Full web/supervisor/E2E suites were not rerun for this read-only audit. Earlier green suite counts in this task do not discharge the new regression cases.

Evidence: [web focused JSON](/private/tmp/stage-ab-audit-integration.json), [isolated V7b JSON](/private/tmp/stage-ab-audit-recovery-v7b.json), [supervisor JSON](/private/tmp/stage-ab-audit-supervisor.json), [R04/R09 JSON](/private/tmp/stage-ab-review-runtime-object-race.json). These are local temporary outputs, not committed qualification records.

## Architectural improvements and dependency order

Retain the current ExecutionHosts boundary, one command ledger, host-private SQLite outbox, manager Postgres event ownership, opaque object/workspace identities and same-host ACP resume. There is no evidence requiring a new orchestration framework, message broker or relay to fix A/B.

1. Stabilize A/B: safe publisher/backpressure (R01/R02), autonomous bounded projector scheduling and durable error recording (R03/R04), then one command reducer plus persisted owner continuation (R05–R08/R10). Fix object event/ACK reconciliation and content safety/integrity (R09/R12–R15) in parallel where ownership permits. Complete the historical import before destructive production cutover (R11). Verify isolated roots and align specifications (R16).
2. Plan **Stage C gate G1: host-owned repositories/workspaces on the supported single host**. Manager owns authorization, orchestration, package trust, frozen admission inputs, review/promotion policy and durable read models. Host owns local Git/CLI/filesystem effects.
3. Plan **Stage C gate G2: two isolated local execution hosts** after G1 acceptance. Activate host-addressed transport, registry/liveness/drain/capabilities, atomic placement and per-host capacity with fenced lease semantics. Keep each live workspace and shared-worktree tree on one host. These are macro acceptance gates; the planning prompt uses C0–C7 for implementation increments.
4. Keep **Stage D** for trusted remote enrollment/authentication, remote credential delivery and relay. Two loopback/local hosts do not establish an Internet-safe deployment.

Stage C must handle these structural constraints:

- Workspace creation currently precedes the run DB transaction. Moving `addWorktree` behind HTTP requires an explicit reservation/operation identity before the side effect, plus adoption and orphan reconciliation.
- Promotion/GC occur after execution assignment release. Reuse [workspace lifecycle claims](web/lib/workbench-lifecycle/service.ts:2352) and [GC operation claims](web/lib/gc/workspace-gc.ts:450), with immutable workspace host ownership and operation fencing. Do not invent live run assignments for post-run Git maintenance.
- Shared-worktree parent/children require placement affinity ([scheduler](web/lib/scheduler.ts:173)); spare capacity on another host does not permit splitting that workspace.
- Freeze source SHA, package/capability/context revisions and hashes, agent instructions and credential requirements at admission. A PostgreSQL lock over different host-local `memory.md` files does not provide coherent bytes; choose explicit durable memory ownership before multi-host execution.
- Define repository target authority for promotion: expected base SHA/ref, remote identity, lock/fence and unknown push outcome. Web approval does not authorize arbitrary host paths/commands.
- Preserve explicit local/manual takeover and dirty-workspace behavior. Scope recovery across workspace modes, workspace-less agents, detached read-only context worktrees, shared roots and scratch.
- Cross-host recovery begins a new fenced attempt from an explicit durable boundary. It does not resume a live ACP turn on another host.

## Suggested handoff

Use the separate [A/B stabilization planning prompt](.ai-factory/reviews/stage-ab-stabilization-aif-plan-prompt.md) first. Then use [Stage C planning prompt](.ai-factory/reviews/stage-c-workspace-multihost-aif-plan-prompt.md). Both request plans only, SDD-driven contracts and a TDD RED → GREEN → REFACTOR implementation phase. Their acceptance gates should reference R01–R17 and concrete tests rather than marking completion from file existence.
