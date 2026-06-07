# Implementation Plan: Improve Flow Graph Visual Drawings

Branch: codex/flow-graph-visual-drawings-plan
Worktree: /private/tmp/maister-flow-graph-visual-drawings-plan
Created: 2026-06-07

## Settings

- Testing: yes
- Logging: standard
- Docs: yes
- Mode: SDD-first, TDD implementation
- Multi-agent strategy: parallel implementation tracks with strict file ownership and RED -> GREEN -> REFACTOR checkpoints

## Roadmap Linkage

Milestone: M22 Workbench visibility follow-up
Rationale: This improves the shipped flow-graph workbench surface without changing Flow execution semantics.

## Research Context

Source: current repo reconnaissance for `web/lib/queries/flow-graph-view.ts`, `web/lib/queries/run-node-status.ts`, `web/lib/board/flow-graph-view-layout.ts`, `web/components/board/flow-graph-view.tsx`, `web/app/api/runs/[runId]/graph/{route.ts,__tests__/route.test.ts}`, `web/app/api/runs/[runId]/graph-status/{route.ts,__tests__/route.test.ts}`, `docs/system-analytics/workbench.md`, ADR-039, ADR-051, ADR-052, and M22 roadmap notes.

Goal:

- Make the execution graph visually legible for real graph flows, especially AIF-style lifecycle flows with planning, implementation, quality gates, human review, and rework loops.
- Keep the graph a view of `compileManifest(...)` and `node_attempts`; do not change runner semantics.

Constraints:

- Preserve React Flow + dagre as the renderer stack.
- Preserve SSE-triggered status refresh; no polling.
- Preserve the implemented ADR-051 DB-backed, project-scoped layout overrides unless Phase 0 proves a newer ADR-062/code path exists and explicitly rewrites this plan before implementation.
- Keep `flow.yaml` logic-only; no manifest schema or engine bump.
- EN + RU labels are required.
- No new env vars, ports, sidecars, or deployment wiring expected.

Decisions:

- Implement visual richness by enriching the graph read model and React Flow rendering: labels, node-kind affordances, declared-gate summaries, runtime gate/status summaries, edge labels, and loop styling.
- Keep gates inside their owning node in the flow graph. The separate evidence graph remains the detailed artifact/gate explorer.
- Keep static manifest-derived metadata in the `GET /graph` topology and runtime node/gate status in the `GET /graph-status` snapshot; do not add per-node API calls or DB reads to the pure topology transform.
- Do not render a terminal `done` pseudo-node in this follow-up. Terminal transitions stay omitted from topology edges, matching the existing M22 graph contract and avoiding confusion with promotion readiness.

Resolved questions:

- Terminal `done` stays omitted from topology edges; no pseudo-node or source-node terminal badge is added in this slice.
- `success` and `default` edges keep visible labels but stay visually quiet; review-loop outcomes (`rework`, `reject`, `takeover`) get animated/classed edge affordances.
- The ADR-062/read-only `flow.yaml` presentation-layout wording was stale for this branch. ADR-051 remains the implemented contract: DB-backed `flow_graph_layouts` overrides with `editFlowLayout`.

## Existing State

- `buildGraphTopology()` returns only `{ id, nodeType, label }` nodes and `{ source, target, outcome }` edges. Label currently equals node id.
- `toFlowGraphView()` passes `{ label, nodeType }` into React Flow nodes and preserves `outcome` on edge data, but the default edge renderer does not surface labels.
- `FlowNodeBody` renders a single HeroUI `Chip`, current-node ring, and invisible gate-rollup test marker. It does not show node type, gate count, review/rework semantics, or loop shape.
- Run detail already renders the graph in the workbench `Graph` tab using `loadRunManifest -> compileManifest -> buildGraphTopology`, `getFlowLayout`, and `getRunNodeStatuses`.
- `getRunNodeStatuses()` is the existing runtime read model for highest-attempt node status, gate statuses, blocking rollup, `runStatus`, and `currentStepId`.
- `GET /api/runs/[runId]/graph-status` is already the SSE-triggered live recolor path. It must stay event-triggered and must not become timer polling.
- `docs/system-analytics/workbench.md` and ADR-051 describe the current DB-backed layout store and `PUT /graph/layout`. The M22 roadmap wording drifts by mentioning authored `flow.yaml` presentation metadata, ADR-062, a dropped layout table, and read-only graph layout. Phase 0 must reconcile this before code changes.

## Contract Surfaces

- HTTP route response: `GET /api/runs/{runId}/graph` may add fields to `topology.nodes[]` and `topology.edges[]`; update `docs/api/web.openapi.yaml` if the route is specified there.
- HTTP route response: `GET /api/runs/{runId}/graph-status` may add runtime gate summary fields to `nodes[nodeId]`; update `docs/api/web.openapi.yaml`.
- Layout route: `PUT /api/runs/{runId}/graph/layout` and layout persistence remain in scope only if Phase 0 preserves ADR-051. If Phase 0 chooses a read-only/manifest-layout contract, this plan must be rewritten before implementation to include cleanup/removal tasks and migrations.
- UI route: `/runs/{runId}?wb=graph` changes visual rendering only.
- i18n: `web/messages/en.json` and `web/messages/ru.json` gain graph labels for node types, edge outcomes, gate summary, and terminal/loop wording.
- Docs: `docs/system-analytics/workbench.md`, `docs/decisions.md` ADR-051/052 notes if necessary, `.ai-factory/ROADMAP.md` M22 wording if current docs/code drift is confirmed.
- DB: no schema change expected.
- Config/deployment: no new env vars, ports, sidecars, package scripts, or compose changes expected.

## Multi-Agent TDD Plan

- Agent A, Read Model: owns `web/lib/queries/flow-graph-view.ts` and its tests.
- Agent B, Layout Transform: owns `web/lib/board/flow-graph-view-layout.ts` and pure layout tests.
- Agent C, React Rendering: owns `web/components/board/flow-graph-view.tsx`, presentational tests, i18n keys, and Playwright coverage.
- Agent D, Docs/Contracts: owns system analytics, API docs, roadmap/ADR drift, and final verification checklist.
- Agent E, Test Fixtures/Acceptance: owns deterministic unit fixtures and E2E seed changes needed for gated nodes, rework edges, and terminal no-refetch checks.
- Integration owner: runs full focused suite after each phase and resolves cross-track type mismatches. No two agents edit the same file in the same phase. Agent C starts component implementation only after Agent A/B metadata contracts are green.

## Commit Plan

- Commit 1 after Phase 0-1: `docs: specify richer flow graph view`
- Commit 2 after Phase 2-3: `feat: enrich flow graph topology and layout`
- Commit 3 after Phase 4-5: `feat: render flow graph visual semantics`
- Commit 4 after Phase 6: `test: cover flow graph workbench visuals`

## Tasks

### Phase 0: SDD Contract Alignment

- [x] Task 1: Reconcile graph layout contract across docs before code.
  - Files: `docs/system-analytics/workbench.md`, `docs/decisions.md`, `.ai-factory/ROADMAP.md`.
  - Confirm whether the product contract is the implemented ADR-051 DB-backed layout overrides or the newer roadmap wording about `flow.yaml` presentation metadata / ADR-062 / read-only layout.
  - Default decision: preserve ADR-051 and update stale roadmap wording unless an actual ADR-062 and implemented presentation-layout code exist in this branch.
  - If ADR-051 wins:
    - Keep `flow_graph_layouts`, `getFlowLayout`, `PUT /api/runs/[runId]/graph/layout`, `editFlowLayout`, and layout persistence tests in this plan.
    - Update `.ai-factory/ROADMAP.md` so it no longer claims read-only `flow.yaml` presentation layout for the current code line.
  - If roadmap/ADR-062 wins:
    - Stop and rewrite this plan before implementation.
    - Add explicit cleanup tasks for the layout table, route removal/read-only UI, docs/API/ERD changes, and any migration already implied by the target branch.
  - Acceptance:
    - The source-of-truth docs agree on layout storage, read/write behavior, RBAC, and graph scope.
    - The docs explicitly say this feature is visual/read-model only and does not change runner transitions.
    - The chosen layout path is named in the plan and downstream tasks refer to the chosen path consistently.
    - No implementation phase starts until this contract is internally consistent.

- [x] Task 2: Specify the enriched static graph DTO and runtime status DTO.
  - Files: `docs/system-analytics/workbench.md`, `docs/api/web.openapi.yaml`.
  - Proposed additive DTO fields:
    - `topology.nodes[].displayLabel`
    - `topology.nodes[].nodeTypeLabel`
    - `topology.nodes[].nodeRole` (`agent | command | check | judge | human | terminal | other`)
    - `topology.nodes[].declaredGateSummary` (`total`, `blocking`, `advisory`, `kinds[]`)
    - `topology.edges[].displayLabel`
    - `topology.edges[].edgeRole` (`success | default | rework | reject | takeover | approve | other`)
    - `graph-status.nodes[nodeId].gateSummary` (`total`, `blockingTotal`, `advisoryTotal`, `worstBlockingStatus`, `failedBlocking`, `staleBlocking`)
  - Acceptance:
    - Additive response shape is documented for both `GET /graph` and `GET /graph-status`.
    - Existing consumers can continue using `id`, `nodeType`, `label`, `source`, `target`, and `outcome`.
    - Open question about `done` pseudo-node is resolved in writing: terminal transitions stay omitted.
    - Static declared-gate metadata is not confused with runtime `gate_results` status.

- [x] Task 3: Add deterministic graph visual fixtures before RED tests.
  - Owner: Agent E.
  - Files: `web/lib/queries/__tests__/flow-graph-view.test.ts`, `web/lib/board/__tests__/flow-graph-view-layout.test.ts`, `web/components/board/__tests__/flow-graph-view.test.ts`, `web/e2e/_seed/seed-e2e.ts` if needed.
  - Fixture requirements:
    - At least one `ai_coding` node with `pre_finish.gates` containing blocking and advisory gates.
    - At least one human/review node with `approve`, `rework`, and/or `takeover` outcomes.
    - At least one unknown/custom transition outcome to prove fallback labeling.
    - A terminal transition to `done` matching the Phase 0 terminal decision.
  - Acceptance:
    - Unit tests use local deterministic fixtures, not ad hoc inline fragments that disagree across agents.
    - E2E seed can create a graph tab with a visible gated node and non-default edge without depending on unrelated AIF-flow work in another worktree.

### Phase 1: Read-Model RED Tests

- [x] Task 4: Write RED unit tests for enriched topology.
  - Owner: Agent A.
  - Files: `web/lib/queries/__tests__/flow-graph-view.test.ts`.
  - Tests:
    - Graph nodes expose humanized `displayLabel` while preserving `label === id` for backward compatibility.
    - Node type maps to stable `nodeRole`.
    - A node with `pre_finish.gates` exposes `declaredGateSummary`.
    - Non-terminal edges expose `displayLabel` and `edgeRole`, including fallback behavior for unknown/custom outcomes.
    - Terminal `done` behavior matches the Phase 0 decision.
  - RED command:
    - `pnpm --filter maister-web exec vitest run --project unit lib/queries/__tests__/flow-graph-view.test.ts`
  - Acceptance:
    - Tests fail because the fields are absent, not because of type errors or bad fixtures.

- [x] Task 5: Implement minimal topology enrichment.
  - Owner: Agent A.
  - Files: `web/lib/queries/flow-graph-view.ts`.
  - Requirements:
    - Use pure functions for label/role mapping.
    - Do not import UI components or client-only code.
    - Do not query DB; this remains a pure `FlowGraph -> GraphTopology` transform.
    - Keep runtime status/gate verdict fields out of topology; those belong to `getRunNodeStatuses()`.
  - GREEN command:
    - `pnpm --filter maister-web exec vitest run --project unit lib/queries/__tests__/flow-graph-view.test.ts`
  - Acceptance:
    - New topology tests pass.
    - Existing topology tests still pass without assertion weakening.

### Phase 2: Runtime Status and Layout Transform RED Tests

- [x] Task 6: Write RED unit tests for enriched runtime gate summaries.
  - Owner: Agent A.
  - Files: `web/lib/queries/__tests__/run-node-status.test.ts` or the existing closest `run-node-status` test file.
  - Tests:
    - Highest-attempt node snapshot exposes `gateSummary`.
    - Blocking/advisory counts are separated.
    - `worstBlockingStatus` follows the existing priority order used by `blockingRollup`.
    - A node without gates exposes a stable zero summary.
  - RED command:
    - `pnpm --filter maister-web exec vitest run --project unit lib/queries/__tests__/run-node-status.test.ts`
  - Acceptance:
    - Tests fail because runtime summary fields are absent, not because DB fixtures are invalid.

- [x] Task 7: Implement runtime gate summary enrichment.
  - Owner: Agent A.
  - Files: `web/lib/queries/run-node-status.ts`, `web/app/api/runs/[runId]/graph-status/__tests__/route.test.ts`, `docs/api/web.openapi.yaml`.
  - Requirements:
    - Preserve existing `gates` and `rollup` fields for compatibility.
    - Reuse the existing highest-attempt and gate-priority logic; do not introduce a second query path.
    - Keep `GET /graph-status` authorized by server-derived `projectId` and `readBoard`.
  - GREEN command:
    - `pnpm --filter maister-web exec vitest run --project unit lib/queries/__tests__/run-node-status.test.ts`
    - `pnpm --filter maister-web exec vitest run --project unit 'app/api/runs/[runId]/graph-status/__tests__/route.test.ts'`
  - Acceptance:
    - Runtime status tests pass.
    - Route tests show additive response shape and unchanged auth.

- [x] Task 8: Write RED pure-transform tests for visual metadata.
  - Owner: Agent B.
  - Files: `web/lib/board/__tests__/flow-graph-view-layout.test.ts`.
  - Tests:
    - React Flow nodes carry `displayLabel`, `nodeTypeLabel`, `nodeRole`, and `declaredGateSummary` in `data`.
    - Edges carry `displayLabel` and `edgeRole` in `data`.
    - Rework/takeover/reject edges receive visual markers (`animated`, className, or marker style) without changing source/target.
    - Unknown/custom edge outcomes use the fallback role/label without throwing.
    - Stored layout overrides still win over dagre positions.
  - RED command:
    - `pnpm --filter maister-web exec vitest run --project unit lib/board/__tests__/flow-graph-view-layout.test.ts`
  - Acceptance:
    - Tests fail only on absent metadata/styling.

- [x] Task 9: Implement layout transform metadata propagation.
  - Owner: Agent B.
  - Files: `web/lib/board/flow-graph-view-layout.ts`.
  - Requirements:
    - Keep dagre baseline behavior and override merge unchanged.
    - Keep node dimensions stable to avoid layout shift.
    - Define edge style mapping in pure helpers.
    - If Phase 0 preserves ADR-051, keep stored layout overrides and `editable` behavior unchanged.
    - If Phase 0 switches to read-only manifest layout, stop and rewrite this task before coding.
  - GREEN command:
    - `pnpm --filter maister-web exec vitest run --project unit lib/board/__tests__/flow-graph-view-layout.test.ts`
  - Acceptance:
    - Layout tests pass.
    - No behavior change for existing `Pending/Running/Succeeded/Failed` status color mapping.

### Phase 3: Component RED Tests

- [x] Task 10: Write RED render tests for richer node body and edge labels.
  - Owner: Agent C.
  - Files: `web/components/board/__tests__/flow-graph-view.test.ts`.
  - Tests:
    - Node body renders display label, node type label, and status label accessibly.
    - Declared gate count and runtime gate summary render visible text or icon+tooltip for blocking/advisory gates.
    - Human/review node has a distinguishable role affordance from agent/check nodes.
    - Edge label render unit is covered through a named presentational export if a custom edge component is introduced.
  - RED command:
    - `pnpm --filter maister-web exec vitest run --project unit components/board/__tests__/flow-graph-view.test.ts`
  - Acceptance:
    - Tests fail because visuals are not present.

- [x] Task 11: Implement richer graph rendering.
  - Owner: Agent C.
  - Files: `web/components/board/flow-graph-view.tsx`.
  - Requirements:
    - Use React Flow custom node/edge renderers (`BaseEdge`, `EdgeLabelRenderer`, or established React Flow primitives), not hand-rolled SVG.
    - Use HeroUI/Tailwind existing forest tokens; no new component library.
    - Keep text fitting within fixed node dimensions; no viewport-scaled font sizes.
    - Keep current-node `aria-current` and status tooltip behavior.
    - Keep nodes non-connectable and layout persistence behavior unchanged.
    - Preserve SSE-triggered `graph-status` refetch behavior: event-driven, debounced, no timer polling, no refetch after terminal run status.
  - GREEN command:
    - `pnpm --filter maister-web exec vitest run --project unit components/board/__tests__/flow-graph-view.test.ts`
  - Acceptance:
    - Component tests pass.
    - No client import of server-only modules.

### Phase 4: i18n and Run Page Wiring

- [x] Task 12: Add EN/RU graph labels and wire them through run detail.
  - Owner: Agent C.
  - Files: `web/messages/en.json`, `web/messages/ru.json`, `web/app/(app)/runs/[runId]/page.tsx`, `web/components/board/flow-graph-view.tsx`.
  - Labels:
    - Node roles: Agent, Command, Check, Judge, Human review, Terminal.
    - Static declared gates: "No gates", "{n} declared gates".
    - Runtime gate summary: "{n} gates", "{n} blocking", "{n} failed", "{n} stale".
    - Edge outcomes: Success, Default, Rework, Reject, Takeover, Approve, Custom.
  - Acceptance:
    - EN and RU keys are complete.
    - `i18n-readiness-keys` style tests remain green.
    - The run page passes labels from server translations; no hard-coded UI prose in the client component beyond stable ids/test attributes.

- [x] Task 13: Preserve route, graph-status, layout, and RBAC semantics.
  - Owner: Integration owner.
  - Files: `web/app/api/runs/[runId]/graph/route.ts`, `web/app/api/runs/[runId]/graph/__tests__/route.test.ts`, `web/app/api/runs/[runId]/graph-status/route.ts`, `web/app/api/runs/[runId]/graph-status/__tests__/route.test.ts`, `web/app/api/runs/[runId]/graph/layout/route.ts` if Phase 0 preserves ADR-051.
  - Identifier audit:
    - `runId`: url-param.
    - `projectId`: server-state from loaded run manifest.
    - `flowId`: server-state from loaded run manifest.
    - `nodeId`: body-controlled only on layout PUT and validated against the pinned manifest before write.
  - Acceptance:
    - `GET /graph` and `GET /graph-status` still require active session and `readBoard`.
    - Layout `PUT` still requires `editFlowLayout` if ADR-051 is preserved.
    - No new write path or body-controlled cross-resource id is introduced.
    - Existing route tests pass with additive DTO fields.

### Phase 5: Playwright Visual Acceptance

- [ ] Task 14: Add E2E coverage for visual graph semantics.
  - Owner: Agent C with Agent E fixture support and Integration owner review.
  - Files: `web/e2e/m22-workbench.spec.ts`, `web/e2e/_seed/seed-e2e.ts` if needed.
  - Tests:
    - Open `/runs/{runId}?wb=graph`.
    - Assert at least one node shows a display label and node type label.
    - Assert a node with gates shows visible declared and runtime gate summaries.
    - Assert a rework/takeover/reject edge label is visible for a seeded graph.
    - Assert layout persistence still works if Phase 0 preserves ADR-051.
    - Assert no `…/graph-status` request fires after the seeded run is terminal.
  - RED command:
    - `pnpm --filter maister-web exec playwright test web/e2e/m22-workbench.spec.ts --project chromium`
  - GREEN command:
    - Same command after implementation.
  - Acceptance:
    - Test fails before component work and passes after.
    - No brittle pixel assertions; use accessible names/test ids and API-backed setup.
  - Status:
    - Visual assertions were added to `web/e2e/m22-workbench.spec.ts` using the existing M22 seed graph.
    - The Playwright command is not green in this environment because the dev server fails before graph assertions with Next login baseline errors; see Verification Notes.

### Phase 6: Verification and Docs Completion

- [x] Task 15: Run focused unit suites.
  - Owner: Integration owner.
  - Commands:
    - `pnpm --filter maister-web exec vitest run --project unit lib/queries/__tests__/flow-graph-view.test.ts`
    - `pnpm --filter maister-web exec vitest run --project unit lib/queries/__tests__/run-node-status.test.ts`
    - `pnpm --filter maister-web exec vitest run --project unit lib/board/__tests__/flow-graph-view-layout.test.ts`
    - `pnpm --filter maister-web exec vitest run --project unit components/board/__tests__/flow-graph-view.test.ts`
    - `pnpm --filter maister-web exec vitest run --project unit 'app/api/runs/[runId]/graph/__tests__/route.test.ts'`
    - `pnpm --filter maister-web exec vitest run --project unit 'app/api/runs/[runId]/graph-status/__tests__/route.test.ts'`
  - Acceptance:
    - All focused unit tests pass.

- [x] Task 16: Run docs and i18n checks.
  - Owner: Agent D.
  - Commands:
    - `pnpm validate:docs`
    - `pnpm --filter maister-web exec vitest run --project unit lib/__tests__/i18n-readiness-keys.test.ts`
  - Acceptance:
    - Mermaid validation passes.
    - EN/RU key parity remains green.

- [ ] Task 17: Run UI acceptance.
  - Owner: Integration owner.
  - Commands:
    - `pnpm --filter maister-web exec playwright test web/e2e/m22-workbench.spec.ts --project chromium`
  - Acceptance:
    - Workbench graph visual test passes.
    - Existing Files and Diff tab assertions remain green.
  - Status:
    - Blocked by the existing Playwright dev-server/login baseline failure before the graph route loads; see Verification Notes.

- [ ] Task 18: Final full-suite gate or explicit baseline note.
  - Owner: Integration owner.
  - Commands:
    - `pnpm --filter maister-web test`
  - Acceptance:
    - If full suite is green, record it.
    - If unrelated baseline failures remain, record exact failing files and error messages, and keep focused suites green.
    - Do not mark the implementation complete with new red tests.
  - Status:
    - Focused graph suites are green.
    - The full unit lane is blocked by unrelated capability catalog baseline failures.
    - The integration lane is blocked by unavailable testcontainers runtime.

## Implementation Notes

- Prefer adding pure helpers near `flow-graph-view.ts` / `flow-graph-view-layout.ts` before touching React component code.
- Avoid a new DB migration if Phase 0 preserves ADR-051. If Phase 0 chooses the roadmap's read-only/manifest-layout contract, this plan must be rewritten to include the required layout-storage cleanup/migration tasks before implementation.
- Avoid per-node API calls. All graph visual data must arrive in the existing graph DTO and status snapshot.
- Keep manifest/static metadata and runtime status metadata separated: `GET /graph` explains what the graph is; `GET /graph-status` explains what happened in this run.
- Quote App Router paths containing `[runId]` in shell commands.
- Keep the Evidence Graph as the detailed artifact/gate explorer; this feature only makes the Flow Graph readable at a glance.
- The current planning branch does not include the uncommitted AIF-flow updates from `/Users/developer/.codex/worktrees/607f/mAIster`. If those changes are kept, implementation should rebase/branch after they are committed or manually account for the additional AIF nodes (`explore`, `improve`, `capture`, `quality`, `fix`).

## Verification Notes

- `$aif-fix review findings` fixed the post-review gaps: unknown/custom edge outcomes now prefer the computed `displayLabel`, live graph-status snapshots update local terminal `runStatus` so terminal runs stop refetching, and gate-summary rows wrap/truncate inside fixed-width nodes.
- `$aif-fix review findings` fixed the final review gaps: graph count labels now use non-ICU `$count` templates so server translation lookup does not require runtime values, OpenAPI marks the emitted visual DTO fields as required, and the SDD plan records the terminal `done` omission decision.
- `pnpm --filter maister-web exec vitest run --project unit components/board/__tests__/flow-graph-view.test.ts` passed: 13 tests.
- `pnpm --filter maister-web exec vitest run --project unit lib/queries/__tests__/flow-graph-view.test.ts lib/queries/__tests__/run-node-status.test.ts lib/board/__tests__/flow-graph-view-layout.test.ts components/board/__tests__/flow-graph-view.test.ts 'app/api/runs/[runId]/graph/__tests__/route.test.ts' 'app/api/runs/[runId]/graph-status/__tests__/route.test.ts' 'app/api/runs/[runId]/graph/layout/__tests__/route.test.ts' lib/__tests__/i18n-readiness-keys.test.ts` passed: 90 tests.
- `pnpm --filter maister-web typecheck` passed.
- `pnpm validate:docs` passed: 6/6 Mermaid blocks.
- `pnpm --filter maister-web lint` completed with no errors and 3 pre-existing warnings outside this feature scope; unrelated `eslint --fix` churn was reverted.
- `git --no-pager diff --check` passed.
- `rg -n "setInterval|router\\.refresh|setTimeout|graph-status" web/components/board/flow-graph-view.tsx web/lib/use-run-stream.ts web/lib/runs 'web/app/api/runs/[runId]/graph-status'` found no new graph polling; the graph component still uses the existing debounced SSE-triggered `graph-status` fetch.
- `pnpm --filter maister-web exec playwright test web/e2e/m22-workbench.spec.ts --project chromium` is blocked in this environment before graph assertions by the Next dev-server/login baseline: `InvariantError: Expected workStore to be initialized. This is a bug in Next.js. page: '/login'`, `Invalid hook call`, `Cannot read properties of null (reading 'useInsertionEffect')`, then webServer timeout.
- `pnpm --filter maister-web test` is not green because the repo-wide unit lane has unrelated capability catalog failures in `lib/capabilities/__tests__/catalog.m14.test.ts` and `lib/capabilities/__tests__/catalog.test.ts`: `upsertCapabilitiesFromConfig failed: tx.select is not a function`.
- `pnpm --filter maister-web test:integration` is blocked by environment baseline: `Could not find a working container runtime strategy` for testcontainers/Postgres suites.
