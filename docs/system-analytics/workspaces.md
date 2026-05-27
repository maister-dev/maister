# Workspaces domain

## Purpose

A **workspace** is the git worktree where a run executes. Every run
gets a fresh worktree under `.maister/<slug>/runs/<runId>/`, isolated
from other concurrent runs on the same project. Workspace lifecycle
covers creation, merge, archival, and reconciliation on host or
process restart.

## Domain entities

- **Workspace row** — `workspaces` table. One row per run.
- **Worktree path** — absolute filesystem path, globally UNIQUE.
- **Branch** — derived as `<branch_prefix><task-slug>-<attempt>` (e.g.
  `maister/bugfix-login-button-3`).
- **Parent repo** — `projects.repo_path`. The worktree shares `.git`
  with the parent.

## Lifecycle state machine

```mermaid
stateDiagram-v2
    [*] --> Created: git worktree add
    Created --> Active: run promoted to Running
    Active --> Merged: git merge --no-ff succeeds<br/>run status=Done
    Active --> Stale: run terminal<br/>(Failed | Crashed | Abandoned)
    Stale --> Removed: GC cron after 7d<br/>git worktree remove
    Merged --> Removed: GC cron after 7d
    Active --> ConflictReview: merge conflict<br/>run stays Review
    ConflictReview --> Active: operator resolves<br/>and re-runs merge
    ConflictReview --> Stale: operator abandons
    Removed --> [*]
```

## Process flows

### Create a worktree (Designed M6)

```mermaid
sequenceDiagram
    participant W as Web tier
    participant FS as Filesystem
    participant DB as Postgres

    W->>DB: read project (repo_path, branch_prefix)
    W->>W: branchName = {branch_prefix}{task-slug}-{attempt}
    W->>W: worktreePath = .maister/{slug}/runs/{runId}/
    W->>FS: git -C {repo_path} worktree add {worktreePath} -b {branchName}
    alt git error
        FS-->>W: non-zero exit
        W-->>W: throw MaisterError(PRECONDITION)
    end
    W->>DB: INSERT workspaces { run_id, project_id, branch, worktree_path, parent_repo_path }
```

### Merge on Review (Designed M9)

```mermaid
sequenceDiagram
    actor U as Operator
    participant W as Web tier
    participant FS as Filesystem
    participant DB as Postgres

    U->>W: POST /api/runs/[id]/merge
    W->>DB: lookup run + workspace + project
    W->>FS: git -C {repo_path} checkout {main_branch}
    W->>FS: git -C {repo_path} merge --no-ff {workspace.branch}
    alt clean merge
        FS-->>W: exit 0
        W->>DB: runs.status=Done, runs.ended_at=now
        W-->>U: 200 Done
    else conflict
        FS-->>W: non-zero exit
        W->>FS: git -C {repo_path} merge --abort
        W-->>U: 409 CONFLICT<br/>(run stays Review)
    end
```

### Reconciliation on startup (Designed M6)

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

### Garbage collection

A cron route GCs worktrees older than 7d in terminal state.

```mermaid
flowchart LR
    Cron[GET /api/cron/gc] --> Select[SELECT workspaces<br/>WHERE run.status IN Done, Abandoned<br/>AND run.ended_at < now - 7d<br/>AND removed_at IS NULL]
    Select --> Remove[git worktree remove --force]
    Remove --> Update[UPDATE workspaces SET removed_at=now]
    Update --> Done([next row])
```

## Expectations

- Exactly one worktree per run, rooted at
  `.maister/<slug>/runs/<runId>/`; no cross-project bleed.
- `workspaces.worktree_path` is globally UNIQUE across all projects;
  enforced at the DB layer.
- Branch name pattern is exactly `<branch_prefix><task-slug>-<attempt>`
  and is created with `git worktree add ... -b`.
- Worktree creation runs preconditions (clean parent, branch free,
  path free) BEFORE the `git worktree add` call; failure throws
  `PRECONDITION` with no filesystem side effect.
- Worktree shares `.git` with the parent repo at
  `projects.repo_path`; the parent is the single source of truth.
- Merge policy is `git merge --no-ff` ONLY; conflict always invokes
  `git merge --abort` and leaves the run in `Review`.
- Reconciliation runs on every Next.js boot AND every supervisor boot,
  comparing `runs`, `git worktree list`, and supervisor's live
  sessions.
- GC removes worktrees of runs in `Done | Abandoned` older than 7 d;
  GC failures log and continue without setting `removed_at`.
- Workspace lifecycle ends at `Removed`; rows are NEVER hard-deleted —
  `removed_at` is set instead.

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
- **Concurrent merges on the same `main_branch`** — POC trusts that the
  parent repo is single-writer (one operator). Phase 2 may add a merge
  queue.

## Linked artifacts

- ADRs: [ADR-011 Workspace lifecycle](../decisions.md#adr-011-workspace-lifecycle-via-git-worktree),
  [ADR-012 Merge policy](../decisions.md#adr-012-merge-policy-no-ff-abort-on-conflict).
- ERD: [`../db/runs-domain.md`](../db/runs-domain.md) (workspaces table).
- Related: [`runs.md`](runs.md), [`projects.md`](projects.md).
- Source: planned `web/lib/worktree.ts`, `web/lib/reconcile.ts`.
