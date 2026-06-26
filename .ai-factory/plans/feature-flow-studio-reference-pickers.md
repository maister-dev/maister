# Implementation Plan: Flow Studio Reference Pickers

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. The implementation phase is strict TDD: each behavior change must go RED -> GREEN -> refactor before moving on.

**Goal:** Make Flow Studio reference authoring safer by replacing raw runner/agent/schema path fields with source pickers while preserving the existing Flow DSL, save path, API, and DB contracts.

**Architecture:** Keep all runtime contracts unchanged. Add client-safe pure helpers for option building and file/schema write intents, keep presentation components focused, and let `LocalPackageEditor` own one shared package-file draft used by both package home and flow editor surfaces.

**Tech Stack:** Next.js 16 App Router, React 19 client components, TypeScript strict, HeroUI/Tailwind styling, Vitest unit/integration, Playwright E2E.

Branch: planned `feature/flow-studio-reference-pickers` (plan written from detached `main` worktree)
Created: 2026-06-26
Spec target: `.ai-factory/specs/feature-flow-studio-reference-pickers.md`

## Settings
- Testing: yes. Implementation is strict TDD: every behavior task starts with a failing test, verifies RED, implements the minimum GREEN, then refactors while staying green.
- Logging: standard. Do not add client `console.*`. Reuse existing structured server logging only where the existing runners endpoint is involved; client fetch failures surface as UI state and keep free-text fallback available.
- Docs: yes. Docs/spec checkpoint is mandatory before code because this changes Flow Studio authoring behavior. API contracts, DB docs, migrations, and system analytics move only if Phase 0 proves the surface changed.

## Implementation Principles
- Follow existing MAIster patterns before adding abstractions.
- Keep modules single-purpose: pure source builders in `reference-sources.ts`, presentation in `reference-combobox.tsx`, schema editing composition in `schema-ref-field.tsx`, state ownership in `local-package-editor.tsx`.
- Preserve strict TypeScript. No `any`; define types for option groups, schema refs, and file writes.
- Follow SOLID where it applies to this React/TypeScript surface: one responsibility per helper/component, explicit typed props, and no broad abstractions before tests prove duplication.
- Keep the implementation KISS/DRY/YAGNI: no platform-agent endpoint, no new save route, no runtime DSL migration, no popover library swap.
- Do not mutate input arrays/objects in helper functions; return new arrays/objects.
- Refactor only after tests are GREEN and only within the touched feature surface.

## Roadmap Linkage
Milestone: "M39. Flow Studio package authoring" polish / follow-on.
Rationale: This is a Flow Studio local-package authoring UX improvement over the M39 local package editor and M41 consensus node surface. It does not introduce a new runtime milestone, engine bump, route, DB table, or run state.

## Problem Statement
Flow Studio currently exposes several raw text fields where the user should be selecting or creating references:

- Consensus participant rows expose separate `agent` and `runner` text fields even though the DSL requires exactly one of them.
- Consensus synthesizer exposes the same separate `agent` and `runner` fields.
- `settings.form_schema` and `output.result.schema` are raw path fields even though package schema files already live in `schemas/*.json` and `FormSchemaBuilder` already edits that grammar.

The goal is to preserve the underlying DSL shapes while making the authoring surface safer and faster:

- One grouped source picker for each participant/synthesizer slot.
- One schema reference picker for each schema-ref slot.
- Inline creation/edit/paste of `schemas/*.json` files through the existing package-file save path.
- Free-text remains available for forward refs and custom ids.

## Ground Truth Confirmed
- `web/lib/config.schema.ts` already enforces exactly one of `agent` or `runner` for `consensusParticipantSchema` and `consensusSynthesizerSchema`.
- `web/components/flows/node-form/node-side-form.tsx` currently renders separate consensus `agent`/`runner` text fields and raw schema path text fields.
- `web/app/api/studio/local-packages/[id]/assistant/runners/route.ts` already returns enabled Ready platform runner options at member scope.
- `web/lib/agents/registry.ts` registers package platform agents from `maister-agents/<stem>.md` as `<packageName>:<stem>`.
- `/studio/edit` passes `identity.project = pkg.name`, matching the package-name prefix required for package-local agent ids.
- `PackageFilesEditor` owns a private `draftFiles` state and emits the single `packageFilesJson` hidden input consumed by `LocalPackageEditor.saveAction`.
- `PackageHome` also mounts `PackageFilesEditor`, so any lifted package-file draft must feed both the package home and flow editor files drawer.
- `FormSchemaBuilder` already edits a `formSchemaSchema` JSON document without owning persistence.
- `docs/screens/studio/editor.md` currently says consensus properties are participant rows with `agent` or `runner`; it needs to describe the new source picker.

## Locked Decisions
1. No DSL shape change. The manifest still stores `participant.agent` OR `participant.runner`, `synthesizer.agent` OR `synthesizer.runner`, `settings.form_schema`, and `output.result.schema`.
2. No new endpoint. Runner options use the existing `/api/studio/local-packages/[id]/assistant/runners` route. Agents are derived client-side from package-local `maister-agents/*.md` files.
3. No platform-wide agent catalog in this picker. The admin-only `/api/admin/agents` route stays out of member local-package editing.
4. Schema file writes go through the existing Save path. Lift package files state to `LocalPackageEditor`, pass that controlled draft into both `PackageHome` and the `FlowEditorTabs` files drawer, and do not persist schema files through out-of-band `PUT` before Save.
5. Schema refs written into the manifest use `./schemas/<name>.json`. Package file paths remain `schemas/<name>.json`.
6. Free-text source inference: exact runner id -> runner; exact agent id -> agent; otherwise default to runner and show a small `as runner` / `as agent` toggle for that unmatched free-text value.
7. Read-only viewer surfaces do not fetch runner/agent/schema sources. They render the current value as read-only/free-text only.

## Contract Surface Trace
| Surface | Change? | Plan action |
| --- | --- | --- |
| Flow DSL / Zod manifest shape | No shape change | Add tests proving emitted nodes still parse under existing `config.schema.ts`; no engine bump. |
| HTTP API / OpenAPI | No route or response shape change | Reuse existing runners endpoint, already documented as `/api/studio/local-packages/{id}/assistant/runners`; Phase 0 verifies no OpenAPI edit is needed. |
| DB / Drizzle migrations | No | No migration. Phase 0 grep verifies no schema/table/index change. |
| AsyncAPI / SSE | No | No event change. |
| `MaisterError` taxonomy | No | No new error code. |
| System analytics / screen docs | Yes | Update `docs/system-analytics/flow-studio.md` and `docs/screens/studio/editor.md` to describe pickers, inline schema authoring, read-only degradation, and no API/DB/runtime contract change. |
| i18n | Yes | Add EN/RU labels for source picker and schema ref editor. |
| Deployment | No | No env var, sidecar, port, package dependency, or compose change. |

## Test Strategy
Use minimum-overlap coverage:

- Pure helper unit tests cover classification, normalization, source patches, package-file draft transforms, schema write intents, and filename derivation.
- Component unit tests cover static render states and initial controlled/uncontrolled ownership; browser click/callback behavior is covered in E2E because the unit project runs in Node and primarily uses `renderToStaticMarkup`.
- Node form tests cover generated field/testid surface and emitted node parseability.
- One integrated E2E path covers real browser selection, schema creation, save, and re-open.
- Existing viewer E2E covers read-only degradation with no fetch.

Every new test file is covered by `web/vitest.workspace.ts`:

- Unit include globs cover `web/lib/**/__tests__/**/*.test.ts` and `web/components/**/__tests__/**/*.test.ts`.
- Integration include globs cover `web/lib/**/*.integration.test.ts` and `web/app/**/*.integration.test.ts`.

## Commit Plan
- Commit 1 (Phase 0): `docs(studio): freeze reference-picker SDD`
- Commit 2 (Phase 1): `feat(studio): add reference source helpers and combobox`
- Commit 3 (Phase 2): `feat(studio): replace consensus agent runner fields with source picker`
- Commit 4 (Phase 3): `feat(studio): add schema reference picker and shared draft-file state`
- Commit 5 (Phase 4): `test(studio): e2e reference pickers and docs sync`

## Tasks

### Phase 0 - SDD and Contract Audit

- [x] **T0.1 - RED-free SDD freeze before code.**
  - Create `.ai-factory/specs/feature-flow-studio-reference-pickers.md`.
  - The spec must include: goals, non-goals, DSL invariants, source inference rules, schema ref normalization, state ownership decision, read-only degradation, acceptance criteria, and "no API/DB/runtime contract change" statement.
  - The state ownership section must explicitly say `LocalPackageEditor` owns one `draftFiles` array used by `PackageHome`, `FlowEditorTabs` files drawer, schema options, and package-local agent options.
  - The implementation protocol section must require RED evidence, GREEN evidence, and a refactor checkpoint for every code task.
  - Acceptance: every requirement from the pasted brief maps to either a task below or an explicit non-goal.
  - Logging requirements: no runtime logging in this docs task.
  - Files: `.ai-factory/specs/feature-flow-studio-reference-pickers.md`.
  - Verify: `pnpm validate:docs` after docs edits in T0.2.

- [x] **T0.2 - Update authoring docs only where needed.**
  - Update `docs/system-analytics/flow-studio.md` with an Implemented/Designed section for reference pickers and inline schema authoring.
  - Update `docs/screens/studio/editor.md` so "Properties / Consensus" names `Participant source` / `Synthesizer source`, grouped Runners/Agents options, forward-ref toggle, and schema ref create/edit/paste affordances.
  - Do not update `docs/api/web.openapi.yaml`, `docs/database-schema.md`, `docs/db/*.md`, or migrations unless the code plan changes to add a route or DDL.
  - Acceptance: docs state no new endpoint, no DB migration, no engine bump, no `MaisterError` code.
  - Logging requirements: no runtime logging in docs.
  - Files: `docs/system-analytics/flow-studio.md`, `docs/screens/studio/editor.md`.
  - Verify: `pnpm validate:docs`.

- [x] **T0.3 - Contract guard checklist.**
  - Before production code, run greps and record the result in the spec:
    - `rg -n "platform_acp_runners|StudioAssistantRunnersResponse" docs/api/web.openapi.yaml`
    - `rg -n "consensusParticipantSchema|consensusSynthesizerSchema|formSettingsSchema|nodeOutputSchema" web/lib/config.schema.ts`
    - `rg -n "schemaRef|participantSource|synthesizerSource|ReferenceCombobox|PackageFilesEditor|PackageHome" web docs .ai-factory`
    - `git --no-pager diff --name-only -- docs/api web/lib/db web/db docs/db`
  - Acceptance: no API/DB contract edit is required at Phase 0 HEAD; if the implementation later adds a route or DDL, stop and amend the spec first.
  - Logging requirements: no runtime logging.
  - Files: spec note only.
  - Verify: `git --no-pager diff --check`.

### Phase 1 - Shared Pure Helpers and ReferenceCombobox

- [x] **T1.1 - RED: reference source helper tests.**
  - Add failing tests in `web/lib/flows/editor/__tests__/reference-sources.test.ts`.
  - Cover:
    - `buildRunnerGroup` maps `{id,label,adapter,model,isDefault}` to group `Runners` with option `kind: "runner"` and hint text.
    - `buildAgentGroupFromFiles` maps only `maister-agents/*.md` to `<packageName>:<stem>` and ignores nested capability subagents.
    - `buildSchemaOptions` maps `schemas/review.json` to value `./schemas/review.json` and file path `schemas/review.json`.
    - `schemaRefToFilePath("./schemas/review.json")` and `schemaFilePathToRef("schemas/review.json")` round trip.
    - `deriveSchemaFileName("Review intake", existing)` produces `schemas/review-intake.json` and appends `-2` when needed.
    - `resolveFreeTextSourceKind` follows exact-match runner, exact-match agent, default runner.
    - `sourcePatchFromSelection("runner", "codex-main")` returns `{ runner: "codex-main", agent: undefined }`, and the agent case clears `runner`.
  - Verify RED: `pnpm --filter maister-web exec vitest run --project unit lib/flows/editor/__tests__/reference-sources.test.ts`.
  - Expected RED: module or exported functions do not exist.
  - Logging requirements: helper is pure and must not log.
  - Files: test only.

- [x] **T1.2 - GREEN: implement helper module.**
  - Create `web/lib/flows/editor/reference-sources.ts`.
  - Export types:
    - `ReferenceSourceKind = "runner" | "agent" | "schema"`
    - `ReferenceSourceOption = { value: string; label: string; kind: ReferenceSourceKind; hint?: string; filePath?: string }`
    - `ReferenceSourceGroup = { label: string; kind: ReferenceSourceKind; options: ReferenceSourceOption[] }`
    - `SourceSelectionPatch = { agent?: string; runner?: string }`
  - Implement the pure functions tested in T1.1.
  - Keep it client-safe: no `node:*`, DB, env, or server-only import.
  - Verify GREEN: same command as T1.1 passes.
  - Refactor: remove duplication only inside the helper; do not touch callers yet.
  - Logging requirements: pure helper, no logging.
  - Files: `web/lib/flows/editor/reference-sources.ts`.

- [x] **T1.3 - RED: combobox render and no-JS behavior tests.**
  - Add failing tests in `web/components/flows/node-form/__tests__/reference-combobox.test.ts`.
  - Cover render behavior with `renderToStaticMarkup`:
    - grouped options render with group labels and option labels;
    - `readOnly` disables input and hides clickable option buttons;
    - empty groups render `emptyHint`;
    - unknown free-text toggle labels render only when supplied by caller.
  - Cover interaction logic through exported pure helpers from T1.2, not DOM event simulation.
  - Verify RED: `pnpm --filter maister-web exec vitest run --project unit components/flows/node-form/__tests__/reference-combobox.test.ts`.
  - Expected RED: component file does not exist.
  - Logging requirements: component must not log.
  - Files: test only.

- [x] **T1.4 - GREEN: implement ReferenceCombobox.**
  - Create `web/components/flows/node-form/reference-combobox.tsx`.
  - Props:
    - `value`
    - `groups`
    - `label`
    - `placeholder`
    - `emptyHint`
    - `readOnly`
    - `testid`
    - `unknownKind`
    - `asRunnerLabel`
    - `asAgentLabel`
    - `onInputValue(value)`
    - `onSelect(value, kind)`
    - `onUnknownKindChange(kind)`
  - Render native input plus grouped inline suggestion rows. Avoid HeroUI popovers in the scrolling node sidebar.
  - Accessibility: label the input, use buttons for options, and keep read-only disabled.
  - Verify GREEN: T1.3 command passes.
  - Phase gate: `pnpm --filter maister-web exec vitest run --project unit lib/flows/editor/__tests__/reference-sources.test.ts components/flows/node-form/__tests__/reference-combobox.test.ts`.
  - Logging requirements: no client logging.
  - Files: `web/components/flows/node-form/reference-combobox.tsx`.

### Phase 2 - Consensus Participant and Synthesizer Source Picker

- [x] **T2.1 - RED: NodeSideForm consensus picker tests.**
  - Update `web/components/flows/node-form/__tests__/node-side-form.test.ts`.
  - Change expectations from old testids:
    - remove `node-consensus-participant-agent-*`
    - remove `node-consensus-participant-runner-*`
    - add `node-consensus-participant-source-*`
    - add `node-consensus-synthesizer-source`
  - Add tests that render with `participantSources` and verify both Runners and Agents labels are present.
  - Add pure helper assertions using `sourcePatchFromSelection` that selecting runner clears agent and selecting agent clears runner, then parse the emitted object through `flowYamlV1Schema`.
  - Verify RED: `pnpm --filter maister-web exec vitest run --project unit components/flows/node-form/__tests__/node-side-form.test.ts`.
  - Expected RED: props/labels/testids do not exist yet.
  - Logging requirements: component behavior must not log.
  - Files: test only.

- [x] **T2.2 - GREEN: replace consensus text-field pairs.**
  - Edit `web/components/flows/node-form/node-side-form.tsx`.
  - Add optional prop `participantSources?: ReferenceSourceGroup[]`.
  - Extend `ConsensusFormLabels` with:
    - `participantSource`
    - `synthesizerSource`
    - `runnersGroup`
    - `agentsGroup`
    - `sourcePlaceholder`
    - `sourceEmptyHint`
    - `asRunner`
    - `asAgent`
  - Replace each participant `agent`/`runner` pair with one `ReferenceCombobox`.
  - Replace synthesizer `agent`/`runner` pair with one `ReferenceCombobox`.
  - Current value is `runner ?? agent ?? ""`; matched known option shows its label via the combobox list while the stored value remains the id.
  - Free-text calls the existing exclusive setters using the inference rule; unmatched values default to runner unless the inline toggle says agent.
  - Preserve participant `id`, material axes, rounds, and remove/add controls unchanged.
  - Verify GREEN: T2.1 command passes.
  - Logging requirements: no client logging.
  - Files: `web/components/flows/node-form/node-side-form.tsx`.

- [x] **T2.3 - RED: label and prop plumbing tests.**
  - Update label builder tests or static render expectations to fail until labels are wired.
  - Add assertions that EN and RU catalogs contain all new `flowEditor.nodeForm.consensus.*` keys.
  - Verify RED:
    - `pnpm --filter maister-web exec vitest run --project unit components/flows/node-form/__tests__/node-side-form.test.ts`
    - `pnpm --filter maister-web exec vitest run --project unit lib/flows/editor/__tests__/reference-sources.test.ts`
  - Expected RED: missing labels/prop threading.
  - Logging requirements: no runtime logging.
  - Files: tests and message catalogs after GREEN.

- [x] **T2.4 - GREEN: thread participant sources from LocalPackageEditor.**
  - Edit `web/lib/flows/node-side-form-labels.ts`, `web/messages/en.json`, and `web/messages/ru.json`.
  - Edit `web/components/flows/flow-graph-editor.tsx` and `web/components/flows/flow-editor-tabs.tsx` to accept and pass `participantSources`.
  - Edit `web/components/studio/local-package-editor.tsx`:
    - fetch `/api/studio/local-packages/${packageId}/assistant/runners` once on mount;
    - on failure, keep an empty runners group and preserve free-text behavior;
    - build Runners group with `buildRunnerGroup`;
    - build Agents group with `buildAgentGroupFromFiles(files, identity.project)` until Phase 3 lifts `draftFiles`; after Phase 3, this must use `draftFiles`.
    - pass combined groups to `FlowEditorTabs`.
  - Do not fetch in `FlowNodeInspector` or the read-only package viewer.
  - Remove old consensus agent/runner labels only after `rg` confirms no remaining references.
  - Verify GREEN:
    - `pnpm --filter maister-web exec vitest run --project unit components/flows/node-form/__tests__/node-side-form.test.ts`
    - `pnpm --filter maister-web typecheck`
  - Logging requirements: route already logs debug for runner count; client fetch must not log secrets or console errors.
  - Files: `node-side-form.tsx`, `node-side-form-labels.ts`, `flow-graph-editor.tsx`, `flow-editor-tabs.tsx`, `local-package-editor.tsx`, `web/messages/en.json`, `web/messages/ru.json`.

### Phase 3 - Schema Reference Picker and Shared Draft Files

- [x] **T3.1 - RED: package-file draft helper and controlled render tests.**
  - Add failing pure tests in `web/lib/flows/editor/__tests__/package-files-draft.test.ts`.
  - Cover:
    - `upsertPackageFile(files, "schemas/review.json", content)` appends a schema file with inferred kind and does not mutate `files`;
    - the same upsert replaces content for an existing path without duplicating it;
    - `removePackageFile` and `renamePackageFilePath` return new arrays and preserve inferred kinds;
    - `replacePackageFileContent` updates only the targeted file;
    - `packageFilesToSubmitValue(files)` serializes exactly the array that should feed `packageFilesJson`.
  - Update `web/components/flows/__tests__/package-files-editor.test.ts`.
  - Add static-render assertions for both modes:
    - uncontrolled mode preserves current behavior and hidden `packageFilesJson`;
    - controlled mode renders the hidden `packageFilesJson` from the `files` prop and exposes the same file tree.
  - Do not try to simulate click callbacks in Node/static-render unit tests; callback behavior is covered through pure helper tests plus T4.1 E2E.
  - Verify RED: `pnpm --filter maister-web exec vitest run --project unit lib/flows/editor/__tests__/package-files-draft.test.ts components/flows/__tests__/package-files-editor.test.ts`.
  - Expected RED: helper module and controlled prop do not exist.
  - Logging requirements: component must not log.
  - Files: test only.

- [x] **T3.2 - GREEN: lift package file draft state.**
  - Create `web/lib/flows/editor/package-files-draft.ts` with the pure functions from T3.1.
  - Edit `web/components/flows/package-files-editor.tsx` so `onFilesChange?: (files: AuthoredFlowPackageFile[]) => void` makes the editor controlled:
    - `effectiveFiles = onFilesChange ? files : draftFiles`;
    - every add/remove/rename/content edit computes the next array with `package-files-draft.ts`;
    - controlled mode calls `onFilesChange(next)`;
    - uncontrolled mode updates internal state and keeps current authored-flow behavior.
  - Preserve uncontrolled internal state for the authored-flow mount at `web/app/(app)/flows/[projectSlug]/[capId]/page.tsx`.
  - Edit `web/components/studio/local-package-editor.tsx`:
    - own `draftFiles` state seeded from `files`;
    - when `files` changes after a successful save/refresh and there is no package-file dirty state, reset `draftFiles` to the fresh server files;
    - pass `draftFiles` and `setDraftFiles` into both `PackageHome` and the `FlowEditorTabs` files drawer;
    - build `schemaFiles` from `draftFiles`;
    - rebuild package-local agent groups from `draftFiles` so newly added `maister-agents/*.md` files can be selected before Save;
    - implement `onWriteSchemaFile(path, content)` as an upsert into `draftFiles`;
    - make `saveAction` diff against `originalRef.current` and submitted controlled `packageFilesJson` as today.
  - Edit `web/components/studio/package-home.tsx` to accept optional `onFilesChange` and pass it through to `PackageFilesEditor`; the flow-link list should derive from the controlled `files` prop.
  - Keep the `FlowEditorTabs` files drawer mounted so its hidden `packageFilesJson` remains part of the save form.
  - Verify GREEN:
    - T3.1 command passes.
    - `pnpm --filter maister-web typecheck`.
  - Logging requirements: no client logging. Save path keeps existing fetch behavior.
  - Files: `web/lib/flows/editor/package-files-draft.ts`, `package-files-editor.tsx`, `local-package-editor.tsx`, `package-home.tsx`.

- [x] **T3.3 - RED: schema ref action helper and static field tests.**
  - Add failing pure tests in `web/lib/flows/editor/__tests__/schema-ref-actions.test.ts`.
  - Cover:
    - `buildSchemaWriteFromTitle("Review intake", existing, content)` validates content with `parseFormSchemaJson`, returns path `schemas/review-intake.json`, ref `./schemas/review-intake.json`, and stable content;
    - collision appends `-2`;
    - editing an existing ref reuses `schemas/<name>.json`;
    - invalid JSON returns an error and no write intent;
    - a JSON document that parses but violates `formSchemaSchema` returns an error and no write intent.
  - Add `web/components/flows/node-form/__tests__/schema-ref-field.test.ts`.
  - Cover:
    - static markup shows existing schema options and keeps the input testid supplied by the caller;
    - inline create/edit affordance labels render only when `schemaFiles` and `onWriteSchemaFile` are present;
    - read-only mode disables the input and hides create/edit actions;
    - an initial validation error prop renders an inline `role="alert"`.
  - Do not unit-test click callbacks with `renderToStaticMarkup`; T4.1 covers the real create/edit/paste browser path.
  - Verify RED: `pnpm --filter maister-web exec vitest run --project unit lib/flows/editor/__tests__/schema-ref-actions.test.ts components/flows/node-form/__tests__/schema-ref-field.test.ts`.
  - Expected RED: helper/component files do not exist.
  - Logging requirements: component must not log.
  - Files: test only.

- [x] **T3.4 - GREEN: implement SchemaRefField.**
  - Create `web/lib/flows/editor/schema-ref-actions.ts`.
  - Create `web/components/flows/node-form/schema-ref-field.tsx`.
  - Compose `ReferenceCombobox`, `FormSchemaBuilder`, and a paste textarea; event handlers call `schema-ref-actions.ts`.
  - Validate all created/pasted/edited JSON with `parseFormSchemaJson` before writing through `onWriteSchemaFile`.
  - Derive the file path with `deriveSchemaFileName`; write file path without leading `./`, store ref with leading `./`.
  - Use a compact inline panel or modal inside the right properties panel; avoid nested card styling.
  - Verify GREEN: T3.3 command passes.
  - Logging requirements: no client logging; validation errors render inline with `role="alert"`.
  - Files: `web/lib/flows/editor/schema-ref-actions.ts`, `schema-ref-field.tsx`.

- [x] **T3.5 - RED: schema refs in NodeSideForm.**
  - Update `web/components/flows/node-form/__tests__/node-side-form.test.ts`.
  - Existing form-node test still expects `node-form-schema`; output schema test still expects `node-output-schema`.
  - Add assertions that both fields render schema picker labels/options when `schemaFiles` is passed.
  - Add assertion that `hasOutputResult` behavior remains true when the value is a string ref.
  - Verify RED: `pnpm --filter maister-web exec vitest run --project unit components/flows/node-form/__tests__/node-side-form.test.ts`.
  - Expected RED: new schema props are not plumbed.
  - Logging requirements: no runtime logging.
  - Files: test only.

- [x] **T3.6 - GREEN: replace raw schema path fields.**
  - Edit `web/components/flows/node-form/node-side-form.tsx`:
    - add optional props `schemaFiles?: { path: string; content: string }[]` and `onWriteSchemaFile?: (path: string, content: string) => void`;
    - replace `settings.form_schema` `TextField` with `SchemaRefField`;
    - replace `output.result.schema` `TextField` with `SchemaRefField`;
    - keep the same testids `node-form-schema` and `node-output-schema` so existing E2E selectors can migrate minimally;
    - write only strings through `setSetting("form_schema", v)` and `setResult({ schema: v })`.
  - Thread the props through `FlowGraphEditor` and `FlowEditorTabs`.
  - Pass schema props from `LocalPackageEditor`, deriving options from the shared `draftFiles` state introduced in T3.2.
  - Extend labels in `NodeSideFormLabels` with `schemaRef` group and add EN/RU messages.
  - Verify GREEN:
    - `pnpm --filter maister-web exec vitest run --project unit components/flows/node-form/__tests__/node-side-form.test.ts components/flows/node-form/__tests__/schema-ref-field.test.ts`
    - `pnpm --filter maister-web typecheck`
  - Logging requirements: no client logging.
  - Files: `node-side-form.tsx`, `schema-ref-field.tsx`, `flow-graph-editor.tsx`, `flow-editor-tabs.tsx`, `local-package-editor.tsx`, `node-side-form-labels.ts`, `web/messages/en.json`, `web/messages/ru.json`.

### Phase 4 - Integrated Verification, Docs, and Cleanup

- [x] **T4.1 - RED: integrated E2E coverage.**
  - Extend `web/e2e/studio-local-edit.spec.ts` or the smallest existing Studio editor spec.
  - Cover one local package editor scenario:
    - participant source selects a runner from Runners and saves as `runner`;
    - participant source selects a package-local agent from `maister-agents/*.md` and saves as `agent`;
    - unmatched free-text can be toggled as agent;
    - create schema writes `schemas/<name>.json`, sets `./schemas/<name>.json`, saves, and the Files drawer shows the new schema file after reload.
    - after schema creation, navigating back to the package-home view still shows the same new schema file because `PackageHome` and the flow files drawer share `draftFiles`.
  - Verify RED: `pnpm --filter maister-web exec playwright test e2e/studio-local-edit.spec.ts`.
  - Expected RED: UI controls do not exist before implementation.
  - Logging requirements: E2E should not depend on console output.
  - Files: E2E test only.

- [x] **T4.2 - GREEN: finish UI edge cases found by E2E.**
  - Fix any spacing, focus, or scroll issues exposed by the E2E.
  - Keep controls compact inside the right properties panel; no floating card inside card.
  - Ensure mobile/sidebar text does not overflow its controls.
  - Verify GREEN:
    - `pnpm --filter maister-web exec playwright test e2e/studio-local-edit.spec.ts`
    - `pnpm --filter maister-web exec playwright test e2e/flow-package-viewer.spec.ts`
  - Logging requirements: no client logging.
  - Files: only UI files touched by prior phases.

- [x] **T4.3 - Docs and dead-label cleanup.**
  - Update docs from T0.2 to final "Implemented" wording if they were initially marked Designed.
  - Remove old camelCase consensus agent/runner labels and i18n keys only if `rg` proves they are unused.
  - Acceptance: EN/RU message keys are complete and no stale consensus field names remain in active docs.
  - Verify:
    - `pnpm validate:docs`
    - `rg -n "participant(Agent|Runner)|synthesizer(Agent|Runner)" web docs .ai-factory`
  - Logging requirements: no runtime logging.
  - Files: docs and i18n only.

- [x] **T4.4 - Full quality gate.**
  - Run:
    - `pnpm --filter maister-web typecheck`
    - `pnpm --filter maister-web test:unit`
    - `pnpm --filter maister-web test:integration`
    - `pnpm validate:docs`
    - `git --no-pager diff --check`
  - Run E2E scope:
    - `pnpm --filter maister-web exec playwright test e2e/studio-local-edit.spec.ts e2e/m38-decide-routing.spec.ts e2e/flow-package-viewer.spec.ts`
  - Acceptance:
    - all new tests were observed RED before implementation and GREEN after;
    - no API, DB migration, env var, `MaisterError`, or engine bump was introduced;
    - all modified files follow existing import order and strict TypeScript conventions.
  - Logging requirements: no new noisy runtime logs; no secrets in logs.
  - Files: no planned edits unless a verification failure identifies a real defect.

## Acceptance Criteria
- Consensus participant and synthesizer authoring uses one source picker per slot.
- Selecting a known runner writes `runner` and clears `agent`.
- Selecting a known package-local agent writes `agent` and clears `runner`.
- Unmatched free-text defaults to runner but offers a visible `as agent` toggle.
- Known runner and agent ids are inferred without showing the toggle.
- The read-only package viewer never fetches source options and remains read-only.
- Existing schema files under `schemas/*.json` are selectable for `form_schema` and `output.result.schema`.
- Creating/pasting/editing a schema validates against `formSchemaSchema` before adding/updating the package file.
- Schema writes update the shared package draft state and persist only through the existing Save path.
- The package-home file editor and the flow editor files drawer read/write the same local package draft during an edit session.
- The saved manifest stores `./schemas/<name>.json`; the package file path is `schemas/<name>.json`.
- `output.result.schema` remains a string, so the M38 routing panel gate still works.
- No new API route, OpenAPI change, DB migration, AsyncAPI event, engine bump, deployment wiring, or `MaisterError` code lands for this feature.
- EN and RU labels cover every new visible control.
- Unit, integration, docs, typecheck, diff-check, and scoped E2E gates are green.

## Risks and Mitigations
- **PackageFilesEditor state lift.** Mitigate by keeping uncontrolled mode as default and adding focused controlled/uncontrolled tests.
- **Two editor mounts drifting.** Mitigate by routing both `PackageHome` and the flow files drawer through `LocalPackageEditor.draftFiles`, and proving it in E2E.
- **Agent id prefix drift.** Mitigate by deriving agents from `identity.project`, which `/studio/edit` passes as `pkg.name`, and by testing `<packageName>:<stem>`.
- **Combobox scroll/popup brittleness.** Mitigate by using a native input plus inline suggestion rows, not a popover.
- **Free-text mistagging.** Mitigate with exact known-id inference and the unmatched-value toggle.
- **Trivial test overlap.** Avoid duplicating generic `planWorkingDirWrites` tests; cover schema persistence in the integrated editor path instead.
- **Docs drift.** Phase 0 freezes the spec and docs before code; Phase 4 flips final wording and validates docs.

## Completeness Review
- SDD-first: T0.1 creates the spec before code; T0.2/T0.3 audit docs, API, DB, and migration surfaces before implementation.
- API contracts: Contract Surface Trace and T0.3 assert no OpenAPI change unless a new route or shape appears.
- DB migrations: Contract Surface Trace and T4.4 assert no Drizzle migration, table, column, index, or DB docs change.
- System analytics: T0.2 updates `flow-studio.md` because the authoring process changes; no new system-analytics file is needed.
- TDD: every behavior phase has RED and GREEN tasks with exact commands and expected failure reasons.
- Edge cases: unknown free text, exact id inference, read-only viewer, fetch failure, invalid pasted JSON, schema filename collisions, and controlled/uncontrolled file state are covered.
- Unit-test feasibility: component tests stay static-render safe; reducer/action helpers and scoped E2E cover state transitions and callbacks that static render cannot drive.
- Minimum-overlap tests: pure helpers cover transformations, component tests cover render/state ownership, E2E covers the integrated save/reopen path.
- Acceptance criteria: each target behavior in the pasted brief maps to a task and a final acceptance bullet.
- Logical holes checked: no out-of-band schema write, no admin-only agent route reuse, no `output.result.schema` type change, no platform catalog scope creep.
