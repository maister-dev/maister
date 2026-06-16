# Workbench lifecycle domain

> **Status: Implemented (M27 slice).** This contract covers operator actions
> for stopped, stale, crashed, finished, and no-longer-useful run workbenches.
> It extends the read-only M22 workbench with explicit lifecycle controls while
> reusing the existing run status enum, workspace archive columns, supervisor
> session model, and git worktree helpers.

## JTBD

When an operator sees a stale, stopped, crashed, finished, or no-longer-useful
workbench in a sidebar, project panel, or run detail view, they need to decide
its fate there: stop live cost, preserve useful work, free disk, or hand the
branch to a local developer without spelunking through git.

When an operator stops an active run, MAIster should terminate the live
supervisor session and finalize the run by its kind — a flow run rests in
`Review`, an agent run is finalized to `Abandoned` (terminal) through its own
agent-termination path — leaving the worktree present for inspection, archive,
or drop instead of treating the operator stop as a crash.
**(Designed — runKind-dispatched stop.)**

When an operator already knows a live flow or scratch run should be preserved or
discarded, MAIster should offer one-click **Stop & archive** and **Stop & drop**
that stop the run and then run the worktree op, instead of forcing a stop, a
wait for `Review`, then a separate second click. **(Designed.)**

When an operator archives or drops a workbench, MAIster must preserve recoverable
work before any prune. Archive records the preserved ref and keeps the worktree;
drop preserves first, then removes only an owned worktree.

When an operator exports a branch, MAIster should push the existing run branch
to the selected remote and provide checkout commands. Dirty work is committed
first through the explicit snapshot commit sub-action.

When an operator wants to continue outside MAIster without final promotion,
MAIster should create a separate handoff branch at the workbench HEAD, push it
to a selected existing remote, and show copyable checkout commands while leaving
the run in its current review/terminal state.

## Vocabulary

- **Workbench** — the visible run/workspace unit in the left rail, portfolio
  cards, project active workspace panel, board/run detail views, and scratch
  detail.
- **Stop** — terminate a live supervisor session and finalize the run by its
  kind: a flow run lands in `Review`; a scratch run lands in `Review` when it
  has a live worktree, otherwise `Abandoned`; an agent run is finalized to
  `Abandoned` (terminal) via `finalizeAgentRun`. `POST /api/runs/{runId}/stop`
  dispatches on `runs.run_kind` (allow-listed `flow | scratch | agent`); the
  scratch detail surface keeps the dedicated `POST /api/scratch-runs/{runId}/stop`
  route, which now delegates to the same shared scratch-stop primitive.
  **(Designed — generalized dispatch; flow stop is Implemented.)**
- **Stop & archive** — one combined action for a live flow or scratch run: stop
  first, then **Archive** the parked worktree. **(Designed.)**
- **Stop & drop** — one combined action: stop first, then **Drop** the worktree.
  For flow runs this is `POST /api/runs/{runId}/stop-drop`; for scratch runs it
  reuses the existing single-transaction `POST /api/scratch-runs/{runId}/discard`
  (stop session + remove worktree → `Abandoned`). **(Designed.)**
- **Archive** — call `preserveWorktree`, record `workspaces.archived_branch` and
  `archived_at`, and leave the worktree on disk.
- **Drop** — call `preserveWorktree`, remove the owned worktree with
  `removeOwnedWorktree`, record `removed_at`, and mark non-`Done` runs
  `Abandoned`.
- **Export branch** — optionally snapshot dirty files, then push the run branch
  with host git credentials. Export does not mark the run `Done`; promotion is
  still the merge/PR completion action.
- **Snapshot commit** — explicit operator action that commits dirty tracked and
  untracked work on the server-owned run branch. It does not push, archive,
  drop, promote, or create a branch.
- **Handoff branch** — operator-named continuation branch created at the
  workbench HEAD without switching the MAIster worktree away from its run
  branch. Existing local or remote handoff refs are reused only when they
  already point at the same workbench HEAD; different-head refs are conflicts.

## State and action matrix

| Run status / dialog                                                         | Stop                 | Archive                   | Drop                       | Export |
| --------------------------------------------------------------------------- | -------------------- | ------------------------- | -------------------------- | ------ |
| `Running` flow                                                              | yes -> `Review`      | no                        | no                         | no     |
| `NeedsInput` / `NeedsInputIdle`                                             | yes -> `Review`      | no                        | no                         | no     |
| live scratch dialog (`Starting`, `WaitingForUser`, `Running`, `NeedsInput`) | yes via scratch stop | no                        | no                         | no     |
| live agent (`Running` / `NeedsInput` / `NeedsInputIdle`)                    | yes -> `Abandoned`   | no                        | no                         | no     |
| `HumanWorking`                                                              | no                   | no                        | no                         | no     |
| `Review`                                                                    | no-op hidden         | yes                       | yes                        | yes    |
| `Crashed`                                                                   | no                   | yes while worktree exists | yes                        | yes    |
| `Done`                                                                      | no                   | yes until pruned          | yes, status remains `Done` | yes    |
| `Abandoned` / `Failed`                                                      | no                   | yes while worktree exists | yes                        | yes    |

The matrix is implemented as an allow-list in
`web/lib/workbench-lifecycle/policy.ts`. Unknown future statuses expose no
actions until deliberately added. Commit and handoff branch creation are not
policy-level read-model actions; they are sub-actions inside the Export dialog
and routes, gated by handoff metadata and lifecycle claims. The combined
**Stop & archive** / **Stop & drop** below are not new policy actions either:
they compose the existing `stop` (live) and `archive`/`drop` (parked) actions
server-side so the operator clicks once.

## Combined stop + worktree ops (Designed)

`Stop & archive` and `Stop & drop` exist because the bare `stop` action lands a
run in a parked state (`Review` for flow/scratch with a worktree) from which the
operator usually wants the very next worktree op. Composing them server-side
keeps a single call with a single error path (the project's "one aggregating
endpoint over a client saga" convention).

Composition is race-free because the stop step is synchronous and commits first:
`stopFlowWorkbench` lands a flow run in `Review` (`service.ts`), the shared
scratch-stop primitive lands a live scratch run in `Review` when it has a
worktree (`scratch-runs/state.ts` `dialogStatusAfterSupervisorStop`), and
`Review` already satisfies `requireActionAllowed(ctx, "archive" | "drop")`. The
combined op then runs the worktree op and returns that op's result.

- `Stop & archive` (`POST /api/runs/{runId}/stop-archive`, flow + scratch):
  stop, then `archiveWorkbench` — worktree preserved on disk.
- `Stop & drop` (`POST /api/runs/{runId}/stop-drop`, flow): stop, then
  `dropWorkbench` — worktree removed, non-`Done` run → `Abandoned`.
- Scratch `Stop & drop` is **not** a new route: it reuses
  `POST /api/scratch-runs/{runId}/discard`, which already stops the session and
  removes the worktree in one transaction (→ `Abandoned`).

Because the stop commit is durable before the worktree op, no two-phase
idempotency marker is added; the crash/failure windows degrade to the parked
state, from which the plain `Archive`/`Drop` actions complete the work:

| Failure | HTTP | Run state | Recovery |
| --- | --- | --- | --- |
| Stop step fails | 5xx / 409 | unchanged (still live) | retry the combined action |
| Stop ok, archive/drop fails | that op's error code | `Review` (worktree intact) | plain `Archive` / `Drop` from the menu |
| Process crash between stop-commit and archive/drop-commit | — | `Review`, no orphan (worktree op never started) | plain `Archive` / `Drop` |

Combined `Stop & *` for `runKind=agent` is out of scope this iteration; an agent
row exposes only the plain (terminating) `Stop`.

## Route contracts and trust boundary

| Route                                    | Purpose                                                           | Trusted identifiers                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST /api/runs/{runId}/stop`            | Stop a live workbench, dispatched on `run_kind` (flow → `Review`, scratch → `Review`/`Abandoned`, agent → `Abandoned`) | `runId` is URL-param; `run_kind`, project, ACP session, and workspace metadata are DB state |
| `POST /api/runs/{runId}/stop-archive`    | Stop then archive a live flow or scratch run (Designed)           | `runId` is URL-param; body empty; project, session, and paths are DB state                  |
| `POST /api/runs/{runId}/stop-drop`       | Stop then drop a live flow run (Designed); scratch reuses `/discard` | `runId` is URL-param; body empty; project, session, and paths are DB state                  |
| `POST /api/runs/{runId}/archive`         | Preserve worktree into `maister/archive/{runId}`                  | branch, paths, base ref, and project are DB state                                           |
| `POST /api/runs/{runId}/drop`            | Preserve then remove an owned worktree                            | worktree path and allowed root are server state                                             |
| `POST /api/runs/{runId}/export-branch`   | Push the run branch; optional force-with-lease retry              | remote and force are body-controlled; branch and paths are DB state                         |
| `GET /api/runs/{runId}/handoff-metadata` | Read dirty state, remotes, suggested branch, and checkout preview | runId is URL-param; branch and paths are DB state                                           |
| `POST /api/runs/{runId}/snapshot-commit` | Commit dirty work on the run branch                               | commit message is body-controlled; branch and paths are DB state                            |
| `POST /api/runs/{runId}/handoff-branch`  | Create and push a continuation branch                             | remote and handoff branch are body-controlled; current branch, HEAD, and paths are DB state |

All routes require a session and project membership at `member` or above. Stop,
stop-archive, stop-drop, archive, and drop use `recoverRun` (the combined routes
authorize once for the whole composed operation); export uses `promoteRun`
because it performs a remote git write. Handoff metadata, snapshot commit, and handoff branch also
use `promoteRun` because they expose or mutate remote-continuation git state. No
route trusts body-provided project ids, worktree paths, current run branches, or
session ids. Strict JSON body schemas reject unknown fields before the service
sees them.

## Lifecycle operation claims

Archive, drop, export, snapshot commit, and handoff branch use a durable
single-owner claim on `workspaces.lifecycle_operation_state`,
`lifecycle_operation_claimed_at`, `lifecycle_operation_attempt_id`, and
`lifecycle_operation_name`. The claim is committed before git or filesystem side
effects and finalized only by the same attempt token. Stale `claiming` rows are
reclaimable using the same timeout as promotion claims. Transient push failures
leave the claim retryable; non-transient failures finalize as `failed`.

## Expectations

- Lifecycle controls render from one shared DTO:
  `deriveWorkbenchLifecycleActions(...) -> enabled action ids`.
- The UI uses a shared `WorkbenchLifecycleActions` component across left rail,
  portfolio/project workspace rows, and run detail.
- Stop resolves a live supervisor session by `runs.acp_session_id` via
  `listSessions()` before calling `deleteSession(sessionId)`. Raw supervisor
  handles are never serialized to the browser.
- Stop dispatches on `runs.run_kind` (allow-listed `flow | scratch | agent`,
  unknown → `PRECONDITION`): flow → `Review`, scratch → `Review` with a live
  worktree else `Abandoned`, agent → `Abandoned` via `finalizeAgentRun`. The
  agent path MUST call `deleteSession` to kill the live supervisor session —
  `finalizeAgentRun` only flips status and nulls `acp_session_id`, it never
  deletes the session — and finalizing frees the agent pool slot through the
  `MAISTER_MAX_CONCURRENT_AGENTS` promotion contract. (Designed.)
- `Stop & archive` / `Stop & drop` commit the stop (parked status) before the
  worktree op; a worktree-op failure leaves the run in `Review`, retryable
  through the plain `Archive`/`Drop` action — never partially committed. Scratch
  `Stop & drop` reuses `/discard`. (Designed.)
- Archive/drop refuse live write states instead of racing the agent.
- Preserve failure returns `409 CONFLICT` and no archive/drop mutation happens.
- Drop removes only a path under `worktreesRoot()` through `removeOwnedWorktree`.
- Export refuses dirty work unless `snapshotDirty=true` and `commitMessage` is
  non-empty. The UI normally commits first through `snapshot-commit`, then pushes
  a clean run branch. Non-fast-forward push rejection is `409 CONFLICT` with
  `pushRejected=non_fast_forward`, `canForce=true`, and a retry hint; retrying
  with force uses `git push --force-with-lease`. Other transient push failures
  are `503 EXECUTOR_UNAVAILABLE`.
- Handoff metadata lists server-discovered remotes. `origin` is only the
  default when it exists; otherwise the first validated remote is the default.
- Snapshot commit refuses clean worktrees and returns the new HEAD commit when
  dirty work was committed.
- Handoff branch refuses dirty worktrees, missing remotes, and different-head
  local or remote branch collisions before pushing the new branch. Same-head
  refs are idempotent retry evidence: a local same-head ref is reused after a
  transient push failure, and a remote same-head ref completes a lost-ack retry.
- Drop persists removal only if the run status still matches the status read
  before the owned worktree removal; stale run-status updates fail with
  `409 CONFLICT`.
- Export and handoff success states include non-chained checkout commands.
- EN and RU labels are shipped together under `workbenchLifecycle`.

## Acceptance criteria

- A live flow run shows only **Stop** in every shared workbench panel.
- A `Review`/terminal workbench with a present worktree shows **Archive**,
  **Drop**, and **Export**. The Export dialog contains snapshot commit and
  optional handoff branch controls.
- A removed worktree shows no lifecycle actions.
- `POST /api/runs/{runId}/archive` records the archive ref only after
  `preserveWorktree` succeeds.
- `POST /api/runs/{runId}/drop` calls preserve before remove and records removal
  only after owned removal succeeds and the run-status CAS still matches.
- `POST /api/runs/{runId}/stop` terminates a live `runKind=agent` run — kills the
  live supervisor session via `deleteSession` and finalizes it to `Abandoned`
  through `finalizeAgentRun` — instead of raising the old flow-only
  `PRECONDITION`. (Designed.)
- `POST /api/runs/{runId}/stop-archive` (flow + scratch) and
  `POST /api/runs/{runId}/stop-drop` (flow) stop first, then run the worktree op,
  returning the worktree-op result; a worktree-op failure leaves the run in
  `Review`. Scratch `Stop & drop` reuses `/discard`. (Designed.)
- `POST /api/runs/{runId}/export-branch` refuses dirty work without explicit
  snapshot consent, pushes the server-owned run branch, returns `pushedRef`, and
  exposes a force-with-lease retry only for non-fast-forward conflicts.
- `POST /api/runs/{runId}/snapshot-commit` commits dirty work exactly once under
  the lifecycle claim and does not push or change run status.
- `POST /api/runs/{runId}/handoff-branch` pushes only the requested handoff
  branch, reuses same-head refs on retry, and does not switch the MAIster
  worktree branch.
- Focused tests cover policy, service orchestration, route wrappers, read-model
  projection, real-git behavior, race/idempotency, UI dialogs, and Playwright
  smoke coverage across the visible panels.

## Linked artifacts

- API: [`../api/web.openapi.yaml`](../api/web.openapi.yaml)
  (`/api/runs/{runId}/stop`, `stop-archive`, `stop-drop`, `archive`, `drop`,
  `export-branch`, `handoff-metadata`, `snapshot-commit`, and `handoff-branch`;
  scratch `Stop & drop` reuses `/api/scratch-runs/{runId}/discard`).
- ERD: [`../db/runs-domain.md`](../db/runs-domain.md) and
  [`../db/erd.md`](../db/erd.md) (`workspaces.lifecycle_operation_*`).
- Related domains: [`workbench.md`](workbench.md), [`workspaces.md`](workspaces.md),
  [`scratch-runs.md`](scratch-runs.md), [`runs.md`](runs.md),
  [`git-integration.md`](git-integration.md), and
  [`reconciliation-gc.md`](reconciliation-gc.md).
- Source: `web/lib/workbench-lifecycle/*`,
  `web/components/workbench/lifecycle-actions.tsx`,
  `web/lib/worktree.ts`.
