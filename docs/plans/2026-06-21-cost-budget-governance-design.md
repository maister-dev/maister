# Cost-budget governance — execution-policy spend axis (planning request)

> **Status: Design / planning request (2026-06-21).** Feeds `/aif-plan`.
> First-place "loop-engineering" feature: the enforcing **spend-rail** the
> already-shipped autonomy (`unattended` preset + `ralph_loop` + the M37
> orchestrator swarm) runs **without** today.
>
> **Owner decisions (2026-06-21):** budget is metered in **tokens**, not USD
> (pricing is hard to maintain). Enforcement is **opt-in, fail-open**: an absent
> or `0` limit means "run, don't constrain" — there is **no launch refusal**.

## 1. Why (the verified gap)

Main (`d14a28ba`) already ships the autonomy machinery: the execution-control
policy (ADR-095) with an `unattended` preset, `crashRetry: ralph_loop | auto_retry`,
on-stuck escalation, the `assertNoBlindShip` verifier guard, and the M37
orchestrator (ADR-098/099/100) with delegated run-trees. It also enforces a
**time** ceiling — a kill-on-cap watchdog in `web/lib/runs/keepalive-sweeper.ts`
terminates a node past its `limits.maxDurationMinutes`.

What it does **not** enforce is **spend**:

- `limits.maxCostUsd` is **record-only by design** — there is a test literally
  named *"never kills on a cost cap alone — maxCostUsd is record-only"*
  (`web/lib/runs/__tests__/time-limit-watchdog.integration.test.ts:363`).
- The only spend-shaped bounds are **count** caps, env-global, not policy:
  `MAISTER_RALPH_MAX_ATTEMPTS`, `MAISTER_AUTO_RETRY_MAX_ATTEMPTS`,
  `MAISTER_ORCHESTRATOR_MAX_DEPTH/FANOUT`.

So you can launch an `unattended` orchestrator that fans out an as-plan task-DAG
and ralph-loops on crashes, bounded only by attempt/depth/fanout **counts** — with
**no token ceiling**. That is the "генератор счёта" loop-engineering warns about
(economy of completion; limits are non-negotiable). This feature closes it.

**Non-goal restated:** this is *not* the self-improvement / constraints loop
(the "moat"). That is the separate second-place feature.

## 2. What (scope)

Add an enforcing **token / failure / time budget** as a **tenth execution-policy
axis (`budget`)**, evaluated at **three scopes** and enforced via a
**warn → escalate → terminate** ladder that reuses existing machinery.

**Scopes (all three in v1):**

| Scope | Aggregation key | Motivation |
| ----- | --------------- | ---------- |
| `run` | a single run | one runaway agent session |
| `task` | all runs of a task (`runs.task_id`) over its 1:N retry/ralph chain | a ralph-loop that keeps relaunching and burning tokens across runs |
| `tree` | the orchestrator run-tree (`runs.root_run_id`) | a swarm / as-plan DAG with only fanout+depth count caps today |

**Meters (owner choice). The spend meter is total tokens, not USD:**

| Meter | `run` | `task` | `tree` | Source |
| ----- | :---: | :----: | :----: | ------ |
| `maxTokens` = input+output+cache_read+cache_creation (incl. resume/cache-creation tax) | ✅ | ✅ | ✅ | `run_cost_rollups` (sum of the four token columns) |
| `consecutiveFailures` | ✅ (failed node attempts) | ✅ (failed runs) | ✅ (failed child runs) | `node_attempts` / `runs` |
| `wallClockMinutes` | — | — | ✅ | `now − root.started_at` |

Per-node wall-clock is already enforced (`maxDurationMinutes`); the new
`wallClockMinutes` is a **tree-wide** elapsed bound only. **Tokens, not USD:**
`run_cost_rollups` already stores the raw token columns; no model-price table is
introduced (prices drift and are costly to maintain). The node-level
`limits.maxCostUsd` stays record-only and untouched — it is a separate concern.

## 3. Architecture (reuse three existing primitives)

1. **The axis** lives in `web/lib/runs/execution-policy.ts` next to the other
   nine — a new `budget` field on `ExecutionPolicyOverrides` /
   `ResolvedExecutionPolicy`, a `PRESET_AXES` column, and a fail-closed
   `budgetFromSnapshot` resolver. It rides in the existing
   `runs.execution_policy` jsonb snapshot — **no migration for the axis itself**.
2. **Spend aggregation** reuses `web/lib/runs/cost-rollups.ts`
   (`reconcileRunCostRollups`, `run_cost_rollups`). Per-run = the existing
   rollup's four token columns summed; per-task = sum `WHERE runs.task_id = T`;
   per-tree = sum `WHERE runs.root_run_id = R`. No USD conversion.
3. **Enforcement** extends the existing budget watchdog in
   `web/lib/runs/keepalive-sweeper.ts` (the same sweep that kills on
   `maxDurationMinutes`) to also evaluate the `budget` axis each tick.

### 3.1 Axis shape

```ts
type BudgetLimits = {           // absent OR 0 = unlimited (fail-OPEN; "run, don't constrain")
  maxTokens?: number | null;          // escalate ceiling (100%)
  hardMaxTokens?: number | null;      // terminate ceiling; if unset = maxTokens * MAISTER_BUDGET_HARD_MULTIPLIER (default 1.25)
  consecutiveFailures?: number | null;
  wallClockMinutes?: number | null;   // tree scope only
  warnAtPct?: number | null;          // default 80
};
type BudgetAxis = { run?: BudgetLimits; task?: BudgetLimits; tree?: BudgetLimits };
```

### 3.2 Preset table + the default

| Axis | `supervised` | `assisted` | `unattended` |
| ---- | ------------ | ---------- | ------------ |
| `budget` | unset (unlimited) | unset (unlimited) | unset, optionally env-defaulted |

- **No launch refusal.** Any preset may run with no budget — absent/0 = unlimited.
  `unattended` is **not** required to carry a budget.
- **Convenience auto-fill (not a guard):** at launch, if the resolved policy is
  `unattended` AND carries no `budget.{run,task,tree}` AND
  `MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS` is set, fill `tree.maxTokens` from
  it. If the env var is unset, the run is simply unbounded. This is an ops
  convenience (`applyDefaultBudgetForUnattended`), never a `PRECONDITION`.

### 3.3 Fail-open resolver

`budgetFromSnapshot(null | absent | malformed)` → all-unset (unlimited). A
malformed snapshot never *adds* a constraint — consistent with "nothing changes
for an existing launch", and aligned with the owner's "no limit ⇒ don't
constrain" rule. (Note: this is fail-OPEN by design for budgets, unlike the
safety axes that fail-closed to `strict`.)

## 4. The breach ladder

Per metered dimension, per active scope, whichever trips first (a meter that is
unset or `0` is skipped):

```
spend/failures/wallclock vs limits
  ≥ warnAtPct (80%)  → WARN      : logExecPolicyAction('budget_warned'), surfaced badge; run continues
  ≥ 100% (maxTokens) → ESCALATE  : reuse onStuck → pause to NeedsInput (budget_breach HITL,
                                   KEEP worktree), emit run.escalated (reason=budget_exceeded),
                                   logExecPolicyAction('budget_escalated'); HITL offers
                                   [Raise budget & resume] / [Abandon]
  ≥ hardMaxTokens    → TERMINATE : supervisor DELETE /sessions/:id (like the time watchdog) → node Failed,
                                   run terminal Failed (BUDGET_EXCEEDED); tree breach reuses the orchestrator
                                   cancel-cascade (one tx, promoteNextPending); logExecPolicyAction('budget_terminated')
```

- **Reuses:** the `onStuck` resolver, the `infra_recovery` HITL pattern that
  `auto_retry` exhaustion already opens (NeedsInput, worktree kept, Retry/Abandon
  — execution-policy.md), the `run.escalated` domain-event + webhook, the time
  watchdog's `deleteSession` kill-path, and the M37 cancel-cascade.
- **New audit kinds** on `ExecPolicyActionKind` (`web/lib/runs/exec-policy-audit.ts`):
  `budget_warned | budget_escalated | budget_terminated | budget_raised`.
- **"Raise budget & resume"** writes a new additive `runs.budget_ceiling_override`
  (raised token ceiling) the watchdog reads ON TOP of the snapshot, logged
  `budget_raised`, then `session/resume`. The execution-policy snapshot stays
  immutable.
- **Idempotency:** the watchdog must not re-escalate a run already paused
  `NeedsInput` for budget, nor re-warn each tick — derive "already warned/escalated"
  from run status + the exec-policy audit rows (no new column).

## 5. Enforcement flow (keepalive-sweeper budget watchdog)

Each `system_sweep` tick (~60s), for every live run (`Running` /
`WaitingOnChildren`) whose `budgetFromSnapshot` (+ `budget_ceiling_override`
top-up) has at least one set, non-zero limit:

1. Force `reconcileRunCostRollups` for the run (and, for a tree/task check, its
   tree/task members) so the token read is fresh — bounds overshoot to ~1 tick.
2. Sum tokens / count consecutive failures / compute tree wall-clock at each
   active scope (run, task, tree).
3. Resolve the highest-severity rung crossed and act per §4 (idempotent). A tree
   breach targets the **root** orchestrator (then cascades); a run/task breach
   targets the offending active run.

~60s lag is acceptable for a token ceiling — the warn rung surfaces the approach
well before the hard kill.

## 6. Data model / migration

- **Axis:** jsonb on `runs.execution_policy` — **no migration**.
- **Migration 0061:** add `runs_root_run_id_idx` index on `runs.root_run_id`
  (none exists — only `runs_task_idx` and `runs_parent_run_id_idx`) for the
  per-tree aggregation; add `runs.budget_ceiling_override jsonb` (raise-and-resume).
- **No pricing table, no USD column, no new cost source.**

## 7. Edge cases

- **Absent / 0 / corrupt snapshot** → that meter (or the whole axis) is unlimited;
  run behaves as today. No throw, no refusal.
- **`WaitingOnChildren`** → orchestrator itself idle (0 tokens); children accrue
  and are summed by the tree rollup; tree `wallClockMinutes` keeps ticking.
- **Child per-run breach** → terminate the child → `run.review`/`Failed` → wakes
  the parent via the existing `orchestrator_resume`; parent may `run_rework` or abandon.
- **Tree per-tree breach** → cascade-terminate the whole tree (one tx).
- **Resume tax** → each respawn's cache-creation tokens are in the rollups
  (`resumed` flag) and count toward the budget by construction.
- **Pending/queued runs** accrue 0 tokens → not evaluated.
- **Rollup lag** → forced reconcile in the tick bounds the overshoot.

## 8. Testing (mirror `time-limit-watchdog.integration.test.ts`)

- warn fires at `warnAtPct` without killing;
- escalate at 100%: run → `NeedsInput`, worktree kept, `run.escalated` (reason=budget_exceeded), HITL row created;
- terminate at `hardMaxTokens`: `deleteSession` called, node `Failed`, run terminal `Failed` (BUDGET_EXCEEDED);
- tree aggregation across 3 child runs sums; tree breach cascades the tree;
- per-task aggregation across sequential ralph-loop runs sums; `task.consecutiveFailures` trips;
- **no refusal:** `unattended` with no budget and no env-default → run launches unbounded; with `MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS` set → `tree.maxTokens` auto-filled; `maxTokens: 0` → unlimited (no kill);
- fail-open: null/malformed snapshot → unlimited, no kill;
- raise-and-resume: `budget_ceiling_override` top-up + run resumes;
- idempotency: the watchdog does not double-escalate a budget-paused run nor re-warn each tick.

## 9. Out of scope (named, not silent)

- The compounding / constraints / self-improvement loop (second-place feature).
- USD/cost conversion + a model-price table (deliberately deferred — tokens are
  the v1 unit; revisit if a $ view is wanted later).
- A new cost **source** (reuse `cost-rollups`).
- Supervisor-side inline (per-step) enforcement (over-built for a token ceiling).
- Flipping node-level `limits.maxCostUsd` from record-only to enforced.

## 10. Resolved decisions

1. **Meter unit:** tokens (not USD) — pricing maintenance avoided. ✅
2. **No-budget behavior:** absent or `0` ⇒ run unbounded; **no launch refusal**;
   `unattended` optionally auto-filled from `MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS`. ✅
3. **Per-task cost:** `task.maxTokens` enforced in v1. ✅
4. **Hard ceiling:** explicit `hardMaxTokens`, else `maxTokens × MAISTER_BUDGET_HARD_MULTIPLIER` (default 1.25). ✅
5. **Status reuse:** `NeedsInput` + `Failed` (HITL `budget_breach`, error `BUDGET_EXCEEDED`) — no new `runs.status`. ✅
6. **Raise-and-resume:** additive `runs.budget_ceiling_override`, snapshot stays immutable. ✅

## 11. Linked artifacts

- **Decisions:** new **ADR-101** (budget axis); extends
  [ADR-095](../decisions.md#adr-095-flow-execution-control-policy--snapshotted-preset--composable-autonomy-axes-fail-closed-no-blind-ship);
  reuses ADR-098/099/100 (orchestrator), ADR-077 (`run.escalated` webhook), ADR-060 (sweeper clock).
- **Source (extend):** `web/lib/runs/execution-policy.ts` (axis + preset + resolver
  + `applyDefaultBudgetForUnattended`), `web/lib/runs/exec-policy-audit.ts` (new action kinds),
  `web/lib/runs/keepalive-sweeper.ts` (budget watchdog), `web/lib/runs/cost-rollups.ts`
  (per-task/per-tree token aggregation), `web/lib/services/runs.ts` (launch auto-fill),
  `web/lib/db/schema.ts` + migration 0061 (`runs_root_run_id_idx`, `runs.budget_ceiling_override`).
- **Docs to update:** `docs/system-analytics/execution-policy.md` (10th axis),
  `docs/system-analytics/observatory.md` (surface budget breaches),
  `docs/decisions.md` (ADR-101).
- **Errors:** `BUDGET_EXCEEDED` (new) on terminate; reuse `CHECKPOINT`/`EXECUTOR_UNAVAILABLE` on the kill path.
