# Implementation Plan: Multi-run Launches, Cost/Time Accounting, and Delivery Policy UI

Branch: codex/improve-multi-run-cost-policy-plan
Created: 2026-06-11

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage

Milestone: "Custom post-M30 feature cluster: multi-run task launches, cost/time accounting, and delivery policy"
Rationale: This plan ties together the current task/run 1:N model, M18 promotion surface, M23/ADR-059 Observatory, ADR-076 model pinning, and the deferred cost/economics slice without treating any API-only change as complete.

## Source Request

Produce a full two-phase implementation plan on top of current main commit
`c104f66b` for:

- Feature A: re-run a task anytime with per-launch flow, runner/model, branch, and delivery-policy overrides.
- Feature B: run cost tokens and time accounting, including rollups and read-only Observatory dimensions.
- Feature C: declarative run delivery policy, including project defaults, launch overrides, promotion-time override, `auto_on_ready`, and a separable `ai_rebase_merge` sub-track.

Mandatory request edits applied to this plan:

- Phase A user stories: Every user story names its UI surface(s); acceptance criteria include the UI behavior, empty/disabled/error states, and i18n coverage.
- Phase B QA: Playwright e2e covers each surface in the UI matrix below; a feature task is not done until its surface test is green.

## Planning Constraints

- No feature is "API-done". Phase B treats a missing UI surface, missing EN/RU message, or missing Playwright coverage as unfinished.
- UI follows existing HeroUI v3 and project patterns: edits happen in popups or dedicated pages, data tables stay view-only, URL-synchronized state is preserved where the surface already uses it, and accessibility/focus/disabled states are explicit.
- Live values update through existing SSE, run-event, or server-refresh paths. No client polling loops and no filesystem polling.
- `web/` remains the human-facing web tier. Agent processes and ACP sessions stay owned by `supervisor/`.
- Use `MaisterError` domain errors with actionable context for known failures. UI branches on `code`, never on message matching.
- Launches continue to flow through `launchRun`; schedules and other dispatchers must not create runs through a side channel.
- Manual re-launch and scheduled dispatch may need separate classifier intents. Manual "Run again" changes must not silently change schedule overlap or terminal/crashed skip semantics.
- The plan was created from detached HEAD `c104f66b`; subsequent refinements live on the branch named above.

## UI Surface Matrix

### Feature A - Launch and Run History

- Task card and task page (`/projects/[slug]/tasks/[number]`): show a "Run again" action in launchable terminal/review states: `Done`, `Review`, `Failed`, `Abandoned`, `Crashed`. Non-launchable states show a disabled action with a tooltip/reason from the shared launchability classifier (`busy`, `blocked`, supervisor unavailable, relation blockers), never a silently hidden control.
- Launch dialog: flow selector defaulted to the task flow and listing enabled project flows; runner/model selector with ADR-076 pinned-model display; base/target branch fields; delivery-policy section; summary line showing branch name and base; every override visibly marked as deviating from the default.
- Task page run history table: one row per run with flow, runner/model, outcome, delivery status, duration, token total, and a link to run detail.
- Board card: preserve latest-run semantics and add a runs-count badge so multi-attempt tasks are recognizable in every board column where task cards appear.

### Feature B - Cost and Time

- Run detail: summary card with tokens by kind (`input`, `output`, `cache-read`, `cache-creation`) and by model, resume-tax subtotal, and active time vs wall-clock side by side.
- Run timeline: per-node-attempt duration and token columns.
- Task page: aggregate totals across all attempts of the task.
- Observatory: read-only cost dimension by project, flow, and node, consistent with ADR-059.
- Live: rollup values update through existing SSE/refresh paths only.

### Feature C - Delivery Policy

- Project settings page/surface (`/projects/[slug]?tab=settings`): delivery-policy default editor for strategy, push, trigger, and target, following the admin data-management pattern of one aggregating PATCH for project settings.
- Launch dialog: policy editor prefilled from project default, with deviations marked.
- Run detail: resolved policy snapshot is always visible. In `Review` with `trigger: auto_on_ready`, show a "will auto-deliver when ready" banner plus a cancel action that switches the run to manual.
- Promote panel: preselects the resolved policy, allows explicit override, and surfaces conflict/degradation states with failing command and paths, at parity with the current merge-conflict UX.
- `ai_rebase_merge`: progress travels through the standard run event stream; HITL requests appear in the standard inbox/needs-you surfaces like any other run.

## Contract Surface Checklist

| Surface | Spec/artifact that must change |
| --- | --- |
| Task launchability, task status reopen, run-history UI | `docs/system-analytics/tasks.md`, `docs/system-analytics/runs.md` |
| Run schedules classifier coherence | `docs/system-analytics/run-schedules.md` |
| Delivery policy, promotion, rebase strategies | `docs/system-analytics/runs.md`, `docs/system-analytics/workspaces.md`, `docs/system-analytics/readiness.md` if readiness gates change |
| Cost/time attribution and rollups | `docs/system-analytics/runs.md`, `docs/system-analytics/observatory.md` |
| HTTP routes and bodies | `docs/api/web.openapi.yaml` |
| External token launch compatibility | `docs/api/external/operations.openapi.yaml`, `docs/api/web.openapi.yaml` if the route is mirrored there |
| Supervisor session/prompt attribution | `docs/api/supervisor.openapi.yaml`, `docs/api/async/supervisor-sse.asyncapi.yaml` if event payloads change |
| Browser-facing SSE event changes | `docs/api/async/web-runs.asyncapi.yaml` |
| DB schema and migrations | `docs/database-schema.md`, `docs/db/erd.md`, `docs/db/runs-domain.md`, `docs/db/projects-domain.md` if `projects` changes |
| ADRs | `docs/decisions.md` after auditing ADR-018, ADR-058, ADR-059, ADR-071, ADR-076, ADR-084 |
| UI copy | `web/messages/en.json`, `web/messages/ru.json` |
| Playwright coverage | `web/playwright.config.ts` `AUTHED_SPEC` and feature specs under `web/e2e/` |

No new env vars, ports, sidecars, or host-mounted files are expected. If Phase A or implementation introduces any, Task 17 becomes mandatory deployment wiring touching `.env.example`, `compose.yml`, `compose.production.yml`, and `docs/configuration.md`.

## Trust Boundary Notes

- `POST /api/runs`: `taskId`, optional `flowId`, `runnerId`, branches, and `deliveryPolicy` are body-controlled. `projectId`, enabled project flows, branch allow-lists, runner readiness, and defaults are server-state. The handler must derive project from task and compare every body-controlled cross-resource id against server-state.
- `POST /api/v1/ext/runs`: token-scoped launch route must explicitly freeze compatibility. Phase A must decide whether it accepts the same overrides as `POST /api/runs` or remains v1-compatible with `taskId`, `runnerId`, `baseBranch`, and `targetBranch` only. In either case, token project scope and audit behavior remain server-state.
- `GET /api/runs/launch-options`: `taskId` is query-controlled. The response derives project, flow list, branch list, default runner/model, and default delivery policy from server-state after auth.
- Aggregating project settings PATCH: `slug` is URL-param; body may include delivery-policy fields alongside other project settings. Project id is server-state and authz is `editSettings`; one invalid sub-section must not partially apply another.
- `POST /api/runs/[runId]/promote`: `runId` is URL-param; target/policy override/reviewed target commit are body-controlled. Workspace, parent repo, run branch, current policy snapshot, and project id are server-state.
- Run policy cancel/switch-to-manual route: `runId` is URL-param; no body-controlled project/workspace ids. It must CAS on `status = Review` and current policy trigger before mutating.
- Supervisor session and prompt attribution: web-controlled `stepId`/`nodeAttemptId` context must be validated as safe ids before it can be written to cost records. Cost attribution context is metadata only; it must never grant project, filesystem, or session authority.

## Commit Plan

- Commit 1 (Tasks 1-6): `docs: specify multi-run cost and delivery policy`
- Commit 2 (Tasks 7-10): `feat(runs): add multi-run launch surfaces`
- Commit 3 (Tasks 11-12): `feat(runs): add cost and time rollups`
- Commit 4 (Tasks 13-15): `feat(delivery): add run delivery policies`
- Commit 5 (Tasks 16-18): `test: cover run policy and cost surfaces`

## Tasks

### Phase A: Documentation and Spec Freeze

- [x] Task 1: Audit current contracts, number space, and UI inventory.
  Deliverable: freeze current state before writing the feature spec. Verify next-free ADR number after ADR-084 and next-free migration after the live `web/lib/db/migrations` journal (0044 already exists on this base). Inventory current UI files: task card, task page, launch popover, run detail layout, review panel, project settings panel, Observatory. Also inventory shared routes/services that this feature will touch: internal launch route, external token launch route, launch-options route, scheduler dispatch, supervisor cost/session schemas, project settings routes, and scratch/flow promote compatibility.
  Files: `docs/decisions.md`, `web/lib/db/migrations/meta/_journal.json`, `web/components/board/launch-popover.tsx`, `web/app/(app)/projects/[slug]/tasks/[number]/page.tsx`, `web/app/(app)/runs/[runId]/layout.tsx`, `web/components/runs/review-panel.tsx`, `web/components/board/panels/settings-panel.tsx`, `web/app/api/runs/route.ts`, `web/app/api/v1/ext/runs/route.ts`, `web/app/api/runs/launch-options/route.ts`, `web/lib/run-schedules/dispatch.ts`, `supervisor/src/types.ts`, `supervisor/src/cost.ts`, `web/lib/runs/promote.ts`.
  Logging requirements: no production logging; document any discovered stale numbering or surface mismatch in the Phase A docs with concrete file paths.
  Verification: `git --no-pager diff --check`; record the verified ADR and migration next-free values in the docs before implementation starts.

- [x] Task 2: Specify Feature A analytics, user stories, and launchability v2.
  Deliverable: docs-first contract for re-running tasks. Define manual launchability v2 as a positive allow-list for `Done`, `Review`, `Failed`, `Abandoned`, and `Crashed`; keep actively executing states `Pending`, `Running`, `NeedsInput`, `NeedsInputIdle`, and relation-blocked states non-launchable with visible disabled reasons. Decide explicitly whether `HumanWorking` remains busy in v1. Define `Done/Abandoned -> InFlight` reopen semantics and preserve previous runs/worktrees/promotability. Freeze schedule launchability separately so scheduler behavior does not accidentally start terminal/review/crashed tasks unless the docs explicitly opt into that.
  UI acceptance: task card/page "Run again", disabled reason tooltip, launch dialog defaults/override badges, task run-history table columns, board runs-count badge, empty/error states, EN/RU strings.
  Files: `docs/system-analytics/tasks.md`, `docs/system-analytics/runs.md`, `docs/system-analytics/run-schedules.md`.
  Logging requirements: specify WARN logs for refused launches with `taskId`, classifier result, blockers, and no server-only path leakage; specify DEBUG logs for accepted launch defaults and override resolution.
  Verification: `pnpm validate:docs`; every user story names UI surface(s) and acceptance includes UI behavior, empty/disabled/error states, and i18n coverage.

- [x] Task 3: Specify Feature B cost/time analytics and storage decision.
  Deliverable: docs-first contract for token attribution, rollups, active/wall time, resume-tax, and Observatory cost dimensions. Prefer exact node-attempt stamping for cost records over timestamp-range attribution; for shared `slash-in-existing` sessions, define prompt-time active attribution context instead of only session-start context. If Phase A proves a case impossible, document the exact limitation and refusal behavior before code. Persist token/cost rollups only where needed; derive duration from existing `runs.started_at`/`ended_at` and `node_attempts.started_at`/`ended_at` unless Phase A documents a concrete reason for redundant duration columns.
  UI acceptance: run detail summary card, run timeline token/duration columns, task aggregate totals, Observatory project/flow/node cost dimension, live update via SSE/refresh only.
  Files: `docs/system-analytics/runs.md`, `docs/system-analytics/observatory.md`, `docs/database-schema.md`, `docs/db/runs-domain.md`, `docs/db/erd.md`.
  Logging requirements: specify structured logs for cost-event ingestion and rollup recompute with `runId`, `nodeAttemptId`, `sessionId`, `model`, token-kind totals, and source offset or event id; no raw prompts, env values, or cost payloads in logs.
  Verification: `pnpm validate:docs`; docs state JSONL remains source of truth and DB rollups are derived/reconcilable.

- [x] Task 4: Specify Feature C delivery policy analytics and state transitions.
  Deliverable: docs-first contract for `delivery_policy` resolution: project default -> launch override -> promote override; snapshot on run; compatibility mapping from `local_merge` and `pull_request`; `auto_on_ready` after readiness only; manual degradation on failures. Define `merge`, `rebase_merge`, `pull_request`, and separable `ai_rebase_merge`. Freeze whether scratch runs keep legacy promote behavior or opt into policy snapshots; if they stay legacy, add explicit regression requirements. For `ai_rebase_merge`, decide whether conflict/HITL uses existing `merge_conflict` assignments or a new action kind before schema work starts.
  UI acceptance: project settings default editor, launch dialog policy editor, run detail policy snapshot/banner/cancel, promote panel preselection/override/conflict states, standard inbox/HITL surfacing for `ai_rebase_merge`.
  Files: `docs/system-analytics/runs.md`, `docs/system-analytics/workspaces.md`, `docs/system-analytics/hitl.md`, `docs/system-analytics/readiness.md` if needed.
  Logging requirements: specify INFO logs for resolved policy snapshot and auto-delivery trigger, WARN for degraded-to-manual states with command/path/status, ERROR only for unrecoverable side-effect failures with attempt id.
  Verification: `pnpm validate:docs`; state diagrams include every auto/manual/degraded transition and crash window.

- [x] Task 5: Freeze API, AsyncAPI, DB docs, and ADR decisions.
  Deliverable: update OpenAPI for `POST /api/runs` flow override and delivery policy, `GET /api/runs/launch-options`, one aggregating project settings PATCH, promote route policy override, and any cancel/switch-to-manual route. Freeze and document `POST /api/v1/ext/runs` compatibility or parity with the internal route. Update supervisor OpenAPI if session/create or prompt/send bodies carry attribution context. Update AsyncAPI only if a new explicit browser-facing or supervisor event kind is required; otherwise document the existing `session.update`/run refresh path. Add or amend ADRs after auditing existing ADRs.
  Files: `docs/api/web.openapi.yaml`, `docs/api/external/operations.openapi.yaml`, `docs/api/supervisor.openapi.yaml`, `docs/api/async/web-runs.asyncapi.yaml`, `docs/api/async/supervisor-sse.asyncapi.yaml`, `docs/database-schema.md`, `docs/db/erd.md`, `docs/db/runs-domain.md`, `docs/db/projects-domain.md`, `docs/decisions.md`.
  Logging requirements: API docs must define structured error payload context for `PRECONDITION`, `CONFLICT`, and `EXECUTOR_UNAVAILABLE` without exposing raw filesystem paths except operator-actionable conflict paths already shown by current merge UX.
  Verification: `pnpm validate:docs`; OpenAPI/AsyncAPI lint during implementation with `npx @redocly/cli lint docs/api/web.openapi.yaml` and `npx @asyncapi/cli validate docs/api/async/web-runs.asyncapi.yaml`.

- [x] Task 6: Freeze Phase B QA matrix and done gates.
  Deliverable: write the acceptance-to-test matrix in Phase A docs. Each feature must map to integration tests and Playwright surfaces before implementation begins. Define a dedicated e2e fixture for this feature cluster instead of mutating shared M18/M23 fixtures in-place, unless Phase A proves reuse is safe. Include exact new spec filenames and the exact `AUTHED_SPEC` regex update if those filenames are not already matched.
  Files: `docs/system-analytics/tasks.md`, `docs/system-analytics/runs.md`, `docs/system-analytics/observatory.md`, `web/playwright.config.ts` (planned change only in Phase A).
  Logging requirements: no app logs; QA docs must name observable error text/code states for each failing test.
  Verification: `pnpm validate:docs`; Phase A does not exit until every UI surface in this plan has an owner and an e2e spec name.

### Phase B: TDD Implementation

- [ ] Task 7: QA writes RED tests first from the Phase A matrix.
  Deliverable: failing tests before implementation for manual launchability v2, schedule launchability preservation, flow override validation, external token route compatibility, launch-options DTO, delivery-policy schema/resolution, promote policy transitions, scratch promote regression, cost attribution/rollups, task aggregates, and UI surfaces. Prefer integration/e2e; use unit tests only for pure classifiers/rollups.
  Files: `web/lib/runs/__tests__/launchability.test.ts`, `web/lib/run-schedules/__tests__/*`, `web/app/api/runs/__tests__/*`, `web/app/api/v1/ext/runs/__tests__/*`, `web/app/api/runs/launch-options/__tests__/route.test.ts`, `web/lib/runs/__tests__/promote-service.test.ts`, `web/lib/queries/__tests__/*`, `supervisor/src/__tests__/cost.test.ts`, `web/e2e/_seed/fixtures.ts`, `web/e2e/_seed/seed-e2e.ts`, `web/e2e/*.spec.ts`, `web/playwright.config.ts`.
  Logging requirements: test fixtures should assert structured logs only where behavior depends on refusal/degradation observability; avoid brittle message-only assertions.
  Verification: run focused failing commands and prove they are picked up by the runner: `pnpm --filter maister-web exec vitest list --project unit`, `pnpm --filter maister-web exec vitest list --project integration`, and targeted `pnpm --filter maister-web test:e2e -- --project=authed <new-specs>`.

- [ ] Task 8: Implement DB schema and migration for policy snapshots and cost/time rollups.
  Deliverable: add the Phase A-selected storage with strict types. Expected shape: project delivery-policy default; run-level resolved policy snapshot; workspace/promotion compatibility fields or migration path; cost/token derived rollup storage for run and node-attempt scopes; indexes needed for task/run/Observatory reads. Preserve existing `promotionMode` compatibility during migration. Do not add redundant duration columns unless Task 3 explicitly justifies them.
  Files: `web/lib/db/schema.ts`, `web/lib/db/migrations/<next>_*.sql`, `web/lib/db/migrations/meta/_journal.json`, `web/lib/db/__tests__/schema.integration.test.ts`, migration-specific integration tests.
  Logging requirements: migration code/scripts should not log secrets or raw JSON payloads; runtime migration readers log structured warnings only for legacy rows that need compat fallback.
  Verification: `pnpm --filter maister-web test:integration -- web/lib/db`, `pnpm --filter maister-web typecheck`, docs DB artifacts from Task 5 updated in same commit.

- [ ] Task 9: Implement launchability v2, launch service overrides, and launch-options API.
  Deliverable: update launchability with explicit manual and schedule intents, or a wrapper that preserves equivalent separation. `launchRun` accepts flow override and delivery policy for the surfaces frozen in Phase A, derives the project from task, validates chosen flow is enabled for the same project, recomputes runner/remaps for the chosen flow, snapshots the selected flow revision/runner/model/policy/base/target on the run, branches from chosen base, and reopens terminal tasks to `InFlight`. Schedules keep conservative outcomes unless Phase A explicitly changes them. The task launch dialog must consume enriched `/api/runs/launch-options`; do not keep task branch/default loading coupled to `/api/scratch-runs/launch-options`.
  Files: `web/lib/runs/launchability.ts`, `web/lib/services/runs.ts`, `web/app/api/runs/route.ts`, `web/app/api/v1/ext/runs/route.ts`, `web/app/api/runs/launch-options/route.ts`, `web/lib/run-schedules/dispatch.ts`, related tests.
  Logging requirements: DEBUG accepted launch resolution with task/run/flow/runner/policy/base/target; WARN refused launch with classifier and blocker refs; include request ids/status codes on supervisor readiness failures.
  Verification: focused unit/integration tests for classifier, route trust boundary, launch branch/base behavior, schedule decision coherence, and no-side-effects refusals.

- [ ] Task 10: Build Feature A UI surfaces.
  Deliverable: replace/extend the current launch popover into a HeroUI-compatible launch dialog with flow, runner/model, branch, delivery-policy, and summary sections. The dialog loads task launch data from `/api/runs/launch-options`, including enabled project flows, branches, runner/model defaults, ADR-076 model pinning display, default policy, and override markers. Add task page "Run again" and disabled-state reason surface. Extend task run history columns. Add board runs-count badge while preserving latest-run column placement.
  Files: `web/components/board/launch-popover.tsx` or new dialog component, `web/components/board/task-card.tsx`, `web/components/board/flight-card.tsx`, `web/lib/queries/board.ts`, `web/lib/queries/task-detail.ts`, `web/app/(app)/projects/[slug]/tasks/[number]/page.tsx`, `web/messages/en.json`, `web/messages/ru.json`.
  Logging requirements: client UI does not log; server queries/routes log only structured refusal/launch events from Task 9.
  Verification: component tests where useful plus Playwright e2e for launch dialog defaults/overrides, disabled reasons, task-page run history, and board runs-count badge. New specs must match `AUTHED_SPEC`.

- [ ] Task 11: Implement cost attribution, projection, and live rollup refresh.
  Deliverable: stamp cost records with enough context to attribute tokens to node attempts, including shared `slash-in-existing` sessions. The supervisor/web boundary must carry node-attempt context at session creation and at prompt send time, update the active attribution context for reused sessions, append enriched `cost.jsonl`, and update derived rollups through run events or server-side recompute-on-read paths. If concurrent prompts in one session would make attribution ambiguous, fail fast or serialize before accepting the prompt. No UI polls files.
  Files: `supervisor/src/cost.ts`, `supervisor/src/types.ts`, `supervisor/src/http-api.ts`, `docs/api/supervisor.openapi.yaml`, `docs/api/async/supervisor-sse.asyncapi.yaml` if event payloads change, `web/lib/supervisor-client.ts`, `web/lib/flows/runner-agent.ts`, `web/lib/flows/runner-graph.ts`, new `web/lib/runs/cost-rollups.ts` or equivalent, tests.
  Logging requirements: DEBUG per cost record append with `sessionId`, `runId`, `nodeAttemptId`, model, and token counts; WARN malformed unattributable records with bounded context; never log raw adapter lines, prompts, or secrets.
  Verification: supervisor unit tests for cost extraction/stamping, web integration tests for rollup persistence/reconciliation, resume-tax attribution, shared-session node attribution, and SSE/refresh update path.

- [ ] Task 12: Build Feature B run/task/Observatory UI.
  Deliverable: run detail summary card, timeline duration/token columns, task aggregate totals across attempts, and read-only Observatory cost rollups by project/flow/node. Ensure active vs wall-clock labels are explicit and live/volatile values are marked when runs are open.
  Files: `web/app/(app)/runs/[runId]/layout.tsx`, `web/components/board/run-timeline.tsx`, `web/lib/queries/run.ts`, `web/lib/queries/task-detail.ts`, `web/app/(app)/projects/[slug]/tasks/[number]/page.tsx`, `web/lib/queries/observatory.ts`, `web/lib/queries/observatory-core.ts`, `web/components/observatory/*`, `web/messages/en.json`, `web/messages/ru.json`.
  Logging requirements: query helpers may log DEBUG aggregate counts (`runCount`, `nodeAttemptCount`, `costRollupCount`) but not raw cost payloads.
  Verification: focused query tests plus Playwright e2e for run detail summary/timeline, task aggregate totals, and Observatory cost dimension.

- [ ] Task 13: Implement delivery-policy schema, project default route, launch snapshot, and manual cancel.
  Deliverable: typed `DeliveryPolicy` schema (`strategy`, `push`, `trigger`, `targetBranch`) with validation and compatibility mapping. Add project default read model and one aggregating project settings PATCH route, snapshot resolved policy on run launch, expose run snapshot to detail queries, and add a cancel/switch-to-manual action for `auto_on_ready`. Existing one-off runner/remap settings routes may remain compatibility wrappers, but the new delivery-policy editor writes through the aggregate route.
  Files: `web/lib/runs/delivery-policy.ts`, `web/lib/db/schema.ts`, `web/app/api/projects/[slug]/settings/route.ts`, existing project settings routes if compatibility wrappers change, `web/app/api/runs/[runId]/delivery-policy/route.ts`, `web/lib/services/runs.ts`, `web/lib/queries/project.ts`, `web/lib/queries/run.ts`, tests.
  Logging requirements: INFO policy default updates and run snapshot resolution with `projectId`, `runId`, and non-secret policy fields; WARN cancel conflicts with observed status/policy trigger.
  Verification: integration tests for SET/CLEAR/re-set project default symmetry, launch snapshot immutability, body identifier trust boundary, and manual cancel CAS.

- [ ] Task 14: Implement delivery-policy UI and non-AI promote strategies.
  Deliverable: project settings editor, launch dialog policy editor, run detail policy snapshot/banner, and promote panel policy preselection/override. Extend promote service for `merge` with optional push, `pull_request`, and `rebase_merge`, preserving readiness re-gate, target-drift token, durable attempt claim, conflict/degradation UX with failing command and paths, and assignment creation. Preserve scratch run promotion semantics unless Task 4 explicitly opts scratch into policy. New UI states branch on typed error codes/status fields, not new message-string matching.
  Files: `web/components/board/panels/settings-panel.tsx`, new delivery-policy editor component, launch dialog component, `web/components/runs/review-panel.tsx`, `web/lib/runs/promote.ts`, `web/app/api/runs/[runId]/promote/route.ts`, `web/lib/worktree.ts`, `web/messages/en.json`, `web/messages/ru.json`, tests.
  Logging requirements: DEBUG policy preselection/override; INFO successful strategy execution and optional push; WARN conflicts, target drift, push rejection, and degraded-to-manual with command/path context.
  Verification: real temp git repo integration tests for merge, merge+push, pull_request compatibility, rebase_merge clean path, rebase conflict abort/restore, target drift, and UI e2e for promote panel states.

- [ ] Task 15: Implement the separable `ai_rebase_merge` sub-track.
  Deliverable: when a rebase conflict occurs under `ai_rebase_merge`, spawn conflict-resolution work on the existing run substrate and worktree, record attempt/audit data per Phase A, stream progress through the standard run event stream, surface permission/HITL requests through normal inbox/needs-you views using the assignment kind frozen in Task 4, restore pre-rebase state on abort, and re-enter the same readiness gate before merge completion. This task must not block shipping `merge`, `rebase_merge`, `pull_request`, push, or manual/auto trigger basics.
  Files: `web/lib/runs/promote.ts`, new `web/lib/runs/ai-rebase-merge.ts` if needed, `web/lib/flows/runner-agent.ts`, `web/lib/queries/run.ts`, `web/lib/assignments/service.ts`, `web/components/board/hitl-inbox.tsx`, `web/components/board/flight-card.tsx`, tests.
  Logging requirements: INFO ai-rebase session start/finish with run/attempt ids; DEBUG readiness re-entry; WARN conflict unresolved, permission denied, abort, or restore failure with command/path context.
  Verification: integration tests with temp repos for conflict -> agent/HITL -> ready -> merge, abort restore, and degradation to manual; Playwright e2e proves standard inbox and run event progress surfaces.

- [ ] Task 16: Complete i18n, accessibility, and URL-state polish for all surfaces.
  Deliverable: every new string in EN/RU, dialog focus trap/restoration, labels for selectors/buttons/tooltips, disabled actions with visible reason and title/aria text, no text overflow on mobile/desktop, no layout shifts in fixed-format table/card controls. Preserve URL-state patterns for project tabs/Observatory filters.
  Files: `web/messages/en.json`, `web/messages/ru.json`, affected components, `web/app/(app)/observatory/page.tsx`, `web/lib/observatory/filters.ts` if filters change.
  Logging requirements: none in client components.
  Verification: `pnpm --filter maister-web test:unit -- web/lib/__tests__/i18n-settings-keys.test.ts` or equivalent i18n key check, plus Playwright screenshots/assertions for dialog focus, disabled controls, and Observatory filters.

- [ ] Task 17: Deployment wiring and configuration audit.
  Deliverable: confirm the feature adds no required env vars, sidecars, ports, or host mounts. If that changes, wire `.env.example`, `compose.yml`, `compose.production.yml`, `Dockerfile` if needed, and `docs/configuration.md` in the same task. Document any intentional dev/prod gap explicitly.
  Files: `.env.example`, `compose.yml`, `compose.production.yml`, `Dockerfile`, `docs/configuration.md` only if needed.
  Logging requirements: if new operational knobs exist, specify INFO startup logs naming knob values without secrets; otherwise no runtime logging change.
  Verification: `git --no-pager diff --check`; if deployment files change, run targeted config/docs validation and ensure no secret values are committed.

- [ ] Task 18: Final verification and reviewer loop.
  Deliverable: orchestrator runs the full verification gate, reviewer checks Phase A contract parity, and implementer fixes all findings before completion. A feature is not done until docs, schema, API, UI, i18n, and surface tests are all green.
  Files: all changed files.
  Logging requirements: review every new log line for structured fields, no raw secrets, no prompt/cost payload leakage, and actionable context.
  Verification: `pnpm --filter maister-web typecheck`; `pnpm --filter maister-web exec eslint .`; `pnpm --filter maister-web test:unit`; `pnpm --filter maister-web test:integration`; focused external token launch route tests if that route is touched; `pnpm --filter @maister/supervisor test:unit`; `pnpm --filter @maister/supervisor test:integration`; scoped Playwright e2e for all UI matrix surfaces; `pnpm validate:docs`; `npx @redocly/cli lint docs/api/web.openapi.yaml`; `npx @redocly/cli lint docs/api/external/operations.openapi.yaml`; `npx @redocly/cli lint docs/api/supervisor.openapi.yaml` if supervisor bodies changed; `npx @asyncapi/cli validate docs/api/async/web-runs.asyncapi.yaml`; `npx @asyncapi/cli validate docs/api/async/supervisor-sse.asyncapi.yaml` if supervisor events changed; `git --no-pager diff --check`.

## Phase Exit Gates

Phase A is complete only when the analytics/docs are internally consistent and every acceptance criterion names its UI surface, disabled/error/empty states, i18n coverage, API/spec surface, DB surface, and test owner.

Phase B is complete only when:

- every Phase A behavior exists in code and UI;
- every UI surface in the matrix has green Playwright coverage;
- task/run launch paths still use `launchRun`;
- internal and external launch-route contracts have an explicit parity or compatibility decision;
- promotion paths preserve readiness re-gate and current conflict parity;
- scratch promotion behavior is either explicitly unchanged and regression-tested or intentionally migrated;
- cost rollups are derived and reconcilable with `cost.jsonl`;
- supervisor cost attribution is exact for node attempts or fails fast where Phase A declares it cannot be exact;
- no new client polling loop was introduced;
- no new env/config/deployment surface was left undocumented.
