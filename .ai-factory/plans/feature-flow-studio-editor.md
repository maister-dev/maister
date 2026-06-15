# Implementation Plan: Flow Studio — Editor Usability (Phase B)

Branch: claude/angry-chaum-31d223
Created: 2026-06-15

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes  # mandatory docs checkpoint; SDD analytics-first per skill-context

## Roadmap Linkage
Milestone: "none"
Rationale: Phase B of the Flow Studio redesign initiative (lineage M27 Flow Studio). A dedicated milestone (M35) belongs in `/aif-roadmap`; this plan does not write it.

## Grounding & sources
- **Design SSOT (surface):** [`docs/screens/studio/README.md`](../../docs/screens/studio/README.md) §"Artifact editor" + the node icon/color table.
- **Sequencing rationale:** [`.ai-factory/plans/feature-flow-studio-redesign.md`](feature-flow-studio-redesign.md) §"Phasing & sequencing" — Phase B is the **storage-agnostic** editor redesign, built behind a small load/save **seam** so Phase C plugs in without rebuilding B.
- **Reference aesthetic:** Heym (`heym.run`) node canvas — compact cards, colored icon chip, named outcome handles.

## Scope boundary
Phase B is a **frontend redesign of the existing flow editor over the unchanged draft/publish/trust backend** — it adds **NO migration, NO new API route, NO new DB/error/env surface**. It delivers: the node **visual scheme** (icons + color per node/gate type, named-outcome handles, dashed rework edges) on the **shared** node renderer; a **3-pane layout** (compact top bar + big canvas + right properties panel) replacing the current tabs + two-column form; **drawers** for YAML / Diff / Files; a **hideable app rail**; and a **load/save seam**.

**Explicitly excluded → Phase C** (package-coupled): the *redesigned* package-aware Files drawer with cross-artifact reference pickers, "new artifact in package", and the top-bar "cut version" action. **No regression:** B carries the **existing** `package-files-editor` behind a `[Files]` drawer (re-homed, not redesigned), so bundled-file editing keeps working; C redesigns what that drawer shows.

## Contract-surface ledger (skill-context: "trace every contract surface to its spec file")

| Surface class | Changes in Phase B? | Spec file / reason |
| --- | --- | --- |
| HTTP route / SSE / error code / env / DB | **No** | Pure client redesign of `/flows/{projectSlug}/{capId}`; save still goes through the existing authored-draft server action (`PATCH /catalog/caps/{capId}/draft`, CAS). No `docs/api/*`, `error-taxonomy.md`, `configuration.md`, `database-schema.md`, `db/*.md` change. |
| `package.json` script / CLI / Flow DSL | **No** | None. |
| Screen surface | **Yes** | New `docs/screens/studio/editor.md`; updated `docs/screens/chrome/left-rail.md` (hideable rail). |
| system-analytics behavior | **Yes** | `docs/system-analytics/flow-studio.md` editor-redesign section + the canonical node-visual scheme. |
| Shared component visual contract | **Yes (note)** | The node-visual scheme lands in the **shared** `FlowNodeBody` → also changes the read-only preview (Phase A) and the **run workbench** graph. Status coloring is unchanged and **composes** with the new type accent (see T1.1). |

## Deployment touchpoints
**None.** No env var, config file, sidecar, or port. No `Dockerfile`/`compose*`/`.env.example` change.

## Identifier trust-boundary table
No new request-derived locators. The editor route `/flows/{projectSlug}/{capId}` and the save action are unchanged: `projectSlug` + `capId` are `url-param`, resolved against `server-state` (the authored-capability row + project `manageCatalog`); the draft CAS uses the existing `expectedDraftVersion` body field (already validated). No new `body-controlled` cross-resource ids.

## Test-integrity acceptance (skill-context)
- **Runnability.** New component tests are `*.test.tsx` under `web/components/{flows,studio,chrome}/**` + `web/lib/flows/**`, run by the web Vitest project (`renderToStaticMarkup`, no jsdom). Confirm the glob matches with `pnpm --filter maister-web exec vitest list` before relying on a test. The e2e `web/e2e/flow-editor.spec.ts` MUST be added to `AUTHED_SPEC` in `web/playwright.config.ts`.
- **Per-phase green checkpoint.** Each phase exits with `pnpm --filter maister-web exec vitest run` green + (Phase 1/2) `playwright test flow-editor.spec.ts` green.
- **Shared-component coverage (T1.1).** The node-visual scheme edits the **shared** `FlowNodeBody`. Enumerate and migrate the touched tests BEFORE editing: `grep -rln "FlowNodeBody\|flow-graph-view\|colorForNodeStatus\|makeFlowNodeView" web/**/*.test.*`. `FlowNodeBody` has **no test today** and feeds the editor, the read-only preview, AND the run workbench — so this is **new coverage**, not migration: any pre-existing test keeps its status-chip / current-node-ring assertions green (the type accent is additive), and T1.1 ADDS a `FlowNodeBody` render test + confirms the vitest include globs `components/board/**`.

## Commit Plan
- **Commit 1** (Phase 0, T0.1–T0.4): `docs(studio): SDD spec + editor screen doc + analytics for editor redesign`
- **Commit 2** (T1.1–T1.2): `feat(web): node visual scheme (icons/colors) + named-outcome handles + rework edges`
- **Commit 3** (T1.3): `feat(web): hideable left rail`
- **Commit 4** (T1.4–T1.6): `feat(web): 3-pane editor (top bar + canvas + properties + drawers) behind a save seam`
- **Commit 5** (T1.7, T2.1–T2.2): `feat(web): editor i18n + e2e; flip docs to Implemented`

---

## Tasks

### Phase 0 — Analytics / SDD first (complete & consistent BEFORE any Phase 1 code)

- [x] **T0.1 — SDD spec.** Create `.ai-factory/specs/feature-flow-studio-editor.md` (frozen SSOT): the 3-pane layout regions, the node/gate **visual scheme** (the icon + color-token table — canonical copy in `flow-studio.md`, cited here), named-outcome handles + dashed rework edges, the hideable rail, the **load/save seam** contract (injectable **server action** preserving the `expectedDraftVersion` CAS; default = the current authored-draft action), and the three ledgers above. Tag pieces Implemented-on-merge / Designed (R6). Match `.ai-factory/specs/feature-flow-studio-phase2-viewing-editing.md` style. Logging: n/a.
- [x] **T0.2 — Screen doc.** Create `docs/screens/studio/editor.md` per the screens template (header · JTBD · roles `manageCatalog` · navigation · layout & regions (top bar / canvas / right properties / drawers / hideable rail) · states · data & APIs (unchanged draft/publish) · i18n `flowEditor` · linked artifacts). Add its index row to `docs/screens/README.md` + glossary row to `docs/CLAUDE.md`. Logging: n/a.
- [x] **T0.3 — Behavior + chrome docs.** Update `docs/system-analytics/flow-studio.md` with an "Editor redesign (Phase B)" section (3-pane, shared node-visual scheme, hideable rail, the seam) — status Designed → Implemented on merge; the canonical visual-scheme table lives here, cited from `editor.md` (R7). Update `docs/screens/chrome/left-rail.md` with the collapse/hide behavior. Logging: n/a.
- [x] **T0.4 — Phase-0 gate.** Run `pnpm validate:docs:all` (green). Confirm spec ↔ screen ↔ analytics agree on the scheme and the B/C exclusion boundary. Commit 1.

### Phase 1 — Editor redesign (storage-agnostic; over existing editor backend)

- [x] **T1.1 — Node visual scheme on the shared renderer.**
  - Files — Create: `web/lib/flows/node-visuals.ts`, `web/lib/flows/node-visuals.test.ts`; Modify: `web/components/board/flow-graph-view.tsx` (`FlowNodeBody`).
  - Do: a pure map `nodeVisual(type)` → `{ iconName, colorToken }` for `ai_coding|judge|cli|check|human` and `gateVisual(kind)` for the 6 gate kinds, per the scheme in `editor.md` (use the app's existing icon set — confirm the import source via `grep -rn "from \"lucide\|@heroicons\|icons\"" web/components | head`). Render a **colored icon chip** as the node's identity in `FlowNodeBody`, **coexisting** with the existing run-status chip (`colorForNodeStatus`, unchanged) and the author `presentationColor` border. This component is shared → the read-only preview (Phase A) + run workbench inherit it.
  - **New coverage (not migration):** `FlowNodeBody` has no test today — ADD the render test below and confirm the vitest include globs `components/board/**`; keep the status-chip / current-node-ring rendering intact (the type accent is additive).
  - Logging: none (pure map + presentational).
  - Test: `web/lib/flows/node-visuals.test.ts` asserts each type/kind → expected token; a `FlowNodeBody` render test asserts the type icon + the status chip both appear.
  - Verify: `pnpm --filter maister-web exec vitest run lib/flows/node-visuals components/board` green.

- [x] **T1.2 — Named-outcome handles + dashed rework edges.**
  - Files — Modify: `web/components/flows/flow-graph-editor.tsx` (`toEditorEdges`, the `flowNode` handle render via `makeEditorNodeView`), and the edge style.
  - Do: label each source handle / edge by its transition `outcome` (success/failure/rework/takeover); style **rework / back-edges** dashed + amber, default outcomes solid — matching the Heym labeled-handle look. Keep `handleConnect`→`setTransition` intact (no second edge store). **Editor-scoped:** handles change only in `makeEditorNodeView`; the read-only `makeFlowNodeView` keeps simple handles.
  - Logging: `console.debug("[flowEditor] connect", { source, target, outcome })` on confirmConnection.
  - Test: a unit test on the edge-style function (outcome → `{ animated/dashed, strokeColor }`).
  - Verify: vitest green; manual: rework edge renders dashed/amber.

- [x] **T1.3 — Hideable app rail.**
  - Files — Modify: `web/components/chrome/left-rail.tsx` (+ the app layout that sizes it).
  - Do: add a collapsed state (persisted to `localStorage`, default expanded) + a toggle button; collapsed shows icons-only (or hidden) so the editor canvas gets width. No collapse machinery exists today — add `useState` + an effect to read/write `localStorage`, and a width/`hidden` class switch.
  - Logging: `console.debug("[leftRail] toggle", { collapsed })`.
  - Test: `web/components/chrome/left-rail.test.tsx` — `renderToStaticMarkup` collapsed vs expanded asserts the nav labels hide/show + the toggle button present.
  - Verify: vitest green; rail collapses and persists across reload.

- [ ] **T1.4 — Editor top bar + load/save seam.**
  - Files — Modify: `web/app/(app)/flows/[projectSlug]/[capId]/page.tsx`, `web/components/flows/flow-editor-tabs.tsx`; Create: `web/components/flows/editor/editor-top-bar.tsx`.
  - Do: collapse the page header + the right-sidebar InfoPanels into a **compact top bar**: identity (project · cap · kind) · lifecycle chip (Draft/Published) · validation chip (computed in the top-bar owner `FlowEditorTabs` via the **pure** `validateEditorManifest` on the owned manifest — not by reaching into `FlowGraphEditor`) · readiness chip (from the page's existing server-computed InfoPanel props) · **Save draft** · **Publish** · drawer toggles `[Files][YAML][Diff]`. **Seam (preserve the contract):** save/publish stay **server actions** with `formData.expectedDraftVersion` **CAS** + progressive enhancement; make the action **injectable** (`saveAction`/`publishAction` props on `FlowEditorTabs`, default = `updateAuthoredFlowAction`/`publishAuthoredFlowAction`) so Phase C passes a local-package-targeting server action — do NOT convert to a client `onSave` callback (that drops CAS). Keep the `yaml` single-state ownership + 400ms reseed.
  - Logging: `console.debug("[flowEditor] submit", { capId, expectedDraftVersion })` before invoking the server action; keep the existing `console.warn("[flowEditor] yaml parse error")` on reseed `"error"`.
  - Test: `editor-top-bar.test.tsx` asserts chips + Save/Publish gated on `canManage` + drawer-toggle buttons.
  - Verify: vitest green; Save still persists via the existing action.

- [ ] **T1.5 — 3-pane canvas + right properties panel.**
  - Files — Modify: `web/components/flows/flow-graph-editor.tsx` (its internal 2-col grid → canvas-center + right pane), `web/components/flows/node-form/node-side-form.tsx` (group its sections under headings: Identity · Behavior · Runner · Gates · Transitions · Presentation — node-intrinsic only; it already lives in the editor's right sidebar).
  - Do: `FlowGraphEditor` **already** renders canvas + a 340px right sidebar (`NodeSideForm` + `EditorValidationSummary`) — so this is NOT a move. Make that existing canvas+sidebar the **full-height dominant** layout: a full-height page shell (canvas fills viewport-minus-chrome), remove the fixed `h-[440px]`, make the right sidebar **collapsible** (~320–360px), and group `NodeSideForm`'s sections under the headings above (field logic unchanged). Keep the `FlowEditorToolbar` palette (Add node ×5 / Add gate ×6 / Remove); **add a `<MiniMap>`** (from the project's ReactFlow pkg — confirm import) + keep `<Controls>` (zoom/fit). The outer page two-column (form / InfoPanels) is removed — InfoPanels → top bar (T1.4).
  - Logging: `console.debug("[flowEditor] select", { nodeId })` on node select (reuse existing `onSelectNode`).
  - Test: render the editor shell asserts canvas region + right pane + properties sections present; node-select shows the form.
  - Verify: vitest green; selecting a node opens its grouped properties; drag persists x/y (existing `moveNode`).

- [ ] **T1.6 — Drawers (YAML / Diff / Files).**
  - Files — Modify: `web/components/flows/flow-editor-tabs.tsx` (tabs → top-bar-driven drawers).
  - Do: replace the Graph/YAML/Diff **tabs** with the canvas always-on + **toggled drawers**: `[YAML]` opens `code-editor.tsx` (the existing YAML editor, same reseed wiring), `[Diff]` opens the existing diff view, `[Files]` opens the **existing** `package-files-editor.tsx` re-homed as a drawer (NOT redesigned — that's C). Drawers are side/bottom overlays, not primary real estate. **Preserve** the 400ms YAML↔canvas reseed and the "flush pending sync" logic (currently on graph-tab entry → now on YAML-drawer open/close), keeping the canvas mounted while a drawer is open, so edits aren't lost across toggles.
  - Logging: `console.debug("[flowEditor] drawer", { open })`.
  - Test: toggling `[YAML]` shows the code editor; `[Files]` shows the files editor; closing returns to canvas.
  - Verify: vitest + manual; YAML↔canvas reseed still works through the drawer.

- [ ] **T1.7 — i18n + e2e + preview reuse check.**
  - Files — Modify: `web/messages/{en,ru}.json` (extend the existing `flowEditor` namespace: top-bar labels, drawer labels, rail toggle, node/gate visual labels), `web/playwright.config.ts` (`AUTHED_SPEC` += `flow-editor`); Create: `web/e2e/flow-editor.spec.ts`.
  - Do: e2e as a seeded admin — open a flow draft → top bar chips render → select a node → right properties populate → drag a node → Save → reload persists position → toggle `[YAML]` drawer → collapse the rail. Confirm the **Phase-A package-detail preview** (`/studio/packages/{ref}`) now renders nodes with the new icons/colors (shared component) and stays read-only; and smoke-check the **run-detail workbench** graph renders with the new node visuals (status chip + type accent compose).
  - Logging: confirm RU JSON parses (`node -e "JSON.parse(require('fs').readFileSync('web/messages/ru.json'))"`).
  - Verify: `lsof -ti :3100,:7788 | xargs kill -9 2>/dev/null; pnpm --filter maister-web exec playwright test flow-editor.spec.ts` green (kill shared ports first).

### Phase 2 — As-built docs sync + gates

- [ ] **T2.1 — Flip docs to Implemented.** Update `docs/screens/studio/editor.md`, `docs/screens/chrome/left-rail.md`, and the `flow-studio.md` editor section status tags Designed → Implemented; confirm the node-visual table matches `node-visuals.ts`. `pnpm validate:docs:all` green.
- [ ] **T2.2 — Full gate + docs checkpoint.** Run `pnpm --filter maister-web exec vitest run lib/flows/node-visuals components/flows components/chrome components/board` (green); `pnpm --filter maister-web exec eslint app/\(app\)/flows components/flows components/chrome/left-rail.tsx components/board/flow-graph-view.tsx` (clean, **scoped — never the no-path `lint`**); `playwright test flow-editor.spec.ts` (green); `pnpm validate:docs:all` (green). Mandatory `/aif-docs` checkpoint. Commit 5.

---

## Follow-on
**Phase C** (own plan, after B) plugs into B's seam: the package-aware **Files drawer** + cross-artifact reference pickers + "new artifact" + the top-bar **cut-version** action, against the `local_packages` working-dir model (Variant B). See [`feature-flow-studio-redesign.md`](feature-flow-studio-redesign.md) §"Phasing & sequencing".

## Нерешённые вопросы

1. **Иконки:** стандартный греп (lucide / heroicons / phosphor / react-icons) НЕ нашёл библиотеку — вероятно inline SVG; на T1.1 определить конвенцию по `left-rail.tsx` и следовать ей. Цвета — из существующих токенов.
2. **Скрытие рейла — глобально или только в редакторе?** Глобальный тумблер (localStorage) проще; авто-сворачивание на `/flows/edit` можно добавить позже.
3. **`presentationColor` vs тип-цвет:** авторский цвет рамки (ADR-064) перекрывает тип-акцент или сосуществует? (предлагаю: тип-акцент = чип иконки, авторский цвет = рамка — не конфликтуют).
4. **Маршрут редактора:** оставить `/flows/{projectSlug}/{capId}` (B не трогает маршрут) — переезд на `/studio/edit/...` отложить до Phase C, когда редактор адресует артефакты локального пакета.
