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

## Contract Surface Map

| Surface changed | Spec file(s) to update |
| --- | --- |
| ADR/spec baseline | `docs/decisions.md` + `.ai-factory/specs/acp-runner-configurations.md` |
| Platform ACP runner catalog and platform default | `docs/configuration.md` + `docs/system-analytics/executors.md` |
| Platform router sidecar catalog and CCR lifecycle | `docs/configuration.md` + `docs/supervisor.md` + `docs/system-analytics/executors.md` |
| Adapter support registry and provisioner contracts | `docs/configuration.md` + `docs/supervisor.md` + `docs/system-analytics/executors.md` |
| Project default runner inheritance | `docs/configuration.md` + `docs/system-analytics/projects.md` |
| Platform Flow default runner and project Flow default runner | `docs/system-analytics/flow-packages.md` + `docs/system-analytics/flows.md` |
| Flow-step target ACP validation/reconfiguration dialog | `docs/flow-dsl.md` + `docs/system-analytics/flows.md` |
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

- [ ] T0.3 - Rewrite `docs/system-analytics/executors.md`.
  Define platform runner catalog, platform default, inheritance chain, runtime resolver, runner readiness, dangerous policies, and edge cases. Logging: n/a.

- [ ] T0.4 - Verify adapter source contracts before coding.
  Inspect installed package sources or official docs for `claude-agent-acp`, Claude Code, `codex-acp`, and Codex CLI. Record accepted env keys, accepted flags, and unsupported flags. Must answer: whether `--dangerously-skip-permissions` can be passed through ACP adapter launch; which env keys Codex uses for OpenAI-compatible base URL/API key; whether z.ai GLM/Qwen should be represented as OpenAI-compatible or another provider shape. No implementation until this is documented. Logging: n/a.
  Required artifact: a short source-backed note in the spec/docs that records:
  Claude Code dangerous-mode flag mapping, installed `claude-agent-acp`
  pass-through support, installed `codex-acp` launch/config support, Codex
  `model_provider`/`model_providers.*` materialization shape, and which
  GLM/Qwen endpoints are usable with Codex Responses-wire routing. Presets
  that are not proven stay `NotReady`; they are not silently hidden.

- [ ] T0.5 - Verify CCR/router sidecar lifecycle contract before coding.
  Inspect current `supervisor/src/ccr-manager.ts`, package behavior, config
  shape, healthcheck behavior, and Docker/host assumptions. Decide which
  sidecar fields are editable as typed admin config. Default stance:
  maximum flexibility for admins in this pre-production slice, including typed
  command preset, config path, port/base URL, healthcheck, env refs, lifecycle
  mode, and provider config refs. Raw shell command strings and raw secret
  values remain disallowed. Logging: n/a.

- [ ] T0.6 - Finalize config/storage shape and contract docs.
  Update `docs/configuration.md`, `docs/flow-dsl.md`, `docs/supervisor.md`,
  OpenAPI specs, DB docs, deployment docs, and `docs/error-taxonomy.md`. If a
  requested provider/flag/sidecar mode is unsupported, mark it
  `Designed`/`NotReady` rather than pretending it works. Run
  `pnpm validate:docs`. Logging: n/a.

- [ ] T0.7 - Specify destructive reset/re-bootstrap contract.
  Document the local-only "blast all MAIster-owned state" reset path: stop
  web/supervisor, drop/recreate the DB or remove SQLite dev DB, remove MAIster
  runtime/cache artifacts, stale MAIster worktrees, generated platform config,
  Flow/capability caches, and any local files the old schema cannot consume.
  Rerun migrations/seeds, create default platform runners/sidecars, and
  re-register projects. Do not delete arbitrary project repos; only
  MAIster-owned DB/runtime/cache/worktree/config paths are in scope. Logging:
  n/a.

### Phase 1 - Schema, DB, and Resolution

- [ ] T1.1 - Add platform runner config schema.
  Add a separate platform runtime schema for `platform.default_runner`,
  `router_instances[]`, and `acp_runners[]`. Do not overload project
  `maister.yaml` parsing with platform-owned config. Validate runner ids,
  sidecar ids, adapter ids, secret refs, provider discriminators, permission
  policy, and no raw tokens. Tests: web unit parse/reject matrix. Logging: n/a.

- [ ] T1.2 - Replace executor persistence with platform runtime persistence.
  Add clean platform runtime tables/columns: `platform_acp_runners`,
  `platform_router_sidecars`, platform runtime settings with
  `default_runner_id`, project `default_runner_id`, platform Flow
  `default_runner_id`, project Flow attachment `default_runner_id`, and
  step-target remapping records when a package target does not directly match a
  platform runner. Runs/workspaces should store `runner_id`,
  `runner_resolution_tier`, and a `runner_snapshot` JSON object containing the
  resolved launch profile needed for display, audit, and recovery. Remove or
  demote legacy project-scoped `executors`, `projects.default_executor_id`,
  `flows.executor_override_id`, `tasks.executor_override_id`, and
  `runs.executor_id` relationships instead of preserving them as production
  compatibility. Adapter families remain a code-owned registry, not CRUD DB
  rows. Update Drizzle migrations/schema/snapshots and DB docs.
  Tests: integration for SET/CLEAR/idempotent-reset on new tables plus schema
  reset smoke. Logging: INFO upsert counts, DEBUG ids only.

- [ ] T1.3 - Implement pure resolver.
  Add `web/lib/acp-runners/resolve.ts` for the corrected chain:
  launch override -> step target -> project Flow default -> platform Flow default
  -> project default -> platform default. Return `{runnerId, tier}`. Tests: unit
  truth table for every tier and missing-runner failure. Logging: n/a.

- [ ] T1.4 - Implement Flow load/attach validation.
  During platform Flow load and project Flow attachment, inspect AI-coding step
  target runner ids. If a target is missing from the platform runner catalog,
  create a pending reconfiguration requirement and block enable/attach until the
  operator maps it to an existing platform runner or edits the platform Flow
  default. Tests: integration for missing runner -> dialog requirement, mapping
  -> success, no silent fallback. Logging: WARN with `{flowId, stepId, missingRunnerId}`.

- [ ] T1.5 - Implement platform runtime web API.
  Add routes/server actions for runner CRUD, sidecar CRUD, platform default
  selection, readiness refresh, adapter diagnostics, project default override,
  Flow default override, and Flow-step remapping. Identifier trust labels:
  platform ids are server-state after DB lookup; route/body ids are untrusted
  input until schema-validated and ownership/usage checked. Side-effecting
  readiness refresh uses BEFORE/side-effect/AFTER persistence. Tests:
  integration for valid update, stale/missing ref refusal, disabled default
  guard, and no raw secret echo. Logging: structured ids only.

- [ ] T1.6 - Add platform runtime API authorization.
  Gate platform runner CRUD, sidecar CRUD, platform default changes, adapter
  diagnostics, and readiness refresh behind `requireGlobalRole("admin")`.
  Project default and project Flow default updates still derive `projectId`
  from server-state project rows before `requireProjectAction(projectId,
  "editSettings")`. Tests: route integration for unauthenticated,
  non-admin/member, admin success, and no body-controlled project authority.
  Logging: structured ids only.

- [ ] T1.7 - Update Flow DSL runner references.
  Replace legacy Flow `recommended_executor` / node `settings.executors[]`
  semantics with `runner_type` + `runner` references. `runner_type` defaults to
  `acp`; for `runner_type: acp`, `runner` is a platform ACP runner id or a
  package target that must be remapped during Flow load/attach. Update
  `flowYamlV1Schema`, `loadFlowManifest`, graph validation, compile metadata,
  docs, and tests. If short-lived compatibility is needed during the branch,
  keep it internal and remove it before final verification. Logging: n/a.

- [ ] T1.8 - Add destructive reset/re-bootstrap tooling.
  Add a project-local, explicit reset command/script or documented command set
  that clears all MAIster-owned local DB/runtime/cache/worktree/config state and
  seeds default platform runtime rows. The command must be opt-in, loudly named,
  print every root it is about to delete, and never remove arbitrary project
  repositories. Tests: smoke against SQLite/dev DB where practical. Logging:
  WARN before destructive actions, INFO summary after.

### Phase 2 - Supervisor Spawn Mapping

- [ ] T2.1 - Normalize resolved runner to spawn intent.
  Add `web/lib/acp-runners/normalize.ts` that converts the resolved platform
  runner plus optional sidecar into a supervisor-safe spawn intent: adapter,
  model, provider env refs, router sidecar intent, permission policy, and
  adapter provision plan. Tests: unit truth table. Logging: n/a.

- [ ] T2.2 - Extend supervisor request schema.
  Add a versioned runner payload to `StartSessionRequestSchema` with adapter
  intent, sidecar intent, and env-ref names, preserving backward compatibility
  while the old executor shape is migrated. Update `web/lib/supervisor-client.ts`,
  `docs/supervisor.md`, and supervisor OpenAPI. Tests: supervisor schema unit.
  Logging: n/a.

- [ ] T2.3 - Map spawn intent to env/argv in supervisor.
  Add supervisor-side adapter provisioners and an allow-list mapper. Preserve
  resume arg ordering. Reject unsupported provider/policy combinations before
  child spawn. Tests: supervisor unit and spawn integration for Claude direct,
  Claude dangerous policy, Codex direct, and verified Codex provider route.
  Logging: INFO spawn summary with runner id/provider/sidecar booleans only.

- [ ] T2.4 - Generalize CCR into keyed router sidecar manager.
  Convert the current singleton CCR manager into a keyed manager for typed
  sidecar instances while keeping `ccr-default` singleton behavior as the
  default. Supervisor receives sidecar intent from web, validates config path
  and healthcheck, starts `ensureRunning(instanceId)`, and shuts down managed
  instances on process exit. Tests: supervisor unit/integration for ready,
  missing config, identity mismatch, disabled sidecar, and two independent
  instance configs. Logging: sidecar id/kind/state only.

- [ ] T2.5 - Add supervisor runtime diagnostics.
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

- [ ] T2.6 - Wire task/Flow launch paths.
  Update `POST /api/runs`, graph runner, resume/recover where applicable to
  resolve platform runner and send normalized spawn intent. Invalid runner
  resolution, missing env refs, unsupported adapter policy, or sidecar not-ready
  must fail before `addWorktree` or DB run/workspace side effects. Tests: web
  integration for no-side-effect refusal. Logging: structured refusal context.

- [ ] T2.7 - Wire scratch launch paths.
  Update `web/lib/scratch-runs/service.ts`,
  `web/app/api/scratch-runs/launch-options/route.ts`, and scratch UI payloads
  to use project -> platform runner defaults, readiness, and one-run override.
  Refuse before `addWorktree`; preserve the existing compensation path for
  failures after worktree creation. Tests: scratch launch-options and launch
  integration. Logging: structured runner id/tier only.

### Phase 3 - MAIster UI Management

- [ ] T3.1 - Platform runtime settings shell.
  Extend the existing protected `/settings` area into an admin-only platform
  runtime settings surface with tabs for ACP Runners, Router Sidecars, and
  Adapter Support. Use dense operational UI, not marketing copy. Tests:
  render/i18n/navigation/auth gating. Logging: n/a.

- [ ] T3.2 - Platform runner management UI.
  Build ACP runner list, create/edit dialog, default runner selector, readiness
  panel, usage/reference panel, disabled-state guard, and sidecar selector.
  Tests: render/i18n/no-secret-leak tests. Logging: n/a.

- [ ] T3.3 - Router sidecar management UI.
  Build sidecar list and create/edit dialog for CCR instances: kind, lifecycle,
  typed command preset, config path, port/base URL, healthcheck, env refs,
  provider config refs, readiness, usage, and start/stop/refresh actions where
  supported. This screen is admin-only. Tests:
  render/integration/no-secret-leak tests. Logging: n/a.

- [ ] T3.4 - Adapter support UI.
  Build read-only adapter registry/diagnostics: supported provider kinds,
  permission policies, binary readiness, verified/NotReady states, and links to
  runners using each adapter. Tests: render/i18n. Logging: n/a.

- [ ] T3.5 - Project default runner UI.
  Add project settings control for default runner: inherit platform default or
  override with platform runner. Show effective value and inheritance tier.
  Tests: component/integration. Logging: server actions only.

- [ ] T3.6 - Flow runner reconfiguration UI.
  Add platform Flow load and project Flow attach dialog for missing/recommended
  AI-coding step ACP targets. Operator can map missing runner ids to existing
  platform runners or set platform/project Flow default. Tests: integration for
  required dialog and successful mapping. Logging: INFO mapping saved.

- [ ] T3.7 - Workspace launch override UI.
  Launch dialog starts with effective runner from project -> platform default
  chain, shows why it resolved, and allows operator override from platform
  runner catalog. Tests: Playwright/component test for initial selection and
  override. Logging: launch request logs selected runner id/tier.

### Phase 4 - Presets, Readiness, and Verification

- [ ] T4.1 - Provider presets.
  Add presets for Claude direct, Claude CCR, Claude Anthropic-compatible
  env-router, Claude dangerous policy, Codex direct, Codex OpenAI-compatible.
  z.ai GLM/Qwen presets become ready only if Phase 0 verifies the Codex
  contract; otherwise they render as "needs adapter verification". Tests: unit
  for generated runner config.

- [ ] T4.2 - Readiness evaluator.
  Evaluate adapter binary availability, sidecar config/state, sidecar
  healthcheck, required env refs in supervisor env, unsupported
  provider/adapter combinations, dangerous policy support, disabled/default
  constraints, and active usage. Tests: unit truth table plus integration for
  launch refusal before side effects. Logging: INFO readiness summary.

- [ ] T4.3 - Acceptance coverage.
  Add Playwright coverage for platform default runner, project inherited
  default, project override, router sidecar readiness, adapter diagnostics,
  Flow missing-runner dialog, scratch default runner, and workspace launch
  override. If live supervisor is unavailable, assert truthful not-ready state.
  Logging: n/a.

- [ ] T4.4 - Verification.
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

## Commit Plan

- Commit 0: `docs(acp): specify platform runner configuration`
- Commit 1: `feat(acp): add platform runtime schema and persistence`
- Commit 2: `feat(acp): resolve runner inheritance and flow remapping`
- Commit 3: `feat(supervisor): provision adapters and router sidecars`
- Commit 4: `feat(web): manage ACP runtime settings`
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
