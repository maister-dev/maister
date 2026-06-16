# Active workspaces (left-rail block)

- **Type:** block — the per-project list of live runs inside the left rail
  chrome (present on every `(app)` screen). Not a standalone route; the rail
  hosts it.
- **Status:** **Implemented** (active-workspaces compact redesign). Live: the
  compact two-line row, the single colour-coded state dot (waiting-for-human
  states use the warm `--attention` token), ticket-derived names + scratch
  rename (`PATCH /api/scratch-runs/{runId}`), linked flow/issue chips, the
  non-linking runner info chip, and the hover/focus icon actions that replace
  the timestamp. Builds on the earlier per-project grouping, RBAC scoping,
  TTL/archived badges, and per-run workbench-lifecycle actions (M27).
- **Source:** `web/components/chrome/left-rail.tsx` (rail host) +
  `web/components/chrome/active-workspace-row.tsx` (the extracted client row,
  new), fed by `getRailWorkspaceGroups` in `web/lib/queries/portfolio.ts`.

## JTBD

When I am working across projects, I want every live run visible at a glance —
its state, which flow and ticket it belongs to, and which runner it runs on —
and I want to act on it (open, stop, rename, archive, export) in place, so I can
triage and steer work without leaving the current screen or scrolling past
full-width buttons.

## Roles & capabilities

| Role | Sees | Acts |
| --- | --- | --- |
| Global viewer / member | Active runs in projects they are a member of (the rail query is membership-scoped) | Opens a run; lifecycle actions and rename are gated per-route by `requireProjectAction` on the target project — a viewer cannot stop/archive/drop/export/rename |
| Global admin | Active runs across **all** non-archived projects | All actions, every project |

The rail never relaxes a project's authorization: visibility is membership- or
admin-scoped in `getRailWorkspaceGroups`, and every action re-checks its own
project action server-side. Rename is a project action on the scratch run's
project, not a creator-only check.

## Navigation

Entry points / exits for one row:

- **Row body (name)** → the run workbench: `/runs/[id]` (flow / agent) or
  `/scratch-runs/[id]` (scratch).
- **Flow chip** → no navigation. There is no installed-flow detail page — the
  `/flows/[projectSlug]/[capId]` route is Flow Studio's *authored-capability*
  editor, keyed by an authored `cap_id`, not the installed `flow_ref_id` a flow
  run references. The flow chip is an information chip (name + tooltip); the
  flow's live graph is reached by opening the run itself.
- **Issue chip `KEY-N`** → the task detail `/projects/[slug]/tasks/[number]`
  (present when the run resolves a task — `runs.task_id` for flow/agent, or
  `scratch_runs.linked_task_id` for a scratch run; hidden otherwise).
- **Runner chip** → no navigation. It is an information chip; the full runner
  description lives in its tooltip.
- **Action icons** → in-place `POST`s (stop / archive / drop / snapshot-commit /
  export-branch / handoff-branch) and the rename `PATCH`; see
  [workbench-lifecycle](../../system-analytics/workbench-lifecycle.md).
- **Group `+`** → the [launch dialog](launch-dialog.md) scratch popover, scoped
  to that project.

```mermaid
flowchart TD
    Row["Active-workspace row"] --> Run["Run workbench /runs/ID or /scratch-runs/ID"]
    Row --> Flow["Flow name — info chip, no navigation"]
    Row --> Task["Task KEY-N /projects/SLUG/tasks/NUMBER"]
    Row --> Runner["Runner tooltip — no navigation"]
    Row --> Act["Lifecycle action — in-place POST or rename PATCH"]
    Group["Project group header +"] --> Launch["Launch dialog — scratch popover"]
```

## Layout & regions

The block is a stack of per-project groups, each with a header
(`project name` · active count · `+` scratch launch) followed by its run rows.
In the expanded rail the block is inline; in the collapsed rail the same block is
hosted inside the Active workspaces flyout, without duplicating narrow text rows
in the icon rail.
A row is two lines:

1. **Line 1 — identity + slot.** A single **state dot** (the only state
   indicator), then the **name**, then the **right slot**.
   - **State dot** — colour encodes the run state; the running tone pulses
     gently. For attention states the dot is followed by a compact **status
     word**; for calm states the word lives only in the dot's `title` /
     `aria-label`. See the tone table under [States](#states). Running vs
     waiting-for-human are deliberately distinct hues — waiting uses a new warm
     `--attention` token (the only warm accent besides `--danger`).
   - **Name** — scratch runs show their editable `name` (with a rename pencil in
     the action cluster); flow / agent runs show a **ticket-derived** name
     (`KEY-N` + task title), falling back to the branch when there is no task.
   - **Right slot** — the relative time by default; on row **hover** or keyboard
     **focus-within**, the time is replaced by the **icon actions**. The action
     buttons are focusable siblings of the row link (never nested inside the
     anchor), so keyboard users reach them and the row stays a single link
     target.
2. **Line 2 — meta chips.** A non-linking **flow** info chip (icon + flow name;
   tooltip carries the `flow_ref_id` + pinned version), a non-linking **runner**
   info chip (icon + `runner-ref`; tooltip carries
   `agent · model · adapter · provider · sidecars`), and a linked **issue**
   `KEY-N` chip (only when the run resolves a task). TTL warning/due and archived
   badges render here when the GC projection or archive flag is set.

**Icon actions** are state-dependent (derived from `lifecycleActions`, unchanged
policy): rename (scratch only), stop, snapshot-commit, export-branch (labelled
"push branch to remote" so its purpose is explicit), archive, drop. Each icon
carries a tooltip naming the action; the heavier export / handoff flow still
opens the existing lifecycle dialog
([lifecycle-actions](../../system-analytics/workbench-lifecycle.md)).

## States

The block's own meaningful states are the empty/live split and the per-row
right-slot micro-interaction:

```mermaid
stateDiagram-v2
    [*] --> Empty: no active or TTL runs
    [*] --> Live: one or more rows
    Live --> RowIdle: default
    RowIdle --> RowActive: hover or focus-within
    RowActive --> RowIdle: blur or pointer leave
    note right of RowActive
      right slot shows icon actions, time hidden
    end note
```

State-dot tone mapping (colour is the at-a-glance language; the word is shown in
the row only when attention is required):

| Run state | Dot tone | Pulse | Status word in row |
| --- | --- | --- | --- |
| Running | green (`--accent-2`) | yes | no — tooltip only |
| NeedsInput / NeedsInputIdle | amber (`--attention`, new) | no | yes |
| Review | teal (`--accent-3`) | no | yes |
| Crashed | red (`--danger`) | no | yes |
| HumanWorking | neutral (`--ink-2`) | no | no — tooltip only |
| Done / Abandoned (TTL) | dim (`--mute-2`) | no | no — tooltip only |

## Data & APIs

- `getRailWorkspaceGroups(userId, role)`
  (`web/lib/queries/portfolio.ts`) — membership/admin-scoped active runs plus
  terminal runs still carrying a GC deadline. The redesign extends its select
  with joins: `tasks` (`number`, `title`) + `projects.task_key` → the `KEY-N`
  label and the ticket-derived name (for scratch runs the task is reached via
  `scratch_runs.linked_task_id`), and `flows` (`flow_ref_id` + pinned version) →
  the flow chip name + tooltip (no link — see Navigation). Runner detail for the
  tooltip comes from the existing `runs.runner_snapshot` (agent / model /
  adapter / provider / sidecar) — no new column.
- **Rename** — new `PATCH /api/scratch-runs/[runId]` writes `scratch_runs.name`
  (atomic, project-action gated, scratch runs only). Flow / agent runs are
  renamed by editing their task, not here.
- **Lifecycle actions** — behaviour and endpoints are unchanged
  ([workbench-lifecycle](../../system-analytics/workbench-lifecycle.md)); only
  the surface changes from text buttons to hover/focus icon buttons.
- **TTL / archived badges** — the `deriveTtlInfo` projection already on the row
  ([reconciliation-gc](../../system-analytics/reconciliation-gc.md)).

## i18n

`portfolio` (active-workspaces labels, the per-state status words, runner
tooltip field labels), `workbenchLifecycle` (action labels, tooltips, dialogs,
plus a new `rename` action), `gc` (TTL / archived badges). New keys: the
rename action + its dialog, the runner-tooltip field labels, and any status
word not already present. EN + RU both required.

## Linked artifacts

- ADRs: [ADR-065](../../decisions.md#adr-065) (platform ACP runner catalog —
  runner identity in the snapshot), ADR-083 (social board — `KEY-N` task
  identity).
- Behaviour: [workbench-lifecycle](../../system-analytics/workbench-lifecycle.md)
  (actions), [social-board](../../system-analytics/social-board.md) (tasks),
  [reconciliation-gc](../../system-analytics/reconciliation-gc.md) (TTL),
  [runs](../../system-analytics/runs.md) (run state machine behind the dot tone).
- Source: `web/components/chrome/left-rail.tsx`,
  `web/components/chrome/active-workspace-row.tsx` (new),
  `web/components/workbench/lifecycle-actions.tsx`,
  `web/lib/queries/portfolio.ts`, `web/app/api/scratch-runs/[runId]/route.ts`
  (rename `PATCH`, new).
