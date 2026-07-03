# Experiment Comparison Studio, Phase 1

- **Branch:** `feature/experiment-comparison-studio`
- **Created:** 2026-07-03
- **Planner:** Codex via `$aif-plan`
- **Refined:** 2026-07-03 via `$aif-improve` (pass 1); 2026-07-03 via
  `$aif-improve` pass 2 — SDD/TDD deep-check against the Tact-2 FINAL request
  plus four code-verification sweeps (launch/relaunch, capabilities/adapters,
  DB/authz/MCP/docs, diff/UI/GC/agents).
- **Mode:** full
- **Status:** Draft implementation plan
- **Worktree note:** The planning run was executed from a detached Codex
  worktree. The intended implementation branch is recorded above; do not assume
  the branch already exists.

## Settings

- **Testing:** yes. Use the requested RED -> GREEN -> REFACTOR flow.
- **Logging:** verbose structured logs at domain boundaries, launch fan-out,
  snapshot capture, GC holds, judge dispatch, and external-token reads. Use
  stable fields, not interpolated dynamic message strings.
- **Docs:** yes. Phase 0 is docs/contracts-first and must pass validation before
  production code begins.
- **Scope:** Phase 1 only: create and compare experiment runs. No new SSE event
  family, no new domain-event outbox topic, no new long-lived sidecar, and no
  extra database tables beyond `experiments` and `experiment_runs`.

## Improve Pass Summary

Pass 1 added the SDD contract gate, exact response-shape/auth-first rules, the
MCP facade read task, judge-advisory persistence in the `experiments.verdict`
envelope, and migration/journal/test-runnability gates.

Pass 2 (this revision) re-verified every seam against the code and realigned
the plan with the Tact-2 FINAL request:

- **Comparable FSM fixed to the request definition:** comparable ⇔ every
  member run status ∈ {Review} ∪ terminal AND ≥2 distinct variants have ≥1
  member run. It is status-based, not snapshot-based; snapshots are best-effort
  evidence captured at the same transition.
- **Immutability moved to creation time:** variants and rubric are immutable
  from experiment creation (request AC: post-create edit attempt →
  `PRECONDITION`), not "after first launch".
- **Error-code split fixed:** create-time base-ref problems → `CONFIG`;
  `POST /api/runs` `baseCommit` missing/unreachable → `PRECONDITION`.
- **Judge advisory write path closed (was a contradiction):** pass 1 stored
  advisories in `experiments.verdict.judgeAdvisories[]` but forbade mutating
  MCP tools, leaving the judge no write path. Resolution follows the shipped
  `triage_set` precedent: a narrow ext op
  `POST /api/v1/ext/.../experiments/{experimentId}/advisory` + MCP tool
  `experiment_advise` + new scope `experiments:advise` (advisory-append only,
  never `human`/status).
- **Files-matrix-under-truncation hole closed:** new
  `experiment_runs.diff_files_summary` jsonb captured from the FULL diff before
  the 512 KB text cap, so the Files tab stays complete after GC/truncation.
- **FR-2a made mechanical:** manual ADR-119 relaunch is task-scoped today (no
  source-run id in the body), so membership inheritance gets an explicit
  optional `relaunchOfRunId` on `POST /api/runs`; budget-restart inherits from
  its `triggerPayload` source run. Bare task launches never inherit (owns the
  "non-member run on the same task" edge).
- **Member budget-restart force gate:** `launchBudgetRestart` passes
  `allowConcurrent: false`; with live sibling variant runs on the same task the
  manual launchability gate refuses `busy`. Member restarts must select the
  force gate.
- **Overlay support matrix precision:** `ENFORCEABILITY_BY_AGENT` has NO
  subagent axis and no claude-only cells; a NEW overlay-class×adapter support
  constant is required for the refusal semantics.
- **Choke-point files corrected:** the primary Review flip is
  `web/lib/runs/resume-driver.ts` (line ~298), not only `state-transitions.ts`;
  diff production/summary live in `web/lib/diff/prepare.ts`
  (`prepareDiff`/`prepareDiffSummary`), not `web/lib/runs/diff-*`.
- **On-read status verification added** (request §3 demands choke-point
  recompute + on-read verification).
- **AC set renumbered to the request-canonical AC-1..AC-11** and the
  traceability matrix now maps FRs and ACs to tasks AND owning test tiers.
- **UI maturity details pinned:** diff pair selector for N>2, replicate
  selector (default latest), queue position + duration in the matrix,
  ai_judgment confidence in Gates, honest "tokens, not $" Cost tab, rubric
  editor pre-filled from the platform default template, judge-availability
  states, e2e asserts both locales.

## Roadmap Linkage

- **Roadmap slice:** Phase 2 candidate: A/B benchmark runs and the Wave 3
  benchmarking moat.
- **Why now:** The existing stack already has run sessions, capability
  materialization, run-cost rollups, gate results, diff rendering, and
  worktree GC. This feature composes those primitives into a controlled
  comparison studio instead of adding a parallel execution substrate.
- **Related milestones already in repo:** M14 scoped capability
  materialization, M27 Flow Studio foundation, M34 platform-agent substrate, M41
  unified run sessions, M42 cost/run transparency, and ADR-125 budget restart.

## Source Request Summary

The final planning request asks for an Experiment Comparison Studio that lets an
operator run the same task N ways from the same pinned base commit, compare
diffs/files/gates/cost, record a human rubric verdict, and optionally ask an
advisory judge agent for a recommendation. The request explicitly requires:

- SDD docs-first Phase 0.
- TDD with unit render tests, real-Postgres integration tests, mock ACP run-flow
  tests, and one stub-supervisor E2E (both locales).
- Two tables only: `experiments` and `experiment_runs`.
- Optional `baseCommit` on `POST /api/runs`, reachable from the server-derived
  base branch (`PRECONDITION` otherwise).
- Variant overlays through the existing capability resolver/materializer seams,
  not a second materialization path; class×adapter incompatibility refuses at
  launch (`CONFIG`), never degrades silently.
- Relaunch inheritance for experiment-member runs (FR-2a), including ADR-125
  budget restarts, in the same transaction as the run insert.
- No new domain events or SSE contract in Phase 1.
- `experiments:manage`, `experiments:conclude` (any project member), external
  `experiments:read` scope semantics; conclusion is human-only (M17 rule).
- Rubric-as-data with the fixed default criteria set; ONE rubric drives the
  human form, the judge prompt, and the DTO.
- Explicit coordination with the in-flight Tact 3 auto-promotion branch.

## Current Repo Recon Snapshot (verified 2026-07-03 against this checkout)

Launch / relaunch:

- `POST /api/runs` (`web/app/api/runs/route.ts:28-49`) accepts `taskId`,
  `flowId`, `runnerId`, `baseBranch`, `targetBranch`, `deliveryPolicy`,
  `executionPolicy`, `packageVersions`, `allowConcurrent`, `brainContext`.
  Auth-first holds (`requireActiveSession()` before body parse). There is NO
  base-commit field and NO source-run id field today.
- `launchRun` (`web/lib/services/runs.ts`): `baseBranch` =
  `input.baseBranch ?? task.baseBranch ?? project.mainBranch`; `baseCommit` is
  resolved via `resolveBaseCommit()` (prefers `origin/<base>`) and stored on
  `workspaces.base_commit` (schema line ~1664) inside the SAME launch
  transaction as the run + workspace + run_sessions inserts. Attempt numbers
  are allocated atomically (`tasks.attemptNumber + 1` UPDATE) BEFORE worktree
  creation; branch naming is `${prefix}task-${task.id}/attempt-${n}` — unique
  per (task, attempt), so concurrent same-task launches are already safe.
- `web/lib/worktree.ts`: `resolveBaseCommit` (line ~291, `rev-parse --verify
  <ref>^{commit}`) exists; `addWorktree` already accepts a `startPoint`.
  There is NO ancestor/reachability validator yet (`merge-base --is-ancestor`
  must be added).
- `web/lib/runs/launchability.ts`: `classifyManualTaskLaunchability` (refuses
  `busy`) vs `classifyForceRelaunchLaunchability` (ADR-119 force gate; only
  `flagged > blocked` refuse).
- Run-status choke points: `web/lib/runs/state-transitions.ts` (guarded
  checkpoint/resume/rework helpers) AND `web/lib/runs/resume-driver.ts` (~line
  298 — the primary `Review` flip). Other `runs.status` writers:
  `web/lib/services/runs.ts` (launch), `web/lib/services/hitl.ts` (budget
  composites), the generalized run-stop dispatcher, reconcile (`Crashed`),
  promote (`Done`), workbench `dropWorkspaceAndAbandondRun`.
  `runs.review_entered_at` does NOT exist on this checkout (it is Tact 3's
  migration 0089).
- ADR-125 budget restart: `launchBudgetRestart` (`web/lib/services/hitl.ts`
  ~2355) → `loadBudgetRestartOptions()` copies task/flow/runner/branches from
  the source run and calls `launchRun` with a `triggerPayload` that references
  the source `runId` and `allowConcurrent: false`.
- `web/app/api/runs/[runId]/recover/route.ts` is crashed-run RECOVERY
  (`resumeCrashedRun`), not relaunch; manual ADR-119 relaunch is
  `POST /api/runs` with `allowConcurrent: true` (task-scoped, no run id).

Capabilities / adapters:

- All four seam functions exist: `buildResolvedCapabilitySet`
  (`web/lib/capabilities/resolver.ts:44`), `pinCatalogToSnapshot` (:95),
  `resolveCapabilityProfile` (:310), `materializeCapabilityProfile`
  (`web/lib/capabilities/materialize.ts:228`).
- Profile selection keys: `selectedMcpIds`, `selectedSkillIds`,
  `selectedRuleIds`, `selectedAgentDefinitionIds`, `selectedRestrictionIds`.
  Overlay classes map onto them: rules→ruleIds, skills→skillIds, mcps→mcpIds,
  subagents→agentDefinitionIds.
- `ENFORCEABILITY_BY_AGENT` (`web/lib/flows/enforcement.ts:28-74`) covers
  enforcement classes only (`mcps, tools, skills, restrictions, permissionMode,
  workspaceAccess, hooks`), all `instructed` for all five agents; it has NO
  subagent axis. The overlay class×adapter refusal needs a NEW constant.
- Exec-trust gate: `gateStdioMcpsByExecTrust`
  (`web/lib/capabilities/agent-map.ts:217-224`) filters stdio MCPs at
  materialization before `session/new`; overlay-added MCPs flow through it
  automatically.
- Flow node profile resolution: `web/lib/flows/graph/runner-graph.ts:1627-1643`
  calls `resolveCapabilityProfile` from the compiled node `settings`; NO
  per-launch override input exists on this path today — this is the overlay
  merge seam.
- Materialized profile snapshot: `.maister/capabilities/<runId>/<nodeAttemptId>/
  profile.json` via `atomicWriteJson`; plan digests in `materialization_plans`.
- The scratch launch capability input is per-class id arrays
  (`web/lib/scratch-runs/types.ts:52-60`); `CapabilityComposer` is a prompt
  text editor, not a profile UI — the variant overlay editor is new UI reusing
  catalog pickers, while the RESOLVER/MATERIALIZER reuse is the binding
  requirement.

Data / evidence:

- `run_cost_rollups` / `node_attempt_cost_rollups` columns: `inputTokens`,
  `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, plus
  `resumeInputTokens`/`resumeOutputTokens`/`resumeCacheReadTokens`/
  `resumeCacheCreationTokens`, `byModel`/`byRunner` jsonb, `sourceEventCount`.
  There is NO duration and NO resume-count column — duration derives from
  `runs.startedAt/endedAt`; session/respawn count derives from `run_sessions`.
- Gate results: `gate_results` (`runId`, `nodeAttemptId`, `gateId`, `kind`,
  `mode`, `status`, `verdict` jsonb `{verdict, confidence, reasons,
  calibration}`) — feeds the Gates tab incl. ai_judgment confidence.
- Diff surface: `web/app/api/runs/[runId]/diff/route.ts` returns `{runId,
  scope, scopes, baseCommit, sourceBranch, targetBranch, diff, truncated,
  files[{path,status,additions,deletions}], perFile, renderUnavailableReason}`.
  `web/lib/diff/prepare.ts` exposes `prepareDiff(rawDiff, truncated)` and
  `prepareDiffSummary(rawDiff, truncated)`; `DiffView`
  (`web/components/workbench/diff-view.tsx`) renders `PreparedFile[]` plain
  DTOs (ADR-066 pattern confirmed).
- Review comments (ADR-072) anchor to `review_comments` rows keyed by
  `hitlRequests` + `nodeId` + `gateAttempt` — they live on the run's review
  surface, not generically on diffs.
- Central run-status chip mapping: `web/lib/runs/run-status-tone.ts`
  (`RUN_STATUS_KEYS`, tones, dot/badge classes) + localized labels in
  messages. Per-node status: `web/components/workbench/node-status-icon.tsx`
  (no prebuilt strip — compose it).

Authz / tokens / MCP / agents:

- `PROJECT_ACTION_MIN` map in `web/lib/authz.ts:45-70` (roles
  `viewer|member|admin|owner`; e.g. `readBoard: "viewer"`,
  `launchRun: "member"`); `requireProjectAction` exists (:294).
- `web/types/token-scopes.ts`: `TOKEN_SCOPES` + fixed `AGENT_TOKEN_SCOPES`
  (includes `comments:create`, `tasks:read`, `flows:read`, `memory:*`).
  Scope→action mapping: `PROJECT_ACTION_BY_SCOPE` in
  `web/lib/tokens/ext-handler.ts:84-105`.
- Mutating agent-facing precedent: ext
  `POST /api/v1/ext/projects/[slug]/tasks/[taskId]/triage` →
  `applyTriageVerdict` (`web/lib/services/triage.ts:170`), mirrored by MCP tool
  `triage_set` in `mcp/src/tools.ts` (TOOL_SPECS is a hand mirror of the ext
  zod — sweep on any route-body change), guarded by
  `mcp/src/__tests__/tool-contract.test.ts`.
- Platform agents: `launchAgentRun` (`web/lib/agents/launch.ts`),
  `issueAgentRunToken` (`web/lib/agents/tokens.ts`); package agent definitions
  live at `maister-agents/<stem>.md` (fixture:
  `web/lib/agents/__tests__/fixtures/core-package/maister-agents/triager.md`;
  plugins repo: `/repos/maister-plugins/packages/core/
  maister-agents/triager.md`); `triager-definition.test.ts` exists.
- MCP package is `@maister/mcp` with `test:unit`/`test:integration` vitest
  projects.

GC / lifecycle / UI chrome / harness:

- `web/lib/gc/workspace-gc.ts` `loadCandidates` already carries the
  shared-tree `treeNotBlocked` predicate (OR of workspaceMode/rootRunId/
  agentWorkspace checks + a `notExists` sibling subquery) — the experiment hold
  extends this exact shape.
- `web/lib/workbench-lifecycle/service.ts` has NO hold predicate; manual ops
  are state-gated per run/workspace (`requireActionAllowed`).
- Project navigation: `web/components/board/project-tabs.tsx` — hardcoded
  `TABS` array + i18n labels + `hrefFor()`; existing tabs use
  `/projects/{slug}?tab=…` hrefs, so the Experiments entry will point at the
  nested route instead (request-mandated pages).
- Session project API routes live under `web/app/api/projects/[slug]/…`
  (tasks, flows, schedules, agents, …); ext routes under
  `web/app/api/v1/ext/projects/[slug]/…`. Both keyed by slug.
- Docs artifacts exist: `docs/database-schema.md`, `docs/db/erd.md`,
  `docs/screens/README.md` + `docs/screens/projects/*.md` (R5-style skeleton),
  `docs/api/web.openapi.yaml`, `docs/api/external/operations.openapi.yaml`,
  AsyncAPI under `docs/api/async/` + `docs/api/external/`.
  Root `pnpm validate:docs` runs BOTH `validate-docs-mermaid.mjs` AND
  `validate-docs-adr-anchors.mjs`.
- Vitest projects `unit` + `integration` in web (globs include
  `app/**/__tests__` and `*.integration.test.ts`); `test:e2e` = playwright;
  `web/e2e/global-setup.ts` exists; `web/app/api/runs/__tests__/` already has
  `post-branch.test.ts`, `relaunch-concurrency.integration.test.ts`, etc.
- Naming convention: board entities use `title` (`tasks.title`,
  `flows.title`); registries use `name` (`projects.name`).
- No experiment API/UI files exist today under `web/app` or `web/components`.

## Numbering And Merge Coordination

Current checkout state at planning time (re-verified 2026-07-03):

- Main worktree HEAD: `e27bd51d`. This Codex worktree: detached at the same
  commit.
- Migrations stop at `0088_mixed_hercules.sql`; `docs/decisions.md` max real
  ADR is ADR-125 (ADR-123/124 absent here; `### ADR-XXX` at the bottom is a
  template stub, not a claim).
- Sibling Tact 3 auto-promotion branch `claude/optimistic-leakey-8fde07`
  (worktree `optimistic-leakey-8fde07`) is now FULLY IMPLEMENTED (all 21 tasks,
  11 commits, gates green, UNMERGED). It claims ADR-126 + migration
  `0089_auto_promotion_lanes` (4 ALTERs incl. `runs.review_entered_at`) and it
  fixed the brain-era e2e harness (globalSetup vector-ext + migrate-brain).

Implementation rule:

1. At implementation start, re-run the ADR and migration scan against current
   `main` (`git show main:docs/decisions.md`; `_journal.json` max), and check
   whether Tact 3 has merged. Record the final numbers in this plan.
2. Keep ADR-124 for this feature (verified free).
3. Use migration `0090_experiments.sql`. Tact 3 being implementation-complete
   makes "Tact 3 lands first" the expected order; if THIS branch somehow lands
   first, renumber only after rebasing on current `main` and keep the Drizzle
   journal `when` monotonic (known silent-skip hazard).
4. Whoever lands second adds the experiment-member exclusion to the
   auto-promotion lanes eligibility predicate + its owning test. Given Tact 3's
   state, plan for THIS branch to own it (T6.6).
5. Rebase-friction files to expect: `web/lib/db/schema.ts`, migration journal,
   `docs/decisions.md`, `docs/PRODUCT_VIEW.md`, EN/RU messages,
   `web/lib/runs/resume-driver.ts`, `web/lib/workbench-lifecycle/service.ts`,
   `web/lib/gc/workspace-gc.ts` (Tact 3 also adds a referenced-run guard —
   REUSE/extend its predicate shape, never add a parallel one).

## Contract Surfaces

| Surface | Files | Contract change |
| --- | --- | --- |
| ADR | `docs/decisions.md` | Add ADR-124 (content checklist in T0.2). |
| System analytics | `docs/system-analytics/experiments.md` | New domain doc with Purpose, Domain entities, State machine, Process flows, Expectations, Edge cases, Linked artifacts. |
| Database docs | `docs/database-schema.md`, `docs/db/erd.md` | Add `experiments` and `experiment_runs`; no variant table. |
| Web OpenAPI | `docs/api/web.openapi.yaml` | Experiment routes (list/create/detail/launch/conclude/abandon/comparison) + optional `baseCommit` AND `relaunchOfRunId` on `POST /api/runs`. |
| External OpenAPI | `docs/api/external/operations.openapi.yaml` | Read-only experiment detail op (`experiments:read`) + advisory append op (`experiments:advise`). |
| AsyncAPI/SSE | `docs/api/async/*.asyncapi.yaml`, `docs/api/external/*.asyncapi.yaml` | No new events in Phase 1; record the deliberate deferral in ADR-124/domain doc. |
| Schema/migration | `web/lib/db/schema.ts`, `web/lib/db/migrations/0090_experiments.sql`, `web/lib/db/migrations/meta/_journal.json`, `meta/*.json` | Two tables, indexes, constraints, Drizzle snapshot/journal. |
| Authz | `web/lib/authz.ts`, `web/types/token-scopes.ts`, `web/lib/tokens/ext-handler.ts` | Actions `readExperiments` (viewer), `manageExperiments`, `concludeExperiments` (member); scopes `experiments:read`, `experiments:advise` + `PROJECT_ACTION_BY_SCOPE` + `AGENT_TOKEN_SCOPES`. |
| MCP facade | `mcp/src/tools.ts`, `mcp/src/rest.ts`, `mcp/src/__tests__/tool-contract.test.ts`, `mcp/src/__tests__/tools.test.ts` | `experiment_get` (read) + `experiment_advise` (advisory append) mirrored to the ext operations. |
| DTO schemas | `web/lib/experiments/http-schemas.ts`, `web/lib/experiments/dto.ts`, route tests | Zod request schemas + explicit DTO projections + OpenAPI examples in sync; exact-shape response tests. |
| Runs launch | `web/app/api/runs/route.ts`, `web/lib/services/runs.ts`, `web/lib/worktree.ts` | Optional `baseCommit` (ancestor-reachability validation, `PRECONDITION`) + optional `relaunchOfRunId` (same-task check, server-derived membership inheritance). |
| Overlay support | `web/lib/flows/enforcement.ts` (or `web/lib/capabilities/agent-map.ts`) | NEW overlay-class×adapter support constant (subagents claude-only); refusal `CONFIG`. |
| Experiments domain | `web/lib/experiments/*` | New service/repository/FSM/status-sync/comparison/diff-of-diffs/rubric/membership modules. |
| Activity | `task_activity` kind registry, activity feed renderer, `web/messages/*` | New domain-only activity kind `experiment_concluded` on the bound task (renderer + i18n + inbox classification). NOT a domain-event outbox kind. |
| UI | `web/app/(app)/projects/[slug]/experiments/*`, `web/components/experiments/*`, `web/components/board/project-tabs.tsx`, `web/messages/en.json`, `web/messages/ru.json` | List/create/lab/verdict surfaces + Experiments tab, localized from day one. |
| Platform agent | `maister-plugins` `packages/core/maister-agents/experiment-judge.md` + `web/lib/agents/__tests__/fixtures/core-package/maister-agents/experiment-judge.md` | Judge definition (mirror pair, byte-identical) + package projection tests + core package version bump/tag. |

## Deployment Touchpoints

No new ports, sidecars, mounted host paths, cron entries, or environment
variables are expected for Phase 1.

If implementation discovers that `experiment-judge` needs new instance-level
configuration, update the same commit with `.env.example`, `docs/configuration.md`,
`compose.yml`, `compose.production.yml`, and deployment docs. Do not add a hidden
runtime fallback.

## Identifier And Trust Boundaries

| Route | Body-controlled identifiers | Server-derived identifiers | Required guard |
| --- | --- | --- | --- |
| `POST /api/runs` | `taskId`, `flowId`, optional `baseCommit`, optional `relaunchOfRunId`, existing launch options | `projectId` from task; base branch from task/project; experiment membership from `relaunchOfRunId` row (NEVER from body experiment ids) | `requireProjectAction(projectId, "launchRun")`; `baseCommit` must exist AND be ancestor-reachable from the selected base ref else `PRECONDITION`; `relaunchOfRunId` must reference a run of the SAME task else `CONFLICT`. |
| `GET /api/projects/{slug}/experiments` | none | `projectId` from slug | `readExperiments` (viewer). |
| `POST /api/projects/{slug}/experiments` | `taskId`, `baseBranch`, optional explicit base ref, `title`, `variants`, `rubric` | `projectId` from slug; `base_commit` resolved server-side at create | `manageExperiments`; task must belong to project; explicit ref must be reachable from `base_branch` else `CONFIG`. |
| `GET /api/projects/{slug}/experiments/{experimentId}` (+ `/comparison`) | none | `projectId` from slug + experiment row join | `readExperiments`; on-read status verification. |
| `POST /api/projects/{slug}/experiments/{experimentId}/launch` | `{variants: "all" \| string[], replicates?: 1..10}` | experiment, task, base commit, variant configs from the experiment row | `manageExperiments`; experiment row lock; status ∈ {draft, running, comparable} else `PRECONDITION`; unknown variant key → `CONFIG`. |
| `POST /api/projects/{slug}/experiments/{experimentId}/conclude` | human verdict payload (`outcome`, `winnerVariantKey?`, `comment?`, `scores?`, `abandonLosers?`) | experiment row, actor from session | `concludeExperiments`; HUMAN session only (machine actor → 403, M17 rule); status = comparable under row lock else `PRECONDITION`. |
| `POST /api/projects/{slug}/experiments/{experimentId}/abandon` | `reason?`, `stopLiveRuns?` | experiment row, actor from session | `manageExperiments`; row-locked transactional status update; live member runs stopped via the standard run-stop dispatcher when requested. |
| `GET /api/v1/ext/projects/{slug}/experiments/{experimentId}` | none | project from slug, experiment by join | token scope `experiments:read` -> `readExperiments`. |
| `POST /api/v1/ext/projects/{slug}/experiments/{experimentId}/advisory` | advisory payload (criterion-id-keyed scores, summary, confidence?) | experiment row; actor identity from token (`agent:<id>` audit) | token scope `experiments:advise`; appends ONLY `verdict.judgeAdvisories[]` under row lock; status ∈ {running, comparable} else `PRECONDITION`; `successAuditInWork: true` (mutating ext route rule). |

## SDD Contract Gate

Implementation cannot start until Phase 0 produces a consistent specification
set and records it in this plan:

1. `docs/system-analytics/experiments.md` defines the current state machine,
   process flows, expectations, edge cases, and linked artifacts. It must not
   describe Phase 2 behavior as current.
2. `docs/api/web.openapi.yaml` and
   `docs/api/external/operations.openapi.yaml` define every request body,
   response DTO, status code, security scope, and example for this feature.
3. Route handlers authenticate before parsing request bodies wherever the
   current route pattern allows it. Token routes use `handleExt` before
   body-specific parsing; the mutating advisory route sets
   `successAuditInWork: true`.
4. Public route responses are explicit DTO projections, never DB rows or rich
   service objects. Tests must assert exact key sets with no server-only fields
   such as worktree paths, adapter argv/env, materialization paths, supervisor
   session ids, or internal cost handles.
5. Both MCP facade tools (`experiment_get`, `experiment_advise`) are mapped in
   `mcp/src/__tests__/tool-contract.test.ts`, so their input schemas mirror the
   external OpenAPI operations for properties, required fields, types, enums,
   and bounds.
6. DB schema changes are complete only when Drizzle schema, SQL migration,
   migration journal/snapshot, `docs/database-schema.md`, and the relevant
   `docs/db/*.md` ERD all agree.
7. The rubric schema is defined ONCE and consumed by the verdict UI form, the
   judge prompt contract, and the DTO — a single module, no copies.

### Frozen SDD Parity Checklist

Use this matrix as the implementation gate. A task is not complete until its
row's artifacts and tests agree with the OpenAPI + system-analytics contract.

| Surface | Required contract | Owning task(s) | Test boundary |
| --- | --- | --- | --- |
| Session routes | `GET/POST /api/projects/{slug}/experiments`, `GET /{experimentId}`, `POST /launch`, `POST /conclude`, `POST /abandon`, `GET /comparison`; auth before body parse where route shape allows; no body-controlled project ids. | T3.1, T3.2, T3.6, T4.1, T4.2 | Route integration tests assert status codes, exact DTO key sets, forbidden machine conclusion, CONFIG vs PRECONDITION, and no server-only fields. |
| Generic launch route | `POST /api/runs` accepts `baseCommit` and `relaunchOfRunId`; derives membership from existing run only; no body `experimentId`. | T3.2, T3.3 | Launch tests cover pinned-base start point, unreachable commit, same-task re-launch membership, cross-task conflict, and budget-restart membership retention. |
| External routes | `GET /api/v1/ext/projects/{slug}/experiments/{experimentId}` with `experiments:read`; `POST .../advisory` with `experiments:advise` and `successAuditInWork: true`. | T4.1, T4.4 | External route tests assert token scope mapping, advisory-only mutation, rubric-score revalidation, status PRECONDITION, audit-in-transaction, and hidden cross-project 404. |
| MCP facade | `experiment_get` and `experiment_advise` mirror external OpenAPI path params/body fields exactly. | T0.4, T4.4 | `mcp/src/__tests__/tool-contract.test.ts` and `tools.test.ts` fail on missing tools, wrong paths, stale body fields, required-field drift, enum drift, or omitted dispatch body fields. |
| DB schema and ERD | Only `experiments` and `experiment_runs`; migration `0090_experiments.sql`; no variant table; no new runs columns; docs and ERD list the same tables, FKs, uniqueness, and indexes. | T1.1, T6.4 | Migration/schema tests assert constraints, cascade behavior, unique run membership, unique variant replicate, and docs drift via grep checklist. |
| Status FSM | `draft -> running -> comparable -> concluded|abandoned`, `running -> abandoned`; terminal statuses immutable; single-variant experiments never comparable. | T2.1, T3.5 | FSM/status-sync tests cover every transition, invalid transitions, terminal immutability, failed/abandoned/crashed member runs, and all-terminal no-success behavior. |
| Variant launch reasons | `initial`, `manual_relaunch`, `budget_restart`; branch naming and materialization derive from immutable `experiments.variants`. | T3.2, T3.3, T3.4 | Launch/membership/materialization tests assert variant keys, replicate ordinals, overlay deltas, unknown variants, duplicate replicates, and immutable config reuse. |
| Scopes and actions | `readExperiments`, `manageExperiments`, `concludeExperiments`; token scopes `experiments:read`, `experiments:advise`; human-only conclusion. | T2.2, T4.4 | Authz/token tests prove viewer/member boundaries, wildcard behavior where existing token rules allow it, exact human actor restriction, and body parse denial after failed auth. |
| DTO exact shape | DTOs come from `web/lib/experiments/dto.ts`, not DB rows; omit worktree paths, ACP session ids, adapter argv/env, token hashes, and cost internals. | T3.1, T4.1 | Exact-shape response tests assert list/detail/comparison/external DTO keys and redaction of server-only fields. |
| Rubric single source | One rubric schema/default template module feeds create validation, verdict UI, judge prompt, comparison DTO, and advisory revalidation. | T4.3, T4.5, T5.4 | Rubric tests cover default criteria, custom criteria validation, stable criterion ids, score bounds, and no duplicate schema definitions. |
| UI and i18n | Experiments project tab, list/create, lab matrix, comparison tabs, verdict/advisory panels; EN/RU messages from day one. | T5.1-T5.5 | Component/E2E smoke tests assert empty/loading/error states, localized labels, disabled terminal actions, and no overlapping text at target breakpoints. |
| AsyncAPI/SSE | No new domain event or AsyncAPI channel for Phase 1; status is verified on read and from existing run completion hooks. | T3.5, T6.3 | Grep/docs checks prove `docs/api/supervisor.asyncapi.yaml` stays untouched for experiments; hook tests prove run terminalization updates experiments without new SSE contracts. |
| Analytics/logging | Structured fields include `projectId`, `experimentId`, `taskId`, `runId`, `variantKey`, `replicateOrdinal`, `actorType`, `requestId`; no raw prompt/diff bodies in logs. | T3.1-T4.5, T6.2 | Route/service tests and code review check structured logs on create/launch/conclude/abandon/advisory/status-sync and no interpolated dynamic log strings. |

## Phase 0 Contract Decisions

### Owner-confirmed pass-2 decisions (2026-07-03 — do not re-ask)

The owner confirmed all six pass-2 design defaults on 2026-07-03. ADR-124
records them as decided, alongside the request's own §12 resolved decisions:

1. **Advisory write path:** new scope `experiments:advise` + ext advisory op +
   MCP tool `experiment_advise` (triage_set precedent) appending
   `verdict.judgeAdvisories[]` — not a comment-only channel.
2. **`base_commit` is resolved and pinned at experiment CREATION** (not at
   first launch).
3. **FR-2a manual mechanism:** optional `relaunchOfRunId` on `POST /api/runs`
   with server-derived membership inheritance.
4. **`experiments.title`** (board-entity convention), not the request sketch's
   `name`.
5. **Conclude writes a `task_activity` row** with new domain-only kind
   `experiment_concluded` in the conclude transaction.
6. **Replicates per launch request bounded 1..10.**

### Decisions

- Experiment status values: `draft`, `running`, `comparable`, `concluded`,
  `abandoned`.
- **Comparable definition (request-canonical):** an experiment is `comparable`
  iff EVERY member run status ∈ {`Review`} ∪ terminal AND at least two distinct
  variants have ≥1 member run. `running` ⇄ `comparable` oscillate when
  replicates are launched or member runs move. A member run parked in
  `NeedsInput`/`NeedsInputIdle`/`HumanWorking` keeps the experiment `running`
  (mid-run human forms make comparison wait — documented edge). Comparability
  is STATUS-based; diff snapshots are best-effort evidence captured at the same
  transition, with on-demand recompute while git refs exist.
- Run failures do not terminalize the experiment ("A crashed, B wins" is a
  legitimate verdict). Failed replicates are relaunchable.
- **Variants and rubric are immutable from CREATION.** There is no update
  surface; a service-level guard rejects any mutation attempt with
  `PRECONDITION` (owning test). Post-create changes require a new experiment.
- **`base_commit` is resolved at CREATION** (tip of `base_branch`, or an
  explicit ref that MUST be ancestor-reachable from `base_branch` else
  `CONFIG`) and stored NOT NULL from creation. This is deliberately stronger
  than the request's "NOT NULL after start": the draft lab header can show the
  pinned SHA, and no first-launch tip race exists. Record in ADR-124.
- **Error-code split:** create-time base-ref/variant/rubric problems →
  `CONFIG`; `POST /api/runs` `baseCommit` missing/unreachable →
  `PRECONDITION`; FSM-illegal launch/conclude/abandon/advisory →
  `PRECONDITION`; unknown variant-config/overlay key or unresolvable overlay
  ref at launch → `CONFIG`.
- `experiments.title` is used (board-entity convention `tasks.title`); the
  request sketch said `name` — deviation recorded in ADR-124.
- **Verdict envelope** (`experiments.verdict` jsonb, nullable):
  `{ human?: { outcome: "winner" | "tie" | "inconclusive",
  winnerVariantKey?, comment?, scores?: { [criterionId]: { [variantKey]:
  number } }, skippedOptionalCriteria?: string[] },
  judgeAdvisories?: [{ advisoryOrdinal, agentRunId, createdAt, scores,
  summary, confidence? }] }`. Only a human session writes `human` and flips to
  `concluded`; advisories append under the experiment row lock while status ∈
  {running, comparable} and are frozen after terminal states.
- **Advisory write path (triage_set precedent):** ext
  `POST /api/v1/ext/projects/{slug}/experiments/{experimentId}/advisory` + MCP tool
  `experiment_advise`, scope `experiments:advise` — appends ONLY
  `judgeAdvisories[]`, never `human`, never status, never member-run rows.
  Interim scope wiring: add `experiments:read` + `experiments:advise` to the
  fixed `AGENT_TOKEN_SCOPES` with a recorded migration note to move them to the
  Tact-0 declared-scopes allowlist when it lands (Tact-0 impl has NOT started —
  the fixed-set path applies unless main says otherwise at implementation
  time).
- **Default rubric template** (platform constant): criteria `correctness`,
  `completeness`, `consistency`, `code_quality`, `cost_efficiency`,
  `specs_traceability` (`optional: true`); criterion shape `{id, label,
  guidance, scale, weight?, optional?}`. Snapshotted immutably onto the
  experiment at creation (wizard may override). Optional criteria are
  human-skippable; the judge scores them only when a requirements source
  exists (task prompt / linked artifacts). `scores` key by `criterion.id`.
- **Membership derivation (FR-2a):** membership is written ONLY from
  server-known source contexts — (a) the experiment launch route (explicit
  variant), (b) the ADR-125 budget-restart composite (source run from
  `triggerPayload`), (c) `POST /api/runs` with `relaunchOfRunId` referencing a
  member run of the same task. Inheritance allocates `replicate_ordinal + 1`
  in the SAME transaction as the run insert and applies only while the
  experiment ∈ {running, comparable}; after `concluded`/`abandoned` a restart
  creates a plain non-member run. A bare task-scoped launch NEVER inherits
  (owns the "human-launched non-member run mid-experiment" edge).
- Variant launches inherit the project package pins (no per-variant
  `packageVersions`) so variants stay comparable; runner is a sibling axis via
  the existing launch-override tier.
- Replicates per launch request bounded 1..10 (zod); the global concurrency
  cap queues extras (`Pending` + position), never errors.
- **GC-protection scope:** automated sweeps (workspace GC, reconcile TTL) skip
  runs referenced by a non-terminal experiment; MANUAL workbench
  drop/archive/export stays allowed (user sovereignty) and the lab degrades to
  snapshots. Deliberate, documented.
- **Conclude activity:** conclusion writes a `task_activity` row (new
  domain-only kind `experiment_concluded`) on the bound task in the SAME
  transaction as verdict + status. No new domain-event OUTBOX kind, no new SSE
  event family, no scheduler trigger (deliberate deferrals recorded). Judge
  task-thread comments reuse the existing comment pipeline and existing
  `task.comment_added` event.
- **SQLite dialect:** the feature functions fully on SQLite (plain tables in
  the main migration lineage; `jsonb().$type<…>()` per existing schema
  pattern); integration coverage stays real-PG per project conventions.
  Recorded in ADR-124 + domain doc.

## Data Model Design

`experiments`:

- `id`, `project_id`, `task_id`
- `title`, optional `description`
- `base_branch`, `base_commit` (NOT NULL, resolved at creation)
- `status`
- `variants` jsonb, immutable from creation: `[{key, label, config}]`
- `rubric` jsonb, immutable from creation (snapshot of the template)
- `verdict` jsonb nullable — the envelope defined in Phase 0 decisions
- `created_by_user_id`, `concluded_by_user_id` nullable
- `created_at`, `updated_at`, `launched_at`, `comparable_at`,
  `concluded_at`, `abandoned_at`

`experiment_runs`:

- `id`, `experiment_id`, `run_id`
- `variant_key`, `replicate_ordinal`
- `launch_reason` ∈ `initial | manual_relaunch | budget_restart`
- `diff_snapshot` text null (capped), `diff_snapshot_truncated` bool,
  `diff_snapshot_bytes`, `diff_snapshot_captured_at`
- `diff_files_summary` jsonb null — per-file `{path, status, additions,
  deletions, patchHash}` computed from the FULL diff BEFORE the text cap
  (keeps the Files tab complete under truncation and after GC)
- `materialization_delta` jsonb null — the applied overlay delta per class
- `created_at`, `updated_at`

Required constraints:

- `experiment_runs.run_id` UNIQUE (a run belongs to at most one experiment).
- UNIQUE `(experiment_id, variant_key, replicate_ordinal)` — resolves the
  duplicate-launch-click race by atomic insert (`onConflictDoNothing` +
  retry-next-ordinal or mapped 409, never a raw 23505).
- `experiment_runs.experiment_id` FK cascades from `experiments.id`;
  `run_id` FK to `runs.id`.
- `experiments.project_id`/`task_id` are validated server-side against the
  slug-derived project; body-provided project ids are never trusted.
- JSON columns use the existing `jsonb("…").$type<…>()` schema pattern
  (Postgres primary; SQLite parity via the Drizzle dialect switch).
- Indexes: `experiment_runs(experiment_id)`, `experiment_runs(run_id)`,
  `experiments(project_id, status)`, `experiments(task_id)`.

## Variant Overlay Registry

Allowed variant config keys for Phase 1 (closed registry; unknown key →
`CONFIG`):

- `runnerId?` — resolved through the existing launch-override tier.
- `executionPolicy?` — reuses the existing `POST /api/runs` executionPolicy
  shape/validation.
- `capabilityOverlay?`:
  - `rules.add[] / rules.remove[]` → `selectedRuleIds`
  - `skills.add[] / skills.remove[]` → `selectedSkillIds`
  - `mcps.add[] / mcps.remove[]` → `selectedMcpIds`
  - `subagents.add[] / subagents.remove[]` → `selectedAgentDefinitionIds`

Implementation requirements:

- Closed zod schema; unknown keys/shapes fail `CONFIG` at create.
- Overlay IDs resolve through the existing catalog/package resolver at LAUNCH
  time; a ref that vanished between create and launch fails `CONFIG` naming the
  ref, before any side effect.
- **Class×adapter support matrix is a NEW constant** (e.g.
  `OVERLAY_CLASS_SUPPORT_BY_AGENT` adjacent to `ENFORCEABILITY_BY_AGENT` in
  `web/lib/flows/enforcement.ts`): rules/skills/mcps supported on all five
  adapters; `subagents` claude-only (adapter materialization fact). An
  unsupported class×resolved-adapter combination REFUSES at launch (`CONFIG`),
  nothing created — silent degradation would poison comparisons.
- MCP overlay entries pass the existing exec-trust gate
  (`gateStdioMcpsByExecTrust`) at materialization — an untrusted stdio MCP is
  withheld exactly as it is for non-experiment runs (owning test).
- Overlay application seam: merge the variant overlay into the node's
  capability selection BEFORE `resolveCapabilityProfile` in
  `web/lib/flows/graph/runner-graph.ts` (~1627). The overlay is derived at
  materialization time from the run's `experiment_runs` join → immutable
  `experiments.variants` (both immutable ⇒ no launch/terminal drift; no new
  columns on `runs`). Reuse `buildResolvedCapabilitySet`,
  `resolveCapabilityProfile`, `pinCatalogToSnapshot`,
  `materializeCapabilityProfile` — NO parallel materializer or direct
  `.maister` writer.
- The persisted effective-profile snapshot (`profile.json`) MUST reflect the
  overlay; additionally persist the compact applied delta to
  `experiment_runs.materialization_delta` so the lab renders the ACTUAL
  materialized delta, never the requested config.
- **Delivery-mechanism slices:** s1 = rules+skills (file-materialized), s2 =
  mcps (session config + exec-trust), s3 = subagents (adapter-gated,
  claude-only). Implement s1 → s2 → s3 inside T2.5. **FR-3 budget gate:** if
  overlay integration blows the tact budget mid-slice, the implementer records
  ONE of four outcomes in this plan + the PR (add budget & continue / restart
  the slice clean / park the partial, branch preserved / discard). Default
  bias: ship s1 first; s2/s3 as immediate follow-up slices. AC-3 requires all
  three slices for full pass — a gate decision that defers s2/s3 must mark the
  affected AC-3 sub-assertions deferred with the recorded rationale.

## Self-Check Passes

### Completeness (pass 2)


### Consistency (pass 2)

Comparable definition, immutability boundary (creation), error-code split
(CONFIG vs PRECONDITION), AC numbering, rubric single-source, and the advisory
write path are now aligned with the request and with each other. OpenAPI ↔
routes ↔ Drizzle ↔ zod ↔ system-analytics ↔ ERD alignment is enforced by the
SDD gate; new authz actions follow the `PROJECT_ACTION_MIN` map
(read=viewer, manage/conclude=member per resolved Q3); UI states render exactly
the five FSM states; file references were corrected to verified paths
(`resume-driver.ts`, `web/lib/diff/prepare.ts`, `project-tabs.tsx`,
`enforcement.ts`).

### Logical Holes Closed (pass 2)

- Judge advisory write path exists (`experiments:advise` + `experiment_advise`)
  and is guarded (append-only, row-locked, pre-terminal only) — the pass-1
  contradiction ("advisories in the envelope" vs "no mutating tools") is gone.
- Files matrix stays complete under truncation/GC via `diff_files_summary`
  captured from the full diff before the 512 KB cap.
- Member budget-restart cannot be refused by a busy task: member restarts
  select the force launchability gate (owning test with a live sibling
  variant run).
- Manual relaunch inheritance has a server-derived source
  (`relaunchOfRunId`); bare task launches never inherit — both sides tested.
- Status recompute is concurrency-safe: experiment row `FOR UPDATE`, fresh
  member-status re-read under the lock, allow-listed transitions
  (draft→running, running⇄comparable; terminal states never overwritten), and
  on-read verification heals+WARNs on drift (defense against a missed writer).
- Conclude vs replicate-launch and conclude vs budget-restart races serialize
  on the same experiment row lock; restart after `concluded` creates a plain
  run (no membership).
- Pending overflow still creates the run row through existing queue semantics;
  the membership row is inserted in the same transaction as the run insert.
- Overlay refs are resolved at launch (vanished ref → named `CONFIG`), the
  class×adapter refusal happens before any side effect, and exec-trust holds
  for overlay MCPs at spawn.
- Auto-promotion exclusion ownership is explicit given Tact 3's implemented
  state (T6.6).

## Acceptance Traceability

Canonical numbering = the Tact-2 FINAL request.

| Requirement | Primary tasks | Owning test tier |
| --- | --- | --- |
| FR-1 base-commit pinning | T1.4, T2.1, T2.2 | integration (launch/base-commit), route unit |
| FR-2 variant launch & fan-out | T2.2 | integration (fan-out, cap/queue) |
| FR-2a relaunch membership inheritance | T2.3 | integration (ADR-125 restart e2e path, relaunchOfRunId) |
| FR-3 capability overlay (s1/s2/s3) | T2.4, T2.5 | unit (schema) + mock-ACP flow integration (materialization) |
| FR-3-gate budget fork | Phase-2 preamble note, T2.5 | recorded decision (plan/PR), no test |
| FR-4 diff snapshotting | T3.2 | integration + mock flow |
| FR-5 GC protection | T3.3 | integration (GC hold/release) |
| FR-6 diff-of-diffs util | T4.2 | unit fixtures |
| FR-7 rubric-as-data | T4.3, T3.4, T5.4 | unit + route integration + render |
| FR-8 experiment-judge agent | T4.4, T4.5, T1.3 | mcp contract + package-definition + advisory-route integration |
| AC-1 pinning | T1.4, T2.2, T6.5 | integration (merge-base assert; PRECONDITION case) |
| AC-2 fan-out & cap | T2.2 | integration (2×2 with cap → 2 live + 2 Pending w/ positions; ordinary attempts) |
| AC-3 overlay | T2.4, T2.5 | mock-adapter integration (skills delta, mcps exec-trust, codex-subagent CONFIG, unknown key CONFIG) |
| AC-4 comparable + snapshots | T3.1, T3.2, T4.1 | integration (no-timer flip; GC-simulation snapshot serving; truncation + complete files matrix) |
| AC-5 diff-of-diffs & files | T4.2, T5.3 | unit fixtures (incl. renames) + render |
| AC-6 gates & cost | T4.1, T5.3 | integration (verdict+confidence; no-data) + render |
| AC-7 rubric & judge | T4.3, T4.5, T5.4, T2.1 | unit (immutability PRECONDITION) + integration (advisory + machine-conclude reject) + render |
| AC-8 verdict & FSM | T3.4 | integration (conclude-in-running PRECONDITION; atomic verdict+status+activity; gates untouched; loser abandon) |
| AC-9 crash & fork interplay | T2.3, T3.1, T6.5 | integration (Crashed surfaced+concludable; restart inherits same variant; park/abandon leave concludable) |
| AC-10 e2e | T6.4 | playwright stub-supervisor (both locales) |
| AC-11 docs & contracts | T0.1–T0.5, T6.1, T6.6, T6.7 | validate:docs, tool-contract, lanes-exclusion test |

## Acceptance Criteria Details (request-canonical)

- **AC-1 Pinning:** base branch advances after experiment creation; a late
  variant/replicate launch still builds from the pinned commit (assert the run
  branch's merge-base with the pin); `POST /api/runs` with an unreachable or
  unknown `baseCommit` → `PRECONDITION`; experiment create with an explicit
  ref not reachable from `base_branch` → `CONFIG`.
- **AC-2 Fan-out & cap:** 2 variants × 2 replicates with cap 2 → 2 live + 2
  `Pending` with queue positions; membership rows written atomically with run
  inserts; member runs appear as ordinary attempts in task history.
- **AC-3 Overlay:** with the mock adapter, variant A `skills.add:[x]` vs B
  without → A's materialized session contains x, B's does not; BOTH
  effective-profile snapshots and `materialization_delta` record the delta and
  the lab renders it. `mcps.add` resolves through the catalog and passes
  exec-trust (untrusted stdio withheld). A subagent overlay on a codex-resolved
  runner → `CONFIG` at launch, nothing persisted. Unknown overlay key at
  create → `CONFIG`.
- **AC-4 Comparable + snapshots:** driving both runs to `Review` flips
  `comparable` with no timer/polling; snapshots + files summaries persisted;
  after simulated GC (worktrees/branches deleted) the comparison DTO serves
  fully from snapshots; a >512 KB diff carries the structured truncation flag
  while the files matrix stays complete.
- **AC-5 Diff-of-diffs & files:** fixtures — identical changes → empty;
  disjoint file sets; same-file-different-hunks; renames; binary/unparseable
  fallback; truncated inputs flagged partial. Files matrix classifies
  touched-by/same/different with All/Different/Same filters and per-file
  A-vs-B drilldown.
- **AC-6 Gates & cost:** gate matrix reflects real per-run `gate_results`
  incl. ai_judgment verdict + confidence; cost tab renders rollup token
  classes (incl. resume-attributed), byModel/byRunner, duration; missing
  rollup → explicit no-data state, never fabricated zeros.
- **AC-7 Rubric & judge:** rubric snapshot immutable (post-create mutation
  attempt → `PRECONDITION`); the verdict form renders from the rubric incl.
  skippable optional criteria; the judge (scripted at substrate level) posts
  advisory scores keyed by criterion ids via `experiment_advise` and they
  render beside human scores; a machine actor calling conclude → rejected.
- **AC-8 Verdict & FSM:** conclude in `running` → `PRECONDITION`; in
  `comparable` → one transaction writes verdict.human + status +
  `experiment_concluded` task activity; member-run gates/statuses untouched;
  `abandonLosers` stops loser runs via the standard dispatcher.
- **AC-9 Crash & fork interplay:** one variant `Crashed` → surfaced in the
  matrix, experiment stays concludable, a replacement replicate launches from
  the same pin; budget breach on a member run → ADR-125 restart produces the
  next replicate of the SAME variant (membership inherited, force gate);
  park/abandon leave the experiment concludable.
- **AC-10 E2E:** stub-supervisor: create (with rubric) → launch 2 variants →
  comparable → lab (matrix, diff, files, verdict with rubric) → conclude —
  asserted under BOTH locales.
- **AC-11 Docs & contracts:** ADR-124 (incl. not-ported auto-approve, GC
  protection, overlay refusal semantics, rubric model, advisory path, §2
  disposition, §9 non-goals), `docs/system-analytics/experiments.md` (R5),
  ERD both artifacts, OpenAPI files lint-clean, `pnpm validate:docs` green;
  the auto-promotion lanes exclusion term + owning test present when landing
  after ADR-126 (expected order).

## TDD And Test Selection Rules

- Every implementation task starts with a failing test or contract validation
  failure, then moves through GREEN and refactor in the same task.
- Unit tests are reserved for stable pure logic: FSM transitions, variant
  schema validation, rubric validation, diff-of-diffs, files-matrix
  classification, and DTO projection helpers.
- Real-Postgres integration tests own DB constraints, transactions,
  cross-resource validation, authz, token scopes, GC holds, launch fan-out, and
  relaunch inheritance.
- Mock ACP/run-flow tests own Review/terminal hooks, snapshot capture, status
  sync, and overlay materialization through the runner graph.
- Playwright gets one high-value stub-supervisor flow only (asserted in both
  locales); do not duplicate lower-level edge cases in E2E.
- Public API tests must include exact response-shape assertions and at least
  one negative auth/scope case per route family.
- Concurrency claims are proven with REAL two-racer tests where the contract
  is 409-vs-500 (second pg connection holding an uncommitted write), not
  single-threaded simulations.
- Test overlap is allowed only when it proves a different boundary. Avoid
  duplicated happy-path assertions that exercise the same service through the
  same inputs.
- After adding any new test file, run the relevant `vitest list --project ...`
  command and record that the file is matched by exactly one project.
- Trivial tests that only assert rendering of static labels, existence of
  imports, or TypeScript restatements of constants do not count toward feature
  coverage.

## Tasks

### Phase 0: Docs, Contracts, And Numbering

- [x] **T0.1 Re-run numbering and branch preflight**
  - Status: completed (2026-07-03).
  - Files: `docs/decisions.md`, `web/lib/db/migrations/meta/_journal.json`,
    `.ai-factory/plans/feature-experiment-comparison-studio.md`.
  - Implementation notes (2026-07-03):
    - Current implementation branch: `feature/experiment-comparison-studio`.
    - `main` HEAD: `e27bd51d00f30cac53a98d52a6d846db46d9bb06`; this branch
      started from the same commit.
    - `main:docs/decisions.md` max real ADR is ADR-125; ADR-124 and ADR-126
      are absent from `main`.
    - `main:web/lib/db/migrations/meta/_journal.json` max migration is
      `0088_mixed_hercules`; current checkout has no `0089`/`0090` migration.
    - Tact 3 branch `claude/optimistic-leakey-8fde07` is unmerged into
      `main` (`git merge-base --is-ancestor claude/optimistic-leakey-8fde07
      main` exited 1) and contains ADR-126 plus `0089_auto_promotion_lanes`.
    - Final numbers for this branch before rebase: ADR-124 and migration
      `0090_experiments.sql`; this branch owns T6.6 auto-promotion lanes
      exclusion if rebased after Tact 3, otherwise leaves the documented merge
      note for the Tact 3 owner.
  - Work: check current `main`, the Tact 3 branch merge state, ADR max, and
    migration max before coding. Record the final ADR/migration numbers and the
    resulting T6.6 ownership (lanes exclusion) in this plan.
  - RED: add no code yet; capture the expected ADR/migration IDs as a
    checklist item.
  - Logging: none in product code; implementation notes must record exact
    branch/head inputs used for numbering.

- [x] **T0.2 Write ADR-124 and system analytics doc**
  - Status: completed (2026-07-03).
  - Files: `docs/decisions.md`, `docs/system-analytics/experiments.md`.
  - Implementation notes (2026-07-03):
    - Added `docs/system-analytics/experiments.md` in R5 order with Purpose,
      Domain entities, State machine, Process flows, Expectations, Edge cases,
      and Linked artifacts.
    - RED/GREEN: initial sandboxed `pnpm validate:docs` was blocked by
      registry DNS while pnpm populated missing local validator packages; rerun
      with network approval passed:
      `validate-docs-mermaid: 5/5 mermaid block(s) passed across 2 file(s)`;
      `validate-docs-adr-anchors: 236 ADR anchor link(s) resolved across 2
      file(s)`.
  - RED: `pnpm validate:docs` (mermaid + ADR-anchor scripts) fails until
    anchors and Mermaid syntax are correct, then passes.
  - Logging: document required structured log fields for experiment create,
    launch, snapshot, conclude, abandon, advisory, and GC hold events.

- [x] **T0.3 Update database, ERD, and product docs**
  - Status: completed (2026-07-03).
  - Files: `docs/database-schema.md`, `docs/db/erd.md`,
    `docs/PRODUCT_VIEW.md`, `docs/screens/README.md`,
    `docs/screens/projects/project-experiments.md`.
  - Implementation notes (2026-07-03):
    - Documented `experiments` and `experiment_runs` in the database narrative,
      cascade chain, and index table, including `launch_reason`,
      `diff_files_summary`, structured truncation fields, and the five-state
      FSM.
    - Updated the consolidated ERD with `EXPERIMENTS`, `EXPERIMENT_RUNS`, task/
      project/run relationships, and `experiment_concluded` task activity.
    - Added the experiment-comparison JTBD/product model/current-scope entry in
      `docs/PRODUCT_VIEW.md`.
    - Added the screen index row and
      `docs/screens/projects/project-experiments.md` following the screen-doc
      skeleton; also added the new docs to `docs/CLAUDE.md` for discoverability.
    - GREEN: `pnpm validate:docs` passed:
      `validate-docs-mermaid: 9/9 mermaid block(s) passed across 8 file(s)`;
      `validate-docs-adr-anchors: 250 ADR anchor link(s) resolved across 8
      file(s)`.
  - Work: document the two-table model (incl. `diff_files_summary`,
    `launch_reason`), status FSM, UI screens (list + lab, matching the existing
    screen-doc skeleton: Route/Status/Source, JTBD, Roles & Capabilities,
    Navigation, Layout & Regions), and non-goals. PRODUCT_VIEW gains the
    experiment-comparison JTBD row.
  - RED: docs validation should catch broken links/anchors before code begins.
  - Logging: document the observability expectations in the screen/domain docs,
    especially why runs can fail without terminalizing the experiment.

- [x] **T0.4 Update API contracts first**
  - Status: completed (2026-07-03).
  - Files: `docs/api/web.openapi.yaml`,
    `docs/api/external/operations.openapi.yaml`,
    `mcp/src/__tests__/tool-contract.test.ts`, any existing API schema tests.
  - Completion notes (2026-07-03):
    - Added all session-auth experiment OpenAPI operations, `baseCommit`, and
      `relaunchOfRunId` to the web contract with CONFIG/PRECONDITION and
      body-controlled-id semantics.
    - Added external `experiments:read` and `experiments:advise` operations,
      schemas, and advisory-only/success-audit semantics.
    - Added MCP facade tools `experiment_get` and `experiment_advise`,
      dispatch routing, the external OpenAPI contract map, and focused tool
      mapping assertions.
    - Verification passed:
      `pnpm --filter @maister/mcp test:unit -- src/__tests__/tool-contract.test.ts src/__tests__/tools.test.ts`
      (189 tests) and `pnpm validate:docs`.
  - Work: add ALL session ops — `GET/POST /api/projects/{slug}/experiments`,
    `GET …/{experimentId}`, `POST …/launch`, `POST …/conclude`,
    `POST …/abandon`, `GET …/comparison` — plus `baseCommit` AND
    `relaunchOfRunId` on `POST /api/runs`; ext ops — read detail
    (`experiments:read`) and advisory append (`experiments:advise`,
    `successAuditInWork`). Map BOTH future MCP tools (`experiment_get`,
    `experiment_advise`) in the tool-contract test. Include body-controlled ID
    notes and error-code semantics (CONFIG vs PRECONDITION) in operation
    descriptions.
  - RED: contract validation fails until all schemas/examples/security scopes
    are consistent; the MCP contract test must fail until both experiment
    tools are mapped or explicitly deferred.
  - Logging: describe route-level audit/log fields in operation descriptions:
    `projectId`, `experimentId`, `taskId`, `runId`, `variantKey`,
    `replicateOrdinal`, `actorType`, and `requestId` where available.

- [x] **T0.5 Freeze SDD parity checklist**
  - Status: completed (2026-07-03).
  - Files: `.ai-factory/plans/feature-experiment-comparison-studio.md`,
    `docs/system-analytics/experiments.md`, `docs/api/web.openapi.yaml`,
    `docs/api/external/operations.openapi.yaml`, `docs/database-schema.md`,
    `docs/db/erd.md`.
  - Completion notes (2026-07-03):
    - Added the Frozen SDD Parity Checklist mapping session routes, generic
      launch, external routes, MCP facade, DB/ERD, status FSM, launch reasons,
      scopes/actions, DTO exact shape, rubric single source, UI+i18n,
      AsyncAPI/SSE non-scope, and analytics/logging to owning tasks and test
      boundaries.
    - Grep sweep terms used:
      `experiments:read|experiments:advise|readExperiments|manageExperiments|concludeExperiments|experiment_get|experiment_advise|successAuditInWork`,
      `draft|running|comparable|concluded|abandoned|initial|manual_relaunch|budget_restart|0090_experiments|experiment_runs`,
      `\{id\}/advisory|experiments/\{id\}`,
      `experiment|experiments` under `docs/api --glob "*.asyncapi.yaml" --glob "*.asyncapi.yml"`.
    - Closed the sweep gaps by changing external route placeholders to
      `{experimentId}` consistently and aligning launch reasons to
      `initial|manual_relaunch|budget_restart`. AsyncAPI grep returned no
      experiment matches, as required.
    - Verification passed:
      `pnpm validate:docs` and
      `pnpm --filter @maister/mcp test:unit -- src/__tests__/tool-contract.test.ts src/__tests__/tools.test.ts`.
  - Work: add a short implementation checklist to the plan or domain doc that
    maps every route/schema/table/status/scope to its owning task and test
    boundary. Include exact DTO-shape, auth-first, DB/ERD, MCP, i18n,
    rubric-single-source, and no-new-AsyncAPI rows.
  - RED: a manual grep checklist should initially fail on at least one missing
    route/status/scope before Phase 0 is complete; close the gaps before code.
  - Logging: no product logging; record the exact grep terms used for the
    contract sweep.

### Phase 1: Schema, Authz, And Launch Foundation

- [x] **T1.1 Add experiment tables and Drizzle schema**
  - Status: completed (2026-07-03).
  - Files: `web/lib/db/schema.ts`,
    `web/lib/db/migrations/0090_experiments.sql`,
    `web/lib/db/migrations/meta/_journal.json`,
    `web/lib/db/migrations/meta/*.json`, `web/lib/db/__tests__/*`.
  - Completion notes (2026-07-03):
    - Added typed Drizzle schema for `experiments` and `experiment_runs`, plus
      generated SQL/snapshot/journal artifacts in the reserved
      `0090_experiments` slot (0089 remains reserved for Tact 3).
    - Added migration integration coverage for table columns/defaults,
      required indexes, status/launch-reason/replicate checks, unique run
      membership, unique variant replicate, and cascade cleanup.
    - RED: focused migration test failed on missing `experiments` table.
      GREEN: `pnpm --filter maister-web exec vitest run --project integration lib/db/__tests__/migration-0090-experiments.integration.test.ts`
      passed (2 tests), and
      `pnpm --filter maister-web exec vitest run --project integration lib/db/__tests__/check-migrations.integration.test.ts`
      passed (2 tests).
  - Work: add `experiments` and `experiment_runs` only, with the constraints,
    indexes, and columns from the Data Model section (incl.
    `diff_files_summary`, `launch_reason`). JSON columns typed via
    `jsonb("…").$type<…>()` per existing pattern. Generate/update the Drizzle
    snapshot and journal in the same task (monotonic `when`), then run
    `pnpm --filter maister-web db:check` or the current migration-integrity
    guard.
  - RED: failing integration assertions for unique run membership, replicate
    uniqueness (onConflict → mapped 409, not raw 23505), FK cascade behavior,
    status enum validation, and journal integrity before applying migration
    code.
  - Logging: no DB logging in migration; schema-facing services must log
    structured row identifiers when constraints reject a write.

- [x] **T1.2 Add domain types, FSM, and repository**
  - Status: completed (2026-07-03).
  - Files: `web/lib/experiments/types.ts`, `web/lib/experiments/fsm.ts`,
    `web/lib/experiments/repository.ts`,
    `web/lib/experiments/validation.ts`,
    `web/lib/experiments/__tests__/*`.
  - Completion notes (2026-07-03):
    - Added shared experiment domain types and switched DB JSON annotations to
      import those types instead of keeping schema-local copies.
    - Added FSM helpers for allowed transitions, terminal status detection, and
      the canonical comparable derivation rule.
    - Added immutability validation for base branch, base commit, variants, and
      rubric, plus a transaction-injected repository status transition helper
      with structured logging fields.
    - RED: focused unit tests failed on missing experiment modules. GREEN:
      `pnpm --filter maister-web exec vitest run --project unit lib/experiments/__tests__/fsm.test.ts lib/experiments/__tests__/validation.test.ts lib/experiments/__tests__/repository.test.ts`
      passed (24 tests).
  - Work: typed experiment DTOs, creation-time immutability guard
    (variants/rubric mutation attempt → `PRECONDITION`), status transition
    helpers implementing the request-canonical comparable rule (EVERY member
    run ∈ {Review} ∪ terminal AND ≥2 variants with ≥1 run), and repository
    functions with transaction injection. Allow-list transitions only:
    draft→running, running⇄comparable, {draft,running,comparable}→abandoned,
    comparable→concluded; terminal states final.
  - RED: pure tests first for every allowed/forbidden FSM transition,
    comparable threshold (incl. a NeedsInput member run keeping `running`,
    single-variant experiments never comparable), and the immutability guard.
  - Logging: repository/service functions log only at state-changing call sites
    with `experimentId`, `fromStatus`, `toStatus`, and `reason`.

- [x] **T1.3 Wire authz actions and token scopes**
  - Status: completed (2026-07-03).
  - Files: `web/lib/authz.ts`, `web/types/token-scopes.ts`,
    `web/lib/tokens/ext-handler.ts`,
    `web/components/account/personal-tokens-panel.tsx`,
    `web/components/board/token-actions.tsx`,
    `web/components/board/panels/integrations-panel.tsx`,
    `web/messages/en.json`, `web/messages/ru.json`,
    `web/lib/__tests__/authz-actions.test.ts`,
    `web/lib/__tests__/authz.integration.test.ts`.
  - Completion notes (2026-07-03):
    - Added `readExperiments`, `manageExperiments`, and
      `concludeExperiments` project actions.
    - Added `experiments:read` and `experiments:advise` to token scopes and
      fixed agent-token scopes; mapped read -> `readExperiments` and advise ->
      `manageExperiments` in the external token handler.
    - Surfaced experiment scope labels in project token and personal token UIs
      with EN/RU translations.
    - RED: scope contract and integrations label tests failed on missing
      actions/scopes/mapping/labels. GREEN:
      `pnpm --filter maister-web exec vitest run --project unit lib/tokens/__tests__/scope-contract.test.ts components/board/panels/__tests__/integrations-panel.test.ts`
      passed (22 tests).
  - Work: add `readExperiments: "viewer"`, `manageExperiments: "member"`,
    `concludeExperiments: "member"` to `PROJECT_ACTION_MIN`; add token scopes
    `experiments:read` and `experiments:advise` to `TOKEN_SCOPES`, map them in
    `PROJECT_ACTION_BY_SCOPE`, add both to the fixed `AGENT_TOKEN_SCOPES`
    (interim path; leave the recorded Tact-0 migration note), and surface them
    in the token scope pickers.
  - RED: tests fail until actions/scopes are present and mapped both ways.
  - Logging: denied authz remains centralized; the external advisory route
    must include structured audit fields for `tokenId`, `scope`, `projectId`,
    and `experimentId`.

- [x] **T1.4 Add optional `baseCommit` to generic run launch**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added `baseCommit` to `POST /api/runs` schema and launch input
      passthrough.
    - Added `assertBaseCommitReachable()` beside `resolveBaseCommit()` using
      schema-hardened `git merge-base --is-ancestor` with remote-preferred
      base-ref resolution and structured rejection logging.
    - Launch now validates a pinned commit before attempt allocation/worktree
      creation, uses it as the `addWorktree` start point, and snapshots it to
      `workspaces.base_commit`.
    - RED: route/service/worktree tests failed on missing schema/helper/use.
      GREEN:
      `pnpm --filter maister-web exec vitest run --project unit app/api/runs/__tests__/post-branch.test.ts lib/services/__tests__/runs-launch-branch.test.ts lib/__tests__/worktree.test.ts`
      passed (42 tests).
  - Files: `web/app/api/runs/route.ts`, `web/lib/services/runs.ts`,
    `web/lib/worktree.ts`, `docs/api/web.openapi.yaml`,
    `web/app/api/runs/__tests__/post-branch.test.ts`,
    `web/lib/runs/__tests__/*`.
  - Work: accept optional `baseCommit`; add an ancestor-reachability validator
    adjacent to `resolveBaseCommit` (`git merge-base --is-ancestor <commit>
    <resolvedBaseRef>`, schema-hardened, no shell interpolation) and use the
    commit as the existing `addWorktree` `startPoint`. Missing/unreachable
    commit → `MaisterError` `PRECONDITION` before any worktree side effect.
    Snapshot the effective commit on `workspaces.base_commit` exactly as
    today. Auth-first ordering is already in place — do not regress it.
  - RED: route/service tests for invalid SHA shape, missing commit,
    reachable-from-wrong-branch, and valid reachable commit (worktree HEAD
    assertion).
  - Logging: log launch rejection with `projectId`, `taskId`, `baseRef`,
    `baseCommit`, and git command failure metadata without logging secrets.

### Phase 2: Experiment Launch, Membership, And Overlays

- [x] **T2.1 Add experiment create/list/detail routes**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added strict create/list/detail route handlers with auth/project-action
      checks before create-body parsing and explicit 404 detail misses.
    - Added experiment HTTP schemas, DTO projections, default rubric snapshot,
      and service-level project/task isolation, duplicate variant-key rejection,
      create-time base pinning, list sorting, and detail lookup.
    - Aligned experiment JSON types/tests with frozen API/system analytics
      (`variant.label`, closed `config`, rubric `guidance`/`scale`).
    - RED: route/service tests failed on missing modules and handlers. GREEN:
      `pnpm --filter maister-web exec vitest run --project unit 'app/api/projects/[slug]/experiments/__tests__/route.test.ts' 'app/api/projects/[slug]/experiments/[experimentId]/__tests__/route.test.ts' lib/experiments/__tests__/service.test.ts lib/experiments/__tests__/validation.test.ts`
      passed (17 tests).
    - Compile check: `pnpm --filter maister-web typecheck` passed.
  - Files: `web/app/api/projects/[slug]/experiments/route.ts`,
    `web/app/api/projects/[slug]/experiments/[experimentId]/route.ts`,
    `web/lib/experiments/service.ts`, `web/lib/experiments/http-schemas.ts`,
    `web/lib/experiments/dto.ts`,
    route tests under matching `__tests__` directories.
  - Work: create experiments (resolve + pin `base_commit` at create: branch
    tip or explicit ref, ancestor-check against `base_branch` → `CONFIG`;
    snapshot rubric from the default template or wizard override; validate
    variants against the closed registry), list experiments for a project
    (newest-first, no pagination Phase 1 — recorded), and load a detail DTO.
    Validate cross-resource IDs server-side. Route handlers stay thin:
    session/auth first, zod parse second, service call, explicit DTO
    projection, HTTP error mapping.
  - RED: tests for viewer/member/admin role boundaries, foreign task
    rejection, immutable-from-create fields (mutation attempt →
    `PRECONDITION`), duplicate variant keys → `CONFIG`, project slug
    isolation, and exact response key sets with no DB-row leakage.
  - Logging: structured info on create and structured warn on cross-resource
    rejection with `slug`, `projectId`, `taskId`, and `actorId`.

- [x] **T2.2 Implement launch fan-out**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added strict launch body parsing for `{variants, replicates}` plus the
      session-auth launch route with auth/project-action checks before body
      parsing.
    - Added experiment launch fan-out through the standard `launchRun` path,
      pinned `baseCommit` validation, variant runner/execution-policy
      passthrough, batch/per-run structured logs, and per-run queue outcome
      DTOs.
    - Extended `launchRun` with an `experimentMembership` internal input so
      `experiment_runs` membership rows are inserted in the same transaction
      as the run row, with the first draft launch flipping the experiment to
      `running`.
    - RED: focused tests failed on missing launch route/service/membership
      transaction support and on a too-loose variant execution-policy type.
      GREEN:
      `pnpm --filter maister-web exec vitest run --project unit 'app/api/projects/[slug]/experiments/[experimentId]/launch/__tests__/route.test.ts' lib/experiments/__tests__/launch.test.ts lib/services/__tests__/runs-launch-branch.test.ts`
      passed (29 tests).
    - Compile check: `pnpm --filter maister-web typecheck` passed.
  - Files: `web/app/api/projects/[slug]/experiments/[experimentId]/launch/route.ts`,
    `web/lib/experiments/launch.ts`, `web/lib/services/runs.ts`,
    `web/lib/db/schema.ts`.
  - Work: launch body `{variants: "all" | string[], replicates?: 1..10 default
    1}`. Under the experiment row lock: FSM guard (status ∈ {draft, running,
    comparable} else `PRECONDITION`; unknown variant key → `CONFIG`), then
    validate the WHOLE batch (overlay refs resolve, class×adapter support,
    base commit still exists) BEFORE the first side effect. Each run then goes
    through the standard `launchRun` (variant `runnerId` via the launch
    override tier, `executionPolicy` passthrough, pinned `baseCommit`,
    project package pins inherited), with the `experiment_runs` membership row
    inserted in the SAME transaction as the run insert and `draft→running`
    flipped in the first launch's transaction. Per-run failures use the
    existing launch compensation (worktree + branch cleanup); the batch
    response reports per-variant outcomes. Cap overflow → `Pending` + queue
    position through existing queue semantics (never an error).
  - RED: integration tests prove all member runs share
    `workspaces.base_commit` = the pin even after the base branch advances
    (merge-base assert); 2×2 with cap 2 → 2 live + 2 Pending with positions;
    member runs appear as ordinary attempts in task history; a forced
    membership-insert failure leaves no orphaned member run; two racing launch
    requests resolve via the UNIQUE ordinal (mapped 409/retry, never 500 —
    real two-racer test).
  - Logging: one structured launch-batch log with counts, then per-run logs with
    `experimentId`, `variantKey`, `replicateOrdinal`, `runId`, `baseCommit`,
    and `queueState`.

- [x] **T2.3 Implement relaunch membership inheritance (FR-2a)**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added `relaunchOfRunId` to `POST /api/runs` parsing and launch input
      forwarding; body-controlled experiment ids remain absent.
    - Added `web/lib/experiments/membership.ts` as the server-derived
      membership inheritance seam: missing source run → `PRECONDITION`,
      cross-task source → `CONFLICT`, non-member or terminal experiment →
      plain run, active member → next replicate ordinal for the same variant.
    - Wired `launchRun` to derive manual and budget-restart membership before
      launchability, insert inherited membership via the existing same-
      transaction `experiment_runs` write, and select the force launchability
      gate only for active experiment-member budget restarts.
    - Added deterministic `triggerPayload.idempotencyKey` for budget restarts
      while preserving the existing oldRunId+hitlRequestId recovery lookup.
    - RED: route/service/helper tests failed on missing `relaunchOfRunId`,
      missing membership module, no helper call, no cross-task conflict, and
      busy member budget restart refusal. GREEN:
      `pnpm --filter maister-web exec vitest run --project unit app/api/runs/__tests__/post-branch.test.ts lib/experiments/__tests__/membership.test.ts lib/services/__tests__/runs-launch-branch.test.ts`
      passed (48 tests).
    - New-test discovery:
      `pnpm --filter maister-web exec vitest list --project unit lib/experiments/__tests__/membership.test.ts`
      listed the file under the unit project only.
    - Integration check:
      `pnpm --filter maister-web exec vitest run --project integration lib/services/__tests__/hitl-budget-breach.integration.test.ts`
      passed (27 tests).
    - Compile check: `pnpm --filter maister-web typecheck` passed.
  - Files: `web/app/api/runs/route.ts`, `web/lib/services/runs.ts`,
    `web/lib/services/hitl.ts` (`launchBudgetRestart`,
    `loadBudgetRestartOptions`), `web/lib/runs/launchability.ts`,
    `web/lib/experiments/membership.ts`, `docs/api/web.openapi.yaml`,
    relevant run/HITL tests.
  - Work: three inheritance sources, all server-derived (NEVER a body
    experiment id):
    1. `POST /api/runs` gains optional `relaunchOfRunId` — must reference a
       run of the SAME task else `CONFLICT`; if that run is an experiment
       member and the experiment ∈ {running, comparable}, allocate the next
       `replicate_ordinal` (launch_reason `manual_relaunch`) in the same
       transaction as the run insert; if the experiment is
       concluded/abandoned → plain run, no membership.
    2. ADR-125 budget restart derives the source run from its
       `triggerPayload`; same inheritance rule (launch_reason
       `budget_restart`). Member restarts MUST select the force launchability
       gate (`classifyForceRelaunchLaunchability`) — the current
       `allowConcurrent: false` manual gate refuses `busy` when sibling
       variant runs are live.
    3. The experiment launch route (T2.2) is inherently membership-aware
       (launch_reason `initial`).
    For budget-restart crash-window recovery, persist a deterministic
    idempotency key in the trigger payload so a retry finds the
    already-launched replacement instead of creating a duplicate replicate.
  - RED: tests for manual relaunch via `relaunchOfRunId` (member + non-member
    + cross-task CONFLICT), the ADR-125 restart path end-to-end on a member
    run WITH a live sibling variant run (force gate), restart after
    `concluded` → plain run, concurrent replicate allocation (two racers),
    crash-window retry lookup, and bare task launch mid-experiment staying
    non-member.
  - Logging: log membership inheritance with `sourceRunId`, `newRunId`,
    `experimentId`, `variantKey`, `replicateOrdinal`, and `launchReason`.

- [x] **T2.4 Add variant overlay validation and support matrix**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added `web/lib/experiments/variant-config.ts` as the single source for
      the closed variant config schema, overlay delta validation, selection-key
      mapping, overlay application order, known-ref checks, and adapter support
      assertions.
    - Added `OVERLAY_CLASS_SUPPORT_BY_AGENT` beside the existing enforcement
      table: rules/skills/mcps are supported for all adapters; subagents are
      Claude-only.
    - Rewired experiment HTTP schemas to import the variant config schema
      rather than duplicating overlay shape definitions.
    - Wired launch-time batch validation to reject vanished overlay refs and
      unsupported class×runner combinations before any `launchRun` fan-out.
    - RED: new tests failed on missing `variant-config` and launch-time
      overlay refusal. GREEN:
      `pnpm --filter maister-web exec vitest run --project unit lib/experiments/__tests__/variant-config.test.ts lib/experiments/__tests__/launch.test.ts`
      passed (12 tests).
    - Regression slice:
      `pnpm --filter maister-web exec vitest run --project unit lib/experiments/__tests__/variant-config.test.ts lib/experiments/__tests__/launch.test.ts 'app/api/projects/[slug]/experiments/__tests__/route.test.ts' lib/experiments/__tests__/service.test.ts lib/experiments/__tests__/validation.test.ts`
      passed (27 tests).
    - New-test discovery:
      `pnpm --filter maister-web exec vitest list --project unit lib/experiments/__tests__/variant-config.test.ts`
      listed the file under the unit project only.
    - Compile check: `pnpm --filter maister-web typecheck` passed.
  - Files: `web/lib/experiments/variant-config.ts`,
    `web/lib/flows/enforcement.ts` (new `OVERLAY_CLASS_SUPPORT_BY_AGENT`
    constant — or `web/lib/capabilities/agent-map.ts` if closer to the adapter
    descriptors), `web/lib/capabilities/types.ts`,
    `web/lib/experiments/__tests__/variant-config.test.ts`.
  - Work: closed zod schema for `{runnerId?, executionPolicy?,
    capabilityOverlay?}` with the four per-class add/remove members mapped to
    profile selection keys (rules→ruleIds, skills→skillIds, mcps→mcpIds,
    subagents→agentDefinitionIds). Introduce the NEW overlay support matrix
    (subagents claude-only; rules/skills/mcps all adapters) — verified absent
    from `ENFORCEABILITY_BY_AGENT` today. Launch-time resolution of overlay
    refs through the existing catalog resolver; vanished ref → `CONFIG` naming
    the ref; unsupported class×resolved-adapter → `CONFIG` before fan-out
    side effects.
  - RED: pure tests for unknown keys, unknown IDs, remove-before-add ordering,
    duplicate add+remove of the same ref, incompatible adapter/class refusal
    (subagents on codex), and unchanged baseline variants (empty overlay =
    node profile untouched).
  - Logging: log CONFIG refusals with `experimentId`, `variantKey`,
    `overlayKind`, `capabilityId`, and `runnerId`.

- [x] **T2.5 Integrate overlays into materialization (slices s1→s2→s3)**
  - Files: `web/lib/flows/graph/runner-graph.ts` (selection merge before the
    `resolveCapabilityProfile` call at ~1627),
    `web/lib/capabilities/materialize.ts`,
    `web/lib/experiments/materialization-delta.ts`,
    `web/lib/flows/graph/__tests__/*`,
    `web/lib/capabilities/__tests__/*`.
  - Work: at node materialization, load the run's experiment membership
    (`experiment_runs` → immutable `experiments.variants`) and merge the
    variant overlay into the node's capability selection BEFORE
    `resolveCapabilityProfile`; materialize through the existing pipeline
    (`pinCatalogToSnapshot` → `materializeCapabilityProfile`) — NO parallel
    writer. Slice order: s1 rules+skills (file-materialized), s2 mcps
    (session config; exec-trust via `gateStdioMcpsByExecTrust` holds), s3
    subagents (claude-only). Persist the compact applied delta to
    `experiment_runs.materialization_delta`; the `profile.json` snapshot must
    reflect the overlay. **FR-3 budget gate checkpoint sits between slices** —
    if the budget blows, record one of the four fork outcomes in this plan +
    the PR (default bias: s1 shipped first).
  - RED: mock-adapter integration tests inspect
    `.maister/capabilities/<runId>/<nodeAttemptId>/profile.json` and adapter
    home outputs per class (skill added/removed, rule added, MCP added passes
    exec-trust / untrusted stdio withheld, subagent added on claude); a
    non-member run's materialization is byte-identical to pre-feature output.
  - Logging: materialization logs include `runId`, `nodeAttemptId`,
    `experimentId`, `variantKey`, `addedCounts`, and `removedCounts`.

### Phase 3: Status, Snapshots, Retention, Verdict

- [x] **T3.1 Recompute experiment status at run-state choke points**
  - Files: `web/lib/experiments/status-sync.ts`,
    `web/lib/runs/state-transitions.ts`, `web/lib/runs/resume-driver.ts`
    (the primary Review flip ~298), `web/lib/services/runs.ts`,
    `web/lib/services/hitl.ts`, the generalized run-stop dispatcher,
    reconcile, promote,
    `web/lib/experiments/__tests__/status-sync.integration.test.ts`.
  - Work: implement `syncExperimentStatusForRun(tx, runId)`: no-op for
    non-members; otherwise `SELECT … FOR UPDATE` the experiment row, re-read
    ALL member run statuses fresh UNDER the lock, derive the status by the
    canonical comparable rule, and write only on change via the allow-listed
    transitions (terminal experiment states never overwritten). Wire it INSIDE
    the same transaction at every `runs.status` writer touching potential
    members — enumerate writers by grep (`resume-driver`, `state-transitions`
    helpers, launch, stop dispatcher, hitl composites, reconcile `Crashed`,
    promote `Done`, workbench abandon) and record the enumeration in the task
    notes. Event-driven only: no polling, no timers, no watchers.
  - RED: integration tests for draft→running on first launch,
    running→comparable when the LAST member run parks (and NOT before — a
    NeedsInput member keeps `running`), comparable→running on a new replicate,
    Crashed member counting as terminal for comparability, and
    concluded/abandoned rejection of recompute overwrites.
  - Logging: log status recompute only when status changes, with readiness
    counts by variant.

- [x] **T3.2 Capture idempotent diff snapshots + file summaries**
  - Files: `web/lib/experiments/diff-snapshot.ts`, `web/lib/worktree.ts`
    (existing truncating diff reader), `web/lib/diff/prepare.ts`
    (`prepareDiffSummary` reuse), `web/lib/runs/resume-driver.ts`,
    `web/lib/runs/state-transitions.ts`,
    `web/lib/experiments/__tests__/diff-snapshot.integration.test.ts`.
  - Work: at each member run's Review/terminal transition, produce the FULL
    unified diff against the pinned range (fixed stored SHA base → 2-dot
    range), compute the per-file summary from the full diff
    (`prepareDiffSummary`-shaped + per-file `patchHash`) into
    `diff_files_summary`, then persist the text capped at 512 KB with the
    STRUCTURED `diff_snapshot_truncated` flag (never an in-band marker).
    Write-once guard (`WHERE diff_snapshot IS NULL` or the explicit
    newer-Review re-capture rule for terminal-after-Review); idempotent and
    crash-safe — re-attempted at the same trigger; capture failure never
    blocks the status transition (comparability is status-based).
  - RED: tests for no-workspace runs, huge diff truncation with complete
    files summary, repeated-call idempotency, terminal-after-Review
    re-capture, and snapshot failure leaving status transition intact.
  - Logging: log snapshot capture with `experimentId`, `runId`, `bytes`,
    `truncated`, `fileCount`, and git failure context.

- [x] **T3.3 Protect active experiment workspaces from automated GC**
  - Files: `web/lib/gc/workspace-gc.ts` (`loadCandidates`),
    the reconcile/TTL sweep call sites, `web/lib/gc/__tests__/*`.
  - Work: extend the candidate predicate with a `notExists(experiment_runs ⋈
    experiments WHERE status NOT IN ('concluded','abandoned'))` term — the
    same shape as the existing `treeNotBlocked` guard. If Tact 3 (ADR-126) is
    on main by then, REUSE/extend its referenced-run guard predicate instead
    of adding a parallel one. Manual workbench drop/archive stays allowed
    (documented; the lab serves from snapshots afterward). After
    conclusion/abandonment, normal TTL resumes.
  - RED: GC integration tests for Done/Abandoned member runs held while the
    experiment is running/comparable, released after conclusion/abandonment,
    coexisting with the shared-tree hold, and non-member runs unaffected.
  - Logging: add debug hold logs with `workspaceId`, `runId`, `experimentId`,
    `experimentStatus`, and hold reason.

- [x] **T3.4 Implement conclude and abandon services**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added conclude/abandon route handlers with auth/project-action checks
      before body parsing and exact DTO responses.
    - Added human-only conclusion validation, comparable-state guard,
      rubric/variant verdict revalidation, transactional
      `experiment_concluded` task activity, and post-commit loser/live-run
      stop dispatch through the standard `stopWorkbenchRun` path.
    - Added activity renderer/i18n mapping for `experiment_concluded` in task
      timelines and the project task log.
    - RED/GREEN: lifecycle service tests initially caught missing post-commit
      stop dispatch and fake-DB activity semantics; GREEN:
      `pnpm --filter maister-web exec vitest run --project unit lib/experiments/__tests__/service.test.ts lib/experiments/__tests__/verdict.test.ts 'app/api/projects/[slug]/experiments/[experimentId]/conclude/__tests__/route.test.ts' 'app/api/projects/[slug]/experiments/[experimentId]/abandon/__tests__/route.test.ts'`
      passed (21 tests).
    - Discovery/typecheck:
      `pnpm --filter maister-web exec vitest list --project unit 'app/api/projects/[slug]/experiments/[experimentId]/conclude/__tests__/route.test.ts'`
      and the matching abandon route listed only under unit; `pnpm --filter
      maister-web typecheck` passed.
  - Files: `web/app/api/projects/[slug]/experiments/[experimentId]/conclude/route.ts`,
    `web/app/api/projects/[slug]/experiments/[experimentId]/abandon/route.ts`,
    `web/lib/experiments/verdict.ts`, `web/lib/experiments/service.ts`,
    the `task_activity` kind registry + activity feed renderer,
    `web/messages/en.json`, `web/messages/ru.json`, route/service tests.
  - Work: conclude — human session only (machine/token actor → rejected, M17
    rule), `concludeExperiments` action, experiment row lock, status =
    `comparable` re-read under the lock else `PRECONDITION`; ONE transaction
    writes `verdict.human` (validated against the rubric snapshot: outcome
    union, winner ∈ variant keys, scores keyed by criterion ids, optional
    criteria skippable), `status = concluded` + `concluded_by/at`, and the
    `experiment_concluded` `task_activity` row on the bound task (renderer +
    i18n + inbox classification for the new kind). Optional `abandonLosers`
    dispatches loser runs through the STANDARD run-stop dispatcher AFTER the
    commit (idempotent, per-run). Member-run gates/statuses are never mutated
    by the verdict itself. Abandon — `manageExperiments`, row-locked
    transactional flip from {draft, running, comparable}; optional
    `stopLiveRuns` stops live member runs via the standard dispatcher (UI
    checkbox defaults ON, server field explicit). Advisory appends after any
    terminal state → `PRECONDITION`.
  - RED: tests for agent-token conclude rejection, viewer rejection,
    conclude-in-running `PRECONDITION`, double-conclude, conclude racing a
    replicate launch (row-lock serialization, two-racer test), winner key not
    in variants → `CONFIG`, abandon from each non-terminal state incl. with
    live runs (dispatcher invoked), and gates/status untouched assertions.
  - Logging: audit conclude/abandon with `experimentId`, `actorId`,
    `winnerVariantKey`, `affectedRunIds`, and status transition.

### Phase 4: Comparison DTOs, Diff-Of-Diffs, Rubric, Judge

- [x] **T4.1 Build comparison DTO facade (with on-read verification)**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added `web/lib/experiments/comparison.ts` with explicit comparison DTOs
      for experiment metadata, variants, member runs, status tones, durations,
      runner labels, gates, cost rollups/no-data state, snapshots,
      files summaries, materialization deltas, and verdict envelope.
    - Added on-read status verification: comparison reads derive the canonical
      member-run status, heal drifted non-terminal experiment status, and WARN
      with structured identifiers.
    - Added session `GET .../comparison` and external
      `GET /api/v1/ext/projects/{slug}/experiments/{experimentId}` routes
      using `readExperiments` / `experiments:read`.
    - RED/GREEN: `comparison.test.ts` first failed on the missing facade;
      GREEN:
      `pnpm --filter maister-web exec vitest run --project unit lib/experiments/__tests__/comparison.test.ts 'app/api/projects/[slug]/experiments/[experimentId]/comparison/__tests__/route.test.ts' 'app/api/v1/ext/projects/[slug]/experiments/[experimentId]/__tests__/route.test.ts'`
      passed (4 tests).
    - Discovery/typecheck: all three new test files listed under the unit
      project only; `pnpm --filter maister-web typecheck` passed.
  - Files: `web/lib/experiments/comparison.ts`, `web/lib/experiments/dto.ts`,
    `web/app/api/projects/[slug]/experiments/[experimentId]/comparison/route.ts`,
    `web/app/api/v1/ext/projects/[slug]/experiments/[experimentId]/route.ts`.
  - Work: load experiment, variants, member runs (status/tone, duration from
    `startedAt/endedAt`, queue position for Pending, attempt number,
    launch_reason lineage), run sessions (runner labels), gate results (kind,
    mode, status, verdict incl. ai_judgment confidence), cost rollups (token
    classes incl. resume-attributed, byModel/byRunner — explicit no-data when
    the rollup row is absent), diff snapshots + files summaries + truncation
    flags, materialization deltas, and the verdict envelope. Perform the
    request-mandated ON-READ status verification: recompute the derived
    status; on drift, heal in a guarded write + WARN log (signals a missed
    choke point). Project explicit DTOs; the ext response mirrors the
    documented subset (incl. snapshots). The read path executes nothing
    beyond the existing diff route's on-demand recompute while refs exist.
  - RED: integration tests with real Postgres fixtures for missing cost,
    missing snapshot, failed run, multiple replicates, drifted-status healing,
    external read scope (positive + negative), and EXACT response shape for
    web and ext DTOs (no server-only fields).
  - Logging: read routes log only at debug/audit level with `experimentId`,
    `projectId`, `viewerType`, and row counts.

- [x] **T4.2 Implement `computeDiffOfDiffs` + files-comparison utilities**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added pure `computeDiffOfDiffs` with normalization for volatile diff
      headers/hunk offsets and LCS-based added/removed line output, plus
      structured `partial` propagation for truncated inputs.
    - Added pure `buildFilesMatrix` from full-diff file summaries with
      `single`, `same`, and `different` classifications, stable per-path
      sorting, touched-by lists, and All/Different/Same filters.
    - RED/GREEN: tests first failed on missing modules; GREEN:
      `pnpm --filter maister-web exec vitest run --project unit lib/experiments/__tests__/diff-of-diffs.test.ts lib/experiments/__tests__/files-matrix.test.ts`
      passed (5 tests).
    - Discovery/typecheck: both new test files listed under unit only;
      `pnpm --filter maister-web typecheck` passed.
  - Files: `web/lib/experiments/diff-of-diffs.ts`,
    `web/lib/experiments/files-matrix.ts`,
    `web/lib/experiments/__tests__/diff-of-diffs.test.ts`,
    `web/lib/experiments/__tests__/files-matrix.test.ts`.
  - Work: TWO pure utilities. (1) `computeDiffOfDiffs(unifiedA, unifiedB)`:
    normalize both diffs (strip index/hash and volatile header lines,
    normalize hunk offsets) → line-level LCS diff of the normalized diffs,
    for the Diff-of-diffs tab. (2) `buildFilesMatrix(summaries[])`: per-file
    touched-by/same/different classification across variants from
    `diff_files_summary` (`patchHash` equality = same), powering the Files
    tab and its All/Different/Same filters — works from summaries alone
    (truncation/GC-proof).
  - RED: fixtures — identical changes → empty; disjoint file sets; same file
    different hunks; RENAMES; binary/unparseable diff fallback; truncated
    snapshot inputs flagged partial (structured flag, not a marker string).
  - Logging: no runtime logging in pure utilities; callers log parse fallback
    counts as structured fields.

- [x] **T4.3 Implement rubric-as-data (single source)**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added `web/lib/experiments/rubric.ts` as the single source for rubric
      zod schemas, the platform default template, and human verdict score/
      optional-skip/winner validation.
    - Rewired create HTTP schemas and experiment service to import the rubric
      module; `verdict.ts` is now a compatibility re-export, not a duplicate
      implementation.
    - RED/GREEN: rubric tests first failed on the missing module; GREEN:
      `pnpm --filter maister-web exec vitest run --project unit lib/experiments/__tests__/rubric.test.ts lib/experiments/__tests__/verdict.test.ts lib/experiments/__tests__/service.test.ts`
      passed (20 tests).
    - Grep/typecheck: rubric schema/default/validation references resolve to
      `rubric.ts` (plus the `verdict.ts` re-export); `pnpm --filter
      maister-web typecheck` passed; rubric test file listed under unit only.
  - Files: `web/lib/experiments/rubric.ts` (the ONE schema module + the
    platform default template constant), `web/lib/experiments/__tests__/rubric.test.ts`.
  - Work: define the criterion schema `{id, label, guidance, scale, weight?,
    optional?}` and the default template with EXACTLY `correctness`,
    `completeness`, `consistency`, `code_quality`, `cost_efficiency`,
    `specs_traceability` (optional). Validation: weights, score-in-scale,
    scores keyed by criterion id × variant key, winner ∈ variant keys,
    optional-criteria skip semantics. This module is the single source for
    the verdict form (T5.4), the judge prompt contract (T4.5 — criterion
    `guidance` = judge instruction), and the DTO — no copies.
  - RED: tests for invalid weights, unknown criterion/winner keys, empty
    criteria, out-of-scale scores (re-validated at the untrusted advisory
    sink — out-of-range ≠ missing), optional-skip acceptance, and template
    defaults.
  - Logging: service logs rubric validation failures with `experimentId`,
    `criterionKey`, and actor, avoiding verdict text in logs.

- [x] **T4.4 Add MCP facade experiment tools (read + advisory)**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Confirmed MCP `experiment_get` and `experiment_advise` dispatch to the
      external read/advisory operations and aligned the advisory score body to
      criterion-id -> variant-key -> score across OpenAPI, route zod, service,
      and MCP dispatch tests.
    - Added `web/lib/experiments/advisory.ts` append-only service with row-lock
      semantics, status guard (`running|comparable` only), rubric score
      revalidation, ordinal allocation, and optional in-transaction audit hook.
    - Added external advisory route with `experiments:advise`,
      `successAuditInWork: true`, CONFIG/PRECONDITION error mapping, and no
      human/status mutation.
    - RED/GREEN: advisory tests first failed on missing service/route; GREEN:
      `pnpm --filter maister-web exec vitest run --project unit lib/experiments/__tests__/advisory.test.ts 'app/api/v1/ext/projects/[slug]/experiments/[experimentId]/advisory/__tests__/route.test.ts'`
      passed (3 tests).
    - Contract checks: `pnpm --filter @maister/mcp test:unit -- src/__tests__/tool-contract.test.ts src/__tests__/tools.test.ts`
      passed (189 tests); `pnpm validate:docs`, `pnpm --filter maister-web
      typecheck`, and `pnpm --filter @maister/mcp typecheck` passed; advisory
      test files listed under unit only.
  - Files: `mcp/src/tools.ts`, `mcp/src/rest.ts`,
    `mcp/src/__tests__/tools.test.ts`,
    `mcp/src/__tests__/tool-contract.test.ts`,
    `docs/api/external/operations.openapi.yaml`,
    `web/app/api/v1/ext/projects/[slug]/experiments/[experimentId]/advisory/route.ts`,
    `web/lib/experiments/advisory.ts`.
  - Work: `experiment_get` maps to the ext read op (`experiments:read`);
    `experiment_advise` maps to the ext advisory op (`experiments:advise`,
    `successAuditInWork: true`) — the triage_set precedent. The advisory
    service appends to `verdict.judgeAdvisories[]` under the experiment row
    lock, status ∈ {running, comparable} else `PRECONDITION`, re-validating
    scores against the rubric at this untrusted sink (fail-closed on
    out-of-range). TOOL_SPECS hand-mirrors the ext zod (properties, required,
    types, enums, bounds); no other mutating experiment tools in Phase 1.
  - RED: the MCP contract test fails until both tools map to their ext
    operations; dispatch tests fail until the tools forward exactly `slug` +
    `experimentId` (+ advisory body); integration tests for advisory append,
    ordinal increment, post-conclude `PRECONDITION`, out-of-range score
    rejection, and scope denial.
  - Logging: ext route audit logs carry `scopeUsed`, `tokenId`,
    `experimentId`, `advisoryOrdinal`.

- [x] **T4.5 Add advisory `experiment-judge` platform agent**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added `core:experiment-judge` platform-agent definition with
      `workspace: none`, `mode: session`, `risk_tier: read_only`, manual
      trigger, advisory-only/no-conclusion guardrails, and required
      `experiment_get` -> `experiment_advise` MCP procedure.
    - Added `web/lib/experiments/judge.ts` as a thin dispatch wrapper around
      the standard `launchAgentRun` manual-trigger path with payload
      `{experimentId}` and workspace `none`.
    - Synced the agent definition and core package manifest into the external
      `maister-plugins/packages/core` checkout; byte identity verified with
      `cmp -s` for both files.
    - RED/GREEN: judge dispatch test first failed on the missing helper;
      GREEN:
      `pnpm --filter maister-web exec vitest run --project unit lib/agents/__tests__/experiment-judge-definition.test.ts lib/agents/__tests__/triager-definition.test.ts lib/experiments/__tests__/judge.test.ts`
      passed (7 tests).
    - Discovery/typecheck: new judge tests listed under unit only; `pnpm
      --filter maister-web typecheck` passed.
  - Files: `maister-plugins` `packages/core/maister-agents/experiment-judge.md`,
    `web/lib/agents/__tests__/fixtures/core-package/maister-agents/experiment-judge.md`
    (mirror pair — byte-identical, diff BEFORE cp-sync),
    judge definition tests alongside `triager-definition.test.ts`,
    `web/lib/experiments/judge.ts`, `web/lib/agents/launch.ts` call site.
  - Work: package-sourced agent with the frontmatter contract `workspace:
    none`, `mode: session`, `risk_tier: read_only`, `triggers: [manual]`, and
    recommended runner bindings that satisfy `workspace: none` (claude
    non-skip runner — triager precedent). Launch: the lab's "Ask judge"
    action calls `launchAgentRun` with a manual trigger payload carrying
    `{experimentId}`. The agent reads the comparison DTO + rubric via
    `experiment_get`, scores the SAME rubric (criterion guidance as
    instruction; optional criteria only when a requirements source exists),
    writes via `experiment_advise`, MAY post a task-thread comment through the
    existing comment pipeline (`comments:create` is already in
    `AGENT_TOKEN_SCOPES`), and NEVER concludes (server rejects machine
    conclude regardless). Memory recall optional (graceful absence). Bump +
    tag the core package version, coordinated with the pending triager
    release line on maister-plugins.
  - RED: package-definition tests fail until the agent parses/projects;
    mirror-pair test fails until plugins deliverable and fixture are
    byte-identical; prompt-invariant tests fail unless the persona states
    advisory-only/no-conclusion; token tests fail until `experiments:read` +
    `experiments:advise` are available to agent runs; a scripted
    substrate-level session posts advisory scores keyed by criterion ids and
    they surface in the comparison DTO.
  - Logging: judge dispatch logs `experimentId`, `agentId`, `runId`,
    `advisoryOrdinal`, and refusal reasons.

### Phase 5: User Interface

- [x] **T5.1 Build experiments list and create flow**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added the nested experiments list page, typed presentational list, and a
      client create modal that can create an inline task first and then create
      the experiment with pinned-base, variants, overlay fields, and rubric
      snapshot payload.
    - Added EN/RU messages for list/create/status/outcome copy and render
      tests covering empty, list, error, localized labels, task creation,
      pinned-base, overlay fields, and rubric defaults.
    - RED/GREEN:
      `pnpm --filter maister-web exec vitest run --project unit components/experiments/__tests__/experiment-list.test.ts`
      passed as part of the Phase 5 render test batch; new test discovery
      listed the file under unit only and not integration. Compile check:
      `pnpm --filter maister-web typecheck` passed.
  - Files: `web/app/(app)/projects/[slug]/experiments/page.tsx`,
    `web/components/experiments/experiment-list.tsx`,
    `web/components/experiments/create-experiment-modal.tsx`,
    `web/components/experiments/variant-editor.tsx`,
    `web/components/experiments/rubric-editor.tsx`,
    `web/messages/en.json`, `web/messages/ru.json`.
  - Work: full-width list page (admin conventions: view table, popup edits) —
    columns: title, task (KEY-N link), status chip, variants count, pinned
    commit short SHA, created, verdict/winner when concluded; row → lab.
    Create modal wizard: task picker with inline task creation, title, base
    branch + optional explicit ref (shows the SHA that will be pinned),
    variants editor (key/label + per-class overlay pickers from the catalog +
    runner/policy fields, validated against the closed registry with
    localized errors), rubric editor PRE-FILLED from the platform default
    template. Localized validation copy EN+RU (every enum label through
    i18n).
  - RED: renderToStaticMarkup tests for empty/list/error/create states, both
    locales, before implementation passes.
  - Logging: UI does not log directly; API create calls carry structured logs
    from T2.1.

- [x] **T5.2 Build experiment lab page**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added the nested lab page backed by `getExperimentComparison`, role
      gates, task link resolution, project tabs, judge-availability lookup,
      and a lab component with localized FSM chip, pinned commit, actions,
      variant/replicate matrix, duration, queue position, run links, and
      crashed-member visibility.
    - RED/GREEN:
      `pnpm --filter maister-web exec vitest run --project unit components/experiments/__tests__/experiment-lab.test.ts`
      passed in the Phase 5 batch; discovery listed the file under unit only
      and not integration. Compile check:
      `pnpm --filter maister-web typecheck` passed.
  - Files: `web/app/(app)/projects/[slug]/experiments/[experimentId]/page.tsx`,
    `web/components/experiments/experiment-lab.tsx`,
    `web/components/experiments/variant-matrix.tsx`,
    `web/components/experiments/run-status-strip.tsx`.
  - Work: header — FSM chip (localized), pinned commit short SHA + copy,
    base branch, task link, and icon+label actions (Launch with
    variant-multiselect + replicates default 1, Abandon with confirm,
    Conclude CTA visible when comparable). Matrix — variants × replicates;
    each cell: run status chip via `run-status-tone.ts`, duration, queue
    position when Pending, run link, and a compact node-status strip composed
    from `node-status-icon.tsx` fed by the existing per-run SSE stream (no
    new SSE contract). Per-variant replicate selector (default: latest
    replicate) feeding the tabs. URL-synced tab state.
  - RED: render tests for draft/running/comparable/concluded/abandoned states
    incl. Pending queue position, Crashed member surfaced-but-concludable,
    and both locales.
  - Logging: UI delegates; comparison route debug logs include loaded
    tab-relevant counts.

- [x] **T5.3 Build comparison tabs**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added server-renderable Diff, Diff-of-diffs, Files, Gates, and Cost tab
      components with pair chips for N>2 variants, stored-snapshot/truncation
      states, compared-file context, `buildFilesMatrix`, gate confidence, and
      honest no-cost/no-snapshot states. Added the plan-named wrapper files for
      stable imports.
    - RED/GREEN:
      `pnpm --filter maister-web exec vitest run --project unit components/experiments/__tests__/comparison-tabs.test.ts`
      passed in the Phase 5 batch; discovery listed the file under unit only
      and not integration. Compile check:
      `pnpm --filter maister-web typecheck` passed.
  - Files: `web/components/experiments/diff-tab.tsx`,
    `web/components/experiments/diff-of-diffs-tab.tsx`,
    `web/components/experiments/files-tab.tsx`,
    `web/components/experiments/gates-tab.tsx`,
    `web/components/experiments/cost-tab.tsx`,
    existing `DiffView`/`web/lib/diff/prepare.ts` as reusable dependencies.
  - Work: Diff — side-by-side per variant with a PAIR SELECTOR for N>2
    variants; server prepares `PreparedFile[]` from the snapshot text (or the
    on-demand diff route while refs exist) — plain DTO across Flight,
    dual-theme shiki CSS per ADR-066; truncation banner and a "refs gone —
    serving stored snapshot" notice. Diff-of-diffs — T4.2 output with an
    empty-state for identical changes. Files — matrix from
    `buildFilesMatrix` with All/Different/Same filters and per-file A-vs-B
    drilldown (content diff when available; explicit "content unavailable
    (truncated, refs gone)" fallback). Gates — gate kind × variant grid with
    blocking/advisory badges and ai_judgment verdict + confidence. Cost —
    per-variant token classes incl. resume-attributed tokens, byModel/
    byRunner breakdown, duration, honest "tokens, not $" caption, explicit
    no-data state. Sections fetch lazily by tab if payload-size tests demand.
  - RED: render tests for missing snapshots, truncated snapshots, refs-gone
    fallback, no cost, mixed gate outcomes, N=3 pair selection, and many
    files without layout shift.
  - Logging: no client logging; server DTO records parse/truncation counters.

- [x] **T5.4 Build verdict and judge controls**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added rubric-driven verdict panel, advisory rendering beside human
      inputs, read-only terminal/viewer states, and a judge panel with
      unavailable/pending/ready states. Added a narrow internal session route
      `POST /api/projects/{slug}/experiments/{experimentId}/judge` that uses
      project auth and the T4.5 judge launch helper.
    - RED/GREEN:
      `pnpm --filter maister-web exec vitest run --project unit components/experiments/__tests__/verdict-panel.test.ts`
      passed in the Phase 5 batch; discovery listed the file under unit only
      and not integration. Compile check:
      `pnpm --filter maister-web typecheck` passed.
  - Files: `web/components/experiments/verdict-panel.tsx`,
    `web/components/experiments/judge-panel.tsx`,
    conclude/abandon route callers, `web/messages/en.json`,
    `web/messages/ru.json`.
  - Work: verdict panel renders the scoring form FROM the rubric snapshot
    (criteria × variant score inputs, optional criteria skippable, weights
    shown, winner/tie/inconclusive selector, comment, `abandonLosers`
    checkbox); judge advisories render BESIDE the human inputs (per-criterion
    suggested scores + summary + confidence, clearly labeled advisory).
    "Ask judge" button with availability states: core package not
    installed/agent not attached → disabled with guidance linking to project
    agents settings; attached → launches and shows pending/done advisory
    states. Permission-gated controls (viewer sees read-only), accessible
    confirmation dialogs, concluded/abandoned read-only view showing the
    recorded verdict.
  - RED: render tests for permission-hidden controls, rubric-driven form
    (incl. optional-skip), validation errors, advisory pending/done/absent
    states, judge-unavailable guidance, and the concluded read-only view —
    both locales.
  - Logging: API routes from T3.4/T4.4/T4.5 log; UI emits no ad hoc console
    logs.

- [x] **T5.5 Add project navigation and screen docs**
  - Status: completed (2026-07-03).
  - Completion notes (2026-07-03):
    - Added the Experiments project tab with nested
      `/projects/{slug}/experiments` href, EN/RU nav labels, and active-state
      render coverage. The screen doc had already been created in T0.3 and
      documents the nested-route deviation from query tabs.
    - RED/GREEN:
      `pnpm --filter maister-web exec vitest run --project unit components/board/__tests__/project-tabs.test.ts`
      passed in the Phase 5 batch; discovery listed the file under unit only
      and not integration. Compile check:
      `pnpm --filter maister-web typecheck` passed.
  - Files: `web/components/board/project-tabs.tsx` (TABS array + label +
    `hrefFor`), `web/messages/en.json`, `web/messages/ru.json`,
    `docs/screens/projects/project-experiments.md`.
  - Work: add the Experiments tab following the existing pattern; `hrefFor`
    points at the nested `/projects/{slug}/experiments` route
    (request-mandated pages; deviation from the `?tab=` pattern recorded in
    the screen doc). Screen doc follows the existing R5-style skeleton.
  - RED: render/navigation tests fail until link and active state exist.
  - Logging: no product logging required.

### Phase 6: Verification, Edge Cases, And Release Prep

- [x] **T6.1 Contract and docs validation**
  - Files: all docs/API files touched above, `mcp/src/__tests__/tool-contract.test.ts`.
  - Work: run `pnpm validate:docs` (mermaid + ADR anchors) and fix anchors,
    OpenAPI schemas, status labels, and MCP facade drift. Grep-sweep every new
    status/scope/action/launch-reason across code, specs, docs, UI labels,
    and tests. Confirm no AsyncAPI/event additions slipped in.
  - RED/GREEN: validation must fail on incomplete contracts during RED and pass
    before code merge.
  - Logging: no product logging; validation output is recorded in final notes.
  - Completed evidence: `pnpm validate:docs` passed; `pnpm --filter @maister/mcp typecheck` passed;
    `pnpm --filter @maister/mcp test:unit -- src/__tests__/tool-contract.test.ts src/__tests__/tools.test.ts`
    passed; grep sweep confirmed new experiment statuses/scopes/actions/tools
    across docs/API/web/MCP, and `rg "experiment|experiments" docs/api --glob
    '*.asyncapi.y*'` returned no AsyncAPI/SSE additions.

- [x] **T6.2 Real-Postgres integration suite**
  - Files: `web/lib/experiments/__tests__/*.integration.test.ts`,
    API route integration tests, existing testcontainers helpers.
  - Work: cover schema constraints, launch fan-out transactions, membership
    inheritance, status sync, snapshots, GC hold/release, advisory append,
    external read route, and authz boundaries — each added RED first.
  - RED/GREEN: each test is added failing first, then implemented to green.
  - Logging: tests assert key structured log calls where the existing harness
    captures pino output; otherwise assert state and error payloads.
  - Completed evidence: added
    `web/lib/experiments/__tests__/service.integration.test.ts`; sandbox RED
    exposed container-runtime access and then a fixture `base_commit` mismatch;
    escalated GREEN
    `pnpm --filter maister-web exec vitest run --project integration lib/experiments/__tests__/service.integration.test.ts`
    passed and covers real-Postgres create/list/status-heal/comparison evidence,
    advisory append, conclusion, and task activity persistence.

- [x] **T6.3 Mock ACP run-flow suite**
  - Files: `web/lib/flows/graph/__tests__/*`,
    `web/e2e/fixtures` or existing fake ACP helpers,
    supervisor test fixture references if needed.
  - Work: use the existing fake/mock ACP adapter to drive Review/terminal
    transitions and prove snapshot capture, comparable status, and overlay
    materialization end-to-end through the runner graph.
  - RED/GREEN: first prove missing hooks leave experiments `running`; then add
    hooks and turn tests green.
  - Logging: assert structured snapshot/status logs include run and experiment
    identifiers.
  - Completed evidence:
    `pnpm --filter maister-web exec vitest run --project unit lib/experiments/__tests__/status-sync.test.ts lib/experiments/__tests__/diff-snapshot.test.ts`
    passed; escalated
    `pnpm --filter maister-web exec vitest run --project integration lib/flows/graph/__tests__/runner-graph.materialize.integration.test.ts`
    passed and covers overlay materialization, experiment member status sync,
    and diff snapshot capture through the runner graph/fake ACP path.

- [x] **T6.4 One stub-supervisor Playwright E2E (both locales)**
  - Files: `web/e2e/experiment-comparison.spec.ts`,
    `web/e2e/global-setup.ts`, seed helpers as needed.
  - Work: create an experiment (with rubric) → launch two variants through the
    stub supervisor → observe `comparable` → open matrix/diff/files/cost/gates
    → record a human verdict → conclude. Assert the key lab strings and states
    under BOTH locales (one spec, two locale contexts). Note: the e2e harness
    was fixed on the Tact 3 branch (vector-ext + migrate-brain in
    globalSetup) — if this branch lands first, port that harness fix here.
  - RED/GREEN: e2e initially fails on missing routes/UI and passes after UI
    implementation.
  - Logging: test asserts route responses and visible UI; product logs are not
    parsed unless existing E2E infrastructure exposes them safely.
  - Completed evidence: added `web/e2e/experiment-comparison.spec.ts`,
    whitelisted it in `web/playwright.config.ts`, and ported the E2E Brain
    migration harness fix in `web/e2e/global-setup.ts`; RED runs caught the
    missing `0090_experiments`/Brain preflight and selector mismatches; GREEN
    `pnpm --filter maister-web test:e2e -- e2e/experiment-comparison.spec.ts`
    passed with EN and RU locale flows opening list/lab, diff/files/gates/cost,
    submitting the real conclusion route, and rendering the locked verdict.

- [x] **T6.5 Edge-case sweep (request §10 — one owning test each)**
  - Files: targeted tests across `web/lib/experiments`, API routes, GC, runs,
    and UI components.
  - Work: verify each §10 edge has its owning test (some land in earlier
    tasks — cross-check, do not duplicate):
    1. human-launched non-member run on the same task mid-experiment (T2.3);
    2. duplicate launch click / replicate ordinal race (T2.2);
    3. conclude vs concurrent replicate-launch race (T3.4);
    4. conclude vs budget-restart race — restart after `concluded` creates NO
       membership (T2.3);
    5. base branch deleted after pin — new launch `PRECONDITION`, existing
       runs unaffected;
    6. mid-run human form — both variants pause, experiment stays `running`
       (T3.1) + documented in the domain doc;
    7. winner promotion when the target moved past the pin — normal merge
       semantics via the existing promote path (conflict → abort, run stays
       Review), test or documented assertion;
    8. overlay ref vanished from the catalog between create and launch —
       launch-time `CONFIG` naming the ref (T2.4);
    9. SQLite dialect — feature functions (schema parity boot check),
       decision documented (T0.2);
    10. experiment abandon with live runs — standard dispatcher, then
        terminal (T3.4);
    plus: deleted task, disabled runner at launch, overlay removing a
    flow-required capability (resolver refusal surfaces), snapshot
    truncation, missing cost, failed run rendering, and external scope
    denial.
  - RED/GREEN: add failing tests for each uncovered edge before fixes.
  - Logging: verify errors are explicit `MaisterError` payloads with actionable
    context, not catch-all failures.
  - Completed evidence: coverage sweep mapped §10 edges to existing owners and
    added the missing conclude-vs-launch race guard in `launchRun` with
    `runs-launch-branch.test.ts`; targeted GREEN commands:
    `pnpm --filter maister-web exec vitest run --project unit lib/services/__tests__/runs-launch-branch.test.ts`
    and
    `pnpm --filter maister-web exec vitest run --project unit lib/experiments/__tests__/launch.test.ts lib/experiments/__tests__/membership.test.ts lib/experiments/__tests__/service.test.ts lib/experiments/__tests__/comparison.test.ts components/experiments/__tests__/comparison-tabs.test.ts components/experiments/__tests__/experiment-lab.test.ts 'app/api/v1/ext/projects/[slug]/experiments/[experimentId]/__tests__/route.test.ts'`.
    Owners now cover non-member same-task runs, duplicate/ordinal race DB
    constraints, conclusion/abandon races, terminal budget restarts, deleted
    base reachability, human pause/running state, promotion conflict semantics,
    vanished overlays, SQLite/Brain migration harness, live-run abandon, deleted
    task/runner/config refusal, truncation/missing cost/failed run rendering,
    and external read-scope denial.

- [x] **T6.6 Auto-promotion exclusion and merge-order finalization**
  - Files: auto-promotion eligibility files (Tact 3 lands
    `web/lib/auto-promotion/*` — verify the shape it merged with), GC tests,
    this plan.
  - Work: Tact 3 (ADR-126) is implementation-complete on its branch, so the
    expected order is Tact 3 first → THIS branch owns adding the
    experiment-member exclusion term to the lanes eligibility predicate
    ("a run referenced by a non-concluded/abandoned experiment is never
    auto-promoted") + its owning test, reusing the same membership predicate
    as T3.3. If against expectation this branch lands first, leave the
    documented merge note for the Tact 3 owner and do not edit absent files.
    Renumber ADR/migration per T0.1 findings after rebasing (journal `when`
    monotonic).
  - RED/GREEN: eligibility test proves non-concluded/abandoned
    experiment-member runs are not auto-promoted.
  - Logging: auto-promotion skip logs include `runId`, `experimentId`,
    `experimentStatus`, and `skipReason`.
  - Completed evidence: `rg --files web/lib web/app | rg
    'auto[-_/]?promotion|promotion.*lane|lane.*promotion|lanes'` found no
    auto-promotion eligibility implementation in this checkout; local branch
    `claude/optimistic-leakey-8fde07` exists, so this branch records the merge
    note from ADR-124/docs and does not edit absent files. The exclusion remains
    owned by this branch after rebasing onto ADR-126/Tact 3.

- [x] **T6.7 Final validation and self-check record**
  - Files: this plan, any changed docs/tests.
  - Work: update the self-check section with implementation evidence, re-run
    validation, and record residual risks.
  - Required commands:
    - `git --no-pager diff --check main...HEAD`
    - `pnpm --filter maister-web db:check`
    - `pnpm --filter maister-web typecheck`
    - `pnpm validate:docs`
    - `pnpm --filter maister-web exec vitest list --project unit`
    - `pnpm --filter maister-web exec vitest list --project integration`
    - `pnpm --filter maister-web test:unit`
    - `pnpm --filter maister-web test:integration`
    - `pnpm --filter @maister/mcp typecheck`
    - `pnpm --filter @maister/mcp test:unit`
    - `pnpm --filter @maister/mcp test:integration`
    - `pnpm --filter maister-web test:e2e -- e2e/experiment-comparison.spec.ts`
  - Logging: no product logging; final notes must include exact commands run
    and any skipped command with reason.
  - Completed evidence (2026-07-03):
    - `git --no-pager diff --check main...HEAD` passed.
    - `pnpm validate:docs` passed:
      `validate-docs-mermaid: 9/9 mermaid block(s) passed across 8 file(s)`;
      `validate-docs-adr-anchors: 250 ADR anchor link(s) resolved across 8
      file(s)`.
    - `pnpm --filter maister-web typecheck` passed after the final relation
      lock fix.
    - `pnpm --filter @maister/mcp typecheck` passed.
    - `pnpm --filter maister-web exec vitest list --project unit` passed.
    - `pnpm --filter maister-web exec vitest list --project integration`
      passed.
    - `pnpm --filter maister-web test:unit` passed under project Node 24:
      573 files, 5850 tests. The earlier sandboxed attempt exposed two
      environment issues (`better-sqlite3` ABI under Node 26 and localhost
      listener `EPERM`); the GREEN run used the bundled Node 24 runtime and
      unsandboxed localhost access.
    - `pnpm --filter @maister/mcp test:unit` passed: 5 files, 189 tests.
    - `pnpm --filter @maister/mcp test:integration` passed with
      `--passWithNoTests` (no integration files in the MCP package).
    - `pnpm --filter maister-web test:e2e -- e2e/experiment-comparison.spec.ts`
      passed before the later non-UI relation-lock fix: setup + EN + RU flows.
    - `DB_URL=postgres://maister:maister@localhost:5432/maister_e2e pnpm --filter maister-web db:check`
      passed before the later non-DB relation-lock fix. A post-fix rerun through
      the package command was blocked by sandbox IPC (`tsx` pipe `EPERM`), and
      the equivalent Node-loader command reached the DB client but was blocked
      by sandbox localhost connect `EPERM`.
    - `pnpm --filter maister-web test:integration` first failed on a stale
      run-context prompt assertion; the test was updated to assert the current
      run-context plus Brain-memory caution text, and the focused
      `run-context.integration.test.ts` rerun passed (7 tests). The subsequent
      full integration rerun reached 278/279 files and failed only
      `relations-cycle.integration.test.ts` because `addTaskRelation` skipped
      the Postgres advisory lock when a real Postgres handle was passed without
      `DB_URL`; `web/lib/social/relations.ts` now attempts the advisory lock on
      transaction handles directly while still skipping SQLite/mocks safely.
      TypeScript passed after this fix. A final unsandboxed focused/full
      integration rerun was blocked by the environment usage limit, so this is
      the only remaining validation gap.

## Commit Plan

1. `docs(experiments): define comparison studio contracts`
   - ADR-124, system analytics, DB/API/screen docs, §2 disposition.
2. `feat(db): add experiment comparison tables`
   - Migration 0090, schema, schema integration tests.
3. `feat(runs): support pinned base commits and relaunch lineage`
   - `POST /api/runs` `baseCommit` + `relaunchOfRunId`, reachability
     validation, tests.
4. `feat(experiments): create and launch experiment variants`
   - Domain service, routes, fan-out, membership rows + inheritance, launch
     tests.
5. `feat(experiments): apply variant capability overlays`
   - Overlay validation + support matrix, resolver/materializer integration
     (slices s1→s3), tests.
6. `feat(experiments): track status snapshots and retention`
   - Status sync + on-read verification, diff snapshots + file summaries, GC
     hold/release.
7. `feat(experiments): expose comparison verdict and judge APIs`
   - Comparison DTOs, diff-of-diffs + files matrix, ext read + advisory ops,
     MCP tools, verdict/conclude/abandon, judge agent.
8. `feat(ui): add experiment comparison studio`
   - List/create flow, lab page, tabs, verdict/judge controls, nav tab, i18n.
9. `test(experiments): add end-to-end comparison coverage`
   - Stub-supervisor Playwright flow (both locales) and edge-case sweep.
10. `chore(experiments): finalize merge coordination`
    - Renumber if needed, auto-promotion exclusion (expected owner: this
      branch), final validation evidence.

## Phase Gates

Every phase exit additionally requires the FULL suite green
(`pnpm --filter maister-web test:unit && pnpm --filter maister-web
test:integration`, plus `@maister/mcp` tests for phases touching the facade);
a red test the phase touched fails the phase (explicit quarantine only, with
reason + follow-up).

- **After Phase 0:** `pnpm validate:docs` passes; ADR/migration numbers are
  confirmed against current `main`; the parity checklist has no open rows.
- **After Phase 1:** schema migration applies in real Postgres integration
  tests; `POST /api/runs` still passes existing launch tests
  (`post-branch.test.ts`, `relaunch-concurrency.integration.test.ts`, …).
- **After Phase 2:** launch fan-out creates member runs sharing the pinned
  base commit; membership inheritance covers all three sources; overlay
  materialization has no parallel writer and refuses unsupported classes.
- **After Phase 3:** experiment status and snapshots are event-driven (zero
  polling), on-read verification heals drift, and GC holds active experiment
  worktrees.
- **After Phase 4:** API DTOs are contract-compatible, external reads are
  scope-gated, both MCP tools mirror their ext operations, the advisory path
  is append-only, and the judge cannot conclude.
- **After Phase 5:** UI renders both locales without layout overflow and the
  lab compares variants end to end from recorded evidence.
- **After Phase 6:** required validation commands pass or any skip is explicit
  and justified; the traceability matrix is updated with evidence.

## Open Risks

- `experiment-judge` lives in the external `maister-plugins` checkout
  (`packages/core/maister-agents/`); its release line must coordinate with the
  pending triager rewrite (uncommitted there). Treat as a required dependency,
  not a silent omission.
- Migration/ADR numbers may still shift: Tact 3 (ADR-126, migration 0089) is
  implemented but unmerged. Re-run numbering (T0.1) before writing the
  migration; expect rebase friction on `schema.ts`, journal, `decisions.md`,
  messages, `resume-driver.ts`, and the GC guard.
- The verdict envelope has two writer families (human conclude, judge
  advisory). Mitigated by the experiment row lock + append-only advisory
  discipline + FSM guards; the two-racer tests in T3.4/T4.4 are the proof.
- The lab payload can get heavy with large snapshots × N variants. Fetch
  comparison sections lazily by tab or return capped summaries first if
  payload-size tests prove it necessary (files matrix works from summaries).
- The Experiments entry deviates from the `?tab=` project-tab pattern (nested
  routes are request-mandated); recorded in the screen doc to avoid nav-drift
  confusion.
