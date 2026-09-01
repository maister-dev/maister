# Implementation Plan: Flow-target delegation for MAIster orchestrators

Branch: `claude/flow-target-delegation-178968` (pre-existing worktree branch — NOT created by this plan)
Created: 2026-09-01 · Refined: 2026-09-01 (`/aif-improve`, SDD + TDD pass)
ADR: **ADR-163** (reserved; next free at `main` HEAD is 163 — 162 is the last)
Migration: **none expected** — slot **0128** reserved but may stay unused (see §Persistence, D9)

## Settings
- Testing: yes — **TDD, RED → GREEN → REFACTOR** (see §Working agreement)
- Logging: verbose (structured `pino`, `[delegation.*]` namespaces — see §Logging contract)
- Docs: yes — mandatory documentation checkpoint at completion
- Method: **SDD** — the Phase-0 specification set is normative; implementation may not diverge from it, and a genuine divergence is a spec bug fixed in BOTH places

## Roadmap Linkage
Milestone: "none"
Rationale: Repository inspection found no directly matching active milestone — the only unchecked one is **M45 (core-package process qualification)**, and the nearest Backlog entry (`flow-target run schedules`, §A14) is a different subsystem. Linkage skipped per the request.

## Prerequisite assumed complete
Universal structured node result (ADR-162, engine 3.6.0, migration 0127) is **merged at `main` `73fa99915`**. This plan does **not** implement public Run-result collection, `run_collect` payload changes, or the RAH reference workflow.

---

## Requirement register (normative)

Derived from the nine sections of the brief. Every requirement is testable, and every one is claimed by at least one task **and** at least one test in the traceability matrix. A task that satisfies no REQ is gold-plating and must be cut; a REQ with no test is not done.

| ID | Requirement | Source |
| --- | --- | --- |
| **REQ-01** | `target` accepts **exactly one** of `agentId` / `flowId`. Both present → refuse. Neither → refuse. Expressed as a **discriminated Zod union**, not optional fields plus procedural fallback. Applies to `run_delegate` **and** `run_plan`. | §1 |
| **REQ-02** | Every currently-valid Agent-target payload keeps working byte-for-byte. | §1 |
| **REQ-03** | `flowId` resolves **only** through the bound orchestrator's project. A package path, git tag, filesystem path, URL, or inline definition is never accepted. | §2 |
| **REQ-04** | The Flow must be enabled, installed, trusted, engine-compatible, and pinned to an immutable package revision — each checked as an explicit allow-list. | §2 |
| **REQ-05** | Trust resolution is **physically separate** from launch: the resolver module cannot start a run. Order = locate → establish trust → execute. | §2 |
| **REQ-06** | The selected flow, package revision, engine range, branch pair, and launch-time configuration are persisted on the child run; terminal and recovery paths read the snapshot, never a live projection. | §2 |
| **REQ-07** | A Flow target launches through the **canonical Flow Run pipeline** (`launchRunStaged`), never `launchAgentRun`, and gets the same workspace / graph state / session set / capability materialization / executor resolution invariants as a user launch. | §3 |
| **REQ-08** | The child run carries `parent_run_id`, `root_run_id`, `launch_mode`, project, task linkage, and delegation provenance. | §3 |
| **REQ-09** | Every shared dispatcher branches on `run_kind` **before** calling kind-specific launch / resume / reconcile / rework / promotion / terminal logic. | §3 |
| **REQ-10** | `mode: run` and `mode: task` have defined, documented behaviour for a Flow target, including how the delegated prompt enters the child Flow context. A Flow whose task-bound input cannot be constructed safely is refused. | §4 |
| **REQ-11** | The child task is assigned the **selected** Flow — never inherited from the orchestrator's task. | §4 |
| **REQ-12** | Each delegation field has an explicit per-target-kind allow-list. A field a target kind cannot support is **refused**, never silently ignored. | §5 |
| **REQ-13** | A Flow executor override passes through the existing **Flow** executor-resolution chain. | §5 |
| **REQ-14** | `run_cancel`, `run_collect`, `run_promote` support both run kinds where their existing state preconditions allow; `run_message` and `run_rework` stay Agent-only with an explicit refusal. | §5 |
| **REQ-15** | Depth **and** fan-out are enforced **before any child record is created**, on **every** creation edge, and the check is not defeated by concurrency. | §6 |
| **REQ-16** | Project, parent run, root run, active orchestrator node, and limits are derived from server state. | §6 |
| **REQ-17** | Global concurrency accounting is preserved; a Flow child draws the flow pool, an Agent child the agent pool. | §6 |
| **REQ-18** | Every settled Flow child emits the same domain event that wakes a parent in `WaitingOnChildren`. | §6 |
| **REQ-19** | Flow children are included in the cancellation cascade. | §6 |
| **REQ-20** | Predicates stay concern-specific; `Review` stays distinct from promoted / safe-to-ship; a Flow child's node graph is never flattened into the parent. | §6 |
| **REQ-21** | Every enumerated failure and crash window has a specified behaviour and a tested recovery path. Related DB writes share one transaction where possible; asynchronous execution starts only after the child-run transaction commits. | §7 |
| **REQ-22** | The tool contract is updated across MCP schemas, external OpenAPI, Flow DSL, system analytics, and any shipped skill that describes delegation targets — each traced to its spec file and verified by opening it. | §8 |
| **REQ-23** | No production third-party Flow package enters this repository; Flow-target coverage uses trusted in-repo fixtures. | §9 |

## Traceability matrix

| REQ | Spec artifact (Phase 0) | Task(s) | Test(s) |
| --- | --- | --- | --- |
| REQ-01 | OpenAPI `ExtDelegationTarget` `oneOf`; MCP `TOOL_SPECS` | S0.5, T2.1 | R1.1, T6.3 |
| REQ-02 | `orchestrator.md` compat matrix | T6.1 | **R1.2** (agent-compat replay, RED-first) |
| REQ-03 | `orchestrator.md` trust-boundary table | T2.2 | T2.2-tests, T6.3 |
| REQ-04 | `orchestrator.md` refusal table (parameterized) | T2.2 | **R1.3** (table-driven refusals) |
| REQ-05 | ADR-163 §Trust separation | T2.2 | R1.3 (module cannot import a launcher — static test) |
| REQ-06 | `runs-domain.md` + `database-schema.md` snapshot shape | T5.1, T6.2 | T5.2 |
| REQ-07 | `orchestrator.md` flow (g) sequence diagram | T6.2 | T6.2-tests, T9.4 |
| REQ-08 | same | T5.1, T6.2 | T5.2 |
| REQ-09 | `orchestrator.md` dispatcher table | T6.2, T7.2, T7.3, T8.1 | one test per discriminant arm |
| REQ-10 | `orchestrator.md` mode semantics (D1) | T6.2 | T6.2-tests |
| REQ-11 | same | T6.2 | T6.2-tests |
| REQ-12 | OpenAPI per-kind option table; refusal table | T2.1, T6.2 | R1.3 |
| REQ-13 | `orchestrator.md` runner chain note | T6.2 | T6.2-tests |
| REQ-14 | OpenAPI per-tool support matrix | T8.1 | T8.1-tests |
| REQ-15 | ADR-163 §Admission; `orchestrator.md` | **T4.1, T4.2** | **T4.2-tests (incl. a real two-racer test)** |
| REQ-16 | trust-boundary identifier table | T6.2 | R1.3 |
| REQ-17 | `orchestrator.md` pool note | T6.2 | T6.5 |
| REQ-18 | `domain-events.md` second emitter | T3.1 | T3.2 |
| REQ-19 | `orchestrator.md` flow (d) | T8.2 | T8.2-tests |
| REQ-20 | `runs.md` + `run-status-sets` note | T4.1 | T4.2-tests, T8.2 |
| REQ-21 | ADR-163 §Residuals + crash matrix | T6.4, T6.6, T6.7, T6.8 | one test per reachable window |
| REQ-22 | contract-surface table | S0.5, S0.6, T9.1, T9.2 | `tool-contract.test.ts`, `validate:contracts` |
| REQ-23 | ADR-163 §Follow-ups | T9.3 | T9.4 |

---

## Working agreement — SDD + TDD

**SDD.** Phase 0 produces the normative specification set: ADR-163, the system-analytics prose + diagrams, **and the machine-readable contracts** (external OpenAPI, MCP `TOOL_SPECS`). Contracts are specifications, not documentation — they are authored **before** the code they constrain, and the repo's OpenAPI-anchored guard (`mcp/src/__tests__/tool-contract.test.ts`) becomes a **RED test** the implementation turns green. Implementation may not diverge from the Phase-0 set; a genuine divergence is a spec bug, fixed in the spec **and** the code in the same commit.

**TDD.** Every implementation task is written as three explicit steps, and the task is not done until all three are recorded:

- **RED** — write the test first, **run it**, and record *how it failed*. A test that passes before the change, or fails for the wrong reason (import error, fixture typo), is not RED — fix the test, not the code.
- **GREEN** — the minimum code that turns it green. No speculative generality.
- **REFACTOR** — remove duplication introduced by the GREEN step, apply the project's conventions, re-run the suite.

**Test-design rules** (enforced at review of each task):

1. **No trivial tests.** A test that asserts a constant, a type, or behaviour no line of this change touches is deleted. (Applied already: three arms of the old consumer-sweep task and the whole "terminal wake parity" task were cut on this rule.)
2. **Minimum overlap.** One behaviour, one owning test. Where several inputs exercise one behaviour, use a **table-driven** test with one row per case — never N copy-pasted bodies. The refusal table (below) is authored in exactly that shape so it transcribes 1:1 into a parameterized test.
3. **Edge cases are first-class**, not appendices: every row of the refusal table, every reachable row of the crash matrix, and both arms of every `run_kind` discriminant.
4. **Race conditions need a real two-racer test** — hold an uncommitted write on a second pg connection, wait on `pg_stat_activity.wait_event_type='Lock'`, then commit. A single-threaded "call it twice" test proves nothing about a lock.
5. **Every test must actually run**: it lands in a path family the runner already globs (`lib/**/*.integration.test.ts`, `app/**/*.integration.test.ts`, `lib/**/__tests__/**/*.test.ts` — all present in `web/vitest.workspace.ts:52-88`), so no runner-config change is needed. Confirm before claiming a test is a deliverable.

**Code rules** (SOLID / KISS / DRY, checked in each REFACTOR step):

- **One admission helper, three call sites** — `run_delegate`, `run_plan` source launch, and `auto_launch_run_plan` are three independent edges into child creation. A guard on one of N edges is a guard on none, so all three call the same `admitDelegatedChild()`. This also removes the `delegationDepth` copy-paste that already exists in two routes.
- **Single responsibility at the module seam**: `lib/orchestrator/delegation-target.ts` owns *wire shape*; `lib/flows/delegatable-flow.ts` owns *trust resolution* and **must not import a launcher** (REQ-05, enforced by a static test); `lib/orchestrator/admission.ts` owns *limits*. No module does two of the three.
- **Match the surrounding code**: `MaisterError` with a discriminated `code` (never a plain `Error`), allow-lists over deny-lists, `// FIXME(any):` on any unavoidable `any`, comments explain WHY only.

---

## As-built findings (established by inspection, not assumption)

These are the facts every later phase depends on. Each was read in the working tree.

### F1. The canonical Flow launch pipeline is task-bound and delegation-blind
`launchRunStaged` / `launchRun` (`web/lib/services/runs.ts:563`, `:1947`) is the canonical Flow launcher. It:
- **requires** `input.taskId`, loads the task first, and derives `projectId` **from the task row** (`:576-592`);
- performs the full trust sequence in-line — enablement allow-list (`LAUNCHABLE_ENABLEMENT_STATES = {Enabled, UpdateAvailable}`, `:268`, `:932`), `trustStatus !== 'untrusted'` (`:938`), pinned-revision resolution (`:952-970`), `packageStatus === 'Installed'` (`:975`), `setupStatus` (`:982`), `isSchemaVersionSupported` (`:990`), `isEngineCompatible` (`:996`), `checkFlowRequirements` (`:1020`);
- inserts the run **without** `parent_run_id`, `root_run_id`, `launch_mode`, `delegation_snapshot`, `workspace_mode` (`:1654-1721` — none of those columns appear in the insert);
- commits, then calls `tryStartRun` (cap admission) and finally `void runFlow(runId)` **after** commit (`:1925-1937`).

⇒ The launcher already satisfies "install-or-locate → establish trust → execute" and "async execution only after commit". What it lacks is a **delegation input surface**.

### F2. A Flow run cannot exist without a task
- `assertFlowRunInvariant` (`web/lib/runs/run-kind-invariants.ts:108`) throws `CONFIG` unless `taskId && flowId`.
- `loadRun` (`web/lib/flows/graph/runner-core.ts:186-194`) throws `PRECONDITION "task not found for run"`.
- The Flow prompt entry point **is** the task prompt: `buildRunContext` writes `intent`/`task.prompt`/`task.effectivePrompt` from `taskPrompt` (`web/lib/flows/graph/run-context.ts:100-104`), and `{{ task.prompt }}` is the manifest idiom.
- `tasks` has **no** visibility / hidden / internal column (`web/lib/db/schema.ts:1383-1466`).

⇒ **Decision D1 (owner):** a Flow target mints a **carrier task** server-side and hands its id to the canonical launcher. See §"Decisions".

### F3. Parent-wake deadlock — a Flow `Review` emits no domain event
`runGraph`'s terminal branches (`web/lib/flows/graph/runner-graph.ts`):
- `Crashed` (`:4813-4849`), `Failed` (`:4856-4895`), stale-pointer `Crashed` (`:2396-2430`) each emit **`emitDomainEvent`** with `parentRunId` pulled through `.returning()`;
- the `Review` branch (`:4904-4927`) emits **only `emitWebhookEvent`** — `.returning()` selects `projectId` alone.

`promoteRun` emits `run.done` with `parentRunId` at all three sites (`web/lib/runs/promote.ts:1260`, `:1626`, `:2003`) — kind-agnostic.

⇒ A delegated Flow child reaching `Review` would **never** wake a parent parked in `WaitingOnChildren`. This is the exact "a status nothing emits on is a deadlock" class. **Phase 2 closes it.**

### F4. `run.review` is already a registered domain-event kind — no migration
- `DOMAIN_EVENT_KINDS` includes `"run.review"` (`web/lib/domain-events/taxonomy.ts:18`).
- `RUN_SETTLED_EVENT_KINDS = RUN_TERMINAL_EVENT_KINDS + "run.review"` (`:64`).
- The DB CHECK `domain_events_kind_check` already lists `'run.review'` (`web/lib/db/schema.ts:6172`).
- `emitDomainEvent`'s discriminated input **compiler-enforces** `parentRunId` on every settled kind (`web/lib/domain-events/outbox.ts:44-52`).

### F5. `auto_launch_run_plan` hard-excludes non-agent children
`web/lib/domain-events/auto-launch.ts:203` — `if (payload.runKind !== "agent") continue;`. Consequences for a Flow child in an as-plan DAG: no auto-promote from `Review` (`:214-217`), no task→`Done` advance (`:226-238`), no `requires` release, no dependent discovery (`:266-282`), and the candidate launcher is hard-wired to `launchAgentRun` with `spec.agentId` (`:302-345`).

### F6. Full consumer sweep for the new `run.review` emit population
Registered consumers (`web/lib/domain-events/consumers.ts:63-83`) and their kind filters:

| Consumer | Filter | Effect of a Flow `run.review` |
| --- | --- | --- |
| `orchestrator_resume` | `isRunSettledEventKind`; branches on the **parent's** `run_kind`, child-agnostic (`orchestrator-resume.ts:135,148`) | **Works unchanged** — this is the wake path |
| `auto_launch_run_plan` | `isRunSettledEventKind` **AND** `payload.runKind === "agent"` | **Must widen** (Phase 5) |
| `agentTriggersConsumer` | generic `eventMatch.kinds` allow-list (`agents/triggers.ts:721`) | An agent bound to `run.review` now also fires on delegated Flow children — intended; needs a doc row + a test |
| `ralphLoopConsumer` | `run.failed` only (`ralph-loop.ts:62`) | Unaffected |
| `costRollupReconcileConsumer` | `isRunTerminalEventKind` (`:48`) | Unaffected (`run.review` excluded) |
| `memoryHarvestConsumer` | terminal + `gate.failed` (`memory-harvest.ts:47`) | Unaffected |
| `sourceReindexConsumer` | brain kinds (`brain/index-triggers.ts:42`) | Unaffected |

**Blast radius today is exactly zero**: the emit is gated on `parent_run_id != null`, and no delegated Flow child exists before this change.

### F7. Which orchestrator tools already work for a Flow child
| Tool | Service | Verdict |
| --- | --- | --- |
| `run_collect` | reads `runs.status` + `artifact_instances` (`collect/route.ts:96-136`) | **kind-agnostic — works** |
| `run_cancel` | `stopWorkbenchRunForToken` → `stopRunByKind` (`workbench-lifecycle/service.ts:1731-1764`) has a `case "flow"` arm | **works** |
| `run_promote` | `promoteChildRunForToken` → `promoteRun` (`runs/promote.ts:2080`) | **kind-agnostic — works** |
| cancel cascade | `cascadeAbandonRunTree` (`orchestrator/cascade.ts:71`) — bulk `UPDATE … WHERE id IN subtree AND status IN CASCADE_NON_TERMINAL` (which includes `Review`, `queries/run.ts:877-886`) + per-pool `promoteNextPending` via `poolForRunKind` | **kind-agnostic — works** |
| `run_rework` | `reworkChildRun` throws `PRECONDITION` unless `runKind === "agent"` (`agents/launch.ts:2907-2913`) | **refuses — keep, but make the refusal explicit at the route** |
| `run_message` | persistent-agent addressing | **agent-only — add an explicit refusal** |

### F8. Governance today
- `run_delegate` enforces **depth only** (`delegate/route.ts:181-192`); it never imports `orchestratorMaxFanout`.
- `run_plan` enforces fan-out as `tasks.length > orchestratorMaxFanout()` (`plan/route.ts:184-193`) — a per-call bound, not a per-orchestrator one.
- Scheduler pools: `poolForRunKind` (`scheduler.ts:84`) → `agent` for agent runs, `flow` for everything else. A Flow child therefore draws `MAISTER_MAX_CONCURRENT_RUNS` (6), an agent child `MAISTER_MAX_CONCURRENT_AGENTS` (3). **Two budgets, one tree.**

### F10. The bound orchestrator ALWAYS has a task — and `childTasks` is additive
`issueOrchestratorRunToken` (`web/lib/agents/tokens.ts:137`) is called from **exactly one** site: the flow graph runner's orchestrator node (`runner-graph.ts:3132`). So a `runs:delegate`-scoped token is always bound to a `run_kind='flow'` run, and a flow run always has a task (F2) ⇒ **`parent.taskId` is never null today**. The `"delegation parent run has no task"` branch in both routes is currently unreachable — **keep it** (it becomes live if an agent orchestrator is introduced, where `runs.task_id` may legitimately be null) and re-comment it as reserved.

The board read model has **no task filter at all** — `getBoardData` selects `.from(tasks).where(eq(tasks.projectId, projectId))` (`web/lib/queries/board.ts:348-351`). Separately, `childTasks` is an **additive** `ChildTaskRef[]` attached to the `parent_of` SOURCE card (`:408-465`, `:677`, `:764`) — it does **not** remove the child from the top-level columns. ⇒ a `parent_of` child appears **twice** (own card + reference under the orchestrator's card); a child **without** the relation appears once, orphaned. This is what forces D1.

### F11. An abandoned orchestrator leaves relaunchable carrier tasks
`getUnlaunchedAutoChildTaskIds` (`web/lib/queries/run.ts:927-957`) filters `tasks.launch_mode='auto'` **AND** `NOT EXISTS (a run for the task)`. Carrier tasks are `launch_mode='manual'` **and** have a run ⇒ the cascade **never** marks them Abandoned. Their *runs* are abandoned (they are in the subtree), the *tasks* are not, and `MANUAL_RUN_STATUS_LAUNCHABILITY.Abandoned = "launchable"` (`web/lib/runs/launchability.ts:61`) ⇒ after an orchestrator abandon, N carrier cards sit on the board **showing a Launch button**.

**Accepted, not fixed** — and the reason is verified, not assumed: **no automation can fire them.** `auto_launch_run_plan` requires `launch_mode='auto'` (`auto-launch.ts:279`) and the C2 auto-launch funnel requires a triaged/armed task; a carrier task is neither. Only a human clicking Launch on a card they can read. Documented in ADR-163 §Residuals and in `orchestrator.md` edge cases.

### F12. Children branch from `main`, not from the orchestrator's branch
A delegated child does **not** inherit the coordinator's branch. Agent path:
`resolvedBranchBase = ctx.project.mainBranch` (`agents/launch.ts:1087`, overridable only by the
agent definition's declared base / `workspace_ref`), then `baseBranch = targetBranch =
resolvedBranchBase` (`:1409-1411`). Flow path: `base = input.baseBranch ?? task.baseBranch ??
project.mainBranch`; `target = input.targetBranch ?? deliveryPolicy.targetBranch ??
task.targetBranch ?? base` (`services/runs.ts:1379-1387`).

⇒ The integration model is **N independent promotes into a shared target**, not "accumulate in the
parent, merge once". The orchestrator's own worktree is the coordinator's workspace, never an
assembly point. The one assembly model that exists — `workspace_mode='shared'` (ADR-102): one
branch, one cumulative diff, one Review, one tree-wide promote — lives **only** in the agent
launcher and is refused for flow targets by D4 in this cut.

Inter-child conflicts are therefore resolved at the SECOND child's promote (`CONFLICT` 409, child
stays `Review`, human resolves). The coordinator cannot rebase a child out of the way: `run_sync`
(ADR-141) requires scope `runs:sync`, and `ORCHESTRATOR_TOKEN_SCOPES` = `AGENT_TOKEN_SCOPES` +
`delegate|collect|cancel|promote`, where `AGENT_TOKEN_SCOPES` carries **no** `runs:*` scope at all.

### F13. A finished worktree-backed child parks in `Review` and nothing reclaims it
Verified chain: (a) `Review` holds **no** scheduler slot — `countLiveRuns` counts only
`Running | NeedsInput | HumanWorking` (`scheduler.ts:158`); (b) there is **no** sweeper for stale
`Review` runs (`keepalive-sweeper.ts` never mentions the status); (c) GC only reclaims
`DISPOSABLE_WORKSPACE_RUN_STATUSES = ["Done","Abandoned"]` (`run-status-sets.ts:20`,
`gc/workspace-gc.ts:272`), so a `Review` worktree is **never** collected; (d) the orchestrator's
NORMAL exit does nothing to its children — it only revokes the token
(`runner-graph.ts:4944-4951`); the cascade fires only on stop / abandon / drop / reconcile-crash.

Who closes a `Review` child:

| Child | Resolver | If nobody resolves |
| --- | --- | --- |
| as-plan (`launch_mode='auto'`) | `auto_launch_run_plan` auto-promotes | — |
| as-run (`manual`), agent or flow | **only a live coordinator** via `run_promote` | parks in `Review` indefinitely: worktree on disk, branch alive, an `OnReview` card |
| flow child, project opted into lane-bounded auto-promotion (ADR-126) and the diff class is allowed | the auto-promote sweep | otherwise as above |

**Pre-existing (ADR-100), but AMPLIFIED by flow targets**: an agent child may be `workspace: none`
or `repo_read` and run straight to `Done` with nothing to park, whereas a flow child **always**
provisions a worktree (F1) and therefore **always** parks in `Review`. Recorded as residual **W12**;
mitigation options are deliberately NOT taken in this cut — see ADR-163 §Residuals.

### F9. Contract drift already present
`docs/api/external/operations.openapi.yaml`:
- `ExtDelegationTarget` (`:4773-4790`) already documents `flowId` — the code refuses it.
- `ExtRunPlanTask.target` (`:4874`) already `$ref`s `ExtDelegationTarget` — the Zod schema accepts `agentId` only.
- Neither uses `oneOf` — "exactly one" is prose, not schema.

`mcp/src/tools.ts:317-356` — `run_delegate.inputSchema.target` lists both fields with **no** `required`, `oneOf`, or `minProperties`.

---

## Decisions (locked with the owner)

| # | Decision | Rationale |
| --- | --- | --- |
| **D1** | **A Flow target ALWAYS mints a carrier task, ALWAYS links it `parent_of` under the orchestrator's task, and ALWAYS honours `title` — in BOTH modes.** No new column, no board-hidden flag. `mode` is therefore **not a board-visibility switch for Flow targets**; it stays meaningful only for Agent targets. | Owner: *"create a subtask for this subflow and provide its id to the launcher"*, plus Q2/Q3 = A. **Revised from the first draft** after inspection showed `childTasks` is ADDITIVE on the board (F10): a `parent_of` child renders as a top-level card **and** as a `ChildTaskRef` under the orchestrator's card. So omitting the relation for `mode: run` would have produced the *same* card count with **zero provenance** — an orphan. Linking always is strictly better. Not silent: the tool description, the OpenAPI, and `orchestrator.md` all state it, and the response always returns `childTaskId`. |
| **D2** | **`run_rework` on a Flow child → `PRECONDITION`**, refused at the route before `reworkChildRun`. | Owner choice. A Flow child owns an internal `human`/`rework` loop; grafting the coordinator's prompt onto it would need a new re-entry contract that overlaps ADR-160. |
| **D3** | **One shared fan-out cap per orchestrator, counted across BOTH child kinds.** Enforced in `run_delegate` (new) and `run_plan` (widened from per-call to per-orchestrator). | Owner: *"ок иметь общий лимит на сабагенты и flow-дочерние раны для ноды-оркестратора"*. Blast radius on shipped agent callers is nil — owner confirmed no orchestrator nodes exist in shipped processes yet. |
| **D4** | **Flow-target field allow-list = `target.flowId`, `mode`, `prompt`, `title?`, `runnerOverride?`.** `workspace`, `workspaceMode`, `persistent`, `addressableKey` are refused with `CONFIG` — never ignored. | Owner selection. `workspace` is meaningless (a Flow run always provisions a worktree); `workspaceMode: shared` would need the agent launcher's shared-tree allocator (`sharedAgentWorktreePath`, `resolveSharedTreeWorkspaceForUpdate`) ported to the Flow path — out of this cut. |
| **D5** | **No new migration.** Verified: `run.review` is already in `DOMAIN_EVENT_KINDS` **and** the `domain_events_kind_check` CHECK (F4); `runs.parent_run_id / root_run_id / launch_mode / delegation_snapshot` all exist; `runs.delegation_snapshot` and `tasks.delegation_spec` are `jsonb` whose TS `$type<>` unions widen without DDL. | The migration-triple rule does not fire. **Both DB doc surfaces still get updated** for the jsonb semantic widening (`docs/database-schema.md` + `docs/db/runs-domain.md`). |
| **D7** | **A delegated flow child's `baseBranch`/`targetBranch` resolve to `project.mainBranch`** (the carrier task carries neither, so `launchRunStaged`'s existing chain falls through to the project default), and BOTH are recorded in `delegation_snapshot`. The delegation body does **not** accept a branch field. | Made explicit rather than inherited by accident: it is a launch-time decision the promote path reads, so the "persist every launch-time decision" rule applies. Matches the agent path (F12), keeps the target inside the project's validated branch allow-list, and leaves branch-topology changes (a child branching off its parent, for recursive assembly) as a deliberate future decision instead of an emergent one. |
| **D6** | **No delegation idempotency key in this cut.** A duplicate `run_delegate` produces a second governed child — bounded by the shared fan-out cap (D3) and visible via `run_collect`. This is **parity with the shipped agent path**, recorded as an explicit residual in ADR-163. | A durable key needs a partial-unique index = a migration the owner scoped out. Owner-confirmed (Q1 = A) after weighing the alternatives: a SELECT-then-INSERT pre-check and a "recent identical prompt" heuristic were both **rejected on purpose** — each leaves a race window, so shipping either under the name "idempotency" is worse than a documented residual, because the next reader trusts it. |
| **D8** | **One `admitDelegatedChild()` helper, called from all three child-creation edges, serialized by a per-orchestrator advisory lock.** The lock is `pg_advisory_xact_lock` keyed on the parent run id — **not** the global `SCHEDULER_LOCK_KEY`, which would serialize every delegation platform-wide against the scheduler. Depth + fan-out are counted under that lock, and the carrier task (the flow-target reservation) is inserted in the same transaction. | `/aif-improve` finding **H1**. The plan's first draft did `COUNT(*)` then create in separate transactions — the project's own rule is *"a transaction is atomicity, NOT mutual exclusion"*, and `auto_launch_run_plan` (`auto-launch.ts:336`) was a **third, entirely unguarded** creation edge that T7.3 was about to extend to flow children. *"A guard on one of N edges is a guard on none."* The realistic concurrent caller here is the duplicate-retry of W7, so the lock narrows that residual too. The helper also absorbs the `delegationDepth` copy-paste that already exists in `delegate/route.ts` and `plan/route.ts` (DRY). |
| **D9** | **Migration slot 0128 is RESERVED and may stay unused.** The expectation is no migration (D5). If implementation discovers a required column, the procedure is fixed in advance: re-confirm `max(idx)` in `migrations/meta/_journal.json` at `main` HEAD **at that moment** (not from this plan), ship the **triple** — SQL file + `_journal` entry with a monotonic `when` + `meta/<NNNN>_snapshot.json` — update `web/lib/db/schema.ts` in the same commit (the schema is the fourth leg: a CHECK widened in SQL but not in `schema.ts` makes `drizzle-kit generate` propose reverting it), and update **both** DB doc surfaces. | `/aif-improve` finding **H4**. "No migration expected" without a named procedure is how a mid-implementation migration lands outside the plan's frozen preflight set. |

---

## Trust boundary — identifier labelling

### `POST /api/v1/ext/runs/delegate`

| Identifier | Label | Handling |
| --- | --- | --- |
| `projectId` | **auth-context** | `ctx.projectId` from the ephemeral `agent:<id>` token binding |
| parent `runId` | **auth-context** | `ctx.actor.boundRunId`; never a body field |
| `rootRunId` | **server-state** | `parent.rootRunId ?? parent.id` after `resolveActiveBoundRun` |
| parent `taskId` | **server-state** | read from the parent run row |
| delegation depth / live-child count | **server-state** | `parent_run_id` walk + `COUNT(*)` over live children |
| `target.flowId` | **body-controlled** | resolved **only** through `resolveFlowRef(ctx.projectId, flowId, db)` → a `flows.id` **or** `flow_ref_id` scoped to the token's project. **Never** a package path, git tag, filesystem path, URL, or inline definition — the Zod schema is `z.string().min(1)` with no path characters ever reaching the FS, and the resolved row's `projectId` is re-asserted |
| `runnerOverride` | **body-controlled** | passed as `LaunchRunInput.runnerId` into the **existing** Flow executor-resolution chain; an unknown/disabled runner surfaces the chain's own `PRECONDITION`/`EXECUTOR_UNAVAILABLE` |
| `mode` | **body-controlled** | closed enum |
| `prompt`, `title` | **body free-text** | no locator role; `title` capped, prompt stored as the carrier task's prompt |
| carrier `taskId` | **server-state** | minted server-side; never accepted from the body |
| child `flowRevisionId` | **server-state** | resolved inside `launchRunStaged` from the project's enablement pointer |

### `POST /api/v1/ext/runs/plan`
Identical, per plan entry; `key` and `dependsOn` are **body-controlled** and validated in-batch (unchanged).

**Rule applied:** no `body-controlled` field names a filesystem path component, and every cross-resource locator (`flowId`, `runnerOverride`) is resolved against server state scoped by the token's `projectId` before use.

---

## Option-compatibility matrix (§5)

| Field | Agent target | Flow target | Refusal when violated |
| --- | --- | --- | --- |
| `target.agentId` | **required** | forbidden | `CONFIG 422` — both present / neither present |
| `target.flowId` | forbidden | **required** | `CONFIG 422` |
| `mode` | `task` \| `run` — genuinely controls whether a task is created | accepted, but **does not** change board presence or linkage (D1); documented, never silently dropped | — |
| `prompt` | ✅ | ✅ → carrier task `prompt` | — |
| `title` | ✅ `mode: task`; on `mode: run` → **`CONFIG`** after T6.3 (a silent drop today) | ✅ **both modes** (D1) | `CONFIG 422` on the agent `mode: run` arm |
| `workspace` | ✅ | ❌ | `CONFIG 422` — *"workspace is not supported for flow targets (a flow run always provisions its own worktree)"* |
| `workspaceMode` | ✅ | ❌ | `CONFIG 422` — *"workspaceMode is agent-target only"* |
| `runnerOverride` | ✅ (agent runner chain) | ✅ (Flow executor-resolution chain) | chain's own `PRECONDITION` / `EXECUTOR_UNAVAILABLE` |
| `persistent` | ✅ | ❌ | `CONFIG 422` — *"persistent children are agent-target only"* |
| `addressableKey` | ✅ | ❌ | `CONFIG 422` |

**Tool support by child kind**

| Tool | Agent child | Flow child |
| --- | --- | --- |
| `run_collect` | ✅ | ✅ |
| `run_cancel` | ✅ | ✅ |
| `run_promote` | ✅ (`Review` only) | ✅ (`Review` only) |
| `run_rework` | ✅ | ❌ `PRECONDITION 409` (D2) |
| `run_message` | ✅ (persistent only) | ❌ `PRECONDITION 409` |

Enforcement mechanism: a **discriminated Zod union** with `.strict()` on each arm, so an agent-only key on the flow arm is a schema error — never a silently dropped field.

---

## Refusal table (§7)

| Condition | Where checked | Code / HTTP | Rows written |
| --- | --- | --- | --- |
| both `agentId` and `flowId` present | Zod discriminated union, pre-everything | `CONFIG` 422 | none |
| neither present | Zod | `CONFIG` 422 | none |
| agent-only field on a flow target | Zod flow arm `.strict()` | `CONFIG` 422 | none |
| no run-bound token | route | `PRECONDITION` 409 | none |
| bound orchestrator terminal / cross-project | `resolveActiveBoundRun` | `PRECONDITION`/`UNAUTHORIZED` | none |
| depth ≥ `MAISTER_ORCHESTRATOR_MAX_DEPTH` | route (server-state walk) | `CONFIG` 422 | none |
| live children ≥ `MAISTER_MAX_ORCHESTRATOR_FANOUT` (**shared cap, D3**) | route (server-state count) | `CONFIG` 422 | none |
| unknown flow / not in project | `resolveDelegatableFlow` → `resolveFlowRef` | `PRECONDITION` 409 | none |
| flow enablement ∉ `{Enabled, UpdateAvailable}` | `resolveDelegatableFlow` | `PRECONDITION` 409 | none |
| `flows.trust_status = 'untrusted'` | `resolveDelegatableFlow` | `PRECONDITION` 409 | none |
| no `enabled_revision_id` / revision row missing | `resolveDelegatableFlow` | `PRECONDITION` 409 | none |
| `packageStatus !== 'Installed'` | `resolveDelegatableFlow` | `PRECONDITION` 409 | none |
| `setupStatus ∈ {pending, failed}` | `resolveDelegatableFlow` | `PRECONDITION` 409 | none |
| unsupported manifest `schemaVersion` | `resolveDelegatableFlow` | `CONFIG` 422 | none |
| engine incompatible (`engine_min`/`engine_max`) | `resolveDelegatableFlow` | `CONFIG` 422 | none |
| flow host requirement missing (`checkFlowRequirements`) | `launchRunStaged` | `PRECONDITION` 409 | carrier task → **compensated** |
| worktree creation failure | `launchRunStaged` inner catch | propagated code | worktree removed; carrier task → **compensated** |
| supervisor unavailable | `checkSupervisorHealth` in `launchRunStaged` | `EXECUTOR_UNAVAILABLE` 503 | carrier task → **compensated** |
| `run_rework` on a flow child | rework route (pre-dispatch guard) | `PRECONDITION` 409 | none |
| `run_message` on a flow child | message route | `PRECONDITION` 409 | none |
| `workspaceMode: shared` on a flow target | Zod flow arm | `CONFIG` 422 | none |

**Invariant:** every refusal above the "carrier task" line writes **no rows at all** — trust resolution is physically separated from launch in `web/lib/flows/delegation-target.ts`, a module that cannot start a run.

---

## Failure & crash-window recovery matrix (§7)

Ordering for one flow-target delegation:

```
[pre-flight — NO writes]
  token → resolveActiveBoundRun → depth → shared fan-out → field allow-list
  → resolveDelegatableFlow (enablement + trust + revision + setup + schema + engine)
        ↓
[Tx A] createTask(carrier) [+ addTaskRelation parent_of when mode:task]   ← ONE transaction
        ↓
[launchRunStaged]
   preAdoptHealth → git worktree add (external)
   → [Tx B] runs + run_sessions + workspaces + tasks.status=InFlight + task_activity   ← ONE transaction
   → COMMIT
   → tryStartRun (cap admission)  → void runFlow(runId)   ← async, strictly post-commit
        ↓
[post-commit] re-read parent status; if terminal → cascade-abandon the just-born child
```

| # | Crash window / failure | Reachable state | Recovery | Tested by |
| --- | --- | --- | --- | --- |
| W1 | Pre-flight refusal (any refusal-table row above the carrier line) | nothing written | n/a — caller sees a typed error | T6.2, R1.3 |
| W2 | `launchRunStaged` throws **after** Tx A | carrier task exists, no run | **Compensation**: route catch deletes the carrier task + relation, guarded by "task has no runs" (`hasAnyRun` false); per-revert `catch` + `log.error`. Compensation covers the **entire** fallible remainder, not a convenient tail. | T6.4 (failure-simulation) |
| W3 | Process death **between** Tx A commit and Tx B commit | carrier task in `Backlog`, `launch_mode='manual'`, no run | **Documented residual**: a visible, harmless Backlog card. No auto-launcher claims it (`launch_mode='manual'` excludes it from the as-plan discovery query, and the C2 auto-launch funnel requires a triaged/armed task). Operator abandons it. Recorded in ADR-163. | T6.8 (asserts the residual shape, not a rescue) |
| W4 | Process death **after** Tx B commit, before `tryStartRun` | run row `Pending`, worktree exists | **Existing** scheduler `promoteNextPending` on the `flow` pool + `reconcile`'s `Pending` handling. Named predicate: `runs.status='Pending' AND run_kind='flow'`. | T6.5 |
| W5 | `runFlow` background death / session spawn failure | run `Running` with no live session | **Existing** reconcile classifier (`reconcile.ts:1308` `cand.runKind !== "flow"` guard routes flow rows to the flow arm) → `Crashed` → `run.crashed` domain event **with `parentRunId`** → `orchestrator_resume` wakes the parent | T6.6 |
| W6 | Parent cancelled/abandoned **during** child launch | child born into a terminal tree | Pre-flight `resolveActiveBoundRun` narrows it; the residual is closed by a **post-commit parent re-read** — if the parent is terminal, the route abandons the child through the same `cascadeAbandonRunTree` path and returns `PRECONDITION`. | T6.7 |
| W7 | Duplicate `run_delegate` (at-least-once MCP redelivery) | two governed children | **Accepted residual (D6)** — bounded by the shared fan-out cap, both visible in `run_collect`. Parity with the shipped agent path. Recorded in ADR-163. | T6.8 (asserts 2 children + cap refusal at the bound) |
| W8 | Flow child reaches `Review` | `Review` + `review_entered_at` | `run.review` **domain** event (Phase 3) with `parentRunId` → `orchestrator_resume` wakes the parent once no non-settled sibling remains → coordinator calls `run_promote` (or, for an as-plan child, `auto_launch_run_plan` auto-promotes) | T2.2, T7.4, T8 |
| W9 | Flow child reaches `Failed`/`Crashed`/`Abandoned` | terminal | **Existing** emits already carry `parentRunId` → parent wakes **unconditionally** | T3.2 |
| W10 | Parent cancel cascade while a flow child is `Review`/`Running` | child `Abandoned` | `cascadeAbandonRunTree` — `Review` is in `CASCADE_NON_TERMINAL_RUN_STATUSES`; `poolForRunKind` releases the **flow** slot | T6.3 |
| W12 | Orchestrator exits NORMALLY leaving un-promoted `Review` children | children park in `Review`: worktree + branch retained, no scheduler slot held, an `OnReview` card each | **Accepted residual (F13)** — nothing reclaims them: no `Review` sweeper, GC skips non-disposable statuses, the normal exit does not cascade. The coordinator contract is "promote or cancel every child before finishing", enforced by prompt, not by the engine. Mitigations enumerated in ADR-163 §Residuals, none taken here. | T5.2 / T6.8 |
| W11 | Orchestrator abandoned → carrier tasks survive their abandoned runs | N `Launch`-able carrier cards on the board | **Accepted residual (F11)** — the cascade cannot reach them (`launch_mode='manual'` + has-a-run), and **no automation can fire them** (`auto_launch_run_plan` needs `auto`; C2 needs triage). Human-only relaunch. | T6.8 |

**Compensation-completeness note.** `launchRunStaged` already owns its own two-level compensation (inner: `removeWorktree`; outer: `revertPackageVersionChoices`). The carrier-task compensation added here is a **third, outermost** layer owned by the delegation route — it must wrap the entire `launchRunStaged` call, not just its tail.

---

## Shared dispatchers that must branch on `run_kind` (§3, enumerated)

| # | Site | Action |
| --- | --- | --- |
| 1 | `web/app/api/v1/ext/runs/delegate/route.ts` | **NEW** — branch on the discriminated target: `launchAgentRun` vs `launchRun` |
| 2 | `web/app/api/v1/ext/runs/plan/route.ts` (source-task launch, `:410-450`) | **NEW** — branch on `spec.kind` |
| 3 | `web/lib/domain-events/auto-launch.ts:203, :302` | **WIDEN** — accept `flow`; dispatch candidate launch on `spec.kind`; auto-promote flow `Review` children |
| 4 | `web/app/api/v1/ext/runs/rework/route.ts` | **NEW** — refuse `run_kind='flow'` before `reworkChildRun` (D2) |
| 5 | `web/app/api/v1/ext/runs/message/route.ts` | **NEW** — explicit flow refusal |
| 6 | `web/lib/flows/graph/runner-graph.ts` Review branch (`:4904`) | **NEW** — `run.review` domain emit gated on `parentRunId != null` |
| 7 | `web/lib/domain-events/orchestrator-resume.ts:148` | **VERIFY** — branches on the *parent's* kind; child-agnostic |
| 8 | `web/lib/workbench-lifecycle/service.ts:1731 stopRunByKind` | **VERIFY** — `case "flow"` present |
| 9 | `web/lib/orchestrator/cascade.ts:71` | **VERIFY** — kind-agnostic + `poolForRunKind` |
| 10 | `web/lib/scheduler.ts:84 poolForRunKind` | **VERIFY + TEST** — flow children draw `MAISTER_MAX_CONCURRENT_RUNS` |
| 11 | `web/lib/reconcile.ts:1104-1308` | **VERIFY** — flow arm already reached |
| 12 | `web/lib/runs/promote.ts:2080 promoteChildRunForToken` | **VERIFY** — kind-agnostic |

Rule applied: *"half-A-tested + half-B-tested ≠ A∘B-tested"* — every arm marked NEW or WIDEN gets a test per discriminant.

**Child-creation edges (D8).** Three sites create a delegated child and therefore ALL call `admitDelegatedChild()`: `run_delegate` (T6.1), `run_plan`'s source launch (S0.5), and `auto_launch_run_plan`'s candidate launch (T7.3 — this one has **never** had a depth or fan-out check). A guard on one of N edges is a guard on none.

---

## Persistence

**No migration.** (D5 — verified, see F4.) Two `jsonb` `$type<>` widenings, TypeScript-only:

```ts
// web/lib/db/schema.ts — runs.delegation_snapshot
export type DelegationSnapshot =
  | { kind?: "agent"; agentDefinitionId: string; revisionId: string }
  | { kind: "runner"; /* …consensus, unchanged… */ }
  | { kind: "flow";                        // NEW (ADR-163)
      flowId: string;                      // resolved flows.id
      flowRefId: string;
      flowRevisionId: string;              // the immutable pinned revision
      resolvedRevision: string;
      engineMin: string | null;            // compatibility as evaluated AT LAUNCH
      engineMax: string | null;
      carrierTaskId: string;               // the server-minted task
      mode: "task" | "run";                // the requested delegation mode
      runnerOverride: string | null;
      baseBranch: string;                  // D7 — resolved at launch, read by promote
      targetBranch: string };

// web/lib/db/schema.ts — tasks.delegation_spec
export type TaskDelegationSpec =
  | { kind?: "agent"; agentId: string; workspace?: …; runnerOverride?: string }   // legacy rows: no `kind`
  | { kind: "flow"; flowId: string; runnerOverride?: string };                    // NEW
```

Back-compat: pre-existing rows carry **no** `kind`, which the reader treats as `"agent"` — mirroring the existing `DelegationSnapshot` precedent (`kind?: "agent"`). Every reader gets a discriminating helper (`delegationSpecKind(spec)`), never an inline `!spec.agentId` test.

**Both DB doc surfaces updated** (`docs/database-schema.md` narrative **and** `docs/db/runs-domain.md` — the ERD is generated to `docs/db/erd.dbml`, so column shape is unchanged and only the prose/jsonb semantics move).

**Migration contingency (D9).** Slot **0128** is reserved and expected to stay unused. The `db:generate`-produces-nothing gate runs at Phase 2 exit **and** in the definition of done, so a schema drift introduced mid-implementation surfaces at the next phase boundary rather than at merge. If a column does become necessary, follow D9's procedure verbatim and fold the migration back into this plan's artifacts in the same pass.

**AsyncAPI (H5) — verified, no change.** `run.review` gains a second *domain-event* emitter (T3.1). Domain events have **no** AsyncAPI spec (`docs/api/async/` holds `outbound-webhooks`, `supervisor-sse`, `web-evaluations`, `web-runs` only); the `run.review` **webhook** already exists in `outbound-webhooks.asyncapi.yaml:321,603` and its emit site is untouched. `pnpm validate:contracts` covers all four AsyncAPI files and stays green. Recorded here so the contract-surface checklist is provably complete rather than silently skipped.

---

## Deployment touchpoints

No new env var, port, binary, config-file path, or `package.json` script. `MAISTER_MAX_ORCHESTRATOR_FANOUT` and `MAISTER_ORCHESTRATOR_MAX_DEPTH` already exist and are already documented in `docs/configuration.md`; **T9.2** updates that table's `max_fanout` **description** for the widened (shared, per-orchestrator) semantics. No `Dockerfile` / `compose*.yml` / `.env.example` change.

---

## API compatibility strategy

1. **Wire-compatible by construction.** Every currently-valid agent payload (`{target:{agentId}, mode, prompt, …}`) matches the agent arm of the discriminated union byte-for-byte. A dedicated regression suite (R1.2) replays the six existing `delegate.integration.test.ts` agent cases unchanged.
2. **The only behaviour change to a shipped path is D3** (a shared per-orchestrator fan-out cap on `run_delegate`, which previously enforced depth only). Owner-confirmed blast radius: shipped processes ship no `orchestrator` node. A dedicated test (T6.2) pins the new refusal, and ADR-163 records the change.
3. **`run_plan`** gains flow targets additively; the `{target:{agentId}}` arm and the whole DAG/cycle/fan-out validation sequence are untouched.
4. **OpenAPI closes existing drift, never widens silently**: `ExtDelegationTarget` becomes `oneOf: [ {required:[agentId]}, {required:[flowId]} ]`, with per-arm `additionalProperties: false` and a documented per-kind option matrix. This makes the spec *stricter* and finally matches the code.
5. **Existing error codes only** — `CONFIG` (422) and `PRECONDITION` (409). No new `MaisterError` code, so `docs/error-taxonomy.md` needs no new row (it does gain the two new refusal reasons under the existing codes).
6. **`run_collect` payload is untouched** (explicit out-of-scope).

---

---

## Commit Plan

| Commit | Tasks | Message |
| --- | --- | --- |
| 1 | S0.1–S0.6 | `docs(orchestrator): specify flow-target delegation — ADR-163, analytics, and the OpenAPI/MCP contracts as normative specs` |
| 2 | R1.1–R1.3 | `test(delegation): RED — contract, agent-compat, and refusal-table harnesses` |
| 3 | T2.1–T2.3 | `feat(delegation): discriminated target + server-owned flow-trust resolver` |
| 4 | T3.1–T3.2 | `fix(flows): emit run.review as a domain event so a flow child wakes its parked orchestrator` |
| 5 | R1.2–T6.2 | `feat(orchestrator): one admission helper — depth + shared fan-out under a per-orchestrator lock` |
| 6 | T5.1–T5.2 | `feat(runs): accept delegation provenance on the canonical flow launch pipeline` |
| 7 | T6.1–T6.8 | `feat(ext): flow-target run_delegate with carrier task, compensation, and crash-window coverage` |
| 8 | S0.6–T7.4 | `feat(ext): flow targets in run_plan; widen the as-plan auto-launcher past agent-only` |
| 9 | T9.3–T8.3 | `feat(orchestrator): explicit rework/message refusals; flow children in the cancel cascade` |
| 10 | T9.1–T9.4 | `docs(api): finalize the flow-target contract surfaces; e2e flow-child smoke` |

---

## Tasks

### Phase 0 — Specification (SDD; normative, NO code)

> Exit gate for every later phase: implementation follows these artifacts. A divergence discovered later is a **spec bug** fixed in both places, never a doc-only patch.

- [x] **S0.1 — Write ADR-163.**
  Files: `docs/decisions/adr-163.md` + a `### ADR-163` header row in `docs/decisions.md`.
  **Reserve the number FIRST:** `git show main:docs/decisions.md | grep -oE '^### ADR-[0-9]+' | tail -1` → confirm `ADR-162`, claim `163`, and write the header before anything cites it (a cited ADR with no header at HEAD is a build break).
  Content: decisions **D1–D9** with their rationale; **§Trust separation** (locate → trust → execute, and why the resolver module may not import a launcher); **§Admission** (D8 — the three edges, the per-orchestrator advisory lock, why not the global scheduler lock); **§Residuals** naming W3, W7, W11, W12 (W12 carries the four mitigations considered and the reason auto-archive is the preferred future fix); **§Follow-ups** carrying (a) the `runs.delegation_key` + partial-unique upgrade path for D6, reusing the `evaluationBatchItemId` adopt pattern (`services/runs.ts:1734-1747`) verbatim, and (b) the deferred `maister-plugins` production example (§9 / REQ-23).
  *Acceptance*: `pnpm validate:docs` green (it chains `validate-docs-adr-anchors.mjs`, links, indexes and `db:erd --check` — the skill-context note that it "only parses Mermaid" is **stale** at this HEAD).
  *Satisfies*: REQ-05, REQ-15, REQ-21, REQ-23.

- [x] **S0.2 — Extend `docs/system-analytics/orchestrator.md`.** (depends on S0.1)
  Per `docs/CLAUDE.md` R5: a **Flow-target delegation** entity block; **two** state machines side by side (Agent-target child vs Flow-target child, the latter showing `Pending → Running → Review → (promote) Done` with the `run.review` wake edge); a **new process-flow (g)** Mermaid **sequence diagram** for the `run_delegate` flow arm — pre-flight → admission-under-lock → carrier-task tx → `launchRunStaged` → post-commit parent re-check — matching the style of flows (a)–(f) (finding **H11**: every other flow has one; the flow arm must not be the exception); the **option-compatibility matrix**; the **shared-dispatcher enumeration**; and the **refusal table in the parameterized shape below** (finding **H12**), so it transcribes 1:1 into R1.3's table-driven test.
  Tag every piece `Designed` per R6 at this phase's HEAD; T9.1 flips them to `Implemented`.
  *Acceptance*: every transition and every refusal row is stated exactly as the code will gate it (allow-lists written as allow-lists); the sequence diagram renders (`validate-docs-mermaid.mjs` via `pnpm validate:docs`).
  *Satisfies*: REQ-03, REQ-07, REQ-09, REQ-10, REQ-11, REQ-12, REQ-13, REQ-17, REQ-20.

- [x] **S0.3 — Update `docs/system-analytics/domain-events.md` + `runs.md`.** (depends on S0.1)
  `domain-events.md`: `run.review` gains a **second emitter** (the graph runner's Review flip, gated on `parent_run_id != null`), plus the **F6 consumer-sweep table** showing which consumers see the widened population and which are provably unaffected.
  `runs.md`: a `### Delegated flow-run child (ADR-163)` subsection under "State machine — execution axis" covering the carrier task, `delegation_snapshot.kind='flow'`, the flow-pool accounting, and the W12 park.
  *Satisfies*: REQ-18, REQ-20.

- [x] **S0.4 — Update both DB doc surfaces.** (depends on S0.1)
  `docs/database-schema.md` (narrative) **and** `docs/db/runs-domain.md`: the `runs.delegation_snapshot` `kind:'flow'` variant and the `tasks.delegation_spec` discriminated union, including the "legacy rows carry no `kind` ⇒ read as agent" rule. State explicitly that there is **no DDL change**, so `docs/db/erd.dbml` is untouched — do not regenerate.
  *Satisfies*: REQ-06.

- [x] **S0.5 — Author the external OpenAPI contract (contract-first).** (depends on S0.2)
  **Finding H2 — this used to sit after the implementation.** Under SDD the contract is the spec, and `mcp/src/__tests__/tool-contract.test.ts` is OpenAPI-**anchored**, so the spec must exist before the guard can be RED.
  `docs/api/external/operations.openapi.yaml`: `ExtDelegationTarget` → `oneOf` of two arms, each `additionalProperties: false`, one `required: [agentId]`, the other `required: [flowId]` (closes the pre-existing drift of F9, and makes "exactly one" schema rather than prose); `ExtRunDelegateBody` gains the per-kind option table and the `422`/`409` refusal reasons; `ExtRunPlanTask` documents the flow arm; add flow-target **examples** for `run_delegate` (`mode:task` and `mode:run`) and `run_plan`; the path `description` states the carrier-task semantics (D1) and the shared admission (D3/D8).
  *Acceptance*: `pnpm validate:contracts` green; every documented refusal maps to a code the route will actually return (cross-checked against R1.3's table).
  *Satisfies*: REQ-01, REQ-12, REQ-22.

- [x] **S0.6 — Author the MCP tool contract + extend the guard's resolver.** (depends on S0.5)
  `mcp/src/tools.ts`: `run_delegate.inputSchema.target` and `run_plan.tasks.items.target` become the same `oneOf` pair. Rewrite both `description` strings to teach **when to pick which**, short enough for repeated prompt injection (≤3 added sentences):
  > *"`target.agentId` = a single-purpose catalog agent (one session, one turn-loop). `target.flowId` = a governed multi-node process from the project's enabled+trusted flows (its own graph, gates, review). Flow targets accept only `title` and `runnerOverride`; `workspace`, `workspaceMode`, `persistent`, `addressableKey` are agent-only and are refused, not ignored. A flow child always gets a linked board task; `run_rework` and `run_message` do not apply to it."*
  **⚠ Guard gap (found by inspection):** `tool-contract.test.ts`'s internal `JsonSchema` resolver understands `allOf` and `$ref` but **not `oneOf`** (`:27-37`). Introducing `oneOf` without extending it makes the guard **stop checking the target while still passing** — worse than no guard. Extend the resolver (compare the arm sets) **in this same task**, and add a case asserting a deliberately-drifted arm FAILS the guard.
  **⚠ Bundle gotcha:** the facade runs `mcp/dist`, not `mcp/src` — `pnpm --filter @maister/mcp build` after editing, or the live tool list keeps the old schema.
  *Acceptance*: `pnpm --filter @maister/mcp build && pnpm --filter @maister/mcp typecheck && pnpm --filter @maister/mcp test` green, with the negative-drift case proving the resolver actually inspects both arms.
  *Satisfies*: REQ-01, REQ-22.

**Phase 0 exit** — all six artifacts complete and mutually consistent; ADR-163 anchor resolves; `pnpm validate:docs` **and** `pnpm validate:contracts` green; unit + integration green (**capture the enumerated integration baseline here** — see §Test-integrity contract).

---

### Phase 1 — RED: the specification harness

> Three failing tests derived directly from Phase-0 artifacts. Each must be **run** and its failure reason recorded before any production code is written.

- [x] **R1.1 — RED: the discriminated-target contract.** (depends on S0.6)
  Assert `mcp` `TOOL_SPECS` and the ext OpenAPI agree on the `oneOf` target for both tools, and that the ext route rejects `{agentId, flowId}` together and `{}`.
  **RED**: `pnpm --filter @maister/mcp test` fails on the target mismatch (the routes still accept the loose object); the route cases fail because today's Zod accepts both/neither shapes.
  *Files*: `mcp/src/__tests__/tool-contract.test.ts` (extended), `web/app/api/v1/ext/runs/__tests__/delegate-target-shape.integration.test.ts`.
  *Satisfies*: REQ-01.

- [x] **R1.2 — RED-neutral: the Agent-compat replay.** (depends on S0.6)
  A **parameterized** replay of the six shipped agent behaviours (as-task, as-run, snapshot + root propagation, disabled/untrusted/Disabled-package refusals, terminal-token refusal, depth bound, no-binding refusal) as a table of cases — **not** six copy-pasted bodies (DRY, finding H7).
  This one is **GREEN from the start by design**: it is the regression fence proving REQ-02, so any later red here is a compatibility break, not progress.
  *Files*: `web/app/api/v1/ext/runs/__tests__/delegate-agent-compat.integration.test.ts`.
  *Migration note*: the existing case `delegate.integration.test.ts:790` — *"flow-target delegation is rejected (CONFIG, out of scope)"* — is **migrated**, not deleted; its assertion inverts in T6.2.
  *Satisfies*: REQ-02.

- [x] **R1.3 — RED: the refusal table, table-driven.** (depends on S0.2, S0.6)
  One test, one row per refusal-table entry (both-fields, neither-field, each agent-only field on a flow target, no run-bound token, terminal orchestrator, over-depth, over-fan-out, unknown flow, not-enabled, untrusted, no enabled revision, revision not `Installed`, `setupStatus` failed, unsupported `schemaVersion`, engine-incompatible). Each row asserts **code + HTTP status + zero rows written** (`tasks` and `runs` both unchanged).
  Plus a **static** case for REQ-05: `web/lib/flows/delegatable-flow.ts` imports no launcher module — read the file's import list and assert none of `services/runs`, `agents/launch`, `flows/runner` appears. This makes "physically separate" a test, not a convention.
  **RED**: every flow row fails (the route still refuses all flow targets with a single generic CONFIG); the static case fails (the module does not exist yet).
  *Files*: `web/app/api/v1/ext/runs/__tests__/delegate-refusals.integration.test.ts`, `web/lib/flows/__tests__/delegatable-flow-isolation.test.ts`.
  *Satisfies*: REQ-04, REQ-05, REQ-12, REQ-16.

**Phase 1 exit** — all three harnesses committed and **executed**; R1.1 and R1.3 are RED for the documented reasons; R1.2 is green. No production code has changed.

---

### Phase 2 — Target resolution (GREEN for R1.1 shape + R1.3 static)

- [x] **T2.1 — `web/lib/orchestrator/delegation-target.ts` — wire shape only.** (depends on Phase 1)
  **RED** is R1.1. **GREEN**: export `delegationTargetSchema` — `z.union([z.object({agentId}).strict(), z.object({flowId}).strict()])` plus a `.superRefine` emitting the two exact messages (`"…exactly one of agentId / flowId (both present)"` / `"…(neither present)"`); `delegationTargetKind(t): "agent" | "flow"`; and `refineDelegateOptionsForTarget(body, ctx)` implementing the §5 matrix with the refusal table's exact strings.
  **REFACTOR**: both routes import this module — the shape lives in exactly one place (DRY).
  *Acceptance*: R1.1's route cases GREEN; module has no DB or launcher import (single responsibility).
  *Satisfies*: REQ-01, REQ-12.

- [x] **T2.2 — `web/lib/flows/delegatable-flow.ts` — trust resolution only.** (depends on T2.1)
  **Renamed** from the first draft's `flows/delegation-target.ts` (finding **H9**: two modules with the same basename in different directories is a readability trap).
  **RED** is R1.3. **GREEN**: `resolveDelegatableFlow({projectId, flowId}, db)` → `{flowId, flowRefId, revisionId, resolvedRevision, versionLabel, engineMin, engineMax}`, running the SAME allow-list sequence as `launchRunStaged:926-1010`: `resolveFlowRef` (accepts `flows.id` or `flow_ref_id`, project-scoped) → re-assert `flow.projectId` → `enabledRevisionId` present → `LAUNCHABLE_ENABLEMENT_STATES.has(enablementState)` → `trustStatus !== 'untrusted'` → `resolveEffectiveFlowRevision` → `packageStatus === 'Installed'` → `setupStatus ∉ {pending,failed}` → `isSchemaVersionSupported` → `isEngineCompatible`.
  **REFACTOR**: hoist `LAUNCHABLE_ENABLEMENT_STATES` to a module both this and `services/runs.ts` import, so the two gates can never drift.
  *Acceptance*: every R1.3 flow row GREEN; the static isolation case GREEN.
  *Logging*: `log.debug({projectId, flowId, flowRefId, revisionId, enablementState, trustStatus}, "[delegation.flow] target resolved")` / `log.warn({…, reason}, "[delegation.flow] target refused")`.
  *Satisfies*: REQ-03, REQ-04, REQ-05.

- [x] **T2.3 — Widen the two jsonb unions + reader helper.** (depends on T2.2)
  **RED**: a unit test asserting `delegationSpecKind({agentId:'x'}) === 'agent'` (legacy row, no `kind`) and `…({kind:'flow',flowId:'y'}) === 'flow'` — fails, helper absent.
  **GREEN**: the `kind:'flow'` `DelegationSnapshot` variant (incl. `baseBranch`/`targetBranch` per D7) and the `TaskDelegationSpec` union in `web/lib/db/schema.ts`; `delegationSpecKind` in `web/lib/orchestrator/delegation-spec.ts`.
  **REFACTOR**: replace any `!spec.agentId` shape-sniffing with the helper.
  *Acceptance*: `pnpm --filter maister-web typecheck` green; **`pnpm --filter maister-web db:generate` emits NO migration** (proves D5 — paste the output in the commit body).
  *Satisfies*: REQ-06.

**Phase 2 exit** — R1.1 fully GREEN, R1.3's non-launch rows GREEN; `db:generate` produces nothing; suite green vs the enumerated baseline.

---

### Phase 3 — Close the parent-wake deadlock (F3)

> Independently valuable and independently testable; deliberately lands **before** any flow child can exist, so the deadlock can never ship.

- [x] **T3.1 — Emit `run.review` as a domain event from the graph runner.** (depends on Phase 2)
  **RED** is T3.2's first case. **GREEN**: at `web/lib/flows/graph/runner-graph.ts:4904-4927`, widen the Review branch's `.returning()` to `{projectId, taskId, flowId, runKind, parentRunId}` (matching the `Failed`/`Crashed` siblings at `:4817`/`:4863`) and, **inside the same transaction** as the status flip, after the existing `emitWebhookEvent`, emit `run.review` via `emitDomainEvent` with `parentRunId` — **gated on `parentRunId != null`**, so a top-level Review still emits nothing (matching `agents/launch.ts:2540-2555` and `orchestrator.md`).
  *Acceptance*: (a) a delegated flow run reaching `Review` writes exactly one `domain_events` row, `kind='run.review'`, `payload.parentRunId` set, `payload.runKind='flow'`; (b) a **top-level** flow run writes none; (c) the webhook fires in both cases; (d) a rolled-back status flip leaves no event (same-tx proof).
  *Logging*: `log2.info({parentRunId, runKind:"flow"}, "[delegation.wake] emitted run.review for delegated flow child")`.
  *Satisfies*: REQ-18.

- [x] **T3.2 — Prove the wake, and the sibling gate, at the consumer.** (depends on T3.1)
  Three cases, no more (finding **H7** pruned this from two tasks and seven arms):
  1. one flow child → `Review` → `orchestrator_resume` CASes the parent `WaitingOnChildren → Running` and calls the injected `resumeFlow` with `{orchestratorResume:{targetStepId}}`;
  2. two flow children, one still `Running` → parent is **not** woken (pending-sibling gate);
  3. a flow child reaching a **failure terminal** wakes the parent **unconditionally**, even with a pending sibling (this is the one useful assertion salvaged from the deleted "terminal wake parity" task — it now exercises the *flow* arm, which nothing covered before).
  **Cut on the no-trivial-tests rule**: the three consumer-sweep arms asserting that `costRollupReconcile` / `memoryHarvest` / `ralphLoop` ignore `run.review` — their filters are `isRunTerminalEventKind`, so those arms test a taxonomy constant, not behaviour.
  **Kept from that sweep**: one case proving `agentTriggersConsumer` **does** deliver a flow child's `run.review` to an agent whose `eventMatch.kinds` includes it — a real, intended behaviour change.
  *Files*: `web/lib/domain-events/__tests__/orchestrator-resume-flow-child.integration.test.ts`.
  *Satisfies*: REQ-18, REQ-20.

**Phase 3 exit** — the deadlock class is closed and pinned before any flow child can be created; suite green.

---

### Phase 4 — Admission: depth + shared fan-out, on every edge (H1)

> Moved **ahead** of the routes (finding **H8**: the old plan had a Phase-4 test depending on a Phase-6 task). Admission is a pure helper with no route dependency, so it belongs here.

- [x] **T4.1 — `web/lib/orchestrator/admission.ts` — one helper, three callers.** (depends on Phase 3)
  **RED** is T4.2. **GREEN**:
  ```ts
  export async function admitDelegatedChild(
    tx: Db, args: { parentRunId: string; incoming: number },
  ): Promise<void>   // throws MaisterError("CONFIG") on either bound
  ```
  Inside the caller's transaction: `pg_advisory_xact_lock(DELEGATION_LOCK_NAMESPACE, hashtext(parentRunId))` — **per-orchestrator, deliberately NOT `SCHEDULER_LOCK_KEY`**, which would serialize every delegation platform-wide against the scheduler — then the depth walk (moved here from the two routes' copy-pasted `delegationDepth`, DRY) and the live-child count.
  The pending predicate derives from the **single** source `web/lib/runs/run-status-sets.ts` (`NOT IN TERMINAL_RUN_STATUSES`), never an inline status list, and is named for its concern: `countLiveDelegatedChildren` — distinct from `pendingChildCount` in `orchestrator-resume.ts`, which is **settled**-based and answers a different question (REQ-20).
  **REFACTOR**: delete both copies of `delegationDepth`.
  *Logging*: `log.warn({parentRunId, live, incoming, cap}, "[delegation.admit] refused — orchestrator fan-out cap reached")`.
  *Satisfies*: REQ-15, REQ-16, REQ-20.

- [x] **T4.2 — Admission tests, including a REAL two-racer.** (depends on T4.1)
  1. cap reached with a **mixed** set of live agent + flow children → next admission `CONFIG 422`, nothing written (proves the cap is shared, D3);
  2. a terminal child frees capacity;
  3. depth at the bound → `CONFIG 422`;
  4. **two-racer**: two concurrent admissions at `cap-1` — hold an uncommitted admission on a second pg connection, wait on `pg_stat_activity.wait_event_type='Lock'`, then commit; assert **exactly one** wins and the loser gets `CONFIG`. A single-threaded "call it twice" proves nothing about a lock and is explicitly not acceptable here;
  5. the **agent-path behaviour change**: an agent-target `run_delegate` at the bound is now refused (previously unbounded) — pinned so the shipped-path tightening is an intentional, tested contract.
  This single table-driven test replaces the first draft's **three** separate cap tasks, which overlapped on the same behaviour (finding **H7**).
  *Files*: `web/lib/orchestrator/__tests__/admission.integration.test.ts`.
  *Satisfies*: REQ-15.

**Phase 4 exit** — admission is correct under concurrency and is the only place limits are computed; suite green.

---

### Phase 5 — Delegation provenance on the canonical Flow launcher

- [x] **T5.1 — Extend `LaunchRunInput`.** (depends on Phase 4)
  **RED** is T5.2. **GREEN**: add `parentRunId?`, `rootRunId?`, `launchMode?`, `delegationSnapshot?` to `LaunchRunInput` in `web/lib/services/runs.ts` and thread them into the run insert (`:1654-1721`). Doc-comment them as **server-internal**, set only by the delegation seam and never accepted from a route body — the same idiom as `scheduledReservation` / `evaluationBatchItemId`.
  Base/target need **no** new input: `base = input.baseBranch ?? task.baseBranch ?? project.mainBranch` already falls through to the project default for a carrier task (D7). The resolved pair is copied into `delegation_snapshot`.
  *Logging*: `log.info({runId, taskId, parentRunId, rootRunId, launchMode}, "[delegation.launch] flow run launched as delegated child")` when `parentRunId` is set.
  *Satisfies*: REQ-07, REQ-08.

- [x] **T5.2 — Snapshot completeness + drift immunity.** (depends on T5.1)
  Assert the child persists every launch-time decision a terminal or recovery path reads: `flow_id`, `flow_revision_id`, `flow_version`, `flow_revision`, `parent_run_id`, `root_run_id`, `launch_mode`, `run_sessions.runner_snapshot`, and a `delegation_snapshot` carrying `flowRefId`, `resolvedRevision`, `engineMin/Max`, `carrierTaskId`, `mode`, `runnerOverride`, `baseBranch`, `targetBranch`. Then **mutate the live projection** — advance the flow's `enabled_revision_id` to a different revision — and assert the child's snapshot is unchanged and `loadRun` still resolves the manifest from `runs.flow_revision_id`. Plus: `workspaces.base_branch`/`target_branch` both equal `project.mainBranch` (D7 — the child does **not** branch from the orchestrator's branch, F12).
  *Files*: `web/lib/services/__tests__/launch-run-delegated.integration.test.ts`.
  *Satisfies*: REQ-06, REQ-08.

**Phase 5 exit** — board-launch regression byte-identical (R1.2 still green); suite green.

---

### Phase 6 — `run_delegate` flow arm

- [x] **T6.1 — Adopt the shared schema + admission in the route (agent path first).** (depends on Phase 5)
  **GREEN for R1.1/R1.3 shape rows without touching flow behaviour yet.** Replace the loose `target` object with `delegationTargetSchema`, apply `refineDelegateOptionsForTarget`, and move depth **plus** the new fan-out check into `admitDelegatedChild` — the flow-target branch still refuses, so R1.2 must stay green through this task.
  *Acceptance*: R1.2 green (compat intact), R1.1 green, R1.3 shape/limit rows green, R1.3 flow-trust rows still red.
  *Satisfies*: REQ-01, REQ-02, REQ-15.

- [x] **T6.2 — The flow arm.** (depends on T6.1)
  **RED**: R1.3's remaining flow rows + the new behaviour cases below.
  **GREEN**: delete the `"flow-target delegation is not yet supported"` block (`:145-160`); resolve via `resolveDelegatableFlow`; then, in **one** `db.transaction` that also holds the admission lock: mint the carrier task and create the `parent_of` relation — for **BOTH** modes (D1) — with `tasks.flowId` = the **selected** child flow (explicitly **not** inherited from the orchestrator's task, REQ-11), `title = body.title ?? titleFromPrompt(body.prompt)` in both modes, `launch_mode='manual'`. After commit, call `launchRun({taskId: carrierTaskId, flowId, runnerId: body.runnerOverride ?? undefined, parentRunId, rootRunId, launchMode:'manual', delegationSnapshot:{kind:'flow',…}}, extCtx)` where `extCtx = {actorUserId: null, authorize: async () => {}}` (the token already scoped the project). The **agent** arm's `mode:task` block moves into the same single transaction (atomicity improvement, pinned by R1.2).
  Keep the existing `parent.taskId`-absent branch as a graceful `log.info` + continue — **do not** harden it into an assert: it is unreachable today (F10) but becomes live if an agent orchestrator is introduced. Re-comment it as *"reserved for a future agent orchestrator; unreachable while only the flow graph runner issues an orchestrator token"*.
  **REFACTOR**: the two arms share pre-flight, admission, and the response builder; only resolution + launcher differ (SRP).
  *Acceptance*: both flow modes → carrier task + `parent_of` + flow run with every delegation column set, `202 {childRunId, childTaskId}`; an explicit `title` persists in both modes; the carrier task's `flowId` is the SELECTED flow; `runnerOverride` reaches the **flow** executor-resolution chain as `LaunchRunInput.runnerId` (REQ-13), and an unknown runner surfaces that chain's own error.
  *Logging*: `log.info({parentRunId, childRunId, childTaskId, targetKind:"flow", flowRefId, flowRevisionId, mode}, "[delegation.delegate] flow child launched")`.
  *Satisfies*: REQ-07, REQ-08, REQ-09, REQ-10, REQ-11, REQ-13.

- [x] **T6.3 — `title` on the AGENT `mode: run` path.** (depends on T6.2)
  `delegate/route.ts:218` sits inside the `mode === "task"` block, so an agent `mode: run` **silently discards** `title` — a live instance of the rule this plan enforces. An agent `mode:run` child creates no task, so there is nothing to name: refuse with `CONFIG` — *"title is only meaningful with mode:task (an agent mode:run child has no task to name)"*.
  **⚠ Behaviour change to a shipped path.** Owner approved Q3=A for the flow path; this agent-side tightening is offered separately and is **safe to drop** without affecting any other task.
  *Acceptance*: agent `mode:run` + `title` → `CONFIG 422`, nothing written; agent `mode:task` + `title` unchanged (R1.2); flow accepts `title` in both modes.
  *Satisfies*: REQ-12.

- [x] **T6.4 — Carrier-task compensation (W2).** (depends on T6.2)
  **RED**: inject a `launchRun` that throws `EXECUTOR_UNAVAILABLE` after the carrier commit; assert the carrier task and relation are gone and the route returns `503` — fails, no compensation exists.
  **GREEN**: an outermost compensation wrapping the **entire** `launchRun` call (not a convenient tail), deleting the carrier task + relation guarded by "the task has no runs", with per-revert `catch` + `log.error`. Note `launchRunStaged` already owns two inner compensation layers (`removeWorktree`, `revertPackageVersionChoices`); this is a third, outer one.
  *Logging*: `log.warn({parentRunId, carrierTaskId, code}, "[delegation.compensate] flow delegation failed after carrier task — removing carrier")`.
  *Satisfies*: REQ-21.

- [x] **T6.5 — Scheduler dispatch + per-pool admission (REQ-17).** (depends on T6.2)
  With the flow pool saturated, a flow delegation returns `202` with the child `Pending`; freeing a slot and running `promoteNextPending({pool:'flow'})` flips it `Running`. In the same table: an **agent** child from the same orchestrator is admitted against the **agent** pool independently — two budgets, one tree (F8).
  *Satisfies*: REQ-17.

- [x] **T6.6 — Crash recovery (W5).** (depends on T6.2)
  Drive a delegated flow child to `Running` with no live supervisor session; run reconcile; assert `Crashed` **and** a `run.crashed` domain event carrying `parentRunId`; then run `orchestrator_resume` and assert the parent wakes.
  *Satisfies*: REQ-21.

- [x] **T6.7 — Parent terminalization during launch (W6).** (depends on T6.2)
  **GREEN**: a post-commit parent re-read; if the parent is terminal, abandon the child through the `cascadeAbandonRunTree` path and return `PRECONDITION 409`.
  *Satisfies*: REQ-21.

- [x] **T6.8 — Residual shapes W3, W7, W11, W12.** (depends on T6.4, T4.2)
  Four assertions pinning documented residuals so a future change that alters any of them fails loudly rather than silently:
  - **W3**: simulate death between the carrier tx and the launch — the residual is a `Backlog`, `launch_mode='manual'` task that **no** discovery query selects (drive `auto_launch_run_plan` and a C2 tick; assert no run appears);
  - **W7**: two identical delegations → two children, both in `run_collect`; the one that would exceed the cap → `CONFIG` (the admission lock narrows but does not eliminate this — D6);
  - **W11**: after an orchestrator abandon, carrier tasks are **not** `Abandoned`, their latest run **is**, `classifyManualTaskLaunchability` → `"launchable"`, and **neither** automation claims them;
  - **W12**: after the parent exits **normally**, an un-promoted flow child is still `Review`, its `workspaces` row un-removed, holds **no** scheduler slot, and a GC pass does not collect it.
  *Satisfies*: REQ-21.

**Phase 6 exit** — R1.1, R1.2, R1.3 all GREEN; suite green.

---

### Phase 7 — `run_plan` flow targets + the as-plan auto-launcher

- [x] **T7.1 — Discriminated target in `run_plan`.** (depends on Phase 6)
  `planTaskSchema.target` → `delegationTargetSchema`; per-kind option allow-list (`workspace` agent-only, `runnerOverride` both). Pre-tx validation (e) dispatches per target kind and still **collects all failures** so every bad target is reported at once with **no rows written**. A flow entry's `createTask` sets `flowId` = the resolved child flow and `delegationSpec = {kind:'flow', flowId, runnerOverride?}`.
  *Acceptance*: a mixed agent+flow plan writes all tasks + `requires` edges in **one** transaction; one bad flow target writes nothing and lists both failures.
  *Satisfies*: REQ-01, REQ-11, REQ-12.

- [x] **T7.2 — Source-task launch dispatch + admission.** (depends on T7.1)
  Post-commit source launch (`plan/route.ts:410-450`) branches on `delegationSpecKind` → `launchAgentRun` vs `launchRun`, and the pre-tx bound calls `admitDelegatedChild(tx, {parentRunId, incoming: tasks.length})` — replacing the per-call-only `tasks.length > cap` check so the batch is bounded by **live children + batch size** (REQ-15). A source-launch failure still leaves the task in `Backlog`.
  *Logging*: `log.info({key, taskId, targetKind, childRunId}, "[delegation.plan] source task launched")`; the existing failure `log.warn` gains `targetKind`.
  *Satisfies*: REQ-09, REQ-15.

- [x] **T7.3 — Widen `auto_launch_run_plan` — and guard its edge (H1/H4).** (depends on T7.2)
  `web/lib/domain-events/auto-launch.ts`:
  - `if (payload.runKind !== "agent") continue;` (`:203`) → an **allow-list** `!== "agent" && !== "flow"`, so `scratch` and any future kind stay rejected by default;
  - `autoPromoteAsPlanChild` (`:214`) now also runs for flow children (`promoteChildRunForToken` is already kind-agnostic);
  - candidate launch (`:302-345`) dispatches on `delegationSpecKind` and — **new** — calls `admitDelegatedChild` before launching. This edge has **never** had a depth or fan-out check; widening it to flow without the guard would make a burst of released dependents unbounded;
  - the `!spec.agentId` guard (`:303`) becomes kind-aware (agent needs `agentId`, flow needs `flowId`), preserving the skip-not-throw idempotent contract.
  *Acceptance*: a mixed diamond DAG (agent → flow → agent) flows end-to-end — sources launch, each child reaches `Review`, auto-promotes to `Done`, advances its task, releases the dependent, and the dependent launches with the right launcher; a burst that would exceed the cap is refused per-candidate and logged, never thrown (the consumer's idempotent contract).
  *Satisfies*: REQ-09, REQ-15, REQ-19.

- [x] **T7.4 — as-plan flow child: auto-promote vs manual, and the conflict path.** (depends on T7.3)
  One table-driven test, three rows: a `launch_mode='auto'` flow child in `Review` **is** auto-promoted (system actor, `local_merge`) → `Done` → `run.done` re-enters the consumer → task `Done` → `requires` released; a **manual** (as-run) flow child in `Review` is **not** auto-promoted (waits for `run_promote`) — the `launch_mode` discriminant; an auto child whose promote **conflicts** stays `Review`, surfaces `CONFLICT`, flips no sibling, and is never auto-resolved (REQ-20: `Review` ≠ safe-to-ship).
  *Satisfies*: REQ-14, REQ-20.

**Phase 7 exit** — mixed-kind DAGs work end-to-end; all three creation edges are guarded; suite green.

---

### Phase 8 — Tool support matrix + cascade

- [x] **T8.1 — Explicit `run_rework` / `run_message` refusals (D2).** (depends on Phase 7)
  **RED**: a flow child in `Review` → `run_rework` currently reaches `reworkChildRun` and fails with its internal message; assert instead the route-level `PRECONDITION 409` — *"run_rework is not supported for flow children — promote or cancel it, or resolve it through its own review loop"*.
  **GREEN**: extend the child `select` with `runKind` and refuse **before** dispatch (`reworkChildRun`'s own `runKind !== "agent"` guard stays as defence in depth). Symmetric explicit refusal in `message/route.ts`.
  *Acceptance*: the flow child is untouched by the refusal (still `Review`, `promotion_state` unchanged) and `run_promote` on the same child still succeeds — proving the refusal is a routing decision, not a state mutation.
  *Satisfies*: REQ-09, REQ-14.

- [x] **T8.2 — Cancellation cascade covers flow children.** (depends on Phase 7)
  An orchestrator with one agent child (`Running`) and one flow child (`Review`); abandon the orchestrator; assert **both** flip `Abandoned`, `run.abandoned` fires for each with `parentRunId`, workspaces get `scheduled_removal_at`, and `promoteNextPending` runs once **per pool** (`flow` and `agent`).
  *Satisfies*: REQ-19.

- [ ] **T8.3 — Dispatcher-arm sweep (REQ-09).** (depends on T8.1, T8.2)
  For each of the twelve sites in the §Shared dispatchers table, confirm coverage exists for **both** discriminant arms — the six marked VERIFY get one flow-child assertion each if none exists, the six marked NEW/WIDEN are already covered by their own tasks. Half-A-tested + half-B-tested ≠ A∘B-tested. Record the mapping (site → covering test) in the commit body; add only the assertions genuinely missing — do not create parallel tests for behaviour already pinned.
  *Satisfies*: REQ-09.

**Phase 8 exit** — every dispatcher arm covered; suite green.

---

### Phase 9 — Contract finalization, docs, E2E

> The machine-readable contracts landed in Phase 0. What remains is prose, status flips, and the end-to-end proof.

- [ ] **T9.1 — Flip Designed → Implemented + reconcile drift.** (depends on Phase 8)
  `orchestrator.md`, `runs.md`, `domain-events.md`, `database-schema.md`, `db/runs-domain.md`: flip every ADR-163 status tag, and reconcile any statement that drifted during Phases 2-8 — the Phase-0 spec is the source of truth, so a genuine divergence is fixed in **both** places, never patched in the doc alone.
  *Acceptance*: `pnpm validate:docs` green; a line-by-line re-read of the Phase-0 refusal table matches the shipped route.
  *Satisfies*: REQ-22.

- [ ] **T9.2 — Prose surfaces: DSL, config, error taxonomy, shipped skills.** (depends on T9.1)
  `docs/flow-dsl.md` §"Node `orchestrator`" (`:598-676`): flow targets in the delegation toolset; `settings.delegation.max_fanout` now bounds **live children of any kind** (D3) — and say explicitly that `web/lib/config.schema.ts` is **unchanged** (`orchestratorSettingsSchema:789` gains no field; only runtime semantics widen), so a reader does not hunt for a schema field.
  `docs/configuration.md`: widen the `MAISTER_MAX_ORCHESTRATOR_FANOUT` row's description. `docs/error-taxonomy.md`: the new refusal reasons under the **existing** `CONFIG` / `PRECONDITION` codes (no new code).
  `docs/system-analytics/external-operations.md` + any shipped skill text enumerating delegation targets. **Verification gate** (project rule: contract edits are not done until the spec set is updated AND verified by grep): run `grep -rn "run_delegate\|run_plan" docs .codex .claude`, open each hit, and record in the commit body which were updated and which are confirmed kind-neutral.
  *Satisfies*: REQ-22.

- [ ] **T9.3 — In-repo fixture Flow (REQ-23).** (depends on Phase 8)
  E2E flow manifests are **not** `flow.yaml` files on disk — they are inline `INSERT INTO flows (…, manifest, …)` + a `flow_revisions` row in `web/e2e/_seed/seed-e2e.ts` (`:1723`, `:1826`, `:1928`, `:2034`, `:2239`), surfaced through a typed entry in `web/e2e/_seed/fixtures.ts` (the orchestrator fixture is at `:44`, `:241`).
  Add a `delegated-flow` fixture the same way: a minimal 2-node graph (one `cli` node that touches a file, one `check` node), `flows.trust_status='trusted'`, `enablement_state='Enabled'`, an `Installed` revision with `setup_status='done'` and a host-compatible engine range, plus an `E2EDelegatedFlowFixture` entry.
  **No third-party production package enters this repo** — the `maister-plugins` example stays deferred in ADR-163 §Follow-ups.
  *Satisfies*: REQ-23.

- [ ] **T9.4 — E2E: an orchestrator launches a Flow child that reaches `Review`.** (depends on T9.3)
  New spec `web/e2e/flow-target-delegation.spec.ts`, following `web/e2e/orchestrator-loop.spec.ts`: the test supervisor drives the orchestrator session to call the **real** `POST /api/v1/ext/runs/delegate` with `{target:{flowId:"delegated-flow"}, mode:"task", prompt:…}`; assert the workbench run-tree renders the **flow** child; drive its nodes; assert it reaches **`Review`**; tick `POST /api/cron/tick?jobKind=domain_event_dispatch` and assert the parked orchestrator wakes (`WaitingOnChildren → Running`).
  **⚠ Shared-infra gotcha:** ports `3100`/`7788` and the `maister_e2e` DB are shared across **all** worktrees — kill those ports and baseline-prove the suite before attributing any failure to this change.
  *Acceptance*: `pnpm --filter maister-web test:e2e -- flow-target-delegation` green; the full e2e suite shows no **new** failures versus the Phase-0 baseline.
  *Satisfies*: REQ-07, REQ-18, REQ-23.

**Phase 9 exit — definition of done**
- [ ] `pnpm --filter maister-web exec eslint .` (check-only — **never** the bare `lint` script, which is `eslint --fix` with no path and reformats ~60 files)
- [ ] `pnpm --filter maister-web typecheck`
- [ ] `pnpm --filter maister-web test:unit`
- [ ] `pnpm --filter maister-web test:integration`
- [ ] `pnpm --filter @maister/mcp build && pnpm --filter @maister/mcp typecheck && pnpm --filter @maister/mcp test`
- [ ] `pnpm validate:docs` (mermaid + ADR anchors + links + indexes + `db:erd --check`)
- [ ] `pnpm validate:contracts` — **mandatory**: OpenAPI/AsyncAPI guard over the file S0.5 edits
- [ ] `pnpm --filter maister-web db:generate` → **no new migration** (re-proves D5 at HEAD; if it emits one, D9's procedure applies)
- [ ] `pnpm --filter maister-web test:e2e`
- [ ] **Traceability closed**: every REQ-01…REQ-23 row has a task **and** a test, both landed

---

## Test-integrity contract (applies to every phase)

1. **Runnability.** Every new test lands in an already-globbed path family — `lib/**/*.integration.test.ts` and `app/**/*.integration.test.ts` are both in the `integration` project's `include` (`web/vitest.workspace.ts:82-88`); unit tests go to `lib/**/__tests__/**/*.test.ts`. **No runner-config change is required.** Confirm with `pnpm --filter maister-web exec vitest list --project integration` before claiming a test is a deliverable. *(Known: `vitest list` can abort at collection on a pre-existing mock error — if it does, confirm the glob by running the single file instead and say so.)*
2. **Baseline first.** At Phase 0, capture the integration baseline as an **enumerated set of failing test ids** (not a count) — `main` currently carries pre-existing integration failures (≈61 by the last recorded measurement, plus ~8 macOS `/var`-symlink dirty-watchdog cases). Every later phase compares the **set**, never the count: a count delta hides a new failure when a pre-existing one coincidentally resolves.
3. **Per-phase green checkpoint.** Each phase exits only when unit + integration are green **relative to the enumerated baseline**. A test the phase touches that is left red fails the phase. Any newly-surfaced pre-existing red is quarantined by an explicit config `exclude` or `.skip` **with a reason and a tracked follow-up** — never tolerated silently, never deleted.
4. **RED is recorded, not assumed.** Every task's RED step names the test AND the failure it produced. A task whose "RED" test passed before the change is a defect in the test, not progress — rewrite the test. A phase may not exit with an unrecorded RED.
5. **Assertion migration is in-scope, by path.**
   - `web/app/api/v1/ext/runs/__tests__/delegate.integration.test.ts:790` — the `"flow-target delegation is rejected"` case: **migrate** (R1.2 records it; T6.2 inverts it), do not delete.
   - `web/app/api/v1/ext/runs/__tests__/plan.integration.test.ts` — target-shape assertions move to the discriminated union (T7.1).
   - `web/app/api/v1/ext/runs/__tests__/promote-rework.integration.test.ts` — gains the flow-child `run_rework` refusal case (T8.1).
   - `web/lib/domain-events/__tests__/orchestrator-resume.integration.test.ts` — gains the flow-child arms (T3.2); existing agent arms must stay untouched and green.
   - `web/lib/domain-events/__tests__/` auto-launch suites — the `runKind !== "agent"` skip assertions become allow-list assertions (T7.3).

## Logging contract

Structured `pino` throughout, `[delegation.*]` prefix, always carrying `{parentRunId, targetKind}` and, where known, `{childRunId, childTaskId, flowRefId, flowRevisionId, mode}`:

| Namespace | Level | Event |
| --- | --- | --- |
| `[delegation.flow]` | debug / warn | target resolved / target refused (with `reason`) |
| `[delegation.delegate]` | info | flow child launched |
| `[delegation.launch]` | info | flow run launched as a delegated child (in `launchRunStaged`) |
| `[delegation.compensate]` | warn / error | carrier removed / carrier removal failed |
| `[delegation.fanout]` | warn | refused at the shared cap |
| `[delegation.wake]` | info | `run.review` emitted for a delegated flow child |
| `[delegation.plan]` | info / warn | source task launched / source launch refused |

**Never logged**: prompts, artifact bodies, token secrets, `acp_session_id`.

---

## Explicitly out of scope
Public Run-result exports · `run_collect` payload changes · RAH reference workflows · RLM runtimes · Prime Agent integration · runtime-authored or untrusted Flow definitions · `workspaceMode: shared` for flow children · production third-party Flow packages in this repo.

---

---

## Owner decisions on the plan's open questions (resolved 2026-09-01)

| Q | Decision | Consequence in this plan |
| --- | --- | --- |
| **Q1 — idempotency for `run_delegate`** | **A — accepted residual**, no key in this cut | D6 unchanged; ADR-163 §Follow-ups carries the `runs.delegation_key` + partial-unique upgrade path. Revisit if orchestrators are to run unattended for long stretches — a duplicate *flow* child costs a full graph run, not one session. |
| **Q2 — carrier task on the board** | **A — visible, and `parent_of` created ALWAYS** | **D1 revised.** Driven by F10: `childTasks` is additive, so an unlinked `mode: run` child would have been an orphan card at the same clutter cost. `mode` is no longer a board switch for flow targets. |
| **Q3 — `title` on `mode: run`** | **A — honour it in both modes** | Option matrix + T6.2. The agent-path silent drop is offered separately as **T6.3** (a shipped-path tightening, safe to drop). |
| **Q4 — `maister-plugins` companion** | **A — defer, record in ADR-163** | T9.2/T9.3 + ADR-163 §Follow-ups. §9 requires only that it be recorded. |

**Owner's own observations, verified and folded in:**
- *"Таска родительского run будет всегда"* — **correct**, and now recorded as **F10**: only the flow graph runner issues an orchestrator token, so the bound run is always a flow run, which always has a task. The `parent.taskId`-absent branch is unreachable today but is **kept**, re-commented as reserved for a future agent orchestrator (where `runs.task_id` may legitimately be null).
- *"если несколько ранов по таску — таких сабтасков может наплодиться много похожих"* — **correct, and pre-existing**: agent `mode: task` already does exactly this; flow targets do not introduce the class, only raise the per-unit cost. Its sharper form is now **F11 / W11**: an abandoned orchestrator leaves its carrier tasks `Launch`-able on the board. Accepted rather than fixed, on verified grounds — **no automation can fire them** (`auto_launch_run_plan` requires `launch_mode='auto'`; the C2 funnel requires triage), so only a human clicking a card they can read. Pinned by **T6.8** so a future change that makes an automation claim these tasks fails loudly.
