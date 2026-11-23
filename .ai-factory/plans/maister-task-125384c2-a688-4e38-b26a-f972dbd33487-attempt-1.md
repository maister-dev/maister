# Unify human-facing task status

**Branch:** `maister/task-125384c2-a688-4e38-b26a-f972dbd33487/attempt-1`

**Created:** 2026-11-23

**Base for numbered artifacts:** `master` at `97e754c60bcab3c4f8819a968d43091cbd8a508c`.

**ADR allocation:** ADR-218 in `docs/decisions/adr-218.md` plus the matching `docs/decisions.md` stub and index. Before writing it, check base and working branch for collisions and renumber both references together if needed.

**Migration allocation:** None. Base main journal ends at `0367_flow_node_restart_checkpoint`. The read-only projection uses existing rows and indexes. Verify the migration SQL directory, journal, snapshots, and Drizzle schema have no implementation diff.

## Original Request

# Task statement

## Context
Task status is presented inconsistently across MAIster screens. Observed on this host: 19 tasks (MAI-8…MAI-26) sit in the Incoming requests tab but each header shows a BACKLOG chip, and the board column "Backlog 4" does not include them. MAI-6 and MAI-7 show stage "Triage / Triage it" in Work while the board shows a LAUNCH button. MAI-5 shows "Abandoned" in Work but sits in Backlog on the board with "PAUSED · Needs review". MAI-11 is labeled three different ways: "Held" on Desk, "BACKLOG · NEEDS REVIEW" in the task header, "QUALIFICATION · NEEDS_REVIEW" in the qualification block.

## Goal
Introduce a single derived, human-facing task status with one vocabulary and one color scale, used identically in the task header, board, Work, Desk, Inbox and MCP.

## Acceptance criteria
- A single derived mapping (status + triageStatus + qualification/blocked reason → one human status) exists as the only source used by all surfaces.
- Task header, board column, Work table, Desk, Inbox and MCP show the same status word and color for the same task.
- The listed inconsistencies are resolved: MAI-8…MAI-26 no longer labeled BACKLOG while sitting in Incoming; MAI-6/MAI-7 do not show Triage in Work while the board offers LAUNCH; MAI-5 does not appear as Backlog + PAUSED while Work says Abandoned; MAI-11 has one status word everywhere.
- Incoming tasks get either their own board column or a counter on the Incoming tab.

## Constraints
- Status must be derived at render/read time — no new persisted status field.
- All surfaces (task header, board, Work, Desk, Inbox, MCP) consume the same mapping; no local re-derivations.

## Out of scope
- Changing the underlying state machine: task statuses themselves, triage flow, qualification lifecycle.
- Redesign of individual screens beyond the status presentation.

## Links
None

## Open questions
- Final EN wording of the status vocabulary (e.g. Held vs Awaiting review vs Needs assessment).
- Should MCP expose the derived status string itself, or consistently named fields from which it is derived?
- Where Incoming lives on the board: own column vs tab counter only.

## Settings

- Testing: yes
- Logging: standard
- Docs: yes

## Roadmap Linkage

Milestone: "none"

Rationale: M51 introduced Work and Desk visibility. The roadmap does not name this cross-surface status change.

## Requirements Brief

- Give task detail, Board, Work, Desk, Inbox and MCP the same task status and semantic color for the same authorized task facts. Apply the same presentation to Incoming rows and the task-detail qualification summary. Keep assessment outcomes, run results, and attention event types as labeled contextual facts where they convey independent information.
- Derive a typed `displayStatus` at read time from task status, triage, current qualification and admission, task-level blockers, and the latest relevant Flow run. Derive from the same committed task facts per read. Reload the projection through existing refresh paths after a mutation or attention invalidation. Use one pure status resolver and one presentation catalog for stable keys, localized labels and semantic tones. Use the same catalog's English label and tone in MCP as structured data. The UI resolves the same key through EN/RU messages and theme tokens.
- Keep the task/run state machines, qualification publication and freshness, triage, manual/automatic admission, permissions and actions under their existing owners. No migration, runtime configuration, new deployment dependency, or persisted status.
- Use an Incoming tab counter backed by the existing Incoming membership predicate. Count the full authorized project population independently of tab filters and pagination. Exclude Incoming members from ordinary board columns, including configured tasks. Keep the existing Work and attention scope rules so a status change cannot hide actionable work.
- Extend MCP response schemas additively and retain raw fields for callers. UI status chips, task board grouping, Work status filter labels, and task-facing attention status all consume the projection. Keep operational categories, counts, and historical run fields where used for actions or workflow calculations.
- Regress the reported MAI-5 through MAI-26 cases using representative fixtures and compare the named tasks on the host when authorized reads are available. The observations describe the intake host. This branch already has partial Incoming header handling and the plan does not assume the host currently runs the same revision.

## Requirements Reconciliation

The Original Request governs presentation. `docs/system-analytics/tasks.md` (Current admission boundary), `docs/system-analytics/task-qualification.md` and `qualification-predicates.ts` govern membership and admission. ADR-170 and `docs/system-analytics/work-stages.md` govern existing Work stage calculations. Record the task-presentation change in the decision log under the repository's ADR rules. Keep stage-derived workflow behavior, including run progress, action grouping and the raw API stage. Reconcile existing Board lane names, Work filters and Desk labels explicitly with the new display contract.

Use this ordered decision table. Every row is a read-only projection. Tones are semantic tokens. Lock the EN/RU labels and token bindings in Phase 0. Use the lower snake case keys `abandoned`, `done`, `queued`, `in_progress`, `waiting_on_human`, `in_review`, `crashed`, `incoming`, `blocked`, `needs_review`, `ready`, and `backlog`. Fix the public tone enum to `neutral | accent | warning | danger | success`. Use matching task-row and task-column tones in light and dark themes.

| Priority and facts | Display label and tone | Existing authority and verification |
| --- | --- | --- |
| Persisted task `Abandoned` or `Done`, regardless of stale flags, qualification or old runs | Abandoned · neutral / Done · success | Task lifecycle and ADR-170 terminal precedence. MAI-5 regression with no run and with retained failed/abandoned history. No task Launch CTA. |
| Latest Flow run Pending, Running/Waiting/WaitingOnChildren, human-input/claim states, Review, or Crashed, with an intact workspace where required | Queued · neutral / In progress · accent / Waiting on human · warning / In review · accent / Crashed · danger | Reuse the run-to-work-stage interpretation in `web/lib/work/stage.ts`. Use one deterministic latest-Flow selector (`started_at DESC, id DESC` over Flow runs only. The schema makes `started_at` non-null). Scratch and qualifier runs do not replace the Flow run. |
| Task is InFlight with no visible Flow run | In progress · accent | Reservation/read gap. Verify this before evaluating pre-execution states, and use existing action gates. |
| Latest Flow run Done on a still-live task | Done · success | This describes delivered work in the read model. Preserve the live task’s existing actions, run completion evidence and workspace cleanup controls. Verify with and without a retained workspace. |
| Exact `incomingWorkPredicate()` membership | Incoming · neutral | Backlog + required + neither current accepted ready nor same-input manual admission + no delivery Flow outside Failed/Abandoned. MAI-8…26, including MAI-11 with a review reason. Qualifier attempt and configured flow do not remove Incoming membership. Verify matching total and no duplicate board card. |
| Live pre-execution task with durable open dependency or blocking clarification | Blocked · warning | Reuse existing relation and clarification predicates and authorized task scope. Check resolution restores the next status on refresh, with detail reason and existing actions available. |
| Remaining pre-execution task with a triage hold effective under the manual launch hold rules, or outstanding required qualification that has no current manual admission | Needs review · warning | Use qualification validity and `isManualTriageHold` from `web/lib/tasks/manual-launch-hold.ts`. Stale or unpublished assessment cannot grant readiness. A current manual admission can clear the presentation hold associated solely with qualification, while explicit holds remain effective. Retain the separate manual and automatic launch rules. Render actionable reason text where needed without using it as a second task status. |
| Remaining live pre-execution/retry task with currently configured Flow | Ready · success | MAI-6/7 regression for configured tasks with null triage. Verify Work shows Ready and does not direct the user to triage solely on a null verdict. Board Launch continues through existing permissions, live eligibility and admission checks. |
| Remaining live pre-execution task without a configured Flow, including triaged but unrouted rows | Backlog · neutral | Flowless legacy task can still expose configuration and triage actions. Failed/Abandoned attempts and removed Review/Crashed workspaces return to pre-execution evaluation independently of task abandonment. Preserve retained worktree actions and test both paths. |

The table assumes Incoming is the primary task status for all Incoming filters. For MAI-11, “Needs review” can describe the assessment when the user inspects its evidence. It is not a second task-status badge. For MAI-6/7, “Ready” describes the configured, otherwise unheld task; supervisor readiness, queue pause and actor-specific authorization still determine which launch action can be used. Test that actual Failed/Abandoned attempts still enter pre-execution evaluation for a live task. The InFlight/no-run rule only applies when the selected Flow row is absent. Do not infer a task's current status from the run referenced by an older Inbox item.

## TDD and acceptance

Write the named tests before behavior changes in each implementation task. Run the relevant case and record the intended failure (RED), make it pass (GREEN), then simplify and rerun the affected suite (refactor). Phase 0 uses contract assertions and docs validators before runtime implementation. Run every changed test through its declared project and include a regression assertion before changing behavior. A RED caused by missing infrastructure does not establish a regression. Keep policy cases in the resolver matrix, query and visibility cases in integrations, and one cross-surface scenario in Playwright. No test may pass solely by asserting a duplicated status table inside a consumer.

## Commit Plan

- After Tasks 1–3, `feat: define and apply shared task status on project screens`.
- After Tasks 4–6, `feat: surface shared task status in Work, attention and MCP`.

## Tasks

### Phase 0 — Specify the read contract

- [x] Task 1. Reconcile the status table and API contracts before implementation.
  - Test first (contract): add assertions in `mcp/src/__tests__/tool-contract.test.ts` for the shared response schema and route references, then add the ADR, analytics and schema until contract validation passes. Keep runtime parity checks for Task 5.
  - Update `docs/system-analytics/tasks.md` with the Designed read contract, precedence, fallback and invariant enforcement points. Cross-reference from `work-stages.md`, `task-qualification.md` and `attention.md`. Write ADR-218 and link its stub to the full record following `docs/CLAUDE.md`. Number the decisions for (1) projection ownership and precedence, (2) task column grouping and Incoming counter, (3) additive wire display contract and existing visibility. Record rejected alternatives and trade-offs for persisted status, local adapters, an Incoming lane, and MCP client inference. Supersede only ADR-170 clauses governing visible task status. Preserve existing write transition rules and separate action preconditions.
  - Define additive `displayStatus: { key, label, tone }` in `docs/api/external/operations.openapi.yaml` for `TaskDTO`, `InstallationTaskSummary`, `ExtTaskSearchHit`, `ExtWorkRow` and task-linked decision responses (`ExtDecisionItem` and each separate emitted task-bearing variant). Specify required on full task DTOs and search/work rows, optional for compact installation readers if their existing grant cannot disclose the projection, and present only for decision variants that expose an authorized task reference. Use an explicit stable key enum, tone enum, English label, examples and closed object shape. Reuse one shared component schema. Check shared serializers for mutation responses that return those same DTOs. Document null/absence for taskless decision items, and update affected examples. Audit `docs/api/web.openapi.yaml` and `docs/api/async/attention-stream.asyncapi.yaml` against the actual serializer changes before updating either.
  - Keep operation identifiers under current rules: project slug/task ID are validated URL locators with current project/task permission checks; actor, installation and membership come from auth context and server state; task/flow/qualification facts come from authorized database rows; search/filter/cursor inputs keep existing validation. Introduce no new request identifiers, effects, error codes, ERDs, or deployment wiring.
  - Logging: document use of existing auth/audit and failure logs. No status-specific success logs.
  - Verify: reconcile every table row and API example with referenced code paths, including the absent latest Flow and stale qualification cases. Run `pnpm validate:docs` and validate the edited OpenAPI spec before Phase 1.

### Phase 1 — Shared projection and project screens

- [x] Task 2. Implement one read projection and one status renderer. Depends on 1.
  - Test first (Vitest unit and integration): add `web/lib/tasks/__tests__/task-display-status.test.ts` for reachable resolver combinations and use `web/lib/queries/__tests__/board.integration.test.ts` for the batched latest-run and authorized facts path, including same-timestamp Flow runs and a newer qualifier.
  - Add pure typed resolver/catalog in `web/lib/tasks/task-display-status.ts`, server-only batch adapter in `web/lib/tasks/task-display-status-queries.ts` and shared status UI in `web/components/tasks/task-status-chip.tsx` with `web/messages/{en,ru}.json`. Use a single stable status key and semantic tone. Keep EN/RU label parity and verify MCP's English label against the UI catalog. Use the same tone binding for task chips and board headings.
  - Build on `qualification-predicates.ts` for exact membership and revision-aware qualification and the existing relation, clarification and latest-Flow read paths. Select minimal status facts in bounded operations on authorized project/task IDs, with existing transaction handles where appropriate. Do not fan out repository-digest checks from `getTaskQualificationSummaries` to list rows. Keep board/work row counts independent of per-task query count. Treat absent historical facts as typed cases in the table. Do not silently default a missing authorized projection to Backlog.
  - Logging: pure resolver and rendering emit no logs. Query failures propagate to the existing boundary with structured operation and scope fields.
  - Verify: unit project coverage for the ordered table, deterministic run selection, exhaustive token/label keys, and overlap cases including terminal + flagged and manually admitted + qualification blocked.

- [x] Task 3. Apply the projection to Board, Incoming and task detail. Depends on 2.
  - Test first (Vitest integration): extend `web/lib/queries/__tests__/{board,task-detail,board-failed-card}.integration.test.ts` for counter and exclusion, status parity and retained workspace controls. Use the Board interaction suite for terminal versus retry CTA visibility.
  - Wire `web/lib/queries/{board,incoming,task-detail}.ts`, the project route and task-detail route under `web/app/(app)/projects/[slug]/`, `web/components/board/{project-tabs,task-card,flight-card}.tsx` and `web/components/agents/incoming-requests.tsx`. Pass the same full count to each `ProjectTabs` caller, including project evaluations and observatory. Test a capped/filtered Incoming list against its uncapped tab total.
  - In `web/components/board/board.tsx` and the BoardData DTO, key task column grouping and headers by canonical status and add an Abandoned lane. Omit empty newly introduced lanes where feasible to keep the board compact. Preserve each task card’s backlog/flight model for controls and retain non-task scratch cards under their current operational grouping. Group every task card exactly once after Incoming exclusion. Remove task-stage, flag and paused badges that otherwise act as a second task status. Keep queue details and assessment facts explicitly contextual. Preserve terminal history and prevent misleading Launch UI on terminal task cards. Preserve retry and worktree controls for a live task whose run failed or was abandoned.
  - Update `web/lib/queries/__tests__/board.integration.test.ts` assertions for old task lanes and Incoming exclusions, `task-detail.integration.test.ts` for the added projection, and `web/components/board/__tests__/task-card-launch-reason.test.ts` where it asserts duplicate status text. Reuse `web/lib/queries/__tests__/board-failed-card.integration.test.ts` as a representative retained-worktree fixture. Keep independent board mechanics coverage in `web/lib/__tests__/board.test.ts`.
  - Logging: preserve existing action feedback and failure logs. Do not log status chip renders or counts.
  - Phase exit: confirm target unit/integration files appear in Vitest discovery and pass. Run `pnpm --filter maister-web test:unit` and `pnpm --filter maister-web test:integration`.

### Phase 2 — Work, attention and external consumers

- [ ] Task 4. Wire Work, Desk and Inbox. Depends on 2 and 3.
  - Test first (Vitest integration and DOM unit): extend `web/lib/queries/__tests__/{work-table,decisions}.integration.test.ts` and `web/components/work/__tests__/work-rows-table.dom.test.ts` for stable scope, historical decision links, canonical filter/legacy deep links and configured null-triage next action. Exercise taskless HITL and task-linked notification variants in their existing component suites.
  - Add the projection in `web/lib/queries/{work-table,decisions,inbox}.ts`. Enrich only authorized task rows and decisions, including nested HITL and legacy notification rows. Resolve status from the linked task's current facts. Retain event kind and non-task decision equivalents and avoid a task chip for projectless or taskless cards. Keep membership, alert ordering, actor visibility and action ownership under current predicates.
  - Render from the projection in `web/components/work/work-rows-table.tsx`, `web/app/(app)/page.tsx`, `web/components/inbox/{decision-card,hitl-inbox-list,hitl-card}.tsx` and `web/components/portfolio/inbox-panel.tsx`. Audit task-bearing callers of the Work stage chip and Desk counts. Use canonical status keys for the Work status facet and displayed counts over its existing authorized result set. Preserve stage-based internal Desk partitions and existing Work stage deep links by honoring legacy stage URL parameters with their original selection semantics. Render any legacy active filter as a workflow filter rather than a second task status. Preserve intrinsic operational group/decision names and the existing raw stage in API projections. Resolve next-action presentation against existing manual admission/routing facts so configured null-triage rows do not also offer “Triage it” while Board offers Launch. Do not make status a permission check.
  - Update `web/lib/queries/__tests__/{work-table,decisions}.integration.test.ts` projected DTO expectations, `web/components/work/__tests__/work-rows-table.dom.test.ts` chip/filter assertions, and `web/components/inbox/__tests__/hitl-card.test.ts` task-associated status copy. Preserve grouped and taskless behaviors. Add fixture coverage for the same task linked from historical and active decision items, with no status leak to unauthorized readers.
  - Logging: retain query/authorization boundary logs and audit. No per-row logs.

- [ ] Task 5. Expose the server-derived status in MCP. Depends on 2 and 4.
  - Test first (Vitest integration and MCP stdio): extend `web/app/api/v1/ext/__tests__/librarian-visibility.integration.test.ts` and `mcp/src/__tests__/stdio.integration.test.ts` for DTO and passthrough. Run current task/installation integration suites for full and compact list/get, including a restricted installation; assert exact status shape and continued exclusion of raw assessment/blocker details in compact payloads.
  - Extend `web/lib/services/tasks.ts` task DTOs for get/list and source lookup, `web/lib/queries/task-search.ts` returned hits, `web/lib/agents/installation-facade.ts` compact task reads, and `web/app/api/v1/ext/{work,decisions}/route.ts` explicit DTOs. Use batch enrichment after the existing authorized selection, inside the existing transaction for installation reads. Verify the existing installation `readBoard` grant permits the board-visible status alone; keep private qualification and blocker details server-side. If an existing authority further restricts status disclosure, omit the entire field from that compact response and describe the guard in the spec. Preserve filters, response pagination, raw state, scope, and source evidence capture. Check all task write responses that reuse `taskToDTO` for response consistency and correct post-write facts.
  - Update MCP tool descriptions in `mcp/src/tools.ts` and the relevant shipped instructions if they direct users to raw status for display. MCP transports the common key, English label and semantic tone without translating domain state or adding a tool. Keep `mcp/src/__tests__/{tools.test.ts,tool-contract.test.ts,stdio.integration.test.ts}` aligned with the documented additive shape.
  - Logging: preserve current installation audit, request/failure logging and MCP stdio behavior. Do not log qualification content or per-task success.
  - Verify: exercise authenticated task_get/list/search, source lookup, compact installation reads, work_list and registered decision reads on shared fixtures. Check raw fields/cursors and grant denial alongside exact label/tone match. Extend existing scoped search and Work coverage in `web/app/api/v1/ext/__tests__/librarian-visibility.integration.test.ts`.

- [ ] Task 6. Verify parity end to end and bring screen documentation current. Final GREEN and docs depend on Tasks 3–5.
  - Test first (Playwright): add the shared parity acceptance scenario in `web/e2e/work-table.spec.ts` before Task 2 changes runtime behavior (the RED step of this task precedes Tasks 2–5) and keep it as the final delivery gate. Reuse seeded task/Run fixtures and build assertions around one representative cross-surface task plus the four reported classes. Use `desk.spec.ts` for existing Desk action coverage.
  - Extend the existing Work and Desk Playwright paths in `web/e2e/{work-table,desk}.spec.ts` with the minimal representative task fixtures needed to cross task detail, Board, Incoming, Work, Desk and Inbox. Reuse existing seeded task/run helpers, especially the existing failed-card integration fixture for retry behavior. Cross-check projected API and stdio MCP output from the same fixture data. Ensure current status and semantic tone agree in EN and RU UI, with one status for MAI-11 and no BACKLOG chip for Incoming. Verify counts, focus/accessible text, light/dark tone consistency, and unchanged unauthorized outcomes. When the named host tasks are available, verify them read-only and record which scenarios were exercised via fixtures.
  - Mark Phase 0 design Implemented after parity passes. Align `docs/screens/{work,desk,inbox}.md`, the project Board/Incoming/task-detail screen references under `docs/screens/projects/`, and the public EN/RU task tour only where it describes affected status behavior. Run docs validators and check MCP examples against observed responses.
  - Logging: use existing test failure diagnostics and redact fixture tokens. No temporary production diagnostics.
  - Phase exit: confirm promised test files match their Vitest unit/integration projects or Playwright config using runner list commands. Run `pnpm --filter maister-web test:unit`, `pnpm --filter maister-web test:integration`, `pnpm --filter @maister/mcp test`, targeted Playwright and web/MCP typechecks. Update affected assertions in the same phase. If a pre-existing failure or unavailable harness prevents a green run, isolate and document the evidence and follow-up under repository test policy before accepting the phase.

## Open Questions

No blocking product decisions remain. The following reversible assumptions are carried by stable ID in the PlanReviewV1 companion.

| ID | Default and consequence |
| --- | --- |
| `status-vocabulary` | Use the labels and tones in the ordered table. Incoming applies to the entire authorized Incoming partition. Assessment outcomes remain available as evidence. |
| `mcp-display-shape` | Publish the additive server-owned key, English label, and tone. UI localization and existing raw fields continue to serve their own callers. |
| `incoming-placement` | Use the uncapped Incoming tab count and exclude Incoming tasks from ordinary board lanes, including routed tasks. |
| `run-selection` | Choose the latest Flow by started time and ID. Terminal task state wins despite historical run data. |
| `ready-semantics` | A configured, otherwise unheld task can display Ready with missing triage. Actor permissions, host readiness, and the write-side admission gate still own launch. |
| `work-compatibility` | Preserve authorized result membership and legacy stage deep links. Use canonical status in the visible task facet and keep stage for operational grouping. |
| `derived-only` | Use existing facts and indexes. There is no DB migration, deployment dependency, or state transition in this plan. |
| `host-verification` | Always use local representative fixtures. Verify MAI-5 through MAI-26 additionally on the intake host when an authorized reader is available. |
