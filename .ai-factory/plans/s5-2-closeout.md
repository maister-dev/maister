# Implementation Plan: Close S5.2 — process death, partitions and denied roots

Created: 2026-09-22. Status: **Implementing; T01–T02 and T04–T07 complete; T03 local baseline verified, remote preflight pending; T08 in progress. Qualification pending.**
Branch: none (existing detached worktree preserved).
Planning HEAD: `c4216cd532c9fe7df2ca38c6045bea23ed54e8fa`.
User-supplied qualification baseline: local `master @ 1056c5c1`.
Parent plan: [Stage A/B stabilization](stage-ab-stabilization.md), task S5.2.
Refinement: SDD/TDD review on 2026-09-22; completion evidence is recorded per phase.

## Goal and boundary

Tick S5.2 only when production-boot partition controls, the complete per-lane
process-death matrix, invocation-owned cleanup and a real CI isolation run have
the evidence required below. Preserve the effort order
P0-1 → P0-2 → P1-5 → **S5.2** → S5.3 → S5.4.

Execution authorized on 2026-09-22 for this complete plan, with local commits
by phase. No merge or push is authorized. Checkboxes are verification gates;
unexecuted or failed acceptance remains open.

Out of scope: browser lifecycle/AT-17; P0-3 permission deadlines; P0-4 HITL UI;
P0-7, backlog B4, backlog D6; separate-user Linux deployment; Linux isolation driver under the
selected option B; S5.4's full documentation/lineage audit. No merge, push,
deployment, broad process cleanup or memory update is included in this plan.

## Settings

- Testing: **yes**, SDD → RED → GREEN → REFACTOR; real supervisor, production
  web and disposable PostgreSQL for new partition/death controls. Use existing
  deterministic ACP fixture binaries; never replace the supervisor with a fake.
- Logging: **verbose, structured, bounded**; common fields below apply to every
  implementation task. Evidence lives outside the worktree.
- Docs: **yes**; use `$aif-docs` for the canonical documentation checkpoints.
  Freeze the normative design before coding; label unimplemented portions
  Designed until their tests execute. As-built wording belongs to the final gate.
- No new production flags, production entrypoint edits, schema migrations,
  runtime dependencies or ADR numbers are planned. Root-cause fixes exposed by
  these controls must be limited to S5.2 invariants and preceded by their RED.
- No AT-01–17 quarantine, skips, todos or loosened assertions. Baseline failures
  are exact test names/error signatures/environment, never pass-count deltas.
- Implementation: strict typed, single-purpose functions; explicit dependency
  boundaries between fault selection, observation, process ownership and cleanup.
  Apply SOLID through those responsibilities, KISS/DRY through existing helpers;
  no generic plugin framework, speculative abstraction or production flag.

## Specification freeze and requirements traceability

T02 is a hard entry gate for implementation: write complete normative analytics,
reconcile relevant API/error contracts and record the schema disposition first.
Every requirement below names an enforcing test and observable result. A field
or outcome discovered to differ from this design returns to T02 for a small
specification amendment **before** implementing or changing its assertion.
Passing a weaker assertion is not resolution of a contract mismatch.

| Requirement | Spec owner / implementation owner | Acceptance evidence |
| --- | --- | --- |
| S52-R1: fault occurs at a proved window | Test-infrastructure B1–B4 / T08 | Reached witness precedes action; action-disabled control fails that witness; all barriers receive explicit disposition. |
| S52-R2: unknown prompt remains recoverable | Prompt lifecycle + receipt contracts / T09 | P1/P2: unchanged request identity, no fabricated failure, one ACP effect, one owner application after actual production recovery. |
| S52-R3: reconnect preserves ordered history | Event-plane + AsyncAPI / T10 | P3 replay/live: exclusive committed cursor, no gap/effect duplication, advanced liveness; positive and duplicate observations distinguished. |
| S52-R4: stale evidence cannot overwrite successor | Epoch/command/owner contracts / T10 | P4: late evidence actually reaches its handler; N+1 authority/domain write audit unchanged during stale settlement. |
| S52-R5: every death/lifecycle row has sufficient evidence | Two per-lane matrices / T11 | Existing accepted families retained; D1–D4 cover the precise missing windows; L1 proves active cancellation. |
| S52-R6: invocation owns every kill and removal | Test resource lifecycle / T04–T07 | O1/O2: real survivors reaped, leak makes exit non-zero, sibling stays alive, roots removed only at terminal invocation cleanup. |
| S52-R7: driver qualification is reproducible in CI | Driver/CI contract / T13 | Real macOS job, driver-denied read and positive host read, real PG, uploaded JSON, measured total <60 minutes. |
| S52-R8: tests cannot silently contact development supervisor | Test-infrastructure transport contract / T12 | All five suites named; shared-tree no-transport assertion and guard falsified without contacting :7777. |
| S52-R9: S5.2 status reflects complete qualified scope | Parent plan + deployment boundary / T14–T15 | Full required case set and errors/exit checked; no open S5.2 gate; S5.3/browser/Linux remain explicitly pending. |

Use `test-infrastructure.md` as the canonical fixture/process specification:
extend its Purpose, Domain entities, State machine, Process flows, Expectations,
Edge cases and Linked artifacts in the existing R5 order. Include one lifecycle
diagram for `allocated → registered → ready → stopping → reaped → roots_removed`,
with startup failure, worker death, lane signal and cleanup failure branches.
Include the proxy state machine, both requested matrices and enforcing tests in
Expectations. Keep host-runtime bytes separate from manager DB state and from
test-only evidence. Reuse existing domain analytics for product recovery;
do not create a duplicate S5.2 domain document or a parallel source of truth.

### API contract freeze — existing surfaces, exact interpretations

| Surface and existing schema | Identifiers / response meaning to freeze | Owning controls and canonical docs |
| --- | --- | --- |
| `POST /sessions/{id}/prompts`, `ImmutablePromptRequestV2`, `PromptAccepted` | URL host-session ID must equal immutable target; envelope command/run/assignment/epoch and request digest are observed, never rewritten by proxy. **202 is admission, not terminal success.** | P1/P2; `docs/api/supervisor.openapi.yaml`, `docs/supervisor.md`, `execution-prompt-lifecycle.md`. |
| `GET /commands/{commandId}`, `CommandReceiptV2` | Exact URL command ID. **200** receipt preserves nested body/error and identity; **404** means no receipt, unlike timeout/reset/unavailability. A network fault must not be forged as 404 or a terminal rejection. | P2, D2; same supervisor OpenAPI and prompt lifecycle. |
| `GET /runtime-events`, `POST /runtime-events/ack` | Exclusive decimal `Last-Event-ID`; same stable stream ID; ACK `throughSequence` never exceeds canonical contiguous prefix. Preserve real frame IDs/bytes; only explicit duplicate action may replay an identical frame. | P3; supervisor OpenAPI, `docs/api/async/execution-host-events.asyncapi.yaml`, `execution-event-plane.md`. |
| `POST /sessions`, `CreateSessionCommand` | Original `create_intent` bytes and command ID; **201** creates one logical host session. No-receipt reissue and committed-receipt fold are distinct windows, specified below. | D2/D4/P4; supervisor OpenAPI, `execution-hosts.md`, `execution-prompt-lifecycle.md`. |
| `POST /sessions/{id}/checkpoint` | Server-bound host session; **200**/idempotent checkpoint, **404** definitive absent session, **409 FENCED** stale authority, **503 EXECUTOR_UNAVAILABLE** retryable failure. A reset is a transport failure, not an observed wire 503. | D1; supervisor OpenAPI + `docs/system-analytics/{sessions,hitl,reconciliation-gc}.md`. |
| `POST /api/runs/{runId}/hitl/{hitlRequestId}/respond` | URL IDs validated against server run/HITL rows; authenticated user from Auth.js; body `optionId` must belong to stored permission choices. **503 EXECUTOR_UNAVAILABLE** preserves stored response and null `responded_at`; idle resume is **202**, same completed response is idempotent **200**. | D1; `docs/api/web.openapi.yaml`, `docs/error-taxonomy.md`, `hitl.md`, `runs.md`. Do not require private error details the route does not serialize. |
| Runtime-object upload/metadata/seal events | Object/intent/generation/host identity from actual production upload; sealed host bytes do not imply manager catalogue commit. | B4; supervisor OpenAPI, `execution-runtime-objects.md`, existing event schema. |
| `POST /sessions/{id}/cancel`, `CancelCommand` | Fenced session target; **200** with `cancelled: true` proves a live turn was interrupted; `false` for an idle session is not active-cancel evidence. Terminal prompt reason is `cancelled`, accepted only with a user-cancel flag. | L1; supervisor OpenAPI, prompt lifecycle and scratch lifecycle analytics. |

Analytics filenames without prefixes in this table live under
`docs/system-analytics/`. No fault-control API is added. Freeze request/response
examples and status/error mappings in existing specs when inaccurate, not only
after a product RED. One concrete existing drift to reconcile: the prompt route
description still says production owner activation is held until S2, whereas
the supplied baseline qualifies production owner boot. Limit that amendment to
this surface; S5.4's whole-repository audit remains deferred.

### Database contract and migration decision

**No permanent schema migration is justified by this close-out.** The required
state already exists in `web/lib/db/schema.ts`; do not add columns to record
test provenance or disable production constraints to arrange a failure.

| Existing durable state | Invariant and observer |
| --- | --- |
| `execution_commands`: `state`, `transport_state`, `attempts`, `max_attempts`, `next_attempt_at` | P2 distinguishes transport uncertainty from terminal command state; exhausted dispatch remains recoverable. Do not assert `unknown` as a command `state`. |
| `request_sha256`, `request_canonical_json`, `owner_kind`, `owner_ref`, `logical_operation_key`, `receipt_evidence`, `terminal_event_id`, `terminal_evidence_sha256` | P1/P2/P4 preserve immutable identity and require agreeing evidence before owner application; never print private request/create bytes. |
| `application_state`, `application_claim_owner`, `completion_applied_at` and owner-domain row | B2/P1/P2 assert one committed application edge and matching domain transaction, not merely one non-null timestamp read. Audit OLD claim owner before final CAS clears it. |
| `create_intent`, `run_sessions`, `run_session_incarnations`, `execution_assignments` | D2/D4 retain original intent/binding; P4 checks active assignment and current session/owner generation. |
| `execution_event_streams` | P3 observes `last_received_sequence`, `last_contiguous_sequence`, `last_ack_confirmed_sequence`, `last_seen_at`, `first_gap_sequence`; ACK ≤ contiguous ≤ received. Host stream claim differs from per-run projector claim. |
| `execution_event_consumers` keyed by `(consumer_name, run_id)` | D3 observes claim, `last_run_sequence`, retry/error state; failed projector domain write and cursor roll back atomically. |
| `execution_runtime_objects` and `hitl_requests`/`runs` | B4 uses exact object generation/state; D1 retains input intent, status, checkpoint handle and eventual delivery marker. |

Preserve migration history: `0131`, `0137_execution_projection_workers`,
`0140_immutable_command_requests`, `0146_flow_session_create_intents`,
`0154_agent_owned_create`, `0159_mandatory_prompt_owner` and later committed
migrations remain unchanged. Test audit tables/functions/triggers belong only to
the disposable database, are uniquely named per case and explicitly dropped;
they are not application migrations or production write paths.

T02 records `no migration` in the spec checklist; T14 compares schema, migration
SQL, journal and snapshots to the execution base and requires no unintended
diff. If a proved product fix truly requires persistent state, stop that code
increment, amend SDD with all writers/readers and atomicity/crash windows, follow
the parent's migration-number approval policy, and add the forward SQL, journal and snapshot triple with `docs/database-schema.md`, owning `docs/db/*` ERD and
generated `erd.dbml`. Validate fresh and populated upgrade paths plus refusal or
data-preserving backfill and rollback/forward-repair rules. Never retrofit a
test-only barrier into production schema or hand-edit historical snapshots.

## Roadmap Linkage

Milestone: Stage A/B stabilization, S5.2 in the parent plan.
Rationale: this is completion of an existing task, not a new roadmap milestone.
`.ai-factory/ROADMAP.md` is not changed. There is no `.ai-factory/RESEARCH.md`;
the user's supplied ground truth and the bounded design checks below are input.

## Evidence baseline — cite, do not repeat the audit

The following facts are accepted from the request at `1056c5c1`; line numbers
refer to that snapshot. They are not new qualification claims for planning HEAD.
`git log 1056c5c1..HEAD` identifies the subsequent Observatory/ADR-178 change
family; implementation records its actual execution revision separately.

| Accepted fact | Source at supplied baseline | Consequence |
| --- | --- | --- |
| S5.2 core qualified, remainder open | `stage-ab-stabilization.md:84,786`; status/current-task anchors | Preserve I1–I4; do not mark S5.2 done now. |
| Isolation is production boot and serial | `scripts/run-stage-ab-tests.mjs`; `web/test-support/real-web.ts:109,238,356` | Reuse one build per lane invocation, real `server.ts`/instrumentation and Auth.js sign-in. |
| Durable production workers already tested | `durable-workers-boot.integration.test.ts` A/B/C, R1–R5; `durable-workers-concurrency.integration.test.ts` D1/D2/E; ADR-176 | Keep evidence attribution, claims and application invariants. |
| ADR-175 and ADR-177 families already green in web lane | `web/lib/flows/graph/__tests__/prompt-owners.integration.test.ts`, `crash-recover-continuation.integration.test.ts`; `web/lib/execution-host/__tests__/command-recovery.integration.test.ts` | Accept the named in-process semantics as specified in the death table; never relabel them production boot. |
| AT-07 budget controls are in-process | `web/lib/execution-host/__tests__/bounded-output.integration.test.ts:1198,1401,1474` | New P1–P4 must exercise real production boot. |
| Proxy/barriers absent; four barriers prescribed | `docs/system-analytics/test-infrastructure.md:83–96`; `real-supervisor.ts:67–73`, `real-web.ts:51–56` | Add one test-only TCP/HTTP proxy module and scoped DB barriers. |
| Real driver is macOS only, no isolation CI job | `process-isolation.ts:11–69`; `.github/workflows/ci.yml:98–122`; `web/package.json:17` | Choose B; explicitly reconcile S5.2/S5.3 driver ownership. |
| Ten historical orphan supervisors reported by owner | PID list in T01; `real-supervisor.ts:64–65,166–207`, `real-web.ts:19,204`; runner lacks exit sweep | Fixture cleanup alone cannot survive worker death; enforce three cleanup levels. |
| Default supervisor URL is guarded; four suites already have fake wiring | `web/lib/supervisor-client.ts:536–541`; five suites named in T12 | Preserve the guard; close the remaining suite with proof. |
| Shipped same-user layout does not enforce I1 boundary | Parent plan `:84`; `docs/deployment.md:116–132` | S5.2 qualifies enforced process security contexts, not separate Unix UIDs in deployment. |

## Decisions to freeze before coding

### CI driver: option B, with an explicit Intel runner pin

Keep `sandbox-exec` and its documented `EPERM` denial. Add a dedicated mandatory
macOS isolation job, serial within each job, Node `24.19.0`, 60-minute job limit.
Keep the existing Ubuntu A/B matrix (`24.15.0`, `24.19.0`) unchanged.
Linux uid/mount-namespace isolation and the separate-user layout belong to S5.3.

The owner's local Mac is **ARM64**. This runner pin applies only to GitHub-hosted
CI; local qualification continues on ARM64 with the existing `sandbox-exec`
driver and local container runtime. Record local ARM64 and CI Intel evidence
separately. No Intel hardware or Rosetta requirement is imposed on the owner.

Use **`macos-15-intel`**, a deliberate correction to the suggested
`macos-latest` spelling. GitHub currently maps `macos-latest` to ARM64 and
documents its nested-virtualization limitation; Colima's own macOS integration
workflow explicitly uses `macos-15-intel`. This supports choosing the Intel
runner but does **not** qualify our Testcontainers stack or timing:
[GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Colima macOS integration workflow](https://github.com/abiosoft/colima/blob/main/.github/workflows/macos-integration.yml).

Provision a version-pinned Colima/Lima Docker runtime on that runner, with its
own job-local VM/profile; install/setup versions are recorded in CI evidence.
Set `DOCKER_HOST` to its actual socket and prove Testcontainers/Ryuk networking
and port reachability using **`pg-container.ts`**. Do not substitute a native
Postgres service, remote shared daemon or second container constructor.
If this preflight fails, the job fails loudly and S5.2 remains open; do not
silently switch to Linux, a fake driver or an unqualified runner alias.

Measure cold setup, container readiness/migrations, one production build, each
suite, cleanup and artifact upload. The 60-minute limit is a gate, not an
estimate. Budget cleanup/upload before the platform timeout; a test-step timeout
must leave time for `always()` diagnostics. Record actual total wall time and
remaining headroom. A local Mac pass is not CI evidence. Minimum-node/image and
browser expansion remain S5.3.

### Proxy contract and exact barrier ownership

New module: `web/test-support/supervisor-fault-proxy.ts`. It is an HTTP-aware
TCP proxy on loopback between the production web and the real supervisor.
Production web receives `MAISTER_SUPERVISOR_URL=proxy.url`; the proxy alone
forwards to the real supervisor. Harness-only receipt/health/metadata probes
use the real supervisor URL and are separately attributed. Observe one stable
`hostKey`, with boot ID changing only on an actual supervisor restart.
Never proxy SQLite or host filesystem operations.

Use a typed selector `{caseId, commandId, route, assignmentEpoch}` (or
`objectId`/`streamId` for those protocols), an explicit action type, and
explicit operations `arm`, `awaitReached`, `release`, `cut`, `assertDrained`,
`close`. Capture an auto-minted command ID from its durable row/envelope before
forwarding it; never reconstruct it from timing. Pass unselected traffic
unchanged. Keep bounded metadata/frame buffers and redact bodies/secrets.

Distinguish a single-shot hold/cut from a persistent partition. P1 consumes one
ACK-drop action. P2 keeps dropping **every retry ACK for the selected command**
and blocking its receipt route until explicit release; each matched attempt is
counted without consuming the partition. Duplicate single-shot consumption is
an error; repeated matches on a persistent partition are expected. No boolean
multi-mode helper: use typed actions with separate handlers.

Barrier states: `armed → reached → released | owned_process_killed`.
An explicit drop/cut is a release with that recorded fault disposition, not an
untracked socket close. Disposal of an unresolved barrier fails before cleanup.
`unreached`, `unreleased`, selector mismatch, client abort without disposition,
or invalid repeated single-shot consumption fails the test. `finally` destroys sockets,
rejects pending waits, releases DB locks and removes test triggers while retaining
the original failure. Timeout diagnoses failure; it never releases a barrier or
proves a window. Production retry deadlines and lease expiry still run normally.

| ID / required window | Mechanism and owning scope | Mandatory evidence before action |
| --- | --- | --- |
| B1 host acceptance / before HTTP ACK | Hold the exact upstream command response before any downstream ACK bytes; direct receipt lookup confirms committed acceptance; explicitly drop the downstream connection. | Same command ID/request digest on host receipt; no downstream ACK; host remains healthy. |
| B2 canonical commit / before owner apply | Test-only, row-scoped trigger in the disposable PG database at the selected owner's domain write; harness holds its advisory key. Use separate observer connection. Do not hold a broad run-row lock that also blocks ingest. | Canonical terminal row visible to observer; claim belongs to intended worker; `pg_locks` waiter identified; domain result and `completion_applied_at` absent. |
| B3 consumer claim / before failing apply | Scoped projector-domain-write trigger after committed consumer claim; identify waiting backend and terminate that exact backend or the owned web PGID. | Durable consumer claim/token + `pg_stat_activity`/`pg_locks` waiter; failure rolls back effect and cursor together. |
| B4 object seal / before catalogue ACK | Hold target upload response and target seal-event delivery, or block the exact catalogue reducer with a scoped PG trigger. Define ACK as manager catalogue commit; upload response alone is not this boundary. | Direct host metadata proves sealed generation/hash; manager catalogue still pending; neither HTTP nor SSE has bypassed the barrier. |

DB barrier helper: `web/test-support/fault-barriers.ts`, extracting only needed
patterns from `web/lib/execution-host/events/__tests__/event-claim-lock.integration.test.ts:298–325,402–484`.
Each lock key is unique to invocation/case/resource; triggers match that same
resource. `projectionTransaction` has a real 5-second cumulative deadline:
after observing the waiter, release or kill within it. Hold long partitions in
the network proxy, never inside these transactions. If the deadline expires
before the chosen action, fail the control as a missed window.

Authorship is mandatory: reuse `durable-workers-ledger.ts` and existing
ADR-176/177 witnesses; record worker/boot/claim owner and exact terminal evidence
digest. Where claims are cleared on commit, a disposable-PG audit trigger records
the successful writer transaction and the null→timestamp application edge.
Do not seed expected final outcomes or invoke recovery/apply directly from the
harness in a production control. Claim count may exceed one after recovery;
committed domain result and completion application must be singular. Assert
successor/current rows as well as the source command, not just a pass log.

### Partition matrix — normative P1–P4

All rows use `startRealWeb` + `startRealSupervisor` + `pg-container.ts` and run in
the **isolation / production boot** lane. Proposed file:
`web/test-support/__tests__/execution-ab-partitions.integration.test.ts`.
T02 copies this table, with full file path, into `test-infrastructure.md` before
implementation; final evidence replaces Planned without changing the contract.

| Test / window | Barrier | Lane / file | Mandatory distinguishing observation and RED target |
| --- | --- | --- | --- |
| **P1: ACK dropped after host commit → web SIGKILL + restart → exactly one result, no duplicate session.prompt** | B1 reached; drop ACK; SIGKILL web PGID after committed acceptance, restart same DB/roots through production boot; release target event hold to settle. | isolation; `web/test-support/__tests__/execution-ab-partitions.integration.test.ts`, P1 | Original immutable command/request, exactly one host ACP effect and one domain result/application. RED target: second `session.prompt` or lost result. Preserve AT-07's parent-plan sentence: “Unknown remains recoverable through web restart; reconnect yields one correct result and no duplicate prompt”. |
| **P2: receipts unavailable beyond the 5× budget, then evidence resumes** | Persistent ACK loss plus route-specific hold of `GET /commands/{id}` across dispatch retries; hold this command's accepted **and** terminal SSE evidence so neither can acknowledge/settle it early. Keep health, unrelated commands and unrelated SSE flowing. Await actual lookup exhaustion and persisted reconciliation state before release. | isolation; `web/test-support/__tests__/execution-ab-partitions.integration.test.ts`, P2 | `transport_state=unknown` during uncertainty; exhausted command has `state=queued`, `transport_state=reconciliation_required`, never fabricated failure; release yields agreeing receipt/canonical evidence and one application. Five receipt attempts are **per dispatch**, separate from the current three-dispatch prompt budget. Record both counters and actual deadlines; an arrival is not exhaustion. Sibling health/receipt control remains available. RED target: fabricated failure or unknown stuck after evidence returns. |
| **P3: cut SSE mid-replay and mid-live** (two named subcases) | Record high-water at stream open; cut both upstream and downstream after selected frame or selected partial frame. Replay frame ≤ frozen high-water; live frame > it. Reconnect from last fully committed exclusive cursor. Explicitly inject one previously forwarded complete frame for the duplicate subcontrol. | isolation; `web/test-support/__tests__/execution-ab-partitions.integration.test.ts`, P3 replay and P3 live | No missing canonical sequence, partial frame never ingested, duplicate recorded as duplicate without another effect, monotone committed/consumer watermarks and advanced `last_seen_at`. A clean exclusive reconnect alone is not duplicate evidence. RED target: gap, replayed effect or unadvanced watermark. Budget each subcase ≥90 s, accounting for 30 s claims and 250 ms reconnect floor; waits prove rows/frames, not log timing. |
| **P4: delayed old response arrives after successor epoch** | Hold epoch N response on a still-live downstream request; prove N+1 committed via ordinary operator/production path; capture successor authority/domain fields before release. Use B2 to distinguish canonical arrival from owner application where needed. | isolation; `web/test-support/__tests__/execution-ab-partitions.integration.test.ts`, P4 | Prove the late body reaches its intended handler before the unchanged request deadline, not merely a write to an aborted socket. N settles fenced/historically only; no stale-authored change to N+1 assignment/session/incarnation/domain owner fields; successor produces its own result once. RED target: current-owner write from N evidence (EVT-05 / ADR-167 D4). |

Each P case additionally asserts its fault actually occurred, that the barrier
reached the requested window and that teardown resolved every barrier. A
previously correct implementation may pass the semantic assertion on first run;
record that result honestly. Missing controls are not proof that HEAD contains
a product bug. Obtain RED for the harness witness by disabling its proxy action,
and use a temporary, narrowly scoped guard mutation if semantic falsification is
needed; never invent a failing baseline.

P2's event hold starts before forwarding the first prompt: `prompt-evidence.ts`
marks an accepted event as `transport_state=acknowledged`, which otherwise
bypasses retry exhaustion. Match only the target command's admission/terminal
evidence; a terminal-only hold is insufficient. P2 forwards unrelated SSE
traffic but must not claim canonical progress past
the held sequence in the same ordered stream. Later events can arrive while
its contiguous watermark stalls. The unaffected sibling control proves health
and receipt-route availability; gap-free convergence is asserted after release.
Keep the held target stream bounded with backpressure; unrelated streams remain
live. P4 pauses successor work at an independent fixture barrier where needed
and compares authority-sensitive fields plus writer-attributed audit records;
legitimate successor timestamps must not cause false stale-write failures.
Choose the response/owner path in T02 with a feasible live-request deadline;
if it cannot reach a real handler, the control is invalid, not historical proof.

### Process-death matrix — lane sufficiency is explicit

Paths in this table are repository-relative. Existing references were located in
the planning checkout; future tests are labelled **new**, not existing evidence.
T02 mirrors this table into the analytics doc; T15 appends evidence pointers to
both. Existing accepted controls must still pass the final regression gates.

| Death window / test | Barrier or evidence trigger | Lane / exact file | Sufficiency and mandatory distinguishing observation |
| --- | --- | --- | --- |
| Web SIGKILL mid-prompt — flow | Accepted, unapplied `flow_node_attempt` command; actual web PGID dies. | isolation; `web/test-support/__tests__/durable-workers-boot.integration.test.ts:320`, `applies the flow_node_attempt owner after the production web restarts` | Existing production proof accepted: restart worker applies once; no second prompt. |
| Web SIGKILL mid-prompt — agent | Same, `agent_turn`. | isolation; `web/test-support/__tests__/durable-workers-boot.integration.test.ts`, `applies the agent_turn owner after the production web restarts` | Existing production proof accepted; one correct agent domain result. |
| Web SIGKILL mid-prompt — scratch | Same, `scratch_message`. | isolation; `web/test-support/__tests__/durable-workers-boot.integration.test.ts`, `applies the scratch_message owner after the production web restarts` | Existing production proof accepted; one reply from intended owner. |
| Web SIGTERM with held claim | Durable held claim before SIGTERM. | isolation; `web/test-support/__tests__/durable-workers-concurrency.integration.test.ts:283`, `E: SIGTERM while a claim is held either releases it in the drain or fails shutdown loudly` | Existing production proof accepted: confirmed release or explicit failed drain; one application after restart. |
| Two web instances | Dead instance's unapplied command; two live production claimants. | isolation; `web/test-support/__tests__/durable-workers-concurrency.integration.test.ts:241`, `D2: two production web instances on one database apply a dead instance's command exactly once` | Existing production proof accepted; winner attributed, losing claimant does not apply. Preserve D1 too. |
| Web SIGKILL + restart under denied roots | I1 negative control then I3 restart; I4 host control. | isolation; `web/test-support/__tests__/execution-ab-isolation.integration.test.ts:335`, I3 | Existing production proof accepted with I1–I4: same history/object bytes, further turn, supervisor untouched, driver-specific errno. |
| Supervisor SIGKILL mid-turn | Accepted real prompt, `sup.restart()`, receipt/canonical ordering variants. | web; `web/lib/execution-host/__tests__/command-recovery.integration.test.ts:766`, `RED 1/3 — SIGKILL mid-prompt + restart, ... → Crashed turn-lost, attempt closed, command discharged, recoverable` | **In-process proof accepted** for ADR-177 classification/evidence-order semantics: real host dies, turn_lost → Crashed, Recover → Done, one new prompt. Production worker activation is separately proven by boot suites; do not duplicate the 14-case family. |
| Adapter SIGKILL mid-turn | Exact adapter PID belonging to run/host; persisted crash evidence. | web; `web/lib/flows/graph/__tests__/prompt-owners.integration.test.ts:3319`, `owner-flow-crash-recover: a crashed agent node recovers to a terminal state with one new prompt under the new epoch`; supporting controls and `crash-recover-continuation.integration.test.ts` | **In-process proof accepted** for ADR-175 domain/epoch semantics: real adapter killed; Recover → Done; one new prompt, zero when agreeing terminal source already exists. Keep all named subvariants. |
| Supervisor restart during NeedsInput — checkpoint/idle | Durable permission + NeedsInput; kill owned host before checkpoint succeeds; hold checkpoint traffic at a reached route barrier while exercising the unavailable-host response, then restart same host root and release. | isolation; **new** `web/test-support/__tests__/execution-ab-process-death.integration.test.ts`, D1 | Production proof required: respond while unavailable returns 503 EXECUTOR_UNAVAILABLE, stored option survives and `responded_at` stays null; checkpoint transport unavailability retains NeedsInput. After restart, definitive missing-session checkpoint permits NeedsInputIdle/released assignment; idle retry resumes through 202 and eventually records delivery/continuation. Observe checkpoint handle and epoch. No arbitrary typed-error pass, new deadline or UI behavior. |
| Supervisor restart during session create — W2, before host effect | Hold original create **before forwarding**; prove durable create intent and absent host receipt; kill/restart host, terminate the blocked attempt and release for production retry. | isolation; **new** `web/test-support/__tests__/execution-ab-process-death.integration.test.ts`, D2a | Production proof required: owning driver reissues original intent/ID once, host creates one logical session, binding committed once. Generic reconciliation must not manufacture private create payload. Existing web `command-recovery.integration.test.ts:202` ACK-write error lacks restart. |
| Supervisor restart during session create — W2, after host commit | B1 holds committed create ACK; direct matching receipt/intent witness, restart host with same root, drop old ACK. | isolation; **new** `web/test-support/__tests__/execution-ab-process-death.integration.test.ts`, D2b | Existing receipt is folded into the original binding; **no extra create is required** to obtain a new ACK. One logical session/intent, one binding application; do not demand that a dead pre-restart adapter remains live. Recovery path must match stored receipt rather than blindly reissue. |
| Postgres connection loss during projection | B3: committed consumer claim, identified backend blocked at its domain write; terminate that backend. | isolation; **new** `web/test-support/__tests__/execution-ab-process-death.integration.test.ts`, D3; retain web `web/lib/execution-host/events/__tests__/projection-worker.integration.test.ts:163,201` | Existing tests prove failed **shutdown cleanup**, not loss during apply. Add exact production control: effect/cursor rollback together, original failure visible, successor claim retries and projects once without new event. Preserve cleanup tests' EXECUTOR_UNAVAILABLE/retained-claim assertions. |
| Web death between create ACK and first prompt | Create ACK and binding committed; proxy holds first prompt before upstream forwarding. Kill web group, then restart. | isolation; **new** `web/test-support/__tests__/execution-ab-process-death.integration.test.ts`, D4 | Production proof required. Same create intent/session recovered, zero host prompts at death, one prompt/application after restart. Existing `web/lib/flows/graph/__tests__/prompt-owners.integration.test.ts:1015` before_admission/before_effect/**before_ack** windows do not prove this post-ACK window. |

Non-browser lifecycle acceptance also retains
`web/lib/execution-host/__tests__/lifecycle-regression.integration.test.ts:329`
E1 (permission → checkpoint → idle → response, epoch fencing and cleanup) and
`:540` E2 (retryable resume spawn failure rolls back/reclaims its generation).
Their in-process proof is sufficient for these service semantics; new D1/D2
cover missing production restart boundaries. I1–I4 cover production launch,
history and object readback. Add **L1 active cancellation**, isolation/production
boot, in `execution-ab-process-death.integration.test.ts`: hold an accepted live
ACP turn, use the ordinary authenticated scratch interrupt route, observe fenced
cancel ACK `cancelled: true`, canonical terminal `stopReason=cancelled` and one
owner application; release the adapter barrier and prove no late successful
overwrite, then send one subsequent turn through the same live session. Existing
`deliverer.integration.test.ts:281` cancels after its prompt completed and checks
only a boolean; `scratch-runs/__tests__/scratch-placement.integration.test.ts:292`
Q2 uses a fake host. Those retain their narrower coverage and do not substitute
for active cancellation. This is the requested non-browser lifecycle row, not
AT-17. Browser half stays open under S5.3.

### Invocation ownership, reaping and parent death

The runner mints a fresh `MAISTER_TEST_WORKTREE_INVOCATION_ID` **before** spawning
Vitest and propagates it unchanged to every descendant. Do not adopt a caller's
possibly shared ID as cleanup authority. Nested O-controls get their own runner
ID. Preserve `vitest.workspace.ts` standalone behavior, but its fallback minting
must not replace the runner's ID. Per-worker root suffixes do not change the
environment tag used by the sweep.

**Build ownership is separate from process ownership.** `real-web.ts` currently
keys its `.next` build stamp by invocation ID. A nested O-control must not
rebuild or mutate `.next` while an outer production web serves it. T04/T05 add
the smallest test-support build handle (revision, verified build ID, artifact
path) passed to an explicit start-from-built-artifact helper; validate the handle
before use. All nested cleanup invocations reuse the outer lane's one build,
but retain separate cleanup IDs and ports. No unverified skip-build flag and no
production server change. Register build subprocesses too. Build-lock ownership
uses PID/start identity: reclaim a proved dead owner rather than waiting for the
current age-only stale threshold. Never delete the worktree's `.next` as a temp
root. A startup-failure/worker-death control must prove no build descendant or
dead-owner lock obstructs the next run.

Add an invocation resource ledger outside disposable roots: atomic per-resource
records avoid shared-file lost updates. Record process PID/PGID, UID, start time,
role, expected parent identity, root ownership and boot/case identity before
reporting readiness. Root ownership records precede content. Enumerate live
processes by OS environment data, match the **exact environment entry** and
validate start identity before signaling; a command-line substring is not
environment ownership. Linux can read `/proc/<pid>/environ`; macOS needs an
environment-aware reader (e.g. `sysctl KERN_PROCARGS2`, with the argv/env split
parsed explicitly), bundled in test support and qualified on the CI image.
Failure to inspect an owned candidate is an error, not an empty process list.
Do not print collected environments. No `pgrep -f` or binary-name kill.

Sweep authority is exactly one minted invocation ID. Exclude the runner and its
short-lived inspection helpers explicitly. Validate registered groups and their
members before group signals; escaped tagged descendants are also caught by the
environment scan. Any mixed/unverifiable group fails closed for group signaling;
terminate only individually verified owned PIDs and report the anomaly. PID/PGID
reuse, permission errors and unexpected owners never authorize wider cleanup.

Three enforcement levels:

1. **Runner:** await cleanup in `finally` and SIGINT/SIGTERM/error paths; async
   cleanup cannot live in Node's synchronous `exit` callback. Forward signals to
   the owned Vitest group, wait bounded grace, discover tagged survivors, report
   each, TERM/KILL as needed, and recheck. Any survivor discovered by the final
   sweep makes the lane non-zero even if killed successfully. Preserve an
   original failed exit/signal and combine cleanup diagnostics, not mask it.
   Spawn errors, reporter parse errors, missing reports and discovery failures
   still sweep. Signals are handled idempotently, with bounded escalation.
2. **Fixture parent death:** preload a watchdog only through test-support spawn
   arguments (`--import` test-support module), preserving the direct production
   Node child and its detached process group. Do not interpose a pnpm/tsx shim.
   Capture expected parent and runner identities before boot, check immediately
   and then on a bounded poll; macOS reparenting to PID 1 or loss of either owner
   terminates the owned group. Runner death must also be detected while a Vitest
   worker remains alive. Linux uses the same poll for this increment. Parent-loss
   handling uses immediate group SIGKILL after identity validation: a preload
   cannot TERM itself and reliably remain alive to escalate against resistant
   adapters. Ordinary fixture SIGTERM/drain tests retain their existing behavior.
   Termination reaches adapter descendants, not only the supervisor leader. Production
   `supervisor/src/main.ts` and `web/server.ts` stay untouched. Polling here is
   test-process liveness only, not a product state-transition mechanism.
   Pass expected identities via test-only spawn metadata, not production config.
   Also preload the owned Vitest Node entrypoint from the test runner so runner
   SIGKILL does not leave its worker group alive. The outer O-control observes
   self-termination of worker and fixture groups; emergency cleanup is only
   containment after a failed assertion, never the evidence of success.
3. **Roots:** remove only invocation-owned runtime/worktree roots after groups
   are confirmed dead **and the fixture/invocation is terminal**. A kill for
   `restart()` preserves the same roots and host identity. Track multiple live
   consumers before disposal; never remove a root still used by another owned
   web instance. Caller-supplied/shared roots are never recursively deleted
   without explicit ownership registration by their creating test.
   Store logs/report/ledger outside removable roots; copy default fixture logs
   before deletion. Parent-death cleanup and runner cleanup are idempotent.
   Never delete by `eh-web-rt-*` glob. Preserve ownership markers on failure so
   an explicit same-invocation recovery can retry; root deletion failure is red.

Runner SIGKILL cannot execute a finalizer. The watchdog must handle its orphaned
fixture processes; normal/failure/catchable-signal runner paths own root cleanup.
For CI cancellation, `always()` cleanup consumes the same recorded invocation
ledger; do not promise cleanup after host power loss. O-controls must prove
their claimed boundaries separately rather than one mechanism masking another.
On runner SIGKILL, the outer control/CI finalizer removes that recorded
invocation's roots only after watchdog exits are proved. An uncontrolled manual
SIGKILL without a surviving owner can leave inert roots/ledger; document this
limit rather than pretending an uncatchable signal ran a finalizer. It must
leave no live owned process. Test-run success always requires zero owned roots.

Common log record: `{invocationId, caseName, event, role, pid, pgid, parentPid,
runtime, rootRole, rootId, bootId, outcome}` plus command/epoch/claim/barrier IDs
where relevant. INFO: start/stop/kill/release and sweep result; WARN: retries,
forced shutdown and detected survivors; ERROR: failed invariant/cleanup. Raw
temporary root paths may appear only in private evidence/ownership ledger;
publish role/opaque IDs and safe traces. Every failure carries bounded
supervisor/web `logTail`, proxy transcript and relevant ledger/PG observations.

## Tasks

### Phase 0 — safe start and frozen specification

- [x] **T01 — Resolve only the ten reported historical strays.** First action
  after implementation is authorized. Snapshot `ps` for PIDs
  `4805,4922,15435,23556,94200,198,866,12964,90424,90461`, including PPID, PGID,
  UID, start time and command; privately inspect their invocation/root identity.
  Validate the first group still belongs to deleted
  `linzumi-analysis-opensource-1535f6`, the second to finished
  `prompt-owner-workers-boot-2328ba` invocations. PIDs may have exited or been
  reused since the owner's observation: absent is recorded; changed/live
  ownership is listed for the owner, never killed. Terminate verified listed
  PIDs with bounded TERM then KILL, recheck by PID/start identity and save
  before/after `ps`. No pattern kill and no extension to additional processes.
  Do not delete their roots without verified exclusive ownership. Files: no
  production edits; private evidence directory only. Logging: per-PID identity,
  action/outcome and refusal reason. Depends: none.
  **Verified 2026-09-22:** all ten identities matched, TERM succeeded, zero
  remaining listed PIDs. Private evidence: `/private/tmp/maister-s52-20260922/`
  `T01-before-ps.json`, `T01-owned-identities.json`, `T01-after-ps.json`.
  Historical roots retained; no broader cleanup performed.

- [x] **T02 — Freeze SDD and acceptance before code.** Via `$aif-docs`, update
  `docs/system-analytics/test-infrastructure.md` with the two full matrices,
  B1–B4 protocol, failure/cancellation cleanup and driver decision. Resolve
  D1's 503/checkpoint/idle path, D2a versus D2b, L1 active cancellation and
  P4's still-live response handler before writing assertions. Freeze the API
  table and DB invariants above; reconcile existing contract drift, record
  explicit no-migration disposition, and assign each requirement to its test.
  In the parent plan, reconcile
  S5.2/S5.3 driver ownership, keep S5.2 unchecked, and add the exact acceptance:
  **“the runner exits non-zero if any invocation-tagged process survives”.**
  Explain that discovery of a leak is red even after successful reaping. Keep
  existing core marked Implemented, planned additions Designed; remove obsolete
  Designed scanner text only where already implemented. Logging: evidence
  index names design revision, matrix IDs and decisions. Depends: T01.
  **Verified:** canonical fault/death matrices and invocation protocol frozen;
  S5.2/S5.3 driver decision aligned; prompt OpenAPI activation drift corrected;
  no schema migration. `validate:docs` and `validate:contracts` passed under
  Node 24.15.0; logs in `/private/tmp/maister-s52-20260922/`.

- [ ] **T03 — Freeze runnable baseline and deployment/CI wiring inventory.**
  Files: this plan, parent-plan evidence references and analytics; no runtime
  configuration change. Record actual master/implementation SHAs, clean state,
  Node/Undici, driver, Docker, load and power/sleep conditions. Run owning
  discovery against existing `laneSuites`; name exact baseline failures and
  environmental errors. Run isolation alone on owner Mac at load average <8,
  lid open/awake; do not run web/supervisor lanes concurrently with it. Keep
  disposable fixture PIDs/root identities for explicit cleanup if baseline
  teardown fails. Record supported CI pin/runtime recipe from official sources.
  Execute the chosen runner's runtime/driver/PG feasibility preflight early
  through T13a after spec freeze; record image, arch, denial and container
  reachability before relying on option B. This is a prerequisite check, not
  I-CI qualification of unimplemented tests. If CI cannot be dispatched from
  this task, record the concrete missing execution prerequisite; do not claim
  its runtime or 60-minute budget proven locally.
  Deployment inventory: proxy ports, watchdog/preload, environment reader and
  ledger paths are test-only; CI dependencies belong to `.github/workflows/ci.yml`
  and test-support, not Dockerfile/compose/deploy units/`.env.example`. Existing
  `MAISTER_SUPERVISOR_URL` and invocation/evidence keys are reused. No new product
  config, endpoint or DB migration is needed. Logging: per-command exit code,
  Errors line, report path, exact failed-test set. Depends: T02.
  **Local baseline verified:** `c4216cd5`, Node 24.15.0/Undici 7.24.4, ARM64
  sandbox-exec, Docker 29.4.2: 15/15, errors=0, exit=0, 372.13 s, no tagged
  survivors. Evidence `/private/tmp/maister-s52-20260922/baseline.json` and
  `baseline-isolation/vitest.json`. Master observed at `053ee078`.
  **Open external prerequisite:** T13a requires the new workflow to be
  published; no push is authorized. Keep this checkbox open and proceed with
  local implementation on the verified baseline; remote qualification is not
  replaced with this local result.

Phase exit: internally consistent normative tables, no claimed unexecuted
qualification, exact baseline and no broadened process authority. Commit C1.

### Phase 1 — reliable process ownership before destructive tests

- [x] **T04 — Add invocation resource identity and safe enumeration.** Files:
  `scripts/run-stage-ab-tests.mjs`, new
  `web/test-support/process-invocation.ts` plus its minimal macOS reader/helper,
  `scripts/run-stage-ab-tests.test.mjs`, `web/vitest.workspace.ts`,
  `web/test-support/worktree-test-root.ts`,
  `web/test-support/vitest-worktree-root.setup.ts`, `real-web.ts` build handle
  and lock ownership. Keep JS runner dependencies
  executable under supported Node versions; avoid a TypeScript import shape
  Node cannot load. Mint before spawn; atomic resource ledger; preserve exact
  tag across children. Integration controls enumerate tagged, untagged and
  sibling-invocation processes and reject reused identity/unreadable ownership;
  no broad unit mock of `ps`. All new helper children are owned too. Logging:
  registration/inspection outcome with no environment dump. Depends: T03.

- [x] **T05 — Enforce runner exit sweep and O1.** Files: runner,
  `process-invocation.ts`, new
  `web/test-support/__tests__/execution-ab-process-cleanup.integration.test.ts`
  and a narrowly scoped child fixture under `web/test-support/fixtures/`.
  Extract only the runner entry needed to run that explicit child suite; nested
  selection excludes the cleanup suite itself. Register the outer suite in the
  serial isolation lane in this increment. Verify its build handle, not a new
  invocation-keyed rebuild. Do not make the private child an ordinary discovered
  integration suite or expose a public fault-mode CLI.
  **RED O1:** start a nested real lane, await supervisor/web readiness, kill its
  Vitest worker mid-suite; baseline leaves tagged groups. **GREEN:** sweep
  reports/kills them, lane exits non-zero, same-name sibling invocation lives.
  Cover success, assertion failure, missing/invalid reporter output and
  SIGINT/SIGTERM cleanup without multiplying expensive production builds.
  Falsification: disable only sweep, assert the exact survivor/exit assertion
  goes red; outer control owns emergency cleanup. Run O1 with watchdog omitted
  in its test fixture to prove the sweep independently, then run the combined
  default path: worker death still fails even if watchdog reaps first. No fault
  mode is added to production entrypoints or the public lane CLI. Logging:
  every sweep kill, originating failure and final recheck. Depends: T04.

- [x] **T06 — Add fixture parent-death supervision and O2.** Files:
  `web/test-support/real-supervisor.ts`, `real-web.ts`, new
  `web/test-support/fixture-parent-watchdog.mjs`, runner spawn path and
  cleanup suite/child fixture.
  **RED O2:** kill the fixture parent; child survives without a runner sweep.
  **GREEN:** preload catches parent loss within its documented bounded interval
  and immediately kills the owned group including adapter/web children.
  Prove registration/startup-race handling and normal restart/stop without
  triggering sibling cleanup. Falsify by omitting preload only for the negative
  control; outer harness reaps that deliberate survivor. Include
  parent-loss proof with a TERM-resistant adapter descendant, and separately
  SIGKILL only the runner while its Vitest worker is still alive: the fixtures
  and owned worker must self-terminate from runner-identity loss, without the
  outer control's emergency reaper. Preserve direct
  production PID/PGID meaning and SIGTERM drain behavior; do not edit either
  production entrypoint. Logging: parent identity, detection, group action,
  confirmed exit. Depends: T04–T05.

- [x] **T07 — Complete root cleanup and fixture diagnostics.** Files:
  `real-supervisor.ts`, `real-web.ts`, `worktree-test-root.ts`, ledger/helper,
  cleanup suite; `pg-container.ts` only if invocation labelling/owned-container
  cleanup is needed, never a second constructor. Remove owned roots at terminal
  disposal on normal/failure/signal paths, preserving them across restart and
  while another owned instance uses them; prevent deleting unowned caller roots,
  evidence or sibling resources. Preserve Testcontainers/Ryuk teardown ordering;
  track container IDs/labels so worker death is observable, not a shared Docker
  prune. Attach `logTail` even for partial startup, timeout and teardown failure.
  Prove three-level cleanup with real fixture children and no remaining tagged
  processes/owned temp roots. Logging: common record on every start/stop/kill
  and root operation; cleanup errors remain failures. Depends: T05–T06.

Phase exit: O1/O2 and their falsifications recorded; I1–I4/worker boot/concurrency
still green. Check runner integration membership for the cleanup file (no
recursive selection of itself in nested controls). Commit C2.

**Phase 1 verified 2026-09-22:** serial production isolation passed 28/28,
four suites, zero errors, exit 0, 434.69 s on darwin/arm64 Node 24.15.0;
terminal sweep found zero leaks. Invocation `cf65a918-eaf8-4c62-bbef-68c8efb4f119`.
Evidence under `/private/tmp/maister-s52-20260922/phase1-isolation-final/`:
`lane.log`, `maister-ab-isolation-wBWVSd/vitest.json` and its process ledger.
Original I1–I4 and worker boot/concurrency assertions remain unchanged.
The cleanup suite owns 13 integration cases, including reporter failures,
catchable signals, runner SIGKILL, parent loss with a TERM-resistant adapter,
exact-environment ownership, OS-denied inspection, and root identity refusal.
`O1-red-no-sweep.log`, `O2-red-no-watchdog.log`, and
`ownership-denied-red-disabled.log` record restored one-at-a-time falsifications;
`cleanup-container-green.log` records 13/13 after fixing independently observed
shared-Ryuk container leaks with exact invocation labels. The final additional
ledger/ancestor protection passed `O-roots-ledger-green.log` (targeted case).
Runner tests 6/6, PG lifecycle control 1/1, web typecheck and targeted lint passed.
Linux process enumeration and hosted Intel qualification remain T14/T13 gates.

### Phase 2 — partitions and missing process-death windows

- [ ] **T08 — Implement reusable proxy and B1–B4 fixture barriers.** Files:
  `supervisor-fault-proxy.ts`, `fault-barriers.ts`, existing test-support ledger
  helpers as needed, new partition/death suites. Reuse production HTTP formats;
  HTTP-aware selectors, complete SSE-frame parsing, backpressure, bidirectional
  stream teardown, bounded response retention and explicit release/disposal.
  Register each new suite/case in isolation as it is added; discovery is an
  entry check for each RED. Add a B4 control: real upload seals while catalogue is
  held, then converges once after release; cutting only HTTP must fail the
  “catalogue still pending” witness when SSE is allowed through. Reuse this
  barrier in P1/P4 object evidence where applicable. Qualify B2/B3 using real PG
  waiters and committed observer reads. No broad code interception, sleeps or
  production test hooks. Logging: selector, reached evidence, disposition,
  upstream/downstream closure and bounded safe traces. Depends: T07.

- [ ] **T09 — P1/P2 RED → GREEN at production boot.** Files: partition suite;
  only if a genuine RED requires it, owning
  `web/lib/execution-host/{deliverer,recovery,prompt-owner-application}.ts`
  or their actual called seam (confirm filename before editing). Follow P1/P2
  table, including receipt-route specificity and unaffected sibling control.
  No harness manual recovery or application. Record baseline semantic result
  and proxy-disabled failure separately. Prove unblock wakes recovery without
  a new user prompt. Root-cause fixes preserve same immutable ID/request,
  production retry budgets and typed uncertainty. Logging: retry exhaustion,
  receipt/terminal digest, boot/claim writer and one application. Depends: T08.

- [ ] **T10 — P3/P4 RED → GREEN at production boot.** Files: partition suite;
  conditional root-cause edits only in owning event consumer/projector and
  command-settlement/fencing seams. Exercise both replay and live cuts, partial
  frame discard and explicit duplicate subcontrol. N+1 must be established by
  the production path before old response release. Falsify each proxy action
  separately: no cut/delay must fail its fault/window assertion; any necessary
  product-guard mutation must fail gap/duplicate/current-owner assertions.
  Restore mutations before regression. Logging: cursor/high-water/frame IDs,
  last-seen before/after, epoch snapshot and actual writer. Depends: T09.

- [ ] **T11 — Close missing death windows D1–D4.** Files: new process-death
  suite, reusable T08 barriers and existing seed/ledger helpers. Implement the
  D1–D4 windows, including D2a/D2b, exactly; keep ADR-175/177 families intact.
  D1 uses actual production sweep/response paths; a past keepalive scheduling
  input is allowed, seeding NeedsInputIdle or invoking its reducer is not.
  D2a proves an owning-driver reissue with no receipt; D2b proves existing receipt
  fold, not an unconditional resend or just an ACK-write exception. D3 kills
  the specific blocked PG backend; D4 proves ACK durable and zero upstream
  prompt before web death. Add the narrow L1 active cancellation control. For each,
  disable its barrier/action to falsify the window witness; guard mutations
  additionally falsify singular settlement/fencing where needed. Logging:
  window evidence, exact killed PID/PGID/backend, restart identity and durable
  outcome with safe tails on all failures. Depends: T10.

Phase exit: P1–P4, B4, D1–D4 and L1 green and falsifiable, no unconsumed barriers,
no cleanup leaks. All files already belong to serial `laneSuites.isolation`;
discovery must show them and each named case. Re-run affected owning
web/supervisor suites on product changes; unchanged ADR families retain their
strong expectations. Review fault placement and writer attribution after every
fix cycle. Commit C3.

### Phase 3 — suite closure, CI and qualified status

- [ ] **T12 — Close S4.1's five-suite finding with exact transport proof.**
  Files: `web/lib/runs/__tests__/shared-tree-auto-launch.integration.test.ts`
  plus parent-plan S5.2 text; other four suites only if regression requires it.
  Bounded planning inspection found task-less roots, early
  `!parent.taskId` skip in `web/lib/runs/auto-launch.ts:311`, mocked
  `tryStartRun`, mocked merge/stat and git-range artifacts. These paths avoid
  the transport. Add minimal `fakeExecutionHosts` wiring and an explicit
  no-real-transport spy covering all cases; leave the real default-URL guard
  intact and unset/restore `MAISTER_SUPERVISOR_URL` for the assertion. Do not
  rely solely on thrown CONFIG: a promotion warning catch can hide it. A
  deliberately introduced real-transport call must fail even if caught.
  Record exact paths and executed cases for `orchestrator-resume-flow-child`,
  `shared-tree-auto-launch`, `flows/runner`, `hitl-hook-trip`, and
  `evidence-readiness-all-blocking-kinds`. Logging: suite, fake-host identity,
  transport-call count and exact outcome. Depends: T11.

- [ ] **T13 — Wire and qualify the CI isolation job.** Files:
  `web/package.json`, `.github/workflows/ci.yml`, runner/report metadata and
  CI-only runtime setup helper if needed. Add
  `test:integration:isolation = node ../scripts/run-stage-ab-tests.mjs isolation`.
  **T13a prerequisite:** minimal runtime/driver/PG preflight is scheduled during
  T03 after T02; no dependency on unimplemented fault tests. **T13b final job:**
  mandatory macOS Intel job as decided above; explicit Colima/Lima/Docker
  provisioning and preflight, frozen pnpm install, Node runtime check, driver
  denial/positive control, serial lane and one build. Export a job-local
  `MAISTER_TEST_EVIDENCE_DIR` under `RUNNER_TEMP`; runner reports its actual
  `vitest.json` location and CI copies/uploads it from that recorded location
  (macOS `tmpdir()` is not `/tmp`). `always()` uploads JSON plus safe logs,
  process/barrier ledgers and timing; missing JSON is failure, never synthetic
  Vitest success. Keep partial diagnostics on worker crash. Runtime cleanup
  runs after resource cleanup and artifact preservation. **I-CI RED:** absent
  script/job/driver/report fails preflight or the owning assertion. **GREEN:**
  actual CI run URL, runner image/version, commit, all required cases and
  artifact IDs with measured total <60 min. A job not executed is still open.
  Logging: setup/build/suite/cleanup/upload timings and remaining budget.
  Depends: T02 for T13a; T07, T11, T12 for T13b. Complete T13 only after T13b.

- [ ] **T14 — Run the final scoped regression and falsification gates.** Files:
  existing test runner configurations only if discovery requires correction;
  evidence outside worktree. Execute the commands below separately and retain
  exit codes, Errors lines and exact failure sets. Isolation alone; web A/B and
  supervisor A/B afterward. Validate default helper compatibility on Linux's
  web/supervisor lanes even though Linux isolation is deferred. Restore all
  mutations and rerun affected tests after any fix; no repeat broad runs with
  no change/uncertainty. Budget adversarial review of proxy races, cleanup
  authority, watchdog parent race, D1 semantics and stale-writer attribution.
  Any unresolved S5.2 assertion, leak or missing CI proof keeps S5.2 unchecked.
  Logging: revision/node/driver/command/case/exact error/evidence pointer.
  Depends: T13.

- [ ] **T15 — Apply the as-built evidence and stop at S5.2.** Files:
  `.ai-factory/plans/stage-ab-stabilization.md`, this plan,
  `docs/system-analytics/test-infrastructure.md`, `docs/deployment.md`,
  `docs/getting-started.md`, `web/CLAUDE.md`; API/analytics contract amendments
  for corrections frozen in T02 or a subsequent justified amendment. Through
  `$aif-docs`, replace obsolete Designed proxy/barrier prose with implementation
  and evidence; keep Linux driver/separate-user layout explicitly S5.3. Fill
  parent matrix rows “ACK/receipt/SSE partitions beyond budgets”, “Real web
  restart and simultaneous worker claims”, “Web runtime-root access denied”
  and the **non-browser half** of “Single-host lifecycle regression”, preserving
  “Real supervisor restart” ADR-177 evidence and its web-lane label. Update
  driver-specific errno wording to EPERM for B. Close all five S4.1 suites by
  name, not the outdated claim that all still contact :7777. Each row names
  test title, file, lane, exact revision/runtime and artifact. Only then tick
  S5.2, update top status and `Current task` to S5.3 (43/45 only if the other
  parent checkboxes still match), and reconcile the historical Linux remainder
  note without erasing its provenance. Deployment text distinguishes enforced
  sandbox security contexts from distinct Unix users and from the shipped
  same-user layout; do not claim Linux qualification. Document the new script
  in the two owning script inventories. Logging: docs validation results and
  evidence references, no new summary-report deliverable. Depends: T14.

Phase exit: S5.2 evidence complete, S5.3/S5.4 still unchecked, no authorized scope
left unfinished. Commit C4. Memory note about the invocation sweep is a separate
follow-up after landing and only under an explicit memory-update request.

## TDD protocol and minimal coverage ownership

Each implementation increment carries its spec IDs and runs **RED → GREEN →
REFACTOR** before the next dependent increment. RED records the exact collected
test title, intended failed assertion, actual failure, exit code and revision.
A syntax/import/setup error is not the requested RED. Missing CI execution is
an open gate, not a passed falsification. If baseline product semantics already
pass, preserve that result and prove the fault/guard with a controlled mutation;
never weaken a test to manufacture a narrative of a fixed bug.

GREEN changes the smallest owning seam; new production behavior requires its
frozen contract and real regression. REFACTOR extracts duplicated setup,
observation and teardown without changing assertions or budgets; rerun the
owning cases and affected existing families. Revert every mutation and execute
the restored case before recording completion. Guard mutations are test-only
working-tree experiments, never checked-in flags or changes to the CI verdict.

| Distinct property / edges | Sole new owning control | Required falsification or negative observation |
| --- | --- | --- |
| Accepted prompt survives web death | P1 | No ACK drop fails the reached/fault witness; removing idempotency or terminal application guard fails duplicate prompt/result observation. |
| Long route-specific receipt outage remains recoverable | P2 | Disabling receipt partition fails the exhausted-budget witness; fabricated terminal failure or disabled recovery fails the exact command/domain assertion. Covers repeated ACK retries; no separate clone per retry count. |
| Ordered replay and live reconnect | P3 replay/live parameterization | Disabled cut fails cut witness; broken cursor/duplicate guard fails missing-sequence or duplicate-effect assertion. Partial frames and explicit duplicate delivery are subcontrols, not a full cross-product. |
| Late old evidence is harmless to current owner | P4 | Disabled delay fails successor-before-handler ordering; bypassed epoch authority fails stale-writer audit. Unconsumed/aborted response is invalid setup. |
| Sealed bytes do not bypass catalogue barrier | B4 | Allowing the alternate HTTP/SSE settlement path makes the pending-catalogue witness red. One reusable real-upload case. |
| Supervisor loss at permission/create boundaries | D1 and D2a/D2b | Disabled kill/hold fails exact window witness; broken retry/receipt-fold gives wrong HTTP/durable state or duplicate create. D2a and D2b differ by committed host effect, not redundant ingest orders. |
| Projection loss is transactionally retryable | D3 | No backend termination fails connection-loss witness; non-atomic cursor/domain advancement fails rollback/one-application assertion. |
| Web death after durable create but before first prompt | D4 | Moving death before binding or after forwarding fails the explicit window assertions. Unlike D2, the supervisor/session stays alive. |
| Active cancel settles and session remains usable | L1 | Idle/no-op cancellation fails `cancelled: true` and live-turn witness; late normal-success overwrite fails terminal/owner audit. |
| Runner reaps owned leaks on every catchable exit path | O1 | Disable sweep only; survivor/zero-leak/non-zero-defect assertion fails. Success, assertion failure, reporter failure and signals share one bounded child-fixture harness; unrelated tagged sibling stays alive. |
| Parent loss needs no runner finalizer | O2 | Disable watchdog only; worker/supervisor/web/TERM-resistant descendant remains alive past its bounded interval and fails. O1 omits watchdog to prevent one guard masking the other. |
| Roots/locks are cleaned with correct ownership | O1/O2 lifecycle edges | Startup failure, dead build owner, restart-retained root, shared owned root and sibling/caller root assertions in those controls; no separate filesystem-mock suite. |
| Suite cannot use implicit development host | T12 owning shared-tree suite | Introduce a transport call caught by its normal warning handler; spy still fails without real network access. Keep existing default-URL guard coverage. |
| Real isolation job exists and finishes | I-CI | Missing required script/case, wrong driver, absent report, leaked process or >=60-minute measured total fails gate; no simulated CI-green substitute. |

Existing I1–I4, durable-worker families and accepted ADR-175/177/lifecycle tests
retain ownership of their established properties; do not clone them into every
new P/D test. Source fixtures may arrange an initial domain state; evidence must
say when they do. In particular, an operator-Recover test that seeds Crashed is
proof of Recover behavior, not proof that a natural adapter-death projector
classified the crash. Preserve the supplied acceptance of those in-process
semantics and label that boundary explicitly in the final matrix.

Timeouts bound failed waits; production budgets still elapse naturally. No
`setTimeout` triggers a fault or substitutes for a reached witness. Logs alone
never prove ownership, duplicate disposition or completion. Every positive case
must reach its durable final assertion and then prove barrier/process/root
teardown, including on assertion and startup failures. CI's report lists every
matrix case, zero skipped/todo cases, zero unhandled errors and the real exit.

## Verification commands and evidence contract

Confirm integration discovery (`vitest list --project=integration` with the
owning file filters) before executing new suites; match every table ID to an
actual collected case. Do not run the deliberately recursive O1 child fixture
as an ordinary integration file. Lane runner must reject missing/empty suites,
skips, todos, failed assertions, unhandled errors and non-zero Vitest exit.

Run separately, in this order on a quiet qualified host:

```text
pnpm --filter maister-web typecheck
pnpm --filter @maister/supervisor typecheck
pnpm test:stage-ab-lane
pnpm --filter maister-web exec eslint <changed-web-files>
pnpm --filter @maister/supervisor exec eslint <changed-supervisor-files-if-any>
pnpm --filter maister-web test:integration:isolation
pnpm --filter maister-web test:integration:ab
pnpm --filter @maister/supervisor test:integration:ab
pnpm --filter maister-web test:unit
pnpm --filter @maister/supervisor test:unit
pnpm --filter maister-web test:integration --maxWorkers=1 --minWorkers=1
pnpm --filter @maister/supervisor test:integration
pnpm validate:docs
pnpm validate:contracts
git --no-pager diff --check
```

The integration suites are real executions, not test-file creation as evidence.
The final broad web integration command is serial on the qualified macOS host
because it also discovers the isolation files; do not run those alongside other
host-heavy suites or infer that the Ubuntu web A/B slice includes them.
Phase gates run affected suites plus owning package unit/integration gates;
reuse identical-revision completed results instead of unnecessarily repeating
them. Full-suite baseline failures outside AT scope remain exact named blockers
to a “full suite green” claim; no automatic quarantine. Fix in-scope regressions;
do not enlarge this close-out to unrelated features.

For every P/D/O/I-CI record: commit and test title, lane/runtime/driver,
invocation ID, fault selector, reached evidence, barrier disposition, writer
identity, relevant before/after rows, process/root cleanup result and raw runner
exit. P2 records actual budget expiry; P3 records both high-water and exclusive
cursor; P4 records successor authority fields and stale-writer audit. Evidence paths remain valid after
root cleanup. CI uploads the real reporter output, not just screenshots/log pass
counts. Each falsification names its specific failed assertion and restored
mutation; deliberate survivors are contained and reaped by the outer test.

## Contract and deployment traceability

| Surface | Canonical files / action |
| --- | --- |
| Test harness ownership, fault state machine, matrices and CI driver | `docs/system-analytics/test-infrastructure.md`; parent S5.2/S5.3 task text and matrix. No production endpoint for fault control. |
| New package script | `web/package.json`, `docs/getting-started.md` Scripts, `web/CLAUDE.md` Scripts; `.github/workflows/ci.yml`. |
| Isolation deployment claim | `docs/deployment.md`; same-user layout stays unqualified for kernel denial. Dockerfile, compose files, deploy units and env templates gain no test-only wiring. |
| Existing HTTP/receipt/checkpoint/create semantics under test | `docs/api/supervisor.openapi.yaml`, `docs/api/web.openapi.yaml`, `docs/supervisor.md`, `docs/system-analytics/execution-prompt-lifecycle.md`; reconcile relevant drift at T02 before tests, and amend before any later product correction. |
| Existing SSE/cursor semantics under test | `docs/api/async/execution-host-events.asyncapi.yaml`, `docs/system-analytics/execution-event-plane.md`; no new event planned. |
| Existing typed errors | `docs/error-taxonomy.md`; pin exact D1/P2 outcomes, no new catch-all status. |
| DB/migrations/ADR | None planned. Disposable triggers/audit tables are fixture-owned, never committed Drizzle migrations. ADR-167/175/176/177 remain authoritative. If a real product correction needs a new schema/contract, freeze that amendment before coding and use the existing number-allocation policy. |

Proxy selectors are test-owned IDs from observed envelopes/rows. Production
URL/auth/server-state/body identifier handling is unchanged; harness selectors
never become a product API or a path-bearing supervisor route.

## Commit plan, failure handling and rollback

- **C1, T01–T03:** `docs(testing): specify S5.2 closeout matrices and CI driver`;
  T13a's executable preflight gets a separate focused CI commit when introduced.
- **C2, T04–T07:** `test(harness): reap invocation processes and owned roots`.
- **C3, T08–T11:** `test(execution-host): qualify production partitions and death windows`.
- **C4, T12–T15:** `test(ci): qualify isolation and close S5.2 evidence`.

Commits are local implementation checkpoints after their gates, not authorization
to push/merge. A product fix gets a focused conventional fix commit with its
real RED/GREEN and docs in the same logical increment. No speculative feature
work is permitted to fill a test gap.

There is no data migration or deployment cutover in this plan. Rollback of a
fault harness must first release all barriers/DB locks and stop only its owned
processes, then remove disposable triggers and roots; preserve evidence and
restore the original explicit supervisor URL. Never roll back by disabling
the default-URL guard, relaxing epoch checks, fabricating terminal outcomes,
skipping AT cases or calling an unavailable driver successful. If CI runtime,
60-minute budget, parent-death reachability or exact fault-window evidence is
unproven, retain S5.2 as open with that precise missing gate.
