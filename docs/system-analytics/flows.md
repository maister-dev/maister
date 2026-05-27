# Flows domain

## Purpose

A **Flow** is a versioned plugin bundle that describes how to execute
one kind of task — bugfix, feature, spec-kit, review, etc. It ships as
a git repository with a manifest (`flow.yaml` v1), shipped CLIs, an
optional `setup.sh`, and a step-typed YAML DSL. MAIster orchestrates
the steps; it does NOT design Flows itself.

## Domain entities

- **Flow plugin** — git repo with `flow.yaml` at root. Pinned by tag.
- **Step** — one of four typed entries in the Flow's `steps[]`:
  `cli`, `agent`, `guard`, `human`.
- **Manifest** — parsed `flow.yaml`. Persisted to `flows.manifest`
  (jsonb).
- **Recommended executor** — optional pointer in the manifest. Lowest
  priority in the override chain ([`executors.md`](executors.md)).

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

### Install a Flow plugin (Designed M5)

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

### Step DSL execution model (Designed M7)

Steps run sequentially. A `human` step's `on_reject.goto_step` can loop
back to an earlier step, carrying the user's comments into
`comments_var`.

```mermaid
flowchart TD
    Start([Run launched]) --> S1[Step 1]
    S1 --> T{type?}
    T -- cli --> Exec1[exec command in worktree]
    T -- agent --> Acp1[supervisor POST /sessions<br/>spawn adapter]
    T -- guard --> Eval[parse cost/time/regex<br/>POC: metric-only]
    T -- human --> Form[render form_schema in UI<br/>wait for response]
    Exec1 --> Next
    Acp1 --> Next
    Eval --> Next
    Form --> Verdict{accepted?}
    Verdict -- yes --> Next[Step N+1]
    Verdict -- no, on_reject.goto_step --> Loop[jump to target step<br/>+ inject comments_var]
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
    B["Project per-flow override<br/>maister.yaml flows().executor_override"] -->|else| Resolved
    C["Project default<br/>default_executor"] -->|else| Resolved
    D["Flow recommended<br/>flow.yaml recommended_executor"] -->|else| Resolved
    Resolved["Resolved executor"] --> Check{registered?}
    Check -- no --> Err["throw MaisterError EXECUTOR_UNAVAILABLE"]
    Check -- yes --> OK["supervisor POST /sessions"]
```

## Expectations

- A Flow plugin is identified by `{id}@{tag}`; install is idempotent on
  that tuple and the cache at `~/.maister/flows/<id>@<tag>/` is
  immutable once written.
- `flow.yaml` is parsed exactly once at install and persisted verbatim
  to `flows.manifest` (jsonb); runtime NEVER re-reads `flow.yaml`.
- `flow.yaml schemaVersion: 1` mismatch refused with `CONFIG` BEFORE
  any filesystem side effect.
- `steps[]` ids are unique within a Flow; duplicates refused with
  `CONFIG`.
- Step types are exactly `cli | agent | guard | human`; unknown type
  refused with `CONFIG`.
- Steps execute sequentially in declaration order; no parallelism on
  POC.
- `agent` step MUST declare `mode`; `human` step MUST declare
  `form_schema`; `guard` step MUST declare at least one of
  `cost | time | regex` — else `CONFIG`.
- `on_reject.goto_step` MUST resolve to an earlier step `id`; jumps to
  a later or missing step refused with `CONFIG`.
- `setup.sh` runs exactly once per `{id}@{tag}` install.
- Executor resolution for every `agent` step is total — produces a
  registered executor or fails with `EXECUTOR_UNAVAILABLE`.
- Guard caps (`cost | time | regex`) are parsed and persisted as
  metrics ONLY on POC; no kill-on-cap (Phase 2).
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
- **`setup.sh` exits non-zero** → `FLOW_INSTALL` (502); manifest stays
  uninstalled.
- **Step output token cost exceeds guard cap (POC)** — metric only,
  no kill. Phase 2 adds enforcement.

## Linked artifacts

- ADRs: [ADR-010 Flow Engine v2](../decisions.md#adr-010-flow-engine-v2-plugin-packaging--step-dsl).
- Config reference: [`../configuration.md`](../configuration.md) §`flow.yaml v1`.
- ERD: [`../db/projects-domain.md`](../db/projects-domain.md) (flows table).
- Schemas: `web/lib/config.schema.ts` (zod step union).
- Source: `web/lib/config.ts` (`loadFlowManifest`).
