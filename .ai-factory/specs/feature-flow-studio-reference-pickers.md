# SDD Spec (FROZEN) - Flow Studio Reference Pickers

> **Status:** Implemented / SDD baseline. This document is the single source of
> truth for the Flow Studio reference-picker behavior. Every behavioral
> deviation requires amending this spec before production code changes.
>
> Plan: [`.ai-factory/plans/feature-flow-studio-reference-pickers.md`](../plans/feature-flow-studio-reference-pickers.md)
> Branch: `feature/flow-studio-reference-pickers`
> Primary surface: `/studio/edit/{localPackageId}/[[...path]]`
>
> Contract summary: no Flow DSL shape change, no new route, no OpenAPI change,
> no DB migration, no AsyncAPI event, no engine bump, no deployment wiring, and
> no new `MaisterError` code. The only intentional docs-contract updates are
> Flow Studio system analytics and the Studio editor screen reference.

---

## 1. Goals

Flow Studio local-package authoring must stop asking users to memorize raw
reference strings for routine authoring while preserving the existing manifest
shapes and save path.

This feature adds:

1. One source picker for each `consensus.participants[]` source slot.
2. One source picker for `consensus.synthesizer`.
3. One schema reference picker for `settings.form_schema` on `form` nodes.
4. One schema reference picker for `output.result.schema`.
5. Inline create, paste, and edit affordances for `schemas/*.json` files, saved
   through the existing local-package Save path.

The authoring UX improves, but the resulting YAML stays compatible with the
current `flowYamlV1Schema`.

## 2. Non-goals

- No Flow DSL migration and no schema-version bump.
- No runtime engine change.
- No new HTTP route for runners, agents, or schema files.
- No platform-wide agent catalog in this picker.
- No use of admin-only `GET /api/admin/agents` from the member editor.
- No immediate out-of-band `PUT /api/studio/local-packages/{id}/files/{path}`
  when creating a schema; schema file changes wait for Save.
- No DB table, column, index, Drizzle migration, or DB docs update.
- No AsyncAPI/SSE event, env var, sidecar, port, package dependency, or compose
  change.
- No new `MaisterError` code.

## 3. Current Ground Truth

- `web/lib/config.schema.ts` already enforces exactly one of `agent` or
  `runner` for `consensusParticipantSchema` and
  `consensusSynthesizerSchema`.
- `runner` means a direct ACP runner id in `platform_acp_runners`.
- `agent` means a package/platform md-agent definition id such as
  `<packageName>:<stem>`.
- `web/components/flows/node-form/node-side-form.tsx` currently renders
  separate `agent` and `runner` text fields for consensus participants and
  synthesizer.
- `settings.form_schema` and `output.result.schema` are currently raw string
  text fields in `NodeSideForm`.
- `GET /api/studio/local-packages/{id}/assistant/runners` already exists,
  is member-gated, and is documented in `docs/api/web.openapi.yaml` as
  `StudioAssistantRunnersResponse`.
- Local package platform agents are package-owned files at
  `maister-agents/<stem>.md`; registry ids use `<packageName>:<stem>`.
- `/studio/edit` passes `identity.project = pkg.name`, which is the package
  name needed for package-local agent ids.
- `PackageFilesEditor` currently owns `draftFiles` internally and emits the
  `packageFilesJson` hidden input consumed by `LocalPackageEditor.saveAction`.
- `PackageHome` and the flow editor files drawer each mount
  `PackageFilesEditor`; they must not drift after `draftFiles` is lifted.
- `FormSchemaBuilder` already edits and validates `formSchemaSchema` JSON
  documents, but it does not own persistence.

## 4. DSL Invariants

The stored manifest shape is unchanged:

```yaml
nodes:
  - id: gather_consensus
    type: consensus
    participants:
      - id: codex
        runner: codex-main
      - id: reviewer
        agent: aif:reviewer
    synthesizer:
      runner: claude-main
  - id: collect_input
    type: form
    settings:
      form_schema: ./schemas/intake.json
    output:
      result:
        schema: ./schemas/result.json
```

Required invariants:

1. A consensus participant stores exactly one of `agent` or `runner`.
2. A consensus synthesizer stores exactly one of `agent` or `runner`.
3. Selecting a runner clears any previously stored `agent`.
4. Selecting an agent clears any previously stored `runner`.
5. The displayed current source is `runner ?? agent ?? ""`.
6. `settings.form_schema` remains a string.
7. `output.result.schema` remains a string, so the M38 routing panel gate still
   treats the node as having an output result.
8. Manifest schema refs are written as `./schemas/<name>.json`.
9. Package file paths are stored as `schemas/<name>.json` without leading `./`.

## 5. Source Picker Contract

### 5.1 Option groups

Source options are grouped into:

- **Runners** - built from
  `GET /api/studio/local-packages/{id}/assistant/runners`, whose items expose
  `{ id, label, adapter, model, isDefault }`.
- **Agents** - derived client-side from the current local package draft files.
  Only root package platform-agent files matching `maister-agents/*.md` become
  agent options. Nested capability subagents such as
  `capability/<id>/agents/*.md` are ignored.

Each option carries:

```ts
type ReferenceSourceKind = "runner" | "agent" | "schema";
type ReferenceSourceOption = {
  value: string;
  label: string;
  kind: ReferenceSourceKind;
  hint?: string;
  filePath?: string;
};
```

### 5.2 Free-text inference

Free text remains available for forward refs and custom ids.

When the typed value is not selected from the list:

1. If it exactly matches a known runner id, write `runner`.
2. If it exactly matches a known agent id, write `agent`.
3. Otherwise default to `runner` and show an inline `as runner` / `as agent`
   toggle for that unmatched value only.

Known ids do not show the toggle because the kind is unambiguous.

### 5.3 Read-only and fetch behavior

`NodeSideForm`, `FlowGraphEditor`, and read-only viewer mounts never fetch source
options themselves. `LocalPackageEditor` fetches runner options once and threads
plain-data groups through the editor. When no groups are passed, the control
degrades to the existing read-only/free-text display.

## 6. Schema Reference Contract

### 6.1 Existing schema options

Schema options are derived from draft package files:

- file path `schemas/review.json`
- option value `./schemas/review.json`
- option file path `schemas/review.json`
- option kind `schema`

Only `schemas/*.json` is included.

### 6.2 Creating, pasting, and editing schemas

Schema creation and editing use `FormSchemaBuilder` and
`parseFormSchemaJson`.

Required behavior:

1. Create asks for a name, derives a safe kebab-case filename, appends `.json`,
   and writes under `schemas/`.
2. Name collisions append a numeric suffix such as `-2`.
3. Paste validates JSON syntax and `formSchemaSchema` before writing.
4. Edit reuses the existing file path for the current ref.
5. Invalid JSON or invalid form-schema shape renders an inline alert and does
   not call the writer.
6. When `schemaFiles` or `onWriteSchemaFile` is absent, create/edit affordances
   are hidden and free-text remains.

Client-side validation is UX only. Runtime validation at the existing config
seam remains authoritative.

## 7. State Ownership

`LocalPackageEditor` owns one shared `draftFiles` array for a local package edit
session.

That same `draftFiles` value must feed:

- `PackageHome`.
- The `FlowEditorTabs` files drawer.
- Package-local agent options.
- Schema reference options.
- `onWriteSchemaFile(path, content)`.
- The `packageFilesJson` hidden input submitted by the existing Save form.

The schema writer only mutates the shared draft array. It does not call the
files API directly and does not persist until the user saves.

`PackageFilesEditor` keeps uncontrolled behavior for existing authored-flow
mounts. In controlled mode it renders from `files`, sends all edits through
`onFilesChange(next)`, and keeps the hidden `packageFilesJson` value aligned
with the controlled data.

## 8. Contract Surface Trace

| Surface | Change | Required action |
| --- | --- | --- |
| Flow DSL / Zod manifest shape | No shape change | Tests prove emitted consensus and schema refs still parse under `flowYamlV1Schema`. |
| HTTP API / OpenAPI | No route or response shape change | Reuse `/api/studio/local-packages/{id}/assistant/runners`; no OpenAPI edit. |
| DB / Drizzle migrations | No | No migration and no DB docs edit. |
| AsyncAPI / SSE | No | No event change. |
| `MaisterError` taxonomy | No | No new code. |
| System analytics | Yes | Update `docs/system-analytics/flow-studio.md` for the authoring process delta. |
| Screen reference | Yes | Update `docs/screens/studio/editor.md` for visible controls. |
| i18n | Yes | Add EN/RU labels for every new visible control. |
| Deployment | No | No env, compose, port, sidecar, or package change. |

If implementation later introduces a route, response shape, DB change, env var,
or error code, stop and amend this spec before code continues.

## 9. Implementation Protocol

Implementation after Phase 0 is strict TDD.

For each code task:

1. Write the smallest failing test that describes the required behavior.
2. Run it and record RED evidence in the task notes or terminal transcript.
3. Implement the minimum production code needed for GREEN.
4. Run the exact test and record GREEN evidence.
5. Refactor only inside the touched feature surface while keeping tests green.
6. Do not move to the next task until the task verification command is green.

The docs-only Phase 0 tasks are RED-free because they freeze specification and
documentation before production code.

## 10. Test Coverage Requirements

Tests must cover required behavior with minimal overlap.

Required layers:

- Pure helpers: source classification, agent derivation, schema ref/path
  normalization, filename derivation, source patches, package-file draft
  transforms, and schema write intents.
- Static component tests: markup, labels, read-only state, and hidden input
  values under Node `renderToStaticMarkup`.
- Node form tests: source picker testids, schema picker testids, and emitted
  manifest parseability.
- E2E: one real local-package authoring path for runner selection, package-agent
  selection, free-text agent toggle, schema creation, save, reload, and package
  home/files drawer shared draft behavior.

Do not add tests that only assert implementation details or duplicate coverage
from another layer.

## 11. Requirements Trace

| Requirement | Spec section | Plan task |
| --- | --- | --- |
| One participant/synthesizer source control | 5 | T1.1-T2.4 |
| Runner options from existing member route | 5.1, 8 | T1.1, T2.4, T0.3 |
| Package-local agents from `maister-agents/*.md` | 5.1 | T1.1, T2.4, T3.2 |
| Free-text inference and toggle | 5.2 | T1.1, T2.1-T2.2 |
| Read-only viewer does not fetch | 5.3 | T2.4, T4.1-T4.2 |
| Existing schema refs selectable | 6.1 | T1.1, T3.5-T3.6 |
| Create/paste/edit schema files | 6.2 | T3.3-T3.6, T4.1 |
| Shared draft files across package home and flow editor | 7 | T3.1-T3.2, T4.1 |
| API/DB/contracts only if needed | 8 | T0.3, T4.4 |
| TDD implementation | 9 | T1.1-T4.4 |

## 12. Acceptance Criteria

- Consensus participant and synthesizer authoring uses one source picker per
  slot.
- Selecting a known runner writes `runner` and clears `agent`.
- Selecting a known package-local agent writes `agent` and clears `runner`.
- Unmatched free text defaults to runner and exposes an `as agent` toggle.
- Known runner and agent ids are inferred without showing the toggle.
- The read-only package viewer never fetches source options.
- Existing `schemas/*.json` files are selectable for `settings.form_schema` and
  `output.result.schema`.
- Creating, pasting, and editing schemas validates with `formSchemaSchema`
  before mutating the draft file set.
- Schema writes update shared local-package draft state and persist only through
  the existing Save path.
- Package home and the flow editor files drawer read/write the same draft files.
- Saved manifests store `./schemas/<name>.json`; package file paths remain
  `schemas/<name>.json`.
- `output.result.schema` remains a string.
- No new API route, OpenAPI change, DB migration, AsyncAPI event, engine bump,
  deployment wiring, or `MaisterError` code lands for this feature.
- EN and RU labels cover every new visible control.
- Unit, integration, docs, typecheck, diff-check, and scoped E2E gates are
  green.

## 13. Phase 0 Contract Guard Results

T0.3 contract guard confirms this feature remains an authoring-only UI/data
flow change:

- `docs/api/web.openapi.yaml` already documents
  `GET /api/studio/local-packages/{id}/assistant/runners` through
  `StudioAssistantRunnersResponse`; no OpenAPI edit is needed.
- `web/lib/config.schema.ts` already owns the persisted DSL contracts through
  `consensusParticipantSchema`, `consensusSynthesizerSchema`,
  `formSettingsSchema`, and `nodeOutputSchema`; no DSL shape edit is needed.
- Reference-picker terms are currently limited to this spec, the plan, docs, and
  existing package editor component names; no production `ReferenceCombobox`
  exists before Phase 1 RED tests.
- `git --no-pager diff --name-only -- docs/api web/lib/db web/db docs/db`
  returns no files; no API contract, DB schema, migration, or DB docs edit is
  present.
- `git --no-pager diff --check` returns clean after the Phase 0 changes.
