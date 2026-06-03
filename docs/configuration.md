[← Error Taxonomy](error-taxonomy.md) · [Back to README](../README.md)

# Configuration

Two layered manifests define how MAIster runs:

- **`maister.yaml` v2** — per-project: which executors, which Flow plugins,
  which default executor. Lives in the registered repo root.
- **`flow.yaml` v1** — per-Flow-plugin: the step DSL (cli / agent / guard /
  human), recommended executor, optional `setup.sh`. Lives in each
  plugin's git repo.

Plus environment variables for the server tier itself.

All validators live in `web/lib/config.ts` (zod schemas in
`web/lib/config.schema.ts`). Every failure path throws
[`MaisterError({ code: "CONFIG" })`](error-taxonomy.md).

## `maister.yaml` v2

```yaml
schemaVersion: 2
project:
  name: myapp
  repo_path: /repos/myapp
  default_branch: main        # default base/target branch
  branch_prefix: maister/     # default: maister/
promotion:
  mode: pull_request          # local_merge | pull_request
  remote: origin              # for pull_request mode
executors:
  - id: claude-sonnet
    agent: claude
    model: claude-sonnet-4-6
  - id: claude-glm-ccr
    agent: claude
    model: glm-4.6
    router: ccr               # optional: route via @musistudio/claude-code-router
  - id: claude-glm-env
    agent: claude
    model: glm-4.6
    env:                      # env-router: any Anthropic-compatible provider
      ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
      ANTHROPIC_AUTH_TOKEN: ${Z_AI_TOKEN}
  - id: codex-default
    agent: codex
    model: gpt-5-codex
default_executor: claude-sonnet
capabilities:
  mcps:
    - id: github
      source: project
      command: github-mcp-server
      agents: [claude, codex]
  skills:
    - id: aif-implement
      source: git
      url: github.com/org/aif-skills
      version: v1.0.0
      agents: [claude, codex]
  tools:
    - id: shell
      agents:
        claude: Bash
        codex: shell
      enforceability: enforced
  restrictions:
    - id: no-global-installs
      enforceability: instructed
  settings:
    - id: codex-default-step
      agent: codex
      source: project
      path: .maister/capabilities/codex-default/settings.json
  # Implemented (M14) — agent_definitions[] and env_profiles[] below
  agent_definitions:
    - id: claude-strict
      source: project
      agents: [claude]
  env_profiles:
    - id: prod-secrets
      source: project
      agents: [claude, codex]
flow_roles:
  - ref: maintainer
    label: Maintainer
    description: Human user, service, or internal agent that owns reviews
  - ref: qa
    label: QA
# Implemented (M14) — capability_imports[] block below
capability_imports:
  - id: aif-skills
    source: github.com/org/maister-aif-skills
    version: v1.0.0
  - id: custom-mcps
    source: github.com/org/maister-custom-mcps
    version: v2.1.0
    trust: explicit           # optional: "explicit" forces trust-confirm even for policy-trusted sources
flows:
  - id: bugfix
    source: github.com/org/maister-flow-bugfix
    version: v1.2.3
  - id: spec-kit
    source: github.com/org/maister-flow-spec-kit
    version: v0.4.1
    executor_override: claude-glm-ccr     # optional per-flow override
```

### Required fields

| Field | Rule |
| ----- | ---- |
| `schemaVersion` | Must be the integer `2`. Loader refuses on any other value. |
| `project.name` | Non-empty string. The `slug` is derived from this (kebab-case). |
| `executors[]` | At least one entry. Each `id` must be unique within the file. |
| `executors[].agent` | `claude` or `codex` only. Current adapters cover both. |
| `executors[].model` | Non-empty. Free-form — the adapter validates. |
| `default_executor` | Must reference an `id` present in `executors[]`. |
| `flows[].id` | Unique within the file. |
| `flows[].source` | Non-empty. Resolved by the Flow loader (`git clone --branch <version>`). |
| `flows[].version` | Tag-pinned (lock semantics). Non-empty. The tag is the user-facing pin; at install the loader records the resolved git commit SHA in `flows.revision` and at run launch snapshots it into `runs.flow_revision`. The runner derives the bundle path from `(flowRefId, flow_revision)`, so a tag re-pointed upstream after the run launched does not affect that run. |

### Optional fields

| Field | Default | Notes |
| ----- | ------- | ----- |
| `project.repo_path` | derived | Optional and ignored since [ADR-025](decisions.md#adr-025-project-repo-onboarding--url-clone-or-local-path-host-credential-auth-configurable-roots). `projects.repo_path` is the **resolved on-disk dir** (the clone target under `MAISTER_REPOS_ROOT`, or the existing local dir), not this manifest field. |
| `project.default_branch` | `main` | Default base branch for new runs and default target branch for promotion. `project.main_branch` remains accepted as a backwards-compatible alias until the branch-targeting migration lands. |
| `project.branch_prefix` | `maister/` | Run-branch prefix; combined with the slug. |
| `promotion.mode` | `local_merge` | Planned M18. `local_merge` merges the run branch into the target branch locally; `pull_request` creates/updates a PR from the run branch into the target branch. |
| `promotion.remote` | unset | Planned M18. Remote name used by pull-request mode. |
| `executors[].env` | `null` | Map of env vars passed to the spawned agent (env-router pattern). |
| `executors[].router` | unset | `ccr` enables `@musistudio/claude-code-router` multi-provider routing inside the session. |
| `flows[].executor_override` | unset | When set, must reference an `id` in `executors[]`. Persisted to `flows.executor_override_id` by `upsertExecutorsFromConfig()` and slots into the override chain at tier 3 (between task override and project default). |
| `flow_roles[]` | `[]` | M13 Flow routing registry. Each `ref` is project-scoped and may be used by `finish.human.role` or human-node `settings.roles[]`. Flow roles are not RBAC and never replace `project_members.role`. |

#### `capability_imports[]` (Implemented, M14)

The optional `capability_imports[]` block declares git-pinned capability
packages for the project. Each entry is fetched, trust-evaluated, and
(conditionally) set up during project registration.

```yaml
capability_imports:
  - id: aif-skills                  # SAFE_PATH_SEGMENT: /^[A-Za-z0-9._-]+$/
    source: github.com/org/aif-skills
    version: v1.0.0                 # tag-pinned (lock semantics); SAFE_PATH_SEGMENT
    trust: explicit                 # optional; forces trust-confirm UI even for
                                    # policy-trusted sources (default: follow policy)
```

| Field | Rule |
| ----- | ---- |
| `id` | Non-empty string matching `SAFE_PATH_SEGMENT` (`/^[A-Za-z0-9._-]+$/`). No `.`, `..`, or embedded `/`. Validated at Zod schema layer AND inside `systemCapabilityCachePath` (defence-in-depth). Unique within the file. |
| `source` | Non-empty git URL. Resolved by `installCapabilityRevision` (`git clone --branch <version>`). |
| `version` | Tag-pinned (lock semantics). Non-empty string matching `SAFE_PATH_SEGMENT`. Passed verbatim to `git clone --branch`. The resolved 40-hex SHA is captured and stored in `capability_imports.resolved_revision`. |
| `trust` | Optional. `"explicit"` overrides policy-trust and requires an operator confirmation via `POST /api/projects/{slug}/capabilities/{capabilityRefId}/trust` before `setup.sh` runs, even if the source prefix would be `trusted_by_policy`. |

**Path safety (R-PATH):** Both `id` and `version` are validated against
`SAFE_PATH_SEGMENT` at the schema layer (Zod `refine`) and again inside the
path builder `systemCapabilityCachePath` (the `assertFieldSafe` guard from
`web/lib/flow-paths.ts`). An import `id` of `../evil`, `..`, or `a/b` is
rejected at both layers and never reaches `~/.maister/capabilities/`. This
mirrors the existing `flowIdSchema` / `versionSchema` pattern (see ADR-043).

**Install lifecycle:** On project registration, each `capability_imports[]`
entry drives `installCapabilityRevision` (fetch → record SHA → resolve trust),
followed by `runCapabilityRevisionSetup` (trust-gated, physically separate).
The resolved import is then ingested into `capability_records` via
`upsertCapabilitiesFromConfig` (source `flow-package`). See
[`db/capabilities-domain.md`](db/capabilities-domain.md) and ADR-043.

**Config-state symmetry (R-SYM):** Removing an entry from `capability_imports[]`
disables the corresponding `capability_records` rows (`selectable=false`,
`disabled_at` set). Historic profile snapshots are not retroactively invalidated.

#### `capabilities.agent_definitions[]` and `capabilities.env_profiles[]` (Implemented, M14)

Two new arrays extend the existing `capabilities` block. Both follow the same
shape as `capabilities.mcps[]` / `capabilities.skills[]` but cover the
`agent_definition` and `env_profile` capability kinds.

| Array | Kind | Purpose |
| ----- | ---- | ------- |
| `capabilities.agent_definitions[]` | `agent_definition` | Named agent configuration profiles (e.g. a `claude-strict` settings profile). |
| `capabilities.env_profiles[]` | `env_profile` | Named environment variable profiles; the agent receives env-var **names** only — never stored in `material` nor written into the worktree. |

These kinds flow through the existing `resolver` / `materializer` generically.
`env_profile` MCP servers are delivered over ACP `newSession params.mcpServers`
carrying env-var **names** only; the supervisor resolves each name→value from its
own `process.env` at session start (ADR-044). No secret value is ever written to
disk or carried on the wire (R-SECRET).

### Planned Flow package lifecycle

M10 keeps `maister.yaml` as the project-desired Flow list but moves package
state into MAIster's database and UI. The file declares desired ids, sources,
version labels, and optional executor overrides. Runtime package records store
resolved revisions, manifest digests, compatibility results, trust decisions,
setup status, enablement, upgrade history, and rollback targets.

The important boundary: editing `maister.yaml` can propose a package install or
upgrade, but it does not silently trust, enable, run setup, or mutate active
runs. The operator reviews package metadata in the UI first. New runs use the
project's enabled package revision; active runs keep their snapshotted
`runs.flow_revision`.

### Capability registry for scratch runs and Flow profiles

Scratch runs use the first implemented subset of the capability model:
platform MCP servers from `.mcp.json` plus project-visible MCP servers, skills,
rules, and restrictions from `maister.yaml`. These records are persisted to
`capability_records` during project registration, selected in the scratch
launcher, and snapshotted into a run-scoped profile before the supervisor
session starts. Flow graph node settings capability refs are validated against
this registry at launch and resolved to concrete agent artifacts at runtime
(**Implemented, M14** — see ADR-041; capability config is delivered to the claude
agent via `<worktree>/.claude/settings.local.json` + ACP `newSession`
`params.mcpServers`, the corrected channel per ADR-044, after the CLI-flag
mechanism was disproven). The `instructed → enforced` flip remains **deferred**,
gated on the ADR-042 live-adapter spike. Public marketplace, organization policy,
and cross-project promotion stay deferred (Phase 2).

Each capability record has:

| Field | Purpose |
| ----- | ------- |
| `id` | Stable name referenced by Flow node settings. |
| `kind` | One of `mcp`, `skill`, `rule`, `tool`, `setting`, `agent_definition`, `env_profile`, `restriction`. |
| `source` | Launch source after normalization: `platform`, `project`, or `flow-package`. `maister.yaml` accepts `project`, `flow`, `git`, `local`, `system`, `platform`, and `flow-package`. |
| `version` / `revision` | User pin and resolved immutable revision when external. |
| `agents` | Supported executor agent ids, with optional concrete per-agent mapping. |
| `selectable` | Whether the record can be selected for future launches; CLEAR disables old rows without deleting historic profile snapshots. |
| `enforceability` | `enforced`, `instructed`, or `unsupported` for the selected executor. |

Runtime must snapshot the resolved capability profile into the run ledger before
an AI node starts. If a node requires strict enforcement but the selected
executor can only receive that capability as an instruction, launch fails rather
than silently weakening the boundary.

### Flow role registry

`flow_roles[]` is the M13 project-local registry for human-work routing labels.
It accepts:

| Field | Rule |
| ----- | ---- |
| `ref` | Required safe id (`A-Z`, `a-z`, digits, `.`, `_`, `-`). Unique within the project config. |
| `label` | Optional display label. Defaults to `ref` when persisted. |
| `description` | Optional operator-facing explanation. |

When a project declares at least one `flow_roles[]` entry, Flow install
validates every graph `finish.human.role` and human-node `settings.roles[]`
against that registry and rejects unknown refs with `CONFIG`. Removing a role
from `maister.yaml` archives the DB row; re-adding the same ref reactivates it.

For compatibility, omitted or empty `flow_roles[]` does not enforce existing
role annotations in older Flow packages. New M13 projects that use role-owned
queues should declare the registry explicitly.

For scratch runs, the web tier owns scoped materialization. V1 writes
`profile.json` and `instructions.md` into the run workspace/runtime area,
persists the profile snapshot, then calls the supervisor with
`capabilityProfilePath` and constrained `adapterLaunch.env` pointing at those
files. The supervisor does not read `maister.yaml` capability policy and does
not decide trust. Adapter-specific MCP config, settings files, and skill loader
wiring are designed follow-up work.

For a fresh per-node AI session, the Flow runner uses the same materializer. For
a long-living ACP session, those files are session-wide: every AI node inside
the session must use the same resolved capability profile. A Flow that needs a
different profile must declare a new session boundary, unless the adapter
supports an explicit safe profile-swap operation.

#### Capability adapter support matrix (Implemented snapshot + designed native activation)

| Capability kind | Claude | Codex | V1 contract |
| --------------- | ------ | ----- | ----------- |
| MCP | Persisted in `profile.json` and listed in `instructions.md`. | Persisted in `profile.json` and listed in `instructions.md`. | Snapshot + instruction handoff is implemented. Adapter-specific MCP config generation is designed, not implemented. Enforced unsupported entries are refused. |
| Skill | Persisted in `profile.json` and listed in `instructions.md`. | Persisted in `profile.json` and listed in `instructions.md`. | Snapshot + instruction handoff is implemented. Adapter-native skill loading is designed, not implemented; enforced unsupported entries are refused. |
| Rule | Persisted in `profile.json` and listed in `instructions.md`. | Persisted in `profile.json` and listed in `instructions.md`. | Instructed-only in V1. |
| Agent settings | Not materialized in V1. | Not materialized in V1. | Designed follow-up. Unknown enforced settings are refused. |
| Restriction | Persisted in `profile.json` and listed in `instructions.md`. | Persisted in `profile.json` and listed in `instructions.md`. | Enforced unsupported restrictions are refused; optional unsupported restrictions are downgraded only when recorded in the profile. |
| Tool / agent definition / env profile | Not activated directly. | Not activated directly. | Refused as enforced capabilities in v1. Optional entries become instructed-only only when the profile records the downgrade. |

### Planned external operations configuration

M16 external operations are configured from the MAIster UI and database, not
from `maister.yaml`. API tokens are service credentials; putting token secrets
or token hashes in a project repo would make rotation and audit worse.

Each API token record has:

| Field | Purpose |
| ----- | ------- |
| `id` | Internal stable identifier used for audit and gate reports. |
| `name` | Human-readable label shown in Project Settings. |
| `prefix` | Non-secret token prefix shown after creation for identification. |
| `secret_hash` | One-way hash of the token secret. The raw secret is shown once. |
| `project_id` | The only project the token can operate on. |
| `scopes` | Allowed operations: `tasks:create`, `tasks:read`, `tasks:update`, `runs:launch`, `runs:read`, `readiness:read`, `artifacts:attach`, `gates:report`. |
| `expires_at` | Optional expiry. Expired tokens fail closed. |
| `revoked_at` | Revocation timestamp. Revoked tokens fail closed. |
| `created_by` / `created_at` | Operator and time that created the token. |
| `last_used_at` | Last accepted request/tool call timestamp. |

The thin MCP facade uses the same token/scopes or a local session credential
that resolves to the same internal token actor. MCP configuration may expose the
MAIster API base URL and token to an agent process, but MCP never owns a
separate authorization model.

### Cross-reference checks

`loadProjectConfig()` runs these after schema validation:

1. `default_executor` must exist in `executors[].id`.
2. Every `flows[].executor_override` must exist in `executors[].id`.
3. No duplicate executor IDs; no duplicate flow IDs; no duplicate `capability_imports[].id`.
4. **(Implemented, M14)** Every Flow node settings capability reference
   (`mcps[]`, `skills[]`, `restrictions[]`, `settingsProfile`, `tools.{claude|codex}`)
   must resolve to a project, Flow-shipped, or system capability record. An
   unknown ref, or a ref present in the registry but not supported by the selected
   executor agent, throws `MaisterError({ code: "CONFIG" })`. This is the
   "carve-b" validation described in ADR-041.

Any failure throws `MaisterError({ code: "CONFIG" })` with the offending
field path in the message.

### Per-step executor override resolution

Highest priority wins. The chain is five tiers — per-task choice
beats per-flow rule:

1. **Run launcher override** (`POST /api/runs body.executorOverrideId`).
2. **Task override** (`tasks.executor_override_id`).
3. **Project per-flow override** (`flows.executor_override_id`, populated from `flows[].executor_override` in `maister.yaml`).
4. **Project default** (`projects.default_executor_id`, populated from `default_executor` in `maister.yaml`).
5. **Flow's `recommended_executor`** from `flow.yaml` (optional).

Implementation lives in `web/lib/executors.ts:resolveExecutor()` and is
called by `POST /api/runs`. The function is pure — no DB access, no
log side effects — and returns `{executorId, tier}`. Callers can pass
`override: undefined` to get the "computed executor for display" path
used by a task-card computed-executor badge.

If none of the above resolves to a registered executor, the resolver
throws `MaisterError({ code: "EXECUTOR_UNAVAILABLE" })` (HTTP 503).

## `flow.yaml` v1

The manifest each Flow plugin ships in its git repo.

```yaml
schemaVersion: 1
name: Bugfix
recommended_executor: claude-sonnet     # optional
setup: ./setup.sh                       # optional one-time install hook
# Optional M10 package contract (ADR-021): recorded + displayed as opaque
# metadata. Only `compat` + `schemaVersion` are ENFORCED at enablement;
# capabilities/gates/artifacts/external_ops gain runtime meaning in M11+.
compat:                                 # optional engine compatibility range
  engine_min: 1.0.0
  engine_max: 2.0.0
capabilities: [shell, edit]             # optional opaque string list
gates: []                               # optional opaque string list
artifacts: [diff, human_note]           # optional opaque string list
external_ops: []                        # optional opaque string list
steps:
  - id: plan
    type: agent
    mode: new-session                   # or slash-in-existing
    prompt: "/aif-plan {{ task.prompt }}"
  - id: lint
    type: cli
    command: pnpm lint
  - id: budget
    type: guard
    cost: 5                             # parsed and persisted, not enforced today
  - id: review
    type: human
    form_schema: ./schemas/review.json
    on_reject:
      goto_step: plan
      comments_var: review_comments
```

### Step types

Discriminated on `type`:

| Type | Required fields | Optional fields |
| ---- | --------------- | --------------- |
| `cli` | `id`, `type=cli`, `command` | `pre_guards`, `post_guards`, `retry_safe` |
| `agent` | `id`, `type=agent`, `mode=new-session\|slash-in-existing`, `prompt` | `pre_guards`, `post_guards`, `retry_safe` |
| `guard` | `id`, `type=guard` + at least one of `cost`, `time`, `regex` | `retry_safe` |
| `human` | `id`, `type=human`, `form_schema` (path to JSON schema with `schemaVersion`) | `on_reject.goto_step`, `on_reject.comments_var`, `retry_safe` |

`retry_safe` (boolean, default `false`) is also accepted on graph `nodes[]`. It
gates operator crash-recovery re-dispatch of a session-less node — a `Crashed`
run whose recover target is session-less (`cli`/`check`/`judge`/`guard`/`human`)
is redispatch-recoverable only when its config declares `retry_safe: true`;
`ai_coding` ignores it (recovered via `--resume`). See
[ADR-034](decisions.md#adr-034-crashed-run-recovery-semantics-hybrid---resume--re-dispatch-durable-marker-first-cap-re-admission)
and [`flow-dsl.md`](flow-dsl.md).

### Node `settings` (typed, M11c)

Every Flow graph node carries an **optional** typed `settings` block. The block
is discriminated on node type and replaces the M11a opaque passthrough — the
shape is now validated, not passed through verbatim. `settings` is OPTIONAL on
**every** node type: a node with no `settings` validates and runs unchanged, and
absence of `settings` NEVER triggers a launch refusal (back-compat). Settings
ride in the pinned `flow_revisions.manifest` — no separate file, env var, or
sidecar. Validation lives in `web/lib/config.schema.ts`; failures throw
`MaisterError({ code: "CONFIG" })`.

Status: the typed shape, node-level validation, the launch-time refusal
boundary, the `enforcement` evaluator, the `enforcement_snapshot` audit record,
and the time-limit watchdog are **Implemented (M11c subset)**. Capability-reference
resolution against the project registry (carve-b), agent-aware name mapping, and
per-session native materialization are **Implemented (M14)** — see
ADR-041 in [`decisions.md`](decisions.md). The materialized config reaches the
claude agent via `<worktree>/.claude/settings.local.json` + ACP `newSession`
`params.mcpServers` (the corrected channel per ADR-044; the CLI-flag
mechanism was disproven against `claude-agent-acp@0.37.0`). The
`instructed → enforced` flip remains **deferred**, gated on the ADR-042
live-adapter spike — no cell is flipped. See
[ADR-031](decisions.md) (typed settings) / [ADR-032](decisions.md) (refusal
boundary) and the frozen enforcement spec in
[`system-analytics/flow-settings.md`](system-analytics/flow-settings.md).

**`ai_coding` / `judge` settings** (agent-capability shape):

`judge` carries the same capability shape MINUS `executors`, `settingsProfile`,
`workspaceAccess`, and `artifactAccess` — those four are `ai_coding`-only (a
judge spawns an agent session but declares no executor allow-list, settings
profile, or workspace policy). The shared subset is `model`, `thinkingEffort`,
`mcps`, `tools`, `skills`, `permissionMode`, `limits`, `restrictions`, and
`enforcement`. `.strict()` parsing rejects any of the four `ai_coding`-only
fields on a `judge` node.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `executors` | `string[]` | **`ai_coding` only.** Each id MUST exist in `maister.yaml` `executors[]` (validated at launch against the project's executors[], M11c). |
| `model` | `string` | Free-form model override. |
| `thinkingEffort` | `low \| medium \| high` | Unknown value rejected. |
| `mcps` | `string[]` | Capability class. Registry resolution against `capability_records` at validate/launch is **Implemented (M14)**. |
| `tools` | `{ claude?: string[]; codex?: string[] }` | Per-agent tool map; malformed map rejected. Capability class. Registry resolution is **Implemented (M14)**. |
| `skills` | `string[]` | Capability class. Registry resolution is **Implemented (M14)**. |
| `settingsProfile` | `string` | **`ai_coding` only.** Named `agent_definition` capability reference. Registry resolution is **Implemented (M14)**. |
| `workspaceAccess` | `read \| write \| none` | **`ai_coding` only.** Capability class. |
| `artifactAccess` | `string[]` | **`ai_coding` only.** Artifact ids the node may read/write. |
| `permissionMode` | `ask \| allow \| deny` | Capability class. Unknown value rejected. |
| `limits` | `{ maxDurationMinutes?: number > 0; maxCostUsd?: number > 0 }` | Out-of-range rejected. `maxDurationMinutes` is the watchdog cap (below); `maxCostUsd` is record-only. |
| `restrictions` | `string[]` | Capability class. Registry resolution is **Implemented (M14)**. |
| `enforcement` | `{ mcps?; tools?; skills?; restrictions?; permissionMode?; workspaceAccess? }` | Per-class intent — see below. |

**`human` settings** (decision/role/takeover shape):

| Field | Type | Notes |
| ----- | ---- | ----- |
| `roles` | `string[]` | Eligible reviewer roles. Role refs are NOT validated against a registry in M11c (M13). |
| `assignees` | `string[]` | Specific assignees. |
| `decisions` | `string[]` | Each value MUST appear in the node's `transitions` (M11c). |
| `allowFurtherTracks` | `boolean` | Permit spawning further tracks. |
| `allowTakeover` | `boolean` | Permit manual takeover. |
| `slaHours` | `number > 0` | Out-of-range rejected. |
| `stalenessHint` | `string` | Hint surfaced when downstream goes stale. |
| `returnRequires` | `string[]` | Conditions required before returning. |

**`cli` / `check` settings** (command shape):

| Field | Type | Notes |
| ----- | ---- | ----- |
| `command` | `string` | Command to run. |
| `timeoutMs` | `number > 0` | Out-of-range rejected. |
| `environmentPolicy` | `inherit \| clean \| whitelist` | Unknown value rejected. |
| `inputArtifacts` | `string[]` | Artifact ids consumed. |
| `outputArtifacts` | `string[]` | Artifact ids produced. |
| `failureClass` | `blocking \| advisory \| retryable` | Unknown value rejected. |

#### `enforcement` intent + the static enforceability table

`settings.enforcement` declares, per capability class (`mcps`, `tools`,
`skills`, `restrictions`, `permissionMode`, `workspaceAccess`), how strictly the
class must hold:

| Value | Meaning |
| ----- | ------- |
| `strict` | The class MUST be enforced; launch refuses if the build cannot enforce it. |
| `instruct` | **Default.** The class is passed to the agent as an instruction. |
| `off` | The class is omitted from the verdict set. |

At launch, each `strict` class is checked against `ENFORCEABILITY_BY_AGENT` — a
**code constant** in `web/lib/flows/enforcement.ts` (NOT an env var, port, or
config-file path), keyed by `agent × capabilityClass`. In M11c every cell is
`instructed`, so any `strict` declaration is `refused` and launch throws
(`CONFIG`, or `EXECUTOR_UNAVAILABLE` once M14 flips cells). M14 only ever flips
`instructed → enforced`; the contract tightens, never loosens. The table and the
`evaluateNodeEnforcement` truth table are FROZEN in
[`system-analytics/flow-settings.md`](system-analytics/flow-settings.md) — that
file is canonical; do not duplicate them here.

The `limits.maxDurationMinutes` watchdog is agent-agnostic and inherently
enforced — it is NOT subject to the `strict`/`instruct` table. A run whose
elapsed exceeds the cap is terminated `Failed` via the supervisor's existing
`DELETE /sessions/:id`.

### Cross-reference checks

`loadFlowManifest()` runs:

1. No duplicate step IDs.
2. Every `on_reject.goto_step` must reference an existing step id.

`recommended_executor`, if present, is a non-empty string. Its existence in
the project's `executors[]` is validated at project-load time, not here —
the manifest can be loaded standalone for testing.

### Package contract + compatibility (M10)

`compat`, `capabilities`, `gates`, `artifacts`, and `external_ops` are optional.
They are parsed, digested into `flow_revisions.manifest_digest`, recorded in
`flow_revisions.contract`, and surfaced in the Flow Packages UI. Enablement and
launch ENFORCE only two compatibility checks (`web/lib/flows/engine-version.ts`):
the manifest `schemaVersion` must be in `SUPPORTED_FLOW_SCHEMA_VERSIONS`, and
`MAISTER_ENGINE_VERSION` must fall within `compat.engine_min..engine_max`.
Incompatibility surfaces as `CONFIG` (422). Semantic validation of the opaque
contract lists is deferred to the milestone that introduces each concept (see
[ADR-021](decisions.md#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility)).

**M11a engine bump (Implemented).** M11a bumps the `MAISTER_ENGINE_VERSION`
constant `1.0.0 → 1.1.0` in `web/lib/flows/engine-version.ts`
([ADR-026](decisions.md#adr-026-flow-graph-manifest-v1-nodes--engine-version-bump)).
This is a **code constant, not an env var** — there is no compose / `.env`
wiring for it. A Flow that uses the graph manifest (`nodes[]`) MUST declare
`compat.engine_min: 1.1.0`, so an older engine refuses it through the same
`engine_min..engine_max` check above. `SUPPORTED_FLOW_SCHEMA_VERSIONS` stays
`[1]` (the graph is additive — no `schemaVersion` bump).

**M12 engine bump (Designed).** M12 bumps `MAISTER_ENGINE_VERSION`
`1.1.0 → 1.2.0`. `GRAPH_MIN_ENGINE_VERSION` stays `1.1.0` — a graph-manifest
Flow still only needs `compat.engine_min: 1.1.0` to enable. The **declared-
artifact gate** is the new threshold: validating `input.requires` /
`output.produces` refs against the manifest's declared artifact ids AND
enforcing the `artifact_required` gate require `compat.engine_min ≥ 1.2.0`. A
Flow that declares typed produces/requires or an `artifact_required` gate but
sets `engine_min < 1.2.0` is refused through the same `engine_min..engine_max`
check above. `SUPPORTED_FLOW_SCHEMA_VERSIONS` stays `[1]` (additive).

**Default vs declared artifacts.** DEFAULT artifact recording — the run log,
guard metrics, the human/form answer, and the diff — is captured for **all
runs at engine 1.1.0 with no manifest changes**: every run records these
regardless of what the Flow declares. The DECLARED-artifact contract — typed
`output.produces` / `input.requires` validation plus the `artifact_required`
gate — is opt-in and requires `compat.engine_min ≥ 1.2.0`.

| Capability | Engine floor | Manifest changes | Scope |
| ---------- | ------------ | ---------------- | ----- |
| DEFAULT artifact recording (log, guard metrics, human/form answer, diff) | `1.1.0` | none | every run, always |
| DECLARED-artifact contract (typed `produces`/`requires` validation + `artifact_required` gate) | `1.2.0` | declare `output.produces` / `input.requires` / `artifact_required` | Flows that opt in |

### Guard semantics

`cost` / `time` / `regex` guard fields are parsed and evaluated as
observational signals. Guard results are written to
`.maister/<slug>/runs/<run-id>/guards.jsonl`. Cost guards compare
against token totals from `cost.jsonl` when the supervisor has emitted
usage records. Guards do not kill a run today; enforcement is Phase 2.

## `form_schema` versioning

Every HITL `human` step's form payload includes a required `schemaVersion`
integer. The runtime compares this against the version the agent step
expected; mismatch → `MaisterError({ code: "CONFIG" })`.

```ts
import { validateFormSchemaVersion } from "@/lib/config";

validateFormSchemaVersion(readBackJson, 1);   // ok if readBackJson.schemaVersion === 1
validateFormSchemaVersion(readBackJson, 2);   // throws CONFIG with both versions named
```

Schema shape:

```yaml
schemaVersion: 1
fields:
  - name: comment
    label: Reviewer comment
    type: string             # string | number | boolean | enum | array
    required: true
  - name: severity
    type: enum
    options: [low, medium, high]
  - name: confirm
    type: boolean
    default: false
```

Field types are limited to `string | number | boolean | enum | array`.
Add new types by extending `formFieldSchema` in
`web/lib/config.schema.ts`.

## Environment variables (server tier)

Read by Next.js (`web/`) and `supervisor/` at startup:

| Var | Required | Default | Used by |
| --- | -------- | ------- | ------- |
| `AUTH_SECRET` | yes | — | Auth.js v5 session JWT signing. Generate with `openssl rand -base64 33`. Must be identical across all web replicas. |
| `AUTH_URL` | no | derived from request host | Auth.js canonical origin (e.g. `https://maister.example.com`). Only needed when a reverse proxy rewrites the `Host` header in a way that breaks callback URLs. Leave blank in dev. |
| `SEED_ADMIN_EMAIL` | no | `admin@maister.local` | `pnpm db:seed` — email for the initial admin user. |
| `SEED_ADMIN_PASSWORD` | no | `maister-admin` | `pnpm db:seed` — password for the initial admin user. Change before any shared use. |
| `DB_URL` | yes | — | `lib/db/client.ts`; accepts `postgres://...` or `file:...` |
| `MAISTER_DB_POOL_MAX` | no | `10` | Postgres pool size in `lib/db/client.ts` |
| `MAISTER_MAX_CONCURRENT_RUNS` | no | `3` | Global concurrency cap (across all projects) |
| `MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS` | no | `60` | Web: periodic reconcile sweeper interval (M19) |
| `MAISTER_RECONCILE_GRACE_SECONDS` | no | `90` | Web: grace window before a no-live-session agent run is crashed (protects in-flight launches/recovers) (M19) |
| `MAISTER_GC_SWEEP_INTERVAL_SECONDS` | no | `3600` | Web: background GC sweeper interval (M19) |
| `MAISTER_GC_AGE_DAYS` | no | `14` | Web: age before Abandoned/Done worktrees + Removed flow revisions are GC'd (M19) |
| `MAISTER_GC_WARNING_DAYS` | no | `2` | Web: TTL warning window before removal (color ramp) (M19) |
| `MAISTER_GC_ARCHIVE_PUSH` | no | `false` | Web: push the `maister/archive/<runId>` branch to the remote during GC preserve (M19) |
| `MAISTER_CRON_TOKEN` | no (empty ⇒ `/api/cron/gc` returns 503 disabled) | (none) | **Server-only secret** for `GET`/`POST /api/cron/gc` auth — never logged or streamed (M19) |
| `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES` | no | unset (empty) | M10 Flow package trust policy (ADR-021). Comma-separated source-URL prefixes that are `trusted_by_policy` (auto-enabled on install). `local`/`file://` sources are always trusted by policy; every other git source is `untrusted` until an explicit per-(project, revision) trust confirmation. Read by the web tier (`web/lib/flows/trust.ts`) at install time. |
| `MAISTER_TRUSTED_CAPABILITY_SOURCE_PREFIXES` | no | unset (empty) | **Implemented (M14).** Comma-separated source-URL prefixes for `capability_imports[]` entries that are granted `trusted_by_policy` (auto-trusted on install, no explicit confirm required). Mirrors `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES` exactly — same prefix-match semantics, same `local`/`file://` always-trusted rule. Every other git source is `untrusted` until an operator calls `POST /api/projects/{slug}/capabilities/{capabilityRefId}/trust`. Setting `trust: explicit` on a `capability_imports[]` entry forces the confirm step even for policy-trusted sources. Read by `web/lib/capabilities/import.ts:resolveCapabilityTrust()`. See ADR-043. |
| `MAISTER_KEEPALIVE_MINUTES` | no | `30` | NeedsInput keep-alive window (minutes). Read by BOTH supervisor (pending-permission deferred timeout) AND web (sweeper expiry, activity-bump amount, useActivityPing heartbeat at half-window). Bumped by every `POST /api/runs/:runId/activity`. |
| `MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS` | no | `30` | M8 keep-alive sweeper tick frequency (seconds). The singleton timer in `web/lib/runs/keepalive-sweeper.ts` calls `runSweepTick()` every interval. Lower → snappier idle transitions; higher → less DB load. |
| `MAISTER_NEEDSINPUTIDLE_TTL_HOURS` | no | `24` | M8 NeedsInputIdle abandonment TTL (hours). Sweeper pass 2 flips `NeedsInputIdle` rows whose `checkpoint_at + ttl < now()` to `Abandoned` and closes any open `hitl_requests.respondedAt`. |
| `MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS` | no | `60` | M8 resume-prompt watchdog (seconds). After a `NeedsInputIdle` row is resumed via `--resume`, the runner-agent must receive `session.permission_request` within this window or `crashResumedRun` transitions the run to `Crashed`. (Helper exists; runner-agent enforcement is a follow-up patch.) |
| `MAISTER_PROJECTS_DIR` | no | unset | Auto-discovery root; every `maister.yaml` under this dir is registered on startup |
| `MAISTER_REPOS_ROOT` | no | `~/.maister/repos` | Root that `POST /api/projects` clones a `repoUrl` into (ADR-025). Resolved by `web/lib/instance-config.ts:reposRoot()`; surfaced read-only on `/settings`. |
| `MAISTER_WORKTREES_ROOT` | no | `~/.maister/worktrees` | Root for run worktrees (ADR-025). Resolved by `worktreesRoot()`. The deprecated `MAISTER_WORKTREE_ROOT` is accepted as a fallback. Surfaced read-only on `/settings`. |
| `MAISTER_SUPERVISOR_URL` | no | `http://localhost:7777` | Web → supervisor HTTP+SSE base URL — see [Supervisor](supervisor.md) |
| `MAISTER_SUPERVISOR_PORT` | no | `7777` | Supervisor bind port (read by `supervisor/src/main.ts`) |
| `MAISTER_RUNTIME_ROOT` | no | supervisor `cwd` | Root under which `.maister/<slug>/runs/...` is written |
| `MAISTER_HEARTBEAT_INTERVAL_MS` | no | `5000` | Supervisor orphan-child detection |
| `MAISTER_KILL_GRACE_MS` | no | `5000` | SIGTERM → SIGKILL grace per session |
| `MAISTER_SHUTDOWN_GRACE_MS` | no | `15000` | Total budget for graceful supervisor shutdown |
| `LOG_LEVEL` | no | `debug` (dev) / `info` (prod) | pino level for both web and supervisor |
| `ANTHROPIC_API_KEY` | yes for default | — | Claude executor (unless overridden by per-executor `env`) |
| `ANTHROPIC_BASE_URL` | no | api.anthropic.com | Per-executor `env` overrides the global default |
| `ANTHROPIC_AUTH_TOKEN` | no | uses `ANTHROPIC_API_KEY` | Required when `ANTHROPIC_BASE_URL` points at a third-party (z.ai GLM, OpenRouter, …) |
| `MAISTER_CCR_AUTH_TOKEN` | no | unset | Fallback for `ANTHROPIC_AUTH_TOKEN` when an executor has `router: ccr` and does not pin the token in `executor.env`. Missing token → `EXECUTOR_UNAVAILABLE` (503). |
| `MAISTER_CCR_CONFIG_PATH` | no | `/app/.ccr/config.json` in Docker, `~/.claude-code-router/config.json` otherwise | Container-side path the supervisor reads for CCR host+port. In compose this aligns with the bind-mount target — leave unset unless changing the layout. |
| `MAISTER_CCR_CONFIG_HOST_PATH` | no (Docker only) | `${HOME}/.claude-code-router` | Host directory bind-mounted at `/app/.ccr` (read-only) in the supervisor service. Point at a secret-mount directory for hardened deployments. |

Secrets MUST live in `.env` server-side. Never logged, never streamed via
SSE, never embedded in `session/update` payloads visible to the browser.

`.env.example` in the repo root documents the full set with safe placeholder
values.

## Authentication & RBAC

MAIster uses **Auth.js v5** (formerly NextAuth.js) with a **credentials
provider only**. OAuth providers are not configured in M9.

The implementation is split into two files to satisfy Auth.js's edge/node
boundary requirements:

- `web/auth.config.ts` — edge-safe: credentials provider slot + `jwt` /
  `session` callbacks (no DB). `web/middleware.ts` builds `NextAuth(authConfig)`
  to protect all `(app)` routes (redirect to `/login` when unauthenticated).
- `web/auth.ts` — Node.js runtime only: Drizzle adapter
  (`@auth/drizzle-adapter`) + credentials `authorize`, and a DB-backed `jwt`
  callback that re-reads `users.role` / `users.mustChangePassword` on every
  refresh and **invalidates the session (returns `null`) if the user no longer
  exists**. This keeps the JWT from outliving a role revocation.

**Admin bootstrap (seeded, not first-user).** A single default admin is created
by **migration `0005`** (`admin@maister.local` / `maister-admin`, bcrypt) so
every deployment has exactly one bootstrap admin after `pnpm db:migrate`. The
row carries `must_change_password = true`, so the well-known default password
**must be changed on first login** before any app access. `pnpm db:seed` is
idempotent with this (it reuses the existing admin by email). **Public
registration never grants admin** — registration creates `member` with
`account_status = pending`; this closes the concurrent-first-user admin-minting
race and requires an existing admin to activate the account.

**Admin user management.** Global admins use `/admin/users` and the
`/api/admin/users` REST routes to activate pending registrations, disable or
re-enable accounts, change global roles, and reset passwords. Password reset can
set `must_change_password = true`, forcing the user through `/change-password`
on next sign-in.

**DB-authoritative authorization.** `lib/authz.ts` re-reads the live `users.role`
and `users.account_status` from the database on every check (`getSessionUser` →
`requireGlobalRole` / `requireProjectRole`); the cached JWT role is **never**
trusted for an authorization decision. A demoted, disabled, or deleted user
loses authority on their next request, not at JWT expiry.

**Forced password change fails closed on APIs too.** The `(app)` layout redirects
`must_change_password` users to `/change-password`, AND every role-gated API
funnels through `requireActiveSession()` (inside `requireGlobalRole` /
`requireProjectRole`), which rejects a forced-change account with
`PASSWORD_CHANGE_REQUIRED` (403). So the seeded admin cannot call `POST /api/projects`,
`POST /api/runs`, task creation, or HITL response with the default password — the
page redirect is not the only gate. `requireSession` / `getSessionUser` stay
permissive so the change-password flow itself can run.

**Global roles** (`users.role`): `admin | member | viewer`. Enforced by
`lib/authz.ts:requireGlobalRole()`.

| Role | Capabilities |
| ---- | ------------ |
| `admin` | Register projects, approve/disable users, change global roles, reset user passwords, is implicit `owner` of every project. |
| `member` | Default. Can be added to projects; cannot register new projects. |
| `viewer` | Read-only access to projects they are explicitly added to. |

**Project roles** (`project_members.role`): `owner | admin | member | viewer`.
Enforced by `lib/authz.ts:requireProjectRole()` / `requireProjectAction()`.

| Role | Min action | Capabilities |
| ---- | ---------- | ------------ |
| `owner` | — | All actions including project archival. |
| `admin` | `editSettings` | Edit project settings. |
| `member` | `launchRun`, `operateScratchRun`, `promoteRun`, `createTask`, `answerHitl` | Launch Flow/scratch runs, operate scratch dialogs, promote run branches, create tasks, respond to HITL. |
| `viewer` | `readBoard`, `readScratchRun` | Read the board, active workspace metadata, scratch dialogs, and stream run events. |

Global `admin` users bypass the `project_members` table and are treated
as `owner` on every project. Source: `web/lib/authz.ts`.

**Middleware protection.** `web/middleware.ts` (Auth.js middleware) protects
all routes under `(app)/`. Unauthenticated requests are redirected to
`/login`. API routes additionally call `requireSession()` /
`requireProjectAction()` directly to enforce role checks and return
machine-readable `401 UNAUTHENTICATED` / `403 UNAUTHORIZED` JSON.

## Internationalization (EN/RU)

MAIster uses **next-intl** for bilingual EN/RU support.

- **Locale detection** (request.ts at `web/i18n/request.ts`): reads the
  `NEXT_LOCALE` cookie first; falls back to the `Accept-Language` request
  header; defaults to `en`.
- **Locale persistence**: the in-app language toggle calls the `setLocale`
  server action, which sets the `NEXT_LOCALE` cookie on the response.
  No URL-based locale prefix — locale is cookie-only.
- **Message catalogs**: `web/messages/en.json` and `web/messages/ru.json`.
  All user-visible strings must have entries in both files.
- **Server usage**: `import { getTranslations } from "next-intl/server"` in
  Server Components and Route Handlers.
- **Client usage**: `import { useTranslations } from "next-intl"` in Client
  Components.

There is no `NEXT_LOCALE` environment variable. The cookie name `NEXT_LOCALE`
is the next-intl default; ops documentation above records it for awareness.

## Public API

### `lib/config.ts`

| Export | Signature | Throws on |
| ------ | --------- | --------- |
| `loadProjectConfig(path)` | `(string) => Promise<MaisterYamlV2>` | Missing file, invalid YAML, schema error, cross-ref failure. All → `MaisterError({ code: "CONFIG" })`. |
| `loadFlowManifest(path)` | `(string) => Promise<FlowYamlV1>` | Missing file, invalid YAML, schema error, dup step ids, dangling `goto_step`. All → `MaisterError({ code: "CONFIG" })`. |
| `validateFormSchemaVersion(obj, expected)` | `(unknown, number) => void` | Malformed form schema OR version mismatch. → `MaisterError({ code: "CONFIG" })` with both versions in the message. |

### `lib/config.schema.ts`

Zod schemas + inferred types:

```ts
import {
  maisterYamlV2Schema, type MaisterYamlV2,
  flowYamlV1Schema, type FlowYamlV1,
  executorSchema, type ExecutorConfig,
  flowEntrySchema, type FlowEntry,
  stepSchema, type Step,
  formSchemaSchema, type FormSchema,
} from "@/lib/config.schema";
```

Import the inferred types in Route Handlers / components instead of
hand-rolling DTOs — the zod schema is the single source of truth.

## CCR (Claude Code Router) bundling

When an executor sets `router: ccr`, MAIster spawns the bundled
[`@musistudio/claude-code-router@2.0.0`](https://www.npmjs.com/package/@musistudio/claude-code-router)
daemon and routes the adapter through it for in-session multi-provider
routing (z.ai GLM, MiniMax, OpenRouter, …).

- The npm package is an exact-pinned **supervisor** dep — operators do
  NOT need to install `ccr` globally. The bin is on the workspace path.
- The supervisor owns the daemon lifecycle. The first `router=ccr`
  spawn lazily starts CCR; subsequent spawns within the same supervisor
  process reuse the same daemon; supervisor SIGTERM/SIGINT stops it.
- The daemon's own configuration file
  (`~/.claude-code-router/config.json`) is **user-managed**. MAIster
  reads `HOST` / `PORT` from it (defaults `127.0.0.1:3456`) but never
  writes the file. Provider keys, default models, routing rules — all
  in that file. In Docker, the host directory (default
  `~/.claude-code-router`, overridable via `MAISTER_CCR_CONFIG_HOST_PATH`)
  is bind-mounted **read-only** at `/app/.ccr` inside the supervisor
  container; the supervisor reads `/app/.ccr/config.json`.
- The adapter token sent in `ANTHROPIC_AUTH_TOKEN` resolves from
  `executor.env.ANTHROPIC_AUTH_TOKEN` ∨ `MAISTER_CCR_AUTH_TOKEN`
  (server env). Missing token surfaces as `EXECUTOR_UNAVAILABLE`
  (503).
- See [executors §CCR setup](system-analytics/executors.md#ccr-setup)
  for the full failure-mode table (config missing, malformed JSON,
  health-check timeout, token missing).

Example executor entry routing GLM-4.6 through CCR:

```yaml
executors:
  - id: claude-glm-ccr
    agent: claude
    model: glm-4.6
    router: ccr
    env:
      # Token consumed by the adapter (CCR currently accepts any non-empty
      # value because routing decisions live in config.json). The vendor
      # provider keys themselves go in ~/.claude-code-router/config.json,
      # NOT here. Placeholders only.
      ANTHROPIC_AUTH_TOKEN: ${CCR_ADAPTER_TOKEN}
```

Example `~/.claude-code-router/config.json` (placeholders — replace
with real values):

```json
{
  "HOST": "127.0.0.1",
  "PORT": 3456,
  "Providers": [
    {
      "name": "z.ai",
      "api_base_url": "https://api.z.ai/api/anthropic",
      "api_key": "<Z_AI_KEY_PLACEHOLDER>",
      "models": ["glm-4.6"]
    }
  ],
  "Router": {
    "default": "z.ai,glm-4.6"
  }
}
```

## Cost tracking on resume (M8)

Every line appended to `.maister/<projectSlug>/runs/<runId>/cost.jsonl`
by a supervisor session that was spawned via `--resume <id>` carries
`"resumed": true`. The marker is added in `supervisor/src/cost.ts`'s
`attachCost(opts)` from `opts.resumed = Boolean(parsed.resumeSessionId)`
at session creation time. The M0 spike measured ~$0.28 of
`cache_creation_input_tokens` per cross-process resume — keep-alive
saves this cost when the operator is paying attention. Ops can monitor
the tax via:

```sql
-- across runs, the cache-creation tokens paid as the cost of resuming
select sum((j->>'cache_creation_input_tokens')::int) as cache_tokens_paid_on_resume
from cost_lines  -- ingestion view derived from cost.jsonl
where (j->>'resumed')::boolean = true;
```

There is no control-plane decision branch on `resumed=true` — it is
observability only.

## See Also

- [Supervisor](supervisor.md) — the ACP daemon that consumes
  `executors[].env` + `executors[].router` and the supervisor-specific
  env vars listed above
- [Error Taxonomy](error-taxonomy.md) — `CONFIG` semantics; what the UI
  shows on each rejection
- [Database Schema](database-schema.md) — how `maister.yaml` registration
  writes `projects + executors + flows` rows
- [Architecture](../.ai-factory/ARCHITECTURE.md) — dependency rules
  enforced around `lib/config.ts`
