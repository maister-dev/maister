# Plan — Cost-budget governance (execution-policy spend axis)

**Branch:** `worktree-cost-budget-governance`
**Created:** 2026-06-21
**Design doc:** `docs/plans/2026-06-21-cost-budget-governance-design.md`
**Feature:** A tenth execution-policy axis `budget` enforcing **token** / consecutive-failure / wall-clock limits at **run + task(1:N) + run-tree** scope via a **warn → escalate → terminate** ladder. Closes the spend-rail gap on main's already-shipped autonomy (`unattended` preset + `ralph_loop` + M37 orchestrator swarm enforce only *count* caps; `maxCostUsd` is record-only by design).

**Owner decisions (2026-06-21):** metered in **tokens**, not USD (pricing maintenance avoided). Enforcement is **opt-in, fail-open** — an absent or `0` limit means "run, don't constrain"; **no launch refusal**.

## Settings

- **Testing:** Yes — integration tests mirroring `web/lib/runs/__tests__/time-limit-watchdog.integration.test.ts`; each test names its runner project; per-phase suite-green gate.
- **Logging:** Verbose — DEBUG at every budget evaluation (scope, tokens, threshold, rung), INFO on warn/escalate/terminate.
- **Docs:** Mandatory checkpoint at completion (route through `/aif-docs`). Phase 0 is docs-first regardless.

## Roadmap Linkage

- **Milestone:** none.
- **Rationale:** Net-new from the loop-engineering gap analysis. It extends the ADR-095 execution-control substrate and fills the write-side autonomy guardrail M23 explicitly deferred. Recommend adding a ROADMAP entry "Mβ. Cost-budget governance" post-merge (out of plan scope).

## Reserved numbers (verified at `main` HEAD `d14a28ba`)

- **ADR-101** — next free (`max(### ADR-NNN)` = ADR-100). Reserve a stub header in `docs/decisions.md` in Phase 0 **before** citing it.
- **Migration 0061** — next free (`_journal.json` last tag `0060_m37_orchestrator_engine`).
- Budget a renumber check if `main` advances before merge (ADR + migration are a shared sequential namespace; clashes are invisible per-branch until merge).

---

## Key Decisions

### D1 — Budget is the 10th execution-policy axis (`budget`)
Add `budget?: BudgetLimits` to `ExecutionPolicyOverrides` (execution-policy.ts:62) and `ResolvedExecutionPolicy` (:80); add a `budget` column to each `PRESET_AXES` block (:98/:109/:120, default = all-unset = unlimited); fold in `expandExecutionPolicy` (:140); add `budget: budgetLimitsSchema` to `executionPolicyOverridesSchema` (:281). Rides the existing `runs.execution_policy` jsonb snapshot — **no migration for the axis itself**.

```ts
type BudgetLimits = {           // absent OR 0 = unlimited (fail-OPEN; "run, don't constrain")
  maxTokens?: number | null;          // escalate ceiling (100%); tokens = input+output+cache_read+cache_creation
  hardMaxTokens?: number | null;      // terminate ceiling; unset ⇒ maxTokens * MAISTER_BUDGET_HARD_MULTIPLIER (default 1.25)
  consecutiveFailures?: number | null;
  wallClockMinutes?: number | null;   // tree scope only
  warnAtPct?: number | null;          // default 80
};
type BudgetAxis = { run?: BudgetLimits; task?: BudgetLimits; tree?: BudgetLimits };
```
`budgetFromSnapshot(snapshot)` mirrors the nine existing `<axis>FromSnapshot` resolvers (`safeParse` → **fail-OPEN to all-unset = unlimited**). Note the inversion: safety axes fail-closed to `strict`; budget fails OPEN, because the owner rule is "no limit ⇒ don't constrain" and a malformed snapshot must never *add* a constraint.

### D2 — Reuse `NeedsInput` + `Failed`, NO new run status
The breach ladder reuses existing statuses to avoid the ~17-site `runs.status` fan-out:
- **ESCALATE → `NeedsInput`** with a new HITL kind **`budget_breach`** (mirror `infra_recovery`), worktree kept, emit `run.escalated` (`detail.reason = "budget_exceeded"`).
- **TERMINATE → `Failed`** with a distinct error code **`BUDGET_EXCEEDED`** (add to `MaisterError` union in `web/lib/errors.ts`); tree terminate reuses `cascadeAbandonRunTree`.
Consequence: fan-out collapses to the **HITL-kind** sites (D-FANOUT) + the new error/audit/event-reason — `runs.status` consumers are untouched, and `launchability.ts`'s exhaustive `satisfies Record<RunStatus,…>` stays green.

### D3 — No launch refusal; opt-in fail-open + optional auto-fill
There is **no** `assertNoBlindSpend` / `PRECONDITION` guard. An absent or `0` budget means the run is unbounded. The only launch-time step is a convenience helper `applyDefaultBudgetForUnattended(policy)` in `web/lib/services/runs.ts` (around the existing policy-snapshot at :290-301): if the resolved policy is `unattended` AND has no `budget.{run,task,tree}` AND `MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS` is set, fill `tree.maxTokens` from it; otherwise leave unbounded. Never throws. (No `MAISTER_ENFORCE_NO_BLIND_SPEND`, no client-side disable.)

### D4 — Tokens, not USD (no pricing table)
`run_cost_rollups` stores raw token columns (`inputTokens|outputTokens|cacheReadTokens|cacheCreationTokens` + resume-attributed subset). The budget meter is the **sum of those four** at the scope; the resume/cache-creation tax is included by construction. **No model-price map, no `estimateUsd`, no USD column** — deliberately deferred (prices drift and are costly to maintain). Node-level `limits.maxCostUsd` stays record-only and untouched.

### D5 — Raise-and-resume via an additive column, NOT snapshot mutation
The execution-policy snapshot is immutable (written once at services/runs.ts:900; zero post-launch `UPDATE … execution_policy`). "Raise budget & resume" adds `runs.budget_ceiling_override jsonb` (additive token-ceiling top-up the budget pass reads ON TOP of the snapshot), audited `budget_raised`. (Migration 0061.)

### D6 — Per-task TOKEN enforcement IS in v1
`budget.task.maxTokens` is enforced (owner confirmed). Task spend = `SUM` of the four token columns over `runs WHERE task_id = T` (the full 1:N ralph/retry chain). Plus `task.consecutiveFailures` = trailing streak of `Failed|Crashed|Abandoned` runs for the task.

### D7 — `run_kind` dispatch: per-kind terminate/escalate adapters (project rule)
The watchdog candidate set is multi-kind, but the breach **mechanism branches on `run_kind` BEFORE routing** — a flow-only path applied to an agent/scratch run silently misbehaves (agent/scratch runs have no `node_attempts`/`current_step_id`). Verified adapters:

| | `flow` | `agent` | `scratch` |
| --- | --- | --- | --- |
| **TERMINATE** (after `deleteSession`) | inline CAS `status=Failed` + `markNodeFailed(BUDGET_EXCEEDED)` | `finalizeAgentRun(runId,"Failed",{reason:"budget_breach"})` (no ledger) | `markScratchCrashed` / `applyDialogStatus(Failed-equiv)` |
| **ESCALATE** (halt session first) | idle-checkpoint path + `markNodeNeedsInput` | checkpoint + `hitl_requests` insert + CAS `status=NeedsInput` (no `nodeAttemptId`) | checkpoint + `applyDialogStatus("NeedsInput")` |

A test exercises EACH arm (project rule: half-A + half-B ≠ A∘B). **No branch for cost** — `reconcileRunCostRollups` is kind-agnostic (keyed on runId, processes `cost.jsonl` even with no node_attempts), so per-task/per-tree token sums over agent children are correct.

### Contract surfaces → spec files (project rule)
| Surface that changes | Spec file the plan's docs phase MUST touch |
| --- | --- |
| New `budget` axis (DSL/policy shape) | `docs/system-analytics/execution-policy.md` + `web/lib/config.schema.ts` + `docs/flow-dsl.md` |
| New error code `BUDGET_EXCEEDED` | `docs/error-taxonomy.md` + `web/lib/errors.ts` |
| `run.escalated` reason `budget_exceeded` (no new event kind) | `docs/system-analytics/domain-events.md` + `docs/system-analytics/outbound-webhooks.md` |
| New HITL kind `budget_breach` | `docs/system-analytics/hitl.md` + `assignments/service.ts` union + `schema.ts` action_kind enum |
| New env vars (`MAISTER_BUDGET_HARD_MULTIPLIER`, `MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS`) | env-vars table in `docs/configuration.md` + `.env.example` (web-tier reads; add to web service `environment:` only if containerized config is expected) |
| New column `runs.budget_ceiling_override`, new index `runs_root_run_id_idx` | Drizzle migration `0061` + `docs/database-schema.md` + `docs/db/runs-domain.md` ERD |
| HITL response route (Raise/Abandon) | reuse the existing HITL respond route; spec the new `budget_breach` decisions in `docs/api/*` if the route shape changes |

### Two-phase commit + multi-store atomicity (project rule)
- **TERMINATE** performs a supervisor side-effect (`deleteSession`) + a multi-store DB transition (`runs.status=Failed` guarded on prior status, `markNodeFailed`, close assignments, emit webhook+domain in one tx) + `promoteNextPending` after commit — mirror `runTimeLimitPass` exactly (keepalive-sweeper.ts:530-655). Kill ordering: attempt `deleteSession` first; on `EXECUTOR_UNAVAILABLE` skip + retry next tick (do NOT mark terminal); on 404 proceed. The status flip is the AFTER-side durable mark.
- **TREE TERMINATE** calls `cascadeAbandonRunTree` (children-first, one tx, `promoteNextPending` per pool) THEN flips the root — exactly as `stopWorkbenchRun`/`cascadeOrchestratorIfNeeded`.
- **ESCALATE → NeedsInput** + the **Raise-and-resume** response are multi-store (status + HITL row + `budget_ceiling_override` write + `scheduleResume`): one tx for the persistent writes, the resume side-effect AFTER commit; the HITL response derives `runId` from **server state** (the HITL row), never a body field. Crash window: process death between the budget-pass tx and `scheduleResume` is recovered by the existing reconcile/keepalive sweep that owns `NeedsInput`.
- **Idempotency:** the budget pass must not re-escalate a run already paused for budget, nor re-warn each tick — derive "already warned/escalated" from `runs.status` + the `exec_policy` audit rows (no new column).

### D-FANOUT — consumer touchpoints (verified file:line)
Because of D2, the surface is small. Update **only** these:
- `web/lib/db/schema.ts:2207` — add `"budget_breach"` to `hitl_requests.action_kind` (TS text-enum; verify no DB CHECK ⇒ likely no migration row).
- `web/lib/assignments/service.ts:72` — add `"budget_breach"` to the HITL-kind union.
- `web/lib/services/hitl.ts` — new `handleBudgetBreachResponse` (mirror `handleInfraRecoveryResponse:1255`); route it in `respondToHitl:1409/1497`.
- `web/lib/queries/hitl.ts:54/259` — already filters `NeedsInput|NeedsInputIdle`; `budget_breach` surfaces in the inbox for free (verify, add test).
- `web/lib/errors.ts` — add `BUDGET_EXCEEDED` to the `MaisterError` code union.
- `web/lib/runs/exec-policy-audit.ts:23` — add `budget_warned|budget_escalated|budget_terminated|budget_raised`.
- No `runs.status` set changes (board.ts / portfolio.ts / scheduler.ts / launchability.ts / run-status-sets.ts) because we reuse `NeedsInput`+`Failed` — **assert this explicitly in a test**.

---

## Phases & Tasks

### Phase 0 — Analytics/docs-first (BEFORE any code; exit = complete + internally consistent)

- **T0.1 ✅ Reserve + write ADR-101.** Stub then full `### ADR-101` in `docs/decisions.md`: budget axis, the ladder state machine, scopes, D2 reuse-status, D3 no-refusal/fail-open, D4 token meter, D5 raise-via-override-column. Add the index row to the decisions table. *Deliverable:* ADR-101 header exists at branch HEAD before any citation.
- **T0.2 ✅ execution-policy.md — 10th axis.** Add `budget` to the Preset→axes table, a "budget ladder" state machine (warn/escalate/terminate) + per-scope semantics, the fail-OPEN default row (`budget→unlimited`), and the optional `applyDefaultBudgetForUnattended` auto-fill. Implementation-status tag: Implemented (this milestone).
- **T0.3 ✅ Schema/ERD + config docs.** `docs/database-schema.md` + `docs/db/runs-domain.md`: `runs.budget_ceiling_override`, `runs_root_run_id_idx`. `web/lib/config.schema.ts` doc for the `budget` axis (token fields). `docs/error-taxonomy.md`: `BUDGET_EXCEEDED`. `docs/system-analytics/hitl.md`: `budget_breach` kind. `docs/system-analytics/domain-events.md` + `outbound-webhooks.md`: `run.escalated` `reason=budget_exceeded`.
- **T0.4 ✅ Deployment touchpoints doc.** `docs/configuration.md` env-vars table + `.env.example`: `MAISTER_BUDGET_HARD_MULTIPLIER`, `MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS`. State explicitly these are web-tier reads (no new sidecar/port); note whether the web service `environment:` block in `compose*.yml` needs them for containerized runs.

> **Commit checkpoint A** (after T0.4): `docs(plan): cost-budget governance Phase 0 — ADR-101 + analytics + deployment touchpoints`.

### Phase 1 — Token aggregation foundation

- **T1.1 ✅ Aggregation helpers + migration 0061.** `queryRunTokens(runId)`, `queryTaskTokens(taskId)`, `queryRunTreeTokens(rootRunId)` (SUM of the four token columns over `run_cost_rollups` joined on `runs.task_id` / `runs.root_run_id`) in `web/lib/runs/cost-rollups.ts`. Migration `0061`: `runs_root_run_id_idx` index + `runs.budget_ceiling_override jsonb` (run `pnpm db:generate`; ensure the journal `when` is monotonic above the DB max — known drizzle footgun). Verbose DEBUG of each scope's token total.
- **T1.2 ✅ Failure + wall-clock helpers.** `consecutiveFailedAttempts(runId)` (node_attempts), `consecutiveFailedRuns(taskId|rootRunId)` (runs ordered by `startedAt`), `treeWallClockMinutes(rootRunId)` (`now - root.startedAt`).

### Phase 2 — The axis (execution-policy.ts)

- **T2.1 ✅ Axis type + schema + preset table.** `BudgetLimits` type + `budgetLimitsSchema` (Zod, token fields); wire into `ExecutionPolicyOverrides`/`ResolvedExecutionPolicy`/`PRESET_AXES`/`expandExecutionPolicy`/`executionPolicyOverridesSchema` at the exact lines in D1. Default in all three presets = all-unset (unlimited).
- **T2.2 ✅ `budgetFromSnapshot` resolver** (fail-OPEN all-unset) mirroring the nine resolvers (after execution-policy.ts:388).
- **T2.3 ✅ `applyDefaultBudgetForUnattended` + audit kinds.** Launch-resolution helper (no guard, never throws) wired into `services/runs.ts` around the policy snapshot: unattended + no budget + `MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS` set ⇒ fill `tree.maxTokens`. Add the four `budget_*` `ExecPolicyActionKind` members.

> **Commit checkpoint B** (after T2.3): `feat(runs): execution-policy budget axis (tokens) + default auto-fill + aggregation`.

### Phase 3 — Enforcement watchdog (keepalive-sweeper.ts)

- **T3.1 ✅ Budget candidate selection.** New `runBudgetPass(db)` registered in `runSweepTick` beside `runTimeLimitPass`. Candidates = active runs (`Running`) across `run_kind` (broader than the time pass's `flow`-only) + tree evaluation keyed on `root_run_id` so a `WaitingOnChildren` orchestrator's tree is evaluated while children spend. Force `reconcileRunCostRollups` for the run (and tree/task members) before reading. Resolve `budgetFromSnapshot` (+`budget_ceiling_override` top-up); skip when no set, non-zero limit. **Throttle the forced reconcile** — only re-reconcile a run whose `run_cost_rollups.sourceCursor` is stale — to avoid per-tick disk I/O across a large tree.
- **T3.2 ✅ Ladder evaluation.** Per active scope (run, task, tree), sum tokens / count consecutive failures / compute tree wall-clock, pick the highest rung crossed (warn/escalate/terminate), idempotent (status + audit). Verbose DEBUG of every evaluation. A meter that is unset or `0` is skipped. **Tree scope has no ESCALATE rung** — a parked `WaitingOnChildren` root has no `→ NeedsInput` transition (the orchestrator-resume consumer only drives `→ Running`) — so a tree breach goes straight to TERMINATE-cascade; ESCALATE applies to run/task scope with a `Running` root.
- **T3.3 ✅ WARN rung.** `logExecPolicyAction('budget_warned')` once per threshold crossing; surfaced via Observatory/run badge (read-only).
- **T3.4 ✅ ESCALATE rung (run/task scope).** The watchdog fires MID-RUN while the agent is spending, so escalate must FIRST **halt the live session** (reuse the idle-checkpoint path so spending stops), THEN open the breach HITL — per `run_kind` (D7): flow uses `escalateAutoRetryExhaustion`-style `markNodeNeedsInput`; agent/scratch checkpoint + insert `hitl_requests` + CAS `status=NeedsInput` (no `nodeAttemptId`). One tx → `needs-input.json` (`kind:"budget_breach"`) + `hitl_requests` row + optional assignment + `runs.status=NeedsInput`; AFTER tx → `emitRunEscalated(reason:"budget_exceeded")` + `logExecPolicyAction('budget_escalated')`. Worktree kept. Two-phase/idempotent.
- **T3.5 ✅ TERMINATE rung.** Run scope: `deleteSession`, then the per-`run_kind` adapter (D7) — flow = guarded `status=Failed` + `markNodeFailed(BUDGET_EXCEEDED)`; agent = `finalizeAgentRun(runId,"Failed",{reason:"budget_breach"})`; scratch = `markScratchCrashed`/`applyDialogStatus` — then close assignments + emit `run.failed` + `promoteNextPending`. Tree scope: `cascadeAbandonRunTree(rootRunId, …, reason:"budget_exceeded")` first, then terminate the root. Enumerate crash windows; `deleteSession` `EXECUTOR_UNAVAILABLE` → skip+retry next tick (NOT terminal), 404 → proceed.

> **Commit checkpoint C** (after T3.5): `feat(runs): budget watchdog — warn/escalate/terminate at run/task/tree scope`.

### Phase 4 — HITL response + raise-and-resume

- **T4.1 ✅ `budget_breach` HITL kind.** Add to the `action_kind` TS-enum (`schema.ts`) + `assignments/service.ts:72` union. **Confirmed: no DB CHECK on `action_kind`** (grep of migrations) — pure TS change, no migration ALTER (rides `db:generate`). Confirm `queries/hitl.ts` inbox surfaces it.
- **T4.2 ✅ Response handler.** `handleBudgetBreachResponse` (mirror `handleInfraRecoveryResponse:1255`): **Abandon** → `runs.status=Failed` (errorCode `BUDGET_EXCEEDED`) + close assignments + emit `run.failed`; **Raise** takes a **form input** — the new token ceiling (or a fixed `× multiplier` bump); the `budget_breach` HITL schema carries a number field, NOT a bare `["raise","abandon"]` decision — and writes it to `runs.budget_ceiling_override` (additive top-up) + `logExecPolicyAction('budget_raised')` + `scheduleResume`. `runId` derived from the HITL row (server-state), not the body. Route in `respondToHitl`. Two-phase commit for the resume side-effect.
- **T4.3 ✅ Top-up read path.** `runBudgetPass` reads `budget_ceiling_override` ON TOP of the snapshot ceiling so a raised run doesn't immediately re-escalate.

### Phase 5 — UI surfacing (EN/RU)

- **T5.1 ✅ Launch dialog budget inputs.** Optional per-run/task/tree budget (token) fields in the launch/execution-policy UI; a soft hint when `unattended` is left unbounded (informational only — no disable, no refusal). EN+RU labels.
- **T5.2 ✅ Budget-breach HITL card + badges.** Inbox card for `budget_breach` (Raise / Abandon), a warn badge on the run, Observatory read-only budget-breach surfacing. EN+RU.

> **Commit checkpoint D** (after T5.2): `feat(web): budget launch inputs + breach HITL card + badges (EN/RU)`.

### Phase 6 — Tests + docs checkpoint

- **T6.1 ✅ Integration + unit tests** (runner project named per test; per-phase green): warn/escalate/terminate per scope; tree aggregation + cascade terminate; task tokens + task consecutive-failure; **no-refusal** behavior (unattended + no budget + no env-default → launches unbounded; with env-default → `tree.maxTokens` auto-filled; `maxTokens: 0` → unlimited, no kill); fail-open null snapshot → unlimited; raise-and-resume top-up; idempotency (no double-escalate / re-warn); **the D2 invariant test** asserting no new `runs.status` value was introduced; **a per-`run_kind` arm test** (flow / agent / scratch) for BOTH terminate and escalate (D7 — half-A + half-B ≠ A∘B). Migrate any assertions the new behavior invalidates (enumerate by file).
- **T6.2 ✅ Docs checkpoint** via `/aif-docs` (mandatory): reconcile execution-policy.md, error-taxonomy.md, hitl.md, domain-events.md, configuration.md, database-schema.md + db/runs-domain.md against the diff; confirm every contract surface above is covered.

> **Commit checkpoint E** (after T6.2): `test+docs: budget governance coverage + as-built reconcile`.

## Test integrity (project rule)
- Every promised test names its **runner project** and is confirmed matched by that project's `include` glob (`vitest list`); a test in a new path family gets a runner-config task in the same phase.
- Each phase's exit = full suite green (`pnpm --filter maister-web test:unit && … test:integration`). Pre-existing/harness-limited reds get an explicit quarantine task with a reason, never silent tolerance.
- Assertion migration for behavior the change touches is in-scope in the phase that changes it.

## Out of scope
The compounding/constraints self-improvement loop (separate second-place feature); USD/cost conversion + a model-price table (tokens are the v1 unit); a new cost *source* (reuse rollups); supervisor-side inline per-step enforcement; flipping node-level `maxCostUsd` from record-only; per-model/per-tool cost breakdown UI.
