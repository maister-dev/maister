# Project Settings Brain

Route: `/projects/{slug}?tab=settings`
Status: Implemented (ADR-127/ADR-128)
Source components: `web/components/board/panels/settings-panel.tsx`,
`web/components/board/panels/project-brain-settings-control.tsx`

## JTBD

When I configure a project, I want to decide whether Brain is enabled, which
kinds have canonical homes, and which flow handles docs projection, so the
Brain's behavior matches the repository's documentation model.

## Roles & capabilities

| Role | Can see | Can act |
| --- | --- | --- |
| Project viewer/member | Project metadata rows only | No edits |
| Project admin/owner | Current Brain settings | Toggle Brain, edit home resolution, choose projection flow, configure source defaults |
| Global admin | Same as project owner | Same as project owner |

Editing requires `editSettings`. Enabling Brain still requires platform
embedding and distill settings; otherwise the route refuses `CONFIG`.

## Navigation

Entry points: project settings tab, Project Brain empty/disabled state. Exits:
Project Brain page, source list, platform Brain settings for global admins.

```mermaid
flowchart TD
    Settings["Project settings"] --> BrainBlock["Brain block"]
    BrainBlock --> BrainPage["Project Brain"]
    BrainBlock --> Platform["Admin Brain settings"]
```

## Layout & regions

- Enablement row: project Brain toggle and status.
- Home resolution: per-kind segmented controls for `owned` versus `indexed`.
- Sources: managed from the Project Brain tab, not duplicated in Settings.
- Projection: flow picker for docs/state projection tasks.
- Autonomy overrides: compact selectors limited to `manual` and `auto_draft`.

The block does not explain how Brain works inline; it exposes controls and state.
Detailed behavior stays in system analytics docs.

## States

```mermaid
stateDiagram-v2
    [*] --> ReadOnly
    ReadOnly --> Editing: user has editSettings
    Editing --> Invalid: missing platform config or invalid home map
    Invalid --> Editing: correction
    Editing --> Saved
```

## Data & APIs

- Server-side read: `settings-panel.tsx` reads `brain_project_config`.
- Implemented write: `PATCH /api/projects/{slug}/settings` with `brainEnabled`,
  `homeResolution`, `projectionFlowId`, and `autonomyDefaults`.
- Dedicated `/api/projects/{slug}/settings/brain` remains a designed split
  route in the OpenAPI document, not the current UI path.

## i18n

Namespace: `settings.*`.

## Linked artifacts

- ADR-122, ADR-127, ADR-128
- [`system-analytics/project-brain.md`](../../system-analytics/project-brain.md)
- [`api/web.openapi.yaml`](../../api/web.openapi.yaml)
