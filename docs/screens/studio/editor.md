# Flow editor (Studio)

- **Type:** screen (artifact editor).
- **Route(s):** `/flows/{projectSlug}/{capId}` (Phase B keeps the existing route;
  relocation to `/studio/edit/{...}` is **Phase C**).
- **Status:** Implemented (Phase B). Supersedes the tabs-in-a-form editor; the
  read-only twin is the shared `FlowGraphView` (per-project package viewer + run
  workbench), which inherits the node visual scheme.
- **Source:** `web/app/(app)/flows/[projectSlug]/[capId]/page.tsx`,
  `web/components/flows/flow-editor-tabs.tsx`,
  `web/components/flows/editor/editor-top-bar.tsx`,
  `web/components/flows/flow-graph-editor.tsx`,
  `web/components/flows/node-form/node-side-form.tsx`,
  `web/components/board/flow-graph-view.tsx` (shared node body),
  `web/lib/flows/node-visuals.ts`.

## JTBD

When I am authoring or reworking a flow, I want a big editing canvas with
readable, color-coded node cards, named outcome handles, and a focused properties
panel — so I can build and understand the graph without fighting cramped tabs or a
narrow viewport.

## Roles & capabilities

| Role | Sees | Notes |
| --- | --- | --- |
| Project `viewer` / global viewer with read | Read-only canvas + drawers; no Save/Publish | the `disabled` path; top-bar action buttons are hidden |
| Project `owner`/`admin` or global `admin` (`manageCatalog`) | Full edit: canvas, properties, Save draft, Publish | gated by `canManage`; Publish also requires a valid package |

The route resolves the authored capability against the project + `manageCatalog`;
the gate is server-side, the hidden action buttons are convenience only.

## Navigation

- **Entry:** the package detail "Rework / Open in editor" affordance, the legacy
  `/flows` editor links, or a direct URL.
- **Exit:** back to the project / Studio; **Publish** commits a local revision
  (stays on the editor); drawer toggles open/close in place.

```mermaid
flowchart LR
    Detail["/studio/packages/{ref}"] -->|rework| Editor["Flow editor"]
    Editor -->|Save draft| Editor
    Editor -->|Publish| Editor
    Editor -->|Files / YAML / Diff| Drawer["Drawer overlay"]
```

## Layout & regions

A 3-pane shell (top bar + canvas + right properties), with toggled drawers and a
hideable app rail ([`../chrome/left-rail.md`](../chrome/left-rail.md)):

1. **Top bar (compact)** — identity (project · cap · kind) · lifecycle chip
   (Draft/Published) · validation chip (valid / N issues, from the pure
   `validateEditorManifest`) · readiness chip · **Save draft** · **Publish** ·
   drawer toggles `[Files] [YAML] [Diff]`.
2. **Canvas (dominant, full height)** — the `FlowEditorToolbar` palette (Add
   node ×5 / Add gate ×6 / Remove), color-coded node cards (icon chip + status
   chip), named-outcome handles, dashed amber rework edges, `<MiniMap>` +
   `<Controls>`. Drag persists `presentation` x/y (ADR-064).
3. **Right properties panel (collapsible, ~320–360 px)** — `NodeSideForm` grouped
   under **Identity · Behavior · Runner · Gates · Transitions · Presentation** +
   `EditorValidationSummary`. Nothing selected → empty hint.
4. **Drawers (overlay)** — `[YAML]` (CodeEditor), `[Diff]` (FlowDraftDiffText),
   `[Files]` (the existing `PackageFilesEditor`, re-homed not redesigned — Phase C
   redesigns it). The canvas stays mounted while a drawer is open.

### Node visual language

Each node/gate carries a colored icon chip + a type-tinted card; the canonical
scheme (icon + hue → `--cv-*` canvas-palette token) lives in
[`../../system-analytics/flow-studio.md`](../../system-analytics/flow-studio.md)
§"Node visual language" and is implemented in `web/lib/flows/node-visuals.ts`. The
icon shape is the primary type signal; the status chip (run/preview only) composes
with it. Blocking gates render a solid chip, advisory an outline; rework /
back-edges render dashed + amber.

## States

```mermaid
stateDiagram-v2
    [*] --> Viewing: open (read-only or canManage)
    Viewing --> NodeSelected: click a node
    NodeSelected --> Viewing: click pane
    Viewing --> DrawerOpen: toggle [Files]/[YAML]/[Diff]
    DrawerOpen --> Viewing: close drawer (canvas stayed mounted)
    Viewing --> Saving: Save draft (server action, CAS)
    Saving --> Viewing: 200 / 409 conflict / 422 invalid
    Viewing --> CompileFallback: manifest fails to compile
    CompileFallback --> Viewing: edit YAML drawer → reseed
```

## Data & APIs

Unchanged draft/publish backend (no new route in Phase B):

- Save draft → `updateAuthoredFlowAction` (server action; `expectedDraftVersion`
  CAS) — injectable via the load/save seam (default action).
- Publish → `publishAuthoredFlowAction` (gated on a valid package).
- Canvas/diff are server-compiled from the draft manifest at page load.

Behavior SSOT: [`../../system-analytics/flow-studio.md`](../../system-analytics/flow-studio.md)
(authored-flow lifecycle, hard-gate, CAS) — not restated here (R7).

## i18n

`flowEditor` (top-bar labels, drawer labels, rail toggle, node/gate visual
labels, the existing node-form / toolbar / validation keys), `flows` (page header
+ save hint). EN + RU parity required.

## Linked artifacts

- ADRs: [#adr-064](../../decisions.md#adr-064) (authored `presentation` layout),
  [#adr-092](../../decisions.md#adr-092) (unified Studio + editable-local-package
  direction).
- Spec: [`../../../.ai-factory/specs/feature-flow-studio-editor.md`](../../../.ai-factory/specs/feature-flow-studio-editor.md).
- Behavior: [`../../system-analytics/flow-studio.md`](../../system-analytics/flow-studio.md).
- Area: [`README.md`](README.md).
- Source: see the Header.
