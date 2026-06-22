# SDD Spec — Cost-budget governance (execution-policy spend axis)

> **Status:** Spec for implementation (2026-06-22). Drives the 6-phase plan
> `.ai-factory/plans/worktree-cost-budget-governance.md`. Canonical contract
> docs are under `docs/` (this file is the SDD planning artifact and cross-
> references them; per docs R7 it never duplicates a canonical contract).
>
> **Owner decisions (locked):** metered in **tokens** (not USD); enforcement is
> **opt-in, fail-open** — absent or `0` limit ⇒ "run, don't constrain"; **no
> launch refusal**.

## 1. Summary

A tenth execution-policy axis **`budget`** that enforces **token /
consecutive-failure / wall-clock** ceilings at **run + task + run-tree** scope
via a **warn → escalate → terminate** ladder, reusing the existing keepalive
sweeper watchdog, the `NeedsInput`/`Failed` statuses, the `infra_recovery` HITL
pattern, the `run.escalated` domain event, and the orchestrator cancel-cascade.
It closes the spend-rail gap: today `unattended` + `ralph_loop` + the M37 swarm
enforce only **count** caps; `maxCostUsd` is record-only.

## 2. Scopes & meters

| Scope | Aggregation key | Motivation |
| ----- | --------------- | ---------- |
| `run`  | one run | a single runaway agent session |
| `task` | all runs of `runs.task_id` (the 1:N retry/ralph chain) | a ralph-loop relaunching and burning tokens across runs |
| `tree` | `runs.root_run_id` (orchestrator run-tree) | a swarm/as-plan DAG bounded only by fanout+depth counts today |

| Meter | run | task | tree | Source |
| ----- | :-: | :--: | :--: | ------ |
| `maxTokens` = input+output+cache_read+cache_creation (incl. resume tax) | ✓ | ✓ | ✓ | `run_cost_rollups` (sum of the four token columns) |
| `consecutiveFailures` | ✓ (failed node attempts) | ✓ (failed runs) | ✓ (failed child runs) | `node_attempts` / `runs` |
| `wallClockMinutes` | — | — | ✓ | `now − root.started_at` |

## 3. Data shapes (LOCKED — code follows this)

### 3.1 Axis (client-safe, `web/lib/runs/execution-policy.ts`)

```ts
// absent OR 0 = unlimited (fail-OPEN; "run, don't constrain")
type BudgetLimits = {
  maxTokens?: number | null;          // escalate ceiling (100%)
  hardMaxTokens?: number | null;      // terminate ceiling; unset ⇒ maxTokens * MAISTER_BUDGET_HARD_MULTIPLIER (default 1.25)
  consecutiveFailures?: number | null;
  wallClockMinutes?: number | null;   // tree scope only
  warnAtPct?: number | null;          // default 80
};
type BudgetScope = "run" | "task" | "tree";
type BudgetAxis = { run?: BudgetLimits; task?: BudgetLimits; tree?: BudgetLimits };
```

`budget?: BudgetAxis` is added to `ExecutionPolicyOverrides` and
`ResolvedExecutionPolicy`; every `PRESET_AXES` entry defaults `budget` to
all-unset (unlimited); `expandExecutionPolicy` folds `o.budget ?? base.budget`;
`executionPolicyOverridesSchema` gains `budget: budgetAxisSchema.optional()`.
Rides the existing `runs.execution_policy` jsonb snapshot — **no migration for
the axis itself**.

### 3.2 Per-run mutable budget state (server, migration 0061)

```ts
type BudgetRung = "warn" | "escalate" | "terminate";
type BudgetState = {
  ceilingOverride?: BudgetAxis;                       // raise-and-resume: per-scope limits that OVERRIDE the snapshot
  notified?: Partial<Record<BudgetScope, BudgetRung>>; // highest rung already actioned per scope (idempotency)
};
```

Persisted as `runs.budget_state jsonb` (nullable). **Why this column and not the
plan's `budget_ceiling_override`** — see recon-correction #5 (§7): the execution
snapshot is immutable, and `logExecPolicyAction` is a **log boundary, not a
queryable audit table**, so the plan's "derive idempotency from audit rows"
premise does not hold. `budget_state` carries BOTH the raise-and-resume top-up
AND the per-scope `notified` rung that makes warn/escalate idempotent — in ONE
column (the same single migration ALTER the plan budgeted).

**Effective limit resolution in the watchdog:**
`effective(scope, meter) = budget_state.ceilingOverride?.[scope]?.[meter] ?? snapshot.budget?.[scope]?.[meter]`.

## 4. The breach ladder

Per metered dimension, per active scope, whichever rung trips first (a meter
that is unset or `0` is skipped):

```
spend / failures / wallclock vs effective limits
  ≥ warnAtPct (80%)  → WARN      : logExecPolicyAction('budget_warned'), set notified[scope]=warn,
                                   surfaced badge (derived); run continues
  ≥ 100% (maxTokens) → ESCALATE  : halt live session (idle-checkpoint so spend stops) → pause to
                                   NeedsInput (budget_breach HITL, worktree KEPT), emit run.escalated
                                   (reason=budget_exceeded), logExecPolicyAction('budget_escalated'),
                                   set notified[scope]=escalate; HITL offers [Raise & resume] / [Abandon]
  ≥ hardMaxTokens    → TERMINATE : deleteSession → run terminal Failed (BUDGET_EXCEEDED);
                                   tree breach → cascadeAbandonRunTree first, then root;
                                   logExecPolicyAction('budget_terminated')
```

**Idempotency:** ESCALATE/TERMINATE are free via `runs.status` (a `NeedsInput`/
`Failed` run is no longer a watchdog candidate). WARN-once is via
`budget_state.notified[scope]`. On **Raise & resume**, `notified[scope]` is
cleared so the raised band re-warns correctly.

**Tree scope has NO ESCALATE rung** — a parked `WaitingOnChildren` root has no
`→ NeedsInput` transition (the orchestrator-resume consumer only drives
`→ Running`), so a tree breach goes straight to TERMINATE-cascade. ESCALATE
applies to run/task scope with a `Running` **flow** root; a non-flow run/task
breach is likewise promoted to terminate (the raise-resume path is flow-only).

## 5. `run_kind` dispatch (D7 — branch BEFORE routing)

The watchdog candidate set spans `flow | agent | scratch`; the breach mechanism
**branches on `run_kind` before routing** (a flow-only path applied to an
agent/scratch run misbehaves — those have no `node_attempts`/`current_step_id`).

| | `flow` | `agent` | `scratch` |
| --- | --- | --- | --- |
| **TERMINATE** (after `deleteSession`) | CAS `status=Failed` + `markNodeFailed(BUDGET_EXCEEDED)` | `finalizeAgentRun(runId,"Failed",{reason:"budget_breach"})` | real `scratch_runs.dialog_status` finalizer (verify fn) |
| **ESCALATE** (halt session first; **flow only**) | idle-checkpoint + `markNodeNeedsInput` | — promoted to TERMINATE | — promoted to TERMINATE |

**ESCALATE is flow-only in v1.** The raise-and-resume path is `runFlow`/`loadRun`,
which only re-enters a flow graph (a non-flow run has `flowId=null` → `loadRun`
throws, stranding the run). So a non-flow (`agent`/`scratch`) run/task
escalate-band breach is **promoted to terminate** in `evaluateBudgetForCandidate`
(same as the tree scope). The kind-agnostic TERMINATE path still protects
agent/scratch at the hard ceiling; agent/scratch budget escalate-raise is deferred
to a future iteration (no extra provisioning to drive a non-flow resume today).

Cost aggregation is **kind-agnostic** (`reconcileRunCostRollups` keys on runId,
processes `cost.jsonl` with no node_attempts), so per-task/per-tree token sums
over agent children are correct without a kind branch. **A test exercises EACH
arm** (project rule: half-A + half-B ≠ A∘B).

## 6. Screens / UI / UX

### 6.1 Launch dialog — budget inputs (T5.1)

- **Where:** the existing launch / execution-policy dialog (the surface that
  picks preset + axis overrides). Add an optional **Budget** sub-section.
- **Controls:** three collapsible groups (Run / Task / Tree), each with numeric
  token inputs: *Max tokens*, *Hard max tokens* (placeholder shows the computed
  `maxTokens × 1.25` default), *Warn at %* (default 80), *Consecutive failures*;
  Tree additionally shows *Wall-clock minutes*. All optional; empty = unlimited.
- **States:** default = all empty (unlimited). When preset = `unattended` AND
  all three scopes empty → a **soft informational hint** (amber, non-blocking):
  "Unattended run with no budget — it will run unbounded. Set a token budget or
  configure `MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS`." No disable, **no
  refusal**.
- **Acceptance criteria:**
  - AC-UI-1: leaving every field empty launches an unbounded run (no error).
  - AC-UI-2: a non-numeric / negative token value is rejected inline with an
    `aria` error before submit (sink-invariant validation, positive int).
  - AC-UI-3: the unattended-unbounded hint renders only when preset=unattended
    AND no budget set; it never blocks Launch.
  - AC-UI-4: EN + RU labels present, parity test green, each key has a render
    site (skill-context i18n rule).

### 6.2 Budget-breach HITL card (T5.2)

- **Where:** the `/inbox` needs-you list and the run-detail HITL panel, as a new
  card for `hitl_requests.kind = 'budget_breach'` (mirrors the `infra_recovery`
  card).
- **Content:** breach summary — *scope* (Run/Task/Tree), *meter* (tokens /
  failures / wall-clock), *current* vs *limit*, and the run/task identity. Two
  actions: **Raise & resume** (primary) and **Abandon** (destructive, rose).
- **Raise form:** a single numeric input "New token ceiling" (pre-filled with
  `current × 2` as a suggestion) — submitting writes `budget_state.ceilingOverride`
  for the breached scope and resumes. Abandon → run `Failed` (`BUDGET_EXCEEDED`).
- **Acceptance criteria:**
  - AC-HITL-1: card shows scope + meter + current/limit; no `acp_session_id` or
    other server handle leaks to the client (DTO projection).
  - AC-HITL-2: Raise requires a positive integer > current limit; Abandon needs
    no input.
  - AC-HITL-3: the `runId` acted on is derived from the HITL row server-side,
    never a request body field.
  - AC-HITL-4: EN + RU; icon affordances; success shown as a green check glyph.

### 6.3 Run + Observatory badges (T5.2)

- A **warn badge** on the run (run-detail header + board flight card / active-
  workspaces row) when the run is in the warn band — **derived** from current
  tokens ≥ `warnAtPct` (no persisted UI flag).
- Observatory read-only surfacing of budget breaches, consistent with its
  existing read-only metric style. **Implemented (escalations + terminations
  counts; warn not surfaced).** `getPortfolioObservatory` /
  `getProjectObservatory` add a `budget` summary (`budgetEscalations` +
  `budgetTerminations`) over `domain_events`, project + window scoped, via ONE
  grouped SELECT: escalations = `run.escalated` / `payload.reason =
  budget_exceeded`; terminations = `run.failed` / `payload.reason ∈
  {budget_exceeded, BUDGET_EXCEEDED, budget_breach}` (the terminate reason is not
  normalized across flow/scratch/agent/tree-root — all three matched). The
  portfolio Observatory cost tab renders a read-only `BudgetSurfaceCard` tile
  (EN+RU). The **WARN** rung is NOT surfaced — it is a `logExecPolicyAction` log
  line with no domain event; warn-band visibility stays on the run-detail badge.
- **Acceptance criteria:**
  - AC-BADGE-1: badge appears iff the run's live token sum ≥ warn threshold and
    disappears if a Raise lifts the ceiling above the current sum.
  - AC-BADGE-2: Observatory surfacing is read-only (no actions), EN + RU.

> A visual mockup of 6.1–6.3 is produced at Phase 5 (the `visualize` tool) and
> linked from `docs/screens/*`.

## 7. Recon corrections to the plan (verified at branch HEAD `d14a28ba`)

These six drifts between the plan's `file:line` map and the actual code were
confirmed by reading the code; implementers MUST follow the corrected anchors:

1. **`runs_root_run_id_idx` already exists** (`web/lib/db/schema.ts:1331`, added
   by M37). Migration 0061 adds **only** `runs.budget_state jsonb` — NOT the
   index. (Design §6 and plan T1.1 predate the M37 index.)
2. **HITL kind column is `hitl_requests.kind`** (`schema.ts:2324`, enum
   `["permission","form","human","infra_recovery"]`, TS-only, no DB CHECK) → add
   `"budget_breach"`. The `action_kind` at `schema.ts:2200` is the separate
   **`assignments`** table enum (`["permission","form","human_review",
   "manual_takeover","merge_conflict","infra_recovery"]`) → also add
   `"budget_breach"` there, plus the `assignments/service.ts:72` union.
3. **`emitRunEscalated` exists** but is module-private in
   `web/lib/flows/graph/runner-graph.ts:355` (with `escalateAutoRetryExhaustion`
   at `:389`). The multi-kind budget watchdog must **export/factor** it (the
   `run.escalated` domain-event + webhook taxonomy already list the kind;
   `domain_events.kind` CHECK at `schema.ts:3383` already allows `run.escalated`).
4. **`MaisterErrorCode` lives in `web/lib/errors-core.ts:8`** (re-exported by
   `errors.ts`). Add `"BUDGET_EXCEEDED"` there.
5. **`logExecPolicyAction` (`exec-policy-audit.ts:36`) is a pino LOG boundary,
   not a DB table.** So idempotency cannot read "audit rows". Resolution:
   `runs.budget_state.notified[scope]` (see §3.2). Escalate/terminate are also
   status-derived (non-candidate once `NeedsInput`/`Failed`).
6. **Scratch terminal uses `scratch_runs.dialog_status`** — the implementer must
   locate the real finalizer (the plan's `markScratchCrashed`/`applyDialogStatus`
   names are illustrative, not verified symbols).

## 8. Functional expectations (acceptance contract)

These become the Expectations bullets in
`docs/system-analytics/execution-policy.md` (R5a) and the test targets in T6.1:

- **E1.** A run with no set/non-zero budget meter at any scope is NEVER killed,
  paused, or refused by the budget axis (fail-open). `maxTokens: 0` ≡ unlimited.
- **E2.** `budgetFromSnapshot(null | absent | malformed)` resolves to all-unset
  (unlimited) — fails **OPEN** (the inversion vs. safety axes that fail-closed
  to `strict`).
- **E3.** WARN fires at `warnAtPct` (default 80%) without killing and at most
  once per scope per band (`budget_state.notified`).
- **E4.** ESCALATE at 100% `maxTokens` (run/task scope) halts the live session
  first, then pauses to `NeedsInput` with a `budget_breach` HITL, keeps the
  worktree, emits `run.escalated` (`reason=budget_exceeded`), all persistent
  writes in ONE transaction, `scheduleResume`/notify after commit.
- **E5.** TERMINATE at `hardMaxTokens` (= `maxTokens × MAISTER_BUDGET_HARD_MULTIPLIER`
  when unset) calls `deleteSession`, then marks the run terminal `Failed` with
  `BUDGET_EXCEEDED`; it NEVER marks `Failed` until the session is confirmed
  stopped/absent — `EXECUTOR_UNAVAILABLE` leaves the run live to retry next tick,
  `404` proceeds (skill-context CAS/never-mark-Failed rule).
- **E6.** A `tree`-scope breach cascade-terminates the whole run-tree
  (`cascadeAbandonRunTree`, one tx, `promoteNextPending` per pool) then flips the
  root; tree scope has no escalate rung.
- **E7.** `task` token spend = SUM of the four token columns over all
  `runs WHERE task_id = T`; `task.consecutiveFailures` = trailing streak of
  `Failed|Crashed|Abandoned` runs for the task.
- **E8.** The breach mechanism branches on `run_kind` before routing; each of
  flow/agent/scratch has a verified terminate adapter. ESCALATE is **flow-only**
  in v1 — a non-flow run/task escalate-band breach is promoted to terminate
  (`evaluateBudgetForCandidate`), since the raise-resume path (`runFlow`) only
  re-enters a flow graph; agent/scratch budget escalate-raise is deferred.
- **E9.** No new `runs.status` value is introduced — the ladder reuses
  `NeedsInput` + `Failed` (asserted by a dedicated test; `launchability.ts`'s
  exhaustive `satisfies Record<RunStatus,…>` stays green).
- **E10.** Raise-and-resume writes `budget_state.ceilingOverride` (additive, the
  snapshot stays immutable), logs `budget_raised`, clears `notified[scope]`, and
  the resumed run does not immediately re-escalate (effective ceiling raised).
- **E11.** The budget pass forces `reconcileRunCostRollups` for the candidate run
  before reading its meters, bounding overshoot to ~one tick. The reconcile is a
  cheap no-op (`missing-cost-file`) when nothing is on disk, so it runs per
  candidate each tick; task/tree member runs are read from their existing rollups
  (reconciled by their own candidacy / the runner write path). A
  `sourceCursor`-based throttle is a possible future optimization, not v1.
- **E12.** New env vars `MAISTER_BUDGET_HARD_MULTIPLIER` and
  `MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS` are documented in
  `docs/configuration.md` + `.env.example` (+ deployment overlays if
  production-relevant) — runtime-contract symmetry.

## 9. Out of scope

Self-improvement/constraints loop; USD conversion + model-price table (tokens
are the v1 unit); a new cost source (reuse rollups); supervisor-side inline
per-step enforcement; flipping node-level `maxCostUsd` from record-only; per-
model/per-tool cost breakdown UI.

## 10. Linked artifacts

- Plan: `.ai-factory/plans/worktree-cost-budget-governance.md`
- Design: `docs/plans/2026-06-21-cost-budget-governance-design.md`
- ADR: ADR-101 (`docs/decisions.md`)
- Behavior contract: `docs/system-analytics/execution-policy.md` (10th axis)
- Source seams: `execution-policy.ts`, `exec-policy-audit.ts`,
  `keepalive-sweeper.ts`, `cost-rollups.ts`, `services/runs.ts`, `services/hitl.ts`,
  `errors-core.ts`, `db/schema.ts` + migration 0061, `orchestrator/cascade.ts`,
  `flows/graph/runner-graph.ts` (`emitRunEscalated`).
</content>
</invoke>
