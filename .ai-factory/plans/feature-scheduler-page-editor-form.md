# Implementation Plan: Scheduler Cockpit and Typed Editor Forms

Branch: detached HEAD in current Codex worktree
Proposed implementation branch: feature/scheduler-page-editor-form
Created: 2026-06-20
Refined: 2026-06-20 via `$aif-improve`

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes
- SDD: yes, Phase 0 spec freeze is mandatory before implementation code
- TDD: yes, tests are written or updated before each implementation phase

## Roadmap Linkage
Milestone: "none"
Rationale: This is a UX/operability refinement over the implemented M24/M28 scheduler surfaces, not a new roadmap milestone.

## Goal
Make the scheduler understandable and safe to edit by separating the platform clock from user-facing run schedules and replacing the raw scheduler `target` JSON textarea with typed, self-explaining controls.

The current admin scheduler page exposes `scheduler_jobs.target` as arbitrary JSON. That is an internal contract. The redesigned surface must explain:
- what an engine job does;
- which jobs are system-managed singletons;
- which target fields are valid for editable job kinds;
- how user-facing `run_schedules` relate to the `run_schedule.dispatcher` engine job;
- why cron expressions belong to `run_schedules`, not `scheduler_jobs`.

## Scope
- Redesign `/admin/scheduler` as an operator cockpit with separate Engine jobs and Task schedules regions.
- Replace the admin scheduler job editor's raw target JSON field with typed controls for `command` and `flow_run`, and no-target read-only treatment for fixed dispatcher/sweep jobs.
- Keep the engine `flow_run` editor low-level: it uses a task id field, while the user-facing project `run_schedules` editor keeps friendly task selection.
- Improve the project run-schedule editor with schedule presets and better cron affordances while preserving the existing API payload.
- Add a read-only cross-project Task schedules overview on `/admin/scheduler` with project links to `/projects/{slug}?tab=schedules`.
- Add a scheduler screen reference under `docs/screens/` and update scheduler analytics/contracts before code.
- Preserve existing DB schema, scheduler tick semantics, seeded singleton constraints, and route paths.

## Non-goals
- No new scheduler clock, timer, polling loop, worker, or supervisor process.
- No DB migration unless Phase 0 uncovers a currently undocumented persisted field mismatch.
- No new env var, bound port, sidecar, package manager dependency, or deployment wiring.
- No inline table editing.
- No second route family for global schedule CRUD. Cross-project task schedules on `/admin/scheduler` are an overview with links to the existing project schedule surface.
- No raw JSON editor as the primary path. A read-only advanced target preview is allowed for diagnostics.
- No friendly project/task picker for engine `flow_run` jobs in this slice; friendly selection belongs to project `run_schedules`.

## SDD and TDD Contract
Implementation must proceed in this order:

1. Phase 0 freezes the spec and analytics. No product code changes until these docs are internally consistent and reviewed.
2. Each code phase starts by adding or updating tests that describe the desired behavior.
3. The implementation phase then makes those tests pass with minimal code.
4. Each phase exits only after its focused tests run and the relevant suite remains green or a pre-existing red lane is explicitly identified as unrelated.

Test runnability is part of acceptance:
- Component tests under `web/components/**/__tests__/**/*.test.ts` are covered by `pnpm --filter maister-web test:unit`.
- App-route/page unit tests under `web/app/**/__tests__/**/*.test.ts` are covered by `pnpm --filter maister-web test:unit`.
- Query/service unit tests under `web/lib/**/*.test.ts` are covered by `pnpm --filter maister-web test:unit`.
- Existing DB-backed scheduler tests under `web/lib/**/*.integration.test.ts` remain in `pnpm --filter maister-web test:integration`; do not add new integration tests unless behavior crosses a DB transaction boundary.

## Contract Surfaces
HTTP routes:
- `GET /api/admin/scheduler-jobs`
  - Identifiers: auth-context admin session only.
  - Change: response shape stays compatible; OpenAPI examples and target schema descriptions must become explicit.
- `POST /api/admin/scheduler-jobs`
  - Identifiers: auth-context admin session; body-controlled `id`, `jobKind`, `target`, `cadenceIntervalSeconds`, `maxFailures`, `nextRunAt`, optional `projectId`.
  - Plan rule: UI must not expose `projectId` unless Phase 0 defines a concrete project-scoped admin job use case. Body-controlled `target.taskId` for engine `flow_run` remains a task id field and must be validated server-side before launch semantics are relied on.
- `PATCH /api/admin/scheduler-jobs/{jobId}`
  - Identifiers: url-param `jobId`; auth-context admin session; body-controlled `target`, `cadenceIntervalSeconds`, `maxFailures`, `nextRunAt`, `enabled`.
  - Plan rule: editor builds the `target` object from typed fields; it never asks the operator to author raw JSON.
- `DELETE /api/admin/scheduler-jobs/{jobId}`
  - Identifiers: url-param `jobId`; auth-context admin session.
  - Plan rule: custom/admin-created jobs require delete confirmation in UI. System-managed seeded jobs must not show a delete affordance in the UI; if backend delete semantics are changed, route tests and OpenAPI must change in the same phase.
- `/api/projects/{slug}/schedules*`
  - Identifiers and route semantics stay unchanged. Project schedule editor UI may produce the same `cronExpr`, `timezone`, `overlapPolicy`, `runnerId`, and `enabled` payloads through better controls.

Queries and data:
- `scheduler_jobs.target` remains `jsonb` with per-kind validation.
- `run_schedules` remains the only persisted cron-expression table.
- Add a read-only cross-project schedule overview query, likely in `web/lib/queries/scheduler.ts` or `web/lib/run-schedules/queries.ts`, joining `run_schedules`, `projects`, `tasks`, and `runs` for admin display.
- No migration is planned. `docs/database-schema.md` and `docs/db/scheduler-domain.md` receive a no-change review during Phase 0; if docs are already accurate, do not churn them.

Docs/specs:
- `docs/system-analytics/scheduler.md`
- `docs/system-analytics/run-schedules.md`
- `docs/screens/admin-scheduler.md` (new)
- `docs/screens/README.md`
- `docs/api/web.openapi.yaml`
- `docs/database-schema.md` and `docs/db/scheduler-domain.md` review-only unless drift is found

## Resolved Phase 0 Decisions
- Engine `flow_run` jobs use an explicit task id field; no friendly task picker is required for engine jobs in this slice.
- User-facing project `run_schedules` keep friendly task selection.
- Scheduler-job delete must gain a confirmation step for deletable jobs.
- The Task schedules overview is read-only and includes project links to the owning project schedules tab.

## Acceptance Criteria
- `/admin/scheduler` clearly distinguishes Engine jobs from Task schedules.
- The table shows readable target summaries, not raw JSON blobs.
- All scheduler job-kind lists come from a shared catalog or single source of truth:
  - all DB-supported kinds: `system_sweep`, `command`, `agent_tick`, `flow_run`, `run_schedule`, `webhook_delivery`, `domain_event_dispatch`;
  - creatable custom kinds match the API schema;
  - seeded singleton kinds are visible/filterable but not creatable as duplicates.
- Creating or editing a `command` job uses typed controls:
  - HTTP ping: URL and timeout.
  - Host ping: host and timeout.
- Creating or editing a `flow_run` job uses typed controls:
  - required task id;
  - optional runner id;
  - optional base branch and target branch.
- System-managed jobs (`system_sweep`, `run_schedule`, `webhook_delivery`, `domain_event_dispatch`, `agent_tick`) cannot be created as arbitrary duplicate jobs in the UI.
- Existing singleton jobs can be paused/resumed and cadence/max-failure edited only where the backend allows it.
- Seeded singleton rows do not expose destructive delete in the UI; deletable jobs require confirmation.
- The project schedule editor offers common presets (hourly, daily, weekdays, weekly, custom cron) and still stores a 5-field `cronExpr`.
- The Task schedules overview shows schedule name, project link, task number/title, enabled state, cron/timezone, next fire, last outcome/error, and last run status/link when available.
- The UI explains overlap policy behavior without visible feature-instruction copy blocks in the main page; concise field hints in forms are allowed.
- EN and RU messages are complete for new or changed visible text.
- No new raw `target` JSON write path is introduced.
- Existing scheduler behavior remains unchanged: fixed-interval engine jobs, cron-only `run_schedules`, one seeded `run_schedule.dispatcher`, no backfill, no duplicate launch.

## Commit Plan
- Commit 1 (tasks 1-2): `docs: specify scheduler cockpit`
- Commit 2 (tasks 3-6): `test: cover scheduler catalog and editors`
- Commit 3 (tasks 7-9): `feat: align scheduler admin contracts`
- Commit 4 (tasks 10-11): `feat: redesign scheduler cockpit`
- Commit 5 (tasks 12-13): `feat: improve schedule editor`
- Commit 6 (task 14): `test: verify scheduler surfaces`

## Tasks

### Phase 0: SDD Spec Freeze

- [x] Task 1: Freeze scheduler analytics and contract specs.

  Deliverable:
  - Update `docs/system-analytics/scheduler.md` with the operator-cockpit contract: Engine jobs, system-managed singleton rules, editable/custom job kinds, per-kind target field expectations, delete affordance rules, and "no cron in scheduler_jobs".
  - Update `docs/system-analytics/run-schedules.md` with the Task schedules overview surface and schedule-preset semantics, without changing dispatch behavior.
  - Review `docs/api/web.openapi.yaml` for `/api/admin/scheduler-jobs` and replace vague `target: object` prose/examples with explicit per-kind shapes.
  - Review `docs/database-schema.md` and `docs/db/scheduler-domain.md`; edit only if they currently imply a wrong scheduler/run-schedule boundary.

  Acceptance:
  - Analytics files follow `docs/CLAUDE.md` R5 order and include implementation-status tags where a described UI piece is newly designed.
  - Every per-kind target shape is represented in prose and OpenAPI examples.
  - Specs explicitly state that raw JSON is not the primary UI.
  - Specs explicitly capture the resolved decisions: engine `flow_run` uses task id, project schedules keep friendly task selection, deletable jobs require confirmation, and Task schedules overview uses project links.
  - No ADR or migration number is allocated because no architecture or schema decision is added.

  Logging requirements:
  - No runtime logging changes.
  - Docs must name which scheduler attempt/job logs remain the operational source for execution failures.

- [x] Task 2: Add the scheduler screen reference before UI work.

  Deliverable:
  - Create `docs/screens/admin-scheduler.md` using the `docs/screens/README.md` template.
  - Update `docs/screens/README.md` index and IA map entry for `/admin/scheduler`.
  - Document JTBD, roles, navigation, layout regions, states, data/APIs, i18n namespaces, and linked artifacts.

  Acceptance:
  - The screen doc distinguishes Engine jobs from Task schedules.
  - The doc links behavior to `docs/system-analytics/scheduler.md` and `docs/system-analytics/run-schedules.md` instead of duplicating the dispatch matrix.
  - The doc states that Task schedules are read-only on `/admin/scheduler` and link to project schedule tabs.
  - `pnpm validate:docs` passes for changed docs.

  Logging requirements:
  - No runtime logging changes.
  - The screen doc must specify where operator-visible failures come from: last scheduler attempt status/error and run-schedule last fire outcome/error.

### Phase 1: TDD Harness

- [x] Task 3: Add tests for scheduler job catalog and typed target modeling before implementation.

  Deliverable:
  - Add or update unit tests around new pure catalog/model modules, likely `web/lib/scheduler/job-catalog.ts` and `web/lib/scheduler/job-targets.ts`, covering:
    - one catalog entry for every `SchedulerJobKind`;
    - filterable kinds include all DB-supported kinds, including `domain_event_dispatch`;
    - creatable kinds match `createSchedulerJobSchema` and exclude seeded-only `agent_tick`, `run_schedule`, and `domain_event_dispatch`;
    - `webhook_delivery` policy is consistent between schema, catalog, docs, and UI;
    - target summary labels for every kind;
    - command target builders for `http_ping` and `console_ping`;
    - flow-run target builder fields with required task id;
    - invalid target normalization failing loudly.

  Acceptance:
  - Tests fail before the catalog/model exists or before behavior is implemented.
  - Tests are included by `pnpm --filter maister-web test:unit`.
  - Tests protect against the current drift where the create modal offers `agent_tick` while the API rejects it.

  Logging requirements:
  - Pure catalog/target parsing/building logs nothing.
  - Server validation changes, if any, must keep existing `pino` structured fields and never log raw secret-like target values.

- [x] Task 4: Add component tests for the admin scheduler cockpit before UI implementation.

  Deliverable:
  - Update `web/components/admin/__tests__/scheduler-jobs-table.test.ts`.
  - Add tests for:
    - target summaries instead of raw JSON;
    - all filter options rendered from the shared catalog;
    - separate Engine jobs and Task schedules regions if split into separate components;
    - system-managed singleton treatment;
    - seeded singleton rows do not expose destructive delete;
    - URL-synchronized filters preserved.
  - Add page/query tests under `web/app/(app)/admin/scheduler/__tests__/` or `web/lib/queries/__tests__/` if a new cross-project schedules query is introduced.

  Acceptance:
  - Tests are included by `pnpm --filter maister-web test:unit`.
  - Existing assertions that expect the old one-table-only surface are migrated in the same task.

  Logging requirements:
  - Client table components log nothing.
  - Query tests must assert no runtime logging is introduced in read-only query helpers.

- [x] Task 5: Add component tests for typed editor forms and schedule presets before implementation.

  Deliverable:
  - Expand `web/components/admin/__tests__/scheduler-job-edit-modal.test.ts`.
  - Expand `web/components/schedules/__tests__/schedule-edit-modal.test.ts`.
  - Cover:
    - no raw target textarea in the primary admin editor path;
    - create kind options match the shared catalog and API schema;
    - `agent_tick`, `run_schedule`, and `domain_event_dispatch` are not creatable from the modal;
    - command mode switches fields correctly;
    - flow-run fields serialize task id, optional runner id, optional base branch, and optional target branch to the existing `target` payload;
    - system-managed kinds show no target fields;
    - deletable jobs use confirmation before DELETE;
    - schedule presets write the expected 5-field cron values;
    - custom cron preserves manual input.

  Acceptance:
  - Tests are red before implementation and green after the relevant implementation task.
  - Tests stay in the existing unit runner include globs.

  Logging requirements:
  - Client modal components log nothing.
  - Failed saves continue to surface typed API errors through existing alert/status regions, not console logging.

- [x] Task 6: Add API/schema validation tests before server changes.

  Deliverable:
  - Update `web/app/api/admin/scheduler-jobs/__tests__/route.test.ts`.
  - Update `web/app/api/admin/scheduler-jobs/[jobId]/__tests__/route.test.ts` if PATCH/DELETE semantics change.
  - Update `web/lib/scheduler/__tests__/job-admin.integration.test.ts` only if behavior crosses the DB/admin service boundary.
  - Cover:
    - API rejects seeded-only create kinds (`agent_tick`, `run_schedule`, `domain_event_dispatch`);
    - API accepts or rejects `webhook_delivery` according to the Phase 0 policy and docs;
    - command targets validate `commandKind`, URL/host, and positive finite timeout;
    - `flow_run` validates required task id and non-empty optional string fields;
    - delete policy is tested if backend protection is added for seeded singleton jobs.

  Acceptance:
  - Route tests are red before schema/server implementation where behavior changes.
  - API error codes remain `CONFIG`/422 for invalid body or per-kind target and `PRECONDITION`/409 for missing job.

  Logging requirements:
  - API errors continue to log unexpected crashes only.
  - Validation failures return typed JSON and should not emit noisy logs.

### Phase 2: Shared Contracts and Server Alignment

- [x] Task 7: Implement the shared scheduler job catalog and typed target model.

  Deliverable:
  - Add `web/lib/scheduler/job-catalog.ts` and `web/lib/scheduler/job-targets.ts`, or equivalent pure modules.
  - Export typed helpers for:
    - all scheduler job kinds;
    - creatable scheduler job kinds;
    - visible/filterable scheduler job kinds;
    - `isCreatableSchedulerJobKind`;
    - `isSystemManagedSchedulerJobKind`;
    - `isSeededSingletonSchedulerJob`;
    - `summarizeSchedulerTarget`;
    - `buildCommandTarget`;
    - `buildFlowRunTarget`;
    - `normalizeSchedulerTargetDraft`.
  - Reuse existing `SchedulerJobKind` types from `web/lib/db/schema.ts`.

  Acceptance:
  - No `any`; use discriminated unions for target drafts.
  - Invalid values fail fast with actionable errors.
  - Client-safe modules do not import `server-only`, `@/lib/errors`, DB clients, or server-only query helpers.
  - Current local job-kind arrays in the page, table, and modal are removed or reduced to imports from the shared catalog.

  Logging requirements:
  - Pure catalog/model modules log nothing.
  - Any caller-side error logging must use structured fields and omit raw target JSON.

- [x] Task 8: Align admin scheduler API schema and server validation with the catalog.

  Deliverable:
  - Update `web/lib/scheduler/job-admin-schema.ts` and `web/lib/scheduler/job-admin.ts`.
  - Prefer a shared client-safe zod schema module only if it can stay free of `server-only` and DB imports.
  - Validate:
    - creatable job kinds from the shared catalog;
    - command `timeoutMs` as a positive finite number when present;
    - command URL scheme at admin-save time, matching handler behavior;
    - command host safety at admin-save time when practical without duplicating incompatible handler logic;
    - `flow_run` required `taskId` and optional branch/runner fields as non-empty strings when present.
  - Update `docs/api/web.openapi.yaml` in the same task if request semantics change.

  Acceptance:
  - No route fan-out; POST/PATCH remain aggregate endpoints.
  - Existing route tests pass with updated expectations.
  - `job-admin.ts` remains the server boundary even though the UI has typed controls.
  - No handler execution semantics change.

  Logging requirements:
  - API errors continue to log unexpected crashes only.
  - Validation failures return typed JSON and should not emit noisy logs.

- [x] Task 9: Add the cross-project Task schedules overview query.

  Deliverable:
  - Add a read-only DTO/query, likely `listSchedulerRunScheduleOverviewRows`, in `web/lib/queries/scheduler.ts` or `web/lib/run-schedules/queries.ts`.
  - Include schedule id/name, project id/slug/name, task id/number/title/status, cron/timezone, enabled state, next fire, queued catch-up state, last fired at, last outcome/error, last run id/status.
  - Keep route semantics unchanged; this query feeds the server-rendered admin page only.

  Acceptance:
  - Query joins `projects`, `tasks`, and `runs` using existing Drizzle/query patterns.
  - Archived projects are excluded or clearly marked according to existing query conventions decided in Phase 0.
  - Rows include project links to `/projects/{slug}?tab=schedules`.
  - No global schedule mutation API or modal is introduced.

  Logging requirements:
  - Query helper logs nothing by default.
  - If diagnostics are added, log counts/status only, not prompts or raw target payloads.

### Phase 3: Admin Scheduler Cockpit

- [x] Task 10: Redesign `/admin/scheduler` page composition and table UI.

  Deliverable:
  - Update `web/app/(app)/admin/scheduler/page.tsx`.
  - Update or split `web/components/admin/scheduler-jobs-table.tsx`.
  - Add a Task schedules overview component if the page needs a second table.
  - Keep filters URL-synchronized.

  Acceptance:
  - Engine jobs and Task schedules are visually and semantically separate.
  - Tables are view-only; mutation stays in modals or project links.
  - The Task schedules region links to the owning project schedule tab instead of inventing global schedule CRUD.
  - The layout remains full-width and responsive with stable table widths.
  - Row actions use the existing icon/action conventions where appropriate and include accessible names.
  - `domain_event_dispatch` is filterable/visible when rows exist.

  Logging requirements:
  - Server page/query helpers may log no data by default.
  - If a new query helper logs diagnostics, use `pino` structured fields and log counts/status only, not schedule names/prompts.

- [x] Task 11: Replace the admin scheduler job editor JSON textarea with typed controls.

  Deliverable:
  - Update `web/components/admin/scheduler-job-edit-modal.tsx`.
  - Create small subcomponents only if needed to keep the modal readable.
  - Preserve the existing aggregate POST/PATCH API shape.
  - Add read-only advanced target preview if useful, collapsed by default.
  - Update `web/messages/en.json` and `web/messages/ru.json`.

  Acceptance:
  - `command` jobs are edited through command-kind segmented control/select plus URL/host/timeout fields.
  - `flow_run` jobs are edited through task id, optional runner id, optional base branch, and optional target branch fields.
  - System-managed jobs do not show target editing.
  - Create kind options come from the shared catalog and match the API schema.
  - Delete is hidden for seeded singleton rows and confirmation-guarded for deletable rows.
  - Focus trap, Esc, backdrop close, focus restore, and alert regions remain intact.

  Logging requirements:
  - Client modal logs nothing.
  - API failures are rendered through existing error state; no `console.log`.

### Phase 4: Project Schedule Editor Improvements

- [x] Task 12: Add cron presets to the project schedule editor.

  Deliverable:
  - Update `web/components/schedules/schedule-edit-modal.tsx`.
  - Add preset selection for hourly, daily, weekdays, weekly, and custom cron.
  - Keep friendly task selection for user-facing project schedules.
  - Preserve existing body shape sent to `/api/projects/{slug}/schedules`.
  - Update EN/RU messages.

  Acceptance:
  - Presets produce valid 5-field cron expressions.
  - Existing schedules whose cron does not match a preset open in custom mode.
  - Client preset helpers do not import `web/lib/run-schedules/cron.ts` because it is `server-only`.
  - Timezone, runner, overlap policy, enabled, delete, and validation behavior remain unchanged.

  Logging requirements:
  - Client modal logs nothing.
  - Existing API error rendering remains the only failure surface.

- [x] Task 13: Improve run-schedules table scanability without changing dispatch behavior.

  Deliverable:
  - Update `web/components/schedules/schedules-table.tsx` only where needed.
  - Add concise next-fire/preset/cron display if it improves comprehension.
  - Preserve trigger-now, pause/resume, and edit actions.

  Acceptance:
  - No dispatch policy wording changes unless already frozen in Phase 0 docs.
  - Last outcome and queue-one catch-up state remain visible.
  - Project links are present in the admin overview, not added to the project-local table unless already useful.
  - Mobile/desktop table text does not overlap.

  Logging requirements:
  - Client table logs nothing.

### Phase 5: Verification

- [x] Task 14: Run focused and suite-level verification.

  Deliverable:
  - Run focused tests first:
    - `pnpm --filter maister-web vitest run --project unit web/components/admin/__tests__/scheduler-job-edit-modal.test.ts web/components/admin/__tests__/scheduler-jobs-table.test.ts`
    - `pnpm --filter maister-web vitest run --project unit web/components/schedules/__tests__/schedule-edit-modal.test.ts web/components/schedules/__tests__/schedules-table.test.ts`
    - any new `web/lib/**/__tests__/*job-targets*.test.ts`, `*job-catalog*.test.ts`, query tests, or admin scheduler route tests.
  - Run broader gates:
    - `pnpm --filter maister-web test:unit`
    - `pnpm --filter maister-web test:integration` if server validation, DB queries, or API routes changed.
    - `pnpm --filter maister-web typecheck`
    - `pnpm --filter maister-web lint`
    - `pnpm validate:docs`
  - Run `web/e2e/run-schedules.spec.ts` only if project schedule behavior or route-visible labels changed enough that unit coverage is insufficient.

  Acceptance:
  - All changed test files are actually matched by the configured Vitest projects.
  - Feature-scoped tests pass.
  - Any unrelated red lane is named with exact command and failure boundary.
  - Docs validation passes for changed docs.

  Logging requirements:
  - Verification should report command outputs and failures; no runtime logging changes are introduced by this task.

## Implementation Notes
- Prefer HeroUI/Tailwind patterns already used in admin users and settings pages.
- Use icons from the existing icon library where an action needs an affordance.
- Keep forms narrow and table/list pages full-width.
- Do not introduce nested cards or marketing-style layout.
- Do not add a new dependency for cron-humanization; simple local helpers are enough unless Phase 0 proves otherwise.
- Keep all user-facing strings in both `web/messages/en.json` and `web/messages/ru.json`.
- Preserve server-only boundaries: page/query code can import DB modules; client components must not value-import server-only modules.
- Do not import `web/lib/run-schedules/cron.ts` from client preset code; it imports `server-only` and Croner.
- Prefer project links over new global schedule mutation controls in this slice.
