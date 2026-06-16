# Active-workspaces rail — row actions redesign (design)

- **Status:** Implemented (2026-06-16).
- **Scope:** the per-project active-workspaces block in the left rail. Surface
  doc: `docs/screens/chrome/active-workspaces.md`. Behavior doc:
  `docs/system-analytics/workbench-lifecycle.md`.
- **Goal:** make per-row actions usable in the narrow (260px) rail — stop the
  hover layout jump, stop the action buttons from burying the run name, replace
  the cramped inline rename, and give live runs more than one action.

## Problem (verified)

1. **Rows grow / jump on hover.** In line 1 the relative-time text (~16px tall)
   is swapped for the action cluster of `h-[26px]` icon buttons via a
   `group-hover` display toggle (`active-workspace-row.tsx:158-169`). The buttons
   are taller than the resting text, so line 1 — and the whole row — grows
   vertically on hover.
2. **Buttons bury the name (scratch).** For a terminal scratch run with a live
   worktree the policy enables `archive + drop + exportBranch`, and
   `exportBranch` expands to `snapshot-commit + export-branch`
   (`lifecycle-actions.tsx:151-155`), plus the rename pencil — up to **5**
   `shrink-0` buttons. In a ~232px content width they consume the `flex-1` name
   area, so the name truncates to nothing and the run link is unreachable.
3. **Live flow runs show one button.** While a run is live
   (`Running/NeedsInput/NeedsInputIdle`) the policy enables only `stop`
   (`policy.ts:106-110`) — hence the single button.
4. **Inline rename is unusable.** The rename pencil opens an inline input +
   save + cancel inside the row (`active-workspace-row.tsx:308-348`); in a 260px
   rail that is cramped and steals the name slot.

## Decisions

| # | Decision |
| - | -------- |
| 1 | Per-row actions collapse into a single overflow **`⋯` menu**; at most one inline primary action (`Stop`, only while live) sits beside it. |
| 2 | Rail action set = `Open · Rename (scratch) · Stop · Archive · Drop`. `snapshot-commit`, `export-branch` (push), and `handoff-branch` are **removed from the rail** and remain only in the run card. |
| 3 | Live runs gain combined **`Stop & archive`** and **`Stop & drop`** actions (one click each), for **flow + scratch** runs. Agent runs are out of scope this iteration (see Agents). |
| 4 | Rename opens a **modal** (reusing the lifecycle `DialogShell`). When the scratch run has a linked task, the modal shows a `KEY-N` context chip; the edited value is the scratch `name`. |
| 5 | The `⋯` menu renders as a **modal action-sheet** (not an anchored dropdown), because the rail body is `overflow-y-auto` (`left-rail.tsx:608`) and would clip an absolute dropdown. Reuses `DialogShell` (focus-trap / Escape / scroll-lock already in place and tested). |
| 6 | **Fix the rail `Stop` for live `runKind=agent` runs.** It currently routes to `/api/runs/[runId]/stop` → `stopFlowWorkbench`, which throws `PRECONDITION` for non-flow runs. The stop path dispatches on run kind so an agent run is terminated via its own path (supervisor `deleteSession` + `finalizeAgentRun`). Combined `Stop & *` for agents stays out of scope. |

## To-be: row anatomy

Line 1 stays `[state dot] · [name link, flex-1 truncate] · [right slot]`; line 2
stays the chip row (flow / runner / `KEY-N` / TTL / archived). Changes:

- **No vertical jump.** Line 1 gets a fixed `min-height` equal to the action
  button height (~26px). The resting time text and the action buttons both fit
  inside that height, so toggling between them never changes row height.
- **No name squeeze / no horizontal twitch.** The right slot reserves a fixed
  min-width sized for `Stop + ⋯` (≤ 2 buttons). The name keeps the rest of the
  width at rest and on hover, and is never covered → the name `Link` is always
  clickable. (Today the right slot can hold up to 5 buttons; now it holds ≤ 2.)
- **Right slot content.** Default: relative time. On hover / focus-within: the
  inline primary (`Stop`, only when the run is live) + the `⋯` trigger. The
  buttons remain focusable siblings of the name link (never nested in the
  anchor), preserving the current keyboard model.

## To-be: the `⋯` action-sheet

`⋯` opens a compact modal (`DialogShell`) titled "Run actions" with the run
identity in the header (linked-task `KEY-N` chip when present + name). The body
is a vertical list of actions; the set depends on run state:

- **Live** (`Running / NeedsInput / NeedsInputIdle`): `Open run` ·
  `Rename` (scratch only) · `Stop & archive` · `Stop & drop`.
  (Plain `Stop` is the inline primary, so it is not duplicated in the list.)
- **Terminal with live worktree** (`Review / Crashed / Done / Abandoned /
  Failed`): `Open run` · `Rename` (scratch only) · `Archive` · `Drop`.
- A muted footer notes `snapshot · push · handoff → in run card`.

Destructive items (`Drop`, `Stop & drop`) use the danger tone. Selecting an
action that needs confirmation or input swaps the sheet body to that action's
existing confirm/input panel (the current `archive`/`drop` confirm, the rename
field) — i.e. the sheet is the root of the existing dialog state machine.

## To-be: combined live actions (backend)

Combining is race-free because `stopFlowWorkbench` is **synchronous** and lands
a flow run in `Review` (`service.ts:1067-1091`), and `Review` already satisfies
`requireActionAllowed(ctx, "archive"|"drop")`. So:

- `Stop & archive` = `stopFlowWorkbench` → `archiveWorkbench`.
- `Stop & drop` = `stopFlowWorkbench` → `dropWorkbench`.

Implementation: server-side combined operations (one route + one service
function per combo) so the client makes a single call with a single error path,
consistent with the project's "one aggregating endpoint over client sagas"
convention. The combined op runs stop, then the worktree op, returning the
worktree-op result; if the worktree op fails the run is safely left in `Review`
(the menu then offers plain `Archive`/`Drop` for a retry).

Scratch runs (in scope): `stopFlowWorkbench` is flow-only
(`service.ts:1045-1050`), but scratch already has its own synchronous routes:
`/stop` (`scratch-runs/[runId]/stop` — stops the session, keeps the worktree)
and `/discard` (`scratch-runs/[runId]/discard:171-229` — stops the session AND
removes the worktree in one transaction → `Abandoned`). So:

- scratch `Stop & drop` = the existing **`/discard`** route (no new backend).
- scratch `Stop & archive` = scratch `/stop` → `archiveWorkbench`
  (`archiveWorkbench` loads via the `runs` row, which exists for scratch). The
  plan pins whether the post-`/stop` `runs.status` (`runStatusForDialogStatus`)
  satisfies `requireActionAllowed("archive")`; if not, the stop step sets an
  archive-eligible status. Net-new backend is then at most a thin scratch
  stop→archive combo; the flow combos remain the main backend work.

## To-be: rename

Rename (scratch only) becomes a `DialogShell` modal:

- Header shows the linked-task `KEY-N` chip when `linked_task_id` resolves;
  otherwise just the rename title.
- Body is the name `input` (trim 1..200, the existing `PATCH
  /api/scratch-runs/{runId}` contract is unchanged).
- The inline rename input / save / cancel in the row is removed.

## Implementation shape

Extend the existing `WorkbenchLifecycleActions`
(`components/workbench/lifecycle-actions.tsx`) rather than adding a parallel
component:

- Add a root `menu` dialog state: the trigger is the single `⋯` button (a new
  `menu` variant, or the `icon` variant reduced to one trigger); opening it sets
  `dialogAction = "menu"` and renders the action list in `DialogShell`.
- Add a `rename` action wired to `PATCH /api/scratch-runs/{runId}` (move the
  logic out of `active-workspace-row.tsx`).
- Add `stopArchive` / `stopDrop` UI actions calling the new combined endpoints.
- Drop `snapshotCommit` / `exportBranch` / handoff from the rail surface (keep
  them for the run-card surface — `variant="detail"`).
- `active-workspace-row.tsx`: line 1 `min-height`, reserved right-slot width,
  inline `Stop` (live) + `⋯`; remove the inline rename block.

## Files (indicative; pinned in the plan)

- UI: `components/chrome/active-workspace-row.tsx`,
  `components/workbench/lifecycle-actions.tsx`,
  `components/chrome/left-rail.tsx` (label wiring only).
- Backend: new flow combined routes under `app/api/runs/[runId]/…` + service
  functions in `lib/workbench-lifecycle/service.ts`; scratch `Stop & drop`
  reuses `app/api/scratch-runs/[runId]/discard`; scratch `Stop & archive` =
  `/stop` → `archiveWorkbench` (thin combo if status mapping needs it); policy
  note in `lib/workbench-lifecycle/policy.ts` (live flow/scratch surface
  combined ops); generalize the stop path so `runKind=agent` is terminated via
  `deleteSession` + `finalizeAgentRun` instead of `stopFlowWorkbench`
  (`app/api/runs/[runId]/stop` and/or `lib/workbench-lifecycle/service.ts`).
- Specs: `docs/screens/chrome/active-workspaces.md`,
  `docs/system-analytics/workbench-lifecycle.md`, `docs/api/web.openapi.yaml`
  (new combined endpoints).
- i18n: `messages/{en,ru}.json` — `workbenchLifecycle` (menu, `stopArchive`,
  `stopDrop`, rename-modal) + `portfolio` (rename) keys.
- Tests: row unit (`components/chrome/__tests__`), lifecycle-actions unit,
  combined-op route/integration tests, e2e `e2e/active-workspaces.spec.ts`.

## Agents (combined ops out of scope; stop fix in scope)

The rail `getRailWorkspaceGroups` **inner-joins `workspaces`**
(`portfolio.ts:829`), so only runs with a real worktree appear: flow, scratch,
and `workspace: worktree` agent runs. `none` / `repo_read` agent runs (the
common case) never reach the rail. This iteration does **not** add combined
`Stop & *` actions for `runKind=agent`; agent rows keep their current
policy-derived actions, now shown through the same menu.

**Stop fix (in scope).** A live worktree-axis agent row surfaces `Stop`, but
`/api/runs/[runId]/stop` → `stopFlowWorkbench` throws `PRECONDITION` for
non-flow runs (`service.ts:1045-1050`). The stop path is generalized to
dispatch on `runKind`: flow keeps its behavior (session teardown → `Review`);
an agent run is stopped via its termination path — supervisor `deleteSession`
+ `finalizeAgentRun` to a terminal status. Note: `finalizeAgentRun`
(`launch.ts:982-1051`) flips status and nulls `acpSessionId` but does **not**
itself call `deleteSession`, so the fix MUST ensure the supervisor session is
actually killed. The plan pins the exact terminal status and where the
dispatch lives (stop route/service vs `endpointFor`).

## Out of scope

- No change to `snapshot-commit` / `export-branch` / `handoff-branch` behavior
  or to their run-card surface.
- No change to the rename API contract, the membership-scoped rail query, or
  per-route RBAC (visibility/authorization boundary stays as-is).
- No new menu/portal primitive — the action-sheet reuses `DialogShell`.

## Testing

- Row renders at fixed height in rest and hover states (no height delta);
  name link reachable with ≤ 2 right-slot buttons.
- `⋯` opens the action-sheet; correct action set per run state (live vs
  terminal; scratch vs flow).
- `Stop & archive` / `Stop & drop` transition a live flow run correctly and are
  idempotent on partial failure (run rests in `Review`).
- Rename modal opens, shows the task chip when linked, PATCHes the name.
- A live `runKind=agent` run's `Stop` terminates it (supervisor session
  killed + terminal status), with no `PRECONDITION` from the flow-only path.
- e2e: hover a scratch row, open `⋯`, rename via modal, and stop&drop a live
  flow run.
