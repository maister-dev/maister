# Local packages (Flow Studio Phase C)

> Behavior SSOT for **editable local packages** — a platform-scoped, git-backed
> working directory a member authors/forks artifacts in, edits in Flow Studio
> under a session lock, and **cuts versions** from into the existing
> package-install substrate. **Status: Designed (ADR-095).** Surface:
> [`../screens/studio/README.md`](../screens/studio/README.md) §Local workspace +
> [`../screens/studio/editor.md`](../screens/studio/editor.md). Data:
> [`../db/projects-domain.md`](../db/projects-domain.md).

## Purpose

A **local package** is a platform-scoped working copy of a package: a mutable,
git-backed directory on the host that a member authors artifacts in (flows,
agents, skills, MCP templates, rules, schemas) or forks from an installed git
package, edits in Flow Studio, and **cuts immutable versions** from. A "cut"
reuses the *existing* installer (`installPackageRevision({ version: "local" })`)
to produce a `local-<digest>` `package_installs` revision that a project member
then attaches — so local packages plug into the same install → attach → run
pipeline as git packages (Variant B), without re-scoping the project-keyed
`authored_capabilities` drafts table.

Boundary: this domain owns the `local_packages` table, its working directory,
the session edit-lock, and the cut/move operations. It does NOT own the
install/attach/trust machinery (that is [`packages.md`](packages.md), reused) nor
git write-back to an upstream source (a PR from the fork branch — **Phase 2**).

## Domain entities

- **`local_packages`** (persisted — [`../db/projects-domain.md`](../db/projects-domain.md)):
  one row per local package, pointing at a `working_dir`. Carries fork lineage
  (`source_install_id`, `source_repo_url`, `source_ref`, `branch_name`), the most
  recent cut (`last_cut_install_id`), and the session lock (`locked_by_user_id`,
  `locked_by_session`, `lock_expires_at`).
- **Per-project default ("virtual") local package** (M36, ADR-095): a
  `local_packages` row with `is_default = true` and a non-NULL `project_id`. It
  is the landing spot for **element-level forks** — a member who forks one flow /
  skill / agent / rule out of an installed package does not name a package; the
  element drops into their project's single default, created on first use. The
  partial-unique index `local_packages_default_per_project`
  (`(project_id) WHERE is_default`) enforces at most one default per project; the
  FK is `ON DELETE CASCADE` (a deleted project drops its default). Named,
  platform-scoped local packages keep `project_id = NULL`, `is_default = false`.
- **Working directory** (`working_dir`, server-only): a git-backed dir under
  `localPackagesRoot()` holding `maister-package.yaml` + the kind dirs
  (`flows/ agents/ skills/ mcps/ rules/ schemas/`). Edited in place by the Studio
  file/graph editors.
- **Cut version**: an immutable `local-<digest>` `package_installs` row produced
  by the installer over a clean export of `working_dir`. A reused entity
  ([`packages.md`](packages.md)).
- **Session edit-lock**: a `(locked_by_session, lock_expires_at)` claim on a
  `local_packages` row; mirrors the `runs.keepalive_until` TTL pattern.
- **Reused**: `package_installs`, `project_package_attachments`, the installer,
  `resolveTrust`, the Phase B `FlowEditorTabs` seam, `lib/worktree.ts` git
  primitives, and the platform MCP catalog (`platform_mcp_servers`,
  [`mcp-management.md`](mcp-management.md)) the MCP-template editor sources from.

## State machine

Package lifecycle:

```mermaid
stateDiagram-v2
    [*] --> Active: create (git init) / fork (copy install + git init)
    Active --> Active: edit files (under lock) · cut version · move artifact
    Active --> Archived: archive
    Archived --> Active: unarchive
    Archived --> [*]: delete (rm working_dir)
    Active --> [*]: delete (rm working_dir)
```

Per-package session edit-lock:

```mermaid
stateDiagram-v2
    [*] --> Unlocked
    Unlocked --> Locked: open editor (acquire, session + TTL)
    Locked --> Locked: keep-alive refresh (extend TTL)
    Locked --> Unlocked: release (navigate away) or TTL expiry
    Locked --> ReadOnly: another session opens while lock live
    ReadOnly --> Unlocked: holder releases or TTL expiry
    Unlocked --> Locked: open after expiry (lazy stale-takeover)
```

## Process flows

Create from scratch, or fork an installed package (two grains, M36):

```mermaid
flowchart TD
    A[New local package] --> B[insert local_packages row]
    B --> C[scaffold working_dir + maister-package.yaml + kind dirs]
    C --> D[git init + initial commit on branch_name]
    D --> E[redirect to /studio/edit/:id/flow.yaml]

    F["Fork PACKAGE to local (POST /api/studio/packages/:ref/fork)"] --> G1[resolve :ref → newest install server-side]
    G1 --> G2["clean-copy ALL install working files (exclude .git) → fresh working_dir"]
    G2 --> H[record source_install_id + source_ref; name = ref-local]
    H --> D

    K["Fork ONE ELEMENT (POST /api/studio/packages/:ref/fork-element)"] --> K1["validate body projectId ∈ getAccessibleProjects (else 404, no write)"]
    K1 --> K2[ensure project default local package, race-safe]
    K2 --> K3["confine elementPath in SOURCE bundle + DEST working_dir"]
    K3 --> K4["copy EXACTLY that one element (flow dir / skill / agent .md / rule)"]
```

**Fork mechanism (finalized, M36):** a fork **copies the installed revision's
on-disk content** (`package_installs.installedPath`, server-only) excluding any
`.git`/VCS dir, then `git init`s the destination fresh — it does NOT re-clone the
upstream source or reuse its history (a clone-source variant was rejected: the
install bytes are already content-addressed and present, so a copy is
deterministic and credential-free). A package fork copies the whole bundle into
a NEW `<ref>-local` package; an element fork copies exactly one confined element
into the project's default. **Neither executes anything** — no `setup.sh`, no MCP
spawn. A missing/unreadable source bundle → `CONFIG`, nothing persisted.

**Element-fork project selection:** the element fork is the only fork that names
a project, because its destination is that project's default package. The
`projectId` is body-controlled, so it is validated against the caller's
`getAccessibleProjects(userId, role)` set (admin → all non-archived; member →
their memberships) — an unknown or inaccessible project is a 404 with no write,
and the default is never created. The package fork takes no project (its output
is platform-scoped and named).

**Default-package race ("create on first use"):** the first element fork for a
project has no default yet. The ensure step scaffolds + `git init`s a working
dir, then `insert(...).onConflictDoNothing()` on the partial-unique
`(project_id) WHERE is_default`; a concurrent racer that lost re-selects the
winner's row and `rm`s its own orphan scaffold — never a read-then-write SELECT
(no TOCTOU).

Edit + save under the lock:

```mermaid
sequenceDiagram
    participant U as User (session S)
    participant E as /studio/edit
    participant L as lock service
    participant FS as working_dir
    U->>E: open package P
    E->>L: acquire(P, S)
    alt free or expired
        L-->>E: locked by S (TTL)
    else live lock by other
        L-->>E: read-only (locked by other)
    end
    loop while editing
        E->>L: refresh(P, S) keep-alive
    end
    U->>E: save file f
    E->>L: assertHoldsLock(P, S)
    alt holds live lock
        E->>FS: atomic write, path-confined to working_dir
    else lock lost or expired
        E-->>U: CONFLICT (reload)
    end
```

Cut a version and (optionally) attach to a project:

```mermaid
sequenceDiagram
    participant U as Member (manageLocalPackages)
    participant C as cut-version route
    participant I as installer
    participant A as attachPackage
    participant DB as local_packages
    U->>C: cut-version(P, attachToProjectId?)
    opt attachToProjectId supplied
        C->>C: requireProjectAction(attachToProjectId, manageLocalPackages) + resolve slug/repoPath
    end
    C->>C: clean export of working_dir to tmp (exclude .git)
    C->>I: installPackageRevision(source=export, version=local)
    I-->>C: package_installs (local-digest, trusted_by_policy)
    C->>DB: stamp last_cut_install_id (AFTER-side marker)
    opt attachToProjectId supplied
        C->>A: attachPackage(projectId, packageInstallId)
        A-->>C: attached (setup.sh runs post-commit)
    end
    Note over C: finally → rm tmp export dir
```

The attach gate (`manageLocalPackages` on `attachToProjectId`) is evaluated
**before** the irreversible export+install, so an inaccessible attach target
never leaves a cut install behind. The tmp export dir is removed in a `finally`.

## Expectations

- A `local_packages` row MUST have a UNIQUE `slug`; its `working_dir` MUST
  resolve under `localPackagesRoot()` and MUST NEVER appear in any client
  response.
- Every file read/write/delete/move MUST resolve the artifact path within the
  row's `working_dir` (realpath containment; reject `..`, absolute paths,
  symlink escape, and any `.git/` path) → `MaisterError("PRECONDITION")` on
  violation, before any write.
- A write MUST be rejected with `MaisterError("CONFLICT")` unless the caller's
  session holds a live (non-expired) lock on the package.
- A lock MUST be acquirable only when the package is unlocked OR
  `lock_expires_at < now` (lazy stale-takeover); a live lock held by another
  session MUST yield a read-only editor and MUST NOT be stolen.
- Authoring (create/fork/edit/cut) MUST require only `requireSession`;
  **attaching** a cut version to a project MUST require project `member`
  (`manageLocalPackages`). Git-package install/attach/trust MUST stay
  admin-gated (unchanged).
- A fork MUST copy the source install's on-disk content **excluding any `.git`/
  VCS dir** and MUST `git init` the destination fresh; it MUST execute NOTHING
  (no `setup.sh`, no MCP). A missing/unreadable source bundle → `CONFIG`, nothing
  persisted.
- A package fork MUST copy the WHOLE bundle into a NEW `<ref>-local` package
  (recording `source_install_id` + `source_ref`). An element fork MUST copy
  EXACTLY ONE confined element into the caller-project's default package and MUST
  NOT copy the rest of the source.
- An element fork's body `projectId` MUST be validated against the caller's
  `getAccessibleProjects` set; an unknown/inaccessible project MUST be rejected
  (404) with NO write (the default MUST NOT be created).
- A project MUST have at most one `is_default` local package; "create on first
  use" MUST be race-safe via `insert(...).onConflictDoNothing()` on the
  partial-unique `(project_id) WHERE is_default` + re-select (never a
  read-then-write SELECT).
- "Cut version" MUST install from a clean export of `working_dir` (no `.git`/VCS
  metadata) via the existing `installPackageRevision({ version: "local" })`,
  producing a `local-<digest>` `package_installs` revision; it MUST NOT introduce
  a second install path.
- A cut MUST stamp `last_cut_install_id` only AFTER the install (and any attach)
  succeeds — the stamp is the durable "cut succeeded" marker, never written
  before the side-effect.
- Local working-dir sources MUST resolve to `trusted_by_policy`; `setup.sh` MUST
  NOT run during install and MUST run only post-attach (ADR-021).
- Deleting a `local_packages` row MUST remove its `working_dir`; orphaned dirs
  and abandoned `Installing` installs are NOT auto-GC'd (manual cleanup, owner
  decision).
- Phase C MUST NOT extend the authored kind enum (`rule|skill|flow`) and MUST NOT
  add a new `MaisterError` code (ADR-008 closed union).
- (Phase 2) PR-to-source is NOT implemented; `source_repo_url`/`source_ref`/
  `branch_name` are stored only to enable it later.

## Edge cases

- Path traversal / symlink escape / `.git/` write → `MaisterError("PRECONDITION")`
  (the confinement guard); no file is written.
- Concurrent edit: a second session opening a locked package gets a read-only
  editor; a save after the lock expired or was taken over →
  `MaisterError("CONFLICT")` ("reload").
- Invalid or missing working dir (manual deletion, bad scaffold) →
  `MaisterError("CONFIG")`.
- Cut-version crash windows (ADR-095), the irreversible export+install happening
  BEFORE the durable stamp/attach: **(a) export done, install not started** →
  only an orphan tmp dir (the `finally` rm covers the happy path), nothing
  persisted; **(b) install done, stamp not written** → an immutable
  content-addressed `package_installs` row exists but `last_cut_install_id` is
  stale — a re-cut reuses the identical install by digest and re-stamps (no
  duplicate, no leak); **(c) stamp done, attach pending** → the package is cut +
  recorded, only the attach did not happen — re-run with `attachToProjectId`, or
  attach later (`attachPackage` is itself one-tx with its own windows). No
  partial state is load-bearing.
- Fork crash: a fork is reads + one row insert; a death after the working-dir
  copy but before the insert leaves an orphan working dir (rolled back on a
  failed insert; otherwise cleaned manually like any orphan). The copy executes
  nothing, so there is no half-run side-effect.
- A cut of a flow-less package (e.g. an element-fork default holding only a
  skill) fails manifest validation at install (`flows` is `min(1)`) → `CONFIG`;
  add a flow before cutting.
- The lock holder's session dies → the lock simply expires at `lock_expires_at`;
  the next opener takes over lazily (no sweeper).

## Linked artifacts

- **ADRs:** ADR-095 (this domain), ADR-092 (unified Studio + editable-local-package
  direction), ADR-088 (package management), ADR-021 (fetch-then-execute trust
  separation) — see [`../decisions.md`](../decisions.md).
- **ERD:** [`../db/projects-domain.md`](../db/projects-domain.md),
  [`../database-schema.md`](../database-schema.md).
- **API:** [`../api/web.openapi.yaml`](../api/web.openapi.yaml)
  (`/api/studio/local-packages*` incl. `/files/{path}` CRUD + `/cut-version`;
  `/api/studio/packages/{ref}/fork` + `/fork-element`).
- **Reused behavior:** [`packages.md`](packages.md) (install/attach/trust),
  [`flow-studio.md`](flow-studio.md) (editor seam, fork),
  [`mcp-management.md`](mcp-management.md) (the MCP catalog the template editor
  sources from).
- **Source (Phase C):** `web/lib/local-packages/*` (incl. `fork.ts`,
  `service.ts` `ensureDefaultLocalPackage`/`cleanCopyExcludingGit`/
  `exportWorkingDir`/`stampLastCutInstall`),
  `web/app/api/studio/local-packages/*` (incl. `[id]/cut-version`),
  `web/app/api/studio/packages/[ref]/{fork,fork-element}/`,
  `web/app/(app)/studio/local/`, `web/app/(app)/studio/edit/[id]/`.
