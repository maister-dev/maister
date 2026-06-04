# Implementation Plan: Platform ACP runner configurations

Branch: feature/acp-launch-configurations
Created: 2026-06-03
Base: detached HEAD @ 6beebf3

## Settings

- Testing: yes. This changes platform configuration, Flow onboarding, project/Flow inheritance, launch override semantics, supervisor spawn mapping, DB persistence, and UI.
- Logging: verbose. Log runner ids, inheritance tier, Flow id, project id, readiness/refusal reason, and spawn-policy decisions. Never log tokens, env values, CCR config content, or raw secret refs.
- Docs: yes. Phase 0 is specs-first and blocks code.
- Branch note: this plan was created in a detached Codex worktree. No branch checkout/pull was performed.
- Deferred sibling plan: `.ai-factory/plans/feature-acp-configuration-ui.md` is intentionally set aside; it covers broader Agents/capabilities UI, not platform ACP runner configuration.
- Deployment status: only a local disposable MAIster install exists. Breaking
  DB schema changes, local data loss, and full local re-bootstrap are
  acceptable when they make the platform ACP model cleaner. A "blast all
  MAIster-owned state" reset is allowed for this feature. Do not spend scope on
  production-grade legacy executor migration/backfill unless a later rollout
  explicitly asks for it.

## Roadmap Linkage

Milestone: "Platform ACP runner configuration"
Rationale: MAIster needs a platform-level catalog of launchable ACP runners, with a platform default, project inheritance/override, platform Flow inheritance/override, project Flow inheritance/override, AI-coding step target validation, and launch-time workspace override.

Decision/spec baseline:

- `docs/decisions.md` ADR-045: platform ACP runners, adapter provisioners, and router sidecars.
- `.ai-factory/specs/acp-runner-configurations.md`: JTBD, journeys, UI/API/DB expectations, readiness, and acceptance criteria.

---

## Corrected Domain Model

ACP runners are configured at **platform level**, not owned by a single project.
A runner is a named launch profile that tells the supervisor what adapter to
spawn and how:

- `claude-code` direct.
- `claude-code-ccr` through Claude Code Router.
- `claude-code-dangerous` with a typed permission bypass policy.
- `codex-openai`.
- `codex-zai-glm`.
- `codex-qwen`.

Every project and Flow selection references one of these platform runner ids.

The domain has three platform runtime layers:

1. **ACP runners** are operator-managed launch profiles and carry project/Flow
   references.
2. **Runner adapters** are code-owned provisioners (`claude`, `codex`, future
   `gemini`, `opencode`) that validate, provision restrictions, build spawn
   intents, and clean up adapter-owned materialization.
3. **Router sidecars** are operator-managed platform daemons such as CCR.
   Runners reference sidecars by id; sidecars have separate DB/API/UI support.

Each runner also has a code-derived **capability agent identity**. Today it is
`claude` or `codex` and normally equals the adapter id. Future adapters may add
new identities. Capability resolution, Flow settings enforcement, and native
materialization must read this stable `capability_agent` from the adapter
registry/resolved runner snapshot, not from the retired project-scoped
`executors.agent` row.

### Ownership And Inheritance

| Level | Meaning |
| --- | --- |
| Platform default runner | Global default ACP runner, e.g. `claude-code`. Required. |
| Project default runner | References a platform runner. Inherits platform default when unset. Can be overridden per project. |
| Platform Flow default runner | Flow-level default in the platform Flow catalog. Inherits platform default when unset. Can be overridden when a Flow is loaded into the platform catalog. |
| Project Flow default runner | Per-project attachment override for a Flow. Inherits project default when unset. Can be overridden when a Flow is attached to a project. |
| AI-coding Flow-step target ACP | Step-level target/recommended runner reference from the Flow package. Must resolve to a platform runner or trigger reconfiguration dialog during platform Flow load / project Flow attachment. |
| Workspace launch override | Operator can override the resolved runner at launch. Initial selection is the effective default with priority project -> platform. |

### Runtime Resolution Chain

For an AI-coding workspace/run, MAIster resolves the runner with this allow-list
order:

1. Launch/workspace override selected in the run dialog.
2. AI-coding Flow-step target ACP, when present and valid.
3. Project Flow default runner override.
4. Platform Flow default runner override.
5. Project default runner.
6. Platform default runner.

If any referenced runner id is missing from the platform catalog, launch does
not guess. The operator must fix the mapping through the Flow reconfiguration
dialog or project/platform defaults UI.

## Problem Statement

Today the code models executors as project-scoped rows:
`{agent, model, env?, router?}`. That is not mature enough for platform
configuration:

- Runner definitions are repeated per project instead of managed once.
- There is no required platform default.
- Project/Flow inheritance is not explicit.
- Flow import cannot ask the operator to remap missing/recommended ACP targets.
- Workspace launch can choose an executor, but it does not start from the
  project/platform effective default hierarchy.
- Supervisor launch details are only partially typed; `adapterLaunch` exists,
  but platform operators cannot manage it safely from MAIster.

The missing product object is a **Platform ACP Runner** plus explicit
inheritance and reconfiguration flows.

## Current-State Map

Already implemented and should be reused where possible:

- `supervisor/src/spawn.ts` dispatches `claude -> claude-agent-acp`,
  `codex -> codex-acp`.
- `supervisor/src/types.ts` accepts `executor`, `adapterLaunch`,
  `mcpServers`, `resumeSessionId`, and `capabilityProfilePath`.
- `router=ccr` is implemented for Claude-like Anthropic-compatible routing:
  the supervisor starts CCR, injects `ANTHROPIC_BASE_URL=<ccr proxy>`, and
  requires `ANTHROPIC_AUTH_TOKEN`.
- `adapterLaunch.preArgs/postArgs/env` exists but is not platform-managed.
- `web/lib/executors.ts` has a project-scoped five-tier resolver. This must be
  replaced or wrapped by a platform-runner resolver with the corrected chain.
- `docs/system-analytics/executors.md` documents current project-scoped executor
  identity and must be rewritten into the platform runner domain.
- Existing task/project/scratch forms still expose project-scoped executors:
  `web/components/board/new-task-modal.tsx`,
  `web/app/api/projects/[slug]/tasks/route.ts`,
  `web/components/board/launch-button.tsx`,
  `web/app/api/runs/route.ts`,
  `web/components/scratch/scratch-launcher.tsx`, and
  `web/app/api/scratch-runs/launch-options/route.ts`.
- Existing project registration persists `maister.yaml executors[]` through
  `web/app/api/projects/route.ts`, `web/lib/config.schema.ts`, and
  `web/lib/executors.ts`. This must become platform-runner binding/remapping,
  not project-scoped runner creation.
- Existing read models join `runs.executor_id -> executors` for board/project
  active workspace display (`web/lib/queries/board.ts`,
  `web/lib/queries/project.ts`) and resume/load paths hydrate executor rows
  (`web/lib/flows/graph/runner-core.ts`, `web/lib/runs/resume.ts`). These must
  read `runner_id` plus `runner_snapshot` so completed/in-flight runs remain
  explainable after runner edits or disablement.

Implementation stance:

- This slice may replace the project-scoped executor model directly. It does
  not need a production-safe migration path for existing MAIster data.
- The implementation still needs a deterministic local reset/re-bootstrap path.
  It may clear all MAIster-owned local state: DB state, `.maister` runtime
  artifacts, MAIster caches, generated platform config, Flow/capability caches,
  seed/admin data, and stale worktrees. After reset, recreate default platform
  runners/sidecars and re-register projects.
- The reset boundary is "MAIster-owned state", not "the user's repositories".
  The command may remove MAIster-created worktrees/caches/config; it must not
  delete arbitrary source repositories unless the operator invokes a separate,
  explicit repo-removal action.
- Compatibility exists only where needed to keep implementation phases runnable
  inside the branch. It is not a product requirement after the final phase.

## Product Scope

Operators can manage platform ACP runners from MAIster:

- Create/edit/disable platform runner profiles.
- Choose the platform default runner.
- Configure Claude Code direct, Claude Code with CCR, Claude Code with
  permission bypass policy, Codex direct, Codex with verified provider routes
  such as z.ai GLM/Qwen.
- Configure platform router sidecar instances such as `ccr-default`, including
  config path, healthcheck, lifecycle state, secret refs, and usage.
- Inspect adapter support/readiness for `claude`, `codex`, and future adapter
  families. Adapter entries are code-owned diagnostics in this slice, not
  arbitrary user-created launch plugins.
- Configure project default runner by selecting a platform runner or inheriting
  the platform default.
- Configure platform Flow default runner when loading/importing a Flow into the
  platform catalog.
- Configure project Flow default runner when attaching a Flow to a project.
- Resolve missing/recommended Flow-step ACP references through a required dialog
  during platform Flow load or project Flow attachment.
- Override the ACP runner in workspace launch; initial value comes from project
  default when available, otherwise platform default.
- Remove task-level executor selection from task creation. A task captures
  intent and Flow only; one-run runner override belongs to the launch/workspace
  dialog.

Not implemented in this slice:

- New adapter families beyond Claude/Codex.
- Custom user-created adapter families.
- Arbitrary adapter binary paths or raw argv entry from the UI.
- Browser entry of raw API token values.
- Provider model catalog syncing. Model ids remain free-form strings.

## Proposed Config Shape

Phase 0 must finalize storage details. Intended platform config:

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
    capability_agent: claude
    model: claude-sonnet-4-6
    provider:
      kind: anthropic
    permission_policy: default

  - id: claude-code-ccr
    adapter: claude
    capability_agent: claude
    model: glm-5.1
    provider:
      kind: anthropic_compatible
    router_instance: ccr-default
    permission_policy: default

  - id: claude-code-dangerous
    adapter: claude
    capability_agent: claude
    model: claude-sonnet-4-6
    provider:
      kind: anthropic
    permission_policy: dangerously_skip_permissions

  - id: codex-zai-qwen
    adapter: codex
    capability_agent: codex
    model: qwen-coder
    provider:
      kind: openai_compatible
      api_key: env:ZAI_API_KEY
      base_url: https://api.z.ai/api/paas/v4
```

Project config references platform runners:

```yaml
project:
  default_runner: inherit # or claude-code-ccr

flows:
  - id: bugfix
    source: github.com/org/flow-bugfix
    version: v1.2.3
    runner: inherit # or codex-zai-qwen
```

Flow package metadata may contain step-level targets:

```yaml
nodes:
  - id: implement
    type: ai_coding
    runner_type: acp
    runner: claude-code-ccr
```

Rules:

- `runner_type` defaults to `acp` today. Keep it explicit in Flow metadata
  where practical so future `cli`/headless runner families do not overload ACP
  semantics.
- For `runner_type: acp`, `runner` references a platform ACP runner id.
- Runner ids must resolve against platform `acp_runners[]`.
- Adapter ids must resolve against the code-owned adapter registry.
- `capability_agent` is derived from the adapter registry/resolved runner and
  snapshotted on launch. It is not an arbitrary UI field.
- `router_instance` ids must resolve against platform `router_instances[]`.
- `inherit` is explicit where useful in UI, but can be omitted in YAML.
- Platform default is required and cannot be disabled while referenced as
  default.
- Flow-step runner ids are advisory/targeted but must be resolved during Flow
  platform load / project attachment. Missing ids trigger reconfiguration.
- Secret values are references (`env:NAME`), not literal tokens.

### Source-Verified Launch Implications

- Claude Code exposes `--dangerously-skip-permissions` and documents it as
  equivalent to `--permission-mode bypassPermissions`. MAIster stores this as
  `permission_policy: dangerously_skip_permissions`; the adapter provisioner
  decides whether the installed ACP adapter can pass `--permission-mode
  bypassPermissions` or must pass the legacy dangerous flag.
- Codex custom model routing is configured through Codex config profiles:
  `model_provider`, `model_providers.<id>.base_url`,
  `model_providers.<id>.env_key`, optional headers/query params, and
  `model_providers.<id>.wire_api = responses`. MAIster should generate an
  isolated Codex profile/CODEX_HOME materialization per runner launch instead
  of assuming project-local `.codex/config.toml` can override provider routing.
- z.ai GLM and Qwen are represented as provider candidates only after checking
  their exact endpoint shape. GLM docs currently show Chat Completions
  compatibility at `https://api.z.ai/api/paas/v4/`; Qwen Cloud documents a
  distinct Responses base URL. Because Codex currently requires Responses-wire
  providers, GLM/Qwen presets must remain `NotReady` until the adapter spike
  proves the selected endpoint works with Codex ACP.
- Router sidecar configuration is admin-only and intentionally flexible in the
  first slice: typed command preset, paths, ports, healthcheck, env refs,
  provider config refs, lifecycle mode, and start/stop/refresh actions. The UI
  must still avoid raw shell strings and raw secret values.
- Supervisor `/health` remains liveness/readiness. Runtime management uses
  dedicated endpoints for adapters, runners, sidecars, and diagnostics. Health
  may include a compact adapter/sidecar availability summary, but not the full
  CRUD/config payload.

### Existing Form And Read-Model Migration Map

- **Project registration:** `POST /api/projects` stops creating project-scoped
  executors from `maister.yaml executors[]`. Project config may reference
  platform runner ids for project default and Flow attachment defaults; missing
  references trigger the same remapping flow as Flow package runner targets.
- **New task form:** `NewTaskModal` and `POST /api/projects/[slug]/tasks` drop
  `executorOverrideId`; task rows no longer carry runner/executor override.
- **Task launch:** `LaunchButton` becomes or opens a launch dialog. The dialog
  receives the effective runner, readiness, and inheritance tier, and may send a
  one-run `runnerId` override to `POST /api/runs`.
- **Scratch launch:** `/api/scratch-runs/launch-options` returns `runners[]`,
  `defaultRunnerId`, readiness, inheritance tier, and safe secret-ref metadata.
  It no longer returns project-scoped `executors[]`, `defaultExecutorId`, or raw
  env-key hints that could be mistaken for configured secrets.
- **Project settings/read models:** `SettingsPanel`, `getProjectPageData`,
  board/portfolio active-workspace projections, run detail, resume, and Flow
  runners use `runner_id`, `runner_resolution_tier`, `runner_snapshot`, and
  `capability_agent` instead of joining `runs.executor_id -> executors`.
- **Usage references:** runner and sidecar management surfaces must query a
  single usage-reference service/index that includes platform default, project
  defaults, platform Flow defaults, project Flow defaults, step remaps, active
  runs/workspaces, and historical run snapshots.

## Contract Surface Map

| Surface changed | Spec file(s) to update |
| --- | --- |
| ADR/spec baseline | `docs/decisions.md` + `.ai-factory/specs/acp-runner-configurations.md` |
| Platform ACP runner catalog and platform default | `docs/configuration.md` + `docs/system-analytics/executors.md` |
| Platform router sidecar catalog and CCR lifecycle | `docs/configuration.md` + `docs/supervisor.md` + `docs/system-analytics/executors.md` |
| Adapter support registry and provisioner contracts | `docs/configuration.md` + `docs/supervisor.md` + `docs/system-analytics/executors.md` |
| Project default runner inheritance | `docs/configuration.md` + `docs/system-analytics/projects.md` |
| Project registration and project config runner bindings | `docs/configuration.md` + `docs/api/web.openapi.yaml` + `docs/system-analytics/projects.md` |
| Platform Flow default runner and project Flow default runner | `docs/system-analytics/flow-packages.md` + `docs/system-analytics/flows.md` |
| Flow-step target ACP validation/reconfiguration dialog | `docs/flow-dsl.md` + `docs/system-analytics/flows.md` |
| Task creation and launch-runner override forms | `docs/api/web.openapi.yaml` + `docs/system-analytics/runs.md` |
| Scratch launch runner selection payloads | `docs/api/web.openapi.yaml` + `docs/system-analytics/runs.md` |
| Runner capability identity and native materialization | `docs/system-analytics/flow-settings.md` + `docs/system-analytics/capabilities.md` + `docs/supervisor.md` |
| Runner/sidecar usage references and disable guards | `docs/system-analytics/executors.md` + `docs/database-schema.md` |
| Supervisor launch payload/mapping | `docs/supervisor.md` + `docs/api/supervisor.openapi.yaml` |
| Web API for platform runners, router sidecars, adapter diagnostics, and Flow reconfiguration | `docs/api/web.openapi.yaml` |
| DB persistence | `docs/database-schema.md` + `docs/db/projects-domain.md` + `docs/db/erd.md` |
| Deployment touchpoints for CCR/sidecars/env refs | `.env.example` + `docs/getting-started.md` + `compose.yml` + `compose.production.yml` |
| Local destructive reset/re-bootstrap | `docs/getting-started.md` + `web/lib/db/README.md` + reset script docs |
| UI strings | `web/messages/en.json` + `web/messages/ru.json` |
| Error/refusal behavior | `docs/error-taxonomy.md` |

## Architectural Decisions

- AD-1: Platform ACP runners are the canonical launch profiles. Project executors become references/overrides to platform runners, not independent launch definitions.
- AD-2: The platform must always have exactly one valid default runner.
- AD-3: Flow runner mappings are resolved at Flow load/attach time. Missing step targets trigger an operator dialog rather than silent fallback.
- AD-4: Runtime resolution is explicit and allow-listed: launch override -> step target -> project Flow default -> platform Flow default -> project default -> platform default.
- AD-5: Typed launch options, not arbitrary argv. Dangerous modes are explicit enum values with allow-listed adapter mappings.
- AD-6: Secret refs only. Platform config, project config, DB rows, API payloads, logs, and UI never contain raw provider tokens.
- AD-7: Supervisor is the only layer that turns a resolved runner into child process env/argv. Web resolves runner id and sends the normalized, validated spawn intent.
- AD-8: Router sidecars such as CCR are platform-managed resources with DB/API/UI support. ACP runners reference sidecar ids; sidecars are not embedded per-run scripts.
- AD-9: Adapter families are code-owned registry entries with UI/API diagnostics and readiness. Operators cannot create arbitrary adapters from UI in this slice.
- AD-10: Because no production MAIster data exists, implementation may use
  breaking DB/config rewrites plus a documented destructive local reset instead
  of maintaining legacy project-executor migration/backfill.
- AD-11: Task creation does not select runners. Tasks capture product intent
  and Flow; runner override is a workspace/run launch decision only.
- AD-12: `capability_agent` from the adapter registry/resolved runner snapshot
  is the canonical identity for capability enforcement and native
  materialization. Retired `executors.agent` must not remain a source of launch
  truth.
- AD-13: Runner/sidecar usage references are centralized in one service/index.
  Disable/delete guards, UI usage panels, and readiness constraints must not
  each recompute references differently.

## Tasks

### Phase 0 - Specs, ADR, and Adapter Contract Spike

- [x] T0.1 - Record ADR-045 in `docs/decisions.md`.
  Lock platform ACP runners, code-owned adapter provisioners, platform router
  sidecars, typed launch options, and secret-ref boundaries. Logging: n/a.

- [x] T0.2 - Create `.ai-factory/specs/acp-runner-configurations.md`.
  Include JTBD, client journeys, platform/project/Flow onboarding paths,
  sidecar/adapter UI expectations, Flow-step missing-runner dialog, workspace
  launch override behavior, readiness criteria, and acceptance criteria.
  Logging: n/a.

- [x] T0.3 - Rewrite `docs/system-analytics/executors.md`.
  Define platform runner catalog, platform default, inheritance chain, runtime resolver, runner readiness, dangerous policies, and edge cases. Logging: n/a.

- [x] T0.4 - Verify adapter source contracts before coding.
  Inspect installed package sources or official docs for `claude-agent-acp`, Claude Code, `codex-acp`, and Codex CLI. Record accepted env keys, accepted flags, and unsupported flags. Must answer: whether `--dangerously-skip-permissions` can be passed through ACP adapter launch; which env keys Codex uses for OpenAI-compatible base URL/API key; whether z.ai GLM/Qwen should be represented as OpenAI-compatible or another provider shape. No implementation until this is documented. Logging: n/a.
  Required artifact: a short source-backed note in the spec/docs that records:
  Claude Code dangerous-mode flag mapping, installed `claude-agent-acp`
  pass-through support, installed `codex-acp` launch/config support, Codex
  `model_provider`/`model_providers.*` materialization shape, and which
  GLM/Qwen endpoints are usable with Codex Responses-wire routing. Presets
  that are not proven stay `NotReady`; they are not silently hidden.

- [x] T0.5 - Verify CCR/router sidecar lifecycle contract before coding.
  Inspect current `supervisor/src/ccr-manager.ts`, package behavior, config
  shape, healthcheck behavior, and Docker/host assumptions. Decide which
  sidecar fields are editable as typed admin config. Default stance:
  maximum flexibility for admins in this pre-production slice, including typed
  command preset, config path, port/base URL, healthcheck, env refs, lifecycle
  mode, and provider config refs. Raw shell command strings and raw secret
  values remain disallowed. Logging: n/a.

- [x] T0.6 - Finalize config/storage shape and contract docs.
  Update `docs/configuration.md`, `docs/flow-dsl.md`, `docs/supervisor.md`,
  OpenAPI specs, DB docs, deployment docs, and `docs/error-taxonomy.md`. If a
  requested provider/flag/sidecar mode is unsupported, mark it
  `Designed`/`NotReady` rather than pretending it works. Run
  `pnpm validate:docs`. Logging: n/a.

- [x] T0.7 - Specify destructive reset/re-bootstrap contract.
  Document the local-only "blast all MAIster-owned state" reset path: stop
  web/supervisor, drop/recreate the DB or remove SQLite dev DB, remove MAIster
  runtime/cache artifacts, stale MAIster worktrees, generated platform config,
  Flow/capability caches, and any local files the old schema cannot consume.
  Rerun migrations/seeds, create default platform runners/sidecars, and
  re-register projects. Do not delete arbitrary project repos; only
  MAIster-owned DB/runtime/cache/worktree/config paths are in scope. Logging:
  n/a.

### Phase 1 - Schema, DB, and Resolution

- [x] T1.1 - Add platform runner config schema.
  Add a separate platform runtime schema for `platform.default_runner`,
  `router_instances[]`, and `acp_runners[]`. The code-owned adapter registry
  must expose supported provider kinds, permission policies, diagnostics, and
  `capability_agent`. Do not overload project `maister.yaml` parsing with
  platform-owned config. Validate runner ids, sidecar ids, adapter ids, secret
  refs, provider discriminators, permission policy, and no raw tokens. Tests:
  web unit parse/reject matrix. Logging: n/a.

- [x] T1.2 - Replace executor persistence with platform runtime persistence.
  Add clean platform runtime tables/columns: `platform_acp_runners`,
  `platform_router_sidecars`, platform runtime settings with
  `default_runner_id`, project `default_runner_id`, platform Flow
  `default_runner_id`, project Flow attachment `default_runner_id`, and
  step-target remapping records when a package target does not directly match a
  platform runner. Runs/workspaces should store `runner_id`,
  `runner_resolution_tier`, `capability_agent`, and a `runner_snapshot` JSON
  object containing the resolved launch profile needed for display, audit,
  resume, recovery, and historical read models. Remove or demote legacy
  project-scoped `executors`, `projects.default_executor_id`,
  `flows.executor_override_id`, `tasks.executor_override_id`, and
  `runs.executor_id` relationships instead of preserving them as production
  compatibility. Adapter families remain a code-owned registry, not CRUD DB
  rows. Update Drizzle migrations/schema/snapshots and DB docs.
  Tests: integration for SET/CLEAR/idempotent-reset on new tables plus schema
  reset smoke. Logging: INFO upsert counts, DEBUG ids only.

- [x] T1.3 - Implement runner/sidecar usage reference service.
  Add `web/lib/acp-runners/usage.ts` (or equivalent) that returns a typed list
  of references for a runner or sidecar: platform default, project defaults,
  platform Flow defaults, project Flow attachment defaults, Flow-step remaps,
  active runs/workspaces, scratch runs, and historical run snapshots. Use this
  service for disable/delete guards and UI reference panels; if cached, define
  deterministic invalidation/rebuild on runner, sidecar, project, Flow,
  remapping, run, and workspace writes. Tests: integration for every reference
  class plus stale-cache/rebuild or pure-query coverage. Logging: structured
  ids only.

- [x] T1.4 - Implement pure resolver.
  Add `web/lib/acp-runners/resolve.ts` for the corrected chain:
  launch override -> step target -> project Flow default -> platform Flow default
  -> project default -> platform default. Return `{runnerId, tier}`. Tests: unit
  truth table for every tier and missing-runner failure. Logging: n/a.

- [x] T1.5 - Implement Flow load/attach validation.
  During platform Flow load and project Flow attachment, inspect AI-coding step
  target runner ids. If a target is missing from the platform runner catalog,
  create a pending reconfiguration requirement and block enable/attach until the
  operator maps it to an existing platform runner or edits the platform Flow
  default. Tests: integration for missing runner -> dialog requirement, mapping
  -> success, no silent fallback. Logging: WARN with `{flowId, stepId, missingRunnerId}`.

- [x] T1.6 - Migrate project onboarding and project config bindings.
  Update `web/lib/config.schema.ts`, `web/app/api/projects/route.ts`,
  `web/lib/executors.ts`, `web/lib/db/seed.ts`, and related registration tests
  so project registration no longer creates project-scoped executors from
  `maister.yaml executors[]`. Project config references platform runner ids for
  project default and Flow attachment defaults; missing platform runners trigger
  an explicit reconfiguration requirement before project enablement/launch.
  Keep any temporary legacy reader internal to the branch and remove it before
  final verification. Tests: project registration with inherited default,
  explicit runner ref, missing runner remap requirement, and no executor rows.
  Logging: project id, runner ids, Flow ids only.

- [x] T1.7 - Implement platform runtime web API.
  Add routes/server actions for runner CRUD, sidecar CRUD, platform default
  selection, readiness refresh, adapter diagnostics, project default override,
  Flow default override, and Flow-step remapping. Identifier trust labels:
  platform ids are server-state after DB lookup; route/body ids are untrusted
  input until schema-validated and ownership/usage checked. Side-effecting
  readiness refresh uses BEFORE/side-effect/AFTER persistence. Tests:
  integration for valid update, stale/missing ref refusal, disabled default
  guard, usage-ref delete/disable refusal, and no raw secret echo. Logging:
  structured ids only.

- [x] T1.8 - Add platform runtime API authorization.
  Gate platform runner CRUD, sidecar CRUD, platform default changes, adapter
  diagnostics, and readiness refresh behind `requireGlobalRole("admin")`.
  Project default and project Flow default updates still derive `projectId`
  from server-state project rows before `requireProjectAction(projectId,
  "editSettings")`. Tests: route integration for unauthenticated,
  non-admin/member, admin success, and no body-controlled project authority.
  Logging: structured ids only.

- [x] T1.9 - Update Flow DSL runner references.
  Replace legacy Flow `recommended_executor` / node `settings.executors[]`
  semantics with `runner_type` + `runner` references. `runner_type` defaults to
  `acp`; for `runner_type: acp`, `runner` is a platform ACP runner id or a
  package target that must be remapped during Flow load/attach. Update
  `flowYamlV1Schema`, `loadFlowManifest`, graph validation, compile metadata,
  `web/lib/flows/lifecycle.ts`, `web/lib/flows.ts`, docs, and tests. Node
  `settings.tools`, `settings.mcps`, `settings.skills`, and enforcement checks
  must resolve against the runner's `capability_agent`, not a removed
  `executor.agent`. If short-lived compatibility is needed during the branch,
  keep it internal and remove it before final verification. Logging: n/a.

- [x] T1.10 - Add destructive reset/re-bootstrap tooling.
  Add a project-local, explicit reset command/script or documented command set
  that clears all MAIster-owned local DB/runtime/cache/worktree/config state and
  seeds default platform runtime rows. The command must be opt-in, loudly named,
  print every root it is about to delete, and never remove arbitrary project
  repositories. Tests: smoke against SQLite/dev DB where practical. Logging:
  WARN before destructive actions, INFO summary after.

### Phase 2 - Supervisor Spawn Mapping

- [x] T2.1 - Normalize resolved runner to spawn intent.
  Add `web/lib/acp-runners/normalize.ts` that converts the resolved platform
  runner plus optional sidecar into a supervisor-safe spawn intent: adapter,
  model, provider env refs, router sidecar intent, permission policy,
  `capability_agent`, runner snapshot, and adapter provision plan. The snapshot
  must be stable enough for display, resume/recovery, capability resolution,
  and historical audit after runner edits. Tests: unit truth table. Logging:
  n/a.

- [x] T2.2 - Extend supervisor request schema.
  Add a versioned runner payload to `StartSessionRequestSchema` with adapter
  intent, sidecar intent, and env-ref names, preserving backward compatibility
  while the old executor shape is migrated. Update `web/lib/supervisor-client.ts`,
  `docs/supervisor.md`, and supervisor OpenAPI. Tests: supervisor schema unit.
  Logging: n/a.

- [x] T2.3 - Map spawn intent to env/argv in supervisor.
  Add supervisor-side adapter provisioners and an allow-list mapper. Preserve
  resume arg ordering. Reject unsupported provider/policy combinations before
  child spawn. Tests: supervisor unit and spawn integration for Claude direct,
  Claude dangerous policy, Codex direct, and verified Codex provider route.
  Logging: INFO spawn summary with runner id/provider/sidecar booleans only.

- [x] T2.4 - Generalize CCR into keyed router sidecar manager.
  Convert the current singleton CCR manager into a keyed manager for typed
  sidecar instances while keeping `ccr-default` singleton behavior as the
  default. Supervisor receives sidecar intent from web, validates config path
  and healthcheck, starts `ensureRunning(instanceId)`, and shuts down managed
  instances on process exit. Tests: supervisor unit/integration for ready,
  missing config, identity mismatch, disabled sidecar, and two independent
  instance configs. Logging: sidecar id/kind/state only.

- [x] T2.5 - Add supervisor runtime diagnostics.
  Add dedicated typed diagnostics endpoints for adapter binary availability,
  supported adapter ids, sidecar instance readiness, required env-ref presence,
  and launcher version information. Keep `/health` focused on liveness and
  supervisor readiness; it may include only a compact adapter/sidecar
  availability summary. Runner/sidecar list/configuration uses separate web API
  endpoints, and supervisor diagnostics is read-only. The web tier uses these
  endpoints for readiness panels because supervisor may run on a different
  host.
  Tests: supervisor unit/integration and web client parse tests. Logging:
  readiness ids/reason codes only.

- [x] T2.6 - Wire task/Flow launch paths.
  Update `web/components/board/launch-button.tsx`,
  `web/app/api/runs/route.ts`, `web/lib/flows/runner.ts`,
  `web/lib/flows/graph/runner-graph.ts`, `web/lib/flows/graph/runner-core.ts`,
  `web/lib/runs/resume.ts`, and recover paths to resolve platform runner and
  send normalized spawn intent. Remove `executorOverrideId` from task launch
  storage; `POST /api/runs` may accept only a one-run `runnerId` override.
  Invalid runner resolution, missing env refs, unsupported adapter policy,
  unsupported capability-agent mapping, or sidecar not-ready must fail before
  `addWorktree` or DB run/workspace side effects. Tests: web integration for
  no-side-effect refusal and resume from `runner_snapshot` after runner edit or
  disable. Logging: structured refusal context.

- [x] T2.7 - Wire scratch launch paths.
  Update `web/lib/scratch-runs/service.ts`,
  `web/app/api/scratch-runs/launch-options/route.ts`, and scratch UI payloads
  to replace `executorId`/`executors[]`/`defaultExecutorId` with
  `runnerId`/`runners[]`/`defaultRunnerId`, project -> platform runner
  defaults, readiness, inheritance tier, and one-run override. The
  launch-options DTO must expose only safe secret-ref metadata, never raw env
  values or misleading env-key hints. Refuse before `addWorktree`; preserve the
  existing compensation path for failures after worktree creation. Tests:
  scratch launch-options and launch integration. Logging: structured runner
  id/tier only.

- [x] T2.8 - Migrate runner read models and reference projections.
  Update `web/lib/queries/board.ts`, `web/lib/queries/project.ts`, portfolio
  active-workspace queries, run detail DTOs, HITL/activity panels, and any
  `executor_id` joins to read `runner_id`, `runner_resolution_tier`,
  `capability_agent`, and `runner_snapshot`. Active and historical runs must
  still render after the platform runner is edited, disabled, or deleted when
  deletion is allowed only for unreferenced runners. Tests: board/project
  query integration and DTO shape tests that do not leak spawn env/argv or
  secret refs beyond labels/reason codes. Logging: n/a.

### Phase 3 - MAIster UI Management

- [x] T3.1 - Platform runtime settings shell.
  Extend the existing protected `/settings` area into an admin-only platform
  runtime settings surface with tabs for ACP Runners, Router Sidecars, and
  Adapter Support. Use dense operational UI, not marketing copy. Tests:
  render/i18n/navigation/auth gating. Logging: n/a.

- [x] T3.2 - Platform runner management UI.
  Build ACP runner list, create/edit dialog, default runner selector, readiness
  panel, usage/reference panel powered by the usage service, disabled-state
  guard, and sidecar selector. Tests: render/i18n/no-secret-leak tests.
  Logging: n/a.

- [x] T3.3 - Router sidecar management UI.
  Build sidecar list and create/edit dialog for CCR instances: kind, lifecycle,
  typed command preset, config path, port/base URL, healthcheck, env refs,
  provider config refs, readiness, usage, and start/stop/refresh actions where
  supported. This screen is admin-only. Tests:
  render/integration/no-secret-leak tests. Logging: n/a.

- [x] T3.4 - Adapter support UI.
  Build read-only adapter registry/diagnostics: supported provider kinds,
  permission policies, binary readiness, verified/NotReady states, and links to
  runners using each adapter. Tests: render/i18n. Logging: n/a.

- [x] T3.5 - Project default runner UI.
  Add project settings control for default runner: inherit platform default or
  override with platform runner. Update `web/components/board/panels/settings-panel.tsx`
  and project settings read models to show effective runner, readiness, and
  inheritance tier instead of `defaultAgent/defaultExecutorRef`. Tests:
  component/integration. Logging: server actions only.

- [x] T3.6 - Flow runner reconfiguration UI.
  Add platform Flow load and project Flow attach dialog for missing/recommended
  AI-coding step ACP targets. Operator can map missing runner ids to existing
  platform runners or set platform/project Flow default. Tests: integration for
  required dialog and successful mapping. Logging: INFO mapping saved.

- [x] T3.7 - Workspace launch override UI.
  Replace the direct `LaunchButton` POST with a launch dialog for task/Flow
  runs. It starts with the effective runner from the resolver chain, shows why
  it resolved, readiness, capability-agent implications, and allows operator
  override from the platform runner catalog. It sends a one-run `runnerId`
  override to `POST /api/runs` when changed. Tests: Playwright/component test
  for initial selection and override. Logging: launch request logs selected
  runner id/tier.

- [x] T3.8 - Remove runner selection from task creation.
  Update `web/components/board/new-task-modal.tsx`,
  `web/app/api/projects/[slug]/tasks/route.ts`, board i18n, and task tests so
  task creation captures title, prompt, and Flow only. Remove
  `executorOverrideId` from the request schema, UI state, DB writes, and client
  labels. Tests: task-create route/component coverage that proves no task-level
  runner override remains and launch override still works from T3.7.
  Logging: n/a.

### Phase 4 - Presets, Readiness, and Verification

- [x] T4.1 - Provider presets.
  Add presets for Claude direct, Claude CCR, Claude Anthropic-compatible
  env-router, Claude dangerous policy, Codex direct, Codex OpenAI-compatible.
  z.ai GLM/Qwen presets become ready only if Phase 0 verifies the Codex
  contract; otherwise they render as "needs adapter verification". Tests: unit
  for generated runner config.

- [x] T4.2 - Readiness evaluator.
  Evaluate adapter binary availability, sidecar config/state, sidecar
  healthcheck, required env refs in supervisor env, unsupported
  provider/adapter combinations, dangerous policy support, disabled/default
  constraints, capability-agent support, and usage-reference blockers from the
  shared usage service. Tests: unit truth table plus integration for launch
  refusal before side effects and disable refusal while referenced. Logging:
  INFO readiness summary.

- [x] T4.3 - Acceptance coverage.
  Add Playwright coverage for platform default runner, project inherited
  default, project override, router sidecar readiness, adapter diagnostics,
  Flow missing-runner dialog, scratch default runner, task launch runner
  override, task creation without runner override, project registration
  missing-runner remap, usage-reference disable guard, and workspace launch
  override. If live supervisor is unavailable, assert truthful not-ready state.
  Logging: n/a.

- [x] T4.4 - Verification.
  Run destructive reset/re-bootstrap smoke in a disposable local/dev DB, then
  run `pnpm validate:docs`, `pnpm --filter maister-web lint`,
  `pnpm --filter maister-web typecheck`, `pnpm --filter maister-web test:unit`,
  `pnpm --filter maister-web test:integration`,
  `pnpm --filter @maister/supervisor test:unit`,
  `pnpm --filter @maister/supervisor test:integration`, and the relevant
  Playwright lane.

## Acceptance Criteria

- AC1: ACP runners are platform-level configurations with one required platform default.
- AC2: Project default runner inherits platform default and can override it.
- AC3: Platform Flow default runner inherits platform default and can override it.
- AC4: Project Flow default runner inherits project default and can override it.
- AC5: Router sidecars such as CCR are platform-level configurations with DB/API/UI support, readiness, lifecycle state, and runner usage references.
- AC6: Adapter support is exposed as a code-owned registry with API/UI diagnostics, not arbitrary user-created adapter CRUD.
- AC7: AI-coding Flow-step target ACP ids are validated against platform runners during Flow platform load and project Flow attachment.
- AC8: Missing/recommended ACP ids open a required reconfiguration dialog and never silently fall back.
- AC9: Workspace launch starts with effective project -> platform default and can override runner for that launch.
- AC10: Supervisor spawn uses typed allow-listed runner options, adapter provisioners, and sidecar intents; unsupported provider/policy/sidecar combinations fail before child spawn.
- AC11: Claude CCR/direct/dangerous and verified Codex provider presets are manageable from MAIster UI without raw secret entry.
- AC12: Docs/OpenAPI/DB docs match the final config, persistence, deployment, and wire shape.
- AC13: A documented destructive "blast all MAIster-owned state" reset can
  recreate a clean local MAIster instance with default platform runner/sidecar
  state.
- AC14: Scratch launches use the same platform runner catalog, readiness, and
  project -> platform default semantics as task/Flow launches.
- AC15: Platform runtime management APIs are admin-gated; project-scoped runner
  defaults derive project authority from server-state rows.
- AC16: Flow AI-coding metadata uses `runner_type` + `runner`; `runner_type:
  acp` resolves through the platform ACP runner catalog, and future runner
  families can extend the field without redefining ACP semantics.
- AC17: Supervisor health remains liveness/readiness, while adapter/sidecar
  diagnostics and runner/sidecar configuration are exposed through separate
  typed endpoints.
- AC18: Task creation no longer accepts or stores runner/executor overrides;
  runner override exists only on workspace/run launch.
- AC19: Project registration no longer creates project-scoped executors from
  `maister.yaml executors[]`; project and Flow config bind to platform runners
  or produce explicit remapping requirements.
- AC20: Runner and sidecar management use a complete usage-reference service or
  deterministic cache covering defaults, Flow mappings, step remaps,
  active/historical runs, scratch runs, and sidecar references.
- AC21: Capability enforcement, capability selection, native materialization,
  and run snapshots use the resolved runner's `capability_agent`; no path reads
  retired `executors.agent` as the source of launch truth.
- AC22: Board, project, portfolio, run detail, resume/recover, task launch, and
  scratch launch read models use `runner_id`/`runner_snapshot` rather than
  joining `runs.executor_id -> executors`.

## Commit Plan

- Commit 0: `docs(acp): specify platform runner configuration`
- Commit 1: `feat(acp): add platform runtime schema and persistence`
- Commit 2: `feat(acp): resolve runner inheritance, usage, and flow remapping`
- Commit 3: `feat(supervisor): provision adapters and router sidecars`
- Commit 4: `feat(web): manage ACP runtime settings and launch forms`
- Commit 5: `chore(acp): add local reset and platform bootstrap`
- Commit 6: `test(acp): add runner configuration acceptance coverage`

## Risks

- R1: Existing project-scoped executor rows are embedded in many read models. Mitigation: no production data exists, so replace the model directly and provide a destructive local reset/re-bootstrap path instead of production-safe backfill.
- R2: Codex third-party provider routing may not support assumed env names. Mitigation: Phase 0 adapter-source spike blocks ready presets.
- R3: Passing dangerous Claude permission flags may be unsupported or unsafe. Mitigation: typed enum, adapter verification, and explicit not-ready state if unsupported.
- R4: Flow remapping could be mistaken for runtime fallback. Mitigation: required dialog and persisted mapping; no silent fallback.
- R5: Sidecar lifecycle may diverge between host dev and Docker/prod. Mitigation: deployment docs, `.env.example`, compose touchpoints, and readiness tests cover both assumptions.
- R6: Adapter registry could be mistaken for configurable custom adapters. Mitigation: UI labels it as support/diagnostics; only runners and sidecars are CRUD in this slice.
- R7: Destructive reset tooling could delete user repos if scoped poorly. Mitigation: only MAIster-owned DB/runtime/cache/worktree/config paths are in scope; require explicit command naming and path logs before deletion.
- R8: Treating every OpenAI-compatible provider as Codex-compatible could create false-ready runners. Mitigation: Codex presets require Responses-wire verification for the exact endpoint/model; otherwise show `NotReady`.
- R9: Old task-level executor override could survive in New Task UI/API and
  bypass the corrected runner chain. Mitigation: remove task override from UI,
  request schema, DB writes, and tests; launch override is the only one-run
  override path.
- R10: Runner/sidecar usage panels or disable guards could miss references if
  every screen computes usage differently. Mitigation: one usage-reference
  service/index with rebuild/invalidation tests.
- R11: Capability enforcement could use stale `executor.agent` while launch uses
  platform runners. Mitigation: adapter registry exposes `capability_agent`,
  launch snapshots it, and every capability/materialization path consumes the
  snapshot/resolved runner identity.
- R12: Project onboarding could keep recreating project-scoped executors from
  `maister.yaml`, reintroducing the old model after reset. Mitigation:
  registration tests assert no executor rows and explicit runner-remap
  requirements for unknown refs.
