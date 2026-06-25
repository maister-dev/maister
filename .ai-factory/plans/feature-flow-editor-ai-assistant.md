# Implementation Plan: Flow Editor AI Assistant

Branch: HEAD (detached worktree; branch creation intentionally skipped)
Created: 2026-06-25

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage
Milestone: "none"
Rationale: Skipped in this manual plan because the current worktree is detached and already contains Flow Studio UI changes.

## Scope

Implement the Flow Studio AI assistant as a safe authoring copilot, not just a docked scratch chat. The assistant must answer questions from the current Flow/package context, and when the user asks for edits it must produce a structured action that the server validates and applies in-place to the local package working dir. Raw protocol JSON must never be shown in the primary transcript.

Existing implemented baseline:
- Bottom AI panel in the local-package editor, collapsible under the canvas/properties surface.
- Wider hideable right-side properties rail in `FlowGraphEditor`.
- Project-less local-package assistant launch through `launchLocalPackageAssistant`.
- `runnerId` already accepted by the launch route and resolved as launch override -> platform default.
- Lock coordination, local-package working-dir confinement, inline HITL, and live editor refresh already exist.

Missing work:
- Flow/package context builder for prompt grounding.
- Assistant system prompt/protocol that includes Flow grammar, current flow, package capabilities, runner context, and selected editor focus.
- Read-only ACP behavior for Q&A/action turns.
- Structured action parsing, validation, lock-guarded in-place apply, and action audit JSONL.
- Studio-specific message endpoint wiring from the docked assistant UI.
- Editor buffer synchronization before assistant turns so server-side apply never races unsaved canvas/form state.
- Reload-stable UI applied-change cards stored as sanitized scratch system messages, with raw JSON stripped before persistence/rendering.
- Runner selector in the bottom assistant panel.

## Architecture Decisions

- Assistant sessions for Flow authoring become read-only ACP sessions (`readOnlySession: true`). Agents may inspect files but must not mutate the working dir directly. Mutations happen only through the server-side structured action apply path.
- Structured actions are full-file `upsert_file` / `delete_file` operations with server-computed base hashes. Hunk-level patching is deferred; full-file ops reuse existing local-package write and validation primitives.
- Apply structured actions in-place during the Studio assistant turn after validation. The local package working tree + existing git diff drawer is the user-visible review buffer; Commit/Discard remains the durable accept/revert boundary.
- Do not add a proposal table for V1. Persist raw structured actions and apply results as run-scoped JSONL artifacts under the assistant run directory for audit/debug/recovery. Store only sanitized user-facing action summaries in `scratch_messages` as a typed system payload so reloads keep the UI card without exposing protocol JSON. The DB remains `runs` / `scratch_runs` / `scratch_messages`.
- Keep using `run_kind = "scratch"` for the assistant. No new `runs.status`, no new run kind, and no supervisor process model change.
- Add a Studio-specific assistant message route instead of widening the generic scratch message route with package-only body fields. The bottom assistant panel must route follow-up sends through that endpoint, not through the generic scratch message endpoint.
- Treat launch prompts and follow-up prompts as the same turn pipeline: context snapshot -> read-only ACP prompt -> parse/sanitize -> optional validated apply -> sanitized transcript result.
- Reserve ADR-110 for the structured Flow assistant action protocol. No migration is planned unless implementation discovers that JSONL is insufficient.

## Contract Surfaces

- Web HTTP API:
  - `POST /api/studio/local-packages/{id}/assistant` changes semantics: launches a read-only assistant session, accepts optional `runnerId`, `intent`, and editor focus context, and runs the initial prompt through the same structured-action pipeline used by follow-up messages.
  - `GET /api/studio/local-packages/{id}/assistant/runners` lists enabled Ready assistant runners plus the platform default, using the same runner catalog/readiness semantics as other launch-option routes.
  - `POST /api/studio/local-packages/{id}/assistant/{runId}/messages` sends Studio assistant turns with `sessionId`, `intent`, and focus context; mutation turns return an `actionResult` summary after in-place apply and persist that summary as a sanitized scratch system message.
  - No V1 client route reads raw action JSONL. A future debug-only `GET /actions` may be added later, but the product UI must use sanitized transcript payloads.
- Specs/docs to update in the same phase:
  - `docs/system-analytics/studio-ai-assistant.md`
  - `docs/api/web.openapi.yaml`
  - `docs/database-schema.md` only if an existing run artifact reference needs clarification; no new table is planned.
  - `docs/flow-dsl.md` if the prompt grammar references new supported authoring protocol terms.
  - `docs/decisions.md` ADR-110.
- No new env vars, sidecars, ports, package dependencies, or DB migrations are planned. Deployment wiring task is therefore a no-op, but `.env.example`, `compose.yml`, and production compose must be explicitly checked for no changes needed.

## Identifier Trust Boundaries

- `POST /api/studio/local-packages/{id}/assistant`
  - `id`: url-param -> local package server-state lookup.
  - `sessionId`: body-controlled lock token -> compared via `assertHoldsLock(id, sessionId)`.
  - `runnerId`: body-controlled runner id -> allow-list against enabled Ready `platform_acp_runners`.
  - `focus.path` / `selectedNodeId`: body-controlled editor context -> optional hints only, validated against server-read current package files / compiled graph before prompt use.
- `GET /api/studio/local-packages/{id}/assistant/runners`
  - `id`: url-param -> local package server-state lookup. No body identifiers.
- `POST /api/studio/local-packages/{id}/assistant/{runId}/messages`
  - `id`, `runId`: url-params. Handler must join `runs.local_package_id = id`, `scratch_runs.run_id = runId`, and `runs.created_by_user_id = session user`.
  - `sessionId`: body-controlled lock token -> compared via `assertHoldsLock(id, sessionId)`.
  - `intent`: body-controlled mode -> enum only; controls prompt/read-only/action parser, never a filesystem path.
  - `focus.path` / `selectedNodeId`: body-controlled hints -> validate against server-state.
  - File paths inside structured actions are model-controlled data -> every operation path re-validates through `resolveWithinWorkingDir` at apply time.
- Sanitized `flow_action_result` scratch system messages
  - Produced by server-side apply only, never by user/model body data directly.
  - Contains relative file paths, operation/status summaries, and validation issues only; raw structured action JSON and absolute paths stay server-side.

## Commit Plan

- Commit 1 (tasks 1-2): `docs: specify flow assistant action contract`
- Commit 2 (tasks 3-5): `feat: add flow assistant action parser and audit log`
- Commit 3 (tasks 6-8): `feat: ground flow assistant turns and apply actions`
- Commit 4 (tasks 9-12): `feat: render assistant applied changes in studio`
- Commit 5 (tasks 13-14): `test: verify flow assistant action workflow`

## Tasks

### Phase 0: Contract First

- [x] Task 1: Write the behavior spec and ADR before code.
  - Files: `docs/system-analytics/studio-ai-assistant.md`, `docs/decisions.md`.
  - Deliverable: ADR-110 defines read-only assistant sessions, structured action blocks, full-file operations, base-hash conflict handling, in-place apply, JSONL audit records, raw-JSON hiding, and apply crash windows.
  - Acceptance: The spec explicitly distinguishes Q&A turns, action turns, validated apply, invalid action, stale action, interrupted apply, and assistant crash/recover.
  - Logging requirements: State every server boundary that will log at DEBUG/INFO/WARN/ERROR; no runtime logging code yet.

- [x] Task 2: Update API/docs contracts and deployment checklist.
  - Files: `docs/api/web.openapi.yaml`, possibly `docs/database-schema.md`, possibly `docs/flow-dsl.md`, `.env.example`, `compose.yml`, `compose.production.yml`.
  - Deliverable: OpenAPI covers all new/changed routes, bodies, responses, `actionResult`, and error statuses; docs describe the JSONL audit artifact; deployment artifacts are checked and either unchanged or updated.
  - Acceptance: Every route in the Identifier Trust Boundaries section is reflected in OpenAPI with server-state vs body-controlled semantics. No new env/dependency/port/DB migration is silently introduced.
  - Logging requirements: Document intended log fields: `localPackageId`, `runId`, `actionId`, `intent`, `runnerId`, `focusPath`, `operationCount`, `status`, and validation issue count.

### Phase 1: Action Protocol And Audit Log

- [x] Task 3: Add the run-scoped assistant action JSONL artifact.
  - Files: `web/lib/studio/flow-assistant/action-log.ts`, `web/lib/studio/flow-assistant/run-artifacts.ts` or another neutral shared helper, possibly refactor the `.maister/<slug>/runs/<runId>` helper currently mirrored by `web/lib/flows/graph/mutation-check.ts`.
  - Deliverable: Append-only JSONL records for `received`, `validated`, `applied`, `rejected`, and `interrupted` action states under the assistant run directory, resolved from `runtimeRoot`, local-package slug, and `runId`.
  - Acceptance: The action log is server-only, contains relative paths only, never exposes absolute working dirs or secrets, and is not the source of truth for current files. Working dir + git diff remains authoritative. A partial/corrupt final JSONL line is ignored by any recovery/debug reader rather than breaking the assistant UI.
  - Logging requirements: INFO for action log writes; WARN if the audit log write fails after an apply succeeds, because user-visible file state still wins.

- [x] Task 4: Implement action protocol schemas, parser, transcript sanitizer, and action-result payload.
  - Files: `web/lib/studio/flow-assistant/protocol.ts`, `web/lib/scratch-runs/transcript.ts`, `web/lib/scratch-runs/events.ts`, `web/components/scratch/scratch-transcript.tsx`.
  - Deliverable: Zod schema for `maister_flow_assistant_action.v1`, `parseAssistantActionBlocks`, `stripAssistantProtocolBlocks`, typed errors for malformed blocks, and a new `ScratchSystemPayload` kind such as `flow_action_result`.
  - Acceptance: Valid action JSON is extracted for validation/apply; malformed protocol blocks create a friendly invalid-action state without exposing raw JSON in the transcript; ordinary markdown stays unchanged. Sanitization happens before or during `scratch_messages` persistence so raw protocol blocks are not stored as normal assistant markdown.
  - Logging requirements: DEBUG on parse attempt with byte length; INFO on action extracted; WARN on malformed action with zod issue summary, never full file contents.

- [x] Task 5: Build server-side action validation and UI DTO shaping.
  - Files: `web/lib/studio/flow-assistant/actions.ts`, `web/lib/local-packages/service.ts` if `readWorkingDirArtifactFiles` or equivalent needs to become shared, focused tests under `web/lib/studio/flow-assistant/__tests__/`.
  - Deliverable: Validate operations against base hashes and a virtual package state, reuse `validatePackageArtifacts` before any writes, then produce sanitized `actionResult` DTOs for the assistant panel/system payload.
  - Acceptance: Helpers enforce run/local-package ownership from server-state and do not trust body-provided local package ids. Stale hashes, path escapes, malformed actions, and invalid virtual package artifacts fail before filesystem writes.
  - Logging requirements: INFO for action lifecycle transitions; WARN for invalid/stale attempts; ERROR only for unexpected validation failures with `runId`/`actionId`.

### Phase 2: Grounded ACP Turns And In-Place Apply

- [x] Task 6: Build the Flow assistant context snapshot.
  - Files: `web/lib/studio/flow-assistant/context.ts`, `web/lib/local-packages/service.ts` if shared read helpers are needed.
  - Deliverable: `buildFlowAssistantContext` returns current package manifest, active flow YAML, graph summary from `buildAuthoredFlowGraph`, validation issues, package file inventory, local package capability inventory (`skills`, `agents`, `mcps`, `rules`, `schemas`), optional project context for project-scoped default packages, and runner summary.
  - Acceptance: Parse errors produce a structured context with last-known/invalid state; no working dir absolute paths leave the server; large files are summarized with truncation flags.
  - Logging requirements: DEBUG counts for files/capabilities/nodes/edges; WARN for parse/validation failures included in context.

- [x] Task 7: Change assistant launch/send to read-only, context-grounded turns.
  - Files: `web/lib/scratch-runs/service.ts`, `web/lib/flows/authoring-skill.ts`, `web/app/api/studio/local-packages/[id]/assistant/route.ts`, new `web/app/api/studio/local-packages/[id]/assistant/[runId]/messages/route.ts`.
  - Deliverable: Assistant `createSession` passes `readOnlySession: true`; the `flow-authoring` materialized skill no longer tells agents to edit files directly; every launch/send prepends system context and action instructions; mutation requests instruct the model to return an action block, not edit files.
  - Acceptance: A local-package assistant turn cannot write through ACP tools; Q&A answers use current context; mutation prompts produce parseable action candidates; generic scratch routes remain unchanged. Initial launch prompts and follow-up prompts share the same parse/sanitize/apply helper so the first user request cannot bypass structured apply.
  - Logging requirements: INFO launch/send with `intent`, `runnerId`, `readOnlySession:true`; DEBUG context size/truncation; WARN when user focus hints are rejected.

- [x] Task 8: Implement lock-guarded in-place action apply in the Studio message route.
  - Files: `web/app/api/studio/local-packages/[id]/assistant/[runId]/messages/route.ts`, `web/lib/studio/flow-assistant/apply.ts`, `web/lib/studio/flow-assistant/turn.ts`.
  - Deliverable: The shared turn helper parses the assistant action block, validates base hashes, validates virtual package artifacts before writes, writes through existing confined local-package file helpers, appends action JSONL records, inserts a sanitized `flow_action_result` system message, and returns a sanitized `actionResult`.
  - Acceptance: Stale hash -> 409 no writes; path escape -> 409 no writes; invalid flow/schema/frontmatter -> 422 no writes; success refreshes working-tree diff/canvas. If a process dies after writes begin, the next UI refresh surfaces the existing working-tree diff and the action log can show an interrupted apply warning; Commit/Discard remains the recovery boundary.
  - Logging requirements: INFO apply begin/success; WARN stale/invalid/interrupted; ERROR unexpected write failure with operation index and confined relative path only.

### Phase 3: Runner Selection And UI Rendering

- [x] Task 9: Add Studio assistant runner options.
  - Files: new `web/app/api/studio/local-packages/[id]/assistant/runners/route.ts`, `web/components/studio/studio-ai-tab.tsx`, `web/messages/en.json`, `web/messages/ru.json`.
  - Deliverable: Bottom assistant launch form includes a compact runner selector showing enabled Ready runners plus platform default, built from the same `platform_acp_runners` / `platform_runtime_settings` / `resolveRunner` semantics used by launch-option routes.
  - Acceptance: Selected `runnerId` is sent only to the assistant launch route; disabled/not-ready/missing runners are rejected server-side; no admin-only API is exposed to non-admin UI.
  - Logging requirements: DEBUG list count; INFO selected runner on launch; WARN rejected runner override.

- [x] Task 10: Wire the docked assistant UI to the Studio-specific message route.
  - Files: `web/components/scratch/scratch-conversation.tsx`, `web/components/studio/studio-ai-tab.tsx`, `web/messages/en.json`, `web/messages/ru.json`.
  - Deliverable: `ScratchConversation` gains a small endpoint override/callback seam or `StudioAiTab` wraps message sending so follow-up turns call `/api/studio/local-packages/{id}/assistant/{runId}/messages` with `sessionId`, `intent`, and focus context. The hardcoded generic recover path is either given the same Studio-specific override or hidden/disabled for the docked Flow assistant until a structured recovery route exists.
  - Acceptance: Generic project scratch chat still posts to `/api/scratch-runs/{runId}/messages`; local-package assistant follow-ups use the Studio route. Attachment controls are preserved only if the Studio route accepts the same JSON/form-data payload; otherwise the docked assistant disables attachments with no broken controls. No Studio assistant action path posts mutation/recovery prompts through generic scratch routes. Errors are surfaced through existing `readApiError` patterns.
  - Logging requirements: Client logs no prompt/action contents. Server logs route lifecycle.

- [x] Task 11: Render applied-change cards from sanitized system messages and hide protocol JSON.
  - Files: `web/components/studio/studio-ai-tab.tsx`, new `web/components/studio/flow-assistant-action-result.tsx`, `web/components/scratch/scratch-transcript.tsx`, `web/lib/scratch-runs/transcript.ts`, `web/messages/en.json`, `web/messages/ru.json`.
  - Deliverable: The assistant panel shows normal prose plus `flow_action_result` cards with summary, touched files/nodes, validation status, and links to inspect the existing diff. Raw action JSON is absent from stored assistant markdown and rendered transcript.
  - Acceptance: Long action cards scroll inside the bottom panel; no text overflows buttons/cards; successful apply refreshes canvas/diff; cards survive `router.refresh()` and page reload because they come from `scratch_messages`, not a transient POST response.
  - Logging requirements: Client logs no action contents. Server logs lifecycle; UI shows friendly errors via `readApiError`.

- [x] Task 12: Preserve editor ergonomics and synchronize unsaved buffers while assistant actions run.
  - Files: `web/components/studio/local-package-editor.tsx`, `web/components/studio/studio-ai-tab.tsx`.
  - Deliverable: In-place apply uses the existing editor lock, sets a short "AI applying" busy state, refreshes `diffRefresh` and `router.refresh()`, and leaves properties rail/canvas visible. Before any assistant turn, the UI either auto-saves the current FlowEditorTabs/package-files buffers through the existing `saveAction` path or blocks the send with a clear "save current editor changes first" state.
  - Acceptance: The assistant never applies against stale server files while the canvas/YAML/files editor has unsaved changes; human editor writes are disabled only while a turn/apply is in flight; collapsed AI panel still preserves run/action state; properties rail remains right-side, wide, and full-height.
  - Logging requirements: No client console logging except existing lock-release warning; action failures are surfaced in UI.

### Phase 4: Verification

- [x] Task 13: Add focused unit/integration coverage.
  - Files: `web/lib/studio/flow-assistant/__tests__/*`, route tests beside new routes, updates to `web/lib/scratch-runs/__tests__/local-package-assistant.integration.test.ts`.
  - Deliverable: Tests for protocol parse/strip, `flow_action_result` encode/parse/render contract, context builder, read-only session launch, Studio-specific message routing, action JSONL append, stale hash refusal, invalid virtual package refusal, path escape refusal, and in-place apply success.
  - Acceptance: Confirm tests are included by the runner (`pnpm --filter maister-web exec vitest list ...` or equivalent) and run green. Existing local-package assistant tests are updated from "fake supervisor writes files directly" toward read-only ACP + server structured apply semantics.
  - Logging requirements: Tests assert important log-triggering branches where practical without fragile full-log snapshots.

- [x] Task 14: Add UI/E2E smoke coverage and final gates.
  - Files: `web/e2e/studio-ai-assistant.spec.ts`, any page fixtures needed.
  - Deliverable: E2E covers bottom panel launch with runner selector, Studio-specific follow-up send, applied-change card render without raw JSON, in-place apply refreshes diff/canvas, unsaved-buffer guard/autosave behavior, and collapse preserves state.
  - Acceptance: Run `pnpm --filter maister-web typecheck`, targeted vitest suites, targeted Playwright spec, `pnpm validate:docs`, and `git --no-pager diff --check`. If `.next/dev/types` causes stale route errors, clear only `web/.next/dev/types` and rerun.
  - Logging requirements: E2E should not depend on log output; runtime logs remain structured enough to debug failures.

## Acceptance Criteria

- Asking "what does this Flow do?" answers from the current `flow.yaml`, compiled graph, package files, and capability inventory.
- Asking for a Flow edit produces a structured action, not direct ACP file mutation and not visible JSON.
- A valid action is applied in-place only under the local-package lock, only inside the working dir, and only after base-hash and virtual validation pass.
- Stale, invalid, malformed, and interrupted actions are recoverable user-facing states; the existing git diff drawer remains the review/revert buffer.
- Assistant turns never race unsaved editor buffers: current canvas/YAML/package-file state is saved first or the send is blocked with a clear message.
- Applied-change cards are reload-stable via sanitized `scratch_messages` system payloads; raw protocol JSON stays in server-only audit artifacts.
- Runner selection is configurable from the assistant panel and uses the platform ACP runner catalog/readiness.
- The editor keeps canvas/properties visible above the bottom assistant panel; the right properties rail remains wider and full-height.
- Docs, OpenAPI, JSONL action artifacts, and tests all describe the same contract.
