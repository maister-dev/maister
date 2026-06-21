# Cost-budget governance — execution-policy spend axis (planning request)

> **Status: Design / planning request (2026-06-21).** Feeds `/aif-plan`.
> First-place "loop-engineering" feature: the enforcing **spend-rail** the
> already-shipped autonomy (`unattended` preset + `ralph_loop` + the M37
> orchestrator swarm) runs **without** today.

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
**no dollar ceiling**. That is the "генератор счёта" loop-engineering warns about
(economy of completion; limits are non-negotiable). This feature closes it.

**Non-goal restated:** this is *not* the self-improvement / constraints loop
(the "moat"). That is the separate second-place feature.

## 2. What (scope)

Add an enforcing **cost / failure / time budget** as a **tenth execution-policy
axis (`budget`)**, evaluated at **three scopes** and enforced via a
**warn → escalate → terminate** ladder that reuses existing machinery.

**Scopes (all three in v1):**

| Scope | Aggregation key | Motivation |
| ----- | --------------- | ---------- |
| `run` | a single run | one runaway agent session |
| `task` | all runs of a task (`runs.task_id`) over its 1:N retry/ralph chain | a ralph-loop that keeps relaunching and burning tokens across runs |
| `tree` | the orchestrator run-tree (`runs.root_run_id`) | a swarm / as-plan DAG with only fanout+depth count caps today |

> **Interpretation flag (confirm):** the owner asked to "return per-task(1:N)
> also; budget limiting is planned though." This spec reads that as **per-task
> budget limiting is IN v1** (cost + consecutive-failures at task scope). If the
> intent was instead "track per-task now, enforce its cost cap later," drop the
> `task.costUsd` enforcement to a follow-up and keep only `task.consecutiveFailures`.

**Meters per the owner's choice:**

| Meter | `run` | `task` | `tree` | Source |
| ----- | :---: | :----: | :----: | ------ |
| `costUsd` (incl. ~$0.28/respawn resume tax) | ✅ | ✅ | ✅ | `runCostRollups` (sum) |
| `consecutiveFailures` | ✅ (failed node attempts) | ✅ (failed runs) | ✅ (failed child runs) | `node_attempts` / `runs` |
| `wallClockMinutes` | — | — | ✅ | `now − root.created_at` |

Per-node wall-clock is already enforced (`maxDurationMinutes`); the new
`wallClockMinutes` is a **tree-wide** elapsed bound only.

## 3. Architecture (reuse three existing primitives)

1. **The axis** lives in `web/lib/runs/execution-policy.ts` next to the other
   nine — a new `budget` field on `ExecutionPolicyOverrides` /
   `ResolvedExecutionPolicy`, a `PRESET_AXES` column, and a fail-closed
   `budgetFromSnapshot` resolver. It rides in the existing
   `runs.execution_policy` jsonb snapshot — **no migration for the axis itself**
   (open jsonb; ADR-095 migration 0055 already added the column).
2. **Spend aggregation** reuses `web/lib/runs/cost-rollups.ts`
   (`reconcileRunCostRollups`, `runCostRollups`). Per-run = the existing rollup;
   per-task = `SUM(runCostRollups.costUsd) WHERE runs.task_id = T`; per-tree =
   `… WHERE runs.root_run_id = R`.
3. **Enforcement** extends the existing budget watchdog in
   `web/lib/runs/keepalive-sweeper.ts` (the same sweep that kills on
   `maxDurationMinutes`) to also evaluate the `budget` axis each tick.

### 3.1 Axis shape

```ts
type BudgetLimits = {
  costUsd?: number;             // escalate ceiling (100%)
  hardCostUsd?: number;         // terminate ceiling; if unset = costUsd * MAISTER_BUDGET_HARD_MULTIPLIER (default 1.25)
  consecutiveFailures?: number; // see meter table for per-scope semantics
  wallClockMinutes?: number;    // tree scope only
  warnAtPct?: number;           // default 80
};
type BudgetAxis = { run?: BudgetLimits; task?: BudgetLimits; tree?: BudgetLimits };
```

### 3.2 Preset table + the teeth ("no blind spend")

| Axis | `supervised` | `assisted` | `unattended` |
| ---- | ------------ | ---------- | ------------ |
| `budget` | `off` | `off` | **required** |

- `supervised` / `assisted` → `off`: **nothing changes for existing launches**
  (matches ADR-095's "nothing changes for an existing launch").
- `unattended` → a launch resolving to `unattended` with **no** `budget.run`,
  `budget.task`, or `budget.tree` is **refused** with
  `MaisterError("PRECONDITION")` by a new `assertNoBlindSpend`, server-side,
  before the run row is created — mirroring `assertNoBlindShip`/`isBlindShip`.
  Supervised autonomy you babysit; unattended autonomy may not run uncapped.
- **Rollout safety:** if `MAISTER_DEFAULT_UNATTENDED_BUDGET_USD` is set, an
  unattended launch with no explicit budget **auto-fills** `tree.costUsd` from it
  (ops global ceiling) instead of refusing. Unset → refuse. Optionally stage the
  whole guard behind `MAISTER_ENFORCE_NO_BLIND_SPEND` (default on).

### 3.3 Fail-closed resolver

`budgetFromSnapshot(null | absent | malformed)` → `off`. "Safe" here = today's
behavior (= `supervised`); the teeth are the **launch-time** no-blind-spend
guard, not the resolver default. Consistent with ADR-095's resolver contract.

## 4. The breach ladder

Per metered dimension, per active scope, whichever trips first:

```
spend/failures/wallclock vs limits
  ≥ warnAtPct (80%)  → WARN      : logExecPolicyAction('budget_warned'), surfaced badge; run continues
  ≥ 100%             → ESCALATE  : reuse onStuck → pause to NeedsInput (infra_recovery-style HITL,
                                   KEEP worktree), emit run.escalated, logExecPolicyAction('budget_escalated');
                                   HITL offers [Raise budget & resume] / [Abandon]; notify_only → no assignment
  ≥ hard ceiling     → TERMINATE : supervisor DELETE /sessions/:id (like the time watchdog) → node Failed,
                                   run terminal Failed; tree breach reuses the orchestrator cancel-cascade
                                   (one tx, promoteNextPending); logExecPolicyAction('budget_terminated')
```

- **Reuses:** the `onStuck` resolver, the `infra_recovery` HITL pattern that
  `auto_retry` exhaustion already opens (NeedsInput, worktree kept, Retry/Abandon
  — execution-policy.md), the `run.escalated` domain-event + webhook, the time
  watchdog's `deleteSession` kill-path, and the M37 cancel-cascade.
- **New audit kinds** on `ExecPolicyActionKind` (`web/lib/runs/exec-policy-audit.ts`):
  `budget_warned | budget_escalated | budget_terminated | budget_raised`.
- **"Raise budget & resume"** is an explicit, audited top-up of the snapshot's
  `budget` axis **only** (the one allowed exception to snapshot immutability),
  gated by the `launchUnattended` action, logged `budget_raised`, then `session/resume`.
- **Idempotency:** the watchdog must not re-escalate a run already paused
  `NeedsInput` for budget, nor re-warn each tick — derive "already warned/escalated"
  from run status + the exec-policy audit rows (no new column needed).

## 5. Enforcement flow (keepalive-sweeper budget watchdog)

Each `system_sweep` tick (~60s), for every live run (`Running` /
`WaitingOnChildren` / `NeedsInput`) whose `budgetFromSnapshot` is not `off`:

1. Force `reconcileRunCostRollups` for the run (and, for a tree/task check, its
   sibling/tree members) so the spend read is fresh — bounds overshoot to ~1 tick.
2. Compute `costUsd` / `consecutiveFailures` / `wallClockMinutes` at each active
   scope (run, task, tree).
3. Resolve the highest-severity rung crossed and act per §4 (idempotent).

~60s lag is acceptable for a dollar ceiling — the warn rung surfaces the
approach well before the hard kill.

## 6. Data model / migration

- **Axis:** jsonb on `runs.execution_policy` — **no migration**.
- **Index (small migration):** `runs` has `runs_task_idx` (task_id) and
  `runs_parent_run_id_idx` but **no index on `root_run_id`** — add
  `runs_root_run_id_idx` for the per-tree aggregation query.
- **No new cost source, no per-run budget-state column** (derive warn/escalate
  state from status + audit).

## 7. Edge cases

- **Corrupt / legacy-null snapshot** → resolver `off`; run behaves as today.
- **`WaitingOnChildren`** → orchestrator itself idle ($0); children accrue and
  are summed by the tree rollup; tree `wallClockMinutes` keeps ticking (a tree
  parked for days *should* trip).
- **Child per-run breach** → terminate the child → `run.review`/`Failed` → wakes
  the parent via the existing `orchestrator_resume`; parent may `run_rework` or abandon.
- **Tree per-tree breach** → cascade-terminate the whole tree (one tx).
- **Resume tax** → each respawn's ~$0.28 cache-creation is in the rollups
  (`resumed` flag) and counts toward the budget; a budget set below the
  resume+ralph floor will warn immediately — surface it, don't silently eat it.
- **Pending/queued runs** accrue $0 → not evaluated.
- **Rollup lag** → forced reconcile in the tick bounds the overshoot.

## 8. Testing (mirror `time-limit-watchdog.integration.test.ts`)

- warn fires at `warnAtPct` without killing;
- escalate at 100%: run → `NeedsInput`, worktree kept, `run.escalated` emitted, HITL row created;
- terminate at hard ceiling: `deleteSession` called, node `Failed`, run terminal `Failed`;
- tree aggregation across 3 child runs sums; tree breach cascades the tree;
- per-task aggregation across sequential ralph-loop runs sums; `task.consecutiveFailures` trips;
- `unattended` launch with no budget and no `MAISTER_DEFAULT_UNATTENDED_BUDGET_USD` → `PRECONDITION`;
- fail-closed: null/malformed snapshot → `off`, no kill;
- raise-budget-&-resume: snapshot `budget` updated + audited, run resumes;
- idempotency: the watchdog does not double-escalate a budget-paused run nor re-warn each tick.

## 9. Out of scope (named, not silent)

- The compounding / constraints / self-improvement loop (second-place feature).
- A new cost **source** (reuse `cost-rollups`).
- Supervisor-side inline (per-step) enforcement (Approach B — over-built for $ ceilings).
- Flipping node-level `limits.maxCostUsd` from record-only to enforced (stays
  record-only; complementary, can follow).
- Per-model / per-tool cost breakdown.

## 10. Open decisions (for `/aif-plan` / owner)

1. **per-task cost enforcement in v1?** (spec assumes yes — see §2 flag).
2. **unattended-no-budget:** hard refuse vs `MAISTER_DEFAULT_UNATTENDED_BUDGET_USD`
   auto-fill vs `MAISTER_ENFORCE_NO_BLIND_SPEND` staging (rec: env-default if set,
   else refuse, behind the flag).
3. **hard ceiling shape:** explicit `hardCostUsd` vs `costUsd × multiplier`
   (rec: explicit optional, else multiplier default 1.25).
4. **warn-state storage:** derive from audit+status (rec, no migration) vs a `runs` column.

## 11. Linked artifacts

- **Decisions:** new **ADR-101** (budget axis); extends
  [ADR-095](../decisions.md#adr-095-flow-execution-control-policy--snapshotted-preset--composable-autonomy-axes-fail-closed-no-blind-ship);
  reuses ADR-098/099/100 (orchestrator), ADR-077 (`run.escalated` webhook), ADR-060 (sweeper clock).
- **Source (extend):** `web/lib/runs/execution-policy.ts` (axis + preset + resolver
  + `assertNoBlindSpend`), `web/lib/runs/exec-policy-audit.ts` (new action kinds),
  `web/lib/runs/keepalive-sweeper.ts` (budget watchdog), `web/lib/runs/cost-rollups.ts`
  (per-task/per-tree aggregation), `web/lib/services/runs.ts` (launch guard),
  `web/lib/db/schema.ts` + a migration (`runs_root_run_id_idx`).
- **Docs to update:** `docs/system-analytics/execution-policy.md` (10th axis),
  `docs/system-analytics/observatory.md` (surface budget breaches),
  `docs/decisions.md` (ADR-101).
- **Errors:** `PRECONDITION` (no-blind-spend), reuse `CHECKPOINT`/`EXECUTOR_UNAVAILABLE` on kill.
