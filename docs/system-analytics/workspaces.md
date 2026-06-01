# Workspaces domain

## Purpose

A **workspace** is the git worktree where a run executes. Every run
gets a fresh worktree under `.maister/<slug>/runs/<runId>/`, isolated
from other concurrent runs on the same project. Workspace lifecycle
covers creation, active workspace visibility, promotion, archival, and
reconciliation on host or process restart.

## Domain entities

- **Workspace row** — `workspaces` table. One row per run.
- **Worktree path** — absolute filesystem path, globally UNIQUE.
- **Branch** — derived by the launcher. Task runs use the project branch
  prefix plus a task/run slug. Scratch runs may use a validated
  operator-provided branch/workspace name.
- **Base branch** — branch selected at launch; the run branch is created from
  this branch's launch-time commit.
- **Target branch** — branch selected for promotion. Defaults to the base
  branch but can differ for engineer-controlled workflows.
- **Parent repo** — `projects.repo_path`. The worktree shares `.git`
  with the parent.
- **Active workspace group** — Implemented. The left rail groups active Flow
  and scratch workspaces by project. Each group shows project name, active
  count, latest activity, and a project-scoped scratch `+` action.
- **Active workspace row** — Implemented. A visible run/workspace row with
  branch or scratch name, run kind, executor profile, launched-by user, status
  label, status dot, relative time, and run/scratch detail link.
- **Read-only range git ops (M11b — Implemented)** — `logRange`
  (`git log <base>..<branch>`), `diffRange` (`git diff <base>..<branch>`), and
  `resolveBaseRef` (`git merge-base <mainBranch> <branch>`) in
  `web/lib/worktree.ts`, used by the manual-takeover return to capture the
  human's commits + diff against the existing worktree. No merge, push, or
  checkout-switch. See [`manual-takeover.md`](manual-takeover.md).

## Lifecycle state machine

```mermaid
stateDiagram-v2
    [*] --> Created: git worktree add
    Created --> Active: run promoted to Running
    Active --> Merged: promotion succeeds<br/>run status=Done
    Active --> Stale: run terminal<br/>(Failed | Crashed | Abandoned)
    Stale --> Removed: GC cron after 7d<br/>git worktree remove
    Merged --> Removed: GC cron after 7d
    Active --> ConflictReview: local promotion conflict<br/>run stays Review
    ConflictReview --> Active: operator resolves<br/>and retries promotion
    ConflictReview --> Stale: operator abandons
    Removed --> [*]
```

### M19 graceful GC lifecycle (Designed)

M19 ([ADR-035](../decisions.md#adr-035)) refines the terminal tail of the
lifecycle above into a **preserve-then-prune** countdown. On the `Abandoned`/
`Done` transition the run stamps `workspaces.scheduled_removal_at = ended_at +
MAISTER_GC_AGE_DAYS` (default 14); the worktree then sits in a TTL countdown,
is **archived** (preserved) by the GC sweep, and only then **pruned**. Full GC
domain detail — both delivery surfaces, the cron route, and the preserve
flowchart — lives in [`reconciliation-gc.md`](reconciliation-gc.md). The GC
state is **derived** from `scheduled_removal_at`, `archived_at`, and
`removed_at` (no `gc_state` enum column).

```mermaid
stateDiagram-v2
    [*] --> Countdown: run terminal (Abandoned/Done)<br/>scheduled_removal_at stamped (migration 0015)
    Countdown --> Countdown: now < effective deadline<br/>TTL ramp green to amber to red
    Countdown --> Archived: GC sweep preserve<br/>archived_branch + archived_at set
    Archived --> Pruned: removeOwnedWorktree<br/>removed_at set
    Countdown --> Pruned: clean + merged<br/>nothing to preserve
    Pruned --> [*]
```

## Process flows

### Create a worktree (Implemented)

```mermaid
sequenceDiagram
    participant W as Web tier
    participant FS as Filesystem
    participant DB as Postgres

    W->>DB: read project (repo_path, branch_prefix, default_branch)
    W->>W: baseBranch = launch.baseBranch ?? default_branch
    W->>W: targetBranch = launch.targetBranch ?? baseBranch
    W->>W: branchName = launch branch name<br/>(task-derived or scratch-provided)
    W->>W: worktreePath = .maister/{slug}/runs/{runId}/
    W->>FS: git -C {repo_path} rev-parse {baseBranch}
    W->>FS: git -C {repo_path} worktree add {worktreePath} -b {branchName} {baseBranch}
    alt git error
        FS-->>W: non-zero exit
        W-->>W: throw MaisterError(PRECONDITION)
    end
    W->>DB: INSERT workspaces { run_id, project_id, branch, base_branch, base_commit, target_branch, worktree_path, parent_repo_path }
```

### Promote on Review (Implemented local merge; PR designed)

```mermaid
sequenceDiagram
    actor U as Operator
    participant W as Web tier
    participant FS as Filesystem
    participant DB as Postgres

    U->>W: POST /api/runs/[id]/promote
    W->>DB: lookup run + workspace + project
    W->>W: verify readiness gates current/pass/overridden
    alt mode = local_merge
        W->>FS: git -C {repo_path} checkout {target_branch}
        W->>FS: git -C {repo_path} merge --no-ff {workspace.branch}
    else mode = pull_request
        W-->>U: 422 CONFIG<br/>(PR hosting not wired)
    end
    alt promotion succeeds
        FS-->>W: exit 0
        W->>DB: runs.status=Done, runs.ended_at=now
        W-->>U: 200 Done
    else conflict
        FS-->>W: non-zero exit
        W->>FS: git -C {repo_path} merge --abort
        W-->>U: 409 CONFLICT<br/>(run stays Review)
    end
```

### Reconciliation on startup (Designed)

Compares three sources of truth:

```mermaid
flowchart TD
    Start([web or supervisor boot]) --> Q1[runs table<br/>SELECT * WHERE status IN<br/>Running, NeedsInput]
    Start --> Q2[git worktree list per project]
    Start --> Q3[supervisor GET /sessions]
    Q1 --> Compare[compare three sets]
    Q2 --> Compare
    Q3 --> Compare
    Compare --> Each{for each Running row}
    Each --> Live{supervisor has<br/>live session?}
    Live -- yes --> OK[no action]
    Live -- no --> Cp{acp_session_id<br/>present?}
    Cp -- yes --> Recover[status=Crashed,<br/>surface Recover or Discard]
    Cp -- no --> Crash[status=Crashed,<br/>only Discard offered]
    Each --> NeedsInputIdle{NeedsInputIdle row<br/>with valid checkpoint?}
    NeedsInputIdle -- yes --> Keep[no action]
    NeedsInputIdle -- no --> Crash
```

> M19 ([ADR-033](../decisions.md#adr-033)) makes this reconcile **allow-list
> `Running`-only** and adds a grace guard plus a retry-safety split (read-only
> `check`/`judge` gate nodes re-dispatch; `cli` nodes crash). The
> "runs vs `git worktree list`" branch becomes the `worktree-gone → Crashed`
> classification. The full classifier and the GC lifecycle live in
> [`reconciliation-gc.md`](reconciliation-gc.md).

### Project-grouped active workspaces (Implemented)

```mermaid
sequenceDiagram
    participant L as Left rail
    participant W as Web tier
    participant DB as Postgres

    L->>W: render app layout
    W->>DB: select visible active runs with workspaces
    DB-->>W: Flow and scratch rows joined to project, executor, creator
    W->>W: map status from runs.status and scratch_runs.dialog_status
    W->>W: group by project and compute active counts
    W-->>L: RailWorkspaceGroup[]
    L-->>L: render project header, count, plus action, rows
```

Active workspace rows use `runs.status` for Flow rows and combine
`runs.status` with `scratch_runs.dialog_status` for scratch rows. Scratch
`WaitingForUser` is displayed as its own label even though the shared
`runs.status` remains `Running`.

### Garbage collection

A cron route GCs worktrees older than 7d in terminal state.

```mermaid
flowchart LR
    Cron[GET /api/cron/gc] --> Select[SELECT workspaces<br/>WHERE run.status IN Done, Abandoned<br/>AND run.ended_at < now - 7d<br/>AND removed_at IS NULL]
    Select --> Remove[git worktree remove --force]
    Remove --> Update[UPDATE workspaces SET removed_at=now]
    Update --> Done([next row])
```

### M19 preserve-then-prune GC (Designed)

M19 ([ADR-035](../decisions.md#adr-035)) replaces the single-step removal above
with a graceful, destructive-safe sweep delivered BOTH as a background
`globalThis`-singleton sweeper (`MAISTER_GC_SWEEP_INTERVAL_SECONDS`, default
3600) and the token-guarded cron route. The candidate select uses the
**effective deadline** so pre-0015 terminal runs (null `scheduled_removal_at`)
are still collected. Every removal is gated on preserve success; GC archives a
branch, it NEVER merges to main/target.

```mermaid
flowchart TD
    Sweep([sweeper tick or POST /api/cron/gc]) --> Select[SELECT workspaces<br/>WHERE removed_at IS NULL<br/>AND run.status IN Abandoned, Done<br/>AND COALESCE scheduled_removal_at,<br/>ended_at + MAISTER_GC_AGE_DAYS <= now]
    Select --> Porcelain[statusPorcelain --untracked-files=all]
    Porcelain --> Dirty{dirty?}
    Dirty -- yes --> Snap[git add -A && git commit --no-verify<br/>maister: GC snapshot of runId]
    Dirty -- no --> Div{logRange base..branch non-empty?}
    Snap --> Arch[git branch -f maister/archive/runId HEAD<br/>set archived_branch + archived_at]
    Div -- yes --> Arch
    Div -- no --> Nothing[nothing to preserve]
    Arch --> Ok{preserve ok?}
    Nothing --> Ok
    Ok -- yes --> Remove[removeOwnedWorktree force<br/>set removed_at]
    Ok -- no --> Skip[skip row, log WARN,<br/>retry next tick]
    Remove --> Done([next row])
```

### M19 worktree TTL color ramp (Designed)

Read models surface a derived `ttlState` for `Abandoned`/`Done` workspaces so
the portfolio rail, board, and run-detail can render a countdown to GC removal.
The effective deadline mirrors the GC sweep exactly:
`effectiveRemovalAt = scheduled_removal_at ?? (ended_at + MAISTER_GC_AGE_DAYS)`.

```mermaid
flowchart LR
    Now([render time now]) --> Eff[effectiveRemovalAt =<br/>scheduled_removal_at ?? ended_at + MAISTER_GC_AGE_DAYS]
    Eff --> Due{now >= effectiveRemovalAt?}
    Due -- yes --> Red[due: red]
    Due -- no --> Warn{now >= effectiveRemovalAt - MAISTER_GC_WARNING_DAYS?}
    Warn -- yes --> Amber[warning: amber]
    Warn -- no --> Green[active: green]
    Eff --> Arch{archived_at set?}
    Arch -- yes --> ArchInd[archived indication]
    Eff --> Pruned{removed_at set?}
    Pruned -- yes --> PrunedInd[pruned indication]
```

## Expectations

- Exactly one worktree per run, rooted at
  `.maister/<slug>/runs/<runId>/`; no cross-project bleed.
- `workspaces.worktree_path` is globally UNIQUE across all projects;
  enforced at the DB layer.
- Branch names are validated before reaching `git worktree add ... -b`; task
  runs are generated from server state and scratch runs may use a validated
  launch-time name.
- Launch can select `base_branch` and optional `target_branch`.
  `target_branch` defaults to `base_branch`; `base_branch` defaults to
  `project.default_branch`.
- Worktree creation records `base_branch`, `base_commit`,
  `branch`, `target_branch`, and promotion mode in the run ledger. Runs are not
  hard-coded to start from or promote to `main`.
- Worktree creation runs preconditions (clean parent, branch free,
  path free) BEFORE the `git worktree add` call; failure throws
  `PRECONDITION` with no filesystem side effect.
- Worktree shares `.git` with the parent repo at
  `projects.repo_path`; the parent is the single source of truth.
- Local promotion merge policy is `git merge --no-ff` ONLY; conflict always
  invokes `git merge --abort`, leaves the run in `Review`, and creates a
  manual-resolution assignment.
- Pull-request promotion is designed. The implemented route currently returns
  `CONFIG` for `pull_request` until repository-hosting integration is wired.
- Full Flow reconciliation across Next.js boot, supervisor boot, git worktrees,
  and live sessions is designed. Scratch recovery is implemented through the
  explicit recover route for crashed scratch sessions.
- GC removes worktrees of runs in `Done | Abandoned` older than 7 d;
  GC failures log and continue without setting `removed_at`.
- **(Designed, M19)** GC MUST select terminal candidates by
  `COALESCE(workspaces.scheduled_removal_at, runs.ended_at + MAISTER_GC_AGE_DAYS) <= now()`
  (default age 14 d) and MUST preserve before pruning: dirty tracked + untracked
  state is snapshot-committed onto `maister/archive/<runId>`, and
  `removeOwnedWorktree` runs ONLY when preserve succeeds. See
  [`reconciliation-gc.md`](reconciliation-gc.md).
- **(Designed, M19)** GC MUST NOT merge into main/target; preservation is the
  archive branch (+ optional push when `MAISTER_GC_ARCHIVE_PUSH=true`, default
  `false`) only.
- Workspace lifecycle ends at `Removed`; rows are NEVER hard-deleted —
  `removed_at` is set instead.
- Active workspace rail groups MUST include both `flow` and `scratch` runs
  visible to the current user and MUST keep task board queries filtered to
  `runs.run_kind = 'flow'`.
- Active workspace status labels MUST distinguish `Running`,
  `WaitingForUser`, `NeedsInput`, `NeedsInputIdle`, `HumanWorking`, `Review`,
  and `Crashed`; `WaitingForUser` is scratch-specific and maps from
  `scratch_runs.dialog_status` while `runs.status = 'Running'`.
- Each project group MUST expose a scratch launch `+` action with that project
  preselected and MUST show launched-by display when `runs.created_by_user_id`
  or legacy scratch creator metadata is available.
- **(Implemented, M11b)** The manual-takeover return reads the EXISTING worktree
  through read-only range ops (`logRange`/`diffRange`/`resolveBaseRef`) ONLY; it
  creates NO new branch/target/PR and performs no push, merge, or
  checkout-switch (the worktree is already on the run branch). A failed git op
  raises `CONFLICT`. See [`manual-takeover.md`](manual-takeover.md).

## Edge cases

- **`PRECONDITION`** — dirty parent repo (uncommitted changes), branch
  already exists, worktree path already exists.
- **Worktree path collision across projects** — globally UNIQUE
  enforcement at the DB layer.
- **Parent repo deleted** — reconciliation flags every active run on
  the project as `Crashed`; project transitions to a degraded state
  (Phase 2 will define).
- **`CONFLICT`** — `git merge --no-ff` exited non-zero. Run stays
  `Review`, worktree stays Active, parent repo is restored via
  `git merge --abort`.
- **`git worktree remove` fails** (locked worktree, missing dir) — GC
  logs and continues; row stays without `removed_at`. Operator can
  force-cleanup manually.
- **Concurrent promotions on the same `target_branch`** — current target trusts
  the parent repo is single-writer (one operator). Phase 2 may add a promotion
  queue.

## Linked artifacts

- ADRs: [ADR-011 Workspace lifecycle](../decisions.md#adr-011-workspace-lifecycle-via-git-worktree),
  [ADR-012 Local promotion merge policy](../decisions.md#adr-012-local-promotion-merge-policy-no-ff-abort-on-conflict).
- ERD: [`../db/runs-domain.md`](../db/runs-domain.md) (workspaces table).
- Related: [`runs.md`](runs.md), [`projects.md`](projects.md).
- Source: `web/lib/worktree.ts`; scratch recovery routes under
  `web/app/api/scratch-runs/[runId]/recover/`. Full Flow reconciliation remains
  designed.
