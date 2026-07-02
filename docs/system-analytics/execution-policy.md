# Flow execution-control policy domain

> **Status: Implemented (2026-06-20).** The preset + ten composable axes, the
> immutable launch snapshot (`runs.execution_policy`), the fail-closed
> `*FromSnapshot` resolvers, the no-blind-ship guard, and all A/B/C/spend axis
> mechanisms are shipped. Locked decisions:
> [ADR-095](../decisions.md#adr-095-flow-execution-control-policy--snapshotted-preset--composable-autonomy-axes-fail-closed-no-blind-ship)
> and [ADR-101](../decisions.md#adr-101-cost-budget-governance--budget-execution-policy-axis-token-metered-warn-escalate-terminate-ladder-fail-open) (budget axis).
> Migrations `0055` (policy columns) + `0056` (`run.escalated` kind) +
> `0061` (`runs.budget_state`, the budget axis).

## Purpose

The execution policy is the contract that decides **where a flow run acts on its
own** — across machine self-correction (Group A), human escalation (Group B),
output shaping (Group C), and spend governance (the `budget` axis) — and the
discipline that keeps autonomy from ever silently shipping unvalidated work. A run
carries a `preset` that expands to ten axes (each overridable), resolved once and
snapshotted onto `runs.execution_policy` at launch; every consumer reads that
immutable snapshot through a fail-closed resolver — except `budget`, which alone
fails **open** (`(Implemented)`, ADR-101). `supervised` is today's behaviour —
nothing changes for an existing launch.

Domain boundary: the policy type + preset table + resolvers
(`web/lib/runs/execution-policy.ts`), the launch resolution/snapshot/authz
(`web/lib/services/runs.ts`), and the per-axis enforcement sites in the flow
engine, the supervisor, and the promote/delivery path. Out of scope: gate
_execution_ (M11a — [`flow-graph.md`](flow-graph.md)), readiness
(M15 — [`readiness.md`](readiness.md)), the delivery policy's merge _mechanics_
(ADR-058/077 — [`outbound-webhooks.md`](outbound-webhooks.md) /
[`workspaces.md`](workspaces.md)), and the HITL substrate
([`hitl.md`](hitl.md)).

## Domain entities

- **`ExecutionPolicy`** — `{ preset, overrides? }`; the preset expands to the
  ten axes, overrides fold on top. Persisted as open jsonb on
  `runs.execution_policy` (snapshot), `projects.execution_policy_default`,
  `tasks.execution_policy` (defaults). See
  [`db/runs-domain.md`](../db/runs-domain.md).
- **Resolvers** — one fail-closed `<axis>FromSnapshot(snapshot)` per consumed
  axis; a null/absent/malformed snapshot resolves to the SAFE default.
- **`logExecPolicyAction`** — the typed audit boundary every autonomy action
  funnels through (`launched | check_downgraded | rework_exhausted |
ralph_relaunch | escalated | permission_auto_approved | human_gate_auto_passed |
dirty_auto_resolved | history_rewritten`).
- **`run.escalated`** — domain-event + webhook kind emitted on an on-stuck route
  (B3) AND on a budget escalate (`reason=budget_exceeded`, no new kind — ADR-101).
  See [`domain-events.md`](domain-events.md) +
  [`outbound-webhooks.md`](outbound-webhooks.md).
- **`budget` axis** — **(Implemented, ADR-101)** the tenth axis: token /
  consecutive-failure / wall-clock ceilings at `run` / `task` / `tree` scope,
  enforced by a warn → escalate → terminate ladder over `run_cost_rollups`. Its
  resolved `BudgetAxis` rides the same `runs.execution_policy` snapshot; the
  per-run mutable raise-and-resume override + per-scope `notified` rung live on
  `runs.budget_state jsonb` (migration `0061`). Breach actions funnel through
  `logExecPolicyAction` as `budget_warned | budget_escalated | budget_terminated |
budget_raised`; a hard-cap terminate fails the run with
  `MaisterError("BUDGET_EXCEEDED")` and opens a `budget_breach` HITL on escalate.
  See [`hitl.md`](hitl.md) + [`../error-taxonomy.md`](../error-taxonomy.md).

## Preset → axes

No preset alone trips the no-blind-ship guard: `checks` stays `strict` at every
level, so auto-pass / auto-promote always sit behind at least one validation
layer.

| Axis (group)            | `supervised`      | `assisted`        | `unattended`      |
| ----------------------- | ----------------- | ----------------- | ----------------- |
| `reworkExhaustion` (A1) | escalate          | escalate          | escalate          |
| `crashRetry` (A2)       | fail              | fail              | ralph_loop        |
| `checks` (A3)           | strict            | strict            | strict            |
| `permissions` (B1)      | ask               | auto_approve      | auto_approve      |
| `humanGate` (B2)        | stop              | stop              | auto_pass         |
| `onStuck` (B3)          | escalate          | escalate          | escalate          |
| `promotion` (C1)        | manual            | manual            | auto_on_ready     |
| `commits` (C2)          | keep_all          | keep_all          | squash_rework     |
| `dirtyResolve` (C3)     | ask               | proceed           | proceed           |
| `budget` (spend)        | unset (unlimited) | unset (unlimited) | unset (unlimited) |

The `budget` axis (Implemented, ADR-101) defaults to **all-unset (unlimited)** at
every preset — fail-open, "run, don't constrain". `unattended` is OPTIONALLY
env-defaulted: when `MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS` is set it seeds a
tree-scope token ceiling for an unattended launch with no explicit budget; the
launch dialog also shows a non-blocking hint in that case (never a refusal).

## State machine — `checks` strictness on a non-review gate (A3)

The check axis only relaxes the **promotion-block** of the non-review check
gates (`command_check | skill_check | artifact_required | external_check`); the
judge/`human_review` rework loop is never touched.

```mermaid
stateDiagram-v2
    [*] --> strict
    strict --> Blocking: gate failed/stale blocks Review
    advisory --> Recorded: verdict surfaced, does NOT block
    skip --> NotEvaluated: gate not run
    Blocking --> [*]
    Recorded --> [*]
    NotEvaluated --> [*]
```

## Process flow — human gate (B2 auto-pass + B3 on-stuck routing)

When a review gate is reached, the disposition is pure
(`resolveHumanGateDisposition`); only `auto_pass` consults
`assertEvidenceReady`. The safe default is the forward (non-rework) decision.

```mermaid
flowchart TD
    A[Review gate reached in runReviewHuman] --> B{humanGate}
    B -->|stop| P[Pause: HITL request + assignment + NeedsInput]
    B -->|auto_pass| C{safe default AND assertEvidenceReady ready}
    C -->|yes| D[Auto-pass: markNodeSucceeded with forward decision]
    C -->|no - stuck| E{onStuck}
    E -->|escalate| P2[Pause + assignment + emit run.escalated]
    E -->|ship_with_warning| F[Forward decision + warning + emit run.escalated]
    E -->|notify_only| G[Pause WITHOUT assignment + emit run.escalated]
```

## Process flow — output shaping at promote (C1 + C2)

```mermaid
flowchart TD
    R[Run reaches Review] --> AD[deliverRunIfAutoReady]
    AD --> T{delivery.trigger auto_on_ready OR promotion auto_on_ready}
    T -->|no| M[Stay Review - manual promote]
    T -->|yes| RG{assertEvidenceReady ready}
    RG -->|no| M
    RG -->|yes| SQ{commits squash_rework or squash_on_promote}
    SQ -->|yes| S[squashRunBranch: collapse base..HEAD, tree-preserving]
    SQ -->|no| MG[merge or PR]
    S -->|tree drift or git error| K[revert to old HEAD - keep_all]
    S --> MG
    K --> MG
    MG --> Done[Done]
```

## Process flow — budget ladder (warn → escalate → terminate)

The budget axis meters token spend (`run_cost_rollups`), consecutive failures,
and tree wall-clock against the effective per-scope limits each watchdog tick,
and climbs a warn → escalate → terminate ladder; an unset or `0` meter is skipped
(fail-open). `run`/`task` scope ESCALATE pauses a run to `NeedsInput` or
`NeedsInputIdle` with a `budget_breach` HITL and the worktree kept when the run
kind has a resumable path. `tree` scope has NO escalate rung — a
`WaitingOnChildren` root has no `→ NeedsInput` transition, so it goes straight to
a cascade-terminate.

```mermaid
stateDiagram-v2
    [*] --> UnderWarn: meter below warnAtPct
    UnderWarn --> Warn: spend or failures or wallclock >= warnAtPct (80%)
    Warn --> Escalate: supported run/task breach >= 100% limit
    UnderWarn --> Escalate: supported run/task breach >= 100% limit
    Warn --> Terminate: hard limit, OR unsupported run/task breach
    UnderWarn --> Terminate: unsupported run/task breach
    Escalate --> Terminate: tokens >= hardMaxTokens after resume
    UnderWarn --> TreeTerminate: tree tokens or wallclock breach (no escalate rung)
    Warn --> TreeTerminate: tree tokens or wallclock breach (no escalate rung)
    Escalate --> Resumed: Raise and resume — ceilingOverride raised
    Escalate --> Restarted: Restart fresh — old run Failed, new attempt launched
    Escalate --> Parked: Park result — preserved ref, run Abandoned
    Resumed --> UnderWarn: notified cleared, re-warns in the raised band
    Escalate --> Abandoned: Discard — run Failed (BUDGET_EXCEEDED)
    Warn --> UnderWarn: continues running (warn does not kill)
    Terminate --> [*]: run terminal Failed (BUDGET_EXCEEDED)
    TreeTerminate --> [*]: cascadeAbandonRunTree then root Failed
    Restarted --> [*]
    Parked --> [*]
    Abandoned --> [*]
```

### Budget-breach decision surface

When the watchdog opens `budget_breach`, the operator chooses from a
server-guarded four-way fork (ADR-125):

| Option           | Effect                                                                                                                                                                                                                                                   | Availability                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Raise & continue | Increase `runs.budget_state.ceilingOverride[scope][field]`, clear `notified[scope]`, then resume through the existing flow/agent resume path.                                                                                                            | Every valid `budget_breach` row.                                                          |
| Restart fresh    | Terminalize the old run as `Failed` with `reason=budget_restart`, then relaunch the same task through `launchRun` or `launchAgentRun` without the old policy snapshot. The new attempt resolves the current execution policy and starts with zero spend. | Top-level task-bound flow runs and top-level task-bound `agent` worktree runs.            |
| Park the result  | Snapshot or export the owned worktree, archive the preserved ref, then mark the run `Abandoned` with `reason=budget_parked`.                                                                                                                             | Runs with an owned worktree row; not orchestrator children or `agent` `none`/`repo_read`. |
| Discard          | Today's abandon behavior: run `Failed`, `BUDGET_EXCEEDED`, TTL cleanup. With `dropWorkspace:true`, remove the owned worktree and run branch after the terminal update.                                                                                   | Every valid `budget_breach` row; drop is hidden/no-op without a worktree.                 |

The response row uses one shared staged claim gate. Legacy raise and abandon set
`respondedAt` immediately as before. Restart first stores
`response.stage="claimed"` with `respondedAt IS NULL`; park enters directly at
`response.stage="preserving"` because preservation is its first resumable phase.
The marker is written only after the composite reaches durable success or a
final post-terminal failure. Pre-boundary failures set `stage:"failed"` and are
re-answerable. Active non-failed claims are excluded from needs-you counts and
render disabled controls.

The card DTO embeds a computed `BudgetBreachProgressDto`: breached dimension,
limit, spent, overshoot, per-dimension budget observations with
`source:"value"|"no-data"`, node progress, diff numstat or `null`, gate counts,
wall-clock minutes, and resume count. It is computed on read and never stores or
returns file contents. Missing worktree, rollup, gate, or ledger data degrades
field-by-field instead of returning 5xx.

## Expectations

- The resolved policy MUST be snapshotted onto `runs.execution_policy` at launch
  and read from that snapshot for the run's life; resume/recover/finalize NEVER
  re-resolve from a mutable default.
- Every `<axis>FromSnapshot` resolver MUST return the SAFE default on a null /
  absent / malformed snapshot (`checks→strict`, `crashRetry→fail`,
  `reworkExhaustion→escalate`, `permissions→ask`, `humanGate→stop`,
  `onStuck→escalate`, `promotion→manual`, `commits→keep_all`, `dirtyResolve→ask`).
- **(Implemented — ADR-118)** A loop node declaring `rework.onExhaustion` OVERRIDES
  the `reworkExhaustion` (A1) axis at that node: on `effective > maxLoops` the
  runner routes via `transitions[<onExhaustion>]` (typically to a `human` node)
  instead of invoking `reworkExhaustionFromSnapshot`. When `onExhaustion` is
  absent the A1 action (`fail`/`escalate`/`ship_with_warning`) applies unchanged.
  This is author-scoped per-loop, distinct from the run-scoped A1 axis. See
  [`flow-graph.md`](flow-graph.md).
- A launch whose resolved policy is a blind ship (relaxed `checks` + auto-pass
  human gate OR auto-promote) MUST be rejected with `MaisterError("PRECONDITION")`
  by `assertNoBlindShip`, server-side, before the run row is created.
- Any non-`supervised`-floor policy (auto_pass / auto_on_ready / relaxed checks /
  non-escalate on-stuck) MUST require the `launchUnattended` project action
  (≥ member); a viewer NEVER launches it.
- `humanGate=auto_pass` MUST auto-resolve a gate only when
  `assertEvidenceReady("review")` is ready AND a forward (non-rework) safe-default
  decision exists; otherwise it routes per `onStuck`, never silently passing.
- `crashRetry=ralph_loop` MUST relaunch at most `MAISTER_RALPH_MAX_ATTEMPTS`
  total attempts per task and MUST be idempotent under at-least-once redelivery
  (a relaunch fires only for the task's current latest flow run).
- `commits` squash MUST be tree-preserving: the post-rewrite `HEAD^{tree}` SHA
  equals the pre-rewrite SHA, else the branch reverts to its original HEAD and
  promotion proceeds on the unmodified history (`keep_all`). A botched history
  NEVER promotes. The squash runs pre-promotion for merge, rebase-merge, AND
  pull-request strategies (a PR branch is force-updated with `--force-with-lease`
  whenever the commit policy squashes — derived from the immutable policy, NOT a
  per-attempt squash result, so a reclaim after a transient push failure still
  force-updates the already-rewritten branch).
- `crashRetry=auto_retry` MUST re-dispatch a failed `retry_safe` node IN-RUN on a
  transient code (`SPAWN`/`EXECUTOR_UNAVAILABLE`/`CHECKPOINT`/`ACP_PROTOCOL`),
  bounded by `MAISTER_AUTO_RETRY_MAX_ATTEMPTS` total ledger attempts; an explicit
  per-node `retry_policy` takes precedence and deterministic codes never retry.
- On `auto_retry` exhaustion the run MUST escalate WITHOUT discarding the worktree
  (the failed attempt → `NeedsInput` so a resume re-runs the node) — never fail
  outright. It opens an `infra_recovery` HITL (Retry re-runs the node once;
  Abandon fails the run), honors `onStuck` (escalate → assigned HITL; notify_only
  → HITL with no assignment), and emits `run.escalated`. An explicit per-node
  `retry_policy` keeps ADR-080's fail-on-exhaustion.
- `dirtyResolve` MUST NEVER auto-`discard`; `commit`/`proceed` auto-resolve only
  at a review-gate pause when the worktree is dirty.
- Every autonomy action MUST funnel through `logExecPolicyAction`; an on-stuck
  route MUST emit `run.escalated` (domain-event + webhook).

### Budget axis expectations

The `budget` axis (Implemented, ADR-101) carries its own acceptance contract; the
A/B/C bullets above are untouched. (≤ 12 bullets — the most load-bearing of the
E1–E12 invariants.)

- A run with no set or `0` budget meter at any scope is NEVER killed, paused, or
  refused by the budget axis — `budget` fails **OPEN** (`maxTokens: 0` ≡
  unlimited), the inversion of the safety axes that fail-closed to `strict`.
- `budgetFromSnapshot(null | absent | malformed)` MUST resolve to all-unset
  (unlimited) — it NEVER throws and NEVER constrains a run on a corrupt snapshot.
- WARN fires at `warnAtPct` (default 80%) WITHOUT killing and at most once per
  scope per band, idempotent via `runs.budget_state.notified[scope]`.
- ESCALATE at 100% `maxTokens` (run/task scope) MUST halt the live session first,
  then pause to `runs.status = 'NeedsInput'` or `NeedsInputIdle` with a
  `budget_breach` HITL, keep the worktree, and emit `run.escalated`
  (`reason=budget_exceeded`) where the run kind has a supported resume route.
  Agent worktree runs use the shared cap-guarded resume path; scratch and
  unsupported agent workspace modes are not restartable in the four-way fork.
  Persistent writes (status, node attempt where applicable, HITL row,
  assignment, `run.needs_input` + `run.escalated` outbox) happen in one
  transaction.
- TERMINATE at `hardMaxTokens` (= `maxTokens × MAISTER_BUDGET_HARD_MULTIPLIER`,
  default 1.25, when unset) MUST call `deleteSession`, then mark the run terminal
  `Failed` with `MaisterError("BUDGET_EXCEEDED")`; it NEVER marks `Failed` until
  the session is confirmed stopped/absent.
- A `tree`-scope breach MUST cascade-terminate the whole run-tree
  (`cascadeAbandonRunTree`, one transaction) then flip the root; tree scope has
  NO escalate rung.
- `task` token spend MUST equal the SUM of the four token columns over all
  `runs WHERE task_id = T`; `task.consecutiveFailures` is the trailing streak of
  `Failed | Crashed | Abandoned` runs for the task.
- The ladder MUST introduce no new `runs.status` value — it reuses `NeedsInput` +
  `Failed`; escalate/terminate idempotency is `runs.status`-derived.
- Raise-and-resume MUST write `runs.budget_state.ceilingOverride` (additive; the
  `runs.execution_policy` snapshot stays immutable), log `budget_raised`, clear
  `notified[scope]`, and the resumed run MUST NOT immediately re-escalate.
- Restart MUST terminalize the old run before launching the new one. The new run
  MUST omit the old policy snapshot so policy resolution and cost rollups start
  fresh. If caps are full, the new run may be `Pending` with a queue position.
- Park MUST preserve the work product (snapshot commit or exported branch)
  before the run becomes `Abandoned`; `budget_parked` is not counted as a budget
  termination because the work product is intentionally retained.
- Structured logs for budget composites MUST use structured fields:
  `runId`, `hitlRequestId`, `taskId`, `oldRunId`, `newRunId`, `optionId`,
  `mode`, `branchName`, `scope`, `meter`, `previousLimit`, `newLimit`,
  `compositeStage`, `workspaceId`, and `ref`. Never log file contents,
  arbitrary response text, secrets, or supervisor handles.
- The breach mechanism MUST branch on `runs.run_kind` (`flow | agent | scratch`)
  BEFORE routing. TERMINATE has a verified adapter for every kind; ESCALATE is
  available for run/task breaches whose run kind and workspace mode have a
  supported pause/response path (flow, scratch with owned worktree, and
  agent-worktree). Unsupported agent workspace modes promote to terminate.
  Terminate per kind, ALL → run `Failed` (a budget-kill is a deliberate,
  NON-recoverable terminal — Recover gates on `runs.status='Crashed'`): flow →
  `markNodeFailed` + run `Failed`; agent → `finalizeAgentRun("Failed")`; scratch
  → `markScratchCrashed(terminal:"failed")` → run `Failed` + `run.failed` event,
  with `scratch_runs.dialog_status=Crashed` (the scratch dialog FSM has no
  `Failed` state) + `error_code=BUDGET_EXCEEDED`. No new `runs.status` is added.

## Edge cases

- **Corrupt / legacy-null policy snapshot** → every resolver fail-closes to its
  safe default (no exception); the run behaves as `supervised` for that axis.
- **Blind-ship combination at launch** → `MaisterError("PRECONDITION")`; the
  launch dialog also disables the conflicting option client-side.
- **`ship_with_warning` with no forward decision** → cannot ship; the disposition
  falls back to an escalate-pause.
- **Squash tree drift / git failure** → `squashRunBranch` reverts to the original
  HEAD and returns not-squashed; the promote keeps the full history. Never throws
  (`code` surfaced only in logs, not the promote result).
- **`commits=defer` / `commits=squash_on_promote`** → `defer` behaves as
  `keep_all` (no separate deferral step today); `squash_on_promote` is an explicit
  alias of `squash_rework` (both collapse `base..HEAD` pre-promotion).
- **Ralph relaunch when the global cap is full** → the new run is created
  `Pending` and auto-promotes when a slot frees (`MaisterError` never raised by
  the consumer; `handle` never throws).
- **Auto-promote with no run creator** → `deliverRunIfAutoReady` degrades the
  delivery snapshot to `manual` and leaves the run in `Review`.
- **`notify_only` pause** → a HITL request row exists (a response CAN resolve the
  run) but no assignment is created; only `run.escalated` notifies externally.
- **Budget — absent / `0` / malformed snapshot** → `budgetFromSnapshot` resolves
  to all-unset (unlimited); the run is never killed, paused, or refused (fail-open,
  no error code — the deliberate inversion of the fail-closed safety axes).
- **Budget — `WaitingOnChildren` tree breach** → straight to TERMINATE-cascade
  (`cascadeAbandonRunTree` then root `Failed` with `BUDGET_EXCEEDED`); a parked
  tree root has no `→ NeedsInput` transition, so there is no escalate rung.
- **Budget — `EXECUTOR_UNAVAILABLE` on the terminate kill** →
  `MaisterError("EXECUTOR_UNAVAILABLE")`; the run is LEFT live and the kill is
  retried on the next watchdog tick (the run is NEVER marked `Failed` until the
  session is confirmed stopped; a `404` proceeds).

## Linked artifacts

- ADRs: [ADR-095](../decisions.md#adr-095-flow-execution-control-policy--snapshotted-preset--composable-autonomy-axes-fail-closed-no-blind-ship);
  [ADR-101](../decisions.md#adr-101-cost-budget-governance--budget-execution-policy-axis-token-metered-warn-escalate-terminate-ladder-fail-open)
  (the budget axis).
- Source: `web/lib/runs/execution-policy.ts` (types + preset table + resolvers +
  `assertNoBlindShip` + the `budget` axis / `budgetFromSnapshot`),
  `web/lib/runs/exec-policy-audit.ts` (audit boundary),
  `web/lib/flows/graph/runner-graph.ts` (A1/A3/B2/B3/C3 sites + the A2
  `auto_retry` `scheduleAutoRetry` synthesis via `resolveAutoRetryPolicy` +
  `emitRunEscalated`), `web/lib/runs/ralph-loop.ts` (A2 `ralph_loop` consumer),
  `web/lib/runs/keepalive-sweeper.ts` (budget watchdog pass),
  `web/lib/runs/cost-rollups.ts` (budget meters), `supervisor/src/acp-client.ts`
  (B1 L3), `web/lib/runs/auto-delivery.ts` (C1), `web/lib/worktree.ts`
  `squashRunBranch` + `web/lib/runs/promote.ts` (C2),
  `web/lib/runs/dirty-resolution.ts` `autoResolveDirtyAtReview` (C3).
- DB: `runs.execution_policy` + defaults + `runs.budget_state` (migration `0061`)
  — [`db/runs-domain.md`](../db/runs-domain.md),
  [`database-schema.md`](../database-schema.md); `run.escalated` —
  [`domain-events.md`](domain-events.md).
- HITL: `budget_breach` kind — [`hitl.md`](hitl.md).
- Errors: [`error-taxonomy.md`](../error-taxonomy.md) (`PRECONDITION` for the
  no-blind-ship guard, `CONFIG` for `reworkExhaustion=fail`, `BUDGET_EXCEEDED`
  for a budget hard-cap terminate).
- Env: `MAISTER_BUDGET_HARD_MULTIPLIER`, `MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS`
  — [`../configuration.md`](../configuration.md).
