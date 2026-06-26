# Implementation Plan — Flow Studio Node-Editor Reference Pickers (Parts A & B)

> Handoff deliverable. Authored 2026-06-26 to be executed in a separate session.
> Covers the two "structured-output / reference" reworks discussed alongside the
> AI-dock UI fixes: (A) consensus participant/synthesizer source picker, and
> (B) structured-output schema reference picker + inline editor. The UI-dock
> work (AI assistant dock recomposition, editor 3-column layout, minimap
> collapse) is a SEPARATE change and not covered here.

## 0. Context & where this runs

The Flow Studio node editor is `web/components/flows/node-form/node-side-form.tsx` (`NodeSideForm`, `"use client"`). It renders a per-node property form for the typed-node graph DSL (`FlowYamlV1`). It is mounted in **two** distinct contexts:

1. **Editable** — `web/components/flows/flow-graph-editor.tsx` (`FlowGraphEditor`) mounts `NodeSideForm` in its right sidebar (line 653-667), passing `onChange={handleNodeFormChange}` + `onPresentationChange`. `FlowGraphEditor` is itself mounted (client-only via `next/dynamic`, `ssr:false`) by `web/components/flows/flow-editor-tabs.tsx` (`FlowEditorTabs`, line 264-273), which is mounted by `web/components/studio/local-package-editor.tsx` (`LocalPackageEditor`, line 579-620). This is the live **local-package** authoring editor at route `/studio/edit` (M36/M39). It runs at **member** RBAC (`requireActiveSession` / `requireGlobalRole("member")` — see `web/lib/scratch-runs/service.ts:1412`), project-less.
2. **Read-only** — `web/components/studio/flow-node-inspector.tsx` (`FlowNodeInspector`) mounts `NodeSideForm` with `readOnly` (line 54-59), used by the package **viewer** (`web/app/(app)/studio/packages/[ref]/flows/[flowId]/page.tsx`). No edits happen here; both Parts must remain byte-identical no-ops in `readOnly` mode.

**Critical architectural finding (drives Part B):** Inside `FlowEditorTabs`, the canvas (`FlowGraphEditor`, owning the flow's YAML via the hidden `name="flowYaml"` input, line 227) and the `PackageFilesEditor` (owning every package file via the hidden `name="packageFilesJson"` input, `package-files-editor.tsx:167`) are **sibling components that share no state**. The list of `schemas/*.json` files lives only in `PackageFilesEditor`'s `files` prop. To give the node form a schema picker, the file list (and a "create/update file" capability) must be **threaded down from `LocalPackageEditor`** (which already holds `files: AuthoredFlowPackageFile[]`, line 173) through `FlowEditorTabs` → `FlowGraphEditor` → `NodeSideForm`. `NodeSideForm` today receives only label/data props; both parts require new optional props plumbed through the same two intermediaries.

**Labels:** all `NodeSideForm` labels are built once in `web/lib/flows/node-side-form-labels.ts` (`buildNodeSideFormLabels`) from the `flowEditor` next-intl namespace. Both the editable and read-only mounts call it. New i18n keys go under `flowEditor.nodeForm.*` in `web/messages/en.json` and `web/messages/ru.json` (the `flowEditor` block starts at en.json:2631; `nodeForm.consensus` at ~2711).

---

## What is intentionally NOT changed (read this first)

- **Data model / migrations:** NONE. No Drizzle schema change, no migration. Participant `runner`/`agent` and schema `form_schema`/`output.result.schema` stay exactly the stored shapes (`string`).
- **Flow grammar / Zod (`web/lib/config.schema.ts`):** UNCHANGED. `consensusParticipantSchema` (line 967, exactly-one-of `agent|runner` superRefine), `consensusSynthesizerSchema` (line 990), `nodeOutputSchema.result.schema` (line 553, `z.string().min(1)`), `formSettingsSchema.form_schema` (line 831, `z.string().min(1)`) and `formSchemaSchema` (line 1258) all stay. The picker writes the same string values the free-text inputs write today.
- **Flow compiler / runtime resolution (`web/lib/config.ts`):** UNCHANGED. `readAndValidateFormSchemaDoc` (line 1396) + `resolveOutputResultSchema` (line 1464) keep the realpath/traversal guard and the four `CONFIG` failure modes. Schema refs stay **relative-path strings** resolved at runtime; no inline-object schemas (explicitly rejected).
- **Save path:** UNCHANGED contract. New schema files reuse the existing `packageFilesJson` blob → `LocalPackageEditor.saveAction` → `planWorkingDirWrites` → `PUT /api/studio/local-packages/[id]/files/<path>`. No new write endpoint.
- **Availability validation at edit time:** NONE. Stale runner/agent ids and stale schema paths fail at launch with `PRECONDITION`/`CONFIG` as they do today. The pickers never block on "this id/file does not resolve".

---

## Cross-cutting design decision: one shared control

Both parts are the same shape: *reference a known catalog/file entity from a field that must still accept arbitrary strings (forward-refs, not-yet-created files)*. Recommendation: **build ONE small shared client component** `web/components/flows/node-form/reference-combobox.tsx` and reuse it for participant-source, synthesizer-source, and schema-ref. Rationale and bounds:

- `SelectField` in `node-side-form.tsx` (line 180) is a bare `<select>` and **cannot** carry a free-text escape hatch — unsuitable.
- HeroUI `Autocomplete` *can* free-solo, but the established precedent in this codebase for "known suggestions + always-valid free text" is **`web/components/settings/model-autocomplete.tsx`** which deliberately uses a **native `<input>` + clickable suggestion chips/list**, with an explicit comment (line 44-49): *"A native input is used deliberately instead of a dropdown combobox: a Popover-in-Modal combobox is brittle."* The node form sits in a scrolling sidebar/drawer with the same brittleness risk. **Follow that precedent**: the shared control = a native `<input>` (free text, always editable) + a grouped option list rendered as selectable rows/chips below it that fill the input on click, matching `FIELD_CLS`/`LABEL_CLS` styling already in `node-side-form.tsx` (line 122-127).
- Keep it surgical: one component, ~80-120 lines, grouped options (`{ groupLabel, options: { value, label, hint? }[] }[]`), `value`, `onChange`, `placeholder`, `readOnly`, `emptyHint`, `testid`. No new dependency, no abstraction beyond these two parts.

This control is the single new primitive shared by both parts.

---

## PART A — Consensus participant & synthesizer source picker

### Current state (cited)

- Each participant renders **three free-text `TextField`s**: id / agent / runner — `node-side-form.tsx:821-860` (id at 827, agent at 834, runner at 841). Synthesizer renders **two free-text `TextField`s** (agent/runner) at `node-side-form.tsx:874-889`.
- Exclusivity is already enforced by the setters: `setParticipantAgent` (line 363) sets `agent` + deletes `runner`; `setParticipantRunner` (line 375) sets `runner` + deletes `agent`; `setSynthesizerAgent` (line 409) / `setSynthesizerRunner` (line 420) mirror this for the single synthesizer object.
- Semantics confirmed in Zod: `runner` = an id in the `platform_acp_runners` catalog (a direct ACP runner: adapter/model/provider); `agent` = a platform md-based agent definition id (M34, `<packageName>:<stem>`) that resolves its own runner chain. Mutually exclusive (`consensusParticipantSchema` superRefine, line 975; `consensusSynthesizerSchema` line 996).

### Target behavior

Replace the **agent + runner** `TextField` pair (participant) and the **synthesizer agent + runner** pair with **one `ReferenceCombobox` per slot** labelled "Participant source" / "Synthesizer source". Options are grouped:
- Group **"Runners"** — from the runner catalog (always available).
- Group **"Agents"** — from the platform md-agent catalog (optional / gracefully degrading, see below).
- Free-text input is always present: typing a raw value that is not a known option keeps the existing free-text behavior (forward-ref / custom id).

**Selection → which field gets written.** The combobox must know, per option, whether it is a runner or an agent so it can call the right exclusive setter. Wire it as: each option carries `kind: "runner" | "agent"`. On select-from-list, call `setParticipantRunner(i, value)` for a runner option or `setParticipantAgent(i, value)` for an agent option (and the synthesizer equivalents). On **free-text** typing (value not matched to any option), we cannot infer kind — resolve it with this rule: **if the typed value exactly matches a known runner id → treat as runner; if it matches a known agent id → agent; otherwise default to `runner`** (runners are the common case and always-available). Keep a tiny inline toggle ("as agent / as runner") next to the free-text field ONLY when the typed value matches neither catalog, so the author can disambiguate a forward-ref. (This toggle is the minimal escape hatch; it writes via the existing setters, so exclusivity holds.) Document this in the component; do not over-build.

The current value displayed = `participant.runner ?? participant.agent ?? ""` (whichever is set); the combobox shows the matched option's label when known, else the raw string.

### Agents group — source investigation & recommendation

**Finding:** There is exactly one agents-catalog list endpoint: `GET /api/admin/agents` (`web/app/api/admin/agents/route.ts`) → `listAgents()` (`web/lib/agents/registry.ts:338`, returns all `agents` rows) mapped through `projectAgentSummary`. **It is `requireGlobalRole("admin")`-gated** (route line 17). The catalog is a projection of installed packages' `maister-agents/<stem>.md` files, keyed `<packageName>:<stem>` (registry.ts:182, ADR-106).

**Constraint:** The live editor (`LocalPackageEditor`) runs at **member** level and is **project-less** (editing a local package's working dir). So:
- The admin endpoint is **not** directly reusable from the member editor (403 for non-admins).
- "What agent set is meaningful here?" — In the project-less local-package authoring context, the most coherent answer is **the package's OWN `maister-agents/*.md` definitions** (the files the author is editing), NOT the whole platform catalog. The editor already has every package file in `files: AuthoredFlowPackageFile[]` (`local-package-editor.tsx:173`), and `classifyPackageFilePath` tags `maister-agents/*` as `agent_definition` (`web/lib/flows/editor/package-file-tree.ts:29`). The agent id is `<packageName>:<stem>` where stem = the file basename. So the Agents group can be derived **client-side, with zero new endpoint**, by listing `files` whose path starts with `maister-agents/` and ends `.md`, mapping each to `{ value: "<pkgName>:<stem>", label: "<stem>", kind: "agent" }`.

**Recommendation (phased):**
- **Phase A1 (ship first):** Runners group only (data already fetchable, see precedent). Agents stay enterable via the free-text fallback. This is the "graceful degradation" the architect required.
- **Phase A2 (optional, low-risk):** Populate the Agents group from the package's own `maister-agents/*.md` files (derived from the `files` prop already threaded down for Part B — see Part B plumbing; the two parts share the same `files` thread). This needs the package name to build `<pkgName>:<stem>`; `identity.project`/`identity.slug` are already passed to `FlowEditorTabs` (`flow-editor-tabs.tsx:86`). Confirm which of `identity.*` is the package name used by the registry's `<packageName>` (registry.ts:182 uses `packageInstalls.name`); if it is not directly available client-side, pass the package name explicitly from `LocalPackageEditor` (it has `identity.project`). Verify the exact `<packageName>` value at implementation time against a seeded package, since a wrong prefix yields ids that fail at launch.
- **Explicitly out of scope:** the full platform agent catalog in this picker (would need a new member-safe list endpoint + project scoping; not required and the architect flagged the agent wiring as "may not be ready"). If desired later, add `GET /api/studio/local-packages/[id]/assistant/agents` mirroring the existing runners route (`web/app/api/studio/local-packages/[id]/assistant/runners/route.ts`) — but only when product needs the whole catalog, not the package's own agents.

### Runners group — source (reuse the precedent)

The runner list is already fetched by the same editor area: `GET /api/studio/local-packages/[id]/assistant/runners` → `listLocalPackageAssistantRunners()` (`web/lib/scratch-runs/service.ts:1320`) returns `{ runners: { id, label, adapter, model, isDefault }[], defaultRunnerId }` (only `enabled && Ready` runners, label = `"<adapter> · <model>"`). This route is `requireGlobalRole("member")` (route line 27) — usable from this editor.

**Wiring options (recommend B):**
- (A) Fetch client-side in `NodeSideForm` — rejected: `NodeSideForm` is also the read-only viewer mount and should not fire fetches; it would fetch on every node selection.
- **(B, recommended)** Fetch ONCE in `LocalPackageEditor` (which already does several `fetch` effects, e.g. the diff effect at line 298) on mount, store `runnerOptions` in state, and thread it down as an optional prop `participantSources?: ReferenceSourceGroups` through `FlowEditorTabs` → `FlowGraphEditor` → `NodeSideForm`. When the prop is absent (the read-only viewer mount), the combobox shows free-text only. Build the groups in `LocalPackageEditor` so the read-only viewer never fetches.

### Part A — file-by-file change list

- [ ] **New:** `web/components/flows/node-form/reference-combobox.tsx` — the shared control (see cross-cutting section). Props: `{ value, onSelect(value, kind?), onFreeText(value), groups: { label, kind, options:{value,label,hint?}[] }[], placeholder, emptyHint, readOnly, testid }`. Renders native `<input>` + grouped clickable option rows. Reused by Parts A & B.
- [ ] **New:** `web/lib/flows/editor/reference-sources.ts` — pure helpers + types: `ReferenceSourceGroups`, `buildRunnerGroup(runners)`, `buildAgentGroupFromFiles(files, packageName)`, `buildSchemaOptions(files)` (Part B). Pure + unit-testable; no server-only.
- [ ] **Edit:** `web/components/flows/node-form/node-side-form.tsx`
  - Add optional props to `NodeSideForm`: `participantSources?: ReferenceSourceGroups` (Runners + optional Agents).
  - Replace participant agent/runner `TextField`s (821-847) with: keep `participantId` `TextField`, then one `ReferenceCombobox` (label = new `consensus.participantSource`). Drive it off `participant.runner ?? participant.agent`; on runner-kind select call `setParticipantRunner(index, v)`, on agent-kind call `setParticipantAgent(index, v)`, on free-text apply the kind-inference rule above.
  - Replace synthesizer agent/runner `TextField`s (874-889) with one `ReferenceCombobox` (label = new `consensus.synthesizerSource`) using `setSynthesizerRunner`/`setSynthesizerAgent`.
  - Keep all `data-testid`s stable where possible; add `node-consensus-participant-source-${index}` and `node-consensus-synthesizer-source`. Note: the existing tests reference `node-consensus-participant-agent-${index}` etc. — update those tests (Part A test plan).
  - In `readOnly` mode the combobox renders read-only (input disabled, no option list) — preserve no-op behavior.
- [ ] **Edit:** `web/components/flows/node-form/node-side-form.tsx` `ConsensusFormLabels` type (line 107): add `participantSource: string`, `synthesizerSource: string`, and combobox chrome labels (`runnersGroup`, `agentsGroup`, `asRunner`, `asAgent`, `sourcePlaceholder`, `sourceEmptyHint`). Keep `participantAgent`/`participantRunner`/`synthesizerAgent`/`synthesizerRunner` only if still referenced; otherwise remove (and remove their builder lines + i18n keys — surgical, they become dead).
- [ ] **Edit:** `web/lib/flows/node-side-form-labels.ts` — add the new consensus label keys (lines ~81-94 block).
- [ ] **Edit:** `web/components/flows/flow-graph-editor.tsx` — add optional prop `participantSources?: ReferenceSourceGroups` to `FlowGraphEditorProps` (line 78) and pass it into `<NodeSideForm>` (line 653). No other editor logic changes.
- [ ] **Edit:** `web/components/flows/flow-editor-tabs.tsx` — add optional prop `participantSources?` and pass through to `<FlowGraphEditor>` (line 265).
- [ ] **Edit:** `web/components/studio/local-package-editor.tsx` — add a `useEffect` to fetch `/api/studio/local-packages/${packageId}/assistant/runners` once on mount, store `runnerOptions` state; build `participantSources` via `buildRunnerGroup` (+ Phase A2: `buildAgentGroupFromFiles(files, packageName)`); pass `participantSources` into `<FlowEditorTabs>` (line 579). The read-only viewer page does not pass this prop → free-text only.
- [ ] **i18n:** add `flowEditor.nodeForm.consensus.participantSource`, `.synthesizerSource`, `.runnersGroup`, `.agentsGroup`, `.asRunner`, `.asAgent`, `.sourcePlaceholder`, `.sourceEmptyHint` to `web/messages/en.json` + `web/messages/ru.json`.

---

## PART B — Structured-output schema reference picker + editor

### Current state (cited)

Two ref sites, both free-text relative-path `TextField`s in `node-side-form.tsx`:
1. **`output.result.schema`** (any node) — rendered at `node-side-form.tsx:1259-1265` (`node-output-schema`, writes `setResult({ schema: v })`). Schema = `nodeOutputSchema.result.schema` (`config.schema.ts:553`, `z.string().min(1)`). Also note `hasOutputResult = typeof result.schema === "string"` (line 440) gates the routing panel — the picker must keep writing a string so that stays true.
2. **`form_schema`** (form node) — rendered at `node-side-form.tsx:762-770` (`node-form-schema`, writes `setSetting("form_schema", v)`). Schema = `formSettingsSchema.form_schema` (`config.schema.ts:831`).

Both resolve at runtime via `readAndValidateFormSchemaDoc` (`config.ts:1396`) against `formSchemaSchema` (`config.schema.ts:1258`), with the realpath traversal guard. Files physically live in the package as `schemas/*.json`.

### Reusable building blocks (confirmed)

- **`FormSchemaBuilder`** — `web/components/flows/artifact-editors/form-schema-builder.tsx`. Visual field builder + JSON CodeMirror tab + live `HitlDecisionControls` preview over a single `content` string; `onChange(nextContent)` re-emits serialized JSON. Validates via `parseFormSchemaJson` (`web/lib/flows/editor/form-schema-edit.ts`), shows an invalid-JSON banner. Self-contained, no persistence.
- **`PackageFilesEditor`** — `web/components/flows/package-files-editor.tsx`. Enumerates files from its `files` prop, classifies each via `classifyPackageFilePath` (`schemas/*.json` → `schema` kind → routes to `FormSchemaBuilder`, line 434-443), supports add/edit/rename/remove, and submits the full set via the hidden `name="packageFilesJson"` input (line 167). **Persistence is NOT here** — the blob is read by `LocalPackageEditor.saveAction` (line 327-424): `parsePackageFilesJson` → `overlayFlowBuffer` → `planWorkingDirWrites` (`web/lib/local-packages/working-dir-save.ts`) → minimal `PUT/DELETE /files/<path>` calls.
- **`CodeEditor`** — `web/components/flows/code-editor.tsx` (CodeMirror), used by `FormSchemaBuilder`'s JSON tab.

### Target behavior (architect-approved approach "A")

The schema field (both ref sites) becomes a **`ReferenceCombobox`** whose Runners-equivalent group = **existing `schemas/*.json` files in the package**, PLUS two creation affordances:

1. **"Create new schema…"** — opens `FormSchemaBuilder` inline (in a modal/inline panel within the node form), seeded empty; on save, writes a new `schemas/<derived-name>.json` file into the package and sets the field's ref to `./schemas/<name>.json`.
2. **"Paste JSON → save"** — the user pastes a JSON schema; it is validated against `formSchemaSchema`; on valid, write `schemas/<derived-name>.json` and set the ref automatically. (Implementable as: a textarea in the same inline panel with a "Validate & save" button, or a paste-detect on the combobox input. Recommend the explicit textarea+button in the inline panel — simpler, testable, avoids clipboard-permission surprises. The "Ctrl+V fast path" is satisfied by pasting into that textarea.)
3. **Editing an existing ref** — a "Edit schema" affordance next to a set value opens `FormSchemaBuilder` on that file's current content; saving rewrites the same file.

Stored value stays a **relative path string** (`./schemas/<name>.json`). Free-text remains available (type any path — forward-ref to a file not yet created). No migration, no compiler/grammar/runtime change.

### The hard part: cross-component file writes (no new endpoint)

`NodeSideForm` cannot write package files directly — persistence is owned by the `packageFilesJson` blob assembled by `PackageFilesEditor` + flushed by `LocalPackageEditor.saveAction`. Two viable mechanisms:

- **(Recommended) Lift the file list to a shared owner.** Thread two new optional props to `NodeSideForm`: `schemaFiles?: { path: string; content: string }[]` (the package's `schemas/*.json`) and `onWriteSchemaFile?: (path: string, content: string) => void`. Implement the writer in `LocalPackageEditor` by lifting `PackageFilesEditor`'s `draftFiles` state up to `LocalPackageEditor` so both the Files drawer AND the node-form schema editor mutate the **same** draft set, which still submits via the one `packageFilesJson` input. Concretely:
  - Move the `files` draft state from inside `PackageFilesEditor` up into `LocalPackageEditor` (or a thin shared context/provider scoped to the editor), passing `files` + `onFilesChange` down to `PackageFilesEditor` (it becomes controlled) and `schemaFiles` (filtered) + `onWriteSchemaFile` down through `FlowEditorTabs` → `FlowGraphEditor` → `NodeSideForm`.
  - `onWriteSchemaFile(path, content)` upserts into the shared draft set (add if new, replace content if exists). The new/changed file then flows through the **existing** save path on the next save — no new API.
  - This keeps one source of truth and one save mechanism; it is the cleanest, but it touches `PackageFilesEditor`'s state ownership. Scope the lift narrowly (only the `draftFiles`/`serialized` state, lines 103-126), preserving its hidden-input + dirty-tracking contract.
- **(Fallback, if the lift is judged too invasive)** Have `onWriteSchemaFile` immediately call `PUT /api/studio/local-packages/[id]/files/<path>` (the same endpoint `saveAction` uses) and then `router.refresh()` so the server re-reads the working dir and re-seeds `files`. This avoids the state lift but introduces an out-of-band write (a schema file is persisted before the user hits Save). Mark this clearly; prefer the lift. Given the surgical-changes mandate and that `saveAction` already batches writes, the **lift is recommended**; the fallback is documented for the implementer to choose if the lift balloons.

**Decision to record as an open question (see §Risks):** lift vs. out-of-band PUT. Both are correct; the lift is cleaner but larger. Implementer picks after sizing the `PackageFilesEditor` state change.

### Derived filename + validation

- Derive `<name>` from a user-provided name field in the inline panel, kebab-cased, `.json` appended; ensure uniqueness against existing `schemas/*` (reuse `uniqueNewPath`-style logic from `package-files-editor.tsx:638`, or a small helper in `reference-sources.ts`). Default like `schema-1.json` if empty.
- Validate pasted/created JSON against `formSchemaSchema` **client-side** before writing, reusing `parseFormSchemaJson` (`web/lib/flows/editor/form-schema-edit.ts`) — the same validator `FormSchemaBuilder` uses. Invalid → inline banner, no write. (Runtime still re-validates at the seam via `readAndValidateFormSchemaDoc`; client validation is UX only, not a security boundary.)
- The stored ref string convention: match existing flows — `./schemas/<name>.json` (the docs example uses `./schemas/review.json`). Confirm whether existing manifests store the leading `./`; the runtime resolver (`config.ts:1401`, `path.resolve(base, relPath)`) accepts both. Use `./schemas/<name>.json` for consistency with authored examples; the picker's option `value` for an existing file should match however the file path is keyed (the file's path is `schemas/<name>.json` without `./` in `AuthoredFlowPackageFile.path`) — normalize so the option value written into the manifest is `./schemas/<name>.json` while the file write path is `schemas/<name>.json`. Document this normalization explicitly in `reference-sources.ts`.

### Part B — file-by-file change list

- [ ] **Edit:** `web/components/flows/node-form/node-side-form.tsx`
  - Add optional props: `schemaFiles?: { path: string; content: string }[]`, `onWriteSchemaFile?: (path: string, content: string) => void`.
  - Replace the **output result schema** `TextField` (1259-1265) with a `ReferenceCombobox` (options = `buildSchemaOptions(schemaFiles)`; group label "Schemas") + a "Create / paste" affordance + an "Edit" affordance when a value is set. Value still written via `setResult({ schema: v })` as a string.
  - Replace the **form_schema** `TextField` (762-770) with the same control; value written via `setSetting("form_schema", v)`.
  - When `schemaFiles`/`onWriteSchemaFile` are absent (read-only viewer mount), the control degrades to free-text + (read-only) current value — no create/edit affordances. Preserve `readOnly` no-op behavior.
  - Add a new `SchemaRefField` sub-component (local to the file or a sibling under `node-form/`) that composes `ReferenceCombobox` + an inline `FormSchemaBuilder` panel (open-on-create/edit) + the paste-validate-save flow. Keep `FormSchemaBuilder` reused verbatim.
  - New labels on `NodeSideFormLabels`: a `schemaRef` group `{ pick, createNew, pasteJson, edit, save, cancel, namePlaceholder, invalidJson, schemasGroup, sourcePlaceholder, freeTextHint }`.
- [ ] **Edit:** `web/lib/flows/node-side-form-labels.ts` — add the `schemaRef` label keys.
- [ ] **Edit:** `web/lib/flows/editor/reference-sources.ts` — add `buildSchemaOptions(files)` (filter `path.startsWith("schemas/") && path.endsWith(".json")` → `{ value: "./"+path, label: path.slice("schemas/".length), kind: "schema" }`), `deriveSchemaFileName(name, existing)`, and the path↔ref normalization helpers.
- [ ] **Edit:** `web/components/flows/flow-graph-editor.tsx` — add optional props `schemaFiles?`, `onWriteSchemaFile?` to `FlowGraphEditorProps` (line 78); pass into `<NodeSideForm>` (line 653).
- [ ] **Edit:** `web/components/flows/flow-editor-tabs.tsx` — add the same optional props; pass through to `<FlowGraphEditor>` (line 265).
- [ ] **Edit:** `web/components/studio/local-package-editor.tsx` — implement the file-list lift (recommended) OR the out-of-band PUT writer (fallback). Provide `schemaFiles` (filtered from the shared draft) + `onWriteSchemaFile` and pass into `<FlowEditorTabs>` (line 579). If lifting, make `PackageFilesEditor` controlled (pass `files`+`onFilesChange`); preserve its `onDirtyChange` + hidden-input contract.
- [ ] **Edit (only if lifting):** `web/components/flows/package-files-editor.tsx` — accept `files` + `onFilesChange` as controlled props (keep current internal-state behavior as the default when uncontrolled, to avoid breaking the authored-flow mount in `flows/actions.ts`). Keep `packageFilesJson` hidden input + dirty effect intact.
- [ ] **i18n:** add `flowEditor.nodeForm.schemaRef.*` to `web/messages/en.json` + `web/messages/ru.json`.

---

## Phased execution

### Phase 0 — Shared primitive & pure helpers (no behavior change)
- [ ] Add `web/lib/flows/editor/reference-sources.ts` (types + `buildRunnerGroup`, `buildAgentGroupFromFiles`, `buildSchemaOptions`, `deriveSchemaFileName`, ref↔path normalization).
- [ ] Add `web/components/flows/node-form/reference-combobox.tsx`.
- [ ] Unit tests for the helpers and the combobox (see Test plan).
- **Verify:** `pnpm --filter maister-web typecheck`; new unit tests green; nothing else changed.

### Phase A — Participant/synthesizer source picker
- [ ] Thread `participantSources` prop through `node-side-form → flow-graph-editor → flow-editor-tabs`.
- [ ] Wire runner fetch in `LocalPackageEditor`; build Runners group (A1).
- [ ] Replace participant + synthesizer agent/runner fields with `ReferenceCombobox`.
- [ ] i18n keys (EN+RU); update `buildNodeSideFormLabels`.
- [ ] (A2, optional) Add Agents group from the package's own `maister-agents/*.md`.
- **Verify:** Zod still parses a manifest produced by selecting a runner (exactly-one-of holds); read-only viewer renders combobox as free-text with no fetch; existing consensus unit test updated and green; lint/typecheck clean.

### Phase B — Schema reference picker + inline builder
- [ ] Decide lift vs. out-of-band PUT; implement the shared `schemaFiles` + `onWriteSchemaFile` thread.
- [ ] Build `SchemaRefField` (combobox + inline `FormSchemaBuilder` + paste-validate-save).
- [ ] Replace both schema `TextField`s.
- [ ] i18n keys (EN+RU); update `buildNodeSideFormLabels`.
- **Verify:** creating a schema writes `schemas/<name>.json` and sets `./schemas/<name>.json`; the file appears in the Files drawer (shared state) and persists through the existing save path; runtime resolver still loads it (no change); `hasOutputResult` routing panel still appears (value stays a string); read-only viewer degrades to free-text; lint/typecheck clean.

### Phase C — Cleanup & docs
- [ ] Remove now-dead `participantAgent/participantRunner/synthesizerAgent/synthesizerRunner` labels + i18n keys if fully replaced (surgical).
- [ ] If a domain doc covers Flow Studio editing (`docs/system-analytics/flow-studio.md`), add a short note that schema refs and consensus sources are now pickable (no contract change). Confirm whether this doc needs updating per the repo's "docs wins" rule.

---

## Test plan

**Unit (vitest):**
- `reference-sources.test.ts` — `buildRunnerGroup` label/format; `buildSchemaOptions` filter + `./` normalization; `deriveSchemaFileName` uniqueness/kebab; agent-id `<pkg>:<stem>` construction.
- `reference-combobox.test.ts` — free-text passthrough; option-click fills value + reports `kind`; readOnly disables input + hides list; empty-group hint.
- **Update** `web/components/flows/node-form/__tests__/node-side-form.test.ts` — it currently asserts the participant `agent`/`runner` testids (`node-consensus-participant-agent-*` etc.); migrate to the new `node-consensus-participant-source-*` and assert: selecting a runner option writes `runner` + clears `agent`; selecting an agent option writes `agent` + clears `runner`; free-text writes a string. Add coverage that the emitted node still satisfies `consensusParticipantSchema`/`consensusSynthesizerSchema` (`config.schema.ts`).
- New `node-side-form` cases for `SchemaRefField`: selecting an existing schema sets `output.result.schema` to `./schemas/<x>.json` (still a string, `hasOutputResult` true); paste-invalid → no write + banner; create → calls `onWriteSchemaFile(path, content)` and sets the ref.
- Confirm `FormSchemaBuilder` reuse is unbroken (its existing tests untouched).

**Integration (vitest, if a save-path test exists):** assert `planWorkingDirWrites` (`working-dir-save.ts`) emits a `put` for the newly created `schemas/<name>.json` given a draft set containing it (no new endpoint test needed).

**E2E (Playwright) — existing specs that touch the studio editor (run/extend, do not add new infra):**
- `web/e2e/m27-flow-editor.spec.ts`, `web/e2e/flow-editor.spec.ts` — node-form editing surface.
- `web/e2e/studio-local-edit.spec.ts` — the `/studio/edit` local-package editor (the live mount for both parts).
- `web/e2e/flow-studio-artifacts.spec.ts` — schema/artifact surfaces.
- `web/e2e/m38-decide-routing.spec.ts` — depends on `output.result.schema` being set (routing panel gate); verify it still passes after Part B.
- (Read-only) `web/e2e/studio-package-viewer.spec.ts` / `flow-package-viewer.spec.ts` — confirm the viewer's `FlowNodeInspector` still renders (free-text, no fetch).
- **E2E run caveat (from repo memory):** Next 16 refuses a second `next dev` on the same project dir — free `:3000` before running e2e locally.

---

## Risks & open questions

**Risks / pitfalls:**
- **State-ownership lift (Part B)** is the riskiest change: moving `PackageFilesEditor`'s `draftFiles` up to `LocalPackageEditor`. Keep `PackageFilesEditor` working uncontrolled for its other mount (`web/app/(app)/flows/actions.ts` authored-flow path) — make the controlled props optional with the current internal state as fallback. Verify the hidden `packageFilesJson` input + `onDirtyChange` still fire.
- **`"use client"` boundary:** `NodeSideForm`, `FlowGraphEditor`, `FlowEditorTabs`, `LocalPackageEditor`, `FormSchemaBuilder` are all client components, and only plain-data props cross the RSC boundary (the editor explicitly forbids functions crossing server→client — `local-package-editor.tsx:177`). All new props (`participantSources`, `schemaFiles`) are plain data; `onWriteSchemaFile` is a client-side callback created inside `LocalPackageEditor` (client), so it never crosses the server boundary — OK.
- **Read-only viewer must not regress:** the viewer page (`.../flows/[flowId]/page.tsx`) passes neither new prop → both controls degrade to free-text/read-only with no network calls. Assert via the existing viewer e2e.
- **Agent-id correctness (Part A2):** `<packageName>:<stem>` must match the registry's `packageInstalls.name` (registry.ts:182). A wrong prefix yields launch-time `PRECONDITION`. Verify against a seeded package before shipping A2; if uncertain, ship A1 only.
- **Combobox-in-drawer brittleness:** the deliberate native-input + suggestion-list pattern (per `model-autocomplete.tsx`) avoids the Popover-in-scroll-container bugs the codebase already hit — do not substitute a HeroUI `Autocomplete` popover without checking it inside the scrolling sidebar.
- **Free-text kind inference (Part A):** for a forward-ref that matches neither catalog, defaulting to `runner` could mis-tag an intended agent ref. Mitigated by the inline "as agent/as runner" toggle shown only in that case. Confirm product accepts this.

**Open questions (для уточнения):**
1. **Part B запись файла:** лифтить state `PackageFilesEditor` в `LocalPackageEditor` (чище, больше кода) или писать схему сразу через `PUT /files/<path>` + `router.refresh()` (меньше кода, запись вне Save)? Архитектор — какой вариант?
2. **Part A группа Agents:** ограничить пакетными `maister-agents/*.md` (без эндпойнта) — ок? Или нужен весь платформенный каталог агентов (тогда новый member-эндпойнт)?
3. **Свободный ввод участника без совпадения:** дефолт `runner` + переключатель "as agent" — приемлемо, или участник-форвард-реф вообще не нужен (только из списка)?
4. **Ref-формат:** писать `./schemas/<name>.json` (как в примерах доков) — ок? Существующие манифесты используют `./`-префикс или голый `schemas/...`?
5. **Старые i18n-ключи** (`participantAgent`/`participantRunner`/`synthesizerAgent`/`synthesizerRunner`): удалять при полной замене или оставить? Grep показывает использование только в `node-side-form-labels.ts` — подтвердить удаление.

Confidence: 🟡 Medium — code paths, schemas, mount points, save mechanism, runner source, and agent-catalog gating all confirmed against actual code (file:line cited). Medium (not high) because two design forks are left open by intent (the `PackageFilesEditor` state-lift vs. out-of-band PUT in Part B, and the Agents-group scope in Part A) — the architect's answers to the open questions finalize them; the exact `<packageName>` value for A2 should be re-verified against a seeded package at implementation time.
