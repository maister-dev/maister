# Flow packages domain

## Purpose

Flow packages are the distribution unit for MAIster delivery processes. This
domain covers package discovery, install, trust review, compatibility,
enablement, upgrade, rollback, deprecation, removal, and how runs stay pinned
to the exact immutable package revision they launched with.

**Status:** the runtime pinning primitives (`runs.flow_revision` snapshot +
content-addressed cache, `systemCachePath(flow_ref_id, revision)`) are
**Implemented** (M4–M8). The multi-revision model, lifecycle operations, trust
review, compatibility enforcement, and the Flow Packages UI are **M10** — see
[ADR-021](../decisions.md#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility)
for the decision, schema model, trust policy, and the microsoft/apm evaluation.

## Domain entities

- **Flow package** — logical delivery process identified by stable
  `flow_ref_id`, source, and human-facing version labels.
- **Package revision** — immutable installed source revision with resolved git
  SHA, manifest digest, install path, compatibility result, setup state, trust
  state, and package contract summary.
- **Project enablement** — project-level pointer to the package revision that
  new runs should use for a given Flow id.
- **Package contract** — declared nodes, artifacts, gates, capabilities,
  shipped skills/agents, setup hooks, optional migrations, external operation
  needs, and supported MAIster engine/API version range.
- **Package trust decision** — operator or policy decision that allows setup
  and enablement for a revision.
- **Package update** — candidate revision installed beside the currently
  enabled revision and compared before switch-over.

## State machine

The lifecycle is split into two distinct state spaces. A **package revision** is
immutable and globally shared across projects (`flow_revisions.package_status`),
so its states describe install/availability only. **Project enablement**
(`flows.enablement_state`) is per-project and describes which revision new runs
use. "One enabled revision per Flow id; older revisions stay available for
in-flight runs and rollback" lives in the enablement space, not the revision
space.

Global revision lifecycle (`flow_revisions.package_status`):

```mermaid
stateDiagram-v2
    [*] --> Discovered: source/version declared
    Discovered --> Installing: install requested (intent row, two-phase)
    Installing --> Installed: clone + validate + digest (AFTER-side marker; setup deferred)
    Installing --> Failed: clone/validation failed
    Installed --> Failed: setup.sh failed (run later, at trust+enable)
    Installed --> Removed: removeRevision (no run references + not enabled anywhere)
    Failed --> Removed
```

`setup.sh` is NEVER executed during install (it is arbitrary package code from a
possibly-untrusted source). It runs only after trust is established — at the
trusted-by-policy auto-enable, or at the explicit enable step — and a non-zero
exit transitions the revision `Installed -> Failed`.

Project enablement lifecycle (`flows.enablement_state`, per project):

```mermaid
stateDiagram-v2
    [*] --> Installed: revision installed for project (not yet enabled)
    Installed --> Enabled: enable (trusted + compatible + setup ok)
    Enabled --> UpdateAvailable: newer revision installed beside (upgrade)
    UpdateAvailable --> Enabled: enable candidate (switch-over)
    Enabled --> Disabled: disable for new launches
    Enabled --> Deprecated: mark current revision deprecated
    Deprecated --> Enabled: rollback / re-enable
    Disabled --> Enabled: rollback / re-enable
```

Enable/upgrade/rollback only move the project `enabled_revision_id` pointer and
refresh the denormalized cache; they never mutate an installed revision's bytes
or an in-flight run's pinned `runs.flow_revision_id`.

## Process flows

### Install or upgrade package

```mermaid
sequenceDiagram
    actor U as Operator
    participant UI as Web UI
    participant W as Web tier
    participant G as Git host
    participant CFG as Config loader
    participant DB as Postgres

    U->>UI: Add or upgrade Flow package
    UI->>W: source + version label
    W->>G: shallow clone, resolve SHA / digest
    W->>DB: INSERT revision<br/>package_status=Installing (intent, two-phase)
    W->>G: finalize clone + symlink (NO setup.sh — deferred)
    W->>CFG: validate flow.yaml + package contract
    CFG-->>W: manifest + digest + contract summary
    alt success
        W->>DB: UPDATE package_status=Installed<br/>setup_status=pending|not_required + digest + contract
    else clone/validate failure
        W->>DB: UPDATE package_status=Failed
        W-->>UI: FLOW_INSTALL {source,version,stage,command,exitStatus,output}
    end
    W-->>UI: show source, revision, digest,<br/>setup, capabilities, gates, risks
    U->>UI: Trust and enable
    UI->>W: enable revision for project
    W->>DB: trust + compatibility + schema check
    W->>G: run setup.sh (trust confirmed)
    alt setup ok
        W->>DB: setup_status=done, lock revision, UPDATE enablement pointer
    else setup failed
        W->>DB: package_status=Failed, refuse enable (PRECONDITION)
    end
    W-->>UI: package enabled (or setup-failed) for new runs
```

### Launch with pinned package revision

```mermaid
sequenceDiagram
    actor U as Operator
    participant W as Web tier
    participant DB as Postgres
    participant R as Runner

    U->>W: Launch task
    W->>DB: Read project Flow enablement
    W->>DB: Validate revision enabled/trusted/compatible/setup ok
    W->>DB: INSERT run with flow_revision
    W->>R: start run using immutable package path
```

### Rollback package

```mermaid
sequenceDiagram
    actor U as Operator
    participant UI as Web UI
    participant DB as Postgres

    U->>UI: Roll back Flow to older revision
    UI->>DB: List installed compatible revisions
    DB-->>UI: revisions + active run references
    U->>UI: Confirm rollback
    UI->>DB: Switch project enablement
    DB-->>UI: new runs use older revision
```

## Expectations

- Current M4 loader remains the low-level installer, but M10 adds product
  lifecycle state above it.
- Tags are user-facing pins. Resolved git SHA and manifest digest are runtime
  truth.
- Installed package revisions are immutable and can coexist for the same Flow
  id.
- New runs use the project-enabled package revision.
- Active and completed runs keep using the revision snapshotted into
  `runs.flow_revision`, regardless of later upgrade, rollback, disable, or
  deprecation.
- Package install validates manifest schema, package contract, compatibility
  range, declared capabilities, gates, artifacts, setup hooks, and external
  operation needs before enablement.
- Setup scripts are revision-scoped, idempotent, and run only after trust
  confirmation.
- Install/upgrade UI shows source, version, resolved revision, manifest digest,
  compatibility result, trust status, setup status, declared nodes, artifacts,
  gates, capabilities, shipped skills/agents, and active run references.
- Upgrade preview shows added, removed, and changed package contract elements.
- Rollback changes project enablement only. It does not mutate existing runs or
  delete the newer package revision.
- Package removal is refused while any run references the revision.
- Full marketplace, signatures, reputation, dependency solving, org-wide
  package policy, and automatic rollout remain deferred.

## Launch precondition refusals

At `POST /api/runs`, after resolving the project-enabled revision via
`flows.enabled_revision_id`, launch refuses before any workspace creation:

| Condition | `MaisterError` code | HTTP |
| --------- | ------------------- | ---- |
| `flows.enabled_revision_id` is null | `PRECONDITION` | 409 |
| `flows.enablement_state` in `{Disabled, Failed}` | `PRECONDITION` | 409 |
| `flows.trust_status = untrusted` | `PRECONDITION` | 409 |
| revision `setup_status` in `{pending, failed}` | `PRECONDITION` | 409 |
| engine/schema incompatible (`compat` vs `MAISTER_ENGINE_VERSION` / `SUPPORTED_FLOW_SCHEMA_VERSIONS`) | `CONFIG` | 422 |

On success the run snapshots `runs.flow_revision_id` (plus the existing
`flow_version` / `flow_revision` text columns) and the runner resolves the
manifest + install path from that pinned revision.

## Edge cases

- **Clone/fetch fails** -> `FLOW_INSTALL` with source, version, stage, exit
  status, and captured output.
- **Manifest invalid** -> `CONFIG`; package revision cannot be enabled.
- **Setup script exits non-zero** -> the revision transitions to
  `package_status='Failed'` (`setup_status='failed'`) and enable is refused with
  `PRECONDITION`. Setup runs only after trust (auto-enable for trusted-by-policy,
  or the explicit enable step), never during install.
- **Resolved revision differs for the same tag** -> install as a new immutable
  revision; do not overwrite the old revision.
- **Package requires unsupported MAIster engine/API/capability** -> revision
  is installed for inspection but cannot be enabled.
- **Launch references disabled/failed/untrusted package** -> `PRECONDITION`
  before workspace creation.
- **Remove referenced revision** -> `PRECONDITION`; keep revision until no run
  references it.
- **Rollback target incompatible with current project config** ->
  `PRECONDITION`; user must resolve config/capability mismatch first.

## Linked artifacts

- Decision: [`../decisions.md` ADR-021](../decisions.md#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility)
  — multi-revision model, trust policy, compatibility scope, microsoft/apm evaluation.
- Roadmap: [`../../.ai-factory/ROADMAP.md`](../../.ai-factory/ROADMAP.md) M10.
- DB schema: [`../database-schema.md`](../database-schema.md) (`flow_revisions`,
  `flows.*`, `runs.flow_revision_id`), migration `0006`.
- Flow DSL: [`../flow-dsl.md`](../flow-dsl.md) (manifest contract fields).
- Configuration: [`../configuration.md`](../configuration.md)
  (`MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES`).
- Web API: [`../api/web.openapi.yaml`](../api/web.openapi.yaml)
  (`/api/projects/{slug}/flow-packages/*`).
- Related domains: [`flows.md`](flows.md), [`projects.md`](projects.md),
  [`runs.md`](runs.md), [`external-operations.md`](external-operations.md).
