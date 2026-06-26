# Implementation Plan: Flow Studio AI-assistant & node-editor improvements (A/B/C/D1ʹ)

Branch: claude/suspicious-boyd-b22d66
Created: 2026-06-26

## Settings
- Testing: yes
- Logging: standard
- Docs: yes  # mandatory docs checkpoint in /aif-implement

## Roadmap Linkage
Milestone: "none"
Rationale: Flow Studio UX polish (assistant dock + node editor); not a standalone roadmap milestone — skipped by user.

---

## Scope, Preconditions & De-confliction

This plan covers four in-scope blocks from the user's request. Two adjacent
bodies of work are **explicitly excluded** and must NOT be re-planned here.

### Preconditions (must hold before implementation starts)
1. **`feature/flow-studio-reference-pickers` (codex worktree `c3f7`) is MERGED into the base.**
   That branch owns and ships, FROZEN spec
   (`.ai-factory/specs/feature-flow-studio-reference-pickers.md`):
   - consensus `participants[]` / `synthesizer` **source** pickers
     (`participantAgent/Runner` → `participantSource`, `ReferenceCombobox`);
   - schema-ref pickers for `settings.form_schema` and `output.result.schema`
     + inline schema create/paste/edit (`SchemaRefField`, `FormSchemaBuilder`);
   - the `draftFiles` **lift** (`package-files-draft.ts`, controlled
     `PackageFilesEditor`) and `reference-sources.ts` /
     `reference-combobox.tsx` / `schema-ref-field.tsx` / `schema-ref-actions.ts`.
   These artifacts are **reused, never recreated**. This branch must be
   **rebased onto post-`c3f7` main before implementing** (the user does this to
   avoid merge conflicts in the shared files: `node-side-form.tsx`,
   `node-side-form-labels.ts`, `flow-editor-tabs.tsx`, `flow-graph-editor.tsx`,
   `local-package-editor.tsx`, `en.json`, `ru.json`).
2. **This branch already carries uncommitted "AI-dock" WIP** (3-column dock,
   minimap collapse + dark-theme fix, node-type hint tooltips incl. consensus,
   danger remove-node, selected-node glow, status/usage lifted to the panel
   header, launch-button overlay + Cmd/Ctrl+Enter for the FIRST prompt). **Build
   on it; do not revert.** Only the follow-up-composer send placement is redone
   (Phase A).

### Out of scope — D2 (separate spec/ADR, owner decision)
The **model → runner-config** work is a separate document and is NOT planned
here:
- replace the free-text `settings.model` with a runner-config picker;
- store the recommended executor **by value** (`adapter` + `model` +
  `thinkingEffort`) in `flow.yaml`;
- launch-time runner **substitution dialog** (dedup by unique
  `(adapter, model, effort)`, bind each missing tuple to a host runner);
- **removing the single-adapter-per-run guard**
  (`web/lib/acp-runners/flow-step-target.ts:60-67`,
  `resolveCompiledStepTargetRunnerId`).
`settings.model` and the runner-resolution path stay **untouched** in this plan.

### Out of scope — c3f7
Consensus source pickers and schema-ref pickers (above) — owned by `c3f7`.

---

## Decisions

### Contract guard (no wire/DB/state change)
This feature is an **authoring-UI + assistant-context** change. It adds **NO**
new HTTP route, OpenAPI shape, DB table/column/index, Drizzle migration,
AsyncAPI/SSE event, `MaisterError` code, env var, sidecar, bound port, or
**Flow-DSL shape change** (`web/lib/config.schema.ts` is read by the grammar
generator and the controls, never modified). The new controls write the **same**
stored shapes the schema already accepts (`skills`/`restrictions`/`mcps` arrays,
list `string[]`s, `action.prompt` string). Therefore **no ADR and no migration
number** are reserved (D2 will own its own ADR). The only contract surfaces
touched are **i18n** and **docs** — traced in §Contract Surface Trace.

### Key design decisions
- **D1. Grammar is derived, drift-guarded, and always on input.** A single SSOT
  builder `buildFlowDslGrammar()` emits the complete compact grammar (every node
  type incl. first-class `consensus`/`orchestrator`, every field + type, every
  enum, gates/transitions/rework/output/decide). A vitest **drift guard**
  introspects `config.schema.ts` (node-type discriminant values + each settings
  schema `.shape` keys + exported zod enum values) and fails the build if any is
  absent from the grammar → "complete and accurate, always." Delivery: inject it
  into `buildFlowAssistantContext` (the **per-turn, always-sent** context) so it
  is literally always on input; render the same SSOT into the `/flow-authoring`
  skill's `references/flow-dsl.md` (`authoring-skill.ts`) so the skill file
  cannot drift either. This is the root-cause fix for "consensus authored as two
  judges": the assistant now has an authoritative statement that `consensus` is
  first-class.
- **D2. Node prompts use canonical capability tokens; no runtime change.** The
  node `action.prompt` is authored in `CapabilityComposer` and stored as
  canonical `@skill:<slug>` tokens. The existing runtime normalizer
  (`web/lib/flows/runner-agent.ts:723`, `normalizeCapabilityTokens`) already
  converts those per adapter (claude `/`, codex `$`) — so the "won't adapt to
  codex" defect is fixed at authoring time with **zero** runtime/grammar change.
- **D3. Project-less capability catalog.** The composer catalog source
  (`getProjectCapabilityCatalog`) is project-scoped; the studio editor is
  project-less. A pure `buildPackageCapabilityCatalog(files, adapter)` derives
  the catalog client-side from the package's own files (skills from
  `skills/<slug>/SKILL.md`) — no new endpoint.
- **D4. Control selection by field semantics.**
  - **Catalog multiselect** (`MultiSelectField`, chips + add-combobox, free-add
    allowed for forward-refs): `skills` (from package `skills/*`), `mcps` (from
    `mcpCatalog`).
  - **Fixed-enum multiselect** (`MultiSelectField` with `fixedOptions`):
    `rework.workspacePolicies` (`keep|rewind-to-node-checkpoint|fresh-attempt`).
  - **Free-text row list** (`StringListField`, add-button + removable rows):
    `restrictions`, `roles`, `assignees`, `decisions`, `material_axes`,
    `rework.allowedTargets`, `hooks.pathGuard.allowedPaths`.
  - **Unchanged:** `settings.model` (D2 out of scope); consensus sources +
    schema refs (c3f7).
- **D5. Read-only viewer parity.** Every new control degrades to read-only /
  free-text when its catalog/source props are absent (the package **viewer**
  mount, `FlowNodeInspector`) — no fetch, byte-identical no-op, mirroring the
  c3f7 contract.

---

## Contract Surface Trace
| Surface | Change | Spec file / action |
| --- | --- | --- |
| Flow DSL / Zod manifest shape (`config.schema.ts`) | **No shape change** | Read-only by the grammar generator + drift guard. Tests prove emitted manifests still parse under `flowYamlV1Schema`. |
| HTTP route / OpenAPI | **None** | No new route; the catalog is client-side from `files`. |
| DB / Drizzle migration / `docs/db/*` | **None** | No persisted-state change. |
| AsyncAPI / SSE | **None** | — |
| `MaisterError` taxonomy | **None** | — |
| env / compose / sidecar / port | **None** | No deployment touchpoint (skill-context deployment rule: N/A). |
| i18n (en/ru) | **Yes** | `web/messages/en.json` + `web/messages/ru.json` — every new visible control localized (TE.1). |
| System analytics | **Yes** | `docs/system-analytics/flow-studio.md` — assistant now receives the full drift-guarded grammar each turn; consensus authored as first-class (TE.2). |
| Screen reference | **Yes** | `docs/screens/studio/editor.md` — node-form MultiSelect/StringList controls + `/`-autosuggest prompt composer + first-prompt autosuggest + overlaid follow-up Send (TE.2). |

## Testing & Gates (per skill-context rule)
- **Runner:** `maister-web` vitest. New unit tests live under already-globbed
  dirs (`web/lib/flows/__tests__/`, `web/lib/capabilities/__tests__/`,
  `web/components/flows/node-form/__tests__/`, `web/components/scratch/__tests__/`).
  Confirm with `pnpm --filter maister-web exec vitest list <file>` when a test
  lands in a new path family.
- **Per-phase green gate (exit criteria for EVERY phase):**
  `pnpm --filter maister-web typecheck` clean **and**
  `pnpm --filter maister-web test:unit` green. Assertion migration for the
  fields a phase converts is **in that phase** (node-side-form tests).
- **E2E:** extend `web/e2e/studio-local-edit.spec.ts` only (TE.3). Caveat
  (repo memory): Next 16 refuses a 2nd `next dev` on the same project dir — free
  `:3000` before running e2e locally.

---

## Commit Plan
- **Commit 1** (Phase 0, T0.1–T0.2): `feat(flows): generated FlowDSL grammar SSOT + drift guard`
- **Commit 2** (Phase A, TA.1): `fix(scratch): overlay follow-up Send bottom-right over composer`
- **Commit 3** (Phase B, TB.1–TB.2): `feat(studio): feed complete FlowDSL grammar to the assistant every turn`
- **Commit 4** (Phase C, TC.1–TC.3): `feat(studio): /-autosuggest in assistant prompt + node action prompt`
- **Commit 5** (Phase D, TD.1–TD.2): `feat(flows): MultiSelectField + StringListField node-form primitives`
- **Commit 6** (Phase D, TD.3–TD.4): `feat(flows): structured node-form controls for skills/mcps/list fields`
- **Commit 7** (Phase E, TE.1–TE.3): `feat(studio): i18n + docs + e2e for assistant/editor improvements`

---

## Tasks

### Phase 0 — Grammar SSOT + drift guard (front-loaded; B depends on it)

- [ ] **T0.1 — `buildFlowDslGrammar()` SSOT.** New `web/lib/flows/flow-dsl-grammar.ts`
  exporting a pure `buildFlowDslGrammar(): string`. Output: a compact, complete
  grammar reference — for EVERY node type (`ai_coding`, `judge`, `cli`, `check`,
  `human`, `form`, `orchestrator`, `consensus`) its required/optional fields with
  types; every enum (`thinkingEffort`, `permissionMode`, `workspaceAccess`,
  `criticality`, `environmentPolicy`, `failureClass`, gate `kind`, gate `mode`,
  `rounds.mode`, `workspacePolicies`, `on_no_consensus`); the `pre_finish.gates`,
  `transitions`, `rework`, `output.result`, and `decide` shapes; and an explicit
  directive: *"`consensus` is a FIRST-CLASS node — emit `type: consensus` with
  `participants[]` + `synthesizer`; NEVER emulate consensus with judge nodes."*
  TDD with T0.2.
  - Files: `web/lib/flows/flow-dsl-grammar.ts`.
  - Logging: standard — one INFO `[flow-dsl-grammar] built (<N> chars, <M> node types)` on first build; pure otherwise.
  - Acceptance: pure function, deterministic; typecheck clean.

- [ ] **T0.2 — Drift-guard test.** New `web/lib/flows/__tests__/flow-dsl-grammar.test.ts`.
  Introspect `config.schema.ts`: enumerate the node discriminated-union `type`
  values; for each settings schema (`aiCodingSettingsSchema`, `judgeSettingsSchema`,
  `cliCheckSettingsSchema`, `humanSettingsSchema`, `formSettingsSchema`,
  `orchestratorSettingsSchema`, consensus node shape) enumerate `.shape` keys;
  enumerate exported zod enum `.options`. Assert EVERY node type, settings key,
  and enum value appears in `buildFlowDslGrammar()`. **RED first** (start with the
  grammar intentionally missing one key/enum), then complete T0.1 to GREEN.
  - Files: `web/lib/flows/__tests__/flow-dsl-grammar.test.ts`.
  - Acceptance: RED evidence recorded; GREEN after T0.1 complete; the test is the "always accurate" enforcement.
  - **Phase gate:** typecheck clean; `test:unit` green.

### Phase A — Follow-up composer Send overlay (#8)

- [ ] **TA.1 — Overlay Send bottom-right over the composer.** In
  `web/components/scratch/scratch-composer.tsx` `compact` mode: REMOVE the
  action-row-above-input (`mb-2 … {actionButtons}`); wrap the `CapabilityComposer`
  in a `relative` container with bottom padding, and render the Send button
  `absolute bottom-2.5 right-2.5` over it (mirror the launch overlay in
  `studio-ai-tab.tsx`). Move the attachment "+" / agent-busy chips into a small
  bottom-LEFT overlaid cluster (compact only). Non-compact mode unchanged.
  Verify Cmd/Ctrl+Enter still submits (existing `onSubmitShortcut`). Keep testid
  `scratch-composer-send`. Migrate the scratch-composer static test for the new
  markup.
  - Files: `web/components/scratch/scratch-composer.tsx` + its `__tests__`.
  - Logging: none (UI).
  - Acceptance: compact Send is overlaid bottom-right OVER the input (not a row above); Cmd/Ctrl+Enter submits; non-compact unchanged; static/unit test green.
  - **Phase gate:** typecheck clean; `test:unit` green.

### Phase B — Feed the grammar to the assistant (#1; root cause of #7) — depends Phase 0

- [ ] **TB.1 — Inject grammar into the per-turn context.** In
  `web/lib/studio/flow-assistant/context.ts` (`buildFlowAssistantContext`), render
  `buildFlowDslGrammar()` into the always-sent prompt as a `## Flow DSL grammar
  (authoritative)` section, and replace the line 118 pointer ("answer from … the
  flow-authoring skill grammar") with the inline grammar reference. Grammar is now
  present on EVERY assistant turn (launch + follow-up).
  - Files: `web/lib/studio/flow-assistant/context.ts` (+ context test if present).
  - Logging: standard — INFO `[flow-assistant] grammar injected (<N> chars)` once per build.
  - Acceptance: a unit/snapshot test asserts the assembled context contains the grammar section and the string `type: consensus`.

- [ ] **TB.2 — Render the SSOT into the `/flow-authoring` skill file.** In
  `web/lib/flows/authoring-skill.ts`, replace the hand-maintained
  `references/flow-dsl.md` grammar body (and the WIP hand-patched
  consensus/orchestrator node-type line + table rows) with the output of
  `buildFlowDslGrammar()` so `FLOW_AUTHORING_SKILL_FILES` ships the generated,
  drift-guarded grammar. Single source of truth — both context (TB.1) and the
  skill file call the same builder.
  - Files: `web/lib/flows/authoring-skill.ts`.
  - Logging: none (in-memory content).
  - Acceptance: no hand-maintained node-type list remains; T0.2 drift guard now also covers the skill file content path; typecheck clean.
  - **Phase gate:** typecheck clean; `test:unit` green.

### Phase C — `/`-autosuggest in two inputs (#2, #3)

- [ ] **TC.1 — `buildPackageCapabilityCatalog(files, adapter)`.** New
  `web/lib/capabilities/package-catalog.ts` — pure builder returning
  `ProjectCapabilityCatalogEntry[]` from `files: AuthoredFlowPackageFile[]`:
  skills from `skills/<slug>/SKILL.md` → `{ kind: "skill", slug, displayName,
  canonicalToken: "@skill:<slug>", surfaceForm, supported: capabilitySurfaceFor(adapter).skills }`.
  Reuse `capabilitySurfaceFor` / `composer-serialize` helpers.
  - Files: `web/lib/capabilities/package-catalog.ts` + `__tests__/package-catalog.test.ts`.
  - Logging: none (pure).
  - Acceptance: skills derived; per-adapter `supported` correct; unit green.

- [ ] **TC.2 — Composer in the assistant first prompt.** Replace the
  `web/components/studio/studio-ai-tab.tsx` first-prompt `<textarea>` with
  `CapabilityComposer` (`catalog={buildPackageCapabilityCatalog(files, adapter)}`,
  `agent={adapter}`), preserving the overlaid launch button, Cmd/Ctrl+Enter
  launch, and disabled states. Thread `files` + selected-runner `adapter` from
  `LocalPackageEditor` (both already available there). The launch/message path
  already normalizes canonical tokens (`normalizeScratchPrompt`).
  - Files: `web/components/studio/studio-ai-tab.tsx`, `web/components/studio/local-package-editor.tsx` (thread `files`/`adapter`).
  - Logging: none (UI).
  - Acceptance: `/` shows skill autosuggest in the first prompt; launch + Cmd/Enter still work; tokens normalized on send.

- [ ] **TC.3 — Composer in the node `action.prompt`.** Replace the
  `web/components/flows/node-form/node-side-form.tsx` `action.prompt` `<textarea>`
  (testid `node-action-prompt`) with `CapabilityComposer`, storing canonical
  `@skill:<slug>` tokens. Thread `promptCatalog` + display `adapter` (flow/package
  default runner adapter; fallback `claude`) from `LocalPackageEditor` →
  `FlowEditorTabs` → `FlowGraphEditor` → `NodeSideForm`. Read-only viewer (no
  catalog) degrades to read-only text. NO runtime change — `runner-agent.ts:723`
  already adapts tokens to codex/claude. Migrate node-side-form tests for the new
  prompt control.
  - Files: `node-side-form.tsx`, `flow-graph-editor.tsx`, `flow-editor-tabs.tsx`, `local-package-editor.tsx`, `node-side-form` `__tests__`.
  - Logging: none (UI).
  - Acceptance: node prompt shows `/` autosuggest; stores `@skill:<slug>`; emitted manifest parses under `flowYamlV1Schema`; an existing normalizer test proves `@skill:x` → `$x` for codex; read-only viewer unaffected (no catalog → plain text).
  - **Phase gate:** typecheck clean; `test:unit` green.

### Phase D — Structured node-form controls (#5, #6)

- [ ] **TD.1 — `MultiSelectField` primitive.** New
  `web/components/flows/node-form/multi-select-field.tsx`: selected values as
  removable chips + an add-combobox over options (progressive disclosure:
  collapsed filterable list). Two modes: `catalog` (skills/mcps, **free-add
  allowed** for forward-refs) and `fixedOptions` (enum, no free-add). `readOnly`
  → chips only. Follows the native-input + suggestion-list precedent
  (`model-autocomplete.tsx`) to avoid Popover-in-scroll-container brittleness.
  - Files: `web/components/flows/node-form/multi-select-field.tsx` + `__tests__/multi-select-field.test.ts`.
  - Logging: none (UI).
  - Acceptance: select/remove/free-add work; `fixedOptions` rejects free-add; readOnly disables editing; unit/static green.

- [ ] **TD.2 — `StringListField` primitive.** New
  `web/components/flows/node-form/string-list-field.tsx`: add-button + one
  text input per item with a per-row danger trash button; empty → add-first
  affordance; writes `string[]`; `readOnly` → rows read-only.
  - Files: `web/components/flows/node-form/string-list-field.tsx` + `__tests__/string-list-field.test.ts`.
  - Logging: none (UI).
  - Acceptance: add/edit/remove rows; empty array semantics preserved; readOnly safe; unit/static green.

- [ ] **TD.3 — Wire catalog/enum multiselects.** In
  `node-side-form.tsx`, replace the comma-separated `TextField`s for **`skills`**
  (catalog = package skills via a `buildSkillOptions(files)` helper) and
  **`mcps`** (catalog = `mcpCatalog` ids; keep writing the flat `string[]` union
  branch), and **`rework.workspacePolicies`** (`fixedOptions` = the 3 enum
  values) with `MultiSelectField`. Thread `skillOptions` + `mcpOptions` from
  `LocalPackageEditor` down (same plumbing as TC.3). Add `nodeForm` labels.
  - Files: `node-side-form.tsx`, `node-side-form-labels.ts`, `flow-graph-editor.tsx`, `flow-editor-tabs.tsx`, `local-package-editor.tsx`, `en.json`, `ru.json`, `node-side-form` `__tests__`.
  - Logging: none (UI).
  - Acceptance: skills/mcps render as chips+add from catalog (free-add allowed); workspacePolicies as fixed multiselect; emitted manifest parses (`skills: string[]`, `mcps: string[]`, `workspacePolicies: enum[]`); read-only viewer degrades.

- [ ] **TD.4 — Wire free-text row lists.** In `node-side-form.tsx`, replace the
  comma-separated `TextField`s for **`restrictions`, `roles`, `assignees`,
  `decisions`, `material_axes`, `rework.allowedTargets`,
  `hooks.pathGuard.allowedPaths`** with `StringListField`. Preserve sparse-block
  semantics (empty list → omit the field, matching current `undefined`). Add
  `nodeForm` labels. Migrate the affected node-side-form tests (enumerate each
  asserted field).
  - Files: `node-side-form.tsx`, `node-side-form-labels.ts`, `en.json`, `ru.json`, `node-side-form` `__tests__`.
  - Logging: none (UI).
  - Acceptance: each field = add-button + removable rows; empty omits the field; emitted manifest parses under `flowYamlV1Schema`; migrated tests green.
  - **Phase gate:** typecheck clean; `test:unit` green.

### Phase E — i18n parity + docs (mandatory) + e2e

- [ ] **TE.1 — i18n parity.** Ensure every new visible control has en + ru keys
  (MultiSelect add/placeholder/empty/remove; StringList add/remove/placeholder;
  the two composer placeholders; the grammar section needs none). Run the en/ru
  key-parity check.
  - Files: `web/messages/en.json`, `web/messages/ru.json`.
  - Acceptance: en/ru parity passes; all new controls localized.

- [ ] **TE.2 — Docs checkpoint.** Update `docs/system-analytics/flow-studio.md`
  (the assistant now receives the complete, drift-guarded Flow DSL grammar on
  every turn; consensus is authored as a first-class node) and
  `docs/screens/studio/editor.md` (node-form MultiSelect/StringList controls +
  `/`-autosuggest prompt composer; assistant first-prompt `/`-autosuggest +
  overlaid follow-up Send). Additive to c3f7's edits; mark **Implemented** (R6);
  keep R5 structure.
  - Files: `docs/system-analytics/flow-studio.md`, `docs/screens/studio/editor.md`.
  - Acceptance: docs updated; `pnpm validate:docs` green.

- [ ] **TE.3 — E2E.** Extend `web/e2e/studio-local-edit.spec.ts`: (a) first-prompt
  composer renders + a skill chip can be inserted via `/`; (b) node `action.prompt`
  composer renders + stores a canonical token; (c) a `skills` multiselect adds +
  removes a chip; (d) a `StringListField` (e.g. `roles`) adds + removes a row;
  (e) follow-up Send button present + overlaid (testid). Keep assertions robust
  (avoid brittle popup-timing). Note the `:3000` single-dev caveat.
  - Files: `web/e2e/studio-local-edit.spec.ts`.
  - Acceptance: scoped e2e green locally (`:3000` free).
  - **Phase gate:** typecheck clean; `test:unit` green; `validate:docs` green; scoped e2e green.

---

## Open Questions (для уточнения — есть дефолты, не блокеры)
1. **Composer-адаптер для node prompt:** показывать `/`-autosuggest по адаптеру flow-default-раннера, или всегда claude-сигилы (рантайм всё равно нормализует)? Дефолт: flow-default, fallback `claude`.
2. **MultiSelect skills/mcps:** разрешить свободный ввод сверх каталога (forward-ref / платформенный скилл)? Дефолт: да (free-add).
3. **`rework.allowedTargets`:** StringList (свободный текст) сейчас, или селект из id нод флоу? Дефолт: StringList; node-id-select — позже.
4. **e2e глубина autosuggest:** TipTap `/`-popup флейки в e2e — ограничиться рендером + вставкой чипа, или полный popup-сценарий? Дефолт: минимально-устойчиво.

Confidence: 🟡 Medium — every file/line, injection point, and schema shape is grounded in cited code; the only soft spots are the four defaulted open questions above and the post-`c3f7`-rebase textual conflicts in the shared node-form/editor files (semantic overlap is low — different field regions).
