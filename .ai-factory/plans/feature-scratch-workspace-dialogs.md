# Implementation Plan: Scratch Workspace Dialogs SDD

Branch: feature/scratch-workspace-dialogs
Plan file: .ai-factory/plans/feature-scratch-workspace-dialogs.md
Created: 2026-06-01

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage

Milestone: "Scratch run UX + M12-aligned artifact intake"
Rationale: This extends the implemented scratch-run slice and prepares uploaded scratch context to become typed artifacts later without waiting for full M12.

## SDD Contract

This is a specification-driven implementation. Phase 0 is a hard gate: no code changes until the specs, analytics, DB docs, API contracts, and acceptance criteria describe the exact contract to implement.

Current baseline:

- Scratch runs are implemented as `runs.run_kind = "scratch"` plus `scratch_runs`, `scratch_messages`, `scratch_attachments`, and `scratch_capability_profiles`.
- `scratch_attachments.kind` is currently `issue_url | file_path | text_note`; binary upload storage is documented as Phase 2.
- Scratch launch uses JSON bodies only and requires `branchName`; the UI currently shows a full-page form.
- Active workspace rail data is flat and maps statuses to coarse `running | needs | queued | done`.
- Scratch ownership is simple: project viewers can read; project members can operate. Keep that model in this feature.

Target contract:

- Active workspaces are grouped by project in the left rail. Each project group shows active count and a compact `+` launch action.
- Scratch launch is a compact command-box dialog/page surface with top name/branch fields, large prompt, bottom machine/project/base-branch row, and compact menus for runner/executor, files, work mode, reasoning effort, platform MCPs, and platform/project/Flow-package capability packs.
- Scratch runner selection is the configured project executor list: each `executors` row is an ACP runner profile. Multiple rows may use the same ACP adapter agent with different `executorRefId`, `model`, `router`, or `env` settings, for example several Claude Code profiles routed through CCR. The UI/API must select an executor profile, not an agent family.
- `branchName` becomes optional; an explicit value is used as-is, and an empty value uses the existing generated scratch branch fallback.
- Work mode is explicit: `auto | plan_first | manual_approval`. `plan_first` maps to the existing `plan_mode = "plan-first"` behavior; other modes persist as policy metadata until runtime enforcement lands.
- `manual_approval` is prompt/policy-only in this feature: the agent is instructed to ask before edits, but no new ACP permission gate is enforced until a later operator-claim/readiness milestone.
- Reasoning effort is explicit: `low | high | extra | ultra`. Persist it as scratch-run metadata and include it in the agent prompt/capability instructions; model-specific adapter enforcement is deferred to M11c/M14.
- Platform MCPs and Flow-shipped skills/agent packs are selectable at scratch launch through the existing capability catalog. V1 persists and materializes the resolved profile; adapter-native tool sandboxing and typed tool restrictions remain future work unless a selected capability is already supported by the current resolver/materializer.
- Native runner provisioning is not part of this feature unless explicitly expanded. Current capability materialization is a profile/instructions handoff (`profile.json`, `instructions.md`, `adapterLaunch.env`). A future provisioning milestone must turn selected MCPs, settings, skills, agents, and restrictions into adapter-native files such as merged `.mcp.json`, `settings.local.json`, worktree skill/agent pack materialization, and tool policy files.
- Real uploaded files are accepted on scratch launch and scratch messages, stored under the run artifact tree, and referenced in messages without dirtying the git worktree.
- Uploaded-file `storage_path` is server-internal. Browser/API responses expose safe display metadata plus a rootless artifact reference; prompts delivered to the local agent may include the server-local path because the agent runs on the same host.
- Flow and scratch workspace rows expose a launched-by user for the rail and workspace cards. New Flow and scratch runs set `runs.created_by_user_id`; legacy rows may be null.

## Contract Surfaces

- DB schema: `web/lib/db/schema.ts`, a new migration after `0012`, `docs/database-schema.md`, `docs/db/runs-domain.md`, and `docs/db/erd.md`.
- Web API: `docs/api/web.openapi.yaml` for `GET /api/scratch-runs/launch-options`, `POST /api/scratch-runs`, `GET /api/scratch-runs/{runId}`, and `POST /api/scratch-runs/{runId}/messages`.
- Async/SSE: no new SSE event type expected. `docs/api/async/web-runs.asyncapi.yaml` must state the scratch dialog still refreshes via existing run stream plus `GET /api/scratch-runs/{runId}`.
- Domain analytics: `docs/system-analytics/scratch-runs.md` and `docs/system-analytics/workspaces.md`.
- Product/docs: `docs/VISION.md`, `.ai-factory/DESCRIPTION.md`, `docs/PRODUCT_VIEW.md` only if wording would otherwise become stale.
- Error taxonomy: `docs/error-taxonomy.md` only if upload validation or multipart parsing needs a new or clarified `CONFIG | PRECONDITION | CONFLICT | EXECUTOR_UNAVAILABLE` row. Prefer existing codes.
- Deployment touchpoints: no new port, sidecar, host mount, or env var is planned. Uploaded files use the existing runtime artifact tree under `MAISTER_RUNTIME_ROOT ?? process.cwd()`. Upload limits are fixed constants for v1: 10 files per request, 25 MiB per file, 100 MiB total parsed multipart payload.

## Designed Follow-Up: Native Runner Provisioning

This plan keeps scratch-run capability selection compatible with the current implementation, but must leave a clear handoff for the next milestone:

- Provision selected platform MCPs and project/Flow-package MCPs into an adapter-native run config, likely a merged per-run `.mcp.json` or adapter-specific MCP config generated under the run artifact/worktree support area.
- Provision selected skills and agent definitions from the repo plus installed Flow packages into the worktree or adapter-visible search path, preserving source/version metadata and avoiding mutation of the parent repo.
- Provision adapter settings such as Claude Code `settings.local.json` or Codex-equivalent settings from selected `setting` / `env_profile` capability records.
- Provision selected restrictions/tool policies as enforceable adapter config where the adapter supports it; otherwise keep the current fail-closed behavior for enforced unsupported restrictions and downgrade optional unsupported restrictions with explicit notes.
- Reuse the same resolved capability profile identity for scratch runs and Flow node sessions so future native provisioning stays auditable against the already-persisted `scratch_capability_profiles` row.
- Keep the supervisor out of trust decisions: web resolves and materializes the profile/provisioning files, then passes paths/env to the ACP session.

## Identifier Trust Boundaries

- `POST /api/scratch-runs`
  - `auth-context`: current user id.
  - `body-controlled`: `projectId`, `baseBranch`, optional `branchName`, `executorId`, optional `linkedTaskId`, `linkedIssueUrl`, selected platform/project/Flow-package capability ids, work mode, reasoning effort, metadata attachments, uploaded file names.
  - `server-state`: project row, configured executor row, visible capabilities, worktree root, run id, project slug, worktree path, supervisor session ids.
  - Rule: never accept body-provided `runId`, `projectSlug`, `worktreePath`, `stepId`, session ids, or storage paths.
- `POST /api/scratch-runs/{runId}/messages`
  - `url-param`: `runId`.
  - `auth-context`: current user id.
  - `server-state`: run/project/workspace/scratch rows, supervisor session id, parent repo path, worktree path, next message sequence.
  - `body-controlled`: message content, metadata attachments, uploaded file names.
  - Rule: all file storage paths derive from server-state run/project/message ids; client filenames are sanitized display metadata only.
- `GET /api/scratch-runs/launch-options`
  - `auth-context`: current user id.
  - `query-controlled`: optional `projectId`.
  - `server-state`: visible project set, branch list, configured executor list, project default executor, machine label, work-mode options, reasoning-effort options, capability catalog grouped by source/kind.
  - Rule: invisible `projectId` returns typed `PRECONDITION`; no filesystem path is accepted from the query.

## Commit Plan

- **Commit 1** (Phase 0): `docs: specify scratch workspace dialogs`
- **Commit 2** (Phases 1-2): `feat: extend scratch run contracts`
- **Commit 3** (Phases 3-4): `feat: add scratch uploads and grouped rail`
- **Commit 4** (Phases 5-6): `test: cover scratch dialogs and uploads`

## Tasks

### Phase 0: Spec Freeze And Acceptance Criteria

- [x] Task 1: Rewrite the scratch-run analytics contract before code.

  Deliverable: update `docs/system-analytics/scratch-runs.md` so it is the implementation source of truth for command-box launch, optional branch fallback, work modes, reasoning effort, real uploaded files, active workspace grouping, and simple collaboration semantics.

  Requirements:
  - Mark every piece as `Implemented`, `Designed`, or `Phase 2` according to the state expected at the end of this plan.
  - Add explicit Expectations and Acceptance Criteria sections for launch UX, runner selection, dialog messages, attachments, uploaded-file storage, capability/profile selection, and active workspace visibility.
  - Add a refusal/precondition table covering invisible project, missing executor, empty prompt, malformed JSON/multipart, invalid branch, branch exists, capacity full, too many files, oversized file, oversized total multipart payload, disallowed filename/path, second prompt while running, and supervisor unavailable.
  - Specify upload storage as run artifacts, not worktree files: `.maister/<projectSlug>/runs/<runId>/uploads/<messageId-or-launch>/<safeName>`.
  - Specify upload retention: discard/removal of the git worktree does not delete uploaded run artifacts in v1; future artifact retention controls belong to the typed artifact/blob-store work.
  - Specify that the scratch runner is the selected configured project executor profile. The same ACP adapter agent may appear multiple times with different model/router/env settings; the launcher must preserve and display that distinction.
  - Specify capability selection groups: platform MCPs, project MCPs, project skills/rules, Flow-package skills/agent definitions, and restrictions. Tool-level restrictions are Designed unless already represented by supported selectable `restriction` records.
  - Specify the current provisioning boundary: selected capabilities are materialized as profile/instructions handoff only; native adapter config generation (`.mcp.json`, settings files, skill/agent directories, tool policies) is a Designed follow-up and must be named in Future Work.
  - State that scratch v1 keeps project-member operation access and documents future single-operator claim as Designed, not Implemented.

  Logging requirements:
  - Plan implementation must add INFO logs for launch requested/rejected, upload stored/rejected, message sent, and grouped workspace query failures.
  - Logs must include structured `runId`, `projectId`, `userId`, counts and sizes, never uploaded file contents or secrets.

  Acceptance:
  - `docs/system-analytics/scratch-runs.md` contains Purpose, Domain entities, State machine, Process flows, Expectations, Edge cases, Acceptance Criteria, and Linked artifacts.
  - No section still says binary uploads are Phase 2 after this feature.

- [x] Task 2: Update workspace/domain specs for grouped active workspaces.

  Deliverable: update `docs/system-analytics/workspaces.md`, `docs/VISION.md`, `.ai-factory/DESCRIPTION.md`, and `docs/PRODUCT_VIEW.md` only where needed to make active workspace grouping, project-level `+` launch, status labels, and launched-by display current-state documentation.

  Requirements:
  - Define active workspace status labels from `runs.status` plus `scratch_runs.dialog_status`.
  - State that `WaitingForUser` is scratch-specific and must be shown even though `runs.status = "Running"`.
  - State that the project-grouped rail includes Flow and scratch runs, while boards still filter to Flow runs.

  Logging requirements:
  - No new runtime logging in this task; docs must name the later query/UI logging checkpoints.

  Acceptance:
  - Docs do not describe a flat-only rail as the only current UX.
  - Docs do not imply scratch runs appear as board attempts.

- [x] Task 3: Update DB and API contract specs before migration/code.

  Deliverable: update `docs/database-schema.md`, `docs/db/runs-domain.md`, `docs/db/erd.md`, and `docs/api/web.openapi.yaml`.

  DB contract:
  - Add nullable `runs.created_by_user_id` FK to `users.id`.
  - Add `scratch_runs.work_mode: "auto" | "plan_first" | "manual_approval"` with default `"auto"`.
  - Add `scratch_runs.reasoning_effort: "low" | "high" | "extra" | "ultra"` with default `"high"`.
  - Keep `scratch_runs.plan_mode` for compatibility; define it as derived legacy policy where `work_mode = "plan_first"` maps to `"plan-first"`, otherwise `"off"`.
  - Extend `scratch_attachments.kind` with `"uploaded_file"`.
  - Add uploaded-file metadata columns to `scratch_attachments`: `file_name`, `mime_type`, `byte_size`, `sha256`, `storage_path`.
  - Define `storage_path` as the canonical server-local path used by the agent prompt and filesystem cleanup logic.
  - Define `value` for `uploaded_file` as a stable rootless artifact reference such as `.maister/<projectSlug>/runs/<runId>/uploads/<scope>/<safeName>`; existing metadata kinds keep current value semantics.
  - Public API DTOs must not expose absolute `storage_path`; only privileged server code reads it.

  API contract:
  - `GET /api/scratch-runs/launch-options` returns project defaults for command-box launch: fixed machine label, default project id, configured executor options, default executor id, default base branch, available branches, work mode options, reasoning effort options, and capability options grouped by source (`platform | project | flow-package`) and kind (`mcp | skill | rule | agent_definition | restriction` where selectable).
  - Executor options include `id`, `executorRefId`, `agent`, `model`, `router`, and display label. The contract names them as ACP runner profiles; it must not collapse multiple executor rows that share the same `agent`.
  - `POST /api/scratch-runs` and `/messages` accept both `application/json` and `multipart/form-data`.
  - Multipart requests include a JSON `payload` field matching the JSON schema and one or more `files` parts.
  - JSON requests continue to accept metadata-only attachments.
  - `POST /api/scratch-runs` accepts selected capability ids for platform MCPs, project/Flow-package skills, rules, agent definitions, and restrictions through the existing capability selection payload, rejecting invisible or unsupported enforced choices with typed errors.
  - Response detail includes uploaded attachment display metadata (`fileName`, `mimeType`, `byteSize`, `sha256`, `artifactRef`) and never exposes arbitrary server filesystem roots.
  - Error mapping follows the current route taxonomy: malformed JSON/multipart is `400 CONFIG`; invisible project, invalid branch, invalid filename/path, too many files, oversized file, and oversized total payload are `409 PRECONDITION`; branch/worktree conflicts and capacity races may be `409 CONFLICT`; supervisor/file-storage infrastructure failures are `503 EXECUTOR_UNAVAILABLE`.

  Logging requirements:
  - Specs must require INFO logs for accepted upload count/bytes and WARN logs for rejected upload reason.

  Acceptance:
  - OpenAPI describes both content types and all status codes: 201/202 success, 400 `CONFIG`, 409 `PRECONDITION | CONFLICT`, and 503 `EXECUTOR_UNAVAILABLE`; it does not introduce 413/422 unless the route error mapper is deliberately changed in the same task.
  - DB docs and ERD agree on every new column and enum value.

### Phase 1: Schema, Types, And Compatibility

- [x] Task 4: Add DB migration and Drizzle schema fields.

  Files: `web/lib/db/schema.ts`, `web/lib/db/migrations/0013_scratch_workspace_dialogs.sql`, migration metadata if generated by Drizzle.

  Requirements:
  - Add nullable `runs.created_by_user_id` with FK to `users.id`; backfill from `scratch_runs.created_by_user_id` for existing scratch runs.
  - Add scratch work mode and reasoning effort columns with safe defaults.
  - Add uploaded-file attachment kind and metadata columns.
  - Ensure `scratch_attachments.value` stays not-null; for `uploaded_file` rows it stores the rootless artifact reference, while metadata columns stay nullable for non-file attachment kinds.
  - Preserve existing rows and JSON-only flows.
  - Do not make legacy Flow rows invalid by requiring a creator.
  - Keep migration snapshots consistent: either generate `0013_*` plus `web/lib/db/migrations/meta/0013_snapshot.json` and `_journal.json` via `pnpm --filter maister-web db:generate`, or hand-edit the SQL and metadata as a single verified unit.

  Logging requirements:
  - No runtime logging in migration.

  Acceptance:
  - Postgres migration applies cleanly.
  - Schema types expose the new enums and fields without `any`.
  - Existing scratch metadata insert fixtures are migrated in tests.

- [x] Task 5: Extend scratch-run input/output types and pure helpers.

  Files: `web/lib/scratch-runs/types.ts`, `web/lib/scratch-runs/launch.ts`, `web/lib/scratch-runs/attachments.ts`, `web/lib/instance-config.ts`, `web/lib/capabilities/types.ts`, `web/lib/capabilities/resolver.ts`, `web/lib/capabilities/materialize.ts`, `web/app/api/scratch-runs/launch-options/route.ts`.

  Requirements:
  - Add `ScratchWorkMode`, `ScratchReasoningEffort`, and `uploaded_file` attachment input/output types.
  - Split client-safe attachment DTOs from internal stored attachment rows so absolute `storagePath` cannot leak through `GET /api/scratch-runs/{runId}`.
  - Make `branchName` optional in `scratchLaunchInputSchema`.
  - Keep JSON body compatibility for existing clients.
  - Add `runtimeRoot()` to `web/lib/instance-config.ts` and use it instead of duplicating `process.env.MAISTER_RUNTIME_ROOT ?? process.cwd()` in new scratch-upload code.
  - Add pure helpers for `workModeToPlanMode`, prompt decoration, safe upload filename generation, byte-size/hash metadata creation, rootless artifact ref creation, and server-local artifact-path derivation from server-state inputs.
  - Extend capability selection/launch-option DTOs so the launcher can show source-aware groups for platform MCPs, project MCPs, project skills/rules, Flow-package skills/agent definitions, and restrictions.
  - Preserve current resolver behavior: unknown/invisible ids are `CONFIG`; enforced unsupported capabilities are refused; optional unsupported capabilities are recorded as downgrade notes only when the existing resolver permits it.
  - Include selected runner/executor, work mode, reasoning effort, and resolved capability profile summary in materialized instructions.
  - Do not implement native adapter provisioning here unless the docs/API scope is explicitly expanded first. Keep `materializeCapabilityProfile` as the existing profile/instructions handoff plus any additional metadata needed for future provisioning.
  - Preserve the existing `decoratePromptForPlanMode` plan-first wording by routing it through the new work-mode helper, not by rewriting behavior.

  Logging requirements:
  - Pure helpers do not log.
  - Service callers will log decisions with helper outputs.

  Acceptance:
  - `decoratePromptForPlanMode` behavior is preserved for plan-first.
  - New helpers reject path traversal, absolute client-provided paths, and empty sanitized filenames with typed `PRECONDITION`.

### Phase 2: API Parsing, Upload Storage, And Services

- [x] Task 6: Implement JSON and multipart parsing for scratch launch and messages.

  Files: `web/app/api/scratch-runs/route.ts`, `web/app/api/scratch-runs/[runId]/messages/route.ts`, new helper under `web/lib/scratch-runs/request.ts`.

  Requirements:
  - Detect `Content-Type`; treat absent or `application/json` as the existing JSON path, and reject unsupported media types as `400 CONFIG`.
  - For JSON, keep current parsing path and behavior.
  - For multipart, parse `payload` JSON and `files` parts using the runtime `FormData`/`File` APIs available to Next.js route handlers.
  - Enforce fixed v1 limits: max 10 uploaded files per request, max 25 MiB per file, max 100 MiB total parsed payload.
  - Return typed `MaisterError` responses; do not introduce raw `Error` paths.
  - Map malformed payload/schema errors to `CONFIG`; map limit and path/filename rejections to `PRECONDITION`; do not add a new `MaisterError` code.
  - Do not accept body-controlled run/project/worktree/session identifiers.

  Logging requirements:
  - DEBUG: content type, file count, metadata attachment count.
  - WARN: multipart parse rejection with `code`, `runId` when available, `userId`, and size/count reason.
  - Never log file contents.

  Acceptance:
  - JSON launch/message route tests continue to pass.
  - Multipart tests cover valid mixed metadata/files and invalid over-limit requests.

- [x] Task 7: Store uploaded files as run artifacts and persist attachment rows.

  Files: `web/lib/scratch-runs/service.ts`, `web/lib/scratch-runs/attachments.ts`, `web/lib/atomic.ts` if a binary atomic helper is needed.

  Requirements:
  - Store launch uploads after `runId` and worktree path are known but before the DB transaction commits attachment rows.
  - Store message uploads after message id/sequence is allocated under the row lock and before inserting the message/attachment rows; if the write fails, rollback the DB transaction and leave no visible message.
  - Write binary uploads via temp-file + fsync/rename or an equivalent atomic binary helper; keep JSON artifact writes on the existing `atomicWriteJson` helper.
  - Use server-derived path: `runtimeRoot/.maister/<projectSlug>/runs/<runId>/uploads/<messageId-or-launch>/<safeFilename>`.
  - If file write fails, leave no DB message or attachment row for that file/message and surface retryable `EXECUTOR_UNAVAILABLE` before marking message delivery complete.
  - If prompt delivery fails after files and DB rows commit, keep the message visible and use the existing retryable/crashed dialog status handling; do not delete already-sent user intent.
  - On launch failure after file writes but before DB commit, best-effort cleanup upload directory alongside existing worktree cleanup.
  - Uploaded files must not be written inside `workspaces.worktreePath`.
  - The prompt sent to the agent must include concise attachment references with file name, MIME type, byte size, sha256, rootless artifact ref, and server-local path.
  - The browser detail response must include the rootless artifact ref and display metadata, not the server-local path.

  Logging requirements:
  - INFO: upload stored with `runId`, `messageId`, `fileName`, `byteSize`, `sha256`.
  - WARN: cleanup failure with `runId`, upload directory, and error message.
  - ERROR: file-write failure with path and code, no contents.

  Acceptance:
  - Uploaded files appear in scratch detail attachments.
  - `GET /api/runs/{runId}/diff` does not include uploaded files.
  - A simulated file-write failure does not append a message that cannot be delivered.

- [x] Task 8: Persist launched-by and new scratch launch metadata.

  Files: `web/lib/scratch-runs/service.ts`, `web/app/api/runs/route.ts`, `web/lib/queries/portfolio.ts`.

  Requirements:
  - Insert `runs.createdByUserId` on new Flow and scratch runs.
  - Insert `scratch_runs.workMode`, `scratch_runs.reasoningEffort`, and compatibility `planMode`.
  - Persist the selected configured executor on `runs.executorId`; do not mirror runner fields into `scratch_runs`.
  - Keep scratch runner compatibility with every executor row that the current supervisor spawn registry can actually launch. Selection is by executor id/profile, not by `agent`; if two rows are both Claude Code via different CCR/model/env settings, both remain distinct selectable runners.
  - Backfill active workspace query launched-by display from `runs.createdByUserId`, falling back to `scratch_runs.createdByUserId` for older scratch rows when needed.
  - Keep board queries unaffected.
  - Preserve authorization semantics: project members can operate scratch runs in v1; launched-by is display/audit metadata, not an ownership gate.

  Logging requirements:
  - Existing launch INFO logs gain `createdByUserId`, `workMode`, and `reasoningEffort` for scratch; Flow launch gains `createdByUserId`.

  Acceptance:
  - New Flow and scratch rows have creator id.
  - Legacy rows with null creator still render without crashing.

### Phase 3: Grouped Active Workspace Queries And Rail UI

- [x] Task 9: Replace flat rail data with grouped active workspace data.

  Files: `web/lib/queries/portfolio.ts`, `web/lib/queries/__tests__/portfolio.integration.test.ts`.

  Requirements:
  - Return `RailWorkspaceGroup[]` grouped by visible project.
  - Do not apply the old global `.limit(8)` before grouping. If the rail still needs a cap, cap per group or after computing group counts so project counts remain truthful.
  - Group contains `projectId`, `projectSlug`, `projectName`, active count, latest activity time, launch href `/scratch-runs/new?projectId=<id>`, and workspace rows.
  - Workspace row contains branch/display name, run kind, executor/agent/model, launched-by display, raw status label, status tone, time, and href.
  - Status mapping must distinguish `Running`, scratch `WaitingForUser`, `NeedsInput`, `NeedsInputIdle`, `HumanWorking`, `Review`, and `Crashed`.
  - Sort groups by latest active workspace first, then project name for ties; sort rows by latest activity first.
  - Respect admin visibility and project membership filtering.

  Logging requirements:
  - Query layer should not log normal reads.
  - If adding defensive fallback around malformed rows, log WARN with project/run ids only.

  Acceptance:
  - Integration tests cover two projects, mixed Flow/scratch rows, `WaitingForUser`, `HumanWorking`, `Crashed`, and launched-by fallback.

- [x] Task 10: Implement project-grouped left rail UI with per-project `+`.

  Files: `web/components/chrome/left-rail.tsx`, `web/app/(app)/layout.tsx`, `web/messages/en.json`, `web/messages/ru.json`.

  Requirements:
  - Render grouped project sections in the Active Workspaces area.
  - Project header shows name, count, and compact `+` link/action.
  - `+` links to `/scratch-runs/new?projectId=<id>` so the scratch launcher opens with that project preselected.
  - Row shows status dot + short label, branch/name, kind/executor/launched-by, and relative time.
  - Add accessible labels/tooltips for the per-project `+` action, because the glyph has no visible text.
  - Keep layout stable at narrow desktop widths; text truncates cleanly.

  Logging requirements:
  - UI component does not log.

  Acceptance:
  - Existing navigation and platform status remain visible.
  - The rail is usable with empty groups, one group, and several groups.

### Phase 4: Scratch Command-Box Launcher And Dialog Attachments

- [x] Task 11: Redesign scratch launcher as compact command box.

  Files: `web/components/scratch/scratch-launcher.tsx`, `web/app/(app)/scratch-runs/new/page.tsx`, `web/messages/en.json`, `web/messages/ru.json`.

  Requirements:
  - Top row: optional workspace name and optional branch name.
  - Main area: prompt textarea.
  - Bottom row: fixed machine label from launch-options, project dropdown, base branch dropdown defaulting to project default branch.
  - Compact controls: runner/executor menu, files menu, work mode menu, reasoning effort menu, platform MCP menu, skills/agent-packs menu, rules/restrictions menu.
  - Project query param preselects project, refreshes branch/executor/capability options, and keeps base branch defaulted to the selected project's default branch unless the user changes it.
  - Empty branch submits no `branchName`; backend derives fallback.
  - File menu supports binary file input plus metadata attachments.
  - Work mode writes `auto | plan_first | manual_approval`; compatibility plan mode follows the helper.
  - Runner/executor defaults to the selected project's default executor from launch-options and displays configured executor label, ACP adapter/agent, model, router, and env-router hint when present.
  - The launcher must not special-case "Claude" as the only scratch runner or deduplicate by `agent`. It renders every configured executor profile returned by launch-options, including multiple Claude Code profiles with different CCR/model routing.
  - Platform MCPs default to selected-by-default records from `.mcp.json`/catalog. Project and Flow-package skills/agent definitions are selectable from the capability catalog and grouped by source so users can see what came from platform, project config, or installed Flow packages.
  - Restrictions/tool-policy controls are shown as capability selections only for currently selectable catalog records; the UI labels strict tool sandboxing as future/designed when enforcement is not supported by the resolver/materializer.
  - The launcher may show selected MCPs/skills/settings as "included in run profile" but must not claim they are natively installed into `.mcp.json`, `settings.local.json`, or adapter skill directories until the future provisioning milestone lands.
  - Reasoning effort defaults to `high` unless launch-options later supplies a project-specific default.
  - The UI must label `auto`, `manual_approval`, and reasoning effort as launch policy/instructions, not guaranteed adapter enforcement.

  Logging requirements:
  - Client does not log.
  - Server logs from earlier tasks cover submitted policy fields and file counts.

  Acceptance:
  - User can launch without typing branch name.
  - User can upload files before launch.
  - The UI does not present unsupported controls as enforced if they are metadata-only.

- [x] Task 12: Update scratch dialog composer and attachment rendering.

  Files: `web/components/scratch/scratch-dialog.tsx`, `web/app/api/scratch-runs/[runId]/route.ts`, `web/messages/en.json`, `web/messages/ru.json`.

  Requirements:
  - Composer accepts binary files plus metadata attachments.
  - Composer sends JSON when there are no binary files and multipart when any binary file is attached.
  - Message attachment list shows uploaded filename, size, MIME type, and hash prefix.
  - Context/sidebar shows launch uploads separately from message uploads.
  - Disable send while prompt is running exactly as today.
  - Scratch detail response includes `workMode`, `reasoningEffort`, creator display, and client-safe uploaded attachment metadata where useful.
  - Detail serialization must translate `scratch_attachments.storage_path` into omitted/private data and expose only the rootless `artifactRef`.

  Logging requirements:
  - Client does not log.
  - Server detail route logs only unexpected errors.

  Acceptance:
  - Uploaded launch files and message files render deterministically.
  - Existing permission/HITL card still works.

### Phase 5: Tests, Runnability, And Migration

- [x] Task 13: Add and migrate unit/integration tests for API and services.

  Files:
  - `web/app/api/scratch-runs/__tests__/route.test.ts`
  - `web/app/api/scratch-runs/launch-options/__tests__/route.test.ts`
  - `web/app/api/scratch-runs/[runId]/__tests__/route.test.ts`
  - `web/app/api/scratch-runs/[runId]/messages/__tests__/route.test.ts`
  - `web/lib/scratch-runs/__tests__/services.test.ts`
  - `web/lib/queries/__tests__/portfolio.integration.test.ts`
  - `web/lib/db/__tests__/schema.integration.test.ts`

  Requirements:
  - Launch-options tests cover project preselection, runner/executor list, default executor, fixed machine label, default base branch, source-grouped platform/project/Flow-package capability options, work mode options, and reasoning effort options.
  - Route tests cover JSON backward compatibility, multipart launch, multipart message, mixed attachment kinds, optional branch fallback, and upload limit rejection.
  - Route/service tests cover selected configured runner persistence, preserving two same-agent executor rows as distinct options, and rejection of executor ids outside the selected project or unsupported by the supervisor spawn registry.
  - Capability tests cover platform MCP defaults, Flow-package skill/agent-definition visibility, invisible capability rejection, and enforced unsupported restriction refusal.
  - Detail route tests cover client-safe uploaded attachment serialization and verify absolute storage paths are not returned.
  - Service tests cover path sanitization, rootless artifact refs, hash/metadata persistence, prompt attachment references, message-write rollback on file-write failure, retryable prompt-delivery failure after DB commit, and cleanup on launch failure.
  - Portfolio integration covers grouped rail, status labels, launched-by, and preselected project launch href.
  - Schema integration covers new columns and defaults.
  - Diff regression covers uploaded files staying outside `GET /api/runs/{runId}/diff` and promote/diff output.

  Logging requirements:
  - Test fixtures may assert structured log context only where helpers expose it; do not make tests brittle on exact log strings.

  Runnability:
  - Files under `web/app/api/**/*.test.ts` and `web/lib/**/*.test.ts` are already matched by the existing unit/integration workspace. Confirm with `pnpm --filter maister-web test:unit -- --list` or `vitest --project unit --list` if the runner supports it.

  Acceptance:
  - `pnpm --filter maister-web test:unit -- --runInBand` is not required; use the project scripts.
  - `pnpm --filter maister-web test:unit` passes.
  - `pnpm --filter maister-web test:integration` passes or any Docker/Testcontainers unavailability is reported as environmental, not ignored.

- [x] Task 14: Add Playwright smoke coverage for launcher and rail.

  Files: `web/e2e/scratch-launch.spec.ts`, `web/e2e/portfolio-board.spec.ts`, test fixtures/seeding helpers if needed.

  Requirements:
  - Open grouped rail, click project `+`, verify launcher opens with project preselected.
  - Launch with generated branch fallback, work mode, effort, and file upload.
  - Open scratch dialog and see uploaded attachment metadata.
  - Verify active workspace row shows project group, status label, executor, and launched-by display.

  Logging requirements:
  - Test code should not add runtime logging.

  Acceptance:
  - `pnpm --filter maister-web test:e2e -- scratch-launch.spec.ts` passes in the configured E2E environment.
  - If E2E DB/browser environment is unavailable locally, document the exact command and blocker.

### Phase 6: Final Docs, Validation, And Release Readiness

- [x] Task 15: Run docs and contract validation.

  Files: docs/specs changed in earlier tasks.

  Requirements:
  - Run `scripts/validate-docs-mermaid.mjs`.
  - Run stale-text greps for "Binary upload storage is Phase 2", flat-only rail language, public exposure of absolute `storage_path`, and required `branchName` language.
  - Verify OpenAPI references resolve around scratch schemas.

  Logging requirements:
  - No runtime logging.

  Acceptance:
  - Mermaid validation passes.
  - No stale docs claim binary upload remains Phase 2 after this feature.

- [x] Task 16: Run final project verification.

  Requirements:
  - Run `git --no-pager diff --check`.
  - Run `pnpm --filter maister-web typecheck`.
  - Run `pnpm --filter maister-web test:unit`.
  - Run `pnpm --filter maister-web test:integration`.
  - Run focused Playwright smoke if the local E2E environment is available.

  Logging requirements:
  - No runtime logging.

  Acceptance:
  - All required checks pass or the final handoff names exact environmental blockers.
  - Any pre-existing failures are documented with command output and not mixed with new regressions.
