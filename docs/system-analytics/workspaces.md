# Workspaces domain

## Purpose

A **workspace** is the git worktree where a run executes. Every run
gets a fresh worktree under `.maister/<slug>/runs/<runId>/`, isolated
from other concurrent runs on the same project. Workspace lifecycle
covers creation, promotion, archival, and reconciliation on host or
process restart.

## Domain entities

- **Workspace row** — `workspaces` table. One row per run.
- **Worktree path** — absolute filesystem path, globally UNIQUE.
- **Branch** — derived as `<branch_prefix><task-slug>-<attempt>` (e.g.
  `maister/bugfix-login-button-3`).
- **Base branch** — branch selected at launch; the run branch is created from
  this branch's launch-time commit.
- **Target branch** — branch selected for promotion. Defaults to the base
  branch but can differ for engineer-controlled workflows.
- **Parent repo** — `projects.repo_path`. The worktree shares `.git`
  with the parent.
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

## Process flows

### Create a worktree (Implemented; branch targeting Planned)

```mermaid
sequenceDiagram
    participant W as Web tier
    participant FS as Filesystem
    participant DB as Postgres

    W->>DB: read project (repo_path, branch_prefix, default_branch)
    W->>W: baseBranch = launch.baseBranch ?? default_branch
    W->>W: targetBranch = launch.targetBranch ?? baseBranch
    W->>W: branchName = {branch_prefix}{task-slug}-{attempt}
    W->>W: worktreePath = .maister/{slug}/runs/{runId}/
    W->>FS: git -C {repo_path} rev-parse {baseBranch}
    W->>FS: git -C {repo_path} worktree add {worktreePath} -b {branchName} {baseBranch}
    alt git error
        FS-->>W: non-zero exit
        W-->>W: throw MaisterError(PRECONDITION)
    end
    W->>DB: INSERT workspaces { run_id, project_id, branch, base_branch, base_commit, target_branch, worktree_path, parent_repo_path }
```

### Promote on Review (Designed)

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
        W->>FS: git -C {repo_path} push {remote} {workspace.branch}
        W->>W: create/update PR {workspace.branch} -> {target_branch}
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
- **(Planned)** Launch can select `base_branch` and optional `target_branch`.
  `target_branch` defaults to `base_branch`; `base_branch` defaults to
  `project.default_branch`.
- **(Planned)** Worktree creation records `base_branch`, `base_commit`,
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
- Pull-request promotion creates or updates one PR from run branch to target
  branch and records the PR URL/number as artifacts and ledger events.
- Reconciliation runs on every Next.js boot AND every supervisor boot,
  comparing `runs`, `git worktree list`, and supervisor's live
  sessions.
- GC removes worktrees of runs in `Done | Abandoned` older than 7 d;
  GC failures log and continue without setting `removed_at`.
- Workspace lifecycle ends at `Removed`; rows are NEVER hard-deleted —
  `removed_at` is set instead.
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
- Source: planned `web/lib/worktree.ts`, `web/lib/reconcile.ts`.
