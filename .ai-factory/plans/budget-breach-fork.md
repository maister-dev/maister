# Budget-Breach Fork: Four-Way Decision Surface

Date: 2026-07-02
Mode: full SDD plan
Branch: detached HEAD in `/Users/developer/.codex/worktrees/65ea/mAIster`
ADR allocation: ADR-125 (owner-confirmed order: 122 project-brain, 123 Tact-0,
124 Tact-2 — Tact-2 commits before this scope; still re-run the ADR max guard
at docs-writing time).
Migration allocation: none planned; if one becomes unavoidable, take the next
free number at implementation time with the monotonic-`when` guard — do NOT
hard-code `0088_*` (the project-brain branch already stakes an unmerged 0088).

## Settings

Testing: yes. TDD RED -> GREEN -> REFACTOR is mandatory.

Logging: verbose for every composite decision and every post-claim side effect.
Use structured fields only: `runId`, `hitlRequestId`, `taskId`, `oldRunId`,
`newRunId`, `optionId`, `mode`, `branchName`, `scope`, `meter`,
`previousLimit`, `newLimit`, `compositeStage`, `workspaceId`, `ref`.

Docs: yes. Phase 0 is docs/contracts first and must be validator-clean before
implementation.

Roadmap linkage: cross-cutting M39/M40/M27 follow-up. This is not a new engine
milestone; it composes the existing ADR-101/106 budget ladder, ADR-119 relaunch
attempt allocation, ADR-121 resume caps, and M27 workbench lifecycle.

## Recon Summary

Verified from code on 2026-07-02:

- `web/lib/services/hitl.ts` currently accepts only
  `optionId in {"raise","abandon"}` for `budget_breach`; `raise` reads legacy
  `raiseTo ?? response`, validates a positive integer greater than
  `schema.limit`, and updates `runs.budgetState.ceilingOverride[scope][field]`.
- Budget meter mapping is already present:
  `tokens -> maxTokens`, `failures -> consecutiveFailures`,
  `wallclock -> wallClockMinutes`.
- `abandon` currently marks the run `Failed`, emits `run.failed` with
  `BUDGET_EXCEEDED`, closes assignments, and leaves workspace cleanup to TTL.
- `web/lib/runs/keepalive-sweeper.ts` computes limits as
  `policy snapshot + ceilingOverride`, re-derives token hard ceilings in one
  place, and creates `budget_breach` HITL rows with
  `decisions: ["raise", "abandon"]`.
- Current budget breach dimensions are `tokens`, `failures`, and `wallclock`.
  Live run/task scopes evaluate tokens/failures; current wallclock breach
  creation is tree-root only and is force-promoted to terminate in the existing
  sweeper. The respond path must still support wallclock rows defensively and
  tests should seed one directly.
- Escalate `NeedsInput` holds the slot; terminate-restorable
  `NeedsInputIdle` releases the slot. Raise re-enters through
  `scheduleBudgetBreachResume`, which uses the shared agent resume slot claim
  for agent runs and `resumeRun` / `runFlow` for flow runs.
- The session-auth respond route schema in
  `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts` still has
  only `optionId`, `response`, `confidence`, and legacy `raiseTo`.
- The external route currently does not actually permit `budget_breach`
  responses. `web/app/api/v1/ext/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts`
  only upgrades exact human token scope for `kind == "human"`, and the shared
  `respondToHitl` service rejects non-user actors for `budget_breach`.
- `docs/api/external/operations.openapi.yaml` currently overstates that
  `budget_breach` can be answered by exact human-token scope. This plan corrects
  that contract text without opening the ext/MCP surface.
- Workbench archive does not terminalize by itself. `stopThenArchive` lands flow
  runs in `Review`, which would not satisfy this feature's "park and return the
  task" requirement. Park therefore needs a small preserve-then-`Abandoned`
  composite that reuses M27 git/workbench primitives but owns the budget-specific
  terminal transition.
- `web/lib/agents/launch.ts` exposes `launchAgentRun`, so Q4 can include
  restart for top-level, task-bound, worktree-mode agent runs using the standard
  agent launch choke point.
- Max ADR present in `docs/decisions.md` is 121. The request reserves ADR-122
  for project-brain and the Tact-0/Tact-2 plans take the next two slots, so this
  plan reserves ADR-125. Re-run the ADR number guard before writing docs.
- Max migration in `web/lib/db/migrations/meta/_journal.json` is
  `0087_shocking_epoch`. No migration is expected because HITL kinds already
  exist and payloads are JSONB.
- Observatory `budgetTerminations` (`web/lib/queries/observatory.ts:456`)
  counts `run.failed` with `payload->>'reason' IN
('budget_exceeded','BUDGET_EXCEEDED','budget_breach')`. The human-abandon
  reason `budget_abandoned` is NOT in the list today (existing gap); restart
  and abandon reasons are an explicit metric decision in this plan.
- The generalized run-stop dispatcher (`stopRunByKind`/`stopWorkbenchRun` in
  `web/lib/workbench-lifecycle/service.ts`) lands runs in `Review` via
  `markRunStoppedAndCloseAssignments` — it MUST NOT be used by these
  composites (it would break the terminal CAS on `NeedsInput*`). The budget
  pause already idle-checkpoints the session (the sweeper's escalate path
  calls `checkpointSession`; a 5xx leaves it live for the next tick), so a
  composite only needs a defensive `checkpointSession` on the run's ACTIVE
  session (M42 ADR-114 lookup) with no status transition.
- Task auto-return is DERIVED in `web/lib/board.ts` from the latest run's
  status (`Failed | Abandoned` → Backlog); there is no async consumer to race
  with during the restart composite.
- The pending read model filters `respondedAt IS NULL`; a stage-claimed row
  stays visible in inbox/needs-you unless explicitly excluded.
- The existing already-delivered retry branch (`hitl.ts:1958`) re-drives the
  resume for ANY retry payload without comparing the stored decision — the
  shared claim gate must fix this.
- i18n catalogs live at `web/messages/en.json` + `web/messages/ru.json`.
- These test files already EXIST and are extended, not created:
  `web/lib/services/__tests__/hitl-budget-breach.integration.test.ts`,
  `respond/__tests__/route.test.ts`,
  `web/components/board/__tests__/hitl-decision-controls.test.ts`,
  `web/components/board/__tests__/run-hitl-response.test.ts`,
  `web/components/inbox/__tests__/hitl-card.test.ts` (all `.test.ts`,
  renderToStaticMarkup convention).

## Decisions

1. Park default is `snapshot`. It needs no extra user input and preserves work on
   the run branch before terminalizing.
2. Park terminal status is `Abandoned`, not `Review`. This satisfies task
   auto-return and avoids creating a new run status. The generic workbench
   `stopThenArchive` flow status remains unchanged for other features.
3. `abandon` without `dropWorkspace` remains byte-compatible with today:
   `Failed`, `BUDGET_EXCEEDED`, TTL cleanup.
4. `abandon` with `dropWorkspace: true` keeps the same `Failed` run result and
   additionally removes the owned worktree/branch now. For no-workspace modes
   the drop flag is accepted as a no-op but the UI hides it.
5. Ext/MCP `budget_breach` responses stay closed. The external OpenAPI
   correction is contract cleanup only; the four-way schema is not exposed there.
6. Q4 is included: restart is available for `runKind == "agent"` only when the
   run is top-level, task-bound, `agentWorkspace == "worktree"`, and has an
   `agentId`. Other agent workspace modes remain no-restart in v1.
7. No new statuses, HITL kinds, domain-event kinds, SSE event types, or DB
   columns are planned.
8. Claim protocol is ONE shared gate for all four options (see "Shared claim
   gate" below). Legacy raise/abandon route through the same gate — wire
   behavior unchanged, internal guard unified.
9. Composites never call `stopRunByKind` (it lands `Review` and would break
   the terminal CAS). Defensive session stop = `checkpointSession` on the
   run's active session only; run status stays `NeedsInput`/`NeedsInputIdle`
   until the composite's own terminal CAS.
10. Restart validates relaunch launchability (manual classifier semantics,
    including ADR-121 blocked/flagged gates) BEFORE claim; refusal is
    `PRECONDITION` with the row intact.
11. Events + metrics: restart's old run emits `run.failed`
    `{errorCode: "BUDGET_EXCEEDED", reason: "budget_restart"}`; park emits
    `run.abandoned` with `reason: "budget_parked"` + the preserved ref. The
    observatory `budgetTerminations` reason filter gains `'budget_restart'`
    AND `'budget_abandoned'` (owner-approved; closes the existing gap — a
    human abandon after a breach is a budget termination too). Park stays out
    of the terminations metric (work preserved, run not `Failed`).
12. AC-8 e2e exercises BOTH locales (cookie toggle inside the spec), not only
    render-level i18n assertions.
13. Commit plan keeps failing tests as a dedicated RED commit (owner-approved;
    not folded into phase commits).

## Availability Matrix

This matrix is enforced by a single server helper and rendered from the server
read model. The UI does not reimplement these predicates.

| Run kind / state                                  | raise                 | restart               | park                     | abandon / drop         |
| ------------------------------------------------- | --------------------- | --------------------- | ------------------------ | ---------------------- |
| Task-bound flow, `NeedsInput` or `NeedsInputIdle` | yes                   | yes                   | yes when worktree exists | yes                    |
| Orchestrator-child run (`parentRunId != null`)    | yes                   | no                    | no                       | yes                    |
| Scratch run with worktree                         | yes                   | no                    | yes when worktree exists | yes                    |
| Agent `none` / `repo_read`                        | yes                   | no                    | no                       | yes, drop hidden/no-op |
| Top-level task-bound agent `worktree`             | yes                   | yes                   | yes when worktree exists | yes                    |
| Experiment member run                             | inherits the flow row | inherits the flow row | inherits the flow row    | inherits the flow row  |

Unavailable options fail with `MaisterError("PRECONDITION")` and must not claim
or consume the HITL row.

## Contract Surfaces

Routes and DTOs:

- `POST /api/runs/{runId}/hitl/{hitlRequestId}/respond`
- `GET /api/runs/{runId}/inbox-context`
- pending HITL read model returned by `web/lib/queries/hitl.ts`
- run-detail HITL panel data path in `web/app/(app)/runs/[runId]/layout.tsx`

Body-controlled fields:

- `optionId`: `raise | restart | park | abandon`
- legacy `raiseTo`: integer, still accepted for `raise`
- `response.dimension`: optional `tokens | failures | wallclock` for `raise`
- `response.newLimit`: integer for `raise`
- `response.mode`: `snapshot | export` for `park`
- `response.branchName`: required for `park/export`, validated before any side
  effect
- `response.dropWorkspace` or top-level `dropWorkspace`: optional boolean for
  `abandon`

Server-state fields:

- `runId`, `hitlRequestId`, `projectId`, `taskId`, `flowId`, `agentId`,
  `runKind`, `parentRunId`, `rootRunId`, `agentWorkspace`, run status, current
  `hitl_requests.schema`, workspaces row, run sessions, execution policy
  snapshot, current policy resolution, scheduler slots, and workbench refs.

OpenAPI:

- Update `docs/api/web.openapi.yaml` with the extended session-auth
  `HitlResponseBody`, `BudgetBreachResponsePayload`,
  `BudgetBreachAvailableOption`, `BudgetBreachProgressDto`, and the pending
  HITL DTO `claimStage` field.
- Update `docs/api/external/operations.openapi.yaml` only to correct the stale
  statement that ext tokens may answer `budget_breach` — the same sentence
  overstates `infra_recovery` (the route upgrades the actor ONLY for
  `kind == "human"`); fix the whole sentence. Do not expose the new schema
  externally.

DB:

- No migration expected. `hitl_requests.kind` already includes
  `budget_breach`, and request/response/schema payloads are JSONB.
- If implementation proves a stored idempotency checkpoint is unavoidable beyond
  existing `hitl_requests.response`, stop and reserve the NEXT FREE migration
  number at that moment with the monotonic-`when` guard (0088 is already staked
  by the unmerged project-brain branch).

## Composite Semantics

### Shared claim gate (all four options)

Every budget_breach response — including legacy raise/abandon — passes one
gate inside the row-lock transaction:

1. `lockHitlRow` (FOR UPDATE).
2. `respondedAt` set → compare the stored `response` payload with the incoming
   one: same option+payload → idempotent completion (re-drive any recorded
   unfinished stage, e.g. the raise resume self-heal); different →
   `CONFLICT`. The pre-existing already-delivered branch adopts this
   comparison — today it re-drives a resume for ANY retry payload, which
   would resume a run a concurrent restart is terminal-izing.
3. `respondedAt IS NULL` but `response.stage` present (claimed composite):
   same payload → re-drive from the recorded stage; different payload →
   `CONFLICT`, EXCEPT `stage: "failed"` — a failed claim is re-answerable
   with ANY option (fresh claim overwrites).
4. Otherwise → validate availability (matrix) + payload, then claim:
   raise/abandon keep today's single-tx shape (`respondedAt` immediately,
   side effects in the same tx); restart writes
   `response = {optionId:"restart", stage:"claimed"}` and park writes
   `response = {optionId:"park", ..., stage:"preserving"}` with `respondedAt`
   still NULL. Both set `respondedAt` only at composite completion or explicit
   final failure.

Stage boundary rule: `stage: "failed"` (re-answerable) may only be set BEFORE
the composite's first irreversible side effect — restart: the old-run
terminal CAS; park: the first preservation write. After the boundary,
recovery is same-payload completion only. A restart relaunch failure after
terminalization is FINAL (`respondedAt` set, `stage: "relaunch_failed"`) —
the other options are meaningless on a terminal run.

Read model: pending HITL DTOs expose `claimStage`; the UI disables decision
controls on an actively claimed row (in-progress indicator) and re-enables on
`stage: "failed"`. Needs-you / pending counts EXCLUDE rows with an active
(non-failed) claim stage.

### Raise

Keep the existing path. Add object payload support while preserving the legacy
payload:

- legacy: `{ "optionId": "raise", "raiseTo": 20000 }`
- new: `{ "optionId": "raise", "response": { "dimension": "tokens", "newLimit": 20000 } }`

Validation:

- Dimension defaults to the breached row's `schema.meter`.
- The dimension must match the breached meter unless a future schema explicitly
  lists multiple breached dimensions.
- `newLimit` must be an integer greater than the breached limit.
- Only the mapped field changes:
  `tokens -> maxTokens`, `failures -> consecutiveFailures`,
  `wallclock -> wallClockMinutes`.
- Token hard-ceiling derivation stays in `keepalive-sweeper.ts`; do not add a
  second budget math path.

### Restart

For task-bound flow runs and Q4-allowed top-level worktree agent runs:

1. Validate availability, payload, AND relaunch launchability pre-flight
   (flow: manual classifier semantics incl. ADR-121 blocked/flagged gates —
   NOT the force classifier; agent: the agent-launch admission checks). Any
   refusal → `PRECONDITION`, row untouched.
2. Claim through the shared gate: `hitl_requests.response =
{optionId:"restart", stage:"claimed"}` while `respondedAt IS NULL`.
3. Defensive session stop: resolve the run's ACTIVE session (M42 lookup) and
   `checkpointSession` it if live — NOT `stopRunByKind`, which lands `Review`
   and would break step 4's CAS. Checkpoint 5xx → `stage:"failed"` +
   `EXECUTOR_UNAVAILABLE` surfaced; row re-answerable.
4. Terminalize the old run before launch, CAS-guarded on
   `NeedsInput | NeedsInputIdle` (same guard as today's abandon):
   - flow: status `Failed`, reason `budget_restart`
   - agent: status `Failed`, reason `budget_restart`
   - both emit `run.failed` webhook + domain events with
     `{errorCode: "BUDGET_EXCEEDED", reason: "budget_restart"}` (counted by
     the extended observatory terminations filter)
   - close assignments and promote pending work as the existing terminal path
     does
5. Record task activity: restart requested, old run terminalized.
6. Relaunch through the standard choke point:
   - flow: `launchRun`
   - agent: `launchAgentRun`
7. Omit the old execution-policy snapshot so the new run resolves the current
   policy and starts with zero spend.
8. Preserve original launch identity where server-state exists:
   - flow: `taskId`, `flowId`, active/default runner id, base/target branches
     from workspace and launch snapshots
   - agent: `agentId`, `projectId`, `taskId`, runner override if present,
     `trigger.source = "manual"`, `workspace = "worktree"`
9. If caps are full, the new run may be `Pending` with `queuePosition`; this is
   success.
10. Mark `respondedAt`, close the HITL, and record lineage activity linking
    old run to new run.

Crash windows:

- Failures BEFORE the terminal CAS (pre-flight refusal races, checkpoint 5xx,
  claim contention) → `stage:"failed"`, row re-answerable with ANY option; no
  run state changed.
- If relaunch fails AFTER old-run terminalization (including the residual
  busy/blocked race between pre-flight and launch), do not roll back the
  terminal state. Record activity with the error, surface the error, set
  `respondedAt` with `stage:"relaunch_failed"` (FINAL — other options are
  meaningless on a terminal run), leave the task launchable in Backlog, and
  do not retry in the background.
- A crash mid-composite: a same-payload retry re-drives from the recorded
  stage (claimed → resume at step 3; old run already terminal → resume at
  step 6). Different payloads return `CONFLICT` unless `stage:"failed"`.

### Park

For runs with an owned worktree:

1. Validate availability and payload (export: `branchName` shape + collision
   pre-check).
2. Claim the HITL row through the shared gate with
   `{optionId:"park", mode, stage:"preserving"}` because preservation is the
   first resumable phase.
3. Defensive session stop via `checkpointSession` on the active session (same
   rule as restart step 3 — never `stopRunByKind`).
4. Preserve work before terminalizing:
   - `snapshot`: if dirty, use the existing workbench snapshot commit primitive;
     if clean, proceed and record "clean worktree, no snapshot commit".
   - `export`: validate `branchName`, reject collisions before mutation, then
     use the existing M27 handoff/export branch primitive to publish/copy the
     preserved branch. Dirty work is snapshotted first.
5. Archive the workspace metadata/ref.
6. Terminalize the run as `Abandoned`, CAS-guarded on
   `NeedsInput | NeedsInputIdle`, close assignments, promote pending work,
   and emit `run.abandoned` webhook + domain events with
   `{reason: "budget_parked", ref: <commit sha | exported branch>}`.
7. Mark `respondedAt` and record task activity with commit/branch refs.

Crash windows:

- Preserve must happen before `Abandoned`.
- Failures BEFORE the first preservation write (payload validation races,
  checkpoint 5xx, branch collision detected at git level — the TOCTOU window
  after the pre-claim check) → `stage:"failed"`, row re-answerable with ANY
  option INCLUDING a different `branchName` or abandon.
- If a crash lands after preservation but before terminalization, a same-payload
  retry reads the recorded response/ref and completes terminalization
  idempotently. Different payloads return `CONFLICT` past this boundary.
- If the worktree was already GC'd, `park` is not available and a direct request
  returns `PRECONDITION` without consuming the row.

### Abandon / Discard

Default abandon remains today exactly: bare `{ "optionId": "abandon" }` marks
the run `Failed`, emits `BUDGET_EXCEEDED`, closes assignments, and leaves TTL
cleanup.

With `dropWorkspace: true`, perform default abandon first, then remove the owned
worktree and run branch using existing worktree removal helpers. Do not change
the final run status from `Failed`. Missing/no-workspace cases are no-ops and
are hidden in the UI.

## Progress DTO

Add a computed read-side aggregate. It is never stored and never includes file
contents.

```ts
type BudgetBreachProgressDto = {
  breach: {
    dimension: "tokens" | "failures" | "wallclock";
    limit: number;
    spent: number;
    overshootPct: number;
  };
  budgetByDimension: Partial<
    Record<
      "tokens" | "failures" | "wallclock",
      {
        limit: number | null;
        spent: number | null;
        source: "value" | "no-data";
      }
    >
  >;
  nodes: { completed: number; total: number; currentNodeId: string | null };
  diff: { filesChanged: number; insertions: number; deletions: number } | null;
  gates: { open: number; satisfied: number; failed: number; unknown: number };
  wallclockMinutes: number | null;
  resumeCount: number | null;
};
```

Degradation rules:

- Missing worktree: `diff = null`, not 5xx.
- Missing cost rollup: `spent = null` with `source = "no-data"`, not zero.
- Missing readiness summary: `unknown` increments, not 5xx.
- Missing node ledger: `nodes.total = 0`, `completed = 0`,
  `currentNodeId = null`.

Budget math source: `loadBudgetByDimension` MUST reuse the sweeper's
effective-limit/token-ceiling helpers (export them from
`keepalive-sweeper.ts` if not already exported) — the "no second budget-math
path" rule applies to the read side too.

Availability inputs are DB state only (workspaces row, run status/kind,
`parentRunId`, `agentWorkspace`, `taskId`) — no disk probing on the read
path; the park composite re-verifies the worktree on disk at execution time.

## Task Plan

### Phase 0 - SDD Contracts RED

#### T0.1 Reserve docs and migration contract

Files:

- `docs/decisions.md`
- `docs/system-analytics/execution-policy.md`
- `docs/system-analytics/hitl.md`
- `docs/system-analytics/workbench-lifecycle.md`
- `docs/api/web.openapi.yaml`
- `docs/api/external/operations.openapi.yaml`
- `docs/screens/inbox.md` + `docs/screens/runs/flow-run.md` (new progress
  block + four-option decision surface)
- `docs/system-analytics/observatory.md` if it names the terminations reasons
- `docs/database-schema.md` only if the migration decision needs an explicit
  "no migration" note

Work:

- Re-run ADR max and reserve ADR-125 or renumber if active reservations changed.
- Write the ADR: four-way fork, compatibility rule, availability matrix,
  Q4 agent-worktree restart guard, park terminal status, ext/MCP non-opening,
  non-goals, crash-window strategy, the shared claim gate + stage boundary
  rule, and the events/metrics decision (budget_restart + budget_abandoned
  counted in observatory terminations; budget_parked excluded).
- Update system analytics:
  - execution policy: budget fork, dimensions, restart fresh policy snapshot,
    progress DTO, slot semantics.
  - HITL: response schema, row claim, idempotency/retry rules, actor limits.
  - workbench lifecycle: budget park/drop composites and their relationship to
    existing M27 primitives.
- Update web OpenAPI for the session-auth route.
- Correct external OpenAPI text to match current code: budget breaches remain
  unavailable to token actors in this change (and the same stale sentence's
  `infra_recovery` claim).
- Update the screen docs for the inbox card and run-detail HITL panel.
- Record explicit migration decision: no DB migration.

Logging: docs must name the structured log fields each composite emits.

RED check:

- `pnpm validate:docs` must pass after docs changes.
- Add or update OpenAPI schema examples before implementation tests are green.

#### T0.2 Add failing contract and service tests

Files:

- EXTEND `web/lib/services/__tests__/hitl-budget-breach.integration.test.ts`
- EXTEND `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/__tests__/route.test.ts`
- NEW `web/lib/runs/__tests__/budget-breach-options.test.ts`
- NEW `web/lib/queries/__tests__/hitl-budget-context.test.ts`
- EXTEND `web/components/board/__tests__/hitl-decision-controls.test.ts`
- EXTEND `web/components/board/__tests__/run-hitl-response.test.ts`
- EXTEND `web/components/inbox/__tests__/hitl-card.test.ts`
- NEW `web/e2e/budget-breach-fork.spec.ts`

Render tests keep the existing `.test.ts` renderToStaticMarkup convention —
no `.test.tsx` files.

Work:

- Write failing tests for all AC and edge cases before implementation.
- Do not create low-value snapshots. Every render test must assert a contract:
  available options, hidden unavailable controls, localized labels, destructive
  confirmation, or branch input behavior.

Logging: tests assert log/audit/activity data where the feature depends on it,
not generic "called logger" behavior.

### Phase 1 - Availability, Schema, and Progress GREEN

#### T1.1 Create the budget breach contract helpers

Files:

- `web/lib/runs/budget-breach-fork.ts` (new)
- `web/lib/services/hitl.ts`
- `web/lib/db/schema.ts` only for exported TS types if needed

Identifiers:

- `BudgetBreachDecision`
- `BudgetBreachResponsePayload`
- `BudgetBreachAvailableOption`
- `BudgetBreachAvailabilityContext`
- `getBudgetBreachAvailableOptions`
- `parseBudgetBreachResponse`
- `assertBudgetBreachOptionAvailable`
- `budgetMeterToPolicyField`
- `BudgetBreachClaimStage`
- `evaluateBudgetBreachClaim` (shared gate verdict: fresh | re-drive |
  idempotent | conflict | re-claimable)

Work:

- Centralize option parsing, legacy compatibility, availability predicates, and
  meter-field mapping.
- Implement the shared claim gate (stored-payload comparison for
  already-delivered rows, stage rules incl. `failed` re-claim) used by ALL
  four options.
- Make both read-side rendering and respond-side guard call the same helper.
- Return `PRECONDITION` for unavailable options before row claim.

Logging: helper returns structured denial reasons for respond logs and tests.

Tests:

- Unit: all matrix rows, including Q4 agent worktree restart and orchestrator
  child denial.
- Unit: legacy raise payload, object raise payload, bare abandon payload.
- Unit: claim gate — same-payload retry idempotent/re-drive, different-payload
  `CONFLICT` (both against a claimed stage and against a responded row),
  `stage:"failed"` re-claimable with any option.

#### T1.2 Extend the route body schema

Files:

- `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts`
- `docs/api/web.openapi.yaml`

Work:

- Accept legacy `raiseTo`.
- Accept `response` object for `raise`, `park`, and `abandon`.
- Accept `dropWorkspace` both top-level and inside `response` for tolerant
  compatibility, canonicalizing to one internal shape.
- Keep confidence ignored for decision kinds.

Logging: log only option ids and numeric limits, never arbitrary response text.

Tests:

- Route unit: new payloads pass zod.
- Route unit: invalid branch payload and invalid new limit return typed errors.

#### T1.3 Add the progress DTO service

Files:

- `web/lib/queries/budget-breach-progress.ts` (new)
- `web/lib/queries/hitl.ts`
- `web/lib/queries/inbox-context.ts`
- `web/app/api/runs/[runId]/inbox-context/route.ts`
- `web/app/(app)/runs/[runId]/layout.tsx`

Identifiers:

- `BudgetBreachProgressDto`
- `loadBudgetBreachProgress`
- `loadBudgetByDimension`
- `loadBudgetNodeProgress`
- `loadBudgetDiffSummary`
- `loadBudgetGateSummary`

Work:

- Compute progress on read for pending `budget_breach` rows.
- Reuse existing node ledger, diff, gate/readiness, cost rollup, and run session
  data where available.
- Add `availableOptions`, `budgetProgress`, and `claimStage` to pending HITL
  DTOs; exclude actively-claimed (non-failed) rows from needs-you/pending
  counts.
- Reuse the sweeper's exported effective-limit helpers for
  `loadBudgetByDimension` — no budget-math reimplementation.
- Degrade field-by-field.

Logging: warn with structured fields only for degraded sources that indicate
unexpected state; expected GC/missing-data is a DTO value, not an error log.

Tests:

- Unit: full-source DTO.
- Unit: GC'd worktree gives `diff = null`.
- Unit: missing cost rollup gives `source = "no-data"`.
- Integration: breach numbers match the sweeper-stamped schema limit/current.

### Phase 2 - Existing Raise and Default Abandon GREEN

#### T2.1 Preserve raise behavior and add per-dimension raise

Files:

- `web/lib/services/hitl.ts`
- `web/lib/runs/keepalive-sweeper.ts` only if schema option metadata changes
- `web/lib/services/__tests__/hitl-budget-breach.integration.test.ts`

Work:

- Keep current legacy behavior byte-compatible on the wire.
- Route raise/abandon through the shared claim gate; the already-delivered
  retry branch now compares the stored decision (different option →
  `CONFLICT`, no resume re-drive).
- Use shared parser and meter mapping.
- Validate wallclock rows as minutes without changing token ceilings.
- Preserve existing raise resume paths for `NeedsInput` and `NeedsInputIdle`.

Logging: keep `budget_raised` audit and add `meter`, `field`, `oldLimit`,
`newLimit`.

Tests:

- AC-1 legacy integer raise.
- AC-7 flow/agent live and idle resume paths.
- Edge: wallclock raise updates only `wallClockMinutes`.
- Regression: raise retry after a completed/claimed DIFFERENT option →
  `CONFLICT`, no resume re-drive.

#### T2.2 Preserve abandon and add drop flag

Files:

- `web/lib/services/hitl.ts`
- `web/lib/workbench-lifecycle/service.ts` only to expose a narrow removal
  helper if needed
- `web/lib/worktree.ts` only if an existing removal helper needs an exported
  wrapper

Work:

- Bare abandon stays `Failed` with today's events/audit.
- `dropWorkspace: true` performs post-terminal owned worktree/branch removal
  without changing status.
- No-workspace drop is a no-op and is not rendered by UI.

Logging: log `dropRequested`, `workspaceFound`, `branchRemoved`,
`worktreeRemoved`.

Tests:

- AC-1 bare abandon exact behavior.
- AC-4 drop true removes worktree/branch.
- AC-4 drop false leaves worktree for TTL.
- Edge: agent none/repo_read drop request is no-op and does not crash.

### Phase 3 - Restart Composite GREEN

#### T3.1 Build launch-option recovery

Files:

- `web/lib/runs/budget-breach-restart.ts` (new)
- `web/lib/services/runs.ts`
- `web/lib/agents/launch.ts`
- `web/lib/runs/active-run-session.ts`

Identifiers:

- `recoverBudgetRestartLaunchInput`
- `recoverFlowBudgetRestartInput`
- `recoverAgentBudgetRestartInput`

Work:

- Recover flow launch inputs from server state: task, flow, active/default
  runner, workspace base/target branches, delivery policy fields that are
  needed by `launchRun`.
- Recover agent launch inputs from server state: `agentId`, `projectId`,
  `taskId`, runner override, `workspace = "worktree"`, manual trigger payload.
- Do not pass old `executionPolicy`; fresh policy resolution is required.
- Use standard launch functions only.

Logging: log recovered option keys and omitted policy snapshot explicitly.

Tests:

- Unit: flow recovery.
- Unit: agent-worktree recovery.
- Unit: missing required server-state fails `PRECONDITION`.

#### T3.2 Implement restart response

Files:

- `web/lib/services/hitl.ts`
- `web/lib/runs/budget-breach-restart.ts`
- `web/lib/services/tasks.ts` or existing activity/comment service
- `web/lib/queries/observatory.ts` (terminations reason filter:
  - `budget_restart`, + `budget_abandoned`)
- `web/lib/scheduler.ts` only if a public promotion helper is missing

Work:

- Launchability pre-flight before claim (manual classifier, ADR-121 gates).
- Claim row exactly once through the shared gate.
- Defensive `checkpointSession` on the active session (never
  `stopRunByKind`).
- Terminalize old run (CAS from `NeedsInput*`, `run.failed` with
  `budget_restart`) before launching new run.
- Relaunch through `launchRun` or `launchAgentRun`.
- Extend the observatory `budgetTerminations` reason filter with
  `budget_restart` and `budget_abandoned`.
- Record lineage activity/comment.
- Mark `respondedAt` only after the composite reaches a durable terminal or
  explicit failure state.
- Same-payload retry may re-drive a claimed restart stage; conflicting payload
  returns `CONFLICT` unless `stage:"failed"` (pre-boundary failure →
  re-answerable); relaunch failure after terminalization is FINAL
  (`stage:"relaunch_failed"`, `respondedAt` set).

Logging: log each composite stage and final result.

Tests:

- AC-2 flow restart: old run terminal, task auto-returned then relaunched,
  attempt N+1, fresh policy snapshot, zero spend.
- AC-2 cap-full: new run `Pending` with queue position and HITL resolved.
- Edge: crash after terminalize before relaunch leaves old terminal and task
  Backlog; explicit retry behavior is deterministic.
- Edge: another live run appears meanwhile; ADR-119 `allowConcurrent` semantics
  decide, with documented result.
- Q4: top-level task-bound worktree agent restart launches a fresh agent run.
- Matrix: orchestrator-child, scratch, none/repo_read agent reject restart
  without consuming the row.
- Pre-flight: blocked/flagged/busy task refuses `PRECONDITION` BEFORE claim;
  row intact, old run untouched.
- Observatory: `budget_restart` and `budget_abandoned` counted in
  `budgetTerminations`; `budget_parked` not counted.

### Phase 4 - Park Composite GREEN

#### T4.1 Expose budget-specific preserve primitives

Files:

- `web/lib/workbench-lifecycle/service.ts`
- `web/lib/workbench-lifecycle/policy.ts`
- `web/lib/runs/budget-breach-park.ts` (new)

Identifiers:

- `parkBudgetBreachRun`
- `snapshotBudgetBreachWorktree`
- `exportBudgetBreachBranch`
- `archiveBudgetBreachWorkspace`

Work:

- Reuse existing M27 git/workbench operations for snapshot, handoff/export
  branch, archive metadata, and worktree inspection.
- Add a budget-specific preserve-then-`Abandoned` composite rather than using
  generic `stopThenArchive`, because generic flow stop lands `Review`.
- Clean worktree snapshot mode records "nothing to commit" and proceeds.
- Export mode validates `branchName`, rejects collisions, snapshots dirty work,
  and records the exported ref.

Logging: log `mode`, `dirty`, `commitSha`, `branchName`, `archiveId`.

Tests:

- AC-3 snapshot with dirty work creates commit/ref and run `Abandoned`.
- Edge: snapshot with clean worktree archives and records no-op snapshot.
- AC-3 export branch collision returns `PRECONDITION`/`CONFLICT` and does not
  consume HITL.
- Edge: GC'd worktree hides park and direct request fails before claim.

#### T4.2 Wire park response

Files:

- `web/lib/services/hitl.ts`
- `web/lib/runs/budget-breach-park.ts`

Work:

- Claim row exactly once through the shared gate after validation.
- Defensive `checkpointSession` on the active session (never
  `stopRunByKind`).
- Preserve work product before terminal status update.
- Pre-preservation failure → `stage:"failed"` (re-answerable, incl. a
  different `branchName` or abandon).
- Close assignments, promote pending, mark `respondedAt`, record task activity.
- Implement same-payload retry for claimed preserve stages.

Logging: log composite stages and preserved refs.

Tests:

- AC-3 snapshot/export success.
- Matrix park success/failure cells.
- Edge: response after manual stop returns existing stale-HITL
  `PRECONDITION`/`CONFLICT`, not a crash.
- Edge: post-claim pre-preservation failure sets `stage:"failed"`; a retry
  with a different `branchName` (or abandon) re-claims and succeeds.

### Phase 5 - UI and i18n GREEN

#### T5.1 Render server-computed options and progress

Files:

- `web/components/board/hitl-decision-controls.tsx`
- `web/components/board/run-hitl-response.tsx`
- `web/components/inbox/hitl-card.tsx`
- `web/app/(app)/runs/[runId]/layout.tsx`
- `web/messages/en.json`
- `web/messages/ru.json`

Work:

- Render budget progress in both inbox and run-detail HITL panels.
- Render only server-provided budget options.
- Use icon + label buttons and helper text for all options.
- Add branch-name input only for `park/export`.
- Add destructive confirmation for `abandon` with `dropWorkspace`.
- Render the claimed-in-progress state (controls disabled, progress hint) and
  re-enable controls on `claimStage: "failed"` with the recorded error.
- Preserve legacy raise UX while sending the canonical object payload when
  possible.
- Add EN and RU strings for every new label/helper/error.

Logging: none in components; client must not log payload contents.

Tests:

- AC-5 UI consumes `availableOptions`; no duplicated matrix logic.
- AC-6 progress block renders full and degraded DTOs.
- AC-8 both locales render new labels.
- Edge: drop is hidden for no-workspace rows; park hidden for GC'd worktree.
- Edge: claimed row renders disabled controls; `failed` stage re-enables.

#### T5.2 Submit new actions from the UI

Files:

- `web/components/board/run-hitl-response.tsx`
- `web/components/board/hitl-decision-controls.tsx`

Work:

- Submit canonical payloads:
  - raise: `{optionId:"raise", response:{dimension,newLimit}}`
  - restart: `{optionId:"restart", response:{}}`
  - park snapshot: `{optionId:"park", response:{mode:"snapshot"}}`
  - park export: `{optionId:"park", response:{mode:"export", branchName}}`
  - abandon drop: `{optionId:"abandon", response:{dropWorkspace:true}}`
- Keep bare abandon path for compatibility.

Logging: none in components.

Tests:

- Render/unit tests assert request payload builder output.
- E2E uses stub supervisor to raise from inbox and confirms run-detail
  mirrors, exercised in BOTH locales (cookie toggle inside the spec).

### Phase 6 - Acceptance, Refactor, and Validation

#### T6.1 Refactor after green

Files:

- All touched implementation files.

Work:

- Remove duplication between service guards and read model.
- Keep helper functions single-purpose and typed.
- Keep comments only where they explain a non-obvious crash/idempotency window.

Logging: verify log fields are structured and no file contents or secrets are
logged.

Tests:

- Re-run targeted unit/integration suites after refactor.

#### T6.2 Final validation

Commands:

- `git --no-pager diff --check`
- `pnpm --filter maister-web typecheck`
- `pnpm validate:docs`
- `pnpm --filter maister-web test:unit`
- `pnpm --filter maister-web test:integration`
- `pnpm --filter maister-web test:e2e -- budget-breach-fork.spec.ts`

If E2E infrastructure is unavailable locally, record the exact failure and keep
unit/integration validation green.

## Traceability Matrix

| Requirement                        | Tasks                                    | Tests                                                                                                                            |
| ---------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| FR-1 four-option response contract | T0.1, T1.1, T1.2, T2.1, T2.2, T3.2, T4.2 | route schema tests, service matrix tests, AC-1, AC-5                                                                             |
| FR-2 restart fresh                 | T3.1, T3.2                               | AC-2, crash-window restart, concurrent-live-run edge, Q4 agent test                                                              |
| FR-3 park                          | T4.1, T4.2                               | AC-3, clean worktree edge, GC'd worktree edge                                                                                    |
| FR-4 discard/drop                  | T2.2                                     | AC-4, no-workspace drop edge                                                                                                     |
| FR-5 progress DTO                  | T1.3                                     | AC-6 full/degraded/integration                                                                                                   |
| FR-6 UI                            | T5.1, T5.2                               | AC-5, AC-8 render/e2e                                                                                                            |
| FR-7 ext/MCP parity                | T0.1, T2.1                               | machine-actor denial assertion in `hitl-budget-breach.integration.test.ts` (api_token → UNAUTHORIZED), OpenAPI correction review |
| FR-8 audit/events                  | T2.1, T2.2, T3.2, T4.2                   | activity/audit assertions in AC-2, AC-3, AC-4 + observatory terminations filter test                                             |
| AC-1 compat                        | T2.1, T2.2                               | legacy raise and bare abandon integration                                                                                        |
| AC-2 restart                       | T3.1, T3.2                               | mock-adapter integration and cap-full integration                                                                                |
| AC-3 park                          | T4.1, T4.2                               | worktree integration                                                                                                             |
| AC-4 discard                       | T2.2                                     | drop and non-drop integration                                                                                                    |
| AC-5 matrix                        | T1.1, T5.1                               | server matrix unit/integration and UI render tests                                                                               |
| AC-6 progress DTO                  | T1.3, T5.1                               | DTO unit/integration and render tests                                                                                            |
| AC-7 resume paths                  | T2.1                                     | extended existing sweeper/hitl integration                                                                                       |
| AC-8 e2e                           | T5.1, T5.2                               | `web/e2e/budget-breach-fork.spec.ts`                                                                                             |
| AC-9 docs                          | T0.1                                     | `pnpm validate:docs`, OpenAPI lint/check                                                                                         |

## Edge Case Coverage

| Edge case                                                       | Owning task      | Owning test                                                  |
| --------------------------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| Double-respond race over new options                            | T1.1, T3.2, T4.2 | integration row-claim race                                   |
| Crash between terminalize and relaunch                          | T3.2             | restart crash-window integration                             |
| Restart when task meanwhile has another live run                | T3.2             | ADR-119 allowConcurrent integration                          |
| Park/snapshot clean worktree                                    | T4.1             | clean snapshot no-op integration                             |
| Park on GC'd worktree                                           | T4.1             | availability + guard integration                             |
| Wallclock raise                                                 | T2.1             | seeded wallclock HITL integration                            |
| Orchestrator-child breach                                       | T1.1             | matrix guard test                                            |
| Agent none/repo_read breach                                     | T1.1, T2.2, T5.1 | matrix + UI hidden drop/park test                            |
| Response after manual stop elsewhere                            | T4.2             | stale HITL conflict/precondition test                        |
| Concurrent DIFFERENT-option respond vs claimed/responded row    | T1.1, T2.1       | shared-gate CONFLICT race integration (raise-during-restart) |
| Claimed-in-progress row in inbox (needs-you + controls)         | T1.3, T5.1       | claim-stage count exclusion + disabled-controls render test  |
| Post-claim pre-preservation failure → re-claim with new payload | T4.1, T4.2       | stage-failed re-claim integration                            |
| Blocked/flagged/busy task at restart pre-flight                 | T3.2             | pre-claim PRECONDITION test (row + old run intact)           |

## Self-Checks

### Pass 1 - Completeness

- Every FR maps to at least one task and one test in the traceability matrix.
- Every AC maps to at least one task and one test in the traceability matrix.
- Availability matrix rows are covered by T1.1 unit tests and at least one
  integration group per success/failure category.
- Touched files and identifiers are listed verbatim in task sections.
- Docs, OpenAPI, UI, service, composite actions, and validation commands are all
  represented.

### Pass 2 - Consistency

- Respond route schema, `docs/api/web.openapi.yaml`, service parser, and UI
  payload builders all use the same option ids:
  `raise | restart | park | abandon`.
- UI renders from server-computed `availableOptions`; server guard uses the same
  helper, so unavailable options cannot be UI-only or server-only.
- Terminal statuses are explicit:
  - raise: remains `NeedsInput`/resume-in-progress until runner reclaims
  - restart old run: `Failed`
  - restart new run: `Running` or `Pending`
  - park: `Abandoned`
  - abandon: `Failed`
- No new DB enum/status/domain-event/SSE kinds are introduced.
- Ext/MCP contract is not widened; stale external docs are corrected to match
  code (both `budget_breach` and `infra_recovery` in the same sentence).
- Observatory terminations metric counts `budget_restart` + `budget_abandoned`
  (run.failed reasons); `budget_parked` (run.abandoned) intentionally excluded
  — recorded in the ADR.
- `claimStage` is exposed consistently: OpenAPI pending-HITL DTO ↔ read model
  ↔ UI disabled/failed rendering.

### Pass 3 - No Logical Holes

- Each composite has a stated claim order, side-effect order, idempotent retry
  behavior, and crash-window result.
- Invalid or unavailable options are rejected before claim, preserving the HITL
  row.
- Preservation happens before park terminalization.
- Old restart run is terminal before the new launch is attempted.
- Relaunch failure after terminalization leaves a consistent Backlog state and
  does not silently retry.
- Progress DTO degrades per field and never exposes file contents or secrets.
- ONE claim gate covers all four options: the already-delivered branch compares
  stored payloads, so a cross-option retry/race can never re-drive a stale
  resume while a composite is mid-flight.
- Composites never route through `stopRunByKind` — the terminal CAS statuses
  (`NeedsInput | NeedsInputIdle`) stay reachable by construction.
- `stage:"failed"` is only reachable before the first irreversible side effect;
  afterwards recovery is same-payload completion only — no lock-in on a
  deterministically failing payload, and no re-answering a terminal run.
- Restart pre-flight launchability runs before claim, so a blocked/flagged/busy
  task never loses its old run to a doomed restart; the residual race lands in
  the FINAL `relaunch_failed` path with the task still launchable.

## Commit Plan

1. `docs: specify budget breach fork`
   - ADR, system analytics, OpenAPI, external contract correction.
2. `test: cover budget breach fork contract`
   - Failing service, route, DTO, render, and e2e tests.
3. `feat: add budget breach option guard and progress dto`
   - Shared helpers, read model, DTO.
4. `feat: preserve budget raise and discard compatibility`
   - Raise compatibility, per-dimension raise, dropWorkspace.
5. `feat: restart and park budget breach runs`
   - Restart/park composites, workbench integration, and the observatory
     terminations-filter extension.
6. `feat: render budget breach decision surface`
   - UI, i18n, e2e.
7. `refactor: tighten budget breach fork helpers`
   - Post-green cleanup only.
