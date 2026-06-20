# Docked AI authoring assistant (Flow Studio — M36 Phase 5)

> Behavior SSOT for the **docked AI authoring assistant**: a **project-less
> scratch-run ACP session rooted at a local-package working dir**. It reuses the
> scratch-run substrate end-to-end but has **no project and no managed git
> worktree** — the session's cwd and sole confinement root is the local
> package's `working_dir`. **Status: backend foundation Implemented (ADR-096);
> the right-panel AI tab, live refresh, and lock coordination are a separate
> task.** Related: [`local-packages.md`](local-packages.md),
> [`scratch-runs.md`](scratch-runs.md), [`runs.md`](runs.md),
> [`../decisions.md#adr-096`](../decisions.md).

## Purpose

The assistant lets a member, while editing a local package in Flow Studio, hand
authoring work to a coding agent: it edits the working-dir files directly
(`flows/ agents/ skills/ mcps/ rules/ schemas/`), the canvas/files live-refresh,
and permission/HITL prompts stream inline in the chat. It is **one ACP run per
editor tab**, lives while the tab is open, and surfaces its edits through the
same git diff → Commit/Discard the editor already exposes.

The hard constraint it introduces: a local package is platform-scoped — a
package-level fork has `project_id = NULL`; a per-project default fork carries a
`project_id`; the editor opens either. So the assistant run is **project-less**:
it cannot assume a project exists.

## Domain entities

- **Local package** — `local_packages` row (ADR-095). `working_dir` is the
  git-backed directory under `localPackagesRoot()`; server-only, never sent to
  the client. The assistant launches against an `active` package.
- **Assistant run** — a `runs` row with `run_kind = "scratch"`,
  **`project_id = NULL`**, **`local_package_id`** set (the launch snapshot),
  `flow_id`/`task_id`/`flow_revision_id` NULL, `flow_version = "scratch"`,
  `flow_revision = "manual"`. **No `workspaces` row.**
- **Scratch metadata** — a `scratch_runs` row with `project_id = NULL`,
  `local_package_id` set, `base_branch`/`base_commit`/`target_branch` read from
  the working dir's git HEAD, the usual `dialog_status`, supervisor session id,
  prompt/policy fields. The owner XOR is DB-enforced (see Data model).
- **Supervisor session** — a normal ACP session whose `cwd = working_dir` and
  whose content-block file-URI **confinement root is `working_dir`** (passed as
  `confineRoot`).
- **Capability profile** — a `scratch_capability_profiles` row materialized from
  a **bare** profile (no project capability catalog); the flow-authoring skill is
  seeded by the Studio surface, not the backend launch.

## Data model (migration 0057, ADR-096)

```mermaid
erDiagram
    local_packages ||--o{ runs : "local_package_id (snapshot, nullable)"
    local_packages ||--o{ scratch_runs : "local_package_id (owner, nullable)"
    projects ||--o{ runs : "project_id (nullable)"
    projects ||--o{ scratch_runs : "project_id (nullable)"
    runs ||--|| scratch_runs : "run_id"

    runs {
        text id PK
        text run_kind "scratch or flow or agent"
        text project_id FK "NULL for project-less assistant run"
        text local_package_id FK "set iff project-less; launch snapshot"
    }
    scratch_runs {
        text run_id PK
        text project_id FK "owner XOR local_package_id (DB CHECK)"
        text local_package_id FK "the project-less owner"
        text base_branch
        text base_commit
        text dialog_status
    }
```

- `scratch_runs_owner_xor_check`:
  `(project_id IS NOT NULL) <> (local_package_id IS NOT NULL)` — exactly one
  owner, never both, never neither.
- `scratch_runs_project_status_idx` is **partial** (`WHERE project_id IS NOT
  NULL`); `scratch_runs_local_package_idx` is the partial twin
  (`WHERE local_package_id IS NOT NULL`).
- `runs.project_id` nullable lets the project-less run exist; every project-scoped
  consumer narrows it through `requireRunProjectId` (throws `CONFIG` on a null) or
  excludes the run by query construction. See the consumer checklist in
  [`../decisions.md#adr-096`](../decisions.md).

## State machine

The assistant uses the existing scratch `dialog_status` machine unchanged — it
adds no status. A launch with an initial prompt lands `Running`; with no prompt
it lands `WaitingForUser`.

```mermaid
stateDiagram-v2
    [*] --> Starting: launchLocalPackageAssistant (insert rows)
    Starting --> Running: createSession + initial prompt sent
    Starting --> WaitingForUser: createSession, no initial prompt
    Running --> WaitingForUser: turn ends (end_turn)
    Running --> NeedsInput: agent requests permission (inline HITL)
    NeedsInput --> Running: user answers (member RBAC)
    WaitingForUser --> Running: user sends a message
    Running --> Crashed: prompt/session failure (no project-scoped emit)
    Running --> Review: stopped with edits to commit
    WaitingForUser --> [*]
    Review --> [*]
    Crashed --> [*]
```

## Process flow — launch

```mermaid
sequenceDiagram
    participant Editor as Studio editor (member)
    participant Web as Next.js (launchLocalPackageAssistant)
    participant DB as Postgres
    participant Sup as Supervisor

    Editor->>Web: launch (localPackageId, prompt)
    Web->>Web: requireActiveSession (member RBAC, ADR-095)
    Web->>DB: load local_packages (active) + platform-default runner
    Web->>Web: supervisor health + scratch capacity (flow pool)
    Web->>Web: read base branch/commit from working_dir git HEAD
    Web->>Web: materialize bare capability profile in working_dir
    Web->>DB: ONE tx — insert runs (project_id NULL, local_package_id) +<br/>scratch_runs (XOR owner) + initial message
    Web->>Sup: createSession(worktreePath=working_dir,<br/>confineRoot=working_dir, projectSlug=package slug)
    Sup-->>Web: { sessionId, acpSessionId }
    Web->>DB: persist acp_session_id + supervisor session id
    Web->>Sup: send initial prompt (if any)
    Web-->>Editor: { runId, dialogStatus }
```

Key launch invariants:
- **No `git worktree add`, no `workspaces` row.** The run executes in the
  existing git-backed working dir.
- **`runs.local_package_id` is written at the single launch insert** and is the
  decisive field every terminal/read path reads.
- **`projectSlug = local package slug`** names the runtime/cost subtree
  (`.maister/<slug>/runs/<runId>`); it is kebab-case + unique by construction
  and is NOT a project reference.
- The runner chain is launch-override → **platform default** (no project-default
  tier, since there is no project).

## Supervisor confinement

A `file:` content-block URI is confined to `confineRoot` (the working dir) ∪ the
run dir (uploads). `confineRoot`, when set, **replaces** the worktree ∪ repo
allow-set used by project runs. A URI outside the working dir — including a path
inside any project repo — is rejected with `PRECONDITION`. The web tier confines
too (defense in depth). Source: `supervisor/src/prompt-confinement.ts`,
`StartSessionRequestSchema.confineRoot`.

## Expectations

- Sending a message starts/continues an ACP session whose cwd is the working
  dir; agent file writes land in the working dir (the editor refreshes them).
- The run carries `project_id = NULL` and `local_package_id` set; the
  `scratch_runs` XOR CHECK guarantees exactly one owner.
- The assistant counts against the scratch (flow-pool) concurrency cap.
- A terminal transition (Crashed/Review/Abandoned) writes the `runs` +
  `scratch_runs` terminal rows but emits **no** project-scoped domain/webhook
  event (there is no project to attribute it to).
- No assistant session can write outside the working dir.

## Edge cases

- **Project-less run reaching a project-scoped path.** It cannot via any
  automatic sweep or project query (excluded by construction); a coding
  regression that routed one there throws `CONFIG` (`requireRunProjectId`)
  rather than NULL-dereferencing.
- **Reconcile.** A project-less run has `project_id = NULL`, so the per-project
  candidate scan never selects it — it is never marked Crashed for a missing
  project worktree (it has none). A live session is `skip`ped; reattach is
  refused for non-flow runs (so the resume-driver never drives it).
- **Diff / change-summary.** The project-scoped run diff + change-summary routes
  return 404 for a project-less run; the assistant's diff is the Studio editor's
  git-working-tree view (Phase 4).
- **Local package deleted.** `runs.local_package_id` / `scratch_runs.
  local_package_id` are `ON DELETE CASCADE`, so deleting a local package removes
  its assistant run history.
- **Lock coordination.** The assistant runs under the editor's working-dir lock
  (the editor is the lock holder; turn-based, so no concurrent writer). The lock
  acquisition/refresh + the AI tab UI are a separate task.

## Out of scope (separate task)

The right-panel Properties⇆AI tabs, live canvas/file refresh, inline HITL
rendering, the flow-authoring skill seeding, and the editor↔assistant lock
coordination. This doc + ADR-096 cover the **backend foundation**: the schema
(0057), the launch fan-out, the `run_kind` consumer fan-out, and the supervisor
working-dir confinement.
