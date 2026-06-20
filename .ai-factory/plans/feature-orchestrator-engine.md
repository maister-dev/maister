# Orchestrator Engine — Implementation Plan

> **Branch:** `feature/orchestrator-engine` (off `main` @ 757a5e9e)
> **Created:** 2026-06-16
> **Milestone:** M36 (proposed)
> **Engine:** flow engine `1.5.0 → 1.6.0` (orchestrator node debuts at `1.6.0`)
> **Reserved numbers (allocate up front per skill-context):**
> - **ADR-095** — Orchestrator engine (node type, run-tree, delegation, as-plan, wait/resume)
> - **ADR-096** — Persistent swarm Layer 2 (sessions, star messaging, worktree modes, per-agent perms)
> - **Migration 0055** — foundation (run-tree + status + node_attempts type + launch snapshots + plan/launch-mode)
> - **Migration 0056** — swarm L2 (persistent-session + worktree-mode columns)
> - A **renumber pass** is a budgeted deliverable AFTER rebasing onto main before merge (Phase 12).
>
> **Refined (iter-2, 2026-06-16):** load-bearing gaps closed — orchestrator-session token/facade (T2.5, blocks Phase 3), `parent_run_id` in run-terminal event payloads (T1.3, blocks T4.3/T5.2), cancel cascade down the run-tree (T7.4), `requires` gating wired into the shared launchability classifier, cap-safe auto-launch, mock-adapter e2e, `delegation_snapshot` disambiguation.

## Settings

- **Testing:** yes — vitest unit + integration (testcontainers), playwright e2e. Per-phase green gate (`pnpm --filter maister-web test:unit && test:integration`) is exit criteria for every code phase. Supervisor: `pnpm --filter @maister/supervisor test`.
- **Logging:** verbose — DEBUG on every delegation hop, idle/resume transition, auto-launch decision, and dependency-block evaluation; INFO on run-tree edges + status transitions; WARN on refused delegation / cycle / fan-out cap.
- **Docs:** yes — mandatory `/aif-docs` checkpoint at completion; **docs-first Phase 0** below is a hard gate before any code phase.

## Roadmap Linkage

- **Milestone:** "M36 — Orchestrator engine (sub-agent run-tree + dynamic task-DAG + persistent swarm)"
- **Rationale:** First dynamic-orchestration capability; converts maister from static-flow-only to governed-dynamic delegation. Foundation for the parked dynamic-flow-synthesis milestone (~M37). (Does NOT edit `ROADMAP.md` — that is `/aif-roadmap`'s job; this is a plan-side linkage only.)

## Scope

**In scope — Part A (Foundation):** `orchestrator` flow node type (long-lived supervisory node) · run-tree (`parent_run_id`/`root_run_id`) · `WaitingOnChildren` run status · delegation toolset over the MCP facade (`run_delegate` as-task|as-run, `run_collect`, `run_cancel`) · `run_plan` task-DAG with success-gated deps + auto-launcher · idle-checkpoint wait + child-terminal-event resume · catalog-resolved children (M34 effective definition, **snapshotted on the child run row**) · workbench dynamic-subtree render.

**In scope — Part B (Swarm L2):** persistent addressable agent sessions (scratch-session reuse) · star-routed messaging through the orchestrator · sleep/wake = idle/resume-on-message · worktree modes (shared vs own-from-branch) · per-agent permissions (reviewer read-only = reuse L1/L2/L3).

**Out of scope (flag, do not build):**
- **Per-path write enforcement** ("tester edits only tests") — maister enforces read-only-vs-full only; path-scoped writes need the **policy layer** (deferred) or OS sandbox `write_paths`. Ship as `instructed`-only with a refusal-on-`strict`; real enforcement is a follow-up tied to the policy layer.
- **Mesh messaging** (direct A→B) — star-through-orchestrator only.
- **Runtime-authored agents** (omnigent `config_path`) — children are catalog-resolved only.
- **Dynamic flow synthesis** (a node that generates a whole FlowGraph) — parked as ~M37.
- **Cost budget** — deferred; concurrency pool only.

## Key Decisions

1. **Orchestrator is a long-lived SUPERVISORY node, not run-to-terminal.** The flow "parks" on it: it spawns/coordinates children, idle-checkpoints while blocked, and reaches a terminal verdict only when the LLM declares the goal met → normal downstream transitions into judge/readiness/promote. Reuses `NodeResult.needsInput` → checkpoint eligibility (`runner-graph.ts`). Governance is structural: every hop routes through this one node, so policy/ensure-gate/HITL/audit attach there.

2. **Children are governed Runs, dynamism is in coordination.** Each delegated unit is a real Run (worktree, gates, promotion, board visibility, concurrency cap). `as-task` → child task via `parent_of` (Kanban) + run; `as-run` → child run only (`parent_run_id`, workbench subtree, no board card). `as-plan` → a DAG of child tasks + `depends_on` edges.

3. **New run status `WaitingOnChildren`** (allow-list everywhere). Holds NO scheduler slot — the orchestrator idle-checkpoints (frees its agent-pool slot via `releaseSlotOnIdle`→`promoteNextPending`) and is resumed by a child-terminal domain event. This avoids pool starvation (agent cap = 3).

4. **Success-gated dependencies for auto-DAGs.** `depends_on`/`blocks` today release on Done **AND** Abandoned (`relations.ts:217`) — correct for a human board, WRONG for auto-execution. Introduce a **`requires` relation kind** (success-gated: releases only on Done; Failed/Abandoned keeps dependents blocked + wakes the orchestrator). `parent_of` continues to never gate.

5. **Snapshot the launch-time effective definition on the child run row** (skill-context rule 207). The catalog-resolved child agent's effective definition + resolved runner are SNAPSHOTTED at spawn (`runs.runner_snapshot` already exists; add `runs.delegation_snapshot`), so the terminal/enforcement path reads what the child actually launched with, never re-derives from a drifting projection.

6. **Branch shared dispatch on `run_kind` BEFORE routing** (skill-context rule 207). The child-terminal resume consumer and reconcile classifier MUST branch on `run_kind`/parent-linkage before driving a run into the flow resume driver — an orchestrator-child driven into the flow-only path `Crashes` context-less. Guard at the irreversible apply site + a test per discriminant arm.

7. **Trust: catalog-resolved, never runtime-authored.** Child resolution goes through M34 `resolveEffectiveAgentDefinition` (enablement + trust gates, pinned revision). A `run_delegate`/`run_plan` naming an agent not resolvable through the project's enabled+trusted catalog is refused (`PRECONDITION`) — physically separate "resolve+trust" from "launch", mandatory regression: delegate to an untrusted/disabled agent → assert no child run created.

### Identifier trust-boundary labels (new routes — skill-context rule)

`run_delegate` / `run_plan` / `run_collect` / `run_cancel` run inside an agent session over the MCP facade with an ephemeral `agent:<id>` token.

| Field | Label | Handling |
| --- | --- | --- |
| `projectId` | `auth-context` | Derived from the agent token's project binding — NEVER body-controlled. |
| parent `runId` | `server-state` | Derived from the token's run binding (`agent-run:{runId}`), not the body. |
| `agentId` / `flowId` (child target) | `body-controlled` | Validated against the project's enabled+trusted catalog (allow-list); unknown ⇒ `PRECONDITION`. |
| `prompt`, `title` | `body-controlled` | Free text; length-bounded; no path use. |
| `depends_on` edges | `body-controlled` | Validated acyclic + in-batch references only; cross-batch/external ids refused. |

### Two-phase commit + multi-store atomicity (skill-context rules)

- **Child run creation** (`run_delegate`/`run_plan` → child run): the tool calls `POST /api/v1/ext/runs` so the **web tier owns the transaction** (run row insert + task/relation rows). Supervisor `POST /sessions` stays AFTER commit; orphan (committed run, no session) is reconciled to `Crashed` by the existing per-project reconcile sweep. Idempotency marker (`spawnedAt`) is the AFTER-side write.
- **`run_plan` emit** writes N task rows + M relation rows in ONE `db.transaction` (no partial DAG). Cycle/depth/fan-out validation + catalog resolution happen BEFORE the tx (clean `PRECONDITION`/`CONFIG`, no rows written).
- **Auto-launch on dependency-clear**: the status CAS (`WaitingInBacklog`/`Pending` → `Running`) + slot accounting fold into the existing `promoteNextPending` advisory-locked path; no new intermediate committed state.
- **Orchestrator wait/resume**: `Running → WaitingOnChildren` (idle-checkpoint, slot released) and `WaitingOnChildren → Running` (resume) each close every store (status + `node_attempts` cursor) in one tx; enumerate crash windows (death between checkpoint write and supervisor SIGTERM; death between child-event consume and parent resume RPC) with a tested recovery path each (reconcile + the keepalive sweeper Pass-1 exclusion).
- **Deferred-release on every failure path**: if a child spawn fails after the parent registered an expectation, the orchestrator's pending-child bookkeeping MUST be released (the child-terminal consumer also fires on `run.failed`/`run.crashed`); a regression asserts a failed child still wakes the parent.

### Contract surfaces → spec files (trace at plan-write; `/aif-verify` re-derives)

| Surface | Spec file(s) |
| --- | --- |
| New node type `orchestrator` + settings shape | `docs/flow-dsl.md` + `web/lib/config.schema.ts` + `docs/system-analytics/orchestrator.md` |
| MCP tools `run_delegate`/`run_plan`/`run_collect`/`run_cancel` | `docs/api/web.openapi.yaml` (`/api/v1/ext/*`) + the MCP facade doc + `docs/system-analytics/external-operations.md` |
| New run status `WaitingOnChildren` | `docs/system-analytics/runs.md` + `docs/api/async/web-runs.asyncapi.yaml` (SSE) |
| `runs.parent_run_id`/`root_run_id`/`delegation_snapshot`, `node_attempts` type, `task_relations` `requires` kind | Migration 0055 + `docs/database-schema.md` + `docs/db/runs-domain.md` + `docs/db/social-board.md` |
| New domain-event consumer (orchestrator resume) + any new event kind | `docs/system-analytics/domain-events.md` + `docs/db/domain-events.md` |
| New env vars | `docs/configuration.md` env table + `.env.example` |
| ADR-095 / ADR-096 | `docs/decisions.md` (stub headers written before first citation) |

### Deployment touchpoints (skill-context rule)

| New dep | Lands in |
| --- | --- |
| `MAISTER_MAX_ORCHESTRATOR_FANOUT` (per-plan task cap, default 16) | `.env.example` + `docs/configuration.md` (web reads it) |
| `MAISTER_ORCHESTRATOR_MAX_DEPTH` (run-tree recursion bound, default 3) | `.env.example` + `docs/configuration.md` |
| Engine floor `1.6.0` | `web/lib/flows/engine-version.ts` + `docs/flow-dsl.md` |

No new sidecar/port — the orchestrator runs as an ordinary ACP session; delegation reuses the existing MCP facade + supervisor. (If none of these env vars is added, drop this section; do not skew dev/prod silently.)

---

# PART A — FOUNDATION

## Phase 0 — Analytics & contracts (docs-first, HARD GATE before any code)

> Exit criteria: every artifact below COMPLETE and INTERNALLY CONSISTENT, status-tagged (Implemented/Designed/Phase 2 per `docs/CLAUDE.md` R6). No code phase starts until Phase 0 is green.

- **T0.1 — ADR-095 + ADR-096 stub headers.** Write `### ADR-095: Orchestrator engine` and `### ADR-096: Persistent swarm Layer 2` in `docs/decisions.md` (full decision text for 095; 096 may be a Designed stub). Reserve before any citation. Verify via `scripts/validate-docs-adr-anchors.mjs`. **Logging:** n/a. **Tests:** ADR-anchor validator green.
- **T0.2 — `docs/system-analytics/orchestrator.md`** per R5 (Purpose, Domain entities, State machine, Process flows, Expectations ≤12, Edge cases, Linked artifacts). MUST enumerate: orchestrator node lifecycle (park → delegate → WaitingOnChildren → resume → complete → transition), the run-tree, the as-plan DAG with the `requires` success-gate, every run-status transition + refusal, the delegation tool contracts. State the allow-lists exactly as code will gate.
- **T0.3 — ERD + schema docs.** `docs/database-schema.md` narrative AND `docs/db/runs-domain.md` + `docs/db/social-board.md` Mermaid `erDiagram` for: `runs.parent_run_id`/`root_run_id`/`delegation_snapshot`/`launch_mode`, `runs.status` new value, `node_attempts.node_type` new value, `task_relations.kind` `requires`. Both artifacts, same change.
- **T0.4 — API/event specs.** `docs/api/web.openapi.yaml`: the four ext delegation routes (paths, bodies, status codes, identifiers labelled). `docs/api/async/web-runs.asyncapi.yaml`: the `WaitingOnChildren` SSE status. `docs/system-analytics/domain-events.md` + `docs/db/domain-events.md`: the orchestrator-resume consumer (and whether a new `run.*` kind is needed — prefer reusing `run.done/failed/crashed/abandoned` + a `parent_run_id` payload field, no new kind).
- **T0.5 — flow-dsl + engine version.** `docs/flow-dsl.md`: the `orchestrator` node type + settings + the `1.6.0` floor + delegation semantics. Tag the swarm pieces `(Phase 2)`.
- **T0.6 — Error taxonomy check.** Confirm no new `MaisterError` code is needed (reuse `PRECONDITION`/`CONFIG`/`CONFLICT`/`EXECUTOR_UNAVAILABLE`); document the mapping in `docs/error-taxonomy.md` callers list. (ADR-008 closed union — do NOT add a code.)

**Commit checkpoint:** `docs(orchestrator): M36 Phase 0 analytics + ADR-095/096 + contracts`.

## Phase 1 — Schema + status fan-out foundation

- **T1.1 — Migration 0055.** Add to `runs`: `parent_run_id text` (nullable, FK→runs, on-delete set-null), `root_run_id text` (nullable, FK→runs), `delegation_snapshot jsonb` (nullable), `launch_mode text` (nullable; `auto`|`manual`). Add `WaitingOnChildren` to `runs.status` (`web/lib/db/schema.ts:1184`). Add `orchestrator` to `node_attempts.node_type` (`schema.ts:~1717`). Add `requires` to `task_relations.kind` (`web/lib/social/relations.ts:27`). Indexes on `parent_run_id`, `root_run_id`. **`delegation_snapshot` holds ONLY the effective agent-definition id + pinned revision** (M34 snapshot pattern) — the resolved runner stays in the existing `runs.runner_snapshot`, do NOT duplicate it. **Config-state symmetry:** n/a (not YAML-persisted). **Tests:** migration up/down on Postgres + SQLite; FK cascade behavior.
- **T1.2 — Fan `WaitingOnChildren` to ALL consumers (allow-list).** Single task, grep-driven, touches every site Agent-B enumerated:
  - **Read models:** `web/lib/queries/portfolio.ts:62` `ACTIVE_RUN_STATUSES` (+`WaitingOnChildren`), `:73` `ACTIONABLE_ASSIGNMENT_RUN_STATUSES` (exclude), `:1103` inbox (exclude); `web/lib/queries/board.ts` InFlight bucket (+); `web/lib/projector/catch-up-sweep.ts:22` `IN_FLIGHT_STATUSES` (+); `web/lib/queries/flow-packages.ts:22` `NON_TERMINAL_RUN_STATUSES` (+); `web/lib/queries/hitl.ts:54` (exclude); `web/lib/gc/ephemeral-agent-gc.ts:33` `LIVE_AGENT_STATUSES` (decide).
  - **Scheduler:** `web/lib/scheduler.ts` `countLiveRuns` (line ~109) — `WaitingOnChildren` does NOT count against the cap (it's checkpointed); confirm `releaseSlotOnIdle`/`promoteNextPending` fire on the transition.
  - **Sweeps:** `web/lib/runs/keepalive-sweeper.ts` Pass-1 (exclude `WaitingOnChildren` from idle-timeout), Pass-2 (exclude from 24h-abandon); `web/lib/reconcile.ts` (orphaned-child detection); `web/lib/gc/workspace-gc.ts` (terminal-only — unaffected).
  - **Guards:** `web/lib/runs/state-transitions.ts` — add allow-list transitions `Running→WaitingOnChildren` and `WaitingOnChildren→Running`; HITL respond guard stays allow-list `{NeedsInput, NeedsInputIdle}`.
  - **Board column:** `WaitingOnChildren` renders in `InProduction` with a distinct "waiting on N children" affordance.
  - **Acceptance:** a grep for the new status name appears in every consumer class above; a test asserts a `WaitingOnChildren` run is visible in portfolio + board AND not counted by `countLiveRuns`.
  - **Logging:** INFO on each status transition with `runId`, `parentRunId`, child count.
- **T1.3 — `parent_run_id` in run-terminal event payloads (blocks T4.3 + T5.2).** Every run-terminal `emitDomainEvent` MUST carry `parent_run_id` so the auto-launcher and resume consumer can route to the parent. Emit sites to cover: `web/lib/agents/launch.ts:956-972` (agent terminal CAS map), `web/lib/workbench-lifecycle/service.ts:1509` (abandon), AND the flow-graph terminal path (locate + cover — not in the agent path). No new event KIND (reuse `run.done/failed/crashed/abandoned`); only the payload widens. **Tests:** a terminating child emits an event whose payload contains its `parent_run_id`; a parentless run emits `null` (no regression).

**Commit checkpoint:** `feat(runs): M36 run-tree columns + WaitingOnChildren status fanned to all consumers`.

## Phase 2 — Orchestrator node type

- **T2.1 — Schema.** `web/lib/config.schema.ts`: add `orchestratorNodeSchema` (type literal `"orchestrator"`, `action.prompt`, `settings: aiCodingSettingsSchema` to inherit the capability shape, `delegation` sub-block: `max_fanout?`, `max_depth?`), append to `nodeSchema` discriminated union (~line 845). **Tests:** schema accepts a valid orchestrator node, rejects unknown settings.
- **T2.2 — Engine floor.** `web/lib/flows/engine-version.ts`: add `1.6.0` floor; orchestrator nodes require `compat.engine_min >= 1.6.0` (refuse at load with `CONFIG` otherwise). **Tests:** a flow with an orchestrator node and `engine_min: 1.5.0` is refused.
- **T2.3 — Enforcement.** `web/lib/flows/enforcement.ts`: extend `assertNodeLaunchable` (line ~152) and `capabilityBearingSettings` (line ~184) to include `orchestrator` (inherits ai_coding classes; all `instructed` per the frozen table — no `enforced` cell). **Tests:** `strict` capability on an orchestrator node refuses exactly like ai_coding.
- **T2.4 — Runner dispatch (supervisory lifecycle).** `web/lib/flows/graph/runner-graph.ts`: add `case "orchestrator"` (switch ~line 565) → `runOrchestratorStep()`. Reuse `runAgentStep` to spawn the ACP session, but: (a) expose the delegation MCP tools to it, (b) when the agent yields awaiting children, return `NodeResult{ needsInput: true }` → checkpoint → `WaitingOnChildren`; (c) when the agent emits a terminal "goal met" signal, write the `node_attempts` terminal verdict and transition downstream. `compile.ts` carries `nodeType: "orchestrator"` to the ledger. **Logging:** DEBUG on park/yield/resume/complete. **Tests:** a stub orchestrator node parks then completes; the flow transitions downstream on completion.
- **T2.5 — Ephemeral token + maister-facade for the orchestrator session (LOAD-BEARING; blocks all of Phase 3).** Today `issueAgentRunToken` (`web/lib/agents/tokens.ts:35`, name `agent-run:{runId}`) + the maister MCP facade are wired ONLY in the agent-run launch path (`web/lib/agents/launch.ts:1456`). The orchestrator is a **flow** run, so without new wiring it never receives the facade/token and **cannot call the delegation tools at all.** Issue a per-launch ephemeral token (`agent:<id>` audit identity) + materialize the maister facade into the orchestrator session's ACP `mcpServers` (reuse the M34 facade plumbing), gated to `orchestrator` nodes only; revoke on terminal (reuse the deterministic-name revoke). **Two-phase/deferred-release:** issue token in the same tx that creates the orchestrator session record; revoke on every terminal path. **Tests:** an orchestrator session authenticates to the facade and a plain `ai_coding` node does NOT; the token is revoked on terminal.

**Commit checkpoint:** `feat(flows): M36 orchestrator node type + supervisory lifecycle`.

## Phase 3 — Delegation toolset (as-run / as-task)

> **Depends on T2.5** — the delegation tools are unusable until the orchestrator session holds the facade + ephemeral token.

- **T3.1 — MCP tool specs + dispatch.** `mcp/src/tools.ts`: add `run_delegate` (`{ target: {agentId|flowId}, mode: "task"|"run", prompt, title?, workspace?, runnerOverride? }`), `run_collect` (`{ childRunId | all }`), `run_cancel` (`{ childRunId }`) to `TOOL_SPECS` + dispatch (~lines 390-429). **`run_collect` read mechanism:** returns each child's terminal status + its `{{ steps.<id>.output }}` stdout var + a manifest of produced artifacts (and the base→run diff ref) by reading the child run DTO + `artifact_instances` — NEVER the child's worktree directly (reviewer-style isolation, matches the cross-vendor-review contract). **Token scope:** add `runs:delegate` to `web/types/token-scopes.ts` `AGENT_TOKEN_SCOPES`; the ephemeral agent token (`web/lib/agents/tokens.ts:issueAgentRunToken`) grants it only to orchestrator runs.
- **T3.2 — Ext route + child-run creation (two-phase).** New `web/app/api/v1/ext/runs/delegate/route.ts` wrapped by `handleExt`. Identifiers per the trust table (projectId/parent runId server-derived; agentId/flowId allow-listed against the catalog). Calls `launchRun()` (`web/lib/services/runs.ts:949`) inside the web-tier transaction with `parent_run_id`/`root_run_id` set + `delegation_snapshot` written; supervisor `POST /sessions` AFTER commit; `spawnedAt` is the AFTER-side idempotency mark. **Deferred-release:** on supervisor-spawn failure, the run is left `Pending` for reconcile (no orphaned parent expectation). **Tests:** integration — `as-task` creates a `parent_of` child task + run; `as-run` creates a child run with `parent_run_id` and NO board card; child carries the snapshot; a supervisor-spawn failure leaves a reconcilable `Pending` (not a stuck parent).
- **T3.3 — Catalog resolution + trust gate.** Resolve `target` through `web/lib/agents/effective.ts:resolveEffectiveAgentDefinition` (enablement + trust + pinned revision) and `web/lib/acp-runners/resolve.ts:resolveAgentRunner`; snapshot both on the child run. Refuse (`PRECONDITION`) if not resolvable/trusted. **Regression (trust separation):** delegate to a disabled/untrusted agent → assert NO child run created.

**Commit checkpoint:** `feat(agents): M36 delegation toolset (as-run/as-task) over the MCP facade`.

## Phase 4 — `run_plan` (task-DAG) + auto-launcher

- **T4.1 — `run_plan` tool + emit.** `mcp/src/tools.ts` + a new ext route. Input: `{ tasks: [{ key, target, prompt, workspace?, runnerOverride?, dependsOn: [key] }] }`. **Pre-tx validation:** acyclic (`depends_on`), `tasks.length ≤ MAISTER_MAX_ORCHESTRATOR_FANOUT`, run-tree depth `< MAISTER_ORCHESTRATOR_MAX_DEPTH`, every `target` catalog-resolvable. **In one tx:** insert N child tasks (`parent_of` ← orchestrator's task), M `requires` relations, all `launch_mode='auto'`, status Backlog/blocked. **Tests:** a 3-task diamond DAG creates 3 tasks + correct `requires` edges; a cyclic DAG is refused (`CONFIG`) with NO rows; over-fanout refused.
- **T4.2 — `requires` success-gate semantics.** `web/lib/social/relations.ts`: `requires` releases ONLY on `Done` (not Abandoned/Failed). Extend `getOpenRelationBlockers` (line ~216) to treat `requires` blockers, and wire it into the **shared launchability classifier `web/lib/runs/launchability.ts`** (consumed by manual `services/runs.ts`, cron `run-schedules/dispatch.ts`, `app/api/runs/launch-options`, and the board) so `requires` gates at EVERY launch entry point — not just the board read model; `parent_of` still never gates. **Tests:** a `requires` blocker in `Failed`/`Abandoned` keeps the dependent blocked (unlike `depends_on`), asserted through the shared classifier so all entry points inherit it.
- **T4.3 — Auto-launcher (domain-event consumer).** New consumer in `web/lib/domain-events/consumers.ts` (`DOMAIN_EVENT_CONSUMERS` line ~52): on child `run.done/failed/crashed/abandoned` (payload `parent_run_id` from T1.3), for each task whose `requires` blockers just cleared (all Done) AND `launch_mode='auto'` AND no open blockers → mark the task **launchable/`Pending`** and let the EXISTING `promoteNextPending` enforce the pool cap. Do NOT launch directly in the consumer — that bypasses the cap. The child `run_kind` decides the pool: a flow-running child → flow pool (6); a bare-agent child → agent pool (3). On a Failed/Abandoned `requires` dependency, DO NOT release dependents — instead wake the orchestrator (T5). **Multi-store atomicity:** the promote CAS rides the existing advisory-locked path. **Branch on `run_kind`** before routing. **Depends on T1.3.** **Tests:** integration — completing the last `requires` blocker marks the dependent Pending and the scheduler promotes it exactly once; a failed blocker does not; two blockers clearing near-simultaneously promote the dependent once.

**Commit checkpoint:** `feat(orchestrator): M36 as-plan task-DAG + success-gated requires + auto-launcher`.

## Phase 5 — Orchestrator wait / resume (the inbox)

- **T5.1 — Wait transition.** When the orchestrator agent yields awaiting children, transition `Running → WaitingOnChildren` in one tx (status + `node_attempts` cursor), checkpoint via the existing supervisor `checkpointSession`, release the slot (`releaseSlotOnIdle` → `promoteNextPending`). **Crash windows:** enumerate death-between-checkpoint-and-SIGTERM (reconcile covers `Running`-with-no-session; ensure `WaitingOnChildren`-with-no-checkpoint is covered too) — tested.
- **T5.2 — Resume on child-terminal.** Extend the T4.3 consumer (or a sibling `orchestratorResumeConsumer`): on a child terminal whose `parent_run_id` is a `WaitingOnChildren` orchestrator with no more pending children (or on the first child needing attention), resume the parent via supervisor `session/resume` on its `acp_session_id`, transition `WaitingOnChildren → Running`. **Race guard:** re-read parent status under lock before the resume RPC (it may have been resumed already) — skip if not `WaitingOnChildren`. **Branch on `run_kind`** (orchestrator vs flow vs scratch) before choosing the resume driver — an orchestrator-child must not be driven into the flow resume path. **Deferred-release:** a `run.failed`/`run.crashed` child also wakes the parent. **Depends on T1.3** (the event payload must carry `parent_run_id`). **Tests:** integration — parent parks, child completes, parent resumes exactly once; concurrent manual-resume + event-resume converge (one resume); a crashed child still wakes the parent.

**Commit checkpoint:** `feat(orchestrator): M36 idle-checkpoint wait + child-terminal resume`.

## Phase 6 — Workbench dynamic-subtree render

> **Flow Studio overlap:** the workbench graph + run-detail surfaces are being actively reworked by Flow Studio (M35/Phase C). Keep this phase ADDITIVE (new render path keyed on the orchestrator node + `parent_run_id`), do not refactor shared editor components; coordinate the merge. Flag any shared file touched.

- **T6.1 — Graph subtree.** In the workbench flow-graph view, render the orchestrator node's runtime children (`parent_run_id` subtree) as sub-nodes with state coloring (awake/working/`WaitingOnChildren`/terminal) reusing the existing live node-status coloring. **Tests:** component render test with a seeded run-tree.
- **T6.2 — Run-detail inspector.** The run-detail inspector (recent `feat(runs): run detail inspector workbench`) shows the orchestrator's child runs expandable with their logs. **Tests:** render test.
- **T6.3 — Board decomposition.** `parent_of` child tasks render as a decomposition group under the parent card. **Tests:** board read-model test asserts parent→children grouping.

**Commit checkpoint:** `feat(workbench): M36 orchestrator dynamic subtree + board decomposition`.

## Phase 7 — Foundation hardening + e2e

- **T7.1 — Recovery/reconcile coverage.** Confirm reconcile handles: orphaned child (`parent_run_id` → crashed/gone parent), `WaitingOnChildren` with no live checkpoint, partial as-plan emit (can't happen — single tx). Each partial state → tested recovery path.
- **T7.2 — e2e (playwright).** A flow with an orchestrator node delegates 2 children, parks, children complete, parent resumes, flow promotes. **Uses the mock ACP adapter** (CI has no live agent) — the mock must support the delegation spawn + `session/resume` round-trip per the CLAUDE.md resume-via-mock contract; extend the mock if needed. Register the new spec in the playwright `AUTHED_SPEC` regex. (Free `:3000` — Next 16 refuses a 2nd dev server.)
- **T7.3 — Migrate existing assertions.** Enumerate any tests asserting the run-status set / board buckets / `countLiveRuns` that the new status invalidates; migrate them in this phase (named, not "migrate suite").
- **T7.4 — Cancel/abandon cascade down the run-tree.** When an orchestrator run is stopped/abandoned/dropped (`web/lib/workbench-lifecycle/service.ts` + the generalized run-stop dispatcher), cascade to its children: cancel in-flight children, release any `WaitingOnChildren`, mark un-launched `launch_mode='auto'` child tasks Abandoned — all in one tx (multi-store atomicity). **Branch on `run_kind`** in the dispatcher before routing each child. **Slot-release contract:** every cascaded terminal honors `promoteNextPending`. **Tests:** abandoning a parked orchestrator with 2 in-flight + 1 queued child terminates all three, leaves no orphan holding a slot, and promotes the queue.

**Commit checkpoint:** `test(orchestrator): M36 foundation reconcile + e2e green`.

---

# PART B — SWARM LAYER 2 (ADR-096, Migration 0056)

## Phase 8 — Persistent swarm sessions

- **T8.1 — Persistent child sessions.** Reuse the scratch-session lifecycle (`web/lib/scratch-runs/service.ts:createSession`, `recovery.ts:classifyScratchRecovery`, `scratchRuns.acpSessionId`) so an orchestrator child can be re-messaged over time rather than run-to-terminal. Migration 0056: a `persistent boolean`/`addressable_key` on the child run (or a swarm-member table) so the orchestrator can address it. **Sleep = idle-checkpoint; wake = resume.** **Tests:** a persistent child receives a 2nd message after checkpoint+resume, context preserved.
- **T8.2 — Re-message tool.** Extend `run_delegate` (or add `run_message`) to send a follow-up to an existing addressable child (by the orchestrator-scoped key), routed via supervisor input delivery. **Branch on `run_kind`.** **Tests:** orchestrator messages child B after child A's result.

## Phase 9 — Star-routed messaging

- **T9.1 — Orchestrator-mediated relay.** Inter-agent messages go A→orchestrator→B only (no mesh): the orchestrator consumes A's result (inbox/domain event), then `run_message`s B. No direct child-to-child channel is created. **Audit:** every hop is observable on the orchestrator node. **Tests:** A's output reaches B only via an orchestrator turn; assert no direct A→B path exists.

## Phase 10 — Worktree allocation modes

- **T10.1 — Mode at launch.** Add `workspace_mode: "own" | "shared"` to the delegation input + snapshot it on the child run. `own` (default) = today's per-run worktree from the base branch (`web/lib/agents/launch.ts:agentWorkdirPath` + `worktree.ts:194`). `shared` = N children point at one pre-allocated tree `<slug>/agents/<orchestratorRunId>`. **Write hazard:** in `shared` mode, serialize writers (one active child turn at a time in a shared tree) — document + enforce via an orchestrator-held lock; the L3 dirty-watchdog (`web/lib/agents/dirty-watchdog.ts:182`) becomes per-shared-tree not per-run. **Tests:** two children in a shared tree do not corrupt it (serialized); own-mode unchanged.

## Phase 11 — Per-agent permissions

- **T11.1 — Reviewer read-only (enforced today).** A child launched with `workspace: repo_read` reuses the L1/L2/L3 read-only enforcement (`supervisor-client.ts:readOnlySession`, `dirty-watchdog.ts:materializeAgentReadOnlySettings`, quarantine). **Tests:** a `repo_read` child cannot write (L1 denies; L3 quarantines on dirt).
- **T11.2 — Path-scoped write (INSTRUCTED-only, refuse-on-strict).** "Tester edits only tests" is expressed as a `restrictions` instruction but is NOT enforced (read-only-vs-full only). Wire it as `instructed`; a `strict` path-scope declaration REFUSES at launch (`CONFIG`) until the policy layer lands. **Doc the gap** in `docs/configuration.md` + `orchestrator.md` ("path-scoped write enforcement — Phase 2, requires the policy layer"). **Tests:** `strict` path-scope refuses; `instruct` passes through.

**Commit checkpoint:** `feat(orchestrator): M36 swarm L2 — persistent sessions + star messaging + worktree modes + read-only perms`.

---

# PART C — Finalize

## Phase 12 — Docs, deployment wiring, renumber pass

- **T12.1 — `/aif-docs` checkpoint.** Flip Phase-0 docs from Designed→Implemented for shipped pieces; keep swarm path-perms `(Phase 2)`. Reconcile every contract surface in the table above against the diff.
- **T12.2 — Deployment wiring.** `.env.example` + `docs/configuration.md` env table for `MAISTER_MAX_ORCHESTRATOR_FANOUT` + `MAISTER_ORCHESTRATOR_MAX_DEPTH`; confirm no compose change needed (no new sidecar/port). If a var is dev-only, document the gap explicitly.
- **T12.3 — Renumber pass (own session, AFTER rebase onto main).** Re-resolve ADR-095/096 + migration 0055/0056 against main's HEAD (parallel branches — Flow Studio Phase C may have claimed numbers); transplant snapshots; run `scripts/validate-docs-adr-anchors.mjs`; `pnpm db:generate` clean.
- **T12.4 — Full green gate.** `pnpm --filter maister-web typecheck && lint && test:unit && test:integration`; supervisor tests; mcp tests; `pnpm validate:docs` + redocly + asyncapi + ADR-anchor validators.

## Commit Plan

| Checkpoint | After phase |
| --- | --- |
| `docs(orchestrator): Phase 0 analytics + ADR-095/096 + contracts` | 0 |
| `feat(runs): run-tree + WaitingOnChildren fanned to all consumers` | 1 |
| `feat(flows): orchestrator node type + supervisory lifecycle` | 2 |
| `feat(agents): delegation toolset (as-run/as-task)` | 3 |
| `feat(orchestrator): as-plan DAG + requires + auto-launcher` | 4 |
| `feat(orchestrator): idle-checkpoint wait + child-terminal resume` | 5 |
| `feat(workbench): dynamic subtree + board decomposition` | 6 |
| `test(orchestrator): foundation reconcile + e2e` | 7 |
| `feat(orchestrator): swarm L2` | 8–11 |
| `docs + deploy + renumber + green` | 12 |

## Risks / Open Questions

1. **Flow Studio merge overlap** (Phase 6, workbench/graph). Mitigation: additive render path, coordinate, renumber pass.
2. **`WaitingOnChildren` consumer completeness** — the highest-risk task (T1.2, 12+ sites). Mitigation: named-export the status sets, grep gate in CI, a test asserting visibility + non-counting.
3. **Auto-launcher exactly-once** under concurrent child terminals clearing a shared dependent. Mitigation: the existing advisory-locked `promoteNextPending` CAS + an integration test with two blockers clearing near-simultaneously.
4. **Depth/fanout bounds** prevent run-tree runaway (orchestrator-task spawning orchestrator-tasks). Enforced pre-tx in T4.1; tested.
5. **Path-scoped perms** genuinely blocked on the policy layer — shipped as instructed-only; do not claim enforcement.
