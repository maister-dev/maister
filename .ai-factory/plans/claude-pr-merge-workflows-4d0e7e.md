# Implementation Plan: PR lifecycle tracking + branch sync with AI conflict resolver

Branch: `claude/pr-merge-workflows-4d0e7e` (implementation branch)
Created: 2026-07-14 · Refined: 2026-07-14 (SDD/TDD hardening + codebase re-verification)

## Settings

- Testing: yes — TDD, RED → GREEN → REFACTOR per task; no trivial tests, no
  duplicated happy paths across suites.
- Logging: verbose — structured events with ids only; never log prompts,
  diffs, conflict hunks, tokens, or provider payloads.
- Docs: yes — the analytics/contract checkpoint (Phase 0) is mandatory before
  code starts and each later phase keeps its affected contracts current.

## SDD delivery rule

This is a specification-driven delivery. Tasks 1–2 produce the authoritative
delta before any production code: ADR-137/ADR-138 own the irreversible
choices; the OpenAPI/AsyncAPI files own the wire; the system-analytics, DB,
and screens documents own lifecycle, invariants, persistence, and surface.
No code task may start until its RED tests cite the corresponding contract
section and the Task-2 spec gate is green. During implementation every new
contract stays `Designed`; **Task 19** flips to `Implemented` only after the
matching GREEN tests and the as-built review pass (Task 20 is the closing
verification gate over the whole diff).

## Roadmap Linkage

Milestone: "M20. Dogfood + external validation"

Rationale: M20 requires shipping non-trivial PRs end-to-end through MAIster.
Today the PR loop ends at "PR opened" (`Done`, `workspaces.pr_state` never
recorded) with no merge/conflict visibility and no recovery path when the
target branch moves; the `ai_rebase_merge` promotion mode exists but is a
no-op (collapses to plain `rebase_merge`). This plan closes that loop: PR
state tracking, target sync, agent-driven conflict resolution, and a
resolver-backed `ai_rebase_merge`.

## Goal and scope

Two features on the run-finishing path, built on the shipped ADR-049/ADR-058/
ADR-087 promotion substrate and the shipped ADR-134 delivery scanner:

**A. PR lifecycle tracking.** A per-project scheduler job polls the provider
state of every MAIster-created PR (`workspaces.pr_url`) through the existing
`gh`/`glab`/Gitea-REST adapter family, persists
`open | merged | closed` + a conflicts flag on `workspaces`, records the
**PR-provider merge commit** in `workspaces.pr_merge_commit_sha`
(provider provenance, distinct from `runs.merge_commit_sha`), emits a
`run.pr_merged` webhook and a `run_pr_merged` task-activity entry on the
merge edge, and surfaces state chips on the run detail and task card.
Bitbucket stays out (deferred tech debt, see below). **`runs.merge_commit_sha`
is NOT written by this scan** — target-branch delivery provenance remains
owned by the shipped `repo_delivery_scan` (ADR-134); see decision 4.

**B. Branch sync + AI conflict resolver (+ resolver-backed `ai_rebase_merge`).**
A manual, operator-launched run operation "sync with target" for `Review` runs
(and, via **reopen**, for `Done` runs whose open PR conflicts): fetch origin,
fast-forward the local target, rebase (default; merge optional) the run branch
onto the target inside the run's worktree, force-with-lease push (with an
explicit expected-SHA lease) when the branch is published, and — on conflict —
launch a fresh ACP resolver session in that same worktree under a separate
configurable runner, with worktree-mutating operations blocked while it works.
Entry points: ReviewPanel sync button, target-drift card, `merge_conflict`
assignment, PR-conflict badge. The same rebase+resolver **core** also backs the
existing `ai_rebase_merge` promotion mode (decision 19), which stops being a
no-op. Ext API + MCP facade coverage ships in the same plan.

### Explicitly excluded from this plan

- **Bitbucket (Cloud and Server/Data Center)** PR adapter — recorded as
  deferred tech debt in ADR-137 with the agreed shape: one REST adapter
  family with configurable API base to cover both editions.
- PR auto-merge / "PR-automerger agent" (ADR-126 Phase-2 note stands), PR
  review-comment ingestion into rework, and any automatic (trigger-driven)
  resolver launch — resolver launch stays manual by design (choosing
  `ai_rebase_merge` promotion mode is itself the explicit, conscious opt-in).
- New domain-event kinds (webhook events only; the `domain_events` kind CHECK
  is untouched).
- Sync/reopen for scratch runs, shared-tree runs (`runs.workspace_mode =
  'shared'`), experiment members, and orchestrator children (`parent_run_id`
  set) — refused with typed `PRECONDITION` in v1.
- Resolver-session reattach after a web restart (v1 recovery is
  deterministic abort; see crash windows).
- No new environment variables, ports, binaries, or container wiring:
  `Dockerfile`, `compose*.yml`, and `.env.example` stay untouched. Cadences
  and caps are code constants; `gh`/`glab` are already host tools probed by
  `instance-config.ts` (`probeTool`).

## Codebase preconditions verified 2026-07-14 (implementer must re-confirm at RED)

These are the load-bearing facts every task builds on; each was checked
against branch HEAD. Where the pre-refinement plan drifted, the correct value
is stated here and threaded into the tasks/decisions below.

- **`runs.acp_session_id` no longer exists** — dropped in M42 (ADR-114,
  migration 0082). The flow's session identity is now its `run_sessions`
  row(s) (`run_sessions.acp_session_id`, unique `(run_id, session_name)`).
  Every "session handle" reference is `run_sessions`, not a `runs` column.
- **The promotion_state FOR-UPDATE fence is caller-side.**
  `markReworkFromReview` (`web/lib/runs/state-transitions.ts:287`) is a bare
  status-guard CAS; the fence lives in the caller `reworkChildRun`
  (`web/lib/agents/launch.ts:2638-2681`, loader
  `loadOwnWorkspacePromotionStateForUpdate:2570-2581`, refuses
  `promotion_state ∈ {claiming, done}`). There is **no** `web/lib/runs/launch.ts`.
- **`promotion_state` is plain `text` (schema.ts:1997, default `'none'`), no
  PG CHECK, no central union type.** Values (`none|claiming|done|failed`) are
  scattered string literals in `promote.ts`, `scheduler/handlers/auto-promote.ts`,
  `agents/launch.ts`. Adding `'reopened'` is app-level (no `ALTER TYPE`) but
  touches all three.
- **`lifecycle_operation_name` is plain `text` (schema.ts:2019), no CHECK,**
  values `archive|drop|exportBranch|snapshotCommit|handoffBranch`
  (`web/lib/workbench-lifecycle/service.ts:65-70`). `"sync"` is a TS-only 6th value.
- **`workspace_mode` is on `runs`** (`runs.workspace_mode`, enum `own|shared`,
  schema.ts:1589), NOT on `workspaces`.
- **`task_activity.kind` is `event_kind`** (const `TASK_ACTIVITY_EVENT_KINDS`,
  schema.ts:4034-4046), and the same const drives **two** CHECKs:
  `task_activity_event_kind_check` (:4087) and `inbox_items_event_kind_check`
  (:4162). Adding `run_pr_merged` expands both (pattern: `0090_experiments.sql`).
- **`projects.id` and `platform_acp_runners.id` are `text`** → `sync_runner_id`
  is `text`, not `uuid`. Mirror `flowRevisions.defaultRunnerId` (schema.ts:385,
  `.references(() => platformAcpRunners.id, { onDelete: "set null" })`), NOT
  `projects.default_runner_id` (plain text, no FK).
- **`runs.merge_commit_sha` already has a writer**: local_merge
  (`promote.ts:1072/1084`) + the `repo_delivery_scan` handler
  (`repo-delivery-scan.ts:483`, stamps `targetSha`, ADR-134, migration 0098).
  This scan is the delivery-provenance owner; the PR scan must not co-write it.
- **`resolveRunner` has no sync tier** — fixed 6-tier literal
  (`acp-runners/resolve.ts:261-274`). A resolver tier must be added.
  `defaultRunSessionValues` (:304) hard-codes `sessionName:"default"` (value +
  literal type) — a `sync-<n>` name needs an override/param.
- **The scratch driver spans two layers.**
  `sendScratchPromptAndProjectEvents` (`scratch-runs/events.ts:705`) is
  prompt/stream/HITL only; `createSession`/`deleteSession` are in
  `scratch-runs/service.ts` (:1075/:2375) → `@/lib/supervisor-client`
  (`createSession:614`, `deleteSession:638`, `sendPrompt:708`); the
  `NeedsInput→Running` flip is the HITL-respond route.
- **`ai_rebase_merge` promotion mode already exists** (`layout.tsx:159`,
  `review-panel.tsx:424`) as a no-op delivery strategy (collapses to
  `rebase_merge`). Decision 19 makes it resolver-backed.
- **`merge_conflict` has no dedicated card** — it is an `assignments.actionKind`
  value (schema.ts:2824), created on local-merge conflict (`promote.ts:210/240`),
  rendered only via the generic assignment surface (`inbox/hitl-card.tsx`,
  `board/assignment-actions.tsx`, raw text in `board/run-timeline.tsx:316`),
  with no i18n label. Task 16 wires a kind-specific branch + EN/RU labels.
- **The PR chip target is `flight-card.tsx`** (renders OnReview/InDelivery/Done);
  `task-card.tsx` is Backlog-only.
- **`pnpm validate:docs` already runs the ADR-anchor validator**
  (`package.json:9` = mermaid + `validate-docs-adr-anchors.mjs`); it is one
  gate, not two. `error-taxonomy.md` is one row per code (extend the
  "Where thrown" cell, do not add rows).

## Resolved design decisions

1. **PR facts stay on `workspaces`** (no new `pull_requests` table),
   extending the existing `pr_url`(text)/`pr_number`(integer) pair: `pr_state`
   (`open|merged|closed`, NULL = never checked), `pr_has_conflicts`
   (boolean, NULL = unknown), `pr_merged_at`, `pr_merge_commit_sha`
   (**PR-provider merge commit — provenance only, NOT `runs.merge_commit_sha`**),
   `pr_state_checked_at`. No backfill: existing PR rows keep NULL state and are
   picked up by the first scan (no guessed mapping — migration rule).
2. **`pr_state_scan` is a per-project scheduler jobKind** following the
   `repo_delivery_scan` seeding pattern (`ensureRepoDeliveryScanJobs`,
   `web/lib/scheduler/jobs.ts:380-419`, invoked from `ensureDefaultSchedulerJobs`
   at `:372` every tick — NOT a registration path), NOT a global singleton.
   Cadence: code constant `PR_STATE_SCAN_CADENCE_SECONDS = 300`. Keyset cursor
   in `scheduler_jobs.target->'cursor'` (the **auto_promote** idiom,
   `handlers/auto-promote.ts:250` read / `:266` write — `repo_delivery_scan`
   has no cursor, so the handler is a hybrid). Candidates: project workspaces
   with `pr_url IS NOT NULL AND (pr_state IS NULL OR pr_state='open')`. Progress
   guarantee: `pr_state_checked_at` is stamped on EVERY attempt, success or
   failure. **Registration is the full fan-out** (decision 2a below), not a
   single union edit.

   2a. **Every `pr_state_scan` registration site** (the enumerated consumer set;
   `repo_delivery_scan` is the template except where noted):
   `SchedulerJobKind` union (`schema.ts:647`) **+ `schedulerJobs.jobKind` enum
   (`:672-684`) + `schedulerJobRuns.jobKind` enum (`:733-745`)** — three schema
   edits or inserts won't compile; `job-catalog.ts`
   (`ALL_SCHEDULER_JOB_KINDS`, `SCHEDULER_JOB_KIND_CATALOG` with
   `creatable:false, systemManaged:true`; **absent** from `SEEDED_SINGLETON_IDS`
   — per-project); `budgets.ts` (union :3-13, `SchedulerBudgetLimits` type
   :15-26, `schedulerBudgetLimits()` :50); **`schedulerBudgetForKind` switch in
   `jobs.ts:136-161`** (NOT budgets.ts; exhaustive, no default → TS enforces);
   `claimDueJobs` CTE 4 spots (`jobs.ts:460-522`); `ensurePrStateScanJobs` +
   `disableArchivedPrStateScanJobs` wired into `ensureDefaultSchedulerJobs`
   (`jobs.ts:372`); dispatch case in `tick-service.ts:88` **plus the
   PRECONDITION-is-Failed-not-Skipped catch special-case at `:206-209`** if
   poison-consumes-budget semantics are wanted; `job-admin-schema.ts` — NOT
   touched (non-creatable); admin UI is data-driven off `FILTERABLE` +
   `t(kind.*)` (no hardcoded list); i18n `adminScheduler.kind.pr_state_scan`
   EN+RU (`messages/{en,ru}.json:2778`). Handler
   `web/lib/scheduler/handlers/pr-state-scan.ts`.
3. **Provider reads extend the existing adapter family**
   (`web/lib/runs/pr-adapter.ts`): a `getPrState` capability for the **4 real
   providers** — `github` (`gh pr view --json
   state,mergedAt,mergeCommit,mergeable,mergeStateStatus`), `gitlab`
   (`glab mr view`: `state`, `has_conflicts`/`detailed_merge_status`),
   `gitea`/`gitverse` (REST: `state`, `merged`, `mergeable`). **`generic` is
   not an adapter** — `selectPrAdapter` throws `PRECONDITION` for it; `getPrState`
   mirrors that as a typed per-item skip (never a job failure). Note the current
   `createOrUpdatePr` fallback is **open-PR-only** and cannot report merge state
   — that is exactly the gap `getPrState` fills. CI mocks the provider boundary
   (git-integration.md convention). Missing CLI/token → per-item skip with
   reason, never a job-failure spiral.
4. **On each detected PR-state edge**, in ONE edge-guarded transaction per edge
   (previous `pr_state`/`pr_has_conflicts` is the guard → exactly-once across
   re-scans; the webhook emit is a transactional outbox insert). Three edges,
   three webhook types (owner decision 2026-07-14: add closed + conflict events):
   - **merged** (`pr_state ∈ {NULL, open}` → `merged`): set `pr_state='merged'`,
     `pr_merged_at`, `pr_merge_commit_sha` (provider mergeCommit); emit
     `run.pr_merged`; write `task_activity` `event_kind='run_pr_merged'` on the
     run's task.
   - **closed-unmerged** (`→ closed`): set `pr_state='closed'`; emit `run.pr_closed`.
   - **conflicts detected** (`pr_has_conflicts` NULL/false → true): set
     `pr_has_conflicts=true`; emit `run.pr_conflicts`; surface the UI badge +
     reopen entry point (no assignment v1).
   All three webhook types are TS taxonomy + AsyncAPI only (`webhook_events.type`
   has no DB CHECK — no migration). `task_activity` stays merged-only (closed/
   conflict surface via chip + webhook, not the board feed). **`runs.merge_commit_sha`
   is NOT touched here** — target-branch delivery provenance stays owned by the
   shipped `repo_delivery_scan` (ADR-134), which already stamps it from target
   reachability; a provider "merged" flag is not proof the commit is on the local
   target, and a second writer would race the scanner (owner decision 2026-07-14:
   split — PR-sha on `workspaces` only). The scan is purely programmatic (provider
   CLI/REST) — it spends zero LLM/agent tokens and NEVER calls the supervisor
   client or launches a session (asserted by test, FR-A5); conflict detection only
   raises the alarm surface (chip/badge + webhook); the resolver is launched
   exclusively by an explicit user click.
5. **Sync is a lifecycle operation** — 6th `LifecycleOperationName` value
   `"sync"` (TS-only; the column has no CHECK) claiming the existing
   `lifecycle_operation_*` slot on `workspaces` (mutual exclusion with
   `archive/drop/exportBranch/snapshotCommit/handoffBranch` for free). Because
   promotion and lifecycle claims do NOT cross-guard today (verified —
   `promoteRun`'s claim never inspects `lifecycle_operation_name`; only a shared
   `FOR UPDATE` workspace row-lock serializes them), this plan adds the
   **explicit double fence**: the sync claim tx refuses when
   `promotion_state ∈ {claiming, done}` (unless reopened), and `promoteRun`'s
   claim tx (`promote.ts:733-753`) refuses when an active
   `lifecycle_operation_name='sync'` claim exists. Both directions get matrix
   tests; the shared-slot ops are covered by ONE representative (mutual
   exclusion is structural), the cross-column sync↔promote fence fully (both
   directions).
6. **Sync pipeline** (service `web/lib/runs/sync-target.ts`):
   `fetchRemote(origin, <target-refspec>)` **scoped to the target ref** (so the
   run branch's remote-tracking ref is NOT refreshed — see decision 11) when a
   remote exists → fast-forward the LOCAL target branch from `origin/<target>`
   (non-FF divergence → typed `PRECONDITION` with both SHAs; dirty parent repo
   for a checked-out target → `PRECONDITION`) → compute ahead/behind → no-op
   success when behind=0 → strategy attempt in the WORKTREE: `rebase` (default)
   or `merge` per `projects.sync_strategy_default` / per-invocation override →
   clean → verification → conditional push → finalize. Eligibility allow-list:
   `runs.status='Review'`, `run_kind ∈ {flow, agent}`, `parent_run_id IS NULL`,
   `runs.workspace_mode <> 'shared'`, not an experiment member. Dirty worktree →
   refuse with hint to snapshot-commit first.
7. **Conflict + agent path**: leave the conflicted rebase/merge state in place
   (conflict hunks materialized); add `markSyncFromReview` in
   `state-transitions.ts` (a bare `Review→Running` CAS, mirroring
   `markReworkFromReview:287`) **behind a new caller-side FOR-UPDATE fence that
   mirrors `reworkChildRun` (`agents/launch.ts:2638-2681`)** — the CAS fn does
   not own the fence. `runs` has no `acp_session_id` to touch; the flow's
   session identity is its existing `run_sessions` row(s). Spawn a **fresh** ACP
   session (never resume) with `cwd=<worktree>`, recorded as a NEW
   `run_sessions` row `sessionName='sync-<attempt>'`. Because
   `defaultRunSessionValues` (`acp-runners/resolve.ts:304`) hard-codes
   `sessionName:"default"`, build the row via spread-override (or extend the
   helper with a `sessionName` param); the `(run_id, session_name)` unique key
   lets `sync-<n>` coexist with the flow's `default` session.
8. **Resolver runner chain**: `resolveRunner` has no sync tier today (fixed
   6-tier literal). Add a sync-scoped resolution: launch override →
   `projects.sync_runner_id` (new nullable **text** FK) → project default →
   platform default, with flow tiers null (scratch pattern,
   `scratch-runs/service.ts:321-344`). Either insert a dedicated tier or route
   `sync_runner_id` through a slot that records the correct
   `runner_resolution_tier` label (do not mislabel it as `stepTarget`). The
   resolved snapshot persists on the `run_sessions` row and
   `run_sync_attempts.runner_id` — the terminal path reads the snapshot, never
   re-resolves.
9. **Resolver driver** composes the two scratch layers explicitly: service-layer
   `createSession(cwd=worktree, runner=snapshot)` (`@/lib/supervisor-client:614`)
   → the scratch-style SSE consumer (mirrors `sendScratchPromptAndProjectEvents`,
   `scratch-runs/events.ts:705` — `session.permission_request` → persisted
   `hitl_requests` row + `NeedsInput`; the `NeedsInput→Running` flip is owned by
   the HITL-respond route, NOT the driver) → blocking `sendPrompt` → `stopReason`.
   Prompt template (fixed, English) carries target ref, strategy,
   `git diff --name-only --diff-filter=U` list, the task title/prompt for intent
   (null-safe for taskless agent runs), and explicit prohibitions: complete the
   rebase/merge, resolve preserving both intents, leave a clean tree, do NOT
   push, do NOT touch unrelated files. **The agent never pushes; the web side
   pushes after verification.**
10. **Verification gate** (web-side, mechanical, after the turn): no
    rebase/merge in progress (`.git` sequencer state absent), working tree
    clean, **`git diff --check` reports zero conflict markers across the whole
    worktree** (not only files changed vs pre-sync HEAD — the agent could paste
    a marker anywhere), target SHA is an ancestor of the new HEAD. Pass →
    push/finalize. Fail → abort (`git rebase --abort` / `merge --abort`,
    restoring the pre-sync SHA recorded in the attempt row), attempt `failed`,
    CAS `Running→Review`. **`agent=false` + conflict** never leaves a conflicted
    tree: abort immediately, restore the pre-sync SHA, return `outcome:'conflict'`
    (no change) so the operator can retry with the agent.
11. **Push policy**: auto-push `--force-with-lease` when `pr_url` is set OR the
    branch has an upstream; otherwise no push. Per-invocation `push` override.
    **Lease safety**: capture the run branch's remote SHA BEFORE the (target-scoped)
    fetch and push `--force-with-lease=refs/heads/<branch>:<captured-remote-sha>`
    — a bare `--force-with-lease` after any fetch that touched
    `origin/<branch>` would lease against the refreshed value and pass even when
    the branch moved (the footgun). Lease failure (branch moved remotely) →
    attempt `failed`, typed `CONFLICT` with both SHAs.
12. **`run_sync_attempts` append-only ledger** (`node_attempts`-shaped: a single
    plain-`text` `phase` column — the lifecycle column, includes terminal
    outcomes — with a TS-only enum, no DB CHECK; NO separate `status` column
    (Task-2 gate: `phase` alone is sufficient): `(run_id, attempt)` UNIQUE;
    `strategy`, `mode`
    (`mechanical|agent`), durable `phase`
    (`starting → rebasing → agent_running → verifying → pushing →
    succeeded | failed | aborted`) written BEFORE each side effect;
    `target_ref`, `target_sha`, `head_sha_before/after`, `remote_sha_before`
    (for the lease), `conflicted_files` jsonb, `runner_id`, `session_name`,
    `agent_running_since` (for the active-time duration cap, decision 16),
    `auto_finalize` (bool, the `ai_rebase_merge` toggle, decision 19), `pushed`,
    `error_code/message`, actor, timestamps. **The attempt-number
    allocation (`max(attempt)+1`), the `starting` row insert, the lifecycle
    `"sync"` claim, and (agent path) the `markSyncFromReview` CAS are ONE
    transaction** — the claim serializes concurrent launches so exactly one
    attempt row is allocated (tested: concurrent double-launch → 2nd refused
    `CONFLICT`, one row). This row is also the reconcile/sweep discriminant for
    "this Running run is in sync mode" (plumbed into `ReconcileInput` and the
    Running-sweep candidate queries — decision 16).
13. **Content-changing sync resets `runs.review_entered_at = now()`** (any sync
    that moves HEAD) — re-arms the ADR-126 auto-promotion grace window, which is
    evaluated in `auto-promotion/evaluate.ts:237-245` (Term 16), NOT in the
    auto-promote SQL prefilter (where `review_entered_at` is only the keyset
    ORDER BY). So lane auto-promotion cannot fire the instant a resolver finishes.
14. **Reopen** (`Done → Review`) for top-level (`parent_run_id IS NULL`)
    `flow|agent` runs whose workspace has an open or conflicted PR. `Done` is
    terminal today (no `Done→Review` edge exists) — add a new exact-allow-list
    CAS in `state-transitions.ts`. One tx: CAS `runs.status 'Done'→'Review'`,
    set `workspaces.promotion_state = 'reopened'` (new app-level value; no PG
    CHECK), clear `scheduled_removal_at`, stamp `review_entered_at = now()`,
    emit the `run.review` webhook (reused; no domain event — reopen is top-level
    only, no orchestrator waiter). Fanout: `canReclaim` (`promote.ts:127`,
    currently admits `{none, failed}` + stale `claiming`) admits `'reopened'`;
    the auto-promote SQL prefilter (`handlers/auto-promote.ts:100-160`) adds
    `ne(promotion_state, 'reopened')` to EXCLUDE reopened runs (note: that
    prefilter is already `run_kind='flow'`-only, so agent-run reopen is
    auto-promotion-irrelevant, but the exclusion is added for the flow case and
    documented for agents); the rework fence (`agents/launch.ts:2644`) already
    passes any non-`{claiming,done}` value. If the workspace was GC'd
    (`removed_at` set), re-attach a worktree to the still-existing run branch
    via a new `addWorktreeForBranch` helper (**checks out an EXISTING branch —
    NO `-b`; the existing `addWorktree` always uses `-b` and refuses**; if the
    local branch is gone, fetch and recreate from `origin/<branch>`; if BOTH are
    gone → typed `PRECONDITION`), then clear `removed_at`/`archived_*`.
    Re-promotion in `pull_request` mode reuses `createOrUpdatePr` — it lists open
    PRs and REUSES the same PR (it does not PATCH title/body; commit updates land
    via the pre-call `git push`). Side effects accepted and documented: the task
    card derives back to OnReview (`board.ts` `InDelivery` is a worktree-presence
    approximation); task relations that released on `Done` re-gate dependents —
    honest, because the PR is in fact not merged.
15. **Concurrency**: the agent path holds a slot while `Running`
    (`countLiveRuns`, `scheduler.ts:145`, counts `{Running, NeedsInput,
    HumanWorking}` for the run's `run_kind` pool — so a NeedsInput resolver
    still holds its slot). `Review→Running` for sync reclaims a slot and is
    therefore **cap-gated** (skill-context: slot-freed states reclaiming on
    transition-to-live must be cap-gated): sync launch at cap → typed `CONFLICT`
    "at capacity", no queueing (manual retry). The cap is the run's own kind cap
    (`MAISTER_MAX_CONCURRENT_RUNS` for flow, `MAISTER_MAX_CONCURRENT_AGENTS` for
    agent). Finalize back to `Review` calls `promoteNextPending`
    (`scheduler.ts:470`, the slot-release contract). Mechanical sync never
    changes status and holds no slot.
16. **Keepalive + duration cap**: runs with an active sync attempt are EXCLUDED
    from the **Running-status** sweep candidate queries — `fetchTimeLimitCandidates`
    (`keepalive-sweeper.ts:448`, `status='Running' AND run_kind='flow'`) and
    `fetchBudgetCandidates` (`:786`, `status ∈ {Running, WaitingOnChildren}`) —
    NOT Pass1/Pass2 (which only select `NeedsInput`/`NeedsInputIdle`; a Running
    mid-sync run is invisible to them, so excluding there is a no-op). A
    checkpoint/TTL-abandon of a mid-rebase resolver would abandon a Review-owned
    run. The backstop is a **sync duration cap that counts only active `Running`
    time** (owner decision 2026-07-14 — a flat wall-clock cap would unsafely kill
    a resolver merely waiting on a human): constant `SYNC_ATTEMPT_MAX_MINUTES =
    30` measured from `run_sync_attempts.agent_running_since`, stamped on the
    initial `Review→Running` launch AND **re-stamped on every `NeedsInput→Running`
    HITL resume**. Sweep predicate: `run.status='Running' AND
    attempt.phase='agent_running' AND agent_running_since < now() - 30min`. While
    the resolver waits on a human it is `NeedsInput` (not `Running`), so the cap
    never sees it and human-wait time never counts; each answer resets the
    30-min window. Only 30 min of continuous `Running` with no interaction (a
    genuine runaway) is swept: kill session, abort, fail attempt, return to
    `Review`. Consequence documented: a sync run parked in `NeedsInput` has no
    keepalive auto-idle (excluded above) and holds its slot until the operator
    responds or stops it — an intentional Review-owned pause.
17. **Ext + MCP**: one new scope `runs:sync` in `web/types/token-scopes.ts`
    covering both `POST /api/v1/ext/runs/sync` and
    `POST /api/v1/ext/runs/reopen`. NOT added to `AGENT_TOKEN_SCOPES`
    (token-scopes.ts) NOR `ORCHESTRATOR_TOKEN_SCOPES` (which lives in
    `web/lib/agents/tokens.ts:35`, not token-scopes.ts) — manual-only stance.
    The ext routes are **run-bound** (project derived from the run row via
    `resolveProjectId`, existence-hidden 404 on mismatch). **`runs:sync` MUST map
    `PROJECT_ACTION_BY_SCOPE["runs:sync"] = "promoteRun"`** (member-level),
    mirroring the internal route (FR-B9). `projectActionForScope` returns
    `PROJECT_ACTION_BY_SCOPE[scope] ?? "readBoard"`, so LEAVING it unmapped is an
    authz DOWNGRADE (a viewer-owned token could launch a resolver) — the
    Task-2 gate corrected the pre-refinement "do not add a default" note, which
    was inverted. `scope-contract.test.ts` asserts the `promoteRun` mapping. MCP
    tools `run_sync` + `run_reopen` in `mcp/src/tools.ts` are
    **4-way coupled**: `TOOL_SPECS` + `resolveRouting` (tools.ts) + `TOOL_OP`
    (`tool-contract.test.ts:86`, bijection assert :248) + a real ext OpenAPI
    operation — the facade routes to `/api/v1/ext/...`, so the ext endpoints are
    mandatory. Ext `run_get` DTO (`getRunDTO`, `services/runs.ts:1765`, wire
    schema `operations.openapi.yaml:3008`) gains `prState`/`prHasConflicts`/
    `syncAttempt`; keep field naming aligned (note the pre-existing
    `runnerId`↔`executorId` drift the input-only contract test does not guard).
18. **Error codes**: reuse the existing taxonomy — `PRECONDITION`
    (guards/preflight/divergence/dirty), `CONFLICT` (claims, cap, lease, busy),
    `EXECUTOR_UNAVAILABLE` (supervisor down/spawn), `CRASH` (session crash). No
    new codes; `docs/error-taxonomy.md` gains **cell entries** (one row per
    code — extend "Where thrown", do not add rows) for the new throw sites.
19. **Resolver-backed `ai_rebase_merge`** (owner decision 2026-07-14: "resolver
    implements `ai_rebase_merge`"). The existing no-op mode
    (`review-panel.tsx:424`, collapses to `rebase_merge`) becomes real by
    reusing the sync **rebase+resolver core** (factored out of decisions 6/9/10
    as a shared primitive so there is no duplication — DRY). The mode carries an
    **`autoFinalize` flag** (owner decision 2026-07-14: opt-in via a launch
    checkbox, **default OFF**):
    - **Clean rebase** (either flag value) → finalize promotion exactly as
      `rebase_merge` does today (→ `Done`).
    - **Conflict, `autoFinalize=false`** (default, two-step) → delegate to the
      sync-resolver (run `Review→Running`, agent resolves, web verifies), which
      returns the run to `Review` with the branch cleanly rebased on target; the
      operation surfaces "conflicts resolved — re-promote to finish". The user
      re-promotes; the second attempt is a clean `rebase_merge`.
    - **Conflict, `autoFinalize=true`** (one-click) → same resolver path, and on
      verified resolution the operation **best-effort chains** the finalize: it
      auto-invokes `promoteRun(rebase_merge)` on the now-clean branch → `Done`.
      **If that chained finalize fails or the web dies, the run simply stays in
      `Review` (clean, rebased) — identical to the two-step outcome — so no new
      stuck state and NO new crash window is introduced** (the resolver still
      runs under the sync lifecycle claim, never the promotion claim; the
      auto-finalize is a post-`Review` best-effort step whose failure degrades
      to manual re-promote).
    A plain `rebase_merge` promotion is unchanged. The `autoFinalize` choice is
    persisted on the sync attempt row (decision 12) so the chained finalize reads
    the launch-time decision.

## Trust boundary and failure model

### Route identifier table

| Route/tool | Identifier | Source | Rule |
| --- | --- | --- | --- |
| `POST /api/runs/[runId]/sync` | `runId` | url-param | Session auth + `requireProjectAction(projectId,"promoteRun")`; project derived server-state from the run row. |
| same | `strategy`, `agent`, `push` | body-controlled | Strict zod enums/booleans; no cross-resource meaning. |
| same | `runnerId` | body-controlled | Validated against the platform runner catalog (server-state lookup) before use; unknown → 422. |
| `POST /api/runs/[runId]/reopen` | `runId` | url-param | Same authz; all other state (workspace, PR, branch) derived server-state. Empty body. |
| `POST /api/v1/ext/runs/sync` | `runId` | body-controlled | `handleExt` scope `runs:sync`; run-bound — project derived from the run row via `resolveProjectId`, existence-hidden 404 on mismatch. Same body fields as internal. Scope `runs:sync` maps to `promoteRun` (member) in `PROJECT_ACTION_BY_SCOPE` — mirrors the internal route, never the `readBoard` fallback. |
| `POST /api/v1/ext/runs/reopen` | `runId` | body-controlled | Same rule. |
| `pr_state_scan` job | workspace/PR ids | server-state | No user input; provider URL derived from `project.repo_url ?? readRemoteOrigin`, never from row text. |
| `promoteRun` mode `ai_rebase_merge` | `runId`,`mode` | url-param/server-state | Existing promotion authz; the resolver it may delegate to runs under the sync lifecycle claim (decision 19). |

### Two-phase / failure classification — sync (agent path)

Order of operations: the attempt row (`starting`), the attempt-number
allocation, the lifecycle `"sync"` claim, and the `Running` CAS are ONE
transaction — the durable intent, written BEFORE any git mutation; `succeeded`
+ `Running→Review` CAS is the AFTER-side write. Phases advance durably before
each side effect.

| Failure | HTTP / outcome | State left | Recovery |
| --- | --- | --- | --- |
| Precondition (status, kind, shared, dirty, divergence) | 409 typed (`httpStatusForCode` maps PRECONDITION+CONFLICT→409; no 412) | No claim, no attempt row | None needed. |
| Claim lost (promotion claiming / lifecycle busy / cap) | 409 `CONFLICT` | Untouched | Manual retry. |
| Fetch/ff-update/rebase start fails | 200 with attempt `failed` (operation result), typed error inside | Rebase aborted, claim released `failed→none` on next claim | Retry allowed (reclaimable). |
| `agent=false` + conflict | 200 `outcome:'conflict'` | Rebase aborted, pre-sync SHA restored, attempt `aborted` | Retry with `agent=true`. |
| Supervisor spawn fails | attempt `failed`, run back `Review` | Conflicted state ABORTED first | Retry; `EXECUTOR_UNAVAILABLE` surfaced. |
| Agent turn crash / non-`end_turn` stop | attempt `failed` | Abort restore pre-sync SHA; session deleted; CAS `Running→Review` | Retry. |
| Verification fails | attempt `failed` | Same deterministic abort | Retry. |
| Push lease rejected | attempt `failed` (`CONFLICT`) | Rebase result KEPT locally (work not lost), no push | Operator decides (re-sync or manual push). |
| Web dies mid-anything | see crash windows | attempt row phase = discriminant | Reconcile/sweep per window below. |

Deferred-release rule: every catch path that breaks the happy path while a
supervisor session exists MUST `deleteSession` (`@/lib/supervisor-client:638`)
and abort the consumer — the session is the deferred; "log and continue" is
forbidden. A regression test simulates a persistence failure after
`createSession` and asserts `deleteSession` was invoked.

### Crash windows (agent path) and recovery predicates

Reconcile classifier input gains an `activeSyncAttempt` signal (plumbed into
`ReconcileInput` and the candidate `select` in `reconcile.ts`); `liveSession`
is `Boolean(matching supervisor session)` built at the sweep (`reconcile.ts:1015`).

| Window | Durable state | Recovery (exact predicate) |
| --- | --- | --- |
| W1: after claim+attempt(`starting`/`rebasing`), before session | attempt phase ∈ {starting,rebasing}, no live session, status `Review` | System sweep: abort in-worktree operation if present, attempt→`failed`, release claim. |
| W2: agent running, web restarts | attempt `agent_running`, status `Running`, live session for (runId, `sync-<n>`), **no in-process driver** | **Startup reconcile** (post-restart there is never an in-process driver): deterministic v1 — `deleteSession`, abort, attempt→`failed`, CAS `Running→Review`, `promoteNextPending`. (Reattach is a recorded future enhancement.) |
| W3: session gone, web died before verify/push/finalize | attempt ∈ {agent_running→no session, verifying, pushing}, status `Running` | Sweep re-runs verification idempotently; push `--force-with-lease` to the recorded SHA is idempotent; finalize or abort per verify result. |
| W4: mechanical sync interrupted (route process death) | attempt `rebasing`, status `Review`, sequencer state on disk | Sweep: abort, attempt→`failed`. |
| W5: active-time duration cap exceeded | status `Running`, attempt `agent_running`, `agent_running_since < now()-30min` (human-wait time in `NeedsInput` is excluded; each HITL resume re-stamps `agent_running_since`) | Sweep: kill session, abort, `failed`, back to `Review`. |
| W6: `ai_rebase_merge autoFinalize=true`, resolver verified but chained finalize not done | attempt `succeeded`, `auto_finalize=true`, status `Review`, branch clean/rebased | **Benign** — no auto-recovery required: the run is a normal clean `Review` (identical to two-step); the operator re-promotes manually. (A future enhancement may auto-resume the finalize; not v1.) |

**Skip-vs-abort discriminant** (resolves the periodic-vs-startup ambiguity):
the PERIODIC system sweep SKIPS a `Running + activeSyncAttempt + live-session`
row only when an in-process sync driver owns it (in-memory driver registry
membership — a healthy in-flight sync). At STARTUP reconcile there is never an
in-process driver, so `Running + activeSyncAttempt + live-session` is treated
as orphaned → W2 abort. `Running + activeSyncAttempt + no-session` → W2/W3 per
phase. A sync row is NEVER driven into the flow reattach arm
(`runResumedSession`) or `redispatch` (`reconcile.ts:231/277` hazard) — both
would mis-drive a non-graph session; the classifier branches on
`activeSyncAttempt` BEFORE those arms. Each arm gets its own test.

### PR-scan poison policy

Deterministic per-item failure (PR 404/deleted, invalid URL) →
`pr_state='closed'` or a recorded skip with `pr_state_checked_at` stamped —
never retried forever. Transient (CLI missing, network, provider 5xx) → item
skipped this tick, cursor advances, `recordJobAttemptResult`
(`jobs.ts:640-697`) max-failures/backoff protects the job (and
`ensurePrStateScanJobs` re-enables only while `consecutive_failures <
max_failures`). One bad row can never stall the per-project job
(progress-guarantee test included).

## Requirements and acceptance criteria

**FR-A (PR tracking)**
- FR-A1: every MAIster-created PR reaches a truthful
  `open|merged|closed(+conflicts)` state on `workspaces` within one scan
  cadence of the provider change; `merged` records
  `workspaces.pr_merge_commit_sha` (provider mergeCommit). **`runs.merge_commit_sha`
  is owned by `repo_delivery_scan` (ADR-134) and is NOT written by this scan.**
- FR-A2: each PR-state edge emits exactly one webhook — `run.pr_merged`
  (+ one `run_pr_merged` task activity), `run.pr_closed`, `run.pr_conflicts` —
  each an edge-guarded single tx → idempotent across redeliveries/re-scans; a
  PR that stays conflicted/merged/closed across scans re-emits nothing.
- FR-A3: run detail (header/inspector facts) and the task board card
  (`flight-card.tsx`) show the PR state chip incl. a distinct conflicts
  affordance (the alarm surface) with a reopen action; resolver launch always
  requires the explicit user click; EN+RU.
- FR-A4: ext `run_get` exposes `prState`/`prHasConflicts`/`syncAttempt`.
- FR-A5: scan never launches anything and **never calls the supervisor
  client** (asserted by test), never mutates git, spends zero LLM/agent tokens
  (provider CLI/REST only), respects the poison policy, and is observable in
  the admin scheduler UI.

**FR-B (sync + resolver + reopen + ai_rebase_merge)**
- FR-B1: mechanical sync on a clean-rebase branch completes synchronously,
  updates the diff/behind indicator, resets the drift warning, and pushes
  (force-with-lease with an explicit expected-SHA) iff published; run stays `Review`.
- FR-B2: local target fast-forwards from `origin/<target>` (target-scoped
  fetch) when FF-able; divergence refuses with both SHAs named.
- FR-B3: on conflicts with `agent=true`, a fresh resolver session runs in the
  run's worktree under the configured runner; permission requests surface as
  standard HITL; stop works; the agent cannot push. `agent=false` + conflict
  aborts cleanly with `outcome:'conflict'`.
- FR-B4: verification gate guarantees: completed rebase/merge, clean tree,
  `git diff --check` clean, target is ancestor — before any push/finalize.
- FR-B5: every attempt is a durable `run_sync_attempts` row with phases; all
  crash windows W1–W6 recover to a stable state by reconcile/sweep (W6 is a
  benign clean-`Review` degradation, no auto-recovery), each covered by a test
  naming its predicate; the skip-vs-abort discriminant is tested both ways.
- FR-B6: while sync is claimed, promote/archive/drop/export/snapshot/handoff
  refuse (and vice versa); sync↔promote matrix-tested both directions, the
  shared lifecycle slot covered by one representative.
- FR-B7: reopen flips exactly `Done→Review` for eligible runs, revives a GC'd
  worktree (existing-branch attach, no `-b`), excludes auto-promotion
  (`ne(promotion_state,'reopened')`), and re-promote reuses the SAME provider PR.
- FR-B8: cap honored: agent path refuses at the run's-kind cap; finalize
  promotes the Pending queue.
- FR-B9: ext routes + MCP tools mirror internal behavior under scope
  `runs:sync`; contract tests (ext OpenAPI ↔ zod ↔ MCP `TOOL_OP` bijection) pass.
- FR-B10: all UI strings exist in EN and RU (parity test green).
- FR-B11: `ai_rebase_merge` promotion is resolver-backed with an `autoFinalize`
  launch flag (default OFF). Clean rebase → finalizes to `Done`. Conflict +
  `autoFinalize=false` → resolver → run returns to `Review` for a manual clean
  re-promote (two-step). Conflict + `autoFinalize=true` → resolver → best-effort
  chained finalize to `Done`, degrading to `Review` (two-step) on any failure.
  No new promotion crash window (the resolver never holds the promotion claim);
  a plain `rebase_merge` promotion is unchanged.

**NFR**
- No plaintext secrets at rest or in logs; provider tokens remain process-env
  only (ADR-049 model B unchanged).
- No new env vars/ports/binaries; suites (`unit`, `integration`, e2e) green
  per phase; `pnpm validate:docs` (mermaid + ADR anchors, one gate) green at
  Phase 0 exit and at closure.

## Migration and ADR reservation

Reserve **ADR-137** (PR lifecycle tracking) and **ADR-138** (branch sync,
resolver, reopen, resolver-backed `ai_rebase_merge`) and migrations
**`0100_pr_state_tracking`** and **`0101_branch_sync`** from `main` (verified
heads 2026-07-14: ADR-136, migration idx 99 `0099_agent_human_ask`, identical
on this branch). Each migration is the full triple (SQL + `_journal.json`
entry + `meta/<NNNN>_snapshot.json`). Before merge: rebase onto current `main`,
re-check both global sequences, renumber ADR/migration and prose references if
a sibling consumed a number, re-run `pnpm validate:docs` (includes the ADR-anchor
validator). Migrations are additive; the only CHECK edits are **both**
`task_activity_event_kind_check` and `inbox_items_event_kind_check` (shared
const) for `run_pr_merged`. No destructive DDL, no backfill guessing.
`promotion_state='reopened'` and `lifecycle_operation_name='sync'` are app-level
(both columns are plain `text`, no CHECK — no `ALTER TYPE`).

## Commit Plan

- **Commit 1** (after Task 2): `docs: specify PR lifecycle tracking and branch sync contracts`
- **Commit 2** (after Tasks 3–4): `feat(db): PR state columns and sync attempt ledger`
- **Commit 3** (after Tasks 5–7): `feat: PR state scan job and surfacing`
- **Commit 4** (after Tasks 8–9): `feat: mechanical target sync with claims and ledger`
- **Commit 5** (after Tasks 10–13): `feat: AI conflict resolver, reopen, resolver-backed ai_rebase_merge`
- **Commit 6** (after Tasks 14–18): `feat: sync/reopen ext API, MCP tools, UI, and e2e`
- **Commit 7** (after Tasks 19–20): `docs: finalize PR/sync contracts as implemented`

## Requirement traceability and TDD gates

For every implementation task: write the named observable test first and show
it fail (RED — including migration tasks: assert the column/CHECK/constraint,
watch it fail on the un-migrated DB), implement the smallest change to green
exactly that contract (GREEN), refactor with the focused suite green (REFACTOR).
Unit tests only for pure logic (git helpers on real tmp repos count as unit per
the existing `worktree*.test.ts` convention, `unit` vitest project, Docker-free);
integration against Testcontainers Postgres for constraints/claims/routes/jobs;
mock ONLY the supervisor and provider boundaries; ONE e2e composition proof per
feature, not negative matrices. Every promised test names its runner project and
the plan confirms the include glob matches (skill-context runnability rule).

| Contract | Authoritative spec | GREEN owner (primary proof) |
| --- | --- | --- |
| S1 PR-state persistence | ADR-137; runs-domain ERD | Task 3 — migration 0100 integration test |
| S2 provider PR-state reads | ADR-137; git-integration.md | Task 5 — pr-adapter unit tests (mocked exec/fetch) |
| S3 scan job lifecycle | scheduler.md; ADR-137 | Task 6 — handler integration + `runSchedulerTick({jobKind:"pr_state_scan"})` wiring-seam test |
| S4 PR surfacing + events | outbound-webhooks.asyncapi; screens | Task 7 — query/emit/component tests |
| S5 git sync helpers | branch-sync.md §git ops | Task 8 — real-git unit tests |
| S6 sync ledger + attempts | ADR-138; branch-sync.md; sync ERD | Task 4 — migration 0101 integration test |
| S7 mechanical sync + fences | branch-sync.md state machine | Task 9 — service/route integration incl. fence matrix |
| S8 resolver session path | branch-sync.md; ADR-138 | Task 10 — driver integration (supervisor client mocked) |
| S9 recovery + watchdogs | branch-sync.md crash windows | Task 11 — reconcile/sweep integration per window |
| S10 reopen + re-promote | ADR-138; workspaces.md | Task 12 — reopen integration incl. same-PR re-promote |
| S11 resolver-backed ai_rebase_merge | ADR-138; git-integration.md | Task 13 — promote-mode integration (clean + conflict-delegate) |
| S12 ext + MCP contract | external operations.openapi | Tasks 14–15 — route integration + `tool-contract.test.ts` + `scope-contract.test.ts` |
| S13 UI + composition | screens docs | Tasks 16–18 — component tests + 2 e2e specs |

## Tasks

### Phase 0: docs-first contracts (SDD)

- [x] **Task 1: Freeze both feature contracts before code.**

  Write `docs/decisions.md` ADR-137 (PR lifecycle tracking: workspace columns
  incl. the `pr_merge_commit_sha` provenance split from `runs.merge_commit_sha`,
  scan job, 4-provider reads + `generic`-unsupported, webhook/activity edge,
  Bitbucket-deferred record) and ADR-138 (sync lifecycle op + double fence,
  pipeline, resolver session model incl. `run_sessions` `sync-<n>` identity and
  the caller-side FOR-UPDATE fence, target-scoped fetch + explicit-SHA lease,
  verification gate incl. `git diff --check`, attempt ledger + phase machine,
  crash windows W1–W6 with recovery predicates + skip-vs-abort discriminant,
  reopen semantics + `promotion_state='reopened'` fanout, active-time duration
  cap (pauses on `NeedsInput`, resets on HITL resume), cap/keepalive-Running-sweep
  interplay, manual-only stance, **resolver-backed `ai_rebase_merge` with the
  `autoFinalize` toggle (default OFF)**). Create `docs/system-analytics/branch-sync.md`
  per the R5 template (exact headers: Purpose, Domain entities, State machine,
  Process flows, Expectations, Edge cases, Linked artifacts) — State machine
  stating the exact allow-list guards as code will gate them; Process flows as
  Mermaid sequence diagrams for mechanical/agent/reopen/ai_rebase_merge. Update:
  `git-integration.md` (PR-state reads, push surface incl. lease, `ai_rebase_merge`
  now real), `scheduler.md` (`pr_state_scan` section + full registration set),
  `workspaces.md` (PR columns, `reopened`, sync claim), `workbench-lifecycle.md`
  (6th op `sync` + camelCase siblings + exclusion matrix), `external-operations.md`
  (scope + 2 ops + MCP tools), `tasks.md` (reopen effect on derived board state +
  relations re-gate), `docs/db/runs-domain.md` + `scheduler-domain.md` ERDs +
  `docs/database-schema.md`, `docs/error-taxonomy.md` (extend existing code
  cells — no new rows). API: `docs/api/web.openapi.yaml` (sync/reopen routes,
  bodies, `200/202/404/409/422/503` (no 412 — `httpStatusForCode` maps
  PRECONDITION+CONFLICT→409), **status↔outcome mapping**: 200
  synced/noop, 202 agent_launched, examples), `docs/api/external/operations.openapi.yaml`
  (ext ops + run DTO `prState`/`prHasConflicts`/`syncAttempt`),
  `docs/api/async/outbound-webhooks.asyncapi.yaml` (**three** channels
  `run.pr_merged` / `run.pr_closed` / `run.pr_conflicts`, each: enum member +
  `DataRunPr*` schema + `oneOf` `$ref` = 9 edits). Screens:
  `docs/screens/runs/flow-run.md` (behind chip, sync dialog, progress/stop,
  drift-card action, conflict card action), `run-inspector.md` (PR facts +
  reopen action), `workbench.md` (op matrix), `docs/screens/projects/project-board.md`
  (PR chip on flight cards), `project-settings-git.md` (sync strategy + resolver
  runner fields). Root `CLAUDE.md` §7/§8 one-line touch-ups. Every new piece
  tagged `Designed`. Note in ADR-138 the `ai_rebase_merge` disambiguation (the
  prior no-op mode is now the resolver).

  **Acceptance:** every refusal/precondition row states the exact allow-list the
  code will implement; both ERD artifacts updated; every changed HTTP/event
  surface has schemas, statuses, examples, status↔outcome mapping, and
  identifier provenance; crash-window table names its recovery predicate + the
  discriminant; `pnpm validate:docs` (mermaid + ADR anchors) passes.

  **Logging (spec):** document the structured events: sync attempt phase
  transitions, scan per-item outcome, reopen, push result — ids/SHAs/counts
  only, never content.

- [x] **Task 2: Spec completeness gate.**

  A dedicated review pass over the Task-1 artifacts BEFORE any code: (a)
  completeness — every FR/NFR maps to a contract section; (b) internal
  consistency — state machines, ERDs, OpenAPI, screens agree on names/states/
  statuses; (c) logical holes — walk each crash window, each fence direction,
  each entry point, and the `ai_rebase_merge` two-step end-to-end on paper; (d)
  acceptance concreteness — every criterion is observable/testable. Then an
  adversarial refute-the-design pass (background-automation + push-force
  security angles: **explicit-SHA lease safety after a target-scoped fetch**,
  confinement of the resolver to the worktree, scope gating, the double-fence
  both directions). Fix findings inline in the same task.

  **Acceptance:** a short findings log appended to the plan file (what was
  challenged, what changed); validators still green.

### Phase 1: persistence

- [x] **Task 3: Migration `0100_pr_state_tracking` + schema.**

  `web/lib/db/schema.ts`: workspaces `pr_state`, `pr_has_conflicts`,
  `pr_merged_at`, `pr_merge_commit_sha`, `pr_state_checked_at`; expand the
  shared `TASK_ACTIVITY_EVENT_KINDS` const with `run_pr_merged` and regenerate
  **both** CHECKs (`task_activity_event_kind_check` AND
  `inbox_items_event_kind_check`). Generate the triple (SQL, journal, snapshot).
  Partial index on `(project_id) WHERE pr_url IS NOT NULL AND (pr_state IS NULL
  OR pr_state='open')` for the scan candidate query.

  **Acceptance (RED first):** a migration integration test asserts (before the
  migration, RED) then (after, GREEN): migrated Postgres accepts legal shapes
  and rejects an illegal `pr_state`; both `event_kind` CHECKs accept
  `run_pr_merged`; pre-existing rows untouched (NULL state); newest journal
  entry has a matching snapshot; test listed by the integration runner.

  **Logging:** none beyond migration runner defaults.

- [x] **Task 4: Migration `0101_branch_sync` + schema.**

  `run_sync_attempts` table per decision 12 (UNIQUE `(run_id, attempt)`, FK
  run/workspace, a single plain-text `phase` column with a TS-only enum — mirror
  `node_attempts`, no DB CHECK, jsonb `conflicted_files`, `remote_sha_before`,
  `agent_running_since` timestamptz (active-time cap), `auto_finalize` boolean
  NOT NULL default false (`ai_rebase_merge` toggle), actor columns);
  `projects.sync_strategy_default` text NOT NULL default
  `'rebase'`; `projects.sync_runner_id` **text** NULL FK
  `platform_acp_runners(id)` ON DELETE SET NULL (mirror
  `flowRevisions.defaultRunnerId`, NOT `projects.default_runner_id`). Document
  that `promotion_state='reopened'` and `lifecycle_operation_name='sync'` are
  app-level (no CHECK — verified).

  **Acceptance (RED first):** constraint/shape integration test (legal/illegal
  phases as plain text, unique attempt, FK SET NULL on runner delete,
  `sync_strategy_default` default applied); Drizzle schema and DB agree; suites
  green.

  **Logging:** none.

### Phase 2: PR lifecycle tracking

- [x] **Task 5: Provider `getPrState` reads in `pr-adapter.ts`.**

  Extend the 4-provider adapter family (`web/lib/runs/pr-adapter.ts`) with
  `getPrState({remoteUrl, prNumber})`: `github` (gh CLI), `gitlab` (glab CLI),
  `gitea`/`gitverse` (REST); normalize to `{state: open|merged|closed,
  mergedAt?, mergeCommitSha?, hasConflicts?: boolean|null}`. Tokens stay
  child-env only. **`generic` → typed skip result (mirror `selectPrAdapter`'s
  unsupported-provider path — not a throw that fails the job).**

  **Acceptance (RED first):** unit tests with mocked `execFile`/`fetch` cover
  each provider's happy path + malformed payload + missing CLI/token
  classification (transient vs deterministic) + `generic`-skip; no live network
  in CI.

  **Logging:** DEBUG per query with provider/pr number/duration; WARN
  classification on failure; never tokens/URLs-with-creds.

- [x] **Task 6: `pr_state_scan` scheduler job.**

  Register the kind at ALL sites per decision 2a (three `schema.ts` enum edits;
  `job-catalog.ts` per-project shape; `budgets.ts` 3 points +
  `schedulerBudgetForKind` in `jobs.ts:136`; `claimDueJobs` 4 spots;
  `ensurePrStateScanJobs` + archived-disable wired into
  `ensureDefaultSchedulerJobs`; `tick-service.ts:88` dispatch + `:206` catch
  special-case; i18n EN+RU; `scheduler.md` + `scheduler-domain.md`). Handler
  `web/lib/scheduler/handlers/pr-state-scan.ts` (hybrid: per-project seeding from
  `repo_delivery_scan`, keyset cursor from `auto_promote`): candidate query
  (partial index), keyset cursor in `target->'cursor'`, batch cap, per-item
  `getPrState` → column updates on `workspaces`; three edge-guarded single txs
  per decision 4: merged {`pr_state`+`pr_merged_at`+`pr_merge_commit_sha`,
  `run.pr_merged` webhook outbox, `run_pr_merged` activity}; closed {`pr_state`,
  `run.pr_closed` webhook}; conflicts {`pr_has_conflicts`, `run.pr_conflicts`
  webhook} — each guarded by the previous `pr_state`/`pr_has_conflicts`; **never
  touches `runs.merge_commit_sha`, never calls the supervisor client**; poison
  policy per the table.

  **Acceptance (RED first):** handler integration test (each of the three edges
  merged/closed/conflicts → correct column update + exactly one webhook-outbox
  row, idempotent re-scan re-emits nothing, poison item, cursor progress past
  ineligible rows, **an assertion the handler never calls `createSession`/the
  supervisor client and never writes `runs.merge_commit_sha`** — FR-A5) + the wiring-seam test
  driving `runSchedulerTick({jobKind:"pr_state_scan"})` end-to-end + the enumerated
  breaking-list tests migrated: `jobs.integration.test.ts` kind lists,
  `i18n-scheduler-kind-keys.test.ts`, **`job-catalog.test.ts` (ALL_JOB_KINDS
  exact-equality), `jobs.test.ts` (`schedulerBudgetForKind` mapping)** all green.

  **Logging:** INFO per tick: project, scanned/updated/skipped counts, cursor;
  WARN per poison item with reason; no payloads.

- [x] **Task 7: PR state surfacing.**

  Webhook taxonomy: add `run.pr_merged`, `run.pr_closed`, `run.pr_conflicts`
  (`webhooks/taxonomy.ts:9` + the matching asyncapi edits from Task 1). DTO
  plumbing: `getRunDetail` + board (`queries/board.ts`) + portfolio
  (`queries/portfolio.ts`) + ext run DTO (`getRunDTO`, `services/runs.ts:1765` +
  wire schema `operations.openapi.yaml:3008`, fields aligned). UI: PR state chip
  (icon + label; green check for merged) in run header facts/inspector and on
  **`flight-card.tsx`** for Done/InDelivery runs; conflicts variant links to the
  reopen action (Task 12 wires it; render a disabled state until then). EN+RU keys.

  **Acceptance (RED first):** renderToStaticMarkup component tests for chip
  states; query tests for DTO fields; the three taxonomy types resolve against
  the asyncapi contract. (Per-edge emit-exactly-once lives in the Task-6 handler
  test — the handler is the emitter; do not duplicate the emit assertion here.)
  i18n parity green.

  **Logging:** none beyond emit INFO.

### Phase 3: git substrate

- [ ] **Task 8: Worktree helpers (TDD on real tmp repos).**

  In `web/lib/worktree.ts` (none of these exist today; reuse the internal
  non-exported `abortMerge:1641`/`abortRebase:1650` where useful):
  `aheadBehindCounts(repo, base, ref)` (`rev-list --left-right --count`),
  `ffUpdateLocalBranch(repo, branch, toSha)` (checked-out and non-checked-out
  cases; refuse non-FF), `rebaseOntoRef(worktree, ref)` returning
  `{ok} | {conflict, conflictedFiles}` (leaves conflict state), `mergeFromRef`
  equivalent, `syncOperationInProgress(worktree)` + `abortSyncOperation(worktree)`
  (rebase-merge/rebase-apply/MERGE_HEAD detection), `hasConflictMarkers(worktree)`
  (whole-tree `git diff --check`), `branchHasUpstream(repo, branch)`,
  `addWorktreeForBranch(repo, path, branch)` (**attach an EXISTING branch —
  NO `-b`, unlike the existing `addWorktree` which always uses `-b`; refuse if
  the branch is checked out elsewhere**).

  **Acceptance:** each helper has RED-first unit tests in
  `web/lib/__tests__/worktree-sync.test.ts` (inline real-git fixture per the
  `worktree.test.ts:38-60` convention, `unit` project, Docker-free), including:
  rebase with multiple conflicted files, abort restoring SHA, ff-update of the
  currently-checked-out target with clean tree, `addWorktreeForBranch` attaching
  an existing branch AND refusing when it is already checked out.

  **Logging:** git stderr captured into typed errors only.

### Phase 4: sync core

- [ ] **Task 9: Mechanical sync service + internal route (extract the shared core).**

  `web/lib/runs/sync-target.ts`: eligibility allow-list (status `Review`,
  runKind `flow|agent`, `parent_run_id IS NULL`, `runs.workspace_mode <>
  'shared'`, not experiment member), lifecycle claim `"sync"` (extend
  `LifecycleOperationName` + policy/tests), the **double fence** (sync refuses
  `promotion_state ∈ {claiming, done}`; `promoteRun` claim tx at
  `promote.ts:733` refuses an active sync claim — touch that claim step + its
  tests), the one-tx {attempt-number alloc + `starting` row + claim} (decision
  12), pipeline per decision 6 (target-scoped fetch, ff local target, ahead/behind,
  strategy attempt), push per decision 11 (explicit-SHA lease), `review_entered_at`
  reset, finalize releasing the claim. **Factor the rebase+push core into a
  reusable primitive** (`rebaseAndVerify`/`pushWithLease`) so Task 10 and Task
  13 share it (DRY). Route `POST /api/runs/[runId]/sync` (strict zod per the
  identifier table, `requireProjectAction("promoteRun")`), returning
  `{attemptId, outcome: noop|synced|conflict|agent_launched, behind, pushed}`
  with the status↔outcome mapping (200 synced/noop, 202 agent_launched, typed
  4xx refusals).

  **Acceptance (RED first):** integration — clean rebase path (behind>0 →
  synced, diff base moved, drift cleared), no-op path, divergent local target
  refusal, dirty worktree refusal, **concurrent double-launch → 2nd `CONFLICT`,
  one attempt row**, fence matrix (sync↔promote BOTH directions; sync↔one
  lifecycle op as the slot representative), push-iff-published incl. **lease
  failure after a target-scoped fetch** (the branch-moved case), `agent=false` +
  conflict → `outcome:'conflict'` clean abort, `review_entered_at` reset asserted,
  route status↔outcome matrix. Existing promote tests migrated for the new fence.

  **Logging:** INFO per phase transition with runId/attempt/SHAs; WARN refusals
  with code; no diff content.

- [ ] **Task 10: Agent resolver path.**

  `markSyncFromReview` in `state-transitions.ts` (bare `Review→Running` CAS,
  mirroring `markReworkFromReview`) **behind a new caller-side FOR-UPDATE fence
  mirroring `reworkChildRun` (`agents/launch.ts:2638`)**; does NOT touch any
  `runs` session column (none exists). Runner resolution chain per decision 8
  (add the sync tier to `resolveRunner`; `projects.sync_runner_id`) + a NEW
  `run_sessions` row via spread-override of `defaultRunSessionValues`
  (sessionName `sync-<attempt>`). Cap check per decision 15 + typed refusal;
  prompt template (fixed, English, task-context null-safe, prohibitions);
  driver: service-layer `createSession(cwd=worktree, runner=snapshot)` (stamp
  `agent_running_since=now()` at launch, decision 16) → scratch-pattern SSE
  consumer (permission → `hitl_requests` row + `NeedsInput`; the
  `NeedsInput→Running` flip owned by the respond route, which **also re-stamps
  `agent_running_since`** for the active-time cap) → blocking `sendPrompt` →
  verification gate (decision 10) → push (decision 11) → finalize CAS
  `Running→Review` + `promoteNextPending`. Deferred-release: EVERY catch after
  `createSession` calls `deleteSession` + consumer abort before rethrow/fail.
  Stop: workbench stop on a syncing run kills the session; the failure path
  (abort → `failed` → `Review`) owns cleanup.

  **Acceptance (RED first):** integration with mocked supervisor client —
  conflict → session launched with conflicted-files prompt vars + a `sync-<n>`
  `run_sessions` row; happy resolve → verified → pushed → `Review` + slot
  released (queue promotion asserted); crash stop-reason → abort + `failed` +
  `Review`; verification-failure → abort; HITL round-trip (permission →
  NeedsInput → respond → Running); deleteSession spy asserted on a simulated
  post-createSession persistence failure; cap refusal test.

  **Logging:** INFO session spawn/end with sessionName/runner tier; INFO
  verification verdict; ERROR classified supervisor failures; never
  prompt/output content.

- [ ] **Task 11: Recovery fanout (reconcile, sweeps, watchdog, keepalive).**

  Reconcile (`web/lib/reconcile.ts`): add `activeSyncAttempt` to `ReconcileInput`
  + the candidate `select`; new arms BEFORE the reattach/redispatch arms —
  Running+sync+live-session → skip (periodic, in-proc driver) / W2 abort
  (startup, no driver) per the discriminant; Running+sync+no-session → W2/W3
  recovery (idempotent re-verify or abort); a sync row NEVER enters
  `runResumedSession`/`redispatch`. System sweep: W1/W4 orphan-operation
  recovery (predicate: attempt phase + no live session + sequencer state), W5
  **active-time** duration cap (`SYNC_ATTEMPT_MAX_MINUTES = 30` measured from
  `agent_running_since`; predicate `status='Running' AND phase='agent_running'
  AND agent_running_since < now()-30min` — `NeedsInput` pauses are naturally
  excluded). `agent_running_since` is stamped at launch and **re-stamped by the
  HITL-respond route on every `NeedsInput→Running` resume** (a one-line write
  in the existing respond path). W6 (`autoFinalize=true` chained-finalize
  crash) is benign — no sweep arm needed (the run is a clean `Review`).
  Keepalive: exclude runs with an active sync attempt from the **Running-status**
  candidate queries (`fetchTimeLimitCandidates:448`, `fetchBudgetCandidates:786`)
  — NOT Pass1/Pass2.

  **Acceptance (RED first):** one integration test PER crash window W1–W5
  asserting the exact recovery predicate and stable state (attempt status, run
  status `Review`, worktree sequencer clean, claim released, slot promoted); a
  W5 test proving a `NeedsInput` human-pause does NOT trip the cap and a HITL
  resume re-stamps `agent_running_since`; the skip-vs-abort discriminant tested
  BOTH ways (periodic-with-driver skip vs startup-no-driver abort); reconcile
  existing tests migrated for the new arms; a test proving the Running-sweeps no
  longer abandon a syncing run.

  **Logging:** INFO recovery decisions with window tag (w1..w6), runId, attempt.

### Phase 5: reopen + ai_rebase_merge

- [ ] **Task 12: Reopen service + route + re-promote.**

  Service per decision 14: single tx — new exact-`Done`-allow-list CAS in
  `state-transitions.ts` (`Done` is terminal today, no such edge exists);
  `promotion_state='reopened'` (edit the scattered literals — no central union);
  clear `scheduled_removal_at`; stamp `review_entered_at`; webhook `run.review`.
  GC'd-workspace revival via `addWorktreeForBranch` (existing-branch attach; +
  fetch-and-recreate when the local branch is gone; PRECONDITION when both gone);
  `canReclaim` admits `'reopened'`; auto-promote SQL prefilter adds
  `ne(promotion_state,'reopened')`; route `POST /api/runs/[runId]/reopen`. Wire
  the PR-conflicts chip action (Task 7) to reopen(+prefilled sync dialog).

  **Acceptance (RED first):** integration — eligible reopen round-trip
  (Done→Review→sync→re-promote reuses the SAME PR via `createOrUpdatePr`,
  asserted by the adapter mock receiving reuse-not-create); GC'd revival
  (worktree re-attached via existing-branch attach, removed_at cleared); refusal
  matrix (non-PR Done run, child run, shared tree, already Review); auto-promote
  evaluator test proving `'reopened'` exclusion; board derivation test (card back
  to OnReview); relations re-gate behavior asserted and documented.

  **Logging:** INFO reopen with runId/pr number/revival flag; WARN refusals.

- [ ] **Task 13: Resolver-backed `ai_rebase_merge` promotion (decision 19).**

  In `promote.ts`, replace the `ai_rebase_merge` no-op (currently collapses to
  `rebase_merge`) with the `autoFinalize`-flagged form (decision 19) reusing the
  Task-9 shared core: attempt the rebase of the run branch onto target; **clean**
  → continue the existing `rebase_merge` finalize (→ `Done`); **conflict** →
  delegate to the sync-resolver (Task 10, under the sync lifecycle claim — NOT
  the promotion claim, so no promotion crash window). On verified resolution:
  `autoFinalize=false` (default) → run stays `Review`, surface "conflicts
  resolved — re-promote to finish"; `autoFinalize=true` → **best-effort chain**
  `promoteRun(rebase_merge)` on the now-clean branch (→ `Done`), and on ANY
  failure leave the run in `Review` (degrade to two-step — benign, W6). Persist
  `autoFinalize` on the attempt row so the chained step reads the launch-time
  decision. A plain `rebase_merge` promotion path is unchanged. ReviewPanel
  shows the mode + the `autoFinalize` checkbox (Task 16 owns the copy).

  **Acceptance (RED first):** integration — `ai_rebase_merge` clean rebase →
  `Done` (same PR/merge as `rebase_merge`); conflict + `autoFinalize=false` →
  resolver under the sync claim, run returns `Review`, no promotion claim held
  across the agent window, manual re-promote finalizes cleanly; conflict +
  `autoFinalize=true` → resolver → chained finalize → `Done` in one operation;
  conflict + `autoFinalize=true` with a simulated finalize failure → run left in
  clean `Review` (W6 benign, no stuck state); `rebase_merge` regression
  unchanged; assert the promotion claim is released before the resolver runs.

  **Logging:** INFO mode/decision (clean-finalize vs resolver-delegate) with
  runId; reuse Task 10 resolver logs.

### Phase 6: ext API + MCP

- [ ] **Task 14: Ext routes + scope.**

  `runs:sync` in `web/types/token-scopes.ts` (NOT in `AGENT_TOKEN_SCOPES` there,
  NOT in `ORCHESTRATOR_TOKEN_SCOPES` at `web/lib/agents/tokens.ts:35`) + token
  UI scope option labels EN+RU (`personal-tokens-panel.tsx:33` `SCOPE_OPTIONS` +
  switch, `scopeLabels` en/ru, + the two board display switches). Routes
  `POST /api/v1/ext/runs/sync` and `.../reopen` via `handleExt` (run-bound —
  `resolveProjectId` from the run row, existence-hidden 404; **map
  `PROJECT_ACTION_BY_SCOPE["runs:sync"] = "promoteRun"`** so ext == internal
  authz, never the `readBoard` fallback; typed status mapping per the
  internal routes); ext `run_get` DTO fields.

  **Acceptance (RED first):** route integration tests (scope enforced,
  wrong-project hidden 404, body validation, outcome parity with internal);
  `scope-contract.test.ts` updated only if a mapping is added; ext OpenAPI
  examples match actual responses (contract chain, not duplicate happy paths);
  `token_audit_log` one success + one refusal row per route asserted.

  **Logging:** standard ext audit rows.

- [ ] **Task 15: MCP facade tools.**

  `run_sync` + `run_reopen` — 4-way coupled: `TOOL_SPECS` + `resolveRouting`
  cases (`mcp/src/tools.ts`, numeric-coercion friendliness via
  `coerceNumericArgs`), `TOOL_OP` mirror in `tool-contract.test.ts` (bijection),
  AND the ext OpenAPI operations from Task 14. Build requirement:
  `pnpm --filter @maister/mcp build` (facade runs `dist/main.js`).

  **Acceptance (RED first):** `tools.test.ts` + `tool-contract.test.ts` green
  (every tool ↔ one ext OpenAPI operation, props/enums parity, bijection);
  coercion test for numeric-ish args if any.

  **Logging:** none (facade standard).

### Phase 7: UI

- [ ] **Task 16: ReviewPanel sync UX + merge_conflict wiring.**

  Behind/ahead chip in `buildReviewPanelData` (`layout.tsx:154`, via
  `aheadBehindCounts` against `origin/<target>` when present else local target);
  Sync button + dialog atop the EXISTING drift card (`review-panel.tsx:434`
  already renders "Promote anyway") — strategy select seeded from project
  default, runner select seeded from the resolver chain, push toggle auto-on
  when published, "resolve conflicts with AI agent" checkbox default ON; drift
  card gains "Sync branch" as the primary action next to "Promote anyway".
  **`merge_conflict` has no dedicated card** — add a kind-specific branch to the
  generic assignment surface (`board/assignment-actions.tsx` / `inbox/hitl-card.tsx`)
  with a "Resolve with agent" action (opens the sync dialog agent-pre-set) + EN+RU
  labels (none exist today). Sync-in-progress panel state (phase + stop) off the
  attempt DTO; run header promotion action disabled while sync claimed. When the
  promotion mode is `ai_rebase_merge`, the promote dialog gains an **"auto-finalize
  after resolve" checkbox (default OFF)** (decision 19) + the post-resolve
  re-promote copy for the two-step path. Icon-first affordances per
  `web/CLAUDE.md`; EN+RU.

  **Acceptance (RED first):** renderToStaticMarkup tests for dialog states/
  validation, chip, drift/conflict entry points, `merge_conflict` "Resolve with
  agent" affordance + labels, the `ai_rebase_merge` auto-finalize checkbox
  (default OFF), in-progress state; i18n parity green.

  **Logging:** client-side none; server actions reuse Task 9/10 logs.

- [ ] **Task 17: Project settings + remaining chips.**

  `project-settings-git` panel: sync strategy default (rebase|merge) and
  resolver runner picker (platform runner catalog, nullable) with the aggregate
  PATCH convention; portfolio/board chips from Task 7 wired to live data on
  `flight-card.tsx`; reopen action surfaced on conflicted-PR cards.

  **Acceptance (RED first):** settings round-trip integration (SET, CLEAR to
  default, idempotent re-SET — config-state symmetry rule, both halves
  mandatory); component tests; EN+RU.

  **Logging:** settings change INFO with project id + field names.

- [ ] **Task 18: E2E composition proofs.**

  Two Playwright specs on the stub-supervisor seeded harness (explicit file
  paths when running): (1) `e2e/run-sync.spec.ts` — seeded Review run behind
  target → Sync → mechanical success → behind chip clears → promote succeeds;
  (2) `e2e/pr-reopen.spec.ts` — seeded Done run with `pr_state='open',
  pr_has_conflicts=true` → conflict chip visible → reopen → run lands OnReview
  with sync dialog reachable. Agent-path negative matrices stay in integration
  (stub supervisor drives the session boundary there).

  **Acceptance:** both specs green locally against the seeded harness; no
  reliance on live gh/glab.

  **Logging:** n/a.

### Phase 8: closure

- [ ] **Task 19: As-built docs flip + renumber pass.**

  Flip Task-1 artifacts `Designed → Implemented` only where tests prove it; sync
  any drift discovered during implementation back into the analytics/OpenAPI/
  screens docs; re-verify ADR/migration numbering against current `main`
  (renumber if a sibling landed first) + prose-form greps; run `pnpm
  validate:docs` (mermaid + ADR anchors); update root `CLAUDE.md` and
  `web/CLAUDE.md` sentences touched by the feature (incl. `ai_rebase_merge` now
  real, `runs.merge_commit_sha` ownership note).

  **Acceptance:** validators green; no `Designed` tag remains on shipped
  behavior; numbering verified against `main` HEAD.

- [ ] **Task 20: Full verification gate.**

  Run the complete suites: `pnpm --filter maister-web test:unit`,
  `test:integration` (Testcontainers; `TESTCONTAINERS_RYUK_DISABLED=true` on
  this host), both e2e specs by explicit path, `mcp` package tests, lint
  (`eslint .` check-only). Confirm the enumerated existing-test migrations
  landed: promote claim tests (sync fence + `ai_rebase_merge`), reconcile
  classifier tests (new arms + discriminant), scheduler `jobs.integration` +
  `i18n-scheduler-kind-keys` + `job-catalog.test` + `jobs.test` (new kind),
  workbench-lifecycle policy tests (6th op), `scope-contract`, `tool-contract`,
  `i18n-parity`, board/portfolio query tests (new fields). Then `/aif-verify`
  against this plan + a final adversarial review pass over the diff; every
  FR/NFR acceptance criterion checked off with evidence.

  **Acceptance:** all suites green with output recorded; zero unaccounted
  FR/AC; findings from the adversarial pass fixed or explicitly deferred with
  rationale in the plan file.

## Open questions — resolved with owner 2026-07-14

1. Reopen re-gates dependent tasks (relations released on Done re-block) —
   CONFIRMED as honest behavior.
2. `run_pr_merged` task activity (migration-backed `event_kind`, BOTH CHECKs) —
   CONFIRMED.
3. Webhooks: `run.pr_merged` + `run.pr_closed` + `run.pr_conflicts` (each
   edge-guarded) — REVISED 2026-07-14, owner asked to add closed + conflict
   events (see resolved item 11). `task_activity` stays merged-only.
4. PR-scan cadence: constant 300s, no env var — CONFIRMED, with the explicit
   owner constraint embedded in decision 4 / FR-A3 / FR-A5: the scan is
   programmatic-only (zero LLM tokens, never calls the supervisor client),
   conflict detection only alarms, and the agent rebase runs strictly by user button.
5. v1 excludes scratch runs, shared trees (`runs.workspace_mode='shared'`),
   experiment members, and orchestrator children from sync/reopen — CONFIRMED.
   Scratch context: scratch delivery already exists (`promoteScratchRun`,
   `promote.ts:1637` — `local_merge` into the scratch `baseBranch` only;
   `pull_request`/`rebase_merge` rejected at entry). A scratch run that needs its
   base pulled in uses its own live conversational session, so dedicated sync
   machinery is not worth v1 complexity.
6. Web restart during agent resolve: deterministic abort (agent work discarded),
   reattach recorded as future enhancement — CONFIRMED.
7. **merge_commit_sha ownership** (refinement 2026-07-14): SPLIT — the PR-provider
   merge commit is recorded on `workspaces.pr_merge_commit_sha` only;
   `runs.merge_commit_sha` stays owned by the shipped `repo_delivery_scan`
   (ADR-134). `pr_state_scan` never co-writes it. CONFIRMED by owner.
8. **`ai_rebase_merge`** (refinement 2026-07-14): the resolver IMPLEMENTS the
   existing no-op mode. CONFIRMED by owner.
9. **`ai_rebase_merge autoFinalize`** (refinement 2026-07-14): one-click async
   is available as an **opt-in launch checkbox, default OFF** — two-step is the
   default; auto-finalize failure degrades to the clean-`Review` two-step state
   (benign W6). CONFIRMED by owner (decision 19).
10. **Duration cap** (refinement 2026-07-14): the 30-min cap counts only active
    `Running` time — `agent_running_since` is re-stamped on each HITL resume, so
    a human pause never trips it; only a genuine runaway is swept. CONFIRMED by
    owner (a flat wall-clock cap was rejected as unsafe; decision 16).
11. **Closed/conflict webhooks** (refinement 2026-07-14): add `run.pr_closed` +
    `run.pr_conflicts` alongside `run.pr_merged`, each edge-guarded (revises item
    3). CONFIRMED by owner (decision 4).

_No open owner questions remain; the plan is ready for `/aif-implement`._

## Task-2 spec completeness gate — findings log (2026-07-14)

An adversarial cross-check of the Phase-0 contracts (ADR-137/138, branch-sync.md,
the three API specs, ERDs, error-taxonomy, screens) against the FRs, verified
against real code. Verdict was **NOT-READY** until the two blockers landed; all
fixed inline in Task 2 (validators re-run green afterwards):

- **B1 (blocker, security) — ext `runs:sync` authz downgrade.** The pre-refinement
  decision 17 said "do NOT add a permissive `PROJECT_ACTION_BY_SCOPE['runs:sync']`
  default" — but `projectActionForScope` (`web/lib/tokens/ext-handler.ts:111`) returns
  `PROJECT_ACTION_BY_SCOPE[scope] ?? "readBoard"`, so LEAVING it unmapped IS the
  downgrade (a viewer-owned token could launch a resolver + force-push). The internal
  route requires `promoteRun` (member). **Fixed:** decision 17 + route-identifier
  table + external-operations.md now require `PROJECT_ACTION_BY_SCOPE["runs:sync"] =
  "promoteRun"`; Task 14 adds the map entry + a `scope-contract.test.ts` assertion.
- **B2 (blocker) — `run_sync_attempts.status` undefined.** The ERD carried both a
  fully-specified `phase` and an undefined `status`, blocking Task 4's migration/enum.
  **Fixed:** dropped `status`; `phase` (starting|rebasing|agent_running|verifying|
  pushing|succeeded|failed|aborted) is the single lifecycle column (ERD, db-schema,
  branch-sync.md, decision 12, Task 4 all updated).
- **C3 — error-taxonomy:** added ADR-138 cell entries to `CONFLICT`,
  `EXECUTOR_UNAVAILABLE`, and `CRASH` (previously only `PRECONDITION`).
- **C4 — workspaces.md** promotion-strategy table `ai_rebase_merge` row rewritten from
  the stale no-op to the resolver-backed behavior.
- **C5 — resolver "cannot push"** was prompt-only, not enforced; ADR-138 + branch-sync.md
  now state it honestly (instructed-only; enforced net = web-side verification gate +
  explicit-SHA lease; bounded blast radius = own PR branch; seam enforcement = future).
- **C6 — `extSyncRun`** gained the missing `503` (agent-path `EXECUTOR_UNAVAILABLE`).
- **N7 — lease capture source** documented (`git ls-remote origin refs/heads/<branch>`
  before the target-scoped fetch; refuse if indeterminate while `pr_url` is set).
- **N8 — `412`** scrubbed from plan prose (`httpStatusForCode` maps PRECONDITION+CONFLICT→409).
- **N9 (kept)** ext `403` reuses `HitlForbidden` — matches every sibling ext run route.
- **N10 (deferred to Task 19)** stale "12-type taxonomy" phrasing in `docs/CLAUDE.md`.

Confirmed clean: FR completeness (every FR-A/FR-B/NFR maps to a contract), outcome/
phase/status-code vocab agreement across specs, W1–W6 discriminants + recovery
predicates, the double-fence both directions (contingent on both claim txs taking the
same `workspaces` row `FOR UPDATE` — an explicit test invariant), the `ai_rebase_merge`
four branches, and FR-A5's zero-token/never-supervisor testability.
