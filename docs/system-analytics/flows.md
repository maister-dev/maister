# Flows domain

## Purpose

A **Flow** is a versioned plugin bundle that describes how to execute
one kind of task — bugfix, feature, spec-kit, review, etc. It ships as
a git repository with a manifest (`flow.yaml` v1), shipped CLIs, an
optional `setup.sh`, and a step-typed YAML DSL. MAIster orchestrates
the steps; it does NOT design Flows itself.

## Domain entities

- **Flow plugin** — git repo with `flow.yaml` at root. Pinned by tag.
- **Flow package revision** — immutable installed revision of a Flow package,
  keyed by resolved commit SHA and manifest digest. Planned M10 makes this a
  first-class lifecycle object with trust, compatibility, setup, enablement,
  upgrade, rollback, and deprecation state.
- **Project Flow enablement** — project-level pointer to the Flow package
  revision new runs should use. Existing runs keep their snapshotted revision.
- **Step** — one of four typed entries in the Flow's `steps[]`:
  `cli`, `agent`, `guard`, `human`.
- **Manifest** — parsed `flow.yaml`. Persisted to `flows.manifest`
  (jsonb).
- **Recommended executor** — optional pointer in the manifest. Lowest
  priority in the override chain ([`executors.md`](executors.md)).
- **Gate** — planned Flow-distributed readiness decision over artifacts:
  command check, internal skill/command check, AI judgment, external
  CI/system check, required artifact, or human review.

## Step taxonomy

```mermaid
classDiagram
    class Step {
        +string id
        +'cli'|'agent'|'guard'|'human' type
    }
    class CliStep {
        +string command
        +Guard[] pre_guards?
        +Guard[] post_guards?
    }
    class AgentStep {
        +'new-session'|'slash-in-existing' mode
        +string prompt
        +Guard[] pre_guards?
        +Guard[] post_guards?
    }
    class GuardStep {
        +number cost?
        +number time?
        +string regex?
    }
    class HumanStep {
        +string form_schema
        +OnReject on_reject?
    }
    class OnReject {
        +string goto_step
        +string comments_var?
    }
    Step <|-- CliStep
    Step <|-- AgentStep
    Step <|-- GuardStep
    Step <|-- HumanStep
    HumanStep *-- OnReject
```

## Process flows

### Install a Flow plugin (Implemented)

```mermaid
sequenceDiagram
    participant W as Web tier
    participant FS as Filesystem
    participant GH as Git host
    participant CFG as lib/config
    participant DB as Postgres

    W->>FS: Cache hit? ~/.maister/flows/{id}@{tag}/
    alt cache hit
        FS-->>W: existing path
    else cache miss
        W->>GH: git clone --branch {tag} {source}<br/>--depth 1 into ~/.maister/flows/{id}@{tag}/
        alt clone fails
            GH-->>W: non-zero exit
            W-->>W: throw MaisterError(FLOW_INSTALL)
        end
    end
    W->>FS: symlink ~/.maister/flows/{id}@{tag}/ -><br/>.maister/{slug}/flows/{id}/
    W->>CFG: loadFlowManifest(.../flow.yaml)
    CFG-->>W: parsed manifest
    W->>DB: INSERT flows row<br/>{ projectId, flowRefId, source, version, installedPath, manifest, schemaVersion }
    opt setup script present
        W->>FS: spawn ./setup.sh (one-time)
    end
```

### Package lifecycle (Planned M10)

```mermaid
stateDiagram-v2
    [*] --> Discovered: source + version declared
    Discovered --> Installing: operator reviews metadata
    Installing --> Installed: clone + validate + digest
    Installing --> Failed: clone/setup/validation failed
    Installed --> Enabled: trust + compatibility pass
    Enabled --> UpdateAvailable: newer chosen version detected
    UpdateAvailable --> Installing: install new revision
    Enabled --> Deprecated: operator marks old
    Enabled --> Disabled: operator disables for new runs
    Deprecated --> Disabled
    Disabled --> Enabled: rollback or re-enable
    Disabled --> Removed: no runs reference revision
    Failed --> Removed
```

### Step DSL execution model (Partly implemented)

Steps run sequentially. The `on_reject.goto_step` loop is designed; today
`human` responses are captured and the runner continues to the next step.

```mermaid
flowchart TD
    Start([Run launched]) --> S1[Step 1]
    S1 --> T{type?}
    T -- cli --> Exec1[exec command in worktree]
    T -- agent --> Acp1[supervisor POST /sessions<br/>spawn adapter]
    T -- guard --> Eval[parse cost/time/regex<br/>metric-only today]
    T -- human --> Form[render form_schema in UI<br/>wait for response]
    Exec1 --> Next
    Acp1 --> Next
    Eval --> Next
    Form --> Verdict{accepted?}
    Verdict -- yes --> Next[Step N+1]
    Verdict -- no, designed on_reject.goto_step --> Loop[jump to target step<br/>+ inject comments_var]
    Loop --> S1
    Next --> Done{more steps?}
    Done -- yes --> S1
    Done -- no --> End([Run complete])
```

### Executor override resolution

The executor for an `agent` step is the highest-priority match:

```mermaid
flowchart LR
    A["Run launcher override<br/>set at Launch click"] -->|wins| Resolved
    B["Task override<br/>tasks.executor_override_id"] -->|else| Resolved
    C["Project per-flow override<br/>maister.yaml flows().executor_override"] -->|else| Resolved
    D["Project default<br/>default_executor"] -->|else| Resolved
    E["Flow recommended<br/>flow.yaml recommended_executor"] -->|else| Resolved
    Resolved["Resolved executor"] --> Check{registered?}
    Check -- no --> Err["throw MaisterError EXECUTOR_UNAVAILABLE"]
    Check -- yes --> OK["supervisor POST /sessions"]
```

## Expectations

- A Flow plugin is identified at install time by its upstream **git
  commit SHA**, captured via `git rev-parse HEAD` after the
  tag-pinned clone. The system cache is keyed by the resolved SHA:
  `~/.maister/flows/<flow_ref_id>@<short_sha>/`. The directory is
  content-addressed and immutable once written — re-installing the
  same tag at a different commit (force-pushed tag, replaced tag)
  lands at a new directory, leaving the prior install untouched.
- **(Implemented)** A run executes against an immutable,
  content-addressed flow bundle. At launch the SHA is snapshotted into
  `runs.flow_revision`; the runner derives the bundle path from
  `(flows.flow_ref_id, runs.flow_revision)` via
  `systemCachePath` — **never** from the mutable
  `flows.installed_path` column. A flow upgrade is therefore safe even
  for runs in flight: the new install lands at a new SHA-keyed
  directory and existing runs keep reading their pinned directory.
  Local-source installs (file:// to a non-git directory, used by
  test fixtures) use the literal `"unknown"` sentinel as the
  revision; production flows are git-only.
- `flow.yaml` is parsed exactly once at install and persisted verbatim
  to `flows.manifest` (jsonb); runtime NEVER re-reads `flow.yaml`.
- **(Planned M10)** Package revisions are persisted separately from project
  enablement. A project may have several installed revisions of one Flow id,
  but only one enabled revision is used for new launches.
- **(Planned M10)** Install and upgrade are explicit product actions. Reading
  `maister.yaml` can discover a desired Flow source/version, but it must not
  silently trust, enable, run setup, or replace the project-enabled revision.
- **(Planned M10)** Package metadata includes source, version label, resolved
  revision, manifest digest, compatibility result, trust status, setup status,
  declared nodes, artifacts, gates, capabilities, external operation needs, and
  active run references.
- **(Planned M10)** Upgrade installs a new immutable revision beside the old
  one, validates compatibility, shows a diff of package contract changes, and
  then switches the project enablement only after user confirmation.
- **(Planned M10)** Rollback switches project enablement to an older installed
  revision. Active and completed runs continue to resolve the revision they
  snapshotted at launch.
- **(Planned M10)** Package removal is refused while any run references the
  revision. GC can remove only unreferenced disabled/failed revisions.
- `flow.yaml schemaVersion: 1` mismatch refused with `CONFIG` BEFORE
  any filesystem side effect.
- `steps[]` ids are unique within a Flow; duplicates refused with
  `CONFIG`.
- Step types are exactly `cli | agent | guard | human`; unknown type
  refused with `CONFIG`.
- Steps execute sequentially in declaration order; no parallelism today.
- `agent` step MUST declare `mode`; `human` step MUST declare
  `form_schema`; `guard` step MUST declare at least one of
  `cost | time | regex` — else `CONFIG`.
- `on_reject.goto_step` MUST resolve to an earlier step `id`; jumps to
  a later or missing step refused with `CONFIG`.
- `setup.sh` runs exactly once per `{id}@{tag}` install.
- Executor resolution for every `agent` step is total — produces a
  registered executor or fails with `EXECUTOR_UNAVAILABLE`.
- Guard caps (`cost | time | regex`) are parsed and persisted as
  metrics only; no kill-on-cap today (Phase 2).
- **(Planned)** Flow graph gates replace observational guard-only readiness.
  Gates ship with the Flow plugin, while project config supplies reusable
  command profiles, skill mappings, capability profiles, env profiles, and
  default limits.
- **(Planned)** Gate kinds are `command_check | skill_check | ai_judgment |
  external_check | artifact_required | human_review`; each gate has
  `mode: blocking | advisory` and status `pending | running | passed |
  failed | stale | skipped | overridden`.
- **(Planned M16)** `external_check` gates are satisfied through the
  token-authenticated operations API or the thin MCP facade. Reports become
  typed gate artifacts and participate in readiness, staleness, review, and
  promotion refusal like native gate results.
- **(Planned)** Internal skill/command gates, such as `/aif-review` or
  project QA/checklist skills, run through the same capability materialization
  and artifact recording path as AI nodes when they use an agent session.
- **(Planned)** Review and merge refuse when any required blocking gate is
  missing, pending, running, failed, stale, or skipped. Overrides require a
  declared human review decision and never delete failed evidence.
- Templating in `prompt` is Mustache-style and resolves session
  context, task fields, per-step output vars, and executor metadata.

## Edge cases

- **`schemaVersion: 1` mismatch in `flow.yaml`** → `MaisterError("CONFIG")` on load.
- **Duplicate step id within `steps[]`** → `CONFIG`.
- **`on_reject.goto_step` references a missing step id** → `CONFIG`.
- **`human` step without `form_schema`** → `CONFIG`.
- **`guard` step without any of `cost`/`time`/`regex`** → `CONFIG`.
- **`agent` step missing `mode`** → `CONFIG`.
- **`git clone --branch <tag>` fails** → `FLOW_INSTALL` (502).
- **Tag mutated upstream after install** — MAIster does NOT re-validate
  on each launch (cache hit short-circuits). Operator forces refresh by
  bumping the tag in `maister.yaml`.
- **Package revision disabled after launch** — in-flight runs keep using their
  snapshotted revision; only new launches are refused.
- **Package revision removed while referenced by a run** → `PRECONDITION`;
  referenced immutable revisions are retained.
- **Package requires unsupported MAIster engine/API/capability** → cannot be
  enabled; launch fails before workspace creation.
- **`setup.sh` exits non-zero** → `FLOW_INSTALL` (502); manifest stays
  uninstalled.
- **Step output token cost exceeds guard cap** — metric only,
  no kill. Phase 2 adds enforcement.

## Linked artifacts

- ADRs: [ADR-010 Flow Engine v2](../decisions.md#adr-010-flow-engine-v2-plugin-packaging--step-dsl).
- Package lifecycle: [`flow-packages.md`](flow-packages.md).
- Config reference: [`../configuration.md`](../configuration.md) §`flow.yaml v1`.
- ERD: [`../db/projects-domain.md`](../db/projects-domain.md) (flows table).
- Schemas: `web/lib/config.schema.ts` (zod step union).
- Source: `web/lib/config.ts` (`loadFlowManifest`).
