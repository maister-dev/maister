# ACP Runner Configurations

## Purpose

ACP runner configuration is the MAIster platform surface for deciding which
AI-coding agent the supervisor starts, how it is provisioned, which routing
sidecars it depends on, and how project/Flow defaults inherit from the platform
catalog.

This spec follows ADR-045. It separates three concepts:

- Platform ACP runners: named launch profiles operators select.
- Runner adapters: code-owned provisioners for adapter families such as
  `claude`, `codex`, future `gemini`, and future `opencode`.
- Router sidecars: platform-managed daemons such as CCR that runners may
  reference.

This is a local-only, pre-production installation today. Correct platform
runtime architecture is more important than preserving legacy local MAIster
state. The implementation may reset all MAIster-owned local DB/runtime/cache/
worktree/config state to land the right model cleanly. It must not delete
arbitrary user repositories without a separate explicit repo-removal action.

## Jobs To Be Done

- As a platform operator, I need one place to define runnable ACP profiles so
  projects do not duplicate launch details.
- As a platform operator, I need a required default runner so new projects and
  workspace launches have a deterministic starting point.
- As a project owner, I need to inherit the platform default or override it for
  my project without redefining runner internals.
- As a Flow maintainer, I need to declare the preferred AI-coding runner for a
  Flow or step and get a required remapping dialog when that runner is missing
  on this platform.
- As an operator launching a workspace, I need the launch dialog to start with
  the effective default and allow a one-run override.
- As a supervisor operator, I need CCR/router lifecycle, adapter readiness, and
  secret/env requirements to be visible before launch instead of failing after
  a worktree/session side effect.

## Actors

| Actor | Responsibility |
| --- | --- |
| Platform operator | Manages platform runners, router sidecars, defaults, and readiness. |
| Project owner | Chooses project default runner inheritance or override. |
| Flow maintainer | Ships recommended runner ids in Flow metadata. |
| Workspace launcher | Chooses a run-time override when needed. |
| Supervisor | Applies adapter provisioning, sidecar lifecycle, env/argv mapping, and cleanup. |

## Entities

### Platform ACP Runner

A platform ACP runner is a named launch profile. It stores:

- `id`, `name`, `description`, `enabled`.
- `runner_type`, currently `acp`; reserved for future non-ACP/headless CLI
  runner families.
- `adapter` id from the code-owned adapter registry.
- `model` and provider shape.
- `permission_policy` enum.
- Optional `router_instance_id`.
- Secret refs only, never raw values.
- Readiness state derived from adapter + sidecar + env validation.

### Runner Adapter

A runner adapter is not arbitrary user-created data in the first slice. It is a
code-owned registry entry with UI/API visibility:

- `id`: `claude`, `codex`, future `gemini`, future `opencode`.
- supported provider kinds and permission policies.
- required binaries and env refs.
- provisioner implementation.
- readiness/provisioning diagnostics.

Adapters may have a platform diagnostics screen/tab, but operators cannot create
new adapters from UI until a plugin/custom-adapter architecture exists.

Adapter provisioner responsibilities:

- `validateConfig(runner)`: static config validation.
- `evaluateReadiness(runner, sidecar, supervisorEnv)`: launch readiness.
- `buildProvisionPlan(context)`: files, ACP params, env refs, and cleanup plan.
- `buildSpawnIntent(context)`: normalized supervisor spawn intent.
- `cleanup(context)`: remove or restore adapter-owned materialization.

### Router Sidecar

A router sidecar is a platform-managed daemon instance such as CCR. It stores:

- `id`, `kind`, `name`, `enabled`.
- admin-editable typed command/preset, not arbitrary shell.
- config path and healthcheck endpoint.
- env/secret refs needed to start and authenticate.
- lifecycle mode and start/stop/refresh support where the sidecar supports it.
- readiness and last error.

Runners reference sidecars by id. The default operational model is one
`ccr-default` instance per supervisor host. Multiple instances are allowed only
when explicitly configured for distinct config paths/ports/providers.
Because this is pre-production, the UI should expose maximum typed flexibility
to admins: command preset, config path, port/base URL, healthcheck, env refs,
provider config refs, lifecycle mode, and usage references. It must still reject
raw shell strings and raw secret values.

## Inheritance And Runtime Resolution

| Level | Behavior |
| --- | --- |
| Platform default runner | Required. Must reference an enabled platform runner. |
| Project default runner | Inherits platform default when unset; can override with a platform runner id. |
| Platform Flow default runner | Inherits platform default when unset; can override per platform Flow. |
| Project Flow default runner | Inherits project default when unset; can override per project Flow attachment. |
| AI-coding Flow-step target ACP | Step-level target/recommended runner id. Must be resolved or remapped during Flow load/attach. |
| Workspace launch override | One-run override. Initial value is the effective default from project -> platform. |

Runtime resolution order:

1. Launch/workspace override.
2. AI-coding Flow-step target ACP.
3. Project Flow default runner.
4. Platform Flow default runner.
5. Project default runner.
6. Platform default runner.

If a referenced runner id is missing or disabled, MAIster refuses launch before
worktree/session side effects. Flow platform load and project Flow attachment
surface missing step targets as a required reconfiguration dialog, not as a
launch-time guess.

## Configuration Shape

```yaml
platform:
  default_runner: claude-code

router_instances:
  - id: ccr-default
    kind: ccr
    lifecycle: managed
    config_path: ~/.claude-code-router/config.json
    healthcheck_url: http://127.0.0.1:3456/health
    auth_token: env:MAISTER_CCR_AUTH_TOKEN

acp_runners:
  - id: claude-code
    adapter: claude
    model: claude-sonnet-4-6
    provider:
      kind: anthropic
    permission_policy: default

  - id: claude-code-ccr
    adapter: claude
    model: glm-5.1
    provider:
      kind: anthropic_compatible
    router_instance: ccr-default
    permission_policy: default

  - id: claude-code-dangerous
    adapter: claude
    model: claude-sonnet-4-6
    provider:
      kind: anthropic
    permission_policy: dangerously_skip_permissions

  - id: codex-zai-qwen
    adapter: codex
    model: qwen-coder
    provider:
      kind: openai_compatible
      base_url: https://api.z.ai/api/paas/v4
      api_key: env:ZAI_API_KEY
    permission_policy: default
```

Project and Flow references never duplicate runner internals:

```yaml
project:
  default_runner: inherit

flows:
  - id: bugfix
    runner: inherit
```

Flow package metadata can name step targets:

```yaml
nodes:
  - id: implement
    type: ai_coding
    runner_type: acp
    runner: claude-code-ccr
```

For Flow metadata, `runner_type` defaults to `acp`. For `runner_type: acp`,
`runner` references a platform ACP runner id or a Flow-package target id that
must be remapped during platform Flow load or project Flow attachment. This
keeps the door open for future `cli`/headless runner families without
overloading ACP terms.

## Source-Verified Adapter Constraints

The implementation must not guess runner support from provider marketing names:

- Claude Code exposes dangerous permission bypass as `--permission-mode
  bypassPermissions` / `--dangerously-skip-permissions`. MAIster stores a typed
  `permission_policy` and the Claude adapter provisioner maps it to the
  installed adapter's supported flag shape.
- Codex provider routing uses Codex configuration profiles with
  `model_provider`, `model_providers.<id>.base_url`,
  `model_providers.<id>.env_key`, optional provider headers/query params, and a
  Responses-wire setting where required by current Codex.
- z.ai GLM, Qwen, and other provider presets are ready only when the exact
  endpoint/model has been verified with Codex ACP. Chat Completions-compatible
  providers are not automatically Codex-compatible if the installed Codex route
  needs Responses-wire behavior.
- Unsupported provider/policy combinations remain visible as `NotReady` rather
  than being hidden or silently mapped to a different runner.

## UI Surfaces

### Platform Runtime Settings

The admin-only platform runtime settings area has three tabs:

- ACP Runners: CRUD for runner profiles, default selector, usage references,
  readiness, disable guard.
- Router Sidecars: CRUD for sidecar instances such as CCR, config/healthcheck
  fields, lifecycle state, readiness, usage references.
- Adapter Support: read-only adapter registry, supported policies/provider
  kinds, binary/source verification, and diagnostics.

### Project Settings

Project settings show default runner inheritance:

- inherit platform default.
- override with a platform runner.
- effective runner and readiness.

### Flow Load And Attach

Flow platform load and project Flow attach inspect AI-coding step target ACP
ids. Missing ids open a required remapping dialog with:

- original runner id from the Flow.
- affected Flow and step.
- select existing platform runner.
- option to set platform/project Flow default when appropriate.

### Workspace Launch

Workspace launch starts with the effective project -> platform default. The
operator may override the runner for that launch. The dialog shows the selected
runner readiness and inheritance tier. A not-ready runner cannot launch.

## API And Persistence Expectations

DB/API support is required for:

- platform ACP runners.
- platform default runner.
- platform router sidecar instances.
- project default runner refs.
- platform Flow default runner refs.
- project Flow default runner refs.
- Flow-step runner remapping records when a package target does not directly
  match a platform runner.

Recommended clean persistence shape:

- `platform_acp_runners`.
- `platform_router_sidecars`.
- platform runtime settings row with `default_runner_id`.
- project `default_runner_id`.
- platform Flow `default_runner_id`.
- project Flow attachment `default_runner_id`.
- Flow-step target/remapping records.
- run/workspace `runner_id`, `runner_resolution_tier`, and `runner_snapshot`
  JSON for audit, display, and recovery.

Adapters are exposed through API as a code-owned registry plus readiness
diagnostics. They are not CRUD rows in the first implementation slice.

Legacy project-scoped executor persistence is not a product compatibility
requirement for this slice. The final model should use platform runner
references directly. Local re-bootstrap is acceptable: drop/recreate MAIster DB
state, remove MAIster-owned runtime/cache/worktree/config artifacts, recreate
default platform runners/sidecars, and re-register projects.

Route and action side effects must use the existing two-phase pattern:

- Validate ids and refs.
- BEFORE: persist intended config/default/remapping.
- Side effect: readiness probe or sidecar lifecycle action.
- AFTER: persist readiness/lifecycle result.

Runner/sidecar list and configuration APIs are separate from readiness health.
Supervisor `/health` remains liveness/readiness and may include only a compact
adapter/sidecar availability summary. Adapter binary status, sidecar readiness,
required env refs, and launcher versions use dedicated typed diagnostics
endpoints.

## Readiness

A runner is ready only when:

- the runner is enabled.
- the adapter exists and supports the provider/policy combination.
- required adapter binary is available to the supervisor.
- all secret refs are present in the supervisor environment or secret store.
- referenced router sidecar is enabled and ready, when required.
- dangerous policy is verified for that adapter, not merely displayed.
- provider routing shape is verified for the adapter.

Readiness failures use existing `CONFIG` or `EXECUTOR_UNAVAILABLE` semantics.
The UI shows reason codes and does not expose secret values.

## Acceptance Criteria

- AC1: The platform has exactly one valid default ACP runner.
- AC2: Platform ACP runners are managed independently from projects.
- AC3: Router sidecars such as CCR are managed as separate platform resources
  and runners reference them by id.
- AC4: Adapter support is visible as a code-owned registry with readiness and
  provisioner diagnostics; adapters are not arbitrary UI-created entities.
- AC5: Project default runner inherits platform default and can override it.
- AC6: Platform Flow default runner inherits platform default and can override
  it.
- AC7: Project Flow default runner inherits project default and can override it.
- AC8: AI-coding Flow-step target ACP ids are validated during platform Flow
  load and project Flow attachment.
- AC9: Missing step target ACP ids require operator remapping and never silently
  fall back.
- AC10: Workspace launch initializes from effective project -> platform default
  and allows a one-run override.
- AC11: Supervisor launch uses typed adapter provisioners and typed sidecar
  lifecycle, not arbitrary shell/argv from UI.
- AC12: No raw secret values are stored in config, DB, API payloads, logs, or UI.
- AC13: A clean local "blast all MAIster-owned state" reset can recreate the
  instance with default platform runners/sidecars and no legacy executor model.
- AC14: Flow AI-coding metadata uses `runner_type` + `runner`; `runner_type:
  acp` resolves through the platform ACP runner catalog.
- AC15: Platform runtime CRUD/configuration is admin-only, with separate
  endpoints for runner/sidecar configuration and read-only diagnostics.
- AC16: Supervisor health is not the configuration API; detailed runtime
  diagnostics live on dedicated typed endpoints.
