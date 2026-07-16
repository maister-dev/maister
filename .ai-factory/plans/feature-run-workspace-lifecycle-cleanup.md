# Implementation Plan: Run Workspace Lifecycle Cleanup and Reconciliation

Branch: `feature/run-workspace-lifecycle-cleanup`
Created: 2026-07-16

## Settings

- Testing: yes — strict TDD at every behavior boundary; RED → GREEN → refactor.
- Logging: verbose — structured lifecycle, reconciliation, retry, and sweep
  summaries; never log prompts, JSONL contents, file contents, diffs, secrets, or
  unredacted user-controlled paths.
- Docs: yes — Phase 0 is a blocking SDD contract checkpoint; the final phase
  performs a separate as-built consistency pass.

## Roadmap Linkage

Milestone: `none`

Rationale: Skipped by user. This is a cross-cutting lifecycle correction on top
of the already implemented M19 and M27 capabilities, not a new roadmap
milestone.

## Goal

Make workspace retention and removal predictable across Flow, scratch, and
agent runs:

1. A writable worktree belonging to `Review`, `Crashed`, or `Failed` remains on
   disk until the user explicitly archives or drops/discards it. Live and HITL
   states remain protected as well.
2. Automatic retention continues to preserve then prune only `Done` and
   `Abandoned` worktrees after the configured 14-day default.
3. Archive becomes an actual space-reclaiming action: preserve recoverable Git
   state, remove the owned worktree, retain the run row and its original status
   as history.
4. Drop/Discard uses the same preserve-first removal protocol but changes every
   non-`Done` run to `Abandoned`.
5. Every row-backed removal path is retry-safe across process death, and disk-
   only MAIster-managed worktrees are reconciled without ever deleting an
   untrusted path.
6. Reconstructible agent directories (`workspace=none` and `repo_read`) and
   isolated test workspaces do not leak into the user's default worktree root.
7. One scheduler-owned sweep performs cleanup with bounded progress, durable
   retry/quarantine state, and an operator-visible summary.

## Current Evidence Snapshot

The implementation starts from these verified facts and must not re-discover or
silently redefine them during coding:

- Flow and scratch writable worktrees use
  `<MAISTER_WORKTREES_ROOT>/<project-slug>/<run-id>`.
- Writable Flow, scratch, and agent allocations install
  `.maister-managed/provenance` containing a server-minted `runId`.
- Runtime artifacts and JSONL live separately under
  `<runtime-root>/.maister/<project-slug>/runs/<run-id>`.
- `runWorkspaceGcSweep` currently selects only `Done` and `Abandoned`, preserves
  before removal, and defaults to 14 days.
- The shared-tree blocker incorrectly uses the broader orchestration terminal
  set, so `Crashed` and `Failed` siblings can currently fail to protect a shared
  allocator tree.
- `archiveWorkbench` currently preserves but deliberately leaves the worktree
  on disk.
- `dropWorkbench` currently preserves, removes, then records the DB transition;
  a process death after removal but before the DB write is not recoverable for
  `Review`, `Crashed`, or `Failed`.
- scratch `/discard` currently writes `removed_at` before filesystem removal and
  treats removal failure as logged success; later GC cannot see that orphan.
- `workspace=none` agent directories are not removed after materialization is
  restored. `repo_read` has both immediate and sweep cleanup.
- normal Playwright isolates `MAISTER_WORKTREES_ROOT`; live Playwright and at
  least one real agent integration path do not. The E2E wrapper does not own a
  Git-aware worktree-root teardown.
- both the legacy in-process GC timer and `system_sweep.default` invoke
  overlapping cleanup services.

## Scope

### In scope

- Writable Flow, scratch, own-agent, and shared-agent worktree retention.
- Archive, Drop, Discard, Stop & archive, and Stop & drop semantics.
- Board, launchability, active-workspace, run-detail, and run-history behavior
  after explicit workspace removal.
- Row-backed crash-window recovery and lifecycle-operation serialization.
- Generic disk/DB reconciliation for MAIster-managed worktrees.
- Durable orphan observation, backoff, quarantine, and bounded sweep progress.
- Immediate plus retrying cleanup for `workspace=none` and `repo_read` agent
  directories.
- Single-owner scheduler wiring and detailed scheduler-run summaries.
- Vitest, normal Playwright, and live Playwright worktree-root isolation and
  teardown.
- EN/RU UI copy, OpenAPI, analytics, DB docs, screen docs, and configuration
  corrections.

### Out of scope

- Retention, archival, compaction, or deletion of run JSONL and other runtime
  artifacts. Existing behavior remains unchanged.
- Deleting run rows, evidence, transcripts, cost data, or historical status
  after workspace removal.
- Adding a new run status such as `Archived`.
- Deleting branches or archive refs merely because a worktree directory was
  removed.
- Automatically deleting paths without valid current MAIster provenance.
- Bulk-removing the currently observed historical test worktrees as part of
  planning or migration. They must pass through the implemented reconciler's
  trust and grace rules.
- A general filesystem browser or arbitrary-path cleanup API.

## Locked Decisions and Invariants

### D1. Run status and workspace presence are separate axes

Run status remains the historical execution result. Workspace presence records
whether the writable checkout still exists. No new run status is introduced.

| Run/workspace state | Automatic cleanup | Explicit Archive | Explicit Drop/Discard |
| --- | --- | --- | --- |
| `Pending`, `Running`, `HumanWorking` | Never | Refuse until stopped/released | Refuse until stopped/released |
| `WaitingOnChildren` | Never | Refuse; use the existing subtree abandon/cascade path | Refuse; use the existing subtree abandon/cascade path |
| `NeedsInput`, `NeedsInputIdle` | Never | Use Stop & archive | Use Stop & drop |
| `Review` | Never | Preserve, remove, keep `Review` in run history | Preserve, remove, set `Abandoned` |
| `Crashed` | Never | Preserve, remove, keep `Crashed` in run history | Preserve, remove, set `Abandoned` |
| `Failed` | Never | Preserve, remove, keep `Failed` in run history | Preserve, remove, set `Abandoned` |
| `Done` | At due retention deadline | Preserve, remove now, keep `Done` | Preserve, remove now, keep `Done` |
| `Abandoned` | At due retention deadline | Preserve, remove now, keep `Abandoned` | Preserve, remove now, keep `Abandoned` |

`scheduled_removal_at` never overrides the protected-status rule. Candidate
selection uses the dedicated disposable set `{Done, Abandoned}`, not the
broader orchestration terminal set.

After Archive removes a `Review` or `Crashed` workspace, the run remains in the
run list and at its direct detail URL, but it no longer keeps the task stranded
in `OnReview`/`Crashed`. Board and launchability classifiers consume
`workspaceRemoved`: the historical run remains visible while the task becomes
relaunchable. `Failed` remains historical and relaunchable as today.

`WaitingOnChildren` is intentionally not a workbench-stoppable state in the
current policy. Archive/Drop must not advertise an impossible "stop first"
remediation. The existing subtree abandon/cascade operation is the only
operator path until a separate design explicitly adds orchestrator Stop.

### D2. Archive and Drop are different user intents

**Archive** means:

1. Preserve tracked, untracked, staged, unstaged, and committed recoverable Git
   state.
2. Record the preservation result. `archived_at` records a successful archive
   intent even when a clean/non-diverged worktree needs no archive branch;
   `archived_branch` is therefore optional.
3. Remove only the MAIster-owned Git worktree.
4. Record `removed_at` only after removal is confirmed.
5. Keep the run's status, evidence, timeline, transcript, cost, and metadata.

Archive converts the retained run into non-actionable history without rewriting
its evidence. Under the claim and before preservation it re-checks that no
active assignment, takeover, or unanswered actionable HITL remains; an
unexpected active row is `409 PRECONDITION` with the blocking action and no Git
side effect. Successful Archive does not delete or synthesize HITL responses,
assignments, ACP/session handles, session history, or evidence. Instead,
`removed_at` plus the durable disposition makes Recover and every worktree-
backed server operation refuse with `PRECONDITION`, and read models compute
`recoverable:false`. `HumanWorking`, live, and HITL execution states remain
outside plain Archive and use their existing release/stop flow first.

**Drop/Discard** means the same preserve-first physical removal, followed by
`Abandoned` for every non-`Done` run. It is the explicit abandon path.

Run detail must render retained history after either operation. Files, diff,
change summary, commit, export, promotion, and other worktree-backed controls
must render a localized unavailable/removed state and must not attempt Git
reads. Active-workspace surfaces continue to filter `removed_at IS NULL`.
Recover, review response, gate chat, takeover, rework, and promotion must repeat
the same server-side workspace-presence guard; hiding a client action is never
the authorization or consistency boundary.

Every completed removal records a durable `removal_kind` independently from the
preservation result. The closed set is `archive`, `drop`, `discard`,
`retention_gc`, `reconciliation`, and `legacy`. Preservation is recorded as
`not_needed`, `ref_created`, `snapshot_created`, or `legacy_unknown`.
`archived_at` therefore means preservation was durably evaluated, while
`removal_kind` is the user/system disposition. This separation is the source of
truth for idempotent replay and conflicting-intent detection.

### D3. One claimed removal protocol owns every row-backed removal

Archive, Drop, both discard routes, automatic workspace GC, and combined stop
actions must converge on one claimed protocol. Do not grow
`workbench-lifecycle/service.ts` into a multi-mode service. Implement small,
strictly typed modules for policy/classification, lifecycle-claim persistence,
Git preservation, ownership verification/removal, transactional finalization,
and route/scheduler orchestration. Operation variants are a discriminated union
with exhaustive handlers, never boolean flags or a function whose mode changes
unrelated behavior.

The durable `workspaces.lifecycle_operation_*` fields are the row-backed
operation intent and ownership fence. Migration `0105` adds the missing lease,
expected-status, completed-disposition, and preservation-outcome fields. A
failed or stale claim retains its operation name, expected run status, and
attempt ID until a new fenced owner replaces it. Success atomically clears the
active state/name/attempt/lease/expected-status fields and writes the completed
disposition; replay reads the completed fields, not a retained active claim.
Extend the operation-name union for automatic GC/recovery rather than adding a
second lock.

Migration `0105` adds exactly:

- `lifecycle_operation_lease_expires_at timestamptz` and
  `lifecycle_operation_expected_run_status text` for active ownership/recovery;
- `archived_commit text` and `preservation_outcome text` with the closed values
  from D2, persisted before removal when preservation succeeds;
- `removal_kind text` with the closed values from D2, written only with
  confirmed `removed_at`.

Checks enforce active attempt/name/lease/expected-status pairing, allowed text
values, and `removed_at IS NOT NULL` paired with a completed removal kind. The
migration backfills pre-existing removed rows as `legacy` plus
`legacy_unknown`; untouched/present rows remain null. Existing archive metadata
is preserved without inventing a commit or disposition.

Claims are renewable leases, not timestamps interpreted once. The owner
heartbeats while preservation, optional push, and removal are running. It must
re-check `(workspace_id, attempt_id, lease_expires_at > now())` immediately
before every irreversible Git/filesystem side effect and in the final DB
transaction. Lease loss aborts with `CONFLICT`; the stale owner must not continue
or finalize.

Required order:

1. Load the run/workspace from server state and authorize the project action
   for user routes.
2. Evaluate an exact status allow-list and shared-tree sibling guard.
3. Claim the workspace lifecycle operation with a server-minted attempt ID,
   expected run status, operation name, and renewable lease.
4. Preserve the worktree.
5. Persist the preservation outcome, created archive ref/time, and exact commit
   under the claim before removal so a retry can recover it after process death.
6. Remove through `removeOwnedWorktree` with the configured root as
   `allowedRoot`.
7. In one DB transaction guarded by workspace ID, expected run status, attempt
   ID, and an unexpired lease, historicalize actionable state when required and
   write `removed_at`, `removal_kind`, the final run transition when applicable,
   scratch dialog state when applicable, ended/scheduled-removal fields, and
   the completed operation result.
8. Clean checkpoint refs and other best-effort repo-global residue only after
   the durable workspace result is known; failures remain visible and
   retryable without rolling back physical removal.

Preserve failure never removes. Removal failure never writes `removed_at` or
the final abandon transition. A stale operation whose path is already absent
must finalize from the durable operation intent instead of trying to preserve a
missing directory.

User-route failure classification:

| Failure class | HTTP/domain result | Durable/retry state |
| --- | --- | --- |
| Authz or status/shared-tree precondition | existing 403 or `409 PRECONDITION` | No claim and no Git/filesystem side effect |
| Another lifecycle owner holds the claim | `409 CONFLICT` | Existing owner remains authoritative; client may refresh/retry |
| Preserve cannot make recoverable state durable | `409 CONFLICT` with remediation | Failed/retryable claim, path present, `removed_at=NULL`, run status unchanged |
| Filesystem/Git removal transient failure | `503 EXECUTOR_UNAVAILABLE` | Failed/retryable claim, path present, `removed_at=NULL`, run status unchanged |
| Filesystem safety/trust refusal | `409 PRECONDITION` | Failed claim with safe reason; no DB terminal transition |
| Finalize DB failure after confirmed removal | `503 EXECUTOR_UNAVAILABLE` | Path absent and durable operation intent retained; retry finalizes without re-removal |
| Retry of an already completed identical intent | 200 idempotent result | Return established status/removal/archive facts; no repeated side effect |
| Retry requests a conflicting intent after completion | `409 CONFLICT` | Established lifecycle result remains unchanged |

All successful lifecycle removal routes return the same exact DTO:

```json
{
  "ok": true,
  "runId": "uuid",
  "operation": "archive|drop|discard",
  "runStatus": "Review|Crashed|Failed|Done|Abandoned",
  "workspaceRemoved": true,
  "idempotent": false,
  "preservationOutcome": "not_needed|ref_created|snapshot_created",
  "archivedBranch": "optional-ref"
}
```

`archivedBranch` is optional; every other field is required. An identical
completed replay returns the same established facts with `idempotent:true`.
`retention_gc` and `reconciliation` are internal dispositions and never accepted
from a request body. All user routes keep an empty body and `recoverRun`
membership derived from the run's server-side project. OpenAPI must specify
401/403/404/409/503 mappings and examples for first success, clean Archive,
idempotent replay, conflicting intent, preserve failure, trust refusal, and
transient removal/finalize failure.

For Stop & archive / Stop & drop, supervisor stop remains the first downstream
side effect. A retryable stop failure leaves DB/workspace unchanged. Once stop
commits the run's parked/terminal status, a later preserve/remove failure leaves
that parked state and a present, retryable worktree; it never rolls the run back
to live execution.

### D4. Multi-store crash windows are explicit

| Crash/failure boundary | Durable state | Required retry/recovery |
| --- | --- | --- |
| Before claim | No intent | Normal retry |
| After claim, before preserve | Claimed operation, path present | Reclaim stale lease and restart preserve |
| Lease expires while the old owner is still running | Claimed operation, path may be present | Old owner fails the next ownership fence; only the new owner may continue |
| Preserve fails | Failed claim, path present, `removed_at=NULL` | User or sweep retry; no status change |
| After preserve metadata commit, before remove | Archive metadata present, path present | Reclaim and continue at remove |
| Remove fails | Failed claim, path present, `removed_at=NULL` | Retry remove; do not report success |
| Process dies after remove, before finalize transaction | Claimed/failed operation, path absent, `removed_at=NULL` | Observe absence and finalize the operation-specific DB transition |
| Finalize transaction fails after remove | Path absent, stale claim | Same missing-path convergence; compare expected status/CAS |
| DB says removed but path still exists from legacy scratch ordering | `removed_at!=NULL`, path present | Provenance/path-checked reconciliation retries physical removal |
| Path disappears with no matching lifecycle intent | Row claims present, path absent | Quarantine/report unless the row is due `Done`/`Abandoned`; never infer an explicit Archive/Drop intent |

Failure-injection tests must exercise every row, including process-death-style
re-entry rather than only caught exceptions. Heartbeat tests use a deliberately
short lease and prove that a live owner renews, a dead owner is reclaimed, and a
reclaimed stale owner cannot cross the removal/finalize fence.

### D5. Shared writable trees are protected by all consumers

A shared writable tree is owned by one allocator workspace row and may be used
by several runs. Both explicit removal and automatic GC must block while any
sharing run is live or retains actionable work.

For the shared-tree removal guard, only siblings in `{Done, Abandoned}` are
disposable. `Review`, `Crashed`, `Failed`, `NeedsInput`, `NeedsInputIdle`, and
every active orchestration state block pruning. Existing shared-tree recovery
runs before generic orphan discovery.

Stop & archive / Stop & drop may be offered for writable agent runs only when
the coordinator can stop/cascade the owned execution subtree and prove no
other live/actionable sibling still uses the tree. Plain `workspace=none` and
`repo_read` agent runs do not expose Git archive/drop controls.

### D6. Reconstructible agent directories are not retained workbenches

The protected-status policy applies to writable Git worktrees. It does not
apply to reconstructible agent execution directories:

- `workspace=none`: after terminal finalization, restore/release owned
  materialization first, then remove the empty/owned run directory. A retrying
  sweep handles process death and partial cleanup.
- `repo_read`: retain the existing restore-before-remove behavior and sweep,
  but bring it under the same summary/progress contract.
- Foreign files, symlinks, a path outside the configured root, or an ownership
  mismatch cause refusal/quarantine, never recursive deletion.

Terminal cleanup reads the launch-time `runs.agent_workspace` snapshot (with
the existing compatibility fallback only for pre-snapshot rows); it never
re-derives the mode from the mutable agent catalog. Shared dispatch branches on
`run_kind` before invoking Flow-, scratch-, or agent-specific finalization, and
the irreversible removal site repeats that discriminant guard.

### D7. Disk-only worktrees require a durable observation ledger

Add `workspace_reconciliation_findings` in provisional migration `0106`. The
table is not run history; it is bounded operational state for filesystem/DB
convergence. At implementation start, re-check main and renumber if `0105` is
or `0106` is no longer free.

Required columns and meanings:

- `id` UUID/text primary key and deterministic unique
  `(canonical_worktree_path, observation_fingerprint)` identity;
- `candidate_kind`, `state`, nullable correlated `run_id`, `project_id`, and
  `workspace_id` plus `provenance_run_id`;
- root-relative display path, canonical worktree path, verified parent repo
  path, provenance version, and observation fingerprint;
- `first_seen_at`, `last_seen_at`, `armed_at`, `next_attempt_at`,
  `attempt_count`, `lease_expires_at`, and claim attempt ID;
- nullable rescue ref and rescue commit written before removal;
- sanitized `last_error_code`, `last_error_message`, and `resolved_at`.

States are exactly `observed`, `held`, `retry_waiting`, `failed`,
`quarantined`, and `resolved`. Index due work as
`(state, next_attempt_at, id)` and provenance correlation as
`(provenance_run_id, state)`, with partial claim/due indexes defined in the
migration. Checks enforce non-negative attempts, resolved timestamp/state
agreement, claim ID/lease pairing, and rescue ref/commit pairing. Resolved
observations are pruned after the existing GC age. Unchanged quarantines are
visible through a new read-only scheduler-admin drill-down and remain until the
fingerprint changes. `GET /api/admin/workspace-reconciliation-findings` requires
platform-admin authorization, supports allow-listed `state`, opaque cursor, and
bounded `limit <= 100`, and returns only finding ID, safe state/kind, root-
relative display path, correlated IDs, attempt/timestamps, rescue ref, and
sanitized error code/message. It never returns canonical absolute paths or
accepts a cleanup target. Mutation/manual re-arm is explicitly deferred; the
plan must not advertise an operator action that does not exist.

The pure classifier must produce these cases:

| Observation | Action |
| --- | --- |
| DB row and matching present worktree | Tracked; no reconciliation action |
| DB row, `removed_at=NULL`, path missing, recoverable lifecycle intent | Resume/finalize claimed operation |
| DB row, `removed_at=NULL`, path missing, no safe intent | Hold/quarantine; only due `Done`/`Abandoned` may use existing GC missing-path recovery |
| DB row, `removed_at!=NULL`, matching path still present | Retry physical removal after all trust checks |
| No workspace row, valid provenance, run row exists | Reconstruct only when parent repo, project, path, branch, and run ownership are exact; otherwise hold/quarantine and never remove |
| No workspace row, valid provenance, no run row | Observe for the GC-age grace period, re-check, preserve to a rescue ref, then prune |
| Missing/malformed/conflicting provenance | Quarantine/report only |
| Outside-root, symlinked, unregistered, or Git-parent mismatch | Quarantine/report only |

Autonomous disk-only pruning requires all gates at both discovery and the final
claimed action:

1. `realpath` is a descendant of `MAISTER_WORKTREES_ROOT`, is not the root, and
   traverses no symlink escape.
2. Git metadata yields a canonical common directory, and `git worktree list`
   from that repository lists the same canonical path. The reconciler never
   guesses a repository from the directory name or project slug.
3. Versioned MAIster provenance validates and matches the inferred run/path.
   New allocations write provenance v2 with `version`, `runId`, canonical
   `parentRepoPath`, `projectId`, branch, workspace kind, and created time.
   Legacy v1 may support report/hold and exact DB-backed recovery, but cannot
   authorize autonomous disk-only deletion by itself.
4. No workspace row exists by path or provenance run ID.
5. No run row and no live supervisor session exists for the provenance run ID.
6. The candidate has survived the existing GC-age grace period.
7. A final DB/Git/liveness re-check under the finding claim still agrees.
8. A collision-safe rescue ref under
   `maister/orphan/<findingId>/<runId>` is created with compare-and-set semantics
   after snapshotting dirty/untracked state and before removal. The exact ref and
   commit are persisted on the finding. An existing different ref is a conflict,
   never force-overwritten. Existing archive-push policy is reused; branch/ref
   deletion remains out of scope.

Legacy or unmarked paths never become auto-delete candidates.

### D8. Sweep progress is bounded and observable

`system_sweep.default` is the only periodic owner of every service included in
its bundle. Remove the unconditional legacy GC timer and
`MAISTER_GC_SWEEP_INTERVAL_SECONDS`, and audit the currently duplicated
keepalive/reconcile timers: either remove them and make `system_sweep` canonical
or prove and document a disjoint responsibility before retaining them.
Availability remains explicit: deployments call authenticated
`/api/cron/tick`, while single-box installs enable
`MAISTER_SCHEDULER_TIMER_ENABLED=true`.

`/api/cron/gc` remains an immediate compatibility entry point. Timer, cron tick,
and compatibility route call one `requestSystemSweep` service that atomically
creates or force-makes-due the canonical job, claims it if no unexpired owner
exists, and executes through the same scheduler attempt path. A losing caller
returns an explicit `alreadyRunning` summary without executing cleanup. The
system-sweep attempt renews its lease and fences summary persistence; two entry
points may not run the bundle concurrently.

Each cleanup service must have:

- deterministic due ordering;
- a bounded batch size and concurrency;
- per-item isolation so one failure cannot abort later items;
- attempt state updated in `finally`;
- capped exponential retry for transient failures;
- permanent quarantine for trust violations;
- a poison-item policy that cannot monopolize the first 100 rows;
- one structured summary with scanned, retained, recovered, preserved,
  removed, retryable-failed, quarantined, and resolved counts.

All unattended candidate kinds, including row-backed GC failures, use the
finding ledger for retry scheduling even when the workspace lifecycle claim is
the side-effect ownership fence. A candidate receives at most eight transient
attempts per `armed_at` generation with exponential backoff capped at 24 hours.
Exhaustion becomes `failed`; a changed observation fingerprint creates a new
`armed_at` generation and fresh budget. Explicit operator re-arm is deferred.
Trust violations become `quarantined` immediately and are not retried while the
fingerprint is unchanged. Thus a failing first page is excluded until due and
cannot hide row N+1.

Persist the composed summary in `scheduler_job_runs.summary` from
`runClaimedJob`; do not discard `runSystemSweep()`'s returned value. The
scheduler attempt is successful only when the bundle completed; partial item
failures are represented in the summary without disabling future sweeps.
Bundle-level DB, lease-loss, or wiring failures remain failed scheduler
attempts.

The production wiring proof must drive the real
`runSchedulerTick({ jobKind: "system_sweep" })` claim → dispatch → summary path;
direct calls to `runSystemSweep` alone do not satisfy the wiring gate.

### D9. Tests own isolated roots

The test harness, not individual tests, owns worktree-root isolation.

- Both Vitest projects receive an invocation-scoped
  `MAISTER_WORKTREES_ROOT`; tests may narrow it but may not fall back to the
  user's default root.
- normal and live Playwright set separate invocation-scoped worktree roots.
- the E2E wrapper owns setup and Git-aware teardown in `finally`, including
  success, failure, SIGINT, and SIGTERM.
- teardown first unregisters/removes Git worktrees through the same confined
  helper, then removes only the asserted invocation root.
- a guard fails fast if a test process resolves `~/.maister/worktrees` or a path
  outside its invocation root.

### D10. Runtime JSONL remains unchanged

No task in this plan moves, preserves, compacts, archives, or deletes JSONL.
The SDD documents the filesystem boundary so future artifact-retention work can
be planned independently without coupling it to workspace GC.

## Acceptance Criteria

- A due `Review`, `Crashed`, `Failed`, `NeedsInput`, or `NeedsInputIdle`
  writable worktree survives repeated scheduler/compatibility GC runs.
- A shared allocator tree survives while any sibling is in a protected status;
  only all-`Done`/`Abandoned` siblings permit automatic collection.
- A due `Done` or `Abandoned` worktree is preserved and pruned exactly once;
  retries converge after every documented crash window.
- Archive removes the directory, reports `workspaceRemoved: true`, records
  archive intent even for a clean worktree, and leaves the run status/history
  unchanged.
- Every successful lifecycle route returns the exact shared DTO, an identical
  replay returns the established result with `idempotent:true`, and a different
  intent after completion returns `409 CONFLICT` without side effects.
- A completed removal has a durable `removal_kind` and preservation outcome;
  legacy removed rows are explicitly marked `legacy`/`legacy_unknown` rather
  than guessed.
- Drop/Discard removes the directory through the same coordinator and changes
  a non-`Done` run to `Abandoned` only after confirmed removal.
- Scratch discard never writes `removed_at` before removal and never reports
  success when removal failed.
- An archived `Review`/`Crashed` run remains in history but no longer strands
  its task or exposes worktree-backed, Recover, HITL/review, takeover, rework,
  or promotion actions. Server routes refuse even if called directly.
- A live lease is renewed across slow preserve/push/remove work; after lease
  loss, the stale owner cannot cross an irreversible fence or persist success.
- A dirty/untracked real Git worktree can be archived, physically removed, and
  recovered from `maister/archive/<runId>`.
- `workspace=none` and `repo_read` terminal directories are cleaned after
  materialization restore and are retried after partial failure.
- New allocations write provenance v2. Valid rowless managed worktrees are
  exactly reconstructed or grace-observed; legacy v1 without a DB-backed exact
  match, malformed provenance, symlink escapes, outside-root paths, and
  Git-parent mismatches are quarantined and never deleted.
- Orphan rescue uses a collision-safe CAS-created
  `maister/orphan/<findingId>/<runId>` ref whose commit is durable in the
  finding; an existing different ref is never overwritten.
- More than 100 candidates with early poison entries still make bounded
  progress on later due entries.
- Platform admins can inspect bounded, cursor-paginated reconciliation findings
  and quarantines without receiving canonical absolute paths or a mutation API.
- One scheduler invocation calls each cleanup service once and persists the
  detailed summary; concurrent timer/tick/compatibility calls have one winner,
  a renewed lease, and a fenced summary write. No retained legacy timer invokes
  a service already owned by the bundle.
- Vitest, normal Playwright, and live Playwright cannot resolve or leave
  worktrees in the user's default root.
- Existing run JSONL/runtime artifacts are byte-for-byte outside the mutation
  surface of all new cleanup services.
- EN/RU copy states that Archive preserves recoverable work, removes the local
  worktree, and leaves run history available.

## Deployment Wiring

No new package, sidecar, port, volume, or required env var is introduced.

The implementation removes the obsolete
`MAISTER_GC_SWEEP_INTERVAL_SECONDS` surface from:

- `.env.example`;
- `web/lib/instance-config.ts` and its tests;
- `web/lib/gc/sweeper.ts` / `web/instrumentation.ts` wiring;
- `docs/configuration.md` and deployment/getting-started guidance that implies
  a second GC timer.

The deployment contract must explicitly keep both supported scheduler modes:

- external authenticated `/api/cron/tick` for production;
- `MAISTER_SCHEDULER_TIMER_ENABLED=true` for single-box fallback.

`MAISTER_GC_AGE_DAYS`, `MAISTER_WORKTREES_ROOT`,
`MAISTER_SCHEDULER_TIMER_ENABLED`, and `MAISTER_CRON_TOKEN` retain their current
deployment wiring. If implementation introduces any new configurable grace or
retry value despite this decision, the same commit must update `.env.example`,
`compose.yml`, `compose.production.yml`, `docs/configuration.md`, and
`docs/getting-started.md`; a code-only env addition fails the phase.

## Contract Surface Map

| Changed surface | Canonical specifications |
| --- | --- |
| `POST /api/runs/{runId}/archive` semantics/response | `docs/api/web.openapi.yaml`, `docs/system-analytics/workbench-lifecycle.md`, `docs/screens/runs/workbench.md` |
| `POST /api/runs/{runId}/drop` semantics/recovery | `docs/api/web.openapi.yaml`, `docs/system-analytics/workbench-lifecycle.md`, `docs/system-analytics/reconciliation-gc.md` |
| `POST /api/runs/{runId}/discard` immediate preserve-first removal | `docs/api/web.openapi.yaml`, `docs/system-analytics/runs.md`, `docs/system-analytics/reconciliation-gc.md` |
| `POST /api/scratch-runs/{runId}/discard` alignment | `docs/api/web.openapi.yaml`, `docs/system-analytics/scratch-runs.md`, `docs/screens/runs/scratch-run.md` |
| `POST /api/runs/{runId}/stop-archive` and `stop-drop` agent/scratch behavior | `docs/api/web.openapi.yaml`, `docs/system-analytics/workbench-lifecycle.md`, `docs/system-analytics/acp-runners.md` |
| Exact lifecycle response DTO, replay, RBAC, and HTTP errors | `docs/api/web.openapi.yaml`, `docs/system-analytics/workbench-lifecycle.md`, route schemas/tests |
| Completed workspace disposition and preservation result | migration `0105`, `docs/database-schema.md`, `docs/db/runs-domain.md`, `docs/db/erd.md` |
| Board/manual/scheduled launchability after removed historical run | `docs/system-analytics/runs.md`, `docs/system-analytics/scheduler.md`, `docs/screens/projects/project-board.md`, `docs/screens/runs/list.md` |
| Active workspace and removed-workspace detail behavior | `docs/system-analytics/workspaces.md`, `docs/screens/chrome/active-workspaces.md`, `docs/screens/runs/{flow-run,run-inspector,workbench}.md` |
| Historicalization of Review/Crashed actionable state | `docs/system-analytics/workbench-lifecycle.md`, `docs/system-analytics/hitl.md`, `docs/system-analytics/runs.md`, run inspector/workbench screens |
| `workspace_reconciliation_findings` table/index/state contract | migration `0106`, `docs/database-schema.md`, `docs/db/runs-domain.md`, `docs/db/erd.md` |
| Reconciliation classifier, grace, rescue, retry, quarantine | `docs/system-analytics/reconciliation-gc.md`, provisional ADR-140 |
| `system_sweep` ownership and persisted summary | `docs/system-analytics/scheduler.md`, `docs/screens/admin-scheduler.md`, `docs/api/web.openapi.yaml` where the existing admin DTO is specified |
| Read-only reconciliation finding drill-down | `GET /api/admin/workspace-reconciliation-findings` in `docs/api/web.openapi.yaml`, `docs/screens/admin-scheduler.md`, `docs/system-analytics/reconciliation-gc.md` |
| Provenance v2 and legacy-v1 limits | `docs/system-analytics/workspaces.md`, `docs/system-analytics/reconciliation-gc.md`, provisional ADR-140 |
| Worktree vs runtime-artifact filesystem roots | `docs/system-analytics/workspaces.md`, `docs/configuration.md`, `.env.example` |
| Removed legacy GC interval | `.env.example`, `docs/configuration.md`, `docs/getting-started.md` |
| Project-wide current-state wording | `CLAUDE.md`, `web/CLAUDE.md`, `.ai-factory/DESCRIPTION.md`, `README.md`, `docs/architecture.md` |

No AsyncAPI event changes and no new `MaisterError` code are expected. Reuse
`PRECONDITION`, `CONFLICT`, and `EXECUTOR_UNAVAILABLE` with
actionable messages. If a new error code becomes necessary, add
`docs/error-taxonomy.md` and all error consumers in the same phase.

## Identifier Trust Table

| Identifier | Source | Rule |
| --- | --- | --- |
| `runId` on lifecycle routes | `url-param` | Resolve the run and project server-side before any Git or filesystem operation. |
| authenticated user/project role | `auth-context` + `server-state` | Existing project action authorization remains mandatory. |
| workspace ID/path, parent repo, branch, base ref | `server-state` | Never accept from request bodies. |
| lifecycle attempt ID | `server-state` | Server-minted claim fence; never client-selectable. |
| lifecycle lease/expected status/completed disposition | `server-state` | Checked before irreversible effects and finalization; never inferred from UI state. |
| scratch run/dialog identity | `url-param` joined to `server-state` | The shared coordinator resolves workspace/run state; the body cannot redirect cleanup. |
| scheduler job ID/kind | `server-state` | Compatibility route delegates to the canonical `system_sweep` identity. |
| disk candidate path | filesystem enumeration under configured root | Canonicalize, root-confine, match Git registry and provenance; never trust a filename alone. |
| provenance v2 fields | managed metadata, then compared with DB, Git, and supervisor state | A classifier input; even v2 is not sufficient authorization for deletion. |
| finding ID | server-minted deterministic identity | Internal claim key; it never expands into an arbitrary client path. |
| cron token | request header/auth context | Existing constant-time validation remains unchanged. |

No changed lifecycle route needs a body-controlled cross-resource identifier.

## Provisional ADR and Migration Reservation

- The next ADR observed on the branch is ADR-139. Reserve **ADR-140** for this
  lifecycle/reconciliation contract.
- The next migration observed in Drizzle journal/files is `0105`. Reserve
  **migration 0105** for workspace lifecycle leases, completed disposition,
  and preservation outcome. Reserve provisional **migration 0106** for
  `workspace_reconciliation_findings`.
- Phase 0 begins by re-checking the then-current `main`. It writes the ADR-140
  header before any other document cites it.
- Each migration is a generated SQL/journal/snapshot triple. Migration `0105`
  backfills existing `removed_at IS NOT NULL` rows to
  `removal_kind='legacy'` and `preservation_outcome='legacy_unknown'`; it never
  guesses Archive vs Drop. Migration `0106` adds an empty operational table and
  does not classify filesystem state during migration. Existing state is
  discovered after deployment through the normal grace-observation path.
- After rebasing onto current main, perform an explicit ADR/migration renumber
  pass, including prose references, filenames, journal `idx`/`tag`, snapshot,
  and anchor validation. Do not hand-renumber only the SQL file.

## Commit Plan

- **Commit 1 (Phase 0):** `docs: specify run workspace lifecycle cleanup`
- **Commit 2 (Phase 1):** `test: isolate run workspaces in test harnesses`
- **Commit 3 (Phase 2):** `feat: persist workspace lifecycle disposition`
- **Commit 4 (Phase 2):** `feat: unify claimed workspace removal lifecycle`
- **Commit 5 (Phase 3):** `fix: protect actionable and shared run worktrees`
- **Commit 6 (Phase 4):** `feat: add workspace reconciliation findings`
- **Commit 7 (Phase 4):** `feat: reconcile managed workspace orphans`
- **Commit 8 (Phase 5):** `fix: make system sweep the single cleanup owner`
- **Commit 9 (Phase 6):** `feat: align workspace lifecycle surfaces`
- **Commit 10 (Phase 7):** `test: verify workspace lifecycle recovery end to end`
- **Commit 11 (Phase 7):** `docs: reconcile workspace lifecycle as built`

Each checkpoint requires its phase exit gate green. Do not combine the
migration with an unrelated generated change, and do not commit a red phase.

## Task Logging Contract

Every task's `Logging` bullet inherits this contract in addition to its local
requirements:

- `DEBUG`: classifier inputs reduced to safe enums/IDs, claim transitions,
  retry scheduling, and per-phase timings.
- `INFO`: user-requested lifecycle outcome and one aggregate sweep/harness
  start/completion summary.
- `WARN`: protected/held candidates, retryable preserve/remove failures, stale
  claims, and compatibility-entry contention.
- `ERROR`: failed durable transition, unsafe-path refusal, bundle-level failure,
  or cleanup that cannot make its promised state converge.
- Use the existing pino logger and `LOG_LEVEL`; operators can reduce production
  verbosity without code changes.
- Log structured fields, not interpolated dynamic messages. Inputs/outputs mean
  server-derived IDs, safe enums, counts, digests, and result codes — never
  prompts, JSONL, diffs, file contents, secrets, tokens, or unredacted absolute
  paths.

## Test Ownership and Non-Overlap Matrix

| Lane | Owns | Must not duplicate |
| --- | --- | --- |
| Pure unit | status/disposition policy, backoff, observation classifier, provenance/path parsing | DB claims, Git subprocess behavior, route wiring |
| Postgres integration | migration shape, CAS/lease/heartbeat, transactional finalization, crash re-entry, scheduler summary persistence | rendering and pure table permutations already covered by unit tests |
| Real-Git integration | dirty/untracked preservation, ref CAS, Git registry/realpath verification, confined removal | HTTP/RBAC and complete status matrices |
| Route tests | authentication, project action, empty-body validation, exact DTO/status/error mapping, replay semantics | internal classifier truth tables and Git implementation details |
| DOM/component | visible action availability, localized copy, removed-history state, keyboard/accessibility behavior | backend status/claim matrices |
| Playwright E2E | three critical journeys: Archive, Drop/Discard, automatic reconciliation/admin summary | exhaustive statuses, failure injection, retry math, lease races, every run kind |

Every requirement has one primary test owner. A higher-level test may assert the
observable consequence of a lower-level rule, but must not replicate its full
permutation table. Unit tests are limited to stable pure transformations;
Postgres and real Git integration are the default for lifecycle correctness.
Mocks are used only at unavailable external boundaries such as the supervisor,
never to replace a practical local Git or database assertion.

## Tasks

### Phase 0 — SDD contract freeze before code

- [x] **Task 1: Reserve ADR-140 and freeze lifecycle and historicalization state machines.**
  - **Files:** `docs/decisions.md`,
    `docs/system-analytics/workbench-lifecycle.md`,
    `docs/system-analytics/workspaces.md`,
    `docs/system-analytics/reconciliation-gc.md`,
    `docs/system-analytics/runs.md`,
    `docs/system-analytics/scratch-runs.md`,
    `docs/system-analytics/acp-runners.md`,
    `docs/system-analytics/hitl.md`, and
    `docs/system-analytics/scheduler.md`.
  - **Change:** re-check main, create the ADR header first, then specify the
    protected/disposable matrix, Archive-vs-Drop distinction,
    `WaitingOnChildren` refusal/remediation, shared-tree ownership, agent mode
    behavior, actionable-state historicalization, renewable lifecycle and
    scheduler claims, every crash/lease-loss window, provenance v2 and legacy
    limits, orphan classifier, grace, collision-safe rescue, retries,
    quarantine, and the JSONL non-goal. Mark unbuilt pieces `Designed`.
  - **Logging:** specify structured fields and redaction policy: `operation`,
    `attemptId`, `workspaceId`, `runId`, `findingId`, safe candidate class,
    counts, duration, and sanitized error code; no content/diff/JSONL.
  - **Tests:** run Mermaid and ADR-anchor validators after the header and links
    exist.
  - **Acceptance:** all named analytics documents are internally consistent and
    contain Purpose, entities/state, process, expectations, edge cases, and
    linked artifacts. Archive of every allowed status has an exact auxiliary
    state outcome. No code task begins with an unresolved transition,
    historicalization, lease-loss, or crash-window row.

- [x] **Task 2: Freeze exact API, RBAC, and user-surface contracts.**
  - **Files:** `docs/api/web.openapi.yaml`,
    `docs/screens/chrome/active-workspaces.md`,
    `docs/screens/projects/project-board.md`,
    `docs/screens/runs/{list,flow-run,scratch-run,run-inspector,workbench}.md`,
    `docs/screens/admin-scheduler.md`, and `docs/error-taxonomy.md` only if the
    closed error union actually changes.
  - **Change:** specify the shared required lifecycle DTO, empty request bodies,
    optional archive branch, `preservationOutcome`, first success, identical
    replay, conflicting replay, RBAC, every 401/403/404/409/503 mapping, and
    examples. Define removed-history rendering and direct-call refusal for
    Recover, HITL/review, gate chat, takeover, rework, export/diff, and
    promotion. Define the immediate compatibility-GC response including the
    `alreadyRunning` loser. Define the platform-admin-only, cursor-paginated,
    read-only findings route and explicitly exclude mutation/re-arm.
  - **Logging:** document API audit fields and scheduler summary fields;
    explicitly forbid absolute orphan paths in DTOs/logs.
  - **Tests:** validate OpenAPI and map each operation/error/example to a route
    contract test; no implementation code yet.
  - **Acceptance:** OpenAPI has one canonical schema referenced by all lifecycle
    routes, existing membership is explicit, no client-controlled path/ref is
    introduced, and screens use the same operation names and outcomes.

- [x] **Task 3: Freeze exact DB migration and durable-state contracts.**
  - **Files:** `docs/database-schema.md`, `docs/db/runs-domain.md`,
    `docs/db/erd.md`, `web/lib/db/schema.ts` as read-only evidence, and the
    provisional `0105`/`0106` migration notes in ADR-140.
  - **Change:** define exact `0105` workspace columns, enums/checks/indexes,
    lifecycle lease/expected status, preservation outcome, completed
    disposition, and legacy backfill. Separately define every `0106` finding
    column, state/check/index, deterministic identity, claim lease, rescue
    ref/commit pairing, retry generation, and resolved retention rule. Neither
    migration performs filesystem work or guesses historical intent.
  - **Logging:** document stored sanitized failure fields and forbid raw
    filesystem evidence/content in operational rows.
  - **Tests:** specify upgrade-from-current, legacy-backfill, fresh-schema,
    check/index, and migration-journal assertions.
  - **Acceptance:** docs and ERD match exact planned Drizzle definitions; each
    field has a writer, reader, invariant, and retention owner. Migration `0105`
    is consumed before coordinator code and `0106` before reconciliation code.

- [x] **Task 4: Freeze the TDD traceability and non-overlap manifest.**
  - **Files:** this plan, analytics Expectations/Edge Cases sections, and
    existing Vitest/Playwright configuration as read-only evidence.
  - **Change:** map every acceptance criterion and crash-window row to one
    primary test lane from the Test Ownership Matrix. Name focused test files
    and three E2E journeys. Require a recorded failing assertion before each
    GREEN slice and a behavior-preserving REFACTOR gate after it.
  - **Logging:** tests assert safe structured codes/counts, not raw messages or
    content.
  - **Tests:** verify every named future test routes to an existing project; do
    not create implementation tests in Phase 0.
  - **Acceptance:** no requirement lacks a test owner, no low-level permutation
    belongs to E2E, and pure unit tests are limited to pure transformations.

**Phase 0 exit gate**

```bash
pnpm validate:contracts
pnpm validate:docs:all
pnpm validate:docs:adr:all
```

### Phase 1 — Test-root isolation first

- [x] **Task 5: RED — prove every test lane refuses the user worktree root.**
  - **Files:** new/extended tests for `web/vitest.workspace.ts`,
    `web/playwright.config.ts`, `web/playwright.live.config.ts`,
    `web/e2e/run.ts`, and `web/lib/orchestrator/__tests__/e2e-loop.integration.test.ts`.
  - **Change:** add failing tests for unit/integration, normal E2E, live E2E,
    normal completion, Playwright failure, and interruption. Assert the resolved
    root is invocation-scoped and never the default user root.
  - **Logging:** test harness logs only its invocation ID and root category
    (`vitest`, `e2e`, `e2e-live`), not a home-directory expansion.
  - **Tests:** confirm each test is listed by `vitest list` or Playwright list;
    preserve the RED output as the checkpoint evidence.
  - **Acceptance:** failures reproduce the current live-Playwright and real
    agent integration leaks before production code/harness changes.

- [x] **Task 6: GREEN — centralize isolated root ownership and teardown.**
  - **Files:** `web/vitest.workspace.ts`, a minimal test setup/global-setup
    helper under `web/test-support/`, `web/playwright.config.ts`,
    `web/playwright.live.config.ts`, `web/e2e/run.ts`, and affected harness
    tests.
  - **Change:** allocate per-invocation roots, set them before app imports,
    fail fast on fallback, and perform confined Git-aware teardown in `finally`
    after success/failure/signals. Remove ad-hoc leakage from the orchestrator
    integration path.
  - **Logging:** structured setup/teardown summaries with root category,
    registered-worktree count, removed count, and failure count.
  - **Tests:** make Task 5 green; include teardown failure propagation without
    hiding the original test failure.
  - **Acceptance:** test harness cleanup cannot target a user-configured/default
    root, and no test in this feature can create new debris there.

- [x] **Task 7: REFACTOR — reduce harness duplication without changing behavior.**
  - **Files:** the Task 6 test-support helper, Vitest/Playwright config, and E2E
    wrapper.
  - **Change:** retain one pure root allocator/validator and one Git-aware
    teardown path, remove duplicated env/default logic, and preserve
    signal/finally behavior. Do not generalize production filesystem APIs into
    test-only modes.
  - **Logging:** keep one start and one completion summary per invocation.
  - **Tests:** rerun Task 5 tests plus full unit/integration discovery.
  - **Acceptance:** all Task 5/6 assertions remain green, types are strict, and
    no helper accepts an unsafe boolean flag or unvalidated arbitrary root.

**Phase 1 exit gate**

```bash
pnpm --filter maister-web exec vitest list --project unit
pnpm --filter maister-web exec vitest list --project integration
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration
pnpm --filter maister-web typecheck
```

### Phase 2 — Canonical explicit lifecycle removal

- [x] **Task 8: RED — lock migration 0105 and durable lifecycle-result behavior.**
  - **Files:** `web/lib/db/__tests__/migration-journal-integrity.test.ts`,
    schema/migration integration tests, and new lifecycle-result repository
    integration tests.
  - **Change:** add failing assertions for all `0105` columns, constraints,
    indexes, legacy backfill, operation-name retention on failure,
    expected-status persistence, completed disposition, preservation outcome,
    and exact replay reconstruction.
  - **Logging:** assert sanitized state/result codes only.
  - **Tests:** prove failures are caused by the absent schema and behavior, not
    by test discovery or a missing database fixture.
  - **Acceptance:** RED covers fresh and upgrade schemas and demonstrates why
    `archived_at` plus a cleared claim cannot distinguish Archive/Drop/GC.

- [x] **Task 9: GREEN — generate migration 0105 and persist lifecycle results.**
  - **Files:** `web/lib/db/schema.ts`, generated `0105_*.sql`,
    `web/lib/db/migrations/meta/_journal.json`,
    `web/lib/db/migrations/meta/0105_snapshot.json`, and focused lifecycle
    claim/result repository modules.
  - **Change:** add lease expiry, expected run status, durable operation intent,
    removal kind, preservation outcome/ref/commit fields, checks/indexes, and
    the explicit legacy backfill. Preserve active failed intent; provide typed
    exact-result reads for replay/conflict classification.
  - **Logging:** log claim/result identifiers and safe enums, never raw paths.
  - **Tests:** make Task 8 green, run `db:generate`, migration check, journal
    integrity, schema integration, and typecheck.
  - **Acceptance:** migration applies from the prior snapshot, current rows are
    not misclassified, and code can reconstruct a completed lifecycle result
    without filesystem access.

- [x] **Task 10: RED — encode preservation, lease, historicalization, and crash windows.**
  - **Files:** `web/lib/workbench-lifecycle/__tests__/service.test.ts`,
    `race.test.ts`, `lifecycle-claim.integration.test.ts`,
    `real-git.integration.test.ts`, scratch/run discard route tests, and
    `workbench-stop.integration.test.ts`.
  - **Change:** write failing cases for Archive removes/keeps status; Drop
    removes/abandons; historicalization of Review/Crashed auxiliary state;
    direct-action refusal after removal; clean archive; dirty/untracked rescue;
    preserve/removal/finalize failures; already-missing retry; heartbeat,
    expiry/reclaim and stale-owner fences; concurrent archive/drop/GC; scratch
    alignment; identical/conflicting replay; and writable agent combinations.
  - **Logging:** assert one start, transition, failure/retry, and completion
    event per attempt with no file contents or diff.
  - **Tests:** use pure unit tests only for policy/disposition tables, real
    Postgres for claims/transactions, and real Git for preservation/removal.
    Existing old-contract assertions are deliberately migrated, not deleted.
  - **Acceptance:** focused tests are runnable and fail only because the old
    Archive/scratch/claim behavior is still present.

- [x] **Task 11: GREEN — implement the modular claimed removal protocol.**
  - **Files:** focused modules under `web/lib/workbench-lifecycle/` for policy,
    claims/heartbeat, preservation, ownership/removal, finalization, and
    orchestration; run/scratch discard services/routes; existing Git helpers;
    checkpoint cleanup seam.
  - **Change:** implement D2-D4 ordering, renewable claim fencing, preservation
    metadata before removal, server-side historicalization, one finalization
    transaction, missing-path operation recovery, and exact allow-lists. Route
    Archive, Drop and both discard paths through typed exhaustive operations;
    eliminate scratch's DB-first/logged-success path.
  - **Logging:** structured operation state, attempt ID, server-derived IDs,
    phase, result, and sanitized failure; removal failure is an error response,
    never logged success.
  - **Tests:** make Task 10 green, including real Git recovery and concurrent
    ownership.
  - **Acceptance:** every row-backed remove path calls the coordinator; grep
    finds no route that writes `removed_at` before confirmed removal and no
    direct unconfined recursive worktree deletion. A stale owner cannot remove
    or finalize after lease loss.

- [x] **Task 12: GREEN — generalize safe combined actions for writable agents.**
  - **Files:** lifecycle orchestrators, agent stop/cascade
    helpers, shared-tree ownership helpers, combined-action routes, and agent
    integration tests.
  - **Change:** allow Stop & archive / Stop & drop for owned writable agent
    worktrees, preserve agent stop semantics, and refuse shared-tree removal
    while another live/actionable sibling exists. Keep `none`/`repo_read` out of
    Git archive/drop.
  - **Logging:** include `runKind`, workspace mode, root run ID, and blocking
    sibling count; never log prompts or agent output.
  - **Tests:** cover own, shared allocator, shared reuser, live sibling,
    protected sibling, and all-disposable siblings.
  - **Acceptance:** an agent action cannot pull a shared tree out from another
    run, and supported actions use the same coordinator as Flow/scratch.

- [x] **Task 13: REFACTOR — enforce single-purpose lifecycle boundaries.**
  - **Files:** modules touched by Tasks 9-12 and their tests.
  - **Change:** remove duplicate operation sequencing and status sets, keep
    discriminated unions exhaustive, isolate side-effect ports, and reduce the
    existing service to orchestration. Preserve public behavior; add no new
    modes or fallback paths.
  - **Logging:** retain one lifecycle event vocabulary and avoid duplicate
    success logs across repository/orchestrator layers.
  - **Tests:** rerun all Task 8-12 focused tests and full unit/integration suites.
  - **Acceptance:** SOLID/KISS/DRY review passes, strict types contain no new
    `any`, no function switches unrelated behavior via flags, and all GREEN
    assertions remain unchanged.

**Phase 2 exit gate**

```bash
pnpm --filter maister-web db:generate
pnpm --filter maister-web db:check
pnpm --filter maister-web exec vitest run --project unit lib/db/__tests__/migration-journal-integrity.test.ts
pnpm --filter maister-web exec vitest run --project unit lib/workbench-lifecycle/__tests__/service.test.ts lib/workbench-lifecycle/__tests__/race.test.ts 'app/api/scratch-runs/[runId]/discard/__tests__/route.test.ts'
pnpm --filter maister-web exec vitest run --project integration lib/workbench-lifecycle/__tests__/lifecycle-claim.integration.test.ts lib/workbench-lifecycle/__tests__/real-git.integration.test.ts lib/workbench-lifecycle/__tests__/workbench-stop.integration.test.ts
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration
pnpm --filter maister-web typecheck
```

### Phase 3 — Automatic retention and reconstructible agent cleanup

- [x] **Task 14: RED — lock the complete GC protection and progress matrix.**
  - **Files:** `web/lib/gc/__tests__/workspace-gc.integration.test.ts`,
    `shared-tree-gc.integration.test.ts`, and lifecycle/GC race tests.
  - **Change:** add due rows for every run status; prove only `Done` and
    `Abandoned` are candidates. Add shared siblings in `Review`, `Crashed`,
    `Failed`, HITL, and live states. Add more than 100 rows with early preserve
    failures and prove later due rows progress.
  - **Logging:** assert retained/block reasons and aggregate counts without one
    noisy info log per healthy retained row.
  - **Tests:** integration project against the real Postgres harness.
  - **Acceptance:** RED demonstrates the broad-terminal shared sibling bug and
    poison-first-page starvation before the fix.

- [x] **Task 15: GREEN — use the disposable set and lifecycle protocol in GC.**
  - **Files:** `web/lib/gc/workspace-gc.ts`,
    `web/lib/runs/run-status-sets.ts` or a dedicated workspace-retention module,
    lifecycle claim helpers, and GC tests.
  - **Change:** introduce one semantically named disposable status set, use it
    for candidate and shared-sibling guards, acquire the common lifecycle
    claim, order candidates deterministically, and converge missing-path
    claimed operations.
  - **Logging:** summary plus warnings/errors for attempted items; include
    protected/shared skip counts and retry counts.
  - **Tests:** make Task 14 green; explicitly assert scheduled-removal timestamps
    cannot bypass status protection.
  - **Acceptance:** user actions and GC cannot race Git removal, and no protected
    worktree is selected.

- [x] **Task 16: RED — specify reconstructible agent-directory cleanup.**
  - **Files:** `web/lib/agents/launch.ts`,
    `web/lib/agents/materialization-manifest.ts`,
    `web/lib/gc/ephemeral-agent-gc.ts`,
    `web/lib/gc/agent-materialization-gc.ts`, a single-purpose plain-directory
    cleanup service, and their tests.
  - **Change:** write failing restore-before-remove, active retention,
    terminal/missing-run cleanup, run-kind/mode discrimination,
    symlink/foreign/outside-root refusal, and retry tests.
  - **Logging:** per-failure structured mode/run/finding data and aggregate mode
    counts; no materialized file names unless reduced to a safe count.
  - **Tests:** unit pure-classifier tests plus integration finalizer ordering.
  - **Acceptance:** RED isolates the leaked `workspace=none` finalizer and any
    missing `repo_read` recovery without duplicating writable-worktree GC tests.

- [x] **Task 17: GREEN — remove reconstructible agent directories safely.**
  - **Files:** files from Task 16 plus existing terminal finalization seams.
  - **Change:** implement immediate finalizer cleanup plus sweep recovery for
    `workspace=none`, retaining/reusing `repo_read` restore-before-remove and
    ownership safeguards. Branch on the persisted launch-time mode and run kind
    at dispatch and immediately before removal.
  - **Logging:** preserve Task 16's structured failure and aggregate contract.
  - **Tests:** make Task 16 green with real filesystem integration where
    practical.
  - **Acceptance:** terminal plain/read-only directories converge to absent,
    while writable worktrees remain governed solely by D1-D5.

- [x] **Task 18: REFACTOR — centralize retention policy and cleanup summaries.**
  - **Files:** workspace GC, reconstructible cleanup services, shared status
    sets, and summary types.
  - **Change:** keep one disposable-status policy and one summary vocabulary,
    remove duplicate retry/skip counting, and preserve separate Git-worktree vs
    plain-directory removal ports.
  - **Logging:** one aggregate summary per service; no healthy per-row INFO
    spam.
  - **Tests:** rerun Tasks 14-17 and full unit/integration suites.
  - **Acceptance:** behavior stays green, cleanup modes remain type-separated,
    and shared policy has one source of truth.

**Phase 3 exit gate**

```bash
pnpm --filter maister-web exec vitest run --project unit lib/gc/__tests__/ephemeral-agent-gc.test.ts lib/gc/__tests__/agent-materialization-gc.test.ts
pnpm --filter maister-web exec vitest run --project integration lib/gc/__tests__/workspace-gc.integration.test.ts lib/gc/__tests__/shared-tree-gc.integration.test.ts
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration
pnpm --filter maister-web typecheck
```

### Phase 4 — Durable orphan observation and reconciliation

- [ ] **Task 19: RED — specify provenance v2 and migration 0106 in tests.**
  - **Files:** provenance core/runtime tests, allocation integration tests,
    schema/migration integration tests,
    `web/lib/db/__tests__/migration-journal-integrity.test.ts`, and pure finding
    repository/backoff tests.
  - **Change:** add failing provenance-v2 parse/write/validation and legacy-v1
    limit cases. Add exact schema/migration expectations for every finding
    column, state, check, index, deterministic identity, lease, retry generation,
    rescue ref/commit pair, and resolution rule.
  - **Logging:** none in the pure classifier; DB/service tests assert sanitized
    error persistence.
  - **Tests:** confirm unit/integration runner globs list the new files.
  - **Acceptance:** RED fails on absent provenance-v2/schema behavior, not on a
    missing runner glob; v1 is demonstrably insufficient for autonomous delete.

- [ ] **Task 20: GREEN — write provenance v2 and implement durable findings.**
  - **Files:** provenance core/runtime modules and all writable allocation
    sites; `web/lib/db/schema.ts`, generated `0106_*.sql`,
    `web/lib/db/migrations/meta/_journal.json`,
    `web/lib/db/migrations/meta/0106_snapshot.json`, finding repository/service,
    and DB tests.
  - **Change:** write provenance v2 atomically for Flow, scratch, own-agent and
    shared allocator worktrees with version, run/project/repo/branch/kind/created
    data; retain explicit v1 parsing. Add the finding table, constraints,
    deterministic identity, due indexes, renewable CAS claim/reclaim, capped
    backoff, quarantine, resolution, rescue evidence, and resolved-row
    retention. No migration filesystem side effect.
  - **Logging:** DB writes store sanitized codes/messages; operational logs use
    finding ID and root-relative path only.
  - **Tests:** make Task 19 green; run `db:generate`, journal integrity,
    migration check, allocation tests, schema integration, claim races, lease
    renewal, and retry math.
  - **Acceptance:** the migration triple applies from `0105`; every new writable
    allocation writes v2; v1 remains readable but cannot silently gain delete
    authority.

- [ ] **Task 21: RED — encode trust, exact reconstruction, grace, and TOCTOU.**
  - **Files:** new `web/lib/gc/__tests__/workspace-reconciler.test.ts` and
    integration test, plus existing shared-orphan recovery tests.
  - **Change:** add failing cases for exact v2 reconstruction, ambiguous v1/run
    hold, missing-run grace, canonical common-dir parent derivation, final
    re-check, DB row appearing between discovery/action, live supervisor
    session, Git registration mismatch, malformed/conflicting provenance,
    outside-root, symlink escape, rescue-ref collision/CAS, preserve/remove
    failures, and shared recovery ordering.
  - **Logging:** assert quarantine/retry reason codes and summary counts; never
    assert raw file content.
  - **Tests:** pure injected unit lane plus real Git/Postgres integration lane.
  - **Acceptance:** every autonomous-delete gate has one negative regression;
    ambiguous existing-run observations are held rather than adopted; the
    historical disk-only shape is reportable without deletion.

- [ ] **Task 22: GREEN — implement report-first reconciliation and safe rescue/prune.**
  - **Files:** new focused modules under `web/lib/gc/` for enumeration,
    classification, finding persistence, rescue, and action; reuse
    `readMaisterProvenance`, Git worktree helpers, and `removeOwnedWorktree`.
  - **Change:** enumerate root-contained Git worktrees, derive/verify parent Git
    common-dir registration, run shared recovery first, upsert observations,
    reconstruct only exact rows, hold ambiguous live rows, wait the existing GC
    age for missing-run v2 candidates, re-check under a renewable claim,
    snapshot dirty/untracked state, CAS-create and persist
    `maister/orphan/<findingId>/<runId>` plus commit, then remove. Unknown/v1-only
    disk candidates stay quarantined. Each item completes independently.
  - **Logging:** one scan summary and structured action/failure records keyed by
    finding ID; root-relative paths only; report quarantine without spamming
    every tick after state is unchanged.
  - **Tests:** make Task 21 green, including more-than-batch-size progress and
    retry/quarantine scheduling.
  - **Acceptance:** no code path can auto-delete on provenance alone; all eight
    gates are repeated immediately before removal.

- [ ] **Task 23: REFACTOR — separate inventory, decision, evidence, and action.**
  - **Files:** modules introduced by Tasks 20-22.
  - **Change:** keep enumeration/read-only evidence, pure classification,
    finding persistence, Git rescue, and removal execution as separate typed
    units. Deduplicate canonical path/Git registration checks with row-backed
    removal without weakening either caller.
  - **Logging:** retain one scan summary and one changed action/failure record;
    unchanged quarantine is not repeatedly logged at INFO/WARN.
  - **Tests:** rerun Tasks 19-22 and full unit/integration suites.
  - **Acceptance:** no module both decides trust and performs deletion, all
    behavior remains green, and unsafe evidence cannot be converted into an
    arbitrary path operation.

**Phase 4 exit gate**

```bash
pnpm --filter maister-web db:generate
pnpm --filter maister-web db:check
pnpm --filter maister-web exec vitest run --project unit lib/db/__tests__/migration-journal-integrity.test.ts lib/__tests__/worktree-provenance-v2.test.ts lib/gc/__tests__/workspace-reconciler.test.ts
pnpm --filter maister-web exec vitest run --project integration lib/db/__tests__/check-migrations.integration.test.ts lib/db/__tests__/schema.integration.test.ts lib/gc/__tests__/workspace-reconciler.integration.test.ts lib/__tests__/reconcile-orphan-shared-tree.integration.test.ts
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration
pnpm --filter maister-web typecheck
```

### Phase 5 — One cleanup owner and truthful scheduler telemetry

- [ ] **Task 24: RED — prove singleton ownership, lease renewal, and summary persistence.**
  - **Files:** `web/lib/__tests__/instrumentation.test.ts`,
    `web/lib/scheduler/__tests__/system-sweeps.test.ts`, scheduler job/tick
    integration tests, and `/api/cron/gc` compatibility tests.
  - **Change:** inventory every instrumentation timer, then add failing
    assertions that no retained timer duplicates a system-sweep service;
    timer/tick/immediate compatibility calls contend on one claim; the winner
    renews its lease; the loser returns `alreadyRunning`; a stale owner cannot
    persist summary; each service runs once; item failures remain in summary;
    bundle failure marks the attempt failed; the returned summary is persisted.
  - **Logging:** assert exactly one bundle start/completion pair per winning
    attempt and one concise loser/claimed event.
  - **Tests:** unit wiring plus real DB claim integration.
  - **Acceptance:** RED exposes the legacy timer and empty scheduler summary.

- [ ] **Task 25: GREEN — route all periodic cleanup through one claimed system sweep.**
  - **Files:** `web/instrumentation.ts`, `web/lib/gc/sweeper.ts`,
    `web/lib/instance-config.ts`, `web/lib/scheduler/system-sweeps.ts`,
    `web/lib/scheduler/tick-service.ts`, `/api/cron/gc`, `.env.example`, and
    relevant tests.
  - **Change:** remove legacy GC timer/config and either remove duplicated
    keepalive/reconcile timers or document/test a genuinely disjoint remainder.
    Compose reconcile → row-backed GC → orphan reconcile → reconstructible
    cleanup in the canonical bundle. Implement `requestSystemSweep` so timer,
    cron tick, and `/api/cron/gc` force/request and claim the same canonical job,
    renew one lease, execute through `runClaimedJob`, and persist the detailed
    returned summary. Keep external cron and fallback timer availability.
  - **Logging:** bundle summary includes per-service counts/durations and
    sanitized error codes; no duplicate service-level success messages at info
    if the bundle summary already carries them.
  - **Tests:** make Task 24 green and verify `/api/cron/gc` preserves immediate
    compatibility semantics while sharing ownership. The exact production
    wiring-seam gate is
    `pnpm --filter maister-web exec vitest run --project integration lib/scheduler/__tests__/workspace-cleanup-wiring.integration.test.ts`,
    which must invoke the real `runSchedulerTick({jobKind:"system_sweep"})`
    path.
  - **Acceptance:** grep finds no `startGcSweeper` startup and no read of
    `MAISTER_GC_SWEEP_INTERVAL_SECONDS`; every periodic cleanup service has one
    owner; no direct `runGcBundle` compatibility bypass remains.

- [ ] **Task 26: REFACTOR — make scheduler ownership and summaries single-source.**
  - **Files:** scheduler job claim/request, tick dispatch, system-sweep
    composition, compatibility route, instrumentation, and summary types.
  - **Change:** remove duplicate claim/summary paths, keep one typed attempt
    executor and heartbeat helper, and preserve service-level isolation without
    catch-all success. Avoid a special compatibility execution mode inside the
    bundle; compatibility changes only how the canonical job is made due.
  - **Logging:** one winning start/completion and one concise contention event;
    no duplicate healthy service INFO logs.
  - **Tests:** rerun Tasks 24-25 and full unit/integration suites.
  - **Acceptance:** all entry points share one ownership/result implementation,
    lease fencing remains green, and SOLID/KISS/DRY review finds no parallel
    scheduler state machine.

**Phase 5 exit gate**

```bash
pnpm --filter maister-web exec vitest run --project unit lib/__tests__/instrumentation.test.ts lib/scheduler/__tests__/system-sweeps.test.ts app/api/cron/gc/__tests__/compat.test.ts
pnpm --filter maister-web exec vitest run --project integration app/api/cron/gc/__tests__/route.integration.test.ts lib/scheduler/__tests__/jobs.integration.test.ts
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration
pnpm --filter maister-web typecheck
```

### Phase 6 — Read models, API, and user surfaces

- [ ] **Task 27: RED — encode route, fan-out, removed-history, and user journeys.**
  - **Files:** board/launchability unit tests; portfolio, project, board,
    run-list, run-detail, active-workspace, scheduled dispatch, C2,
    launch-options, manual launch, and budget-restart integration tests;
    affected direct-action route tests; admin findings route/read-model/panel
    tests; lifecycle DOM and EN/RU parity tests; the three focused Playwright
    journeys from the Test Ownership Matrix.
  - **Change:** add failing cases for archived `Review`/`Crashed`, Failed,
    active-workspace removal, history retention, no Git reads after removal,
    every launchability caller, direct server refusal for Recover/HITL/gate
    chat/takeover/rework/export/diff/promotion, exact DTO/error/replay,
    disabled actions, clean archive, agent combined actions, immediate
    compatibility result, bounded/redacted admin findings, and localized copy.
  - **Logging:** query/UI tests prove no worktree access for
    `removed_at!=NULL`; routes audit only server-derived identifiers.
  - **Tests:** unit pure classifiers, Postgres read-model/route integration,
    node-environment DOM, locale parity, and only three E2E journeys.
  - **Acceptance:** RED shows current board/launchability stranding and old
    Archive copy; lower-level matrices remain in their focused integration
    owners rather than being copied into E2E.

- [ ] **Task 28: GREEN — align all run-kind surfaces and exact route contracts.**
  - **Files:** `web/lib/board.ts`, `web/lib/runs/launchability.ts`,
    `web/lib/queries/{portfolio,project,board,run,runs-list}.ts`, scheduler
    C2/dispatch/launch-options/manual/budget-restart callers, shared lifecycle
    action component, Flow/scratch/agent layouts/inspector, affected direct
    action routes/DTOs, admin findings query/route/scheduler panel, and
    `web/messages/{en,ru}.json`.
  - **Change:** thread workspace presence through every classifier caller,
    retain history, render removed state without Git access, repeat server
    guards, expose exact allowed actions, return the shared lifecycle DTO, and
    update confirmations. Add the platform-admin-only read-only findings
    drill-down with cursor/limit/state validation and root-relative display.
    Keep Archive and Drop visually/verbally distinct.
  - **Logging:** route success/failure audit fields include action/result;
    client logging remains free of paths and archive contents.
  - **Tests:** make Task 27 green; update every old Archive-keeps-worktree
    assertion rather than deleting it.
  - **Acceptance:** every read model/caller agrees on active workspace vs
    historical run, direct routes fail safely, exact OpenAPI examples match,
    and EN/RU ship together.

- [ ] **Task 29: REFACTOR — consolidate workspace-presence policy and lifecycle DTOs.**
  - **Files:** launchability/read-model helpers, action policy, route response
    builders, UI components, and locale keys touched by Tasks 27-28.
  - **Change:** retain one workspace-presence input model, one exhaustive
    lifecycle response builder, and shared localized removed-state primitives.
    Remove repeated status/string branching without coupling server policy to
    React.
  - **Logging:** preserve route audit vocabulary; client emits no paths/content.
  - **Tests:** rerun Task 27 focused tests, the three E2E journeys, contract
    validation, and full unit/integration suites.
  - **Acceptance:** behavior/contracts remain green, every classifier call
    supplies workspace presence, and no DTO copy can drift from OpenAPI.

**Phase 6 exit gate**

```bash
pnpm --filter maister-web exec vitest run --project unit lib/__tests__/board.test.ts lib/runs/__tests__/launchability.test.ts lib/runs/__tests__/inspector-actions.test.ts
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration
pnpm --filter maister-web typecheck
pnpm validate:contracts
```

### Phase 7 — End-to-end proof and as-built reconciliation

- [ ] **Task 30: VERIFY — prove the three user journeys and failure-safe harness.**
  - **Files:** the three Task 27 Playwright journeys, migrated relevant portions
    of `web/e2e/m19-reconcile-gc.spec.ts` and
    `web/e2e/m27-workbench-lifecycle.spec.ts`, `AUTHED_SPEC`, and E2E wrapper
    tests.
  - **Change:** verify only: (1) parked/live Archive including retained history
    and relaunchability, (2) Drop/Discard including exact response/status, and
    (3) automatic orphan reconciliation plus admin summary. Assert real
    filesystem, DB, Git-ref, UI, and test-root cleanup. Verify normal and live
    Playwright configurations allocate isolated roots and teardown on success,
    failure, SIGINT, and SIGTERM. Do not reproduce complete status, lease,
    shared-sibling, or retry matrices here.
  - **Logging:** capture only structured test/sweep summaries; traces must not
    be used as the sole proof of filesystem cleanup.
  - **Tests:** run the three normal Playwright journeys; list/smoke the live
    config and run its harness cleanup tests; keep low-level failure injection
    in integration suites.
  - **Acceptance:** the three journeys prove the contract through UI/API and on
    disk, all prior RED suites remain green, and no test writes the default user
    root.

- [ ] **Task 31: Reconcile specs to the implementation and run the renumber pass.**
  - **Files:** every document in the Contract Surface Map, `docs/decisions.md`,
    both migration triples, `.env.example`, `CLAUDE.md`, `web/CLAUDE.md`,
    `.ai-factory/DESCRIPTION.md`, `README.md`, `docs/architecture.md`, and
    touched screen/API examples.
  - **Change:** compare code, schema, tests, API examples, EN/RU copy, analytics,
    and screen docs; replace `Designed` with `Implemented` only where shipped;
    correct stale 7-day/runtime-root/timer/archive wording; explicitly supersede
    old ADR-034/035 and M19/M27 semantics where they changed; rebase and
    renumber ADR/migrations atomically if required.
  - **Logging:** document final summary field names and operational remediation
    for retry/quarantine; do not add a changelog-style duplicate narrative.
  - **Tests:** full unit/integration/E2E/type/contract/doc/migration gates plus
    targeted greps for removed config and stale Archive copy.
  - **Acceptance:** no logical hole remains between status policy, filesystem
    behavior, DB state, scheduler wiring, UI, tests, and docs. JSONL behavior is
    explicitly unchanged everywhere.

**Phase 7 exit gate**

```bash
pnpm --filter maister-web test:e2e -- e2e/m19-reconcile-gc.spec.ts e2e/m27-workbench-lifecycle.spec.ts
pnpm --filter maister-web exec playwright test --config playwright.live.config.ts --list
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration
pnpm --filter maister-web typecheck
pnpm --filter maister-web db:check
pnpm validate:contracts
pnpm validate:docs:all
pnpm validate:docs:adr:all
```

## Full-Suite Integrity Rules

- Every new test file must be confirmed by `vitest list` or Playwright list
  before its first commit.
- Each phase ends with the full web unit and integration suites green, not only
  focused tests.
- Existing assertions that encode the old Archive-keeps-worktree contract are
  migrated in the same phase as the behavior change.
- A pre-existing/harness-limited red test must be explicitly quarantined with a
  reason and tracked follow-up; it may not be silently tolerated, deleted, or
  hidden by `passWithNoTests`.
- Real Git tests must verify both the directory absence and recoverability from
  the archive ref.
- Failure-injection tests must inspect DB state, lifecycle claim state,
  filesystem state, and retry result at each crash window.
- Each implementation slice records a focused RED assertion, reaches GREEN with
  the minimum production change, then passes a behavior-preserving REFACTOR
  task before its phase checkpoint. RED is never committed or hidden.
- Test ownership follows the non-overlap matrix; E2E is limited to the three
  named journeys and does not duplicate integration truth tables.

## Final Definition of Done

- SDD artifacts, ADR, API, DB schema/ERD, configuration, and screen contracts
  describe one internally consistent lifecycle.
- The implementation passes the protected/disposable status matrix for Flow,
  scratch, own-agent, and shared-agent workspaces.
- All row-backed removal paths use the same durable claim and converge after
  process death; completed disposition makes replay exact and conflicting
  intent detectable.
- Disk-only managed worktrees make bounded progress through recover, grace,
  rescue/prune, retry, or quarantine; provenance v2 participates in proof,
  legacy/ambiguous paths are never deleted, and rescue refs cannot overwrite
  prior evidence.
- `system_sweep` is the only periodic owner and its persisted summary explains
  what happened; leases renew and stale owners cannot persist success.
- Platform admins can inspect redacted finding/quarantine details through the
  read-only bounded API/UI; no cleanup/re-arm mutation is introduced.
- Tests cannot create or leave worktrees in the user's default root.
- Runs and their historical evidence remain visible after workspace removal.
- Runtime JSONL retention remains untouched and is ready for a separate future
  design if/when the product needs it.
