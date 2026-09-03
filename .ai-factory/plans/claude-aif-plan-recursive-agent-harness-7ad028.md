# Implementation Plan: Governed Recursive Agent Harness (RAH) — public Run results, result profiles, effective recursion bounds, result-only completion, reference workflow

Branch: `claude/aif-plan-recursive-agent-harness-7ad028` (pre-existing worktree branch — NOT created by this plan; base = `main` tip `c7bc45ddd`, ADR-163 merged and pushed 2026-09-02 12:15)
Created: 2026-09-02 · Refined: 2026-09-02 (`/aif-improve` — SDD + TDD pass; owner decisions Q1-A · Q2-A · Q3=6 · Q4-A · **Q5-C** · Q6-C · Q7-C · Q8-A · Q9-B · Q10-A applied)
ADR: **ADR-165** (provisional — `main` HEAD ends at ADR-163; **ADR-164 is committed on the unmerged Stage A branch** `claude/stage-a-execution-host-plan-6d70f9`, verified in its `docs/decisions.md`; whichever of the two lands second re-verifies `git show main:docs/decisions.md` and renumbers — D14)
Migration: **`0129_run_results`** (provisional — `main` journal max is `0127`; **`0128_execution_hosts` is committed on the Stage A branch**, verified in its `_journal.json`; D14)
Engine: `MAISTER_ENGINE_VERSION` **3.6.0 → 3.7.0** (`RAH_ENGINE_MIN = "3.7.0"`)

## Settings
- Testing: yes — **TDD, RED → GREEN → REFACTOR** per task; integration-first against real Postgres + the real seams (`runGraph`, `finalizeAgentRun`, the route handlers, the consumers); unit only for pure functions
- Logging: verbose — structured `pino`, `[run-result.*]` / `[delegation.*]` / `[budget.tree.*]` namespaces (§Logging contract); **never a result value, prompt, artifact body, token secret, or `acp_session_id`**
- Docs: yes — mandatory documentation checkpoint; **SDD**: the Phase-0 specification set is normative; implementation may not diverge from it; a genuine divergence is a spec bug fixed in BOTH places in the same commit
- Method: SDD + TDD exactly as the ADR-162 / ADR-163 plans (same working agreement, same test-design rules)

## Roadmap Linkage
Milestone: "none"
Rationale: Repository inspection found no directly matching active milestone (the only unchecked one is **M45**; the Backlog has no recursive-harness / public-result / orchestrator-depth entry). Skipped per the request.

---

## Prerequisite audit (no blocker; four gaps that are the work itself)

| # | Prerequisite | Status | Evidence |
| --- | --- | --- | --- |
| P1 | `output.result` channel for every AI-producing node | **Present** | `NODE_OUTPUT_TRANSPORT` (`web/lib/flows/graph/node-output.ts:46-58`); seam `validateNodeStructuredOutput` `:282-405` at `runner-graph.ts:3454-3464`; per-attempt identity `node_attempts.output_contract` (migration 0127). |
| P2 | Flow-owned schemas with open JSON substructures | **Present** | `formSchemaSchema` (`config.schema.ts:1314-1378`): `json` type, recursive `items`, open objects; `checkStructure` (`output-schema.ts:46-94`): depth ≤ 64, keys ≤ 10 000, arrays ≤ 10 000, unsafe keys; byte cap `MAISTER_NODE_OUTPUT_MAX_BYTES` 256 KiB. |
| P3 | Orchestrator delegation to trusted Agent AND Flow targets | **Present** (`main` `c7bc45ddd`, ADR-163 — pushed 2026-09-02) | `delegationTargetSchema`, `resolveDelegatableFlow`, carrier task, `launchRunStaged` flow arm, `admitDelegatedChild` on every creation edge, `emitDelegatedReviewIfChild`. |
| P4 | Run trees, `WaitingOnChildren`, cascade, promotion, rework, concurrency, tree budgets, evidence, readiness | **Present** | `runs.parent_run_id/root_run_id`; `orchestrator_resume`; `cascadeAbandonRunTreeAndStopSessions`; `promoteRun` re-gates `assertEvidenceReady` (`promote.ts:726`); ADR-101 root-only tree meters (`keepalive-sweeper.ts:1122-1205`); `artifact_instances` FSM; `readiness-core.ts`. |

**Gaps the brief requires and the repo lacks** (each is a REQ below, not a parallel mechanism): **G1** no run-level result entity; agent runs have no result transport (`finalizeAgentRun` writes only `runs`). **G2** node-level delegation bounds are dead config (owner decision 2026-09-02); no child-count budget; no per-orchestrator active-children cap (3 × 16 ⇒ up to 4 096 admissible runs). **G3** `run_collect` scavenges an `inline` artifact for `outputText` with no `ORDER BY` (non-deterministic). **G4** no tree-wide cost/wall-clock roll-up in any UI or Lab metric; the Lab has no rework/crash/child-count/result metrics.

One 2026-09-02 owner decision is reversed by the brief and re-confirmed by the owner (**Q1-A**): node-level bounds become live **only for `engine_min ≥ 3.7.0`** (D5).

---

## Requirement register (normative)

Every REQ is claimed by ≥ 1 task AND ≥ 1 AC; a task satisfying no REQ is cut.

| ID | Requirement | Brief § |
| --- | --- | --- |
| **REQ-01** | One engine-owned, run-kind-neutral envelope `{schemaRef, value}`; the engine owns run identity, immutable schema identity, producer identity, attempt/revision identity, validity + supersession, engine-derived artifact metadata, creation + completion timestamps. The producer supplies ONLY the validated `value`. | §1 |
| **REQ-02** | Flow Run: explicit `result.export` (package-local schema + producer node set); every permitted producer satisfies the export schema; the export resolves against the PINNED revision; rework supersedes; Failed / Crashed / Abandoned / human-resolved paths have explicit semantics; **a flow that completes with a valid public result and a clean workspace finalizes to `Done` directly (result-only completion, Q5-C)**. | §2 |
| **REQ-03** | Agent Run: package-level named `result_profiles`; `run_delegate`/`run_plan` select by NAME; server-resolved from the parent's pinned package; the child emits a final `maister:output` block; validated + persisted BEFORE the child becomes collectable; `persistent + resultProfile` refused by an explicit allow-list guard. | §2 |
| **REQ-04** | Scratch and manual runs keep the public result optional. | §2 |
| **REQ-05** | Open JSON payloads with a deterministic spine; unknown fields preserved exactly; the ADR-162 limits apply unchanged, through ONE validator. | §3 |
| **REQ-06** | `run_collect` v2 (Appendix B): direct children only; status-without-result while running; explicit `resultStatus` for every settled shape; `outputText` additive/deprecated; engine-derived artifact metadata; idempotent; stale bound tokens refused; MCP + OpenAPI + examples + tool docs updated. | §4 |
| **REQ-07** | Effective depth / fan-out / active-children = `min(instance policy, active orchestrator node declaration)`; parent, root, project, depth, active node, pinned revision, allowed profiles server-derived; no redundant body-controlled cross-resource ids; concurrency / capabilities / trust / workspace / executor / budget enforcement unchanged; concern-specific predicates; the exact wake event documented; a nested orchestrator publishes its OWN result. | §5 |
| **REQ-08** | Reference RAH workflow (§6) with ONE writer, an independent verifier, bounded rework / human escalation for malformed results, child failures, budget exhaustion and no-consensus; a settled child is never promotable by itself; hidden subagents structurally excluded. | §6 |
| **REQ-09** | Conservative defaults: depth 2, fan-out **6**, active children 3; explicit tree-level token / wall-clock / child-count / failure budgets REQUIRED; deeper recursion needs Flow author intent; effective bounds recorded on the Run. | §7 |
| **REQ-10** | Observability: run tree, result identity + value in the run inspector, structured decision records, tree-wide token + wall-clock aggregate, no values in logs, no second evidence subsystem. | §8 |
| **REQ-11** | Evaluation Lab comparison of 4 arms over the 9 measures through the existing objective-provider seams; "parent used the results" measured as engine-marked collection ∩ self-reported consumption (Q7-C). | §9 |
| **REQ-12** | Production package ownership is external (`maister-plugins/packages/rah`, authored in parallel after Phase 7, committed/tagged after this repo merges — Q9-B); this repo ships engine/API/storage/UI + an in-repo fixture package; no external package source enters core. | §Repo |
| **REQ-13** | Launch-time schema/profile decisions persisted; terminal and collection paths read the snapshot. | §Plan |
| **REQ-14** | Every body-controlled identifier in changed routes enumerated; server-state derivation preferred. | §Plan |
| **REQ-15** | Multi-store terminal transitions atomic, or every crash window enumerated AND tested. | §Plan |
| **REQ-16** | Coverage of the 14 named scenarios; suites runnable and green at every phase boundary. | §Plan |

## Traceability matrix (REQ → spec artifact → tasks → ACs)

| REQ | Spec artifact (Phase 0) | Tasks | ACs |
| --- | --- | --- | --- |
| REQ-01 | ADR-165 §Envelope; `run-results.md` §Entities + §FSM; DB docs | S0.1–S0.4, T3.1–T3.3 | AC-07, AC-08, AC-09, AC-10 |
| REQ-02 | `run-results.md` §Flow semantics + §Result-only completion; `flow-dsl.md`; `runs.md`; `workspaces.md`; `readiness.md` | T2.2, T4.1–T4.7 | AC-03, AC-11–AC-17 |
| REQ-03 | `run-results.md` §Agent semantics; OpenAPI `resultProfile`; MCP | T2.1, T5.1–T5.6 | AC-01, AC-02, AC-19–AC-24 |
| REQ-04 | ADR-165 §Scope; `run-results.md` Expectations | T3.2 | AC-09 (NULL-contract row) |
| REQ-05 | `run-results.md` §Limits (reuse) | T3.2, T4.2, T5.4 | AC-13, AC-23 |
| REQ-06 | OpenAPI `ExtChildRunSummary` v2; MCP `run_collect`; `orchestrator.md` §Collect | S0.6, S0.7, T7.1–T7.4 | AC-31, AC-32, AC-33 |
| REQ-07 | `orchestrator.md` §Bounds; ADR-165 §Bounds; `scheduler.md`; `domain-events.md` | T6.1–T6.6, T4.6 | AC-18, AC-25–AC-30 |
| REQ-08 | `run-results.md` §Reference workflow; fixture package | T9.1–T9.3 | AC-37, AC-38 |
| REQ-09 | ADR-165 §Defaults; `flow-dsl.md` `delegation` v2; `execution-policy.md` | T2.3, T6.1–T6.4 | AC-04, AC-05, AC-25, AC-28, AC-30 |
| REQ-10 | `run-results.md` §Observability; `runs.md` cost section; `screens/runs/flow-run.md`; `web.openapi.yaml` cost-summary | T8.1–T8.5 | AC-34, AC-35, AC-36 |
| REQ-11 | `evaluations.md` §RAH protocol | T10.1–T10.4 | AC-39 |
| REQ-12 | ADR-165 §Packaging; companion doc | T9.1, T11.3 | AC-37 (fixture is in-repo), AC-40 |
| REQ-13 | `run-results.md` §Snapshots; DB docs | T4.1, T5.2, T6.1 | AC-11, AC-12, AC-19, AC-26, AC-27 |
| REQ-14 | §G trust tables | T5.1, T7.1 | AC-19, AC-32 |
| REQ-15 | §D crash matrix | T4.2, T4.5, T5.4, T6.1, T7.2 | AC-13 (W1), AC-15/16 (W2/W10), AC-23 (W3), AC-24 (W4), AC-26 (W5), AC-32 (W6) |
| REQ-16 | §Test-integrity contract | all | AC-37 (matrix), phase gates |

---

## Working agreement — SDD + TDD (binding for `/aif-implement`)

1. **Phase 0 is normative.** ADR-165, `docs/system-analytics/run-results.md`, the updated `orchestrator.md` / `runs.md` / `workspaces.md` / `flow-graph.md` / `readiness.md` / `domain-events.md` / `scheduler.md` / `execution-policy.md` / `evaluations.md`, the DB docs, the OpenAPI + MCP contracts (Appendix B) and the grammar contract are authored before code. `mcp/src/__tests__/tool-contract.test.ts` is OpenAPI-anchored and becomes RED in Phase 1.
2. **RED is recorded, message pinned.** A test that passes for the wrong reason (status+code only) is not RED (ADR-163 lesson).
3. **No trivial tests, minimum overlap** — every AC has exactly ONE primary enforcing test (Appendix E); other suites may touch a behaviour incidentally but never re-assert it as their purpose. Table-driven refusals. A real two-racer (second pg connection + `pg_stat_activity.wait_event_type='Lock'`) for every lock. Integration tests execute the real seam; a test that mocks the thing it pins is a defect.
4. **Every allow-list gets a positive test, not only denials** (patch 2026-08-06-19.10). **Assert both orderings of a race** (patch 2026-07-27-21.50). **A guard's failing state must be reachable in production** — write the production-shape test first (patch 2026-09-01-05.40).
5. **Runnability**: new tests land in `lib/**/*.integration.test.ts`, `app/**/*.integration.test.ts`, `lib/**/__tests__/**/*.test.ts`, `components/**/__tests__/**/*.test.ts` (all globbed by `web/vitest.workspace.ts`). `vitest list --project integration` is unusable — confirm by running the file.
6. **Baseline first, compare SETS.** Integration was 0 failures on 2026-09-02 except the flaky `lib/runs/__tests__/dirty-resolution-race.integration.test.ts` pair; e2e 35 failures at `73fa99915`. Ryuk/docker mass failures are infrastructure. **As-built (2026-09-03, rebased onto `main` = ADR-164/0128):** the e2e baseline is **34** — the two `m18-branch-promotion` failures were fixed (a shared fixture target branch + page-wide `getByText("Done")`), and `recursive-harness.spec.ts` is accepted KNOWN-FLAKY under the full parallel suite (passes in isolation; mechanism and the restructure backlog item are recorded in `web/CLAUDE.md` §Suite baselines).
7. **Shell hygiene**: every Bash call `cd`s to an absolute path; never the bare `pnpm lint`; ports 3100/7788 + `maister_e2e` are shared across worktrees; `mcp/dist` must be rebuilt after `tools.ts` edits.
8. **Code rules**: `MaisterError` with a discriminated `code`, allow-lists over deny-lists, no `any` without `// FIXME(any):`, comments explain WHY only, surgical diffs, one SSOT per concept (one validator, one status predicate, one bounds computation, one publish helper, one result-status derivation).

---

## As-built findings (read in the working tree; every later phase depends on them)

- **F1 — Schema documents are JSON, package-root, path-referenced** (`ROOT_SCHEMA_PATTERN`, `lib/flows/editor/reference-sources.ts:47`; reader `readFormSchemaDocWithBytes`, `lib/config.ts:1954-2023`). `.yaml` is not accepted → the brief's `.yaml` example maps to `.json` (Q2-A). Package-root `schemas/` is copied into every member flow's `installedPath/schemas/` at install (`materializeSharedPackageRootSchemas`, `lib/flows.ts:348-403`).
- **F2 — `maister-package.yaml` is `.strict()` (`config.schema.ts:1558-1590`); `flow.yaml` is `.passthrough()` (`:1237-1293`).** `contractOf` (`lib/flows.ts:790`) projects only `capabilities/gates/artifacts/external_ops`; `FLOW_YAML_KEYS` (`lib/flows/authored-complete.ts:22`) is a stale completion list.
- **F3 — Schema resolution is lazy at the seam** (`resolveOutputResultSchemaWithIdentity`, `lib/config.ts:2035`, called only after a non-absent payload — ADR-162 amendment). `flowInstallPath` = `runs.flow_revision_id → flow_revisions.installed_path` (`runner-core.ts:293-323`). ⇒ the run-level contract must be resolved by the LAUNCHER, pre-worktree, and read by the seam.
- **F4 — Flow-node payload persistence is a merged bag** (`result.vars = {...vars, ...value}`, `node-output.ts:391-393`); the pure value exists only inside the seam's success path.
- **F5 — Agent runs have no result plane.** `consumeAgentSession` (`lib/agents/launch.ts:3613-3817`) extracts text only for consensus drafts; `finalizeAgentRun` (`:2341-2737`) is the single terminal choke point (CAS from `TERMINAL_CAS_SOURCE[outcome]`, status `Review` iff a `workspaces` row or a shared writable exit, else `Done`; emits `run.review{cause:"agent_exit"}` iff `parentRunId`, else `DOMAIN_KIND_BY_OUTCOME` with an optional `reason`). Chunk capture precedent: `runner-agent.ts:546-547,653` (`agent_message_chunk`, 1 MiB cap).
- **F6 — Terminal transitions are single-transaction.** Flow: three CAS branches in `runGraph` (`runner-graph.ts:4813-4945`); the Review branch flips `{status:"Review", endedAt, reviewEnteredAt, currentStepId:null}` WHERE `status='Running'`, emits webhook + `emitDelegatedReviewIfChild(…cause:"graph_completed")`, then (outside the tx) `deliverRunIfAutoReady`, `releaseRunContextMounts` (status-gated inside), token revoke, `promoteAfterExit → promoteNextPending`. `assertEvidenceReady(runId,"review")` runs BEFORE the branch (`:4158`, Review chokepoint). Agent: one `finalizeAgentRun` transaction.
- **F7 — What a promote-driven `Done` writes** (`promote.ts:1188-1275`, own-tree arm): `runs{status:"Done", currentStepId:null, endedAt, promotedHeadSha, mergeCommitSha, diffStat}`; `workspaces{promotionState:"done", promotedAt, scheduledRemovalAt = now + gcAgeDays, promotionLane}`; webhook `run.promoted`; per settled child: `systemCloseActiveAssignmentsForRun`, webhook `run.done{}`, domain `run.done{runId, taskId, flowId, runKind}` with `parentRunId`. **No `tasks` write** — the board derives the Done column from the run (`queries/board.ts:302`); only `auto_launch_run_plan` flips `launch_mode='auto'` tasks to Done on `run.done` (`auto-launch.ts:275-285`). `workspaces.promotion_state` defaults `'none'` (values `none|claiming|done|reopened`). GC collects `DISPOSABLE_WORKSPACE_RUN_STATUSES` (`Done|Abandoned`) at `scheduled_removal_at ?? ended_at + gcAgeDays` (`gc/workspace-gc.ts:188-280`). No UI reader branches on `promotedHeadSha`.
- **F8 — Empty-diff primitives exist**: `diffNameStatus({worktreePath, baseRef, branch})` (committed changes `base..branch`, `worktree.ts:2359`) and `diffWorkingTree(worktreePath, "HEAD")` (uncommitted incl. intent-to-add, `:2141`); `workspaces.base_commit` (nullable) is the branch point.
- **F9 — Wake path.** `orchestrator_resume` (`orchestrator-resume.ts:120`, `startFrom:"now"`) on `RUN_SETTLED_EVENT_KINDS` = `run.done | run.failed | run.crashed | run.abandoned | run.review` routed by `payload.parentRunId`; failure kinds wake unconditionally, success-side kinds at `pendingChildCount === 0`; single-winner CAS `WaitingOnChildren → Running` + `session/resume`. `run.review` carries a required `cause`. Domain events have no AsyncAPI file.
- **F10 — `ralphLoopConsumer`** (`ralph-loop.ts:55-125`) relaunches a task-backed **flow** run on `run.failed` when the policy says `ralph_loop` and it is the task's latest run — **it does not check `parent_run_id`**, so a delegated flow child would be relaunched lineage-less (the evaluations.md "known lineage gap" class). Agent children are excluded (`runKind !== "flow"`).
- **F11 — Bounds today.** `admitDelegatedChild` (`admission.ts:113`): `pg_advisory_xact_lock(0x646c6774, hashtext(parentRunId))`, depth walk (parent = 0, cap 64), live children `NOT IN TERMINAL` across kinds, env only (`orchestratorMaxDepth()` 3, `orchestratorMaxFanout()` 16); decisive inside both launchers' run-insert tx (`services/runs.ts:1591`). Scheduler writer-gate precedent `sharedWriterSiblingActive` (`scheduler.ts:175`, `Running|NeedsInput|HumanWorking`; `promoteNextPending` `continue`s `:702-713`).
- **F12 — Tree budgets today** (`ExecutionPolicy.budget.tree`: `maxTokens/hardMaxTokens/consecutiveFailures/wallClockMinutes/warnAtPct`, `execution-policy.ts:295-330`) are metered ONLY at the root by the keep-alive sweeper; a tree escalate is force-promoted to terminate-cascade. `queryRunTreeTokens(rootRunId)` is a flat `SUM` by `root_run_id` (`cost-rollups.ts:543`); `getRunCostSummary` and the cost panel are per-run; `/api/runs/{runId}/cost-summary` IS documented in `docs/api/web.openapi.yaml:5906`.
- **F13 — Token & bound run.** `issueOrchestratorRunToken` at ONE site (`runner-graph.ts:3133`, on every start AND wake); `resolveActiveBoundRun` (`lib/runs/bound-run.ts:40`) refuses terminal/cross-project with `PRECONDITION` 409 on every run-bound route. The route does not resolve the active node; the resume consumer does.
- **F14 — `run_collect` today** (`collect/route.ts`): `{childRunId?, all?}`; `parent_run_id = bound AND project_id = token`; bare array of `{childRunId, status, outputText?, artifacts{id,kind,name}[], diffRef?}`; `"unknown"` status fallback for a missing row; OpenAPI says mismatch → 404 while the code returns 409 (drift).
- **F15 — Fixtures & Lab.** e2e manifests inline in `web/e2e/_seed/seed-e2e.ts`; `test-supervisor.ts` simulates every session in-process and emits only `session.exited` for children; `maister-plugins` has ZERO orchestrator nodes across 29 manifests. Lab seams: `OBJECTIVE_CHECK_PROVIDERS` (`evaluations/method-schema.ts`) → `ObjectiveFactSource` + `evaluateObjectiveCheck` (`objective/providers.ts`) → `runObjectiveChecks` (`objective/execute.ts`) → `listStudyExecutions` / `study-lab.tsx`; `METRICS_FORMULA_VERSION`.
- **F16 — Numbers.** Engine `3.6.0` (`engine-version.ts:83`; pinned by `config-schema-artifacts.test.ts:10`); floors are flat consts (`config.ts:498-566`) + `OUTPUT_COORDINATOR_ENGINE_MIN` (`config.schema.ts:1312`); the `reentry` gate (`config.ts:1043,1271-1301`) is the manifest-key template. `main` journal max `idx 127` with snapshot; Stage A's branch carries `0128_execution_hosts` + `### ADR-164`.

---

## Decisions (D1–D18)

| # | Decision | Rationale |
| --- | --- | --- |
| **D1** | **New table `run_results`** (one row per result REVISION, incl. `invalid` rows) + three nullable jsonb columns `runs.result_contract`, `runs.delegation_bounds`, `flow_revisions.result_profiles`. Migration `0129`, additive, no backfill; NULL = "no contract / pre-feature". | A revision has its own lifecycle and N per run (DB rule for a new table); plane separation (ADR-162 D7) forbids the artifact plane; `node_attempts.vars` is a merged bag (F4) and graph-only (F5). |
| **D2** | **Wire envelope `{schemaRef, value}`; `schemaRef = "<flowRefId>@<resolvedRevision[:12]>:<schemaStem>"`.** Engine-owned row fields per Appendix A; completion timestamp = `runs.ended_at` (joined, never duplicated). | Deterministic from server state; matches the brief's `package@revision:name`. |
| **D3** | **Flow export = top-level `result.export { schema, from[], required?=true }`**; load-time: every `from[]` node exists, is not `human|form`, declares `output.result` with the SAME normalized `schema` path, and its `required` is forced `true` when the export is required; runtime "latest valid publish wins". | Brief §2 "every permitted producer must satisfy the export schema", enforced where declared (ADR-162 pattern). |
| **D4** | **Agent profiles = package-level `result_profiles` in `maister-package.yaml`**, resolved at INSTALL into `flow_revisions.result_profiles` for every member flow; at delegation `body.resultProfile` resolves against the PARENT run's pinned revision (`runs.flow_revision_id`); allowed profiles = that map's keys. | Profile by NAME, server-resolved, pinned (brief §2/§5); `schemas/` is already package-root shared (F1). |
| **D5** | **Bounds live for `engine_min ≥ 3.7.0` only (Q1-A).** `settings.delegation` gains `max_active_children?` and a REQUIRED complete `budget {max_tokens, wall_clock_minutes, max_child_runs, consecutive_failures}` for orchestrator nodes in ≥ 3.7.0 manifests. Effective at node start: depth `min(MAISTER_ORCHESTRATOR_MAX_DEPTH, max_depth ?? 2)`, fan-out `min(MAISTER_MAX_ORCHESTRATOR_FANOUT, max_fanout ?? 6)` (Q3), active `min(pool cap, max_active_children ?? 3)`. Pre-3.7.0 manifests: env-only, byte-identical. | Floor-gating = ADR-162 precedent; no existing manifest changes behaviour; "author intent" holds because the node default (2) is below the env ceiling (3). No new env var (D13). |
| **D6** | **Bounds snapshotted on the ORCHESTRATOR run** (`runs.delegation_bounds`) at the token-issuance site, keyed by `nodeAttemptId` (rewritten only when the active node ATTEMPT changes). Admission reads the parent's and the ancestors' snapshots; NULL ⇒ env-only. | Brief §5 (active node from server state) + §7 (record effective bounds for audit/recovery). |
| **D7** | **Active-children concurrency is a QUEUE, not a refusal**: a child whose parent already has `maxActiveChildren` siblings in `SLOT_HOLDING_RUN_STATUSES` stays `Pending`; `tryStartRun` / `promoteNextPending` skip it like `sharedWriterSiblingActive`. `run_delegate` returns `status` additively. | Cap semantics = queue + position (CLAUDE.md §4); one scheduler idiom. |
| **D8** | **Budgets (Q6-C): `max_child_runs` binds at EVERY level** — admission walks the ancestor chain and refuses when any ancestor's subtree (all statuses, recursive CTE) `+ incoming` exceeds that ancestor's `max_child_runs`; **token / wall-clock / failure budgets bind at the ROOT** (min-merged into the existing sweeper meters) and are recorded-only on nested orchestrators (documented: "count budgets bind at every level; spend/time/failure budgets bind at the tree root; a flow launched as a child obeys the root's"). | Count is what prevents depth × fan-out blow-up; the sweeper already meters the root; subtree spend meters are Phase 2. |
| **D9** | **Publish points and atomicity.** Flow producer: the seam's success arm returns `value`; ONE helper `closeSucceededAttemptWithResult` wraps `markNodeSucceeded` + `run_results` INSERT + supersede in ONE tx at all three call sites. Agent: `finalizeAgentRun` parses/validates/inserts/flips/emits in its EXISTING tx. Flow terminal: the completeness gate and result-only completion run inside the EXISTING terminal tx. `first_collected_at` is set in the collect route in a tx before the response (idempotent). | REQ-15: every result write shares the transaction of the state it describes (F6). |
| **D10** | **Missing / invalid semantics (Q4-A).** `required` excuses ABSENCE only. Agent child + required profile: absent → `invalid` row (`invalid_reason:"result_missing"`, no value) + run `Failed` + `run.failed{reason:"result_missing"}`; present-but-invalid → `invalid` row (class reason) + `Failed{reason:"result_invalid"}`; optional absent → settle normally (`absent`). Flow: producer-node failures keep ADR-162 semantics (`on_mismatch` rework or Failed); at `graph_completed` a required export with no `valid` row whose producer attempt is the node's latest `Succeeded` attempt → `invalid` row (`result_missing`) + `Failed{reason:"result_missing"}` instead of Review/Done. Human-resolved Review flips (`operator_stop`, `rework_released`, `sync_returned`) never fail the run; `run_collect` reports `missing|stale|invalid` honestly. Failure-terminal children report `unavailable` + `resultFailure` from the newest `invalid` row. | Consistent with the node seam; fail-closed for auto-promotion; the parent wakes on `run.failed` and re-delegates within budget or escalates; `resultFailure` always has ONE durable source (the invalid row). |
| **D11** | **Supersession + staleness.** Publish supersedes every prior `valid|stale` row; `markDownstreamStale` marks the run's `valid` row `stale` when its producer node is among the staled nodes; at most ONE `valid` row per run (partial unique index). | Brief §2; mirrors the artifact FSM without joining the evidence plane. |
| **D12** | **`run_collect` v2 is additive on the same route** (Appendix B): `settled`, `resultStatus`, `result`, `resultRevision`, `resultFailure`, artifact items `+nodeId +validity`; `outputText` deprecated + deterministic (`ORDER BY created_at DESC LIMIT 1`); `"unknown"` fallback removed (missing row = mismatch → 409); OpenAPI 404-vs-409 drift fixed to the code. | Brief §4; every existing caller keeps working on the fields it reads. |
| **D13** | **No new env var, no compose / Dockerfile change.** Description text only in `docs/configuration.md` + `.env.example` comments. | Deployment rule: nothing new to wire. |
| **D14** | **Numbering (Q8-A): ADR-165, migration 0129, engine 3.7.0**; renumber pass T11.4 (take 164/0128 only if the owner drops the Stage A branch). | Single-source allocation; Stage A's numbers are committed on its branch. |
| **D15** | **Hidden subagents structurally excluded in the reference workflow**: orchestrator node `enforcement.tools: strict` + a `tools` allow-list omitting the adapter's subagent tool (`Task`/`Agent` on claude; codex has none), enforced by `capability_guard` (ADR-130); delegation only through `run_delegate`/`run_plan`. | Brief: "adapter-internal hidden subagents do not satisfy this contract". |
| **D16** | **Reference RAH graph (one flow run, one worktree)**: `orchestrate (orchestrator; researchers = read-only agent children at depth 1 or `rah-research` flow children at depth 2; completing turn publishes the REDUCED result incl. `consumedChildRunIds`) → writer (ai_coding, consumes {{ steps.orchestrate.vars.plan }}) → verify (judge on an independent runner, blocking `ai_judgment` gate) → review (human) → done`, `orchestrate.output.result.on_mismatch: retry` bounded by `rework.maxLoops`, `decide` on `outcome` (`blocked → escalate` human), readiness + `promoteRun` unchanged. **Research flow children carry `result.export` and finalize `Done` by result-only completion (D17)** — the coordinator only collects; W12 no longer applies to result-bearing research flows. | Brief §6; ONE writer by construction; no shared-workspace child writers. |
| **D17** | **Result-only completion (Q5-C).** In `runGraph`'s success branch, when `runs.result_contract.kind === "flow_export"`, a `valid` current result exists, AND the workspace is clean (`diffNameStatus(base_commit..branch)` empty AND `diffWorkingTree(HEAD)` empty; `base_commit` NULL ⇒ not clean), the run flips `Running → Done` in the terminal tx: `runs{status:"Done", endedAt, currentStepId:null, diffStat:{files:0,additions:0,deletions:0}}` (`promotedHeadSha`/`mergeCommitSha` NULL), `workspaces{scheduledRemovalAt = now + gcAgeDays}` (`promotion_state` stays `none`), `systemCloseActiveAssignmentsForRun`, webhook `run.done{}` + domain `run.done{…, completion:"result_only", resultStatus:"valid", parentRunId}`; NO `run.review`; `deliverRunIfAutoReady` skipped; mounts released; token revoked; `promoteNextPending` via the existing exit. Otherwise (a diff, a dirty tree, an optional-absent result, or no export) the branch behaves byte-identically to today. `assertEvidenceReady(runId,"review")` still gates it (it runs before the branch). `promotion_hold` is not consulted: nothing is promoted, no git side effect, the hold column is untouched. | A research flow has nothing to promote; parity with a `workspace: none` agent child reaching `Done`; removes the coordinator-discipline residual for research flows; keeps Review meaning "a diff awaits". |
| **D18** | **`ralph_loop` never relaunches a delegated child** (`parent_run_id IS NOT NULL` skipped, logged). | F10: a lineage-less relaunch is an orphan the parent never collects; the orchestrator owns retries of its children (brief §6 "route child failures through bounded rework or human escalation" at the parent). Recorded as an ADR-165 consequence + `domain-events.md` consumer row. |

---

## Phase 0 analytics specification — content contract

### A. Entities (`docs/system-analytics/run-results.md` §Domain entities · `docs/db/runs-domain.md` · `docs/database-schema.md`)

- **Run result contract** — `runs.result_contract` (jsonb, NULL = none), Appendix A `RunResultContract`. Written by the launcher in the run-insert tx (flow: from the pinned revision's `result.export`; agent: from the parent's `flow_revisions.result_profiles`). Terminal and collection paths read only this snapshot.
- **Run result** — `run_results` (Appendix A `RunResultRow`); `validity ∈ {valid, stale, superseded, invalid}`; `CHECK ((validity='invalid') = (value IS NULL))`; `UNIQUE(run_id, revision)`; partial unique `(run_id) WHERE validity='valid'`; `artifact_manifest` = engine manifest AT PUBLISH (audit; `run_collect.artifacts` is the LIVE engine manifest).
- **Delegation bounds** — `runs.delegation_bounds` (jsonb, NULL = env-only), Appendix A `DelegationBounds`.
- **Result profiles** — `flow_revisions.result_profiles` (jsonb, NULL = none), Appendix A `ResultProfileMap`.

### B. Validity FSM + `resultStatus` derivation (`run-results.md` §State machine)

```
[*] → valid        publish (seam success / agent finalize); supersedes prior valid|stale
valid → stale      markDownstreamStale touches the producer node (rework / operator restart)
valid → superseded a newer publish for the run
stale → superseded a newer publish for the run
[*] → invalid      a publish attempt failed (reason recorded, no value) — incl. result_missing; terminal
```

ONE predicate `deriveResultStatus({runStatus, contract, newestRow, validRow})` (`lib/run-results/status.ts`), consumed by the collect route, the run DTO, and the Lab:

| Run status | Rows / contract | `resultStatus` |
| --- | --- | --- |
| `Pending|Running|NeedsInput|NeedsInputIdle|HumanWorking|WaitingOnChildren` | any | `pending` |
| `Review|Done` | a `valid` row | `valid` |
| `Review|Done` | no row; contract NULL or `required:false` | `absent` |
| `Review|Done` | no `valid` row; contract `required:true` (human-resolved Review only) | `missing` |
| `Review|Done` | newest row `stale` | `stale` |
| `Review|Done` | newest row `invalid` | `invalid` |
| `Failed|Crashed|Abandoned` | any | `unavailable` (+ `resultFailure` from the newest `invalid` row, else null) |

### C. Refusal / precondition table (allow-lists, stated as code will gate)

| # | Condition | Where | Code / HTTP | Rows |
| --- | --- | --- | --- | --- |
| R1 | `resultProfile` on a FLOW target | `refuseUnsupportedDelegationOption` (route, pre-lookup) | `CONFIG` 422 | none |
| R2 | `resultProfile` with `persistent: true` | route refinement (allow-list: `resultProfile` iff agent ∧ ¬persistent) | `CONFIG` 422 | none |
| R3 | `resultProfile` not a key of the parent's pinned `flow_revisions.result_profiles` | `resolveResultProfile` | `CONFIG` 422 | none |
| R4 | `resultProfile` while the parent flow's `engine_min < 3.7.0` | same (explicit guard) | `CONFIG` 422 | none |
| R5 | effective depth reached (`depth ≥ min(env, root.maxDepth, parent.maxDepth)`) | `admitDelegatedChild` (lock) | `CONFIG` 422 | none |
| R6 | effective fan-out reached (`live + incoming > min(env, parent.maxFanout)`) | same | `CONFIG` 422 | none |
| R7 | any ancestor's child-count budget exhausted (`subtree(ancestor) + incoming > ancestor.budget.maxChildRuns`) | same (recursive CTE per ancestor) | `CONFIG` 422 | none |
| R8 | load: `result.export.from[]` names an unknown node / a `human|form` node / a node without `output.result` / a node whose `output.result.schema` ≠ export `schema` | `validateGraphManifest` | `CONFIG` at load | — |
| R9 | load: `result.export` / `max_active_children` / `budget` below `engine_min 3.7.0` | `validateGraphManifest` | `CONFIG` at load | — |
| R10 | load: orchestrator node in a ≥ 3.7.0 manifest without a complete `delegation.budget` | `validateGraphManifest` | `CONFIG` at load | — |
| R11 | install: `result_profiles.<name>.schema` not a package-root `./schemas/*.json`, unreadable, malformed, or using `json|items` below a member flow's floor | `validatePackageRootSchemaReferences` | `FLOW_INSTALL` | revision `Failed` |
| R12 | launch (flow): export schema unresolvable from the pinned `installedPath` | `launchRunStaged` pre-worktree | `CONFIG` 422 | none (delegation path: carrier compensated as today) |
| R13 | agent child completes, required profile, sentinel absent | `finalizeAgentRun` | `invalid` row (`result_missing`) + `Failed`, `run.failed{reason}` | one tx |
| R14 | agent child completes, sentinel oversize / malformed / structurally unsafe / schema mismatch | `finalizeAgentRun` | `invalid` row (class) + `Failed{result_invalid}` | one tx |
| R15 | flow `graph_completed`, required export, no current `valid` row | `runGraph` terminal branch | `invalid` row (`result_missing`) + `Failed{result_missing}` | one tx |
| R16 | `run_collect` for a run that is not a DIRECT child of the bound orchestrator | route | `PRECONDITION` 409 | none |
| R17 | `run_collect` / `run_delegate` / `run_plan` from a token whose orchestrator is terminal | `resolveActiveBoundRun` | `PRECONDITION` 409 | none |
| R18 | child queued by the active-children cap | scheduler | not a refusal — `Pending`; `run_delegate` returns `status:"Pending"` | run row exists |
| R19 | `run.failed` for a run with `parent_run_id` under a `ralph_loop` policy | `ralphLoopConsumer` | skipped (logged), never relaunched | none |

### D. Crash-window matrix (REQ-15)

| # | Window | Reachable state | Recovery | AC |
| --- | --- | --- | --- | --- |
| W1 | Flow producer close: `markNodeSucceeded` + result INSERT + supersede | one tx — none | — | AC-13 (rollback proof) |
| W2 | Flow terminal: completeness gate / result-only Done / Review flip + emit | one tx (existing terminal tx) — none | — | AC-15, AC-16 |
| W3 | Agent finalize: parse + validate + INSERT + CAS + emit | one tx — none | — | AC-23 |
| W4 | Death after `session.exited` is observed, before the finalize tx (buffer in-process) | run `Running`, no live session | existing reconcile → `Crashed` → `run.crashed{parentRunId}` wakes the parent; NO result (documented) | AC-24 |
| W5 | Bounds snapshot written, death before `createSession` | node attempt fails via existing paths; snapshot retained (attempt-keyed, idempotent) | next attempt rewrites | AC-26 |
| W6 | `first_collected_at` tx commits, death before the HTTP response | marker set, caller never saw the body | caller retries (idempotent read) | AC-32 |
| W7 | Install: revision row written without `result_profiles` | impossible — same statement | — | AC-02 |
| W8 | Launch: `result_contract` snapshot | run-insert tx | — | AC-11, AC-19 |
| W9 | Child queued by the active cap; nothing re-promotes | cannot occur — every settle path calls `promoteNextPending` (`promoteAfterExit`, finalize, park) | pinned | AC-29 |
| W10 | Result-only completion: the clean check is a READ before the tx; no session is live at the terminal branch; Done + `scheduled_removal_at` + emits in ONE tx | none | — | AC-16 |

### E. API shapes — see Appendix B (normative fragments).

### F. Wake events (verbatim in `run-results.md` + `orchestrator.md`)

A parent in `WaitingOnChildren` is woken by `orchestrator_resume` on exactly these `domain_events` kinds routed by `payload.parentRunId`: `run.review` (cause-tagged), `run.done` (incl. `completion:"result_only"`), `run.failed`, `run.crashed`, `run.abandoned`. **Invariant:** the child's `run_results` row (valid or invalid) is committed in the SAME transaction as the settle flip that emits the event, so a woken parent's `run_collect` never observes a half-published result. Payload widening (Q10-A, additive, no kind/CHECK change): `run.review|run.done|run.failed` gain `resultStatus`; `run.done` gains `completion ∈ {promoted, result_only}`; `run.failed.reason` gains `result_missing | result_invalid`.

### G. Trust boundaries — identifier labelling (delta over ADR-163)

| Route | Identifier | Label | Handling |
| --- | --- | --- | --- |
| delegate / plan | `resultProfile` | **body-controlled** (a NAME, `/^[A-Za-z0-9._-]{1,64}$/`) | allow-list lookup in the PARENT run's pinned `flow_revisions.result_profiles`; never a path or schema; `CONFIG` on miss |
| delegate / plan | parent `flow_revision_id`, allowed profile set, root run, depth, active node, bounds | **server-state** | `resolveActiveBoundRun` → `runs` → `flow_revisions`; `delegation_bounds` written by the runner |
| delegate / plan / auto-launch | child `result_contract` | **server-state** | built by the launcher from the resolved profile / export |
| collect | `projectId`, parent `runId` | **auth-context** | token binding (unchanged) |
| collect | `childRunId` | **body-controlled** | verified `parent_run_id = bound AND project_id = token`; mismatch/missing → 409 (existence-hidden) |

No filesystem path component anywhere; artifact metadata is engine-derived from `artifact_instances`, never from the payload.

---

## Persistence — migration `0129_run_results` (authoritative SQL) + the fourth leg

```sql
CREATE TABLE "run_results" (
  "id" text PRIMARY KEY,
  "run_id" text NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "validity" text NOT NULL,
  "schema_ref" text NOT NULL,
  "schema_sha256" text NOT NULL,
  "schema_version" integer NOT NULL,
  "producer_kind" text NOT NULL,
  "producer_ref" text NOT NULL,
  "node_attempt_id" text REFERENCES "node_attempts"("id") ON DELETE SET NULL,
  "value" jsonb,
  "value_bytes" integer NOT NULL,
  "invalid_reason" text,
  "artifact_manifest" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "engine_version" text NOT NULL,
  "superseded_by_id" text REFERENCES "run_results"("id") ON DELETE SET NULL,
  "superseded_at" timestamp with time zone,
  "first_collected_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "run_results_validity_check" CHECK ("validity" IN ('valid','stale','superseded','invalid')),
  CONSTRAINT "run_results_producer_kind_check" CHECK ("producer_kind" IN ('flow_node','agent_session')),
  CONSTRAINT "run_results_value_shape_check" CHECK (("validity" = 'invalid') = ("value" IS NULL)),
  CONSTRAINT "run_results_invalid_reason_check" CHECK (("validity" = 'invalid') = ("invalid_reason" IS NOT NULL)),
  CONSTRAINT "run_results_run_revision_uq" UNIQUE ("run_id", "revision")
);
CREATE UNIQUE INDEX "run_results_one_valid_per_run_uq" ON "run_results" ("run_id") WHERE "validity" = 'valid';
CREATE INDEX "run_results_run_idx" ON "run_results" ("run_id");
ALTER TABLE "runs" ADD COLUMN "result_contract" jsonb;
ALTER TABLE "runs" ADD COLUMN "delegation_bounds" jsonb;
ALTER TABLE "flow_revisions" ADD COLUMN "result_profiles" jsonb;
```

- **Quadruple:** SQL + `_journal.json` (`idx 129`, monotonic `when`) + `meta/0129_snapshot.json` + `web/lib/db/schema.ts` (`runResults` with `$type<>`s and the same CHECKs, the three columns) — a CHECK the schema never learned makes `drizzle-kit generate` propose reverting it (patch 2026-09-01-05.40). Gates: `db:generate` proposes nothing; newest journal entry has a snapshot; testcontainers bootstrap applies 0129.
- **Live-data rule:** additive, nullable, no backfill; no DROP, no re-key.
- **Docs (both surfaces + regen):** `docs/database-schema.md` (`## run_results`, three column notes, `## Tables` row) AND `docs/db/runs-domain.md` `erDiagram` (`RUN_RESULTS`, `runs ||--o{ run_results`, self-ref) + `pnpm --filter maister-web db:erd`.
- **API exposure sweep:** `run_results` is read by exactly three modules (`lib/run-results/*`, the collect assembly, the run DTO); recorded in T3.3.

## Deployment impact analysis

| Item | Impact |
| --- | --- |
| Migration `0129` | Additive. Owner runs `pnpm --filter maister-web db:migrate` after merge (0127, and 0128 if Stage A lands first, precede it). Old rows read NULL. |
| Engine `3.6.0 → 3.7.0` | Existing manifests unchanged; new keys refused below the floor; `config-schema-artifacts.test.ts:10` pin updated; root `CLAUDE.md` §6 engine number + one public-result sentence. |
| MCP facade | `pnpm --filter @maister/mcp build` after `tools.ts` edits (facade runs `mcp/dist`). |
| Env / compose / Dockerfile / `.env.example` | **No new variable, no wiring** (D13); description text only. |
| e2e | New spec in `AUTHED_SPEC` (`web/playwright.config.ts`); `test-supervisor.ts` gains sentinel emission (additive). |
| Behaviour changes to shipped paths | (a) `run_collect` gains fields; `outputText` deterministic; missing-row `"unknown"` → 409. (b) `run_delegate` response gains `status`. (c) `run_plan` batch pre-check uses the effective fan-out (≥ 3.7.0 parents only). (d) `Running → Done` is a new flow-run edge, reachable ONLY for flows declaring `result.export` (none exist today). (e) `ralph_loop` skips delegated children (D18 — a delegated flow child under a ralph policy was previously relaunched lineage-less). (f) OpenAPI collect mismatch 404 → 409 (code unchanged). Shipped processes ship no `orchestrator` node and no `result.export`; blast radius nil, recorded in ADR-165. |
| `maister-plugins` | `packages/rah` authored in the sibling checkout after Phase 7, committed + tagged `rah/v1.0.0` after this repo merges (Q9-B; push via the one-off HTTPS URL). |

## API compatibility strategy

1. Every existing `run_delegate` / `run_plan` / `run_collect` payload is accepted unchanged; regression fences: ADR-163's `delegate-agent-compat.integration.test.ts`, `plan.integration.test.ts`, `admission.integration.test.ts` stay green untouched.
2. `run_collect` v2 additive; `outputText` `deprecated: true` in OpenAPI + MCP with the replacement named.
3. New refusals fire only when a new option / a ≥ 3.7.0 key is used; existing codes only (`CONFIG` 422, `PRECONDITION` 409, `FLOW_INSTALL`) — `docs/error-taxonomy.md` gains reason rows, no new code.
4. Domain-event payload widening is additive jsonb; consumer sweep recorded (T4.6).
5. Bounds semantics change only behind `engine_min ≥ 3.7.0` (D5).
6. `docs/api/web.openapi.yaml` `getRunCostSummary` gains an optional `tree` object (additive); `info.version` bumps on both OpenAPI files.

---

## Acceptance criteria (Given / When / Then → ONE enforcing test)

Grammar, install, floors (Phase 2)
- **AC-01** Given `maister-package.yaml` with `result_profiles: {research: {schema: ./schemas/research-result.v1.json}}`: parses; an entry with an unknown key, a non-root path, or a name outside `/^[A-Za-z0-9._-]{1,64}$/` → parse error. → `web/lib/__tests__/config.schema.test.ts`
- **AC-02** Given a package install: `flow_revisions.result_profiles` is written for EVERY member flow as `{schemaPath, schemaStem, schemaVersion, sha256, schema}` in the same revision write; a profile referencing a missing / malformed / escaping file, or `json|items` below a member flow's floor → `FLOW_INSTALL`, revision `Failed`, no partial map. → `web/lib/__tests__/flows.integration.test.ts`
- **AC-03** Given `result.export`: parses with `required` defaulting `true`; each R8 rule refuses `CONFIG` naming the node and the reason; `from[]` nodes with `output.result.required:false` are forced required when the export is required (the loaded manifest reflects it). → `web/lib/__tests__/config-artifacts.test.ts`
- **AC-04** Given `result.export`, `delegation.max_active_children`, or `delegation.budget` with `engine_min < 3.7.0` → `CONFIG` naming the floor; the identical manifest at `3.7.0` loads. → `config-artifacts.test.ts`
- **AC-05** Given an orchestrator node in a ≥ 3.7.0 manifest without a complete `budget` (any of the four keys missing) → `CONFIG` naming the node and the missing key; complete → loads; a pre-3.7.0 orchestrator manifest without `budget` still loads. → `config-artifacts.test.ts`
- **AC-06** `MAISTER_ENGINE_VERSION === "3.7.0"`; the grammar string contains `result.export`, `result_profiles`, `max_active_children`, `max_child_runs`, `3.7.0`, `resultProfile`, `run_collect`; the Studio assistant prompt still contains the grammar. → `config-schema-artifacts.test.ts`, `flow-dsl-grammar.test.ts`, `flow-assistant/__tests__/context.test.ts`

Persistence (Phase 3)
- **AC-07** Journal max+1 = 0129 with a matching snapshot; `db:generate` proposes nothing after `schema.ts`; a fresh testcontainer bootstrap applies 0129 and both CHECKs hold. → Phase-3 gate commands (recorded in the commit body)
- **AC-08** Given `publishRunResult` twice: revision 1 `superseded` with `superseded_by_id` = revision 2, `superseded_at` set; `markRunResultStale` flips only the `valid` row of a named producer; a stale row is superseded by the next publish; a second `valid` INSERT bypassing the helper violates `run_results_one_valid_per_run_uq`; `recordInvalidRunResult` stores no value and a reason (both CHECKs); `markRunResultCollected` twice → `first_collected_at` unchanged. → `web/lib/run-results/__tests__/ledger.integration.test.ts`
- **AC-09** `deriveResultStatus` returns exactly the §B table (all 7 outcomes, incl. NULL contract on a scratch/manual run → `absent`). → `web/lib/run-results/__tests__/status.test.ts` (pure, table-driven)
- **AC-10** `schemaRefFor({flowRefId:"core-rah", resolvedRevision:"1a2b3c4d5e6f7890", schemaStem:"research-result.v1"}) === "core-rah@1a2b3c4d5e6f:research-result.v1"`. → `web/lib/run-results/__tests__/contract.test.ts`

Flow results (Phase 4)
- **AC-11** Given a pinned revision with `result.export`: `launchRunStaged` writes `runs.result_contract{kind:"flow_export", schemaRef, sha256 of the doc bytes, schemaVersion, required, producerNodeIds, schema, flowRevisionId}` in the run-insert tx; an unresolvable export schema refuses `CONFIG` BEFORE the worktree with zero `runs`/`workspaces` rows; through `run_delegate` the carrier task is abandoned (existing compensation). → `web/lib/services/__tests__/launch-run-result-contract.integration.test.ts`
- **AC-12** After launch, repointing `flows.enabled_revision_id` to a revision with a different schema changes neither the snapshot nor which schema the seam validates against. → same file
- **AC-13** Given a producer node succeeding through the real seam: one `valid` row whose `value` deep-equals the payload including undeclared nested keys, `node_attempts.vars` still merged as before, `output_contract` unchanged, `artifact_manifest` = current artifacts at publish; a forced INSERT failure leaves the attempt un-closed (W1). → `web/lib/flows/graph/__tests__/run-result-flow.integration.test.ts`
- **AC-14** Rework re-running the producer → revision 2 `valid`, revision 1 `superseded`; a rework staling the producer without a re-run → `stale`; two producers on alternative branches → only the executed one publishes; a `judge` and a `cli` producer arm each publish (transport-agnostic). → same file
- **AC-15** Given `graph_completed` with a required export and no current `valid` row: `invalid` row (`result_missing`) + run `Failed` + `run.failed{reason:"result_missing", resultStatus:"missing", parentRunId}` in one tx, and `orchestrator_resume` wakes the parent; a missing OPTIONAL result → Review `absent`. → `web/lib/flows/graph/__tests__/run-result-flow-terminal.integration.test.ts`
- **AC-16** Result-only completion, table-driven: (valid, clean) → `Done` in one tx with `endedAt`, `diffStat` zeros, `promotedHeadSha`/`mergeCommitSha` NULL, `workspaces.promotionState='none'`, `scheduledRemovalAt` = now + gcAgeDays, assignments closed, webhook `run.done` + domain `run.done{completion:"result_only", resultStatus:"valid", parentRunId}`, NO `run.review`, mounts released, `promoteNextPending` invoked; (valid, committed diff) → Review; (valid, dirty working tree only) → Review; (valid, `base_commit` NULL) → Review; (optional absent, clean) → Review; (no export, clean) → Review byte-identical. → same file
- **AC-17** Operator stop mid-graph on a required-export run → Review, run NOT failed, `run.review{cause:"operator_stop", resultStatus:"missing"|"stale"}`; a rework-claim release after the producer was staled → `stale`. → same file
- **AC-18** Consumer sweep: `orchestrator_resume` wakes on `run.failed{reason:"result_missing"}` with a pending sibling (unconditional arm); `auto_launch_run_plan` flips an as-plan task Done and releases a `requires` dependent on a result-only `run.done`; `ralphLoopConsumer` skips a failed run with `parent_run_id` (no relaunch) and still relaunches a parentless one (positive arm). → `web/lib/domain-events/__tests__/run-result-consumers.integration.test.ts`

Agent results (Phase 5)
- **AC-19** R1–R4, table-driven, for `run_delegate` AND `run_plan`: code + HTTP + zero rows in `tasks`/`runs`/`run_results`; positive arm: agent target + known profile → `202`, `runs.result_contract{kind:"agent_profile", profileName, schemaRef (parent's flowRefId@rev12:stem), sha256}`, `run_plan` task carries `delegation_spec.resultProfile`. → `web/app/api/v1/ext/runs/__tests__/delegate-result-profile.integration.test.ts`
- **AC-20** The as-plan auto-launcher's candidate launch snapshots the same contract from the task's `delegation_spec` (third edge); a profile removed from a NEWER package revision still resolves (pinned). → `web/lib/domain-events/__tests__/auto-launch-result-profile.integration.test.ts`
- **AC-21** `lib/run-results/resolve-profile.ts` imports no launcher module (`services/runs`, `agents/launch`, `flows/runner`). → `web/lib/run-results/__tests__/resolve-profile-isolation.test.ts`
- **AC-22** `appendCapped` keeps the first `STDOUT_CAP_BYTES` and marks truncation; `extractSentinelBlock` on multi-block text takes the LAST properly fenced block; the consumer resets the buffer at each prompt turn. → `web/lib/flows/__tests__/capped-text.test.ts` (pure) + the turn-reset case in AC-23's file
- **AC-23** Driving the real `consumeAgentSession` with a scripted stream: valid sentinel → `valid` row + `Review`/`Done` per existing rules + `run.review{cause:"agent_exit", resultStatus:"valid"}`/`run.done`; absent+required → `invalid` row (`result_missing`) + `Failed{result_missing}` + unconditional parent wake; each invalid class (schema mismatch / unsafe key / depth / oversize / malformed JSON) → `invalid` row with the class reason + `Failed{result_invalid}`; optional absent → normal; `Failed`/`Crashed` outcomes never publish; contract NULL → nothing parsed. → `web/lib/agents/__tests__/agent-run-result.integration.test.ts`
- **AC-24** W4: child `Running`, session dead, no finalize; reconcile → `Crashed` + `run.crashed{parentRunId}`; `run_results` empty; `run_collect` → `unavailable`, `resultFailure:null`. → extension of the existing reconcile integration suite (one case)

Bounds (Phase 6)
- **AC-25** `computeEffectiveDelegationBounds` table: `engineMin < 3.7.0` → env-only (`source:"env"`, `maxActiveChildren:null`, `budget:null`); ≥ 3.7.0 undeclared → 2/6/3 capped by env; declared above env → env; declared below env → declared; `budget` copied verbatim. → `web/lib/orchestrator/__tests__/bounds.test.ts` (pure)
- **AC-26** Snapshot written at node start keyed by `nodeAttemptId`; a wake (same attempt) does not rewrite; a second orchestrator node (new attempt) rewrites; W5 shape (snapshot present, session never created) is retained. → `web/lib/orchestrator/__tests__/bounds.integration.test.ts`
- **AC-27** Admission on a ≥ 3.7.0 parent: fan-out 6 refuses the 7th live child; depth 2 refuses a grandchild's delegation; a pre-3.7.0 parent keeps env semantics (the ADR-163 `admission.integration.test.ts` stays green untouched); changing env after the snapshot changes no admission outcome. → same file
- **AC-28** Child-count budget at every ancestor: root `max_child_runs: 5` with a nested orchestrator `max_child_runs: 2` — the nested one refuses its 3rd descendant while the root still admits; the root refuses the 6th descendant overall; **two-racer** at `cap-1` on a second pg connection → exactly one wins, loser `CONFIG`, zero extra rows. → same file
- **AC-29** Active cap 3: four delegations → three `Running`, the fourth `Pending` and `run_delegate` returns `status:"Pending"`; a sibling reaching `Review` (and, separately, `Done`) frees it on the next `promoteNextPending`; the pool cap still applies (a lower pool cap wins). → same file
- **AC-30** Root tree budget min-merge: node `max_tokens` below the policy's `tree.maxTokens` → the node value is the escalate limit; a nested orchestrator's `budget` is recorded but the sweeper meters only the root. → extension of the keep-alive budget integration suite (two cases)

Collect (Phase 7)
- **AC-31** Each `resultStatus` value reachable through the real seams (`pending`, `valid` agent + flow, `absent`, `missing`, `stale`, `invalid`, `unavailable` with `resultFailure`) with the v2 shape (`settled`, `result` null unless valid, `resultRevision`, artifact items `nodeId`+`validity`). → `web/app/api/v1/ext/runs/__tests__/collect-v2.integration.test.ts`
- **AC-32** Grandchild invisible with `all:true` and named → 409 (message pinned); a payload claiming a fake artifact id changes nothing in `artifacts`; two consecutive collects return byte-identical bodies and set `first_collected_at` exactly once; token of a terminal orchestrator → 409; `outputText` deterministic under two qualifying inline artifacts. → same file
- **AC-33** `TOOL_SPECS` mirrors OpenAPI for `resultProfile` (both tools) and `run_collect`'s output shape; a deliberately drifted `resultStatus` enum FAILS the guard. → `mcp/src/__tests__/tool-contract.test.ts`

Observability (Phase 8)
- **AC-34** The public-result panel renders schemaRef, validity glyph, revision, collected marker and a JSON viewer for a run with a contract; nothing renders for a run without; child rows show the result glyph per status; EN and RU strings resolve. → `web/components/runs/__tests__/run-public-result-panel.test.tsx` + `run-inspector-child-runs-list.test.tsx` (static markup)
- **AC-35** `getRunTreeCostSummary(root)` sums root + descendants (tokens by kind and model) and reports tree wall-clock; a non-root run yields no tree facts; `GET /api/runs/{id}/cost-summary` includes `tree` only for a tree root with children. → `web/lib/queries/__tests__/run-tree-cost.integration.test.ts` + the route test
- **AC-36** `grep -rn "value\|payload\|prompt" web/lib/run-results web/lib/orchestrator/bounds.ts web/lib/agents/launch.ts | grep -E "log\.(info|warn|debug|error)"` shows no interpolated value/payload/prompt (review gate, output pasted in the commit body).

Harness (Phase 9)
- **AC-37** The twelve-scenario matrix in T9.2 passes against the in-repo fixture package; a static assertion proves the fixture's orchestrator node has `enforcement.tools: strict` with no `Task`/`Agent` in `tools` and that no fixture child declares `workspace: worktree`. → `web/lib/orchestrator/__tests__/recursive-harness.integration.test.ts`
- **AC-38** The depth-2 e2e loop passes: flow research children finalize `Done` by result-only completion, the root wakes, collects two `valid` exports, publishes its own result (revision 1), the panel and tree cost facts render. → `web/e2e/recursive-harness.spec.ts`

Lab (Phase 10)
- **AC-39** Over a seeded depth-2 tree (one invalid result, one crash, one rework, two of three valid results collected, `consumedChildRunIds` naming one collected and one fabricated id): `child_run_count@1 = N`, `result_validation_failures@1 = 1`, `collected_results_ratio@1 = 2/3`, `consumed_results_ratio@1 = 1/3` (fabricated id excluded), `rework_count@1 = 1`, `crash_count@1 = 1`, `tree_tokens@1` = subtree sum, `tree_wall_clock_minutes@1`, `promotion_readiness@1` = the classifier state; each provider is non-executable (reads recorded facts only). → `web/lib/evaluations/objective/__tests__/tree-facts.integration.test.ts` + `providers.test.ts` (pure arms)

Docs (Phases 0, 11)
- **AC-40** `pnpm validate:docs` (mermaid, ADR anchors, links, indexes, `db:erd --check`) and `pnpm validate:contracts` green; `docs/system-analytics/README.md` and `docs/db/README.md` index rows present; every `(Designed)` tag flipped at T11.1 with the `| Designed |` table form swept too (patch 2026-08-06-19.10). → gate commands

---

## Commit Plan

| # | Tasks | Message |
| --- | --- | --- |
| 1 | S0.1–S0.9 | `docs(run-results): specify the governed recursive harness — ADR-165, run-results analytics, bounds, result-only completion, and the OpenAPI/MCP contracts as normative specs` |
| 2 | R1.1–R1.4 | `test(rah): RED — collect v2 contract, resultProfile refusal table, validity FSM and effective-bounds harnesses` |
| 3 | T2.1–T2.6 | `feat(flows): result_profiles, result.export and delegation bounds/budget grammar behind engine 3.7.0` |
| 4 | T3.1–T3.3 | `feat(db): run_results ledger, result_contract, delegation_bounds and result_profiles snapshots (migration 0129)` |
| 5 | T4.1–T4.7 | `feat(flows): publish flow-run public results at the seam, supersede on rework, gate completion on a required export, result-only completion to Done` |
| 6 | T5.1–T5.6 | `feat(agents): resultProfile delegation — server-resolved profiles, final maister:output publish, result-caused failures` |
| 7 | T6.1–T6.6 | `feat(orchestrator): effective bounds snapshot, per-ancestor child-count budget, per-orchestrator active-children queue` |
| 8 | T7.1–T7.4 | `feat(ext): run_collect v2 — validated public results, engine-derived artifact metadata, first-collected marker` |
| 9 | T8.1–T8.5 | `feat(runs): public-result inspector panel, child result badges, tree cost and wall-clock roll-up` |
| 10 | T9.1–T9.3 | `test(rah): in-repo reference harness fixture package, the twelve-scenario matrix, and the depth-2 e2e loop` |
| 11 | T10.1–T10.4 | `feat(evaluations): recursive-harness objective providers and the four-arm comparison protocol` |
| 12 | T11.1–T11.5 | `docs(rah): as-built flip, contract sweep, renumber pass, companion package handoff` |

No AI co-author trailer (repo convention).

---

## Tasks

> Task-tracker note: no `TaskCreate` tool is available in this session; this file is the task ledger `/aif-implement` consumes. Every implementation task is written as **RED** (AC ids, run and recorded) → **GREEN** (minimal code) → **REFACTOR** (DRY/SOLID targets) with files, logging, and the REQ it satisfies.

### Phase 0 — Specification (SDD; normative, NO code)

- [x] **S0.1 — ADR-165.** Files: `docs/decisions/adr-165.md` + stub/index row in `docs/decisions.md`. Reserve first: `git show main:docs/decisions.md | grep -oE '^### ADR-[0-9]+' | tail -1` → `ADR-163`; ADR-164 is committed on the Stage A branch → claim 165 and record the dependency. Content: D1–D18 with rationale; §Envelope; §Result by run kind (flow export / agent profile / scratch+manual optional); **§Result-only completion** (D17: the exact predicate, what is written, what is NOT — no promotion, no hold consultation, no task write, GC via `scheduled_removal_at`); §Bounds (D5–D8, floor-gated, queue-not-refuse, per-ancestor count budget, root-only spend meters, residual R-nested); §Wake invariant; §Hidden subagents; §`ralph_loop` consequence (D18); §Packaging (fixture in-repo, `maister-plugins/packages/rah` authored after Phase 7 — Q9-B); §Residuals (W12 narrowed to non-result flows; R-nested; W4 no-result-on-crash); §Alternatives (result as `artifact_instances` kind; result on `runs` columns; refuse-not-queue; bounds for all manifests; versioned `/collect/v2`; parking invalid agent results in Review — Q4-B; auto-archive — Q5-B).
  *Acceptance*: AC-40. *Satisfies*: REQ-01, REQ-02, REQ-07, REQ-09, REQ-12, REQ-15.

- [x] **S0.2 — New domain doc `docs/system-analytics/run-results.md`** (R5): Purpose · Domain entities (§A) · State machine (§B FSM) · Process flows: (a) flow-node publish at the seam, (b) agent-run publish at finalize, (c) supersession on rework, (d) terminal gate — completeness / result-only Done / Review (one flowchart with the three exits), (e) collect v2 sequence, (f) reference RAH workflow (D16) · **the `resultStatus` table (§B)** · **the refusal table (§C) in parameterized shape** · **the crash matrix (§D)** · Expectations (Appendix D — ≤ 12 bullets, each naming its AC) · Edge cases (each with a `MaisterError` code) · Linked artifacts. Every piece `(Designed)`. Index row in `docs/system-analytics/README.md`.
  *Satisfies*: REQ-01–REQ-08, REQ-13, REQ-15.

- [x] **S0.3 — Extend the sibling analytics docs** (depends on S0.2): `orchestrator.md` — **Bounds & budgets** topical section (effective formula, snapshot, active queue, per-ancestor count budget, root meters, `≥ 3.7.0` gate), option matrix + `resultProfile` row, refusal rows R1–R7 / R16–R19, **`run_collect` contract** subsection (v2, direct-children-only, idempotent, stale token), wake invariant, the D16 coordinator contract ("collect only; research flows finish by themselves"); `runs.md` — execution-axis state machine gains `Running → Done (result-only completion, ADR-165)`, a `### Result-only completion` subsection, the delegated-child subsection's result semantics per terminal path, cost section (tree roll-up); `workspaces.md` — `### Result-only completion` beside "Promote on Review" (`promotion_state` stays `none`, `scheduled_removal_at`, GC, no `run.promoted`); `flow-graph.md` — seam publish step + the terminal-exit table; `readiness.md` — chokepoint diagram gains the Done exit; `domain-events.md` — payload widening rows + consumer sweep incl. `ralph_loop` (D18); `scheduler.md` — active-children skip beside the writer gate; `execution-policy.md` — tree budget min-merge + `max_child_runs`; `reconciliation-gc.md` — one sentence (Done + `scheduled_removal_at` from result-only completion is the existing GC shape).
  *Satisfies*: REQ-02, REQ-06, REQ-07, REQ-09, REQ-10.

- [x] **S0.4 — DB doc surfaces (Designed)** (depends on S0.1): `docs/database-schema.md` (`## run_results` with the SQL, the three columns, NULL semantics, `## Tables` row) AND `docs/db/runs-domain.md` `erDiagram` + Constraints + Status enum reference (`run_results.validity`). `erd.dbml` regenerates in Phase 3.
  *Satisfies*: REQ-01, REQ-13.

- [x] **S0.5 — Flow DSL + configuration + error taxonomy (Designed)**: `docs/flow-dsl.md` — `## Flow result export (result.export) (Designed — ADR-165)` modelled on `reentry` (YAML, R8–R10, floor, result-only completion note, "the schema file is the contract"), `## Node orchestrator` `delegation` v2 (advisory sentence REPLACED), `## Package contract fields` gains `result_profiles`; `docs/configuration.md` — `maister-package.yaml` v1 `result_profiles`, env rows' descriptions; `docs/error-taxonomy.md` — reason rows.
  *Satisfies*: REQ-02, REQ-03, REQ-09.

- [x] **S0.6 — External OpenAPI (contract-first, Appendix B)** (depends on S0.2): `docs/api/external/operations.openapi.yaml` — `ExtRunDelegateBody` + `ExtRunPlanTask` `resultProfile`; delegate `202` response `status`; `ExtChildRunSummary` v2 (`resultStatus` enum of 7, `result`, `resultRevision`, `resultFailure`, artifact `nodeId`+`validity`, `outputText` deprecated); collect path description (direct-children-only, idempotent, stale token 409, mismatch 409 — drift fix); three examples; `info.version` bump. `docs/api/web.openapi.yaml` — `getRunCostSummary` optional `tree` object.
  *Acceptance*: `pnpm validate:contracts` green; every documented refusal maps to a code a route will return. *Satisfies*: REQ-06, REQ-10, REQ-14.

- [x] **S0.7 — MCP tool contract + guard** (depends on S0.6): `mcp/src/tools.ts` — `resultProfile` on both tools (agent-only note); `run_collect` description (≤ 4 sentences): *"`result.value` is the validated public result — use it, not `outputText`. `resultStatus` says why it is absent. Collect is idempotent and shows only your DIRECT children. Research flow children finish by themselves when they publish a result and change nothing; collect BEFORE `run_cancel` — a failure-terminal child reports `unavailable`."*; extend `tool-contract.test.ts` (`resultStatus` enum mirror + a deliberately-drifted negative case). Build gotcha: `pnpm --filter @maister/mcp build`.
  *Acceptance*: mcp build/typecheck/test — the new cases RED, negative case proves the guard inspects the enum. *Satisfies*: REQ-06.

- [x] **S0.8 — Spec file**: `.ai-factory/specs/feature-recursive-agent-harness.md` — clauses C-1…C-n mirroring §A–§G + Appendices A–D, each mirrored by an AC; the reference workflow; the Lab protocol; the owner decisions Q1–Q10 recorded verbatim.
- [x] **S0.9 — Screen + grammar contract notes**: `docs/screens/runs/flow-run.md` gains the public-result panel + child result glyphs + tree cost facts (surface only, behaviour linked to `run-results.md`); `docs/system-analytics/evaluations.md` gains the `### Recursive-harness comparison protocol (Designed)` section (four arms, nine measures → providers, replicate policy, human-verdict rule); grammar text planned (lands in T2.6).
  *Satisfies*: REQ-08, REQ-10, REQ-11.

**Phase 0 exit** — all nine artifacts complete and mutually consistent; ADR-165 anchor resolves; `pnpm validate:docs` AND `pnpm validate:contracts` green; unit + integration green; **enumerated integration baseline captured**.

---

### Phase 1 — RED: the specification harness

- [x] **R1.1 — RED: collect v2 (AC-31, AC-32 fences).** `collect-v2.integration.test.ts`: v2 fields (RED: absent); grandchild invisible + named → 409 with the pinned message (GREEN fence); identical bodies on repeat (RED once the marker exists — assert body equality, not "no write"); terminal-parent token → 409 (fence).
- [x] **R1.2 — RED: `resultProfile` refusal table (AC-19).** `delegate-result-profile.integration.test.ts`: R1–R4 rows × both routes + the positive arm. RED: unknown key today.
- [x] **R1.3 — RED: validity FSM + status predicate (AC-08, AC-09).** `status.test.ts` (pure table) + `ledger.integration.test.ts`. RED: modules/table absent.
- [x] **R1.4 — RED: effective bounds (AC-25).** `bounds.test.ts`. RED: module absent.

**Phase 1 exit** — four harnesses executed; RED reasons recorded; fences green.

---

### Phase 2 — Manifest grammar + floors (engine 3.7.0)

- [x] **T2.1 — `result_profiles` in the package manifest + install materialization.** RED: AC-01, AC-02. GREEN: `maisterPackageManifestSchema.result_profiles: z.record(profileNameSchema, z.object({schema: packageRootSchemaRefSchema}).strict()).optional()` (`config.schema.ts:1558`); `web/lib/packages/manifest.ts` passes it through; `web/lib/flows.ts` — `validatePackageRootSchemaReferences` + `materializeSharedPackageRootSchemas` resolve each profile (`readFormSchemaDocWithBytes` + sha256 of raw bytes via `new Uint8Array(buf)`) and write `flow_revisions.result_profiles` for EVERY member flow in the same revision write (W7); floors folded with `addSchemaReferenceFloors` (lowest member floor wins); Studio mirror in `web/lib/local-packages/validate.ts` (BLOCK finding). REFACTOR: one `resolveProfileDoc` helper shared by install and Studio validation.
  *Logging*: `[run-result.profiles] materialized {packageName, revision, profiles}` / `refused {…, reason}`.
  *Satisfies*: REQ-03. (depends on R1.2)
- [x] **T2.2 — `result.export` in `flowYamlV1Schema` + load rules.** RED: AC-03, AC-04 (export arm). GREEN: `result: z.object({export: z.object({schema, from: z.array(nodeIdSchema).min(1), required: z.boolean().default(true)}).strict()}).strict().optional()` (`config.schema.ts:1237`); `declaresResultExport(manifest)` + gate in `validateGraphManifest` (`config.ts`, the `reentry` template) implementing R8 (incl. forcing producer `required`) and the `RAH_ENGINE_MIN` floor (R9); `collectReferencedSchemaPaths` collects the export schema. Add `result` to `FLOW_YAML_KEYS` AND close the pre-existing gaps (`reentry, sessions, mcps, requirements, metadata, defaults, verdict_calibration`) — one line, recorded in the commit body.
  *Satisfies*: REQ-02.
- [x] **T2.3 — `delegation` v2.** RED: AC-04 (delegation arms), AC-05. GREEN: `orchestratorSettingsSchema.delegation` gains `max_active_children?: positive int` and `budget?: {max_tokens, wall_clock_minutes, max_child_runs, consecutive_failures}.strict()` (all four required inside the block); load gates: floor (R9) and "≥ 3.7.0 orchestrator without complete `budget`" (R10). `max_fanout/max_depth` parsing unchanged.
  *Satisfies*: REQ-09.
- [x] **T2.4 — Engine bump.** GREEN: `engine-version.ts` `3.6.0 → 3.7.0` + changelog line; `RAH_ENGINE_MIN` exported from `config.schema.ts` beside `OUTPUT_COORDINATOR_ENGINE_MIN`; migrate `config-schema-artifacts.test.ts:10` and any `3.6.0` pin (AC-06 half).
- [x] **T2.5 — Grammar/floor tests GREEN.** AC-01–AC-05 + AC-06 green; `flows.integration.test.ts` W7 same-statement proof.
- [x] **T2.6 — Authoring grammar + skill + Studio labels.** RED: AC-06 prose pins. GREEN: `flow-dsl-grammar.ts` (manifest-header paragraph for `result.export` + result-only completion; orchestrator `delegation` v2 with the effective formula and defaults 2/6/3; a "public results + `run_collect` v2 + `resultProfile`" paragraph in the structured-result section); `authoring-skill.ts` `REF_PACKAGE_LAYOUT` mentions `result_profiles`; drift-guard pins; Studio: `node-side-form.tsx` typed fields for the new `delegation` keys + `node-side-form-labels.ts` + `messages/{en,ru}.json`; `result.export` stays raw-YAML-mode (documented). REFACTOR: none beyond label SSOT.
  *Satisfies*: REQ-02, REQ-09.

**Phase 2 exit** — `cd web && pnpm typecheck && pnpm exec eslint . && pnpm test:unit` green; integration green vs baseline.

---

### Phase 3 — Persistence

- [x] **T3.1 — Migration 0129 + `schema.ts` (the quadruple).** RED: AC-07 (bootstrap applies; shape probes in R1.3). GREEN: SQL as §Persistence; `_journal.json` idx 129; `meta/0129_snapshot.json`; `schema.ts` `runResults` (+ TS types of Appendix A) and the three columns. Renumber check vs Stage A now (D14).
  *Acceptance*: AC-07. *Satisfies*: REQ-01, REQ-13. (depends on Phase 2)
- [x] **T3.2 — `web/lib/run-results/` module.** RED: AC-08, AC-09, AC-10. GREEN: `ledger.ts` (`publishRunResult`, `recordInvalidRunResult`, `markRunResultStale`, `markRunResultCollected`), `status.ts` (`deriveResultStatus`), `contract.ts` (`schemaRefFor`, `buildFlowExportContract`, `buildAgentProfileContract`), `artifact-manifest.ts` (`engineArtifactManifest`), `validate.ts` (`validateResultValue` = `parsePayload`/byte cap + `validateStructuredOutput` — a thin composition over the ADR-162 validator, **no second validator**). REFACTOR: reuse `output-schema.ts` constants by import.
  *Logging*: `[run-result.publish] {runId, revision, schemaRef, sha256Prefix, valueBytes, producer}`, `[run-result.supersede]`, `[run-result.stale]`, `[run-result.invalid] {runId, reasonClass, valueBytes}` — never the value.
  *Satisfies*: REQ-01, REQ-05.
- [x] **T3.3 — DB docs as-built + integrity.** `pnpm --filter maister-web db:erd`; `runs-domain.md` + `database-schema.md` as-built; API-exposure sweep recorded; `git diff --stat docs/api/` empty in this commit. AC-07 outputs in the commit body.

**Phase 3 exit** — unit + integration green; `pnpm validate:docs` green incl. `db:erd --check`.

---

### Phase 4 — Flow-run public results + result-only completion

- [x] **T4.1 — Launch-time contract snapshot (flow).** RED: AC-11, AC-12. GREEN: `launchRunStaged` — after manifest classification, before the worktree: resolve `result.export` from `revision.installedPath` → `buildFlowExportContract` → `runs.result_contract` in the run-insert tx (R12 refuses with zero rows); `resolveDelegatableFlow` pre-resolves the export as a pre-flight, the launcher's resolve is decisive (F4 idiom). REFACTOR: one `resolveFlowExportContract(revision)` used by both.
  *Logging*: `[run-result.contract] {runId, kind:"flow_export", schemaRef, sha256Prefix, producerNodeIds}`.
  *Satisfies*: REQ-02, REQ-13. (depends on Phase 3)
- [x] **T4.2 — Publish at the seam, atomically (D9).** RED: AC-13. GREEN: `StructuredOutputOutcome` success arm gains `value`; when the node is a producer, the seam validates against `loaded.run.resultContract.schema` (the snapshot) and reports the snapshot's identity; `runner-graph.ts` — `closeSucceededAttemptWithResult({db, nodeAttemptId, patch, loaded, node, structuredOutput})` replacing the three direct `markNodeSucceeded` calls (`:4250`, `:4393`, `:4711`): ONE tx → `markNodeSucceeded(…, tx)` → `publishRunResult(tx, …)` with `engineArtifactManifest`. REFACTOR: the three sites collapse to one call.
  *Satisfies*: REQ-01, REQ-02, REQ-13, REQ-15.
- [x] **T4.3 — Supersession + staleness.** RED: AC-14. GREEN: `ledger.ts::markDownstreamStale` calls `markRunResultStale(tx, runId, staledNodeIds)` in its tx (covers `:4580`, `:3596`, `hitl.ts:5152`).
  *Satisfies*: REQ-02.
- [x] **T4.4 — Seam integration tests GREEN (AC-13, AC-14)** in `run-result-flow.integration.test.ts` via `runGraph` + `graph-run-seed` (+ the limits arm through the seam: unsafe key / depth → ADR-162 failure, `invalid` row only when the schema was resolved — pin which).
- [x] **T4.5 — Terminal gate: completeness, result-only completion, Review (D10, D17).** RED: AC-15, AC-16, AC-17. GREEN: in `runGraph`'s success branch, before the CAS: `resolvePublicResult(db, runId)`; (a) required + none → `recordInvalidRunResult(result_missing)` + the Failed branch shape with `errorCode CONFIG`, `run.failed{reason:"result_missing", resultStatus}`; (b) `valid` + `isRunWorkspaceClean({worktreePath, branch, baseCommit})` (new `lib/runs/workspace-clean.ts` over `diffNameStatus` + `diffWorkingTree`; `baseCommit` NULL ⇒ false) → the **Done** flip per D17 in ONE tx (`runs`, `workspaces.scheduledRemovalAt`, `systemCloseActiveAssignmentsForRun`, webhook `run.done`, domain `run.done{completion:"result_only", resultStatus:"valid"}` with `parentRunId`); skip `deliverRunIfAutoReady`; the existing post-tx tail (mounts, token, `promoteAfterExit`) runs unchanged; (c) otherwise the existing Review flip, `run.review` payload widened with `resultStatus`. REFACTOR: extract `finalizeFlowRunDone(tx, …)` mirroring `promote.ts`'s Done write list (parity table in the ADR).
  *Logging*: `[run-result.terminal] {runId, exit:"done_result_only"|"review"|"failed_result_missing", resultStatus, clean}`.
  *Satisfies*: REQ-02, REQ-07, REQ-13, REQ-15, REQ-16.
- [x] **T4.6 — Consumer sweep + `ralph_loop` guard (D18).** RED: AC-18. GREEN: `ralph-loop.ts` selects `parentRunId` and skips when set (`log.info … "ralph relaunch skipped — delegated child, the orchestrator owns retries"`); `mapDomainEvent` (`ext-activity/domain-events.ts`) unchanged (kind switch) — verified; per-consumer "unchanged / reads the new field" recorded in the commit body for `auto_launch_run_plan`, `orchestrator_resume`, `agent_triggers`, `cost_rollup_reconcile`, `memory_harvest`, `brain_source_reindex`.
  *Satisfies*: REQ-07, REQ-08.
- [x] **T4.7 — Terminal tests GREEN (AC-15, AC-16, AC-17)** in `run-result-flow-terminal.integration.test.ts` (table-driven result-only matrix; real git worktree via `withGitRepo`; mounts-released assertion; `promoteNextPending` spy).

**Phase 4 exit** — R1.3 GREEN; suite green vs baseline.

---

### Phase 5 — Agent-run public results (`resultProfile`)

- [x] **T5.1 — Wire shape + allow-lists.** RED: AC-19 (refusal rows). GREEN: `delegation-target.ts` — `resultProfile` in both body schemas; `refuseUnsupportedDelegationOption` gains R1; a refinement for R2 (allow-list: `resultProfile` iff agent ∧ ¬persistent); `plan/route.ts` reports all violations at once; `TaskDelegationSpec` agent arm gains `resultProfile?` (jsonb, TS-only). REFACTOR: none.
  *Satisfies*: REQ-03, REQ-14. (depends on Phase 4)
- [x] **T5.2 — Server-side profile resolution on all three edges.** RED: AC-19 positive arm, AC-20, AC-21. GREEN: `lib/run-results/resolve-profile.ts::resolveResultProfile(db, {parentRunId, name})` → parent `runs.flow_revision_id` → `flow_revisions.result_profiles[name]` (+ `flow_ref_id`, `resolved_revision`) → `buildAgentProfileContract` (R3/R4); `LaunchAgentRunInput.resultContract?` (server-internal) written in the run-insert tx; `run_delegate`, `run_plan` (spec → snapshot at source launch) and `auto_launch_run_plan` (spec → snapshot at candidate launch) all call the one resolver. REFACTOR: none.
  *Logging*: `[run-result.contract] {runId, kind:"agent_profile", profileName, schemaRef, sha256Prefix}`; `[delegation.profile] refused {parentRunId, name, reason}`.
  *Satisfies*: REQ-03, REQ-13, REQ-14.
- [x] **T5.3 — Final-text capture.** RED: AC-22. GREEN: extract `appendCapped` from `runner-agent.ts:546` into `lib/flows/capped-text.ts` (used by both — no behaviour change for flow nodes); `consumeAgentSession` accumulates `agent_message_chunk` text per turn (reset when a new prompt turn starts) and passes `finalText` to `finalizeAgentRun(runId, "Done", {finalText})`.
  *Satisfies*: REQ-03.
- [x] **T5.4 — Publish / refuse in `finalizeAgentRun` (D10).** RED: AC-23. GREEN: inside the existing tx, when `runs.result_contract` is set and outcome is `Done`: `extractSentinelBlock` → `validateResultValue(contract.schema)` → `publishRunResult` → status per existing rules → emit with `resultStatus`; absent+required → `recordInvalidRunResult(result_missing)` + status `Failed` + `run.failed{reason:"result_missing"}`; invalid → `recordInvalidRunResult(class)` + `Failed{result_invalid}`; optional absent → normal; `Failed`/`Crashed` outcomes never publish; persistent runs cannot carry a contract (R2). REFACTOR: the status/emit block is untouched; the result step is one helper call.
  *Logging*: `[run-result.agent] {runId, outcome, resultStatus, reasonClass?, valueBytes?}`.
  *Satisfies*: REQ-03, REQ-10, REQ-15.
- [x] **T5.5 — Agent-arm tests GREEN (AC-22, AC-23)** in `agent-run-result.integration.test.ts` (scripted `SupervisorApi` stream; both orderings where a race exists — a chunk arriving after `session.exited` is ignored).
- [x] **T5.6 — W4 (AC-24)** — one case in the existing reconcile integration suite.

**Phase 5 exit** — R1.2 GREEN; suite green vs baseline.

---

### Phase 6 — Effective bounds, budgets, active-children queue

- [x] **T6.1 — Bounds snapshot at node start.** RED: AC-25 (R1.4), AC-26. GREEN: `lib/orchestrator/bounds.ts` — `computeEffectiveDelegationBounds({env, declared, engineMin, nodeId, nodeAttemptId})` (pure) + `writeDelegationBoundsIfChanged(db, runId, bounds)`; called in `runner-graph.ts` at the token-issuance block before `createSession`. Env accessors reused.
  *Logging*: `[delegation.bounds] {runId, nodeId, nodeAttemptId, source, maxDepth, maxFanout, maxActiveChildren, budget}`.
  *Satisfies*: REQ-07, REQ-09, REQ-13. (depends on Phase 5)
- [x] **T6.2 — Admission v2 (D5, D8).** RED: AC-27, AC-28. GREEN: `admission.ts` reads the parent's and the ancestor chain's `delegation_bounds` (the existing depth walk already visits every ancestor — collect their snapshots in the same loop): depth `min(env, root.maxDepth ?? env, parent.maxDepth ?? env)`; fan-out `min(env, parent.maxFanout ?? env)`; for each ancestor with `budget.maxChildRuns`: `countRunSubtree(tx, ancestorId)` (recursive CTE over `parent_run_id`, all statuses) `+ incoming > max` → `CONFIG` naming the ancestor (R7). NULL snapshots ⇒ env-only. `plan/route.ts` batch pre-check uses the effective fan-out. REFACTOR: the walk returns `{depth, ancestors:[{id, bounds}]}` once; no second query.
  *Logging*: `[delegation.admit]` / `[delegation.fanout]` gain `{source, effective}`; `[budget.tree.children] refused {ancestorRunId, descendants, incoming, cap}`.
  *Satisfies*: REQ-07, REQ-09.
- [x] **T6.3 — Active-children queue (D7).** RED: AC-29. GREEN: `run-status-sets.ts` exports `SLOT_HOLDING_RUN_STATUSES = ["Running","NeedsInput","HumanWorking"]` (the list `countLiveRuns` and `sharedWriterSiblingActive` already use — both switched to the constant); `scheduler.ts::orchestratorActiveChildrenAtCap(tx, parentRunId, excludeRunId)` checked in `tryStartRun` and `promoteNextPending` beside the writer gate (skip + continue); `run_delegate` returns `status`. REFACTOR: the two inline status lists become the constant.
  *Logging*: `[delegation.active-cap] queued|released {childRunId, parentRunId, active, cap}`.
  *Satisfies*: REQ-07, REQ-09.
- [x] **T6.4 — Root tree-budget min-merge.** RED: AC-30. GREEN: `keepalive-sweeper.ts` tree scope: `effectiveTreeLimit = min(policy tree limit, root.delegation_bounds.budget.<x>)` for tokens (escalate + hard via the multiplier), wall-clock, consecutive failures; disposition unchanged. Nested: recorded only.
  *Logging*: budget logs gain `{limitSource: "policy"|"node"|"min"}`.
  *Satisfies*: REQ-09.
- [x] **T6.5 — Recovery reads the snapshot.** GREEN (test-only if already true): `orchestrator-resume.ts` + `reconcile.ts` never re-derive bounds; a woken parent's next admission uses the same snapshot (AC-27 env-drift row).
- [x] **T6.6 — Bounds tests GREEN (AC-26–AC-29)** in `bounds.integration.test.ts` incl. the two-racer and the pre-3.7.0 compat pin (ADR-163 `admission.integration.test.ts` untouched).

**Phase 6 exit** — R1.4 GREEN; suite green vs baseline.

---

### Phase 7 — `run_collect` v2

- [x] **T7.1 — Route rewrite (additive, D12).** RED: AC-31. GREEN: assembly in `lib/run-results/collect.ts` (`collectChild(db, {parentRunId, childRunId})`): `runs` row + `result_contract`, newest + `valid` rows, `deriveResultStatus`, `resultFailure` from the newest `invalid` row, `engineArtifactManifest` (live), `diffRef` unchanged, `outputText` with `ORDER BY created_at DESC LIMIT 1`, `settled = isSettledRunStatus(status)`; missing row → `PRECONDITION` (existence-hidden, R16). Thin route. REFACTOR: `outputTextFromArtifacts` / `diffRefFromLocator` move into the module unchanged.
  *Logging*: `[run-result.collect] {parentRunId, childRunId, resultStatus, revision, settled}`.
  *Satisfies*: REQ-06. (depends on Phase 6)
- [x] **T7.2 — `first_collected_at` marker (Q7-C).** RED: AC-32 (marker rows). GREEN: in a tx before the response, `markRunResultCollected` for every `valid` row served (idempotent, W6).
  *Satisfies*: REQ-06, REQ-11.
- [x] **T7.3 — OpenAPI/MCP GREEN (AC-33).** Contracts from S0.6/S0.7 now match; `pnpm --filter @maister/mcp build`.
- [x] **T7.4 — Collect tests GREEN (AC-31, AC-32)** in `collect-v2.integration.test.ts` (each `resultStatus` reached through the real seams; fake artifact id inert; idempotency; grandchild; stale token; deterministic `outputText`).

**Phase 7 exit** — R1.1 GREEN; suite green vs baseline.

---

### Phase 8 — Observability

- [x] **T8.1 — Public-result inspector panel.** RED: AC-34 (panel). GREEN: `lib/runs/run-result-dto.ts` (`RunPublicResultDto`, explicit columns), `components/runs/run-public-result-panel.tsx` rendered from `app/(app)/runs/[runId]/layout.tsx` beside `NodeTranscriptPanel` when a contract or rows exist; EN/RU messages; HeroUI; icon affordances; a "completed without promotion" fact for `Done` runs with `promotion_state='none'` (derivable, no column). `docs/screens/runs/flow-run.md` as-built.
  *Satisfies*: REQ-10. (depends on Phase 7)
- [x] **T8.2 — Child result badges.** RED: AC-34 (badges). GREEN: `ChildRunRef.resultStatus` (`queries/run.ts:806`, one left join on the newest row via the status predicate); glyphs in `orchestrator-run-subtree.tsx` + `run-inspector-child-runs-list.tsx`; EN/RU.
- [x] **T8.3 — Tree cost + wall-clock roll-up.** RED: AC-35. GREEN: `cost-rollups.ts::queryRunTreeTokensByKind(rootRunId)` (a `root_run_id`-scoped sibling of the per-run query, by kind and model); `queries/run.ts::getRunTreeCostSummary(rootRunId)`; `treeWallClockMinutes` reused; `cost-summary-facts.ts` "Tree total tokens" / "Tree wall-clock" facts (tree roots with children only); `cost-summary/route.ts` returns `tree?` (documented in S0.6). REFACTOR: the per-run and tree queries share one row-folding helper.
- [x] **T8.4 — Structured decision records sweep + log gate (AC-36).** One structured line per decision class with stable keys; the grep gate output pasted in the commit body.
- [x] **T8.5 — Read-model tests GREEN (AC-34, AC-35)** (`renderToStaticMarkup` component tests; `run-tree-cost.integration.test.ts`; the cost-summary route case).

**Phase 8 exit** — suite green; `pnpm exec eslint .` clean on touched files.

---

### Phase 9 — Reference harness fixture + integration matrix + e2e

- [x] **T9.1 — In-repo fixture package `web/test-fixtures/rah/`** (REQ-12): `maister-package.yaml` (`name: rah-fixture`, `result_profiles: {research: {schema: ./schemas/research-result.v1.json}}`, flows `rah-root-d1`, `rah-root-d2`, `rah-research`, `single-agent`, `externalized-context`), `schemas/research-result.v1.json` (`summary:string!`, `outcome:enum[completed,blocked,needs_input]!`, `payload:json!`), `schemas/reduce-result.v1.json` (the spine + `consumedChildRunIds: array<string>!` + `plan: json`), `maister-agents/{architecture,dependency,test,risk}-researcher.md` (`workspace: repo_read`), the D16 graphs at `engine_min 3.7.0` with `delegation: {max_depth: 1|2, max_fanout: 4, max_active_children: 3, budget: {…}}`, `enforcement.tools: strict` + a `tools` allow-list omitting `Task`/`Agent` (D15), `orchestrate.output.result {schema: ./schemas/reduce-result.v1.json, required: true, on_mismatch: retry}`, `rework.maxLoops: 2`, `decide` on `output.outcome` (`blocked → escalate`), `writer` consuming `{{ steps.orchestrate.vars.plan }}`, `verify` judge + blocking `ai_judgment` gate, `review` human; `rah-research` has its own orchestrator + `result.export {schema: ./schemas/research-result.v1.json, from: [orchestrate]}` (finishes by result-only completion). e2e inline manifests in `seed-e2e.ts` (`RAH_ROOT_MANIFEST`, `RAH_RESEARCH_MANIFEST`) + `fixtures.ts` entries + seeded `flow_revisions.result_profiles`.
  *Satisfies*: REQ-08, REQ-12. (depends on Phase 8)
- [x] **T9.2 — Integration matrix (AC-37)** `web/lib/orchestrator/__tests__/recursive-harness.integration.test.ts` (real `runGraph` + real routes + scripted supervisor; `delegation-seed.ts`, `graph-run-seed.ts`, `withGitRepo`): (1) depth-1 loop: 4 agent researchers publish → parent wakes once all settle → the completing turn publishes the reduce result (`consumedChildRunIds` ⊆ valid children) → writer → verify → Review → `promoteRun` re-gates readiness → Done; (2) depth-2: root → 2 `rah-research` flow children fanning out agents, each finishing `Done` by result-only completion with a `valid` export → root collects ONLY the two exports (grandchildren invisible); (3) malformed child result → `Failed{result_invalid}` + `invalid` row → parent wakes → re-delegates within fan-out → completes; (4) missing required → `Failed{result_missing}`; (5) rework supersession through the harness; (6) stale token after the root terminalizes → 409; (7) effective bounds: fan-out 4 refuses the 5th, depth bound refuses a grandchild's delegation at depth 2, the nested `max_child_runs` refuses before the root's; (8) parent wake per kind (`review/done(result_only)/failed/crashed/abandoned`); (9) `run_cancel` of a research child mid-run → `Abandoned`, wake, `unavailable`; root abandon cascades to grandchildren + sessions; (10) budget exhaustion: tree token breach → terminate-cascade → root Failed → task Backlog; (11) one-writer safety: the only worktree writer is the `writer` node; static asserts on the fixture (no `worktree` child; `capability_guard` allow-list omits the subagent tool); `ralph_loop` never relaunches a failed child (D18); (12) readiness-gated promotion: a failing `verify` gate blocks `promoteRun` (`PRECONDITION`); a settled agent child in `Review` promoted alone still requires ITS readiness.
  *Satisfies*: REQ-08, REQ-16.
- [x] **T9.3 — e2e (AC-38)** `web/e2e/recursive-harness.spec.ts` (+ `AUTHED_SPEC`): `test-supervisor.ts` — child sessions whose run has a `result_contract` emit a `session.update{sessionUpdate:"agent_message_chunk", content:{type:"text", text}}` carrying the sentinel before `session.exited{0}`; the orchestrator resume turn calls the REAL `POST /api/v1/ext/runs/collect` (`all:true`) through its facade token, asserts `resultStatus:"valid"` for each, then emits the reduce sentinel listing `consumedChildRunIds`; delegations carry `resultProfile:"research"` (agent) or target the `rah-research` flow (depth 2). Spec: launch `rah-root-d2` → two flow children → their agent grandchildren → children finish `Done` (result-only) → root wakes → root's public-result panel shows `valid` revision 1 → tree cost facts render. **Tick `domain_event_dispatch` BEFORE the launch**; kill 3100/7788 first; baseline-prove; retry once on a cold `next dev`.
  *Acceptance*: `cd web && pnpm test:e2e e2e/recursive-harness.spec.ts` green; `flow-target-delegation` + `orchestrator-loop` still green; no NEW failure vs the 35-failure baseline.

**Phase 9 exit** — suite + e2e green vs baselines.

---

### Phase 10 — Evaluation Lab

- [x] **T10.1 — Objective providers (F15 seams; Q7-C).** RED: AC-39 (pure arms). GREEN: `OBJECTIVE_CHECK_PROVIDERS` + `ObjectiveFactSource.tree?` + exhaustive arms: `child_run_count@1`, `result_validation_failures@1` (invalid rows incl. `result_missing` over the tree), `collected_results_ratio@1` (`first_collected_at` set ÷ valid child rows), `consumed_results_ratio@1` (root result `consumedChildRunIds` ∩ children with a `valid` row ÷ valid child rows — fabricated ids excluded), `rework_count@1`, `crash_count@1`, `tree_tokens@1`, `tree_wall_clock_minutes@1`, `promotion_readiness@1`. All read recorded facts (ADR-143 D11).
  *Satisfies*: REQ-11. (depends on Phase 9)
- [x] **T10.2 — Fact population + persistence.** GREEN: `objective/execute.ts` (`ParticipantFacts.tree` via one recursive CTE) → `evaluation_metric_results`; `METRICS_FORMULA_VERSION` bump if any formula changes; the comparison view renders the new metrics generically.
- [x] **T10.3 — Protocol doc as-built.** `evaluations.md` §RAH protocol flipped `(Implemented)`; recipes over `single-agent`, `externalized-context`, `rah-root-d1`, `rah-root-d2`; the nine measures → providers/verdict mapping (human corrections = superseding verdicts; objective gate success = `gate_result@1`); replicate policy; human-verdict rule (ADR-147).
- [x] **T10.4 — Provider tests GREEN (AC-39)** — `providers.test.ts` (one row per arm) + `tree-facts.integration.test.ts` (seeded tree, exact values).

**Phase 10 exit** — suite green.

---

### Phase 11 — As-built docs, contract sweep, renumber, companion package

- [x] **T11.1 — Flip Designed → Implemented + reconcile drift** in every Phase-0 artifact (prose AND `| Designed |` table cells); ADR-165 as-built section; spec as-built. A divergence is fixed in BOTH places. *Acceptance*: AC-40; a line-by-line re-read of §C against the shipped routes/loader.
- [x] **T11.2 — Contract-surface verification gate.** `grep -rn "run_collect\|outputText\|resultProfile\|result_profiles\|result\.export\|max_active_children\|max_child_runs\|result_only" docs .codex .claude web/lib/flows/flow-dsl-grammar.ts web/lib/flows/authoring-skill.ts mcp/src` — open each hit, record updated / kind-neutral in the commit body; root `CLAUDE.md` §6 (engine 3.7.0 + one public-result sentence + result-only completion in §7/§8) and `web/CLAUDE.md` if a UI convention changed.
- [x] **T11.3 — Companion package `maister-plugins/packages/rah` (Q9-B; external, not gated here).** Authored in `/repos/maister-plugins` from the in-repo fixture after Phase 7 (contracts GREEN): the same D16 graphs with production prompts, `core` runner profiles, package `result_profiles`, README with the install/enable steps and the Lab protocol run; left UNCOMMITTED there until this repo merges, then committed + tagged `rah/v1.0.0` (push via the one-off HTTPS URL). A pointer doc `docs/plans/2026-09-02-rah-companion-package.md` (+ `docs/plans/README.md` row) records the handoff.
  *Satisfies*: REQ-12.
- [x] **T11.4 — Renumber pass.** After rebasing onto `main`: re-verify ADR-165 / migration 0129 / engine 3.7.0 are still max+1 (`git show main:docs/decisions.md`; `_journal.json` max + `when` monotonic + snapshot present); take 164/0128 ONLY if the owner drops the Stage A branch; grep prose forms (`pre-0129`, `since 0129`).
- [x] **T11.5 — Definition of done (all green, outputs pasted in the commit body):**
  ```bash
  cd /repos/mAIster/.claude/worktrees/musing-lamarr-c2c0f4/web && pnpm exec eslint .
  cd /repos/mAIster/.claude/worktrees/musing-lamarr-c2c0f4/web && pnpm typecheck
  cd /repos/mAIster/.claude/worktrees/musing-lamarr-c2c0f4/web && pnpm test:unit
  cd /repos/mAIster/.claude/worktrees/musing-lamarr-c2c0f4/web && pnpm test:integration
  cd /repos/mAIster/.claude/worktrees/musing-lamarr-c2c0f4 && pnpm --filter @maister/mcp build && pnpm --filter @maister/mcp typecheck && pnpm --filter @maister/mcp test
  cd /repos/mAIster/.claude/worktrees/musing-lamarr-c2c0f4 && pnpm --filter @maister/supervisor typecheck
  cd /repos/mAIster/.claude/worktrees/musing-lamarr-c2c0f4 && pnpm validate:docs
  cd /repos/mAIster/.claude/worktrees/musing-lamarr-c2c0f4 && pnpm validate:contracts
  cd /repos/mAIster/.claude/worktrees/musing-lamarr-c2c0f4/web && pnpm db:generate     # → "No schema changes, nothing to migrate"
  cd /repos/mAIster/.claude/worktrees/musing-lamarr-c2c0f4/web && pnpm test:e2e         # set-diff vs the 35-failure baseline; new spec green
  ```
  Traceability closed: every REQ row has tasks AND ACs landed; every AC has exactly one primary test (Appendix E). Owner-side after merge: `git push`, `pnpm --filter maister-web db:migrate` (0129), `pnpm --filter @maister/mcp build` on the facade host, commit + tag the companion package.

---

## Test-integrity contract (applies to every phase)

1. **Runnability** — all new tests land in already-globbed path families (`web/vitest.workspace.ts`); confirm by running the single file.
2. **Baseline first, SETS not counts** — integration set at Phase 0 (expected: the dirty-resolution-race pair); e2e 35 at `73fa99915`; ryuk/docker mass failures are infrastructure.
3. **Per-phase green checkpoint** — unit + integration green vs the set at every exit; a touched red fails the phase; newly surfaced pre-existing reds are quarantined with a reason + follow-up, never deleted.
4. **RED recorded, message pinned; mutation-check every guard** (revert the guard, observe RED, restore).
5. **Assertion migration is in-scope, by path**: `web/app/api/v1/ext/runs/__tests__/collect*.integration.test.ts` (additive — existing assertions untouched; the `"unknown"`-status case, if any, becomes the 409 case), `delegate.integration.test.ts` / `plan.integration.test.ts` (no change expected — grep for `resultProfile` as an unknown-key example), `web/lib/orchestrator/__tests__/admission.integration.test.ts` (must stay green untouched — pre-3.7.0 fixtures keep env semantics), `web/lib/__tests__/config-schema-artifacts.test.ts:10` (engine pin), `web/lib/flows/__tests__/flow-dsl-grammar.test.ts` (new pins), `mcp/src/__tests__/tool-contract.test.ts` (new properties), `web/e2e/orchestrator-loop.spec.ts` + `flow-target-delegation.spec.ts` (must stay green — test-supervisor changes are additive), `web/lib/domain-events/__tests__/orchestrator-resume*.integration.test.ts` (payload widening must not break existing arms), `web/lib/runs/__tests__/ralph-loop*.test.ts` (gains the parent-skip case; the parentless positive arm must remain), `web/lib/scheduler` tests touching `sharedWriterSiblingActive` (constant extraction is behaviour-neutral).

## Logging contract

Structured `pino`; keys only, never values. `LOG_LEVEL`-driven.

| Namespace | Level | Event |
| --- | --- | --- |
| `[run-result.profiles]` | info / warn | profiles materialized at install / refused |
| `[run-result.contract]` | info | launch-time contract snapshot (`flow_export` / `agent_profile`) |
| `[run-result.publish]` | info | `{runId, revision, schemaRef, sha256Prefix, valueBytes, producer}` |
| `[run-result.invalid]` | warn | `{runId, reasonClass, valueBytes}` |
| `[run-result.supersede]` / `[run-result.stale]` | info | supersession / staleness |
| `[run-result.terminal]` | info | flow terminal exit (`done_result_only` / `review` / `failed_result_missing`) |
| `[run-result.agent]` | info / warn | agent finalize outcome + `resultStatus` |
| `[run-result.collect]` | debug / info | collect served |
| `[delegation.bounds]` | info | effective bounds snapshot |
| `[delegation.admit]` / `[delegation.fanout]` | warn | refusals (+ `source`, `effective`) |
| `[delegation.active-cap]` | info | child queued / released |
| `[delegation.profile]` | warn | profile refused |
| `[budget.tree.children]` | warn | per-ancestor child-count budget refused |
| `[ralph]` | info | relaunch skipped — delegated child |

**Never logged**: result values, prompts, artifact bodies, token secrets, `acp_session_id`.

---

## Explicitly out of scope

Python RLM runtimes · Prime Agent integration · adapter-internal hidden subagents (structurally excluded, D15) · unbounded recursion · autonomous production skill mutation · concurrent shared-workspace writers (`workspaceMode: shared` for flow children stays an ADR-163 follow-up) · subtree token/wall-clock/failure budget enforcement below the root (R-nested) · a `Review`-age sweeper for W12 (non-result flows) · auto-archive of Review children (Q5-B, superseded by D17 for result flows) · a versioned `/collect/v2` route · YAML schema documents (Q2-A) · new env vars · a domain-event AsyncAPI file (pre-existing gap) · parking invalid agent results in `Review` for `run_rework` (Q4-B, revisit if writer-children packages appear).

---

## Appendix A — TypeScript shapes (normative; land in `web/lib/db/schema.ts` and `web/lib/run-results/types.ts`)

```ts
export type RunResultValidity = "valid" | "stale" | "superseded" | "invalid";
export type RunResultProducerKind = "flow_node" | "agent_session";
export type RunResultInvalidReason =
  | "result_missing" | "malformed_json" | "oversize" | "unsafe_key"
  | "depth_limit" | "key_limit" | "array_limit" | "schema_mismatch";

export type RunResultRow = {
  id: string; runId: string; revision: number; validity: RunResultValidity;
  schemaRef: string; schemaSha256: string; schemaVersion: number;
  producerKind: RunResultProducerKind;
  producerRef: string;                      // node id | "session:default"
  nodeAttemptId: string | null; value: unknown | null; valueBytes: number;
  invalidReason: RunResultInvalidReason | null;
  artifactManifest: Array<{ artifactId: string; kind: string; nodeId: string | null; validity: string }>;
  engineVersion: string; supersededById: string | null; supersededAt: Date | null;
  firstCollectedAt: Date | null; createdAt: Date;
};

export type RunResultContract =
  | { kind: "flow_export"; schemaRef: string; schemaVersion: number; sha256: string;
      required: boolean; producerNodeIds: string[]; schema: FormSchema; flowRevisionId: string }
  | { kind: "agent_profile"; profileName: string; schemaRef: string; schemaVersion: number;
      sha256: string; required: true; schema: FormSchema; sourceFlowRevisionId: string };

export type DelegationBudget = { maxTokens: number; wallClockMinutes: number; maxChildRuns: number; consecutiveFailures: number };
export type DelegationBounds = {
  nodeId: string; nodeAttemptId: string; engineMin: string | null; source: "env" | "node";
  maxDepth: number; maxFanout: number; maxActiveChildren: number | null; budget: DelegationBudget | null;
  declared: { max_depth?: number; max_fanout?: number; max_active_children?: number; budget?: DelegationBudget } | null;
  instance: { maxDepth: number; maxFanout: number; flowPool: number; agentPool: number };
};

export type ResultProfileMap = Record<string, { schemaPath: string; schemaStem: string; schemaVersion: number; sha256: string; schema: FormSchema }>;

export type PublicRunResult = { schemaRef: string; value: unknown };
export type ResultStatus = "pending" | "valid" | "absent" | "missing" | "stale" | "invalid" | "unavailable";
```

## Appendix B — Wire contracts (normative fragments for S0.6 / S0.7)

`ExtChildRunSummary` v2 (OpenAPI):
```yaml
ExtChildRunSummary:
  type: object
  required: [childRunId, status, settled, resultStatus, result, resultRevision, resultFailure, artifacts]
  additionalProperties: false
  properties:
    childRunId: { type: string, format: uuid }
    status: { type: string }
    settled: { type: boolean }
    resultStatus: { type: string, enum: [pending, valid, absent, missing, stale, invalid, unavailable] }
    result:
      nullable: true
      type: object
      required: [schemaRef, value]
      additionalProperties: false
      properties:
        schemaRef: { type: string, description: "<flowRefId>@<rev12>:<schemaStem>" }
        value: {}   # the validated payload, any JSON object
    resultRevision: { type: integer, nullable: true }
    resultFailure:
      nullable: true
      type: object
      required: [reason, message]
      additionalProperties: false
      properties:
        reason: { type: string, enum: [result_missing, malformed_json, oversize, unsafe_key, depth_limit, key_limit, array_limit, schema_mismatch] }
        message: { type: string }
    artifacts:
      type: array
      items:
        type: object
        required: [id, kind, name, nodeId, validity]
        additionalProperties: false
        properties:
          id: { type: string, format: uuid }
          kind: { type: string }
          name: { type: string }
          nodeId: { type: string, nullable: true }
          validity: { type: string, enum: [current, stale, superseded, failed, skipped] }
    diffRef: { type: string, nullable: true }
    outputText: { type: string, nullable: true, deprecated: true, description: "Legacy inline-artifact text. Use result.value." }
```
Delegate / plan additions: `resultProfile: { type: string, minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$" }` on `ExtRunDelegateBody` and `ExtRunPlanTask` (agent target only; 422 on a flow target or with `persistent`); delegate `202` response `{ childRunId, childTaskId?, status: { enum: [Pending, Running] } }`. MCP `run_delegate.inputSchema.properties.resultProfile` and `run_plan.tasks.items.properties.resultProfile` mirror the same shape; `run_collect` output documented as the v2 array. `web.openapi.yaml` `getRunCostSummary` gains `tree?: { totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, wallClockMinutes, runCount }`.

Domain-event payload widening (documented in `domain-events.md`, no AsyncAPI): `run.review|run.done|run.failed` `+resultStatus`; `run.done` `+completion: "promoted" | "result_only"`; `run.failed.reason` `+ "result_missing" | "result_invalid"`.

## Appendix C — Effective bounds + admission (normative pseudocode)

```
bounds(node, engineMin) =
  engineMin < 3.7.0 → { source:"env", maxDepth: env.depth, maxFanout: env.fanout, maxActiveChildren: null, budget: null }
  else               → { source:"node", maxDepth: min(env.depth, node.max_depth ?? 2),
                          maxFanout: min(env.fanout, node.max_fanout ?? 6),
                          maxActiveChildren: min(poolCap(kind), node.max_active_children ?? 3),
                          budget: node.budget (required) }

admit(parent, incoming):
  lock(parent)
  chain = walkUp(parent)                       // [{id, bounds}] parent first, root last, cap 64
  depth = |chain| - 1
  maxDepth = min(env.depth, root.bounds?.maxDepth ?? env.depth, parent.bounds?.maxDepth ?? env.depth)
  if depth >= maxDepth → CONFIG (R5)
  live = countLiveDelegatedChildren(parent)     // NOT IN TERMINAL, both kinds
  if live + incoming > min(env.fanout, parent.bounds?.maxFanout ?? env.fanout) → CONFIG (R6)
  for a in chain where a.bounds?.budget?.maxChildRuns:
    if countRunSubtree(a.id) + incoming > a.bounds.budget.maxChildRuns → CONFIG naming a (R7)

schedule(child): parent.bounds?.maxActiveChildren != null && activeSiblings(parent) >= it → keep Pending (R18)
```

## Appendix D — `run-results.md` Expectations (≤ 12, each names its AC)

1. `run_results` MUST hold at most one `valid` row per run (`run_results_one_valid_per_run_uq`); every publish MUST supersede prior `valid|stale` rows in the same transaction. (AC-08)
2. A result row MUST be committed in the SAME transaction as the attempt close (flow) or the terminal flip (agent, completeness gate, result-only Done) that makes it collectable; `orchestrator_resume` MUST never observe a settle without its row. (AC-13, AC-15, AC-16, AC-23)
3. `runs.result_contract` MUST be written by the launcher from the pinned revision / the parent's pinned profiles, and MUST be the only schema the seam, the finalizer and the collect route read. (AC-11, AC-12, AC-19, AC-20)
4. `required` MUST excuse absence only; a present-but-invalid payload MUST record an `invalid` row and fail the run (`result_invalid`); a required absence MUST record `result_missing` and fail the run — never on a human-resolved Review flip. (AC-15, AC-17, AC-23)
5. A flow run MUST finalize `Running → Done` (result-only completion) iff it declares `result.export`, holds a `valid` current result, and its workspace is clean (`base_commit..branch` empty AND working tree clean); any other success exit MUST be `Review`, byte-identical to today. (AC-16)
6. `run_collect` MUST return only DIRECT children of the bound orchestrator, MUST be idempotent (identical bodies; `first_collected_at` set once), MUST derive `artifacts` from `artifact_instances`, and MUST refuse a terminal-orchestrator token with `PRECONDITION`. (AC-31, AC-32)
7. `resultStatus` MUST be derived by ONE predicate (`deriveResultStatus`) on every surface. (AC-09)
8. Effective bounds MUST be `min(instance policy, active node declaration)` for `engine_min ≥ 3.7.0` and env-only below, snapshotted on the orchestrator run per node attempt and read by admission and the scheduler; env changes after the snapshot MUST NOT change a running tree's bounds. (AC-25–AC-27)
9. `max_child_runs` MUST bind at every ancestor (subtree count under the per-orchestrator lock); token/wall-clock/failure budgets MUST bind at the tree root via the existing meters. (AC-28, AC-30)
10. A child over its parent's active-children cap MUST stay `Pending` (never refused) and MUST start on the next `promoteNextPending` after a sibling leaves a slot-holding status. (AC-29)
11. `resultProfile` MUST resolve only from the parent's pinned `flow_revisions.result_profiles`, MUST be refused on flow targets and with `persistent`, and MUST be snapshotted on all three creation edges. (AC-19, AC-20)
12. `ralph_loop` MUST NOT relaunch a run with `parent_run_id`. (AC-18)

## Appendix E — Test ownership (AC → primary test → runner project)

| AC | File | Project |
| --- | --- | --- |
| 01, 03–05 | `web/lib/__tests__/config.schema.test.ts`, `config-artifacts.test.ts` | unit |
| 02 | `web/lib/__tests__/flows.integration.test.ts` | integration |
| 06 | `config-schema-artifacts.test.ts`, `flows/__tests__/flow-dsl-grammar.test.ts`, `studio/flow-assistant/__tests__/context.test.ts` | unit |
| 07, 40 | gate commands (commit body) | — |
| 08 | `web/lib/run-results/__tests__/ledger.integration.test.ts` | integration |
| 09, 10 | `web/lib/run-results/__tests__/status.test.ts`, `contract.test.ts` | unit |
| 11, 12 | `web/lib/services/__tests__/launch-run-result-contract.integration.test.ts` | integration |
| 13, 14 | `web/lib/flows/graph/__tests__/run-result-flow.integration.test.ts` | integration |
| 15, 16, 17 | `web/lib/flows/graph/__tests__/run-result-flow-terminal.integration.test.ts` | integration |
| 18 | `web/lib/domain-events/__tests__/run-result-consumers.integration.test.ts` | integration |
| 19 | `web/app/api/v1/ext/runs/__tests__/delegate-result-profile.integration.test.ts` | integration |
| 20 | `web/lib/domain-events/__tests__/auto-launch-result-profile.integration.test.ts` | integration |
| 21 | `web/lib/run-results/__tests__/resolve-profile-isolation.test.ts` | unit |
| 22 | `web/lib/flows/__tests__/capped-text.test.ts` (+ one case in AC-23's file) | unit / integration |
| 23 | `web/lib/agents/__tests__/agent-run-result.integration.test.ts` | integration |
| 24 | existing reconcile integration suite (one case) | integration |
| 25 | `web/lib/orchestrator/__tests__/bounds.test.ts` | unit |
| 26–29 | `web/lib/orchestrator/__tests__/bounds.integration.test.ts` | integration |
| 30 | keep-alive budget integration suite (two cases) | integration |
| 31, 32 | `web/app/api/v1/ext/runs/__tests__/collect-v2.integration.test.ts` | integration |
| 33 | `mcp/src/__tests__/tool-contract.test.ts` | mcp |
| 34 | `web/components/runs/__tests__/run-public-result-panel.test.tsx`, `run-inspector-child-runs-list.test.tsx` | unit |
| 35 | `web/lib/queries/__tests__/run-tree-cost.integration.test.ts` + cost-summary route case | integration |
| 36 | grep gate (commit body) | — |
| 37 | `web/lib/orchestrator/__tests__/recursive-harness.integration.test.ts` | integration |
| 38 | `web/e2e/recursive-harness.spec.ts` | e2e |
| 39 | `web/lib/evaluations/objective/__tests__/tree-facts.integration.test.ts`, `providers.test.ts` | integration / unit |

---

## Owner decisions applied (2026-09-02)

| Q | Decision | Where it landed |
| --- | --- | --- |
| Q1 | A — node bounds live for `≥ 3.7.0` only | D5, T2.3, T6.1–T6.2, AC-25/27 |
| Q2 | A — JSON schema docs only | F1, D3/D4, T2.1 |
| Q3 | 6 — default fan-out | D5, AC-27 |
| Q4 | A — required absent/invalid → `Failed` (+ `invalid` row as the one durable reason) | D10, R13–R15, T5.4, T4.5, AC-15/23 |
| Q5 | **C — result-only completion to `Done`** | D17, W10, T4.5/T4.7, AC-16, D16 (research flows), S0.3 (runs/workspaces/readiness docs) |
| Q6 | C — child-count at every level, spend/time/failure at root | D8, T6.2/T6.4, AC-28/30, Appendix C |
| Q7 | C — engine marker + self-reported consumption, intersection metric | T7.2, T10.1, AC-32/39 |
| Q8 | A — ADR-165 / 0129 (Stage A's 164 / 0128 are committed on its unmerged branch) | D14, T11.4 |
| Q9 | B — companion package authored after Phase 7, committed/tagged after merge | T11.3, REQ-12 |
| Q10 | A — payload widening, no new kinds | §F, T4.6, Appendix B |

No unresolved owner questions remain. One shipped-path change was folded in rather than asked: `ralph_loop` skipping delegated children (D18), a small fix with a positive-arm test, because a lineage-less relaunch would silently break the "child failures route through the parent" contract the harness relies on.
