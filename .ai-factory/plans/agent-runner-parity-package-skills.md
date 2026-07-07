# Plan: Agent Runner Parity and Package Skills

## Metadata

- Plan id: `agent-runner-parity-package-skills`
- Created: 2026-07-07
- Status: ready for implementation
- Planning worktree: detached HEAD at the current repo snapshot
- Target implementation branch: `feature/agent-runner-parity-package-skills`
- Suggested base: `main`
- Roadmap linkage: M34 platform-agent substrate follow-up, with guardrail-read-only parity aligned to M40
- ADR numbering: expected next ADR is ADR-129; verify on the implementation branch with `rg -n "^### ADR-" docs/decisions.md | tail -20` before editing decisions
- DB migration: none expected; implementation must prove this by leaving `web/lib/db/migrations/` and migration journal files unchanged

## Improvement Pass 1

This pass tightens the original plan against the current code paths and removes
four hidden assumptions that would otherwise leak into implementation:

- Read-only runner parity cannot be a static descriptor flag alone. The adapter
  must either have fresh cached `readOnlySession` smoke evidence or be
  explicitly classified as not requiring live smoke with a documented reason.
- Launch-time runner compatibility must use the final launch workspace override
  before any side effects such as worktree creation, detached checkout creation,
  run insertion, or session token issuance.
- Package skills are not guaranteed to live at `<packageInstall>/skills`.
  Attached packages expose skill inventory through their manifest capability
  roots, currently `manifest.spec.capabilities[*].path/skills`, and those roots
  must be used for standalone package-agent materialization.
- Package materialization must copy capability subagents for Claude, because
  Claude is the adapter family with a native `.claude/agents/` surface. Other
  adapter families remain skill-only for this path.

## Scope

Implement the core request for package-backed standalone platform agents:

1. Runner-agnostic read-only standalone agents.
2. Wholesale providing-package skill materialization for standalone agent sessions.
3. Strict typed `capability_profile` with `mcps?: string[]`.
4. SDD-first docs, API/DB contract audit, system analytics updates, and screen contract cleanup.
5. TDD implementation with explicit RED -> GREEN -> refactor steps and no trivial coverage.

## Non-Goals

- Do not implement ADR-041 enforcement flips.
- Do not add DB columns, migration files, or persisted schema fields.
- Do not add package-skill selection UI.
- Do not change flow-driven or flow-node-bound execution behavior.
- Do not relax `dangerously_skip_permissions` refusal for `workspace: none | repo_read`.
- Do not allow non-claude `mode: subagent`.
- Do not add cross-package skill augmentation beyond a future-facing `capability_profile` note in docs.

## Settings

- SDD gate: update and review specs/docs before implementation code changes.
- TDD gate: add failing tests before implementation for every behavior change.
- Refactor gate: after tests are green, remove duplication and align helper boundaries without changing behavior.
- Engineering gate: implementation must follow project conventions plus SOLID,
  KISS, DRY, strict typing, and single-purpose helper boundaries.
- Logging: every task that changes runtime behavior must add or preserve structured logs with stable fields, not interpolated dynamic strings.
- Errors: known domain refusals must throw `MaisterError` with actionable context.
- Contracts: API, AsyncAPI, DB, docs, and system analytics must be checked explicitly even when unchanged.

## Current-State Findings

- `web/lib/acp-runners/resolve.ts` currently refuses `workspace: none | repo_read` unless the selected runner has `capabilityAgent === "claude"`.
- `web/lib/acp-runners/adapter-support.ts` and `supervisor/src/adapter-registry.ts` do not expose `readOnlyCapable`.
- `supervisor/src/acp-client.ts` already has generic L1 `readOnlySession` arbitration:
  - read/search/fetch/think kinds are allowed when the ACP request exposes an allow option.
  - unknown and write-like kinds deny by default.
  - inline L1 decisions do not emit `session.permission_request`.
- `supervisor/src/__tests__/adapter-compatibility.integration.test.ts` already tests opencode read-only round trips via the mock ACP fixture and can be parameterized.
- `web/lib/capabilities/adapter-home.ts` already materializes package skills per adapter and returns redirect env for home-redirect adapters.
- `web/lib/agents/dirty-watchdog.ts` currently filters/restores only `.claude/settings.local.json` and its MAIster marker.
- `web/lib/agents/effective.ts` resolves the pinned attached package definition but does not return `installedPath`.
- `web/lib/agents/definition.ts` currently accepts `capability_profile: z.record(z.unknown())`.
- `web/lib/agents/launch.ts` launches standalone agents, applies `readOnlySession` for non-worktree workspaces, and computes `cwd` per workspace target.
- `web/lib/packages/attach.ts` collects package skills from each manifest
  capability member root, not from a single package-root `skills/` directory.
- `web/lib/agents/launch.ts` currently resolves runner compatibility before the
  final launch workspace override is known.
- `supervisor/src/adapter-smoke-cache.ts`, `supervisor/src/types.ts`,
  `web/lib/supervisor-client.ts`, and `web/lib/acp-runners/readiness.ts`
  currently expose only generic ACP smoke status; they do not expose a separate
  read-only-session smoke dimension.
- `web/lib/agents/registry.ts` already reports invalid package definitions
  during registration/resync and avoids writing invalid rows; this plan should
  strengthen that path instead of inventing a parallel invalid-reporting
  channel.

## Implementation Preflight

- ADR check: latest ADR number must be reverified before editing
  `docs/decisions.md`; no ADR is planned unless implementation exposes a new
  durable decision beyond the updated contracts.
- API contract check: `docs/api/web.openapi.yaml` must document launch
  `workspace?`; `docs/api/supervisor.openapi.yaml` must document nested
  `smoke.readOnlySession`.
- AsyncAPI contract check: no SSE event shape change is expected; verify before
  final completion.
- DB/migration check: no schema or migration files are expected to change.
- System analytics and screen contracts now define final-workspace runner
  compatibility, read-only-session evidence, pinned package skill roots, strict
  `capability_profile`, and no partial side effects before refusal.
- RED test mapping: runner compatibility/read-only evidence, package skill
  materialization and cleanup boundaries, strict `capability_profile`, and
  supervisor diagnostics shape.
- Acceptance criteria are fail-closed: missing evidence, missing pinned package
  skill files, unknown profile keys, or unsupported workspace/runner pairs must
  refuse with domain errors before launch side effects.

## Contract Surface Matrix

| Surface                                    | Source files                                                                                                                                                                      | Contract artifact                                                                                                | Expected change                                                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner read-only capability                | `web/lib/acp-runners/adapter-support.ts`, `supervisor/src/adapter-registry.ts`                                                                                                    | `docs/system-analytics/acp-runners.md`, `docs/screens/settings-acp-runners.md`                                   | Add `readOnlyCapable` as descriptor support plus read-only-session smoke evidence, not an adapter-name shortcut.                                              |
| Read-only smoke evidence                   | `supervisor/src/adapter-smoke-cache.ts`, `supervisor/scripts/smoke-acp-adapter.ts`, `supervisor/src/types.ts`, `web/lib/supervisor-client.ts`, `web/lib/acp-runners/readiness.ts` | `docs/system-analytics/acp-runners.md`, `docs/supervisor.md` if smoke CLI docs live there                        | Add a separate read-only-session smoke dimension for read-only standalone launch gating while keeping generic ACP smoke advisory for normal runner readiness. |
| Standalone runner resolution               | `web/lib/acp-runners/resolve.ts`, `web/lib/agents/launch.ts`                                                                                                                      | `docs/system-analytics/agents.md`, `docs/screens/projects/project-settings-agents.md`                            | Replace claude-only read-only check with descriptor-gated check.                                                                                              |
| Supervisor L1 read-only arbitration        | `supervisor/src/acp-client.ts`                                                                                                                                                    | `docs/system-analytics/acp-runners.md`, `docs/api/async/supervisor-sse.asyncapi.yaml`                            | No wire shape change expected; prove existing `readOnlySession` semantics cover all adapters.                                                                 |
| Package skill/subagent materialization     | `web/lib/agents/launch.ts`, `web/lib/agents/effective.ts`, `web/lib/capabilities/adapter-home.ts`, `web/lib/packages/attach.ts`                                                   | `docs/system-analytics/agents.md`, `docs/system-analytics/capabilities.md`, `docs/flow-dsl.md`                   | Standalone agent sessions receive skill capabilities from the providing pinned package's manifest member roots; Claude also receives capability subagents.     |
| Materialization cleanup and dirty watchdog | `web/lib/agents/dirty-watchdog.ts`, `web/lib/capabilities/adapter-home.ts`, `web/lib/agents/launch.ts`                                                                            | `docs/system-analytics/agents.md`, `docs/system-analytics/workspaces.md`                                         | Generated skill files join manifest/restore/filter so repo-read agents are not quarantined for MAIster-owned materialization.                                 |
| Typed `capability_profile`                 | `web/lib/agents/definition.ts`, `web/lib/agents/registry.ts`, Studio validation paths                                                                                             | `docs/flow-dsl.md`, `docs/system-analytics/agents.md`, relevant Studio screen docs if visible validation changes | Strict `{ mcps?: string[] }`, unknown keys rejected as `CONFIG`, resync reports invalid legacy profiles without writing them.                                 |
| HTTP/OpenAPI                               | `docs/api/web.openapi.yaml`, `docs/api/supervisor.openapi.yaml`                                                                                                                   | `pnpm validate:contracts`                                                                                        | No shape change expected; only edit if implementation introduces a new request/response field.                                                                |
| DB schema                                  | `web/lib/db/schema.ts`, `web/lib/db/migrations/`                                                                                                                                  | `docs/database-schema.md`, `docs/db/`                                                                            | No DB migration; no schema doc change unless a surprise persistence need is discovered and justified.                                                         |

## Acceptance Criteria

- A read-only standalone agent can use a non-claude runner when that adapter has
  descriptor `readOnlyCapable` support, descriptor
  `readOnlySessionSmoke: required` evidence is ok when required, and the runner
  is enabled/ready.
- A read-only standalone agent fails closed when the selected adapter is not
  proven by both descriptor support and read-only-session evidence.
- Missing, pending, skipped, stale, or failed read-only-session smoke evidence
  refuses `workspace: none | repo_read` before worktree/cwd/run/token side
  effects unless the adapter has a documented not-required classification.
- `dangerously_skip_permissions` still refuses `workspace: none | repo_read`.
- `mode: subagent` still refuses non-claude runners.
- The launch-time workspace used for runner compatibility matches the actual launch override workspace: `input.workspace ?? effective.parsed.workspace`.
- Supervisor L1 read-only arbitration is verified per read-only-capable adapter with:
  - write-like permission kind -> selected deny option.
  - read-like permission kind -> selected allow option.
  - unknown permission kind -> selected deny option.
  - no `session.permission_request` leakage.
  - `pendingPermissions` remains empty.
- Standalone sessions materialize every skill-kind capability from the agent's providing pinned package, not from the newest install catalog projection.
- Package skill paths come from the pinned package manifest's capability member
  roots, not from a flat package-root `skills/` assumption.
- Standalone package materialization copies package capability subagents for
  Claude and omits them for non-Claude adapters.
- Skill materialization works for `workspace: worktree`, `repo_read`, and `none`.
- Claude gets package skills through cwd `.claude` materialization; non-claude adapters use their descriptor-backed materialization targets.
- MAIster-owned materialized skill paths are restored/filtered before dirty-watchdog quarantine decisions.
- User-owned same-name skill directories are never deleted unless MAIster created or replaced them in the same session and recorded that ownership.
- `capability_profile` accepts only strict `{ mcps?: string[] }`.
- `capability_profile.mcps` values are id-shaped, bounded, deduplicated, and order-stable.
- Unknown `capability_profile` keys raise `MaisterError("CONFIG")` at definition registration/validation.
- Resync reports invalid legacy package agent profiles and does not write now-invalid agent definitions.
- Docs, system analytics, and screen references describe the as-built behavior.
- All targeted tests, full relevant suites, docs validation, contract validation, and check-only ESLint gates pass.

## SDD Phase 0: Spec and Contract Freeze

### Task 0.1 - Reserve numbering and inspect overlap

Files/commands:

- `docs/decisions.md`
- `git --no-pager diff`
- `git status --short --branch`
- `rg -n "^### ADR-" docs/decisions.md | tail -20`
- Inspect overlap with Tact-3 branch `claude/optimistic-leakey-8fde07` before implementation rebases.

Deliverables:

- Confirm next ADR number, expected ADR-129.
- Decide whether ADR-129 is required. Use it only if the read-only-capability descriptor or package-skill materialization changes a durable product decision.
- Confirm no migration number is reserved.
- List overlapping files before implementation starts:
  - `web/lib/acp-runners/resolve.ts`
  - `web/lib/acp-runners/adapter-support.ts`
  - `supervisor/src/adapter-registry.ts`
  - `web/lib/agents/launch.ts`
  - `web/lib/agents/dirty-watchdog.ts`

Acceptance:

- The implementation branch starts from an up-to-date base.
- ADR and migration decisions are explicit before code edits.

### Task 0.2 - Update system analytics and product contracts first

Files:

- `docs/system-analytics/agents.md`
- `docs/system-analytics/acp-runners.md`
- `docs/system-analytics/capabilities.md`
- `docs/flow-dsl.md`
- `docs/screens/settings-acp-runners.md`
- `docs/screens/projects/project-settings-agents.md`
- `docs/screens/studio/editor.md` only if strict profile validation changes visible Studio behavior.

Required spec content:

- `readOnlyCapable` is a per-adapter capability, not an adapter-name shortcut.
- `readOnlyCapable` requires both descriptor support and read-only-session
  smoke evidence or an explicit not-required classification with a documented
  reason.
- Non-proven adapters fail closed.
- `dangerously_skip_permissions` remains blocked for read-only workspaces.
- `mode: subagent` remains claude-only.
- L1 supervisor `readOnlySession` is the load-bearing guardrail.
- Generic ACP smoke remains advisory for normal readiness; read-only-session
  smoke is the extra gate for read-only standalone launches.
- L2 adapter materialization is best effort and descriptor-backed.
- L3 dirty-watchdog remains terminal enforcement for repo-read agents.
- Standalone package agents receive all skill capabilities from their providing
  pinned attached package's manifest capability roots.
- Standalone package-agent materialization copies skill capabilities for every
  adapter and copies capability subagents only for Claude.
- Flow-driven and flow-node-bound execution keep current behavior.
- `capability_profile` supports only `mcps?: string[]`.
- OpenAPI/AsyncAPI and DB schema are unchanged unless the implementation phase proves otherwise.
- Reconcile contradictory current-state docs, especially stale claims that
  package materialization is claude-only when codex/home-redirect materializers
  already exist.

Acceptance:

- Docs contain no stale "claude-only read-only standalone" concept.
- Screen docs match the visible user expectations for runner selection and validation errors.
- Docs validation still has a clear path to green after final implementation.

### Task 0.3 - Fullness and logical-hole review before code

Produce a short implementation checklist in the plan PR/commit message or a temporary review note before coding starts:

- Requirement-to-test mapping for A, B, and C.
- Contract-surface check for API, AsyncAPI, DB, docs, and screens.
- Failure-mode check for unavailable read-only-session smoke evidence, unknown
  permission kind, env collision, stale package install, missing manifest skill
  root, user-owned skill collision, and dirty repo-read terminal cleanup.
- Runtime-target check for all four standalone triggers and all three workspace targets.
- Side-effect-ordering check that read-only compatibility is decided before any
  worktree creation, detached checkout creation, `runs` insert, or session token
  issuance.

Acceptance:

- No implementation task starts until each requirement has either a test target or an explicit non-code verification target.

## TDD Phase 1: RED Tests

Add tests first. Run each listed focused command and record that it fails for the expected reason before implementation.

### Task 1.1 - Runner-resolution RED tests

Files:

- `web/lib/acp-runners/__tests__/resolve-agent.test.ts`
- `web/lib/agents/__tests__/launch.test.ts` or `web/lib/agents/__tests__/launch-worktree-modes.integration.test.ts` for launch workspace override behavior.

Cases:

- `workspace: none` and `repo_read` allow codex when `readOnlyCapable: true`
  and the descriptor marks read-only-session smoke `not_required`; opencode
  additionally requires ok read-only-session evidence.
- `workspace: none` and `repo_read` refuse adapters when `readOnlyCapable: false`.
- `workspace: none` and `repo_read` refuse adapters before launch side effects
  when read-only-session smoke evidence is missing, pending, skipped, stale, or
  failed.
- `dangerously_skip_permissions` still refuses read-only workspaces even if
  descriptor and read-only-session evidence are otherwise valid.
- `mode: subagent` still refuses non-claude even if descriptor and
  read-only-session evidence are otherwise valid.
- `workspace: worktree` is not blocked by missing read-only capability.
- Launch override workspace is used for compatibility checks, not only the agent definition workspace.
- Launch override compatibility failures occur before `addWorktree`, detached
  checkout creation, `runs` insert, or session token issuance.

Focused RED command:

```bash
pnpm --filter maister-web exec vitest run --project unit lib/acp-runners/__tests__/resolve-agent.test.ts
```

Acceptance:

- Tests fail only because `readOnlyCapable`, descriptor-backed
  read-only-session smoke requirement, evidence checks, or workspace override
  handling are not implemented yet.

### Task 1.2 - Supervisor read-only parity RED tests

Files:

- `supervisor/src/__tests__/adapter-compatibility.integration.test.ts`
- `supervisor/test/fixtures/mock-acp-compatibility.mjs`
- `supervisor/src/__tests__/adapter-registry.test.ts`
- `supervisor/src/__tests__/types.test.ts`
- `web/lib/__tests__/supervisor-client.test.ts`
- `web/lib/acp-runners/__tests__/readiness.test.ts`

Cases:

- Parameterize read-only round trip over every adapter marked `readOnlyCapable`.
- For each adapter:
  - permission kind `edit` selects deny.
  - permission kind `read` selects allow.
  - permission kind `custom_write` or another unknown kind selects deny.
  - no `session.permission_request` event is emitted.
  - pending permissions remain empty.
- Registry tests assert `readOnlyCapable` exists on both default runtime descriptors and lookup results.
- Smoke-cache schema tests assert a nested `readOnlySession` evidence object
  round-trips through supervisor diagnostics and the web supervisor client.
- Web readiness tests prove generic ACP smoke stays advisory for normal runners
  while read-only launch gating fails closed without read-only-session evidence.

Focused RED command:

```bash
pnpm --filter @maister/supervisor exec vitest run --project integration src/__tests__/adapter-compatibility.integration.test.ts
```

Acceptance:

- The first run fails because descriptors/tests are not wired for all read-only-capable adapters yet, not because the mock fixture is flaky.

### Task 1.3 - Package-skill materialization RED tests

Files:

- `web/lib/agents/__tests__/launch-worktree-modes.integration.test.ts`
- `web/lib/agents/__tests__/dirty-watchdog.integration.test.ts`
- `web/lib/capabilities/__tests__/adapter-home.test.ts`
- `web/lib/packages/__tests__/attach.test.ts` only if shared manifest inventory helpers are changed.
- New focused helper test only if existing files become too broad.

Cases:

- Providing package has skills under at least two
  `manifest.spec.capabilities[*].path/skills/<slug>/SKILL.md` roots and no
  package-root `skills/` directory.
- Providing package also contains a capability-local `agents/` entry proving
  standalone package materialization copies subagents for Claude and omits them
  for non-Claude adapters.
- Standalone launch materializes all package skills for:
  - `workspace: worktree`
  - `workspace: repo_read`
  - `workspace: none`
- Claude cwd materialization writes expected `.claude/skills/<slug>` or existing package-artifact target.
- Gemini cwd materialization writes `.gemini/skills/<slug>`.
- Codex/opencode/mimo home-redirect materialization writes under generated per-session home and returns redirect env.
- Existing user-owned same-name skill directory is preserved when the adapter materializer is in preserve mode.
- Dirty watchdog does not quarantine a clean repo-read run whose only working-tree changes are MAIster-owned materialized skills.
- Dirty watchdog still quarantines a repo-read run with a real extra file.

Focused RED commands:

```bash
pnpm --filter maister-web exec vitest run --project unit lib/capabilities/__tests__/adapter-home.test.ts
pnpm --filter maister-web exec vitest run --project integration lib/agents/__tests__/dirty-watchdog.integration.test.ts lib/agents/__tests__/launch-worktree-modes.integration.test.ts
```

Acceptance:

- Tests fail because standalone launch does not materialize providing-package
  skill roots, assumes the wrong package-root shape, or dirty-watchdog does not
  know generated skill paths yet.

### Task 1.4 - Typed `capability_profile` RED tests

Files:

- `web/lib/agents/__tests__/definition.test.ts`
- `web/lib/agents/__tests__/registry.integration.test.ts`
- Studio validation tests if existing coverage exercises artifact validation.

Cases:

- Accept omitted `capability_profile`.
- Accept `{ mcps: ["github", "postgres"] }`.
- Deduplicate `{ mcps: ["github", "github", "postgres"] }` to `["github", "postgres"]`.
- Reject unknown keys like `skills`, `mcp_servers`, or `restrictions`.
- Reject non-array `mcps`.
- Reject non-string, empty, too-long, or unsafe-id values.
- Reject profiles exceeding the bounded count.
- Render/parse round trip preserves strict profile shape.
- Resync reports invalid legacy package profiles and does not write them.

Focused RED command:

```bash
pnpm --filter maister-web exec vitest run --project unit lib/agents/__tests__/definition.test.ts
```

Acceptance:

- Tests fail because the parser still accepts arbitrary record keys or silently filters invalid MCP ids.

## GREEN Phase 2: Runner-Agnostic Read-Only Agents

### Task 2.1 - Add descriptor capability to both mirrors

Files:

- `web/lib/acp-runners/adapter-support.ts`
- `supervisor/src/adapter-registry.ts`
- `supervisor/src/adapter-smoke-cache.ts`
- `supervisor/src/types.ts`
- `web/lib/supervisor-client.ts`
- `web/lib/acp-runners/readiness.ts`
- `web/lib/acp-runners/__tests__/schema-shape.test.ts` if descriptor shape coverage requires it.
- `supervisor/src/__tests__/adapter-registry.test.ts`

Implementation:

- Add `readOnlyCapable: boolean` to `AdapterSupport`.
- Add the same capability to `AdapterRuntime` or an equivalent runtime descriptor in the supervisor.
- Add helpers such as `isAdapterReadOnlyCapable(adapterId)` only if they remove duplication.
- Default to `false` for any adapter that lacks test/smoke evidence.
- Set descriptor support to `true` only for adapters covered by read-only parity
  tests.
- Extend smoke cache and diagnostics with nested evidence:

```ts
type AdapterSmokeEvidence = {
  readonly status: "ok" | "failed" | "pending" | "skipped";
  readonly reason?: string;
  readonly checkedAt?: string;
  readonly protocolVersion?: string;
};
```

- Add a `readOnlySession?: AdapterSmokeEvidence` dimension alongside generic
  ACP smoke.
- Effective read-only capability for `workspace: none | repo_read` is false
  unless descriptor support is true and `readOnlySession.status === "ok"`, or
  the adapter has a documented not-required classification.
- Do not make generic ACP smoke a global readiness gate for normal runner
  selection.
- Keep adapter ids as the source of identity; do not infer from `capabilityAgent`.

Logging:

- No new logs required in descriptors.
- If smoke evidence is checked during readiness, log structured fields: `adapter`, `readOnlyCapable`, `smokeStatus`, `reason`.

Acceptance:

- Both web and supervisor descriptor tests cover the new field.
- Descriptor values are synchronized by adapter id.
- Diagnostics and web supervisor-client schema tests cover nested
  `readOnlySession` evidence.
- Read-only launch gating fails closed when read-only evidence is missing or not
  ok, while generic readiness semantics stay unchanged.

### Task 2.2 - Replace claude-only read-only runner check

Files:

- `web/lib/acp-runners/resolve.ts`
- `web/lib/acp-runners/__tests__/resolve-agent.test.ts`
- `web/lib/agents/launch.ts`

Implementation:

- Extend `RunnerCatalogEntry` with `readOnlyCapable: boolean`.
- Populate it in `runnerCatalogEntry(...)` from the adapter support descriptor.
- In `resolveAgentRunner(...)`, replace `runner.capabilityAgent !== "claude"` for read-only workspaces with `!runner.readOnlyCapable`.
- Preserve the earlier `dangerously_skip_permissions` refusal.
- Preserve subagent-mode claude-only refusal.
- In launch code, compute the final launch workspace before runner resolution:
  - `const workspace = input.workspace ?? ctx.effective.parsed.workspace`
  - pass this value into runner compatibility checks.
  - use the same value for persisted `runs.agent_workspace`, cwd selection,
    `readOnlySession`, and terminal cleanup expectations.
- Perform read-only runner compatibility before side effects:
  - no worktree creation.
  - no detached repo-read checkout creation.
  - no `runs` insert.
  - no session token issuance.
- Keep `startAgentSession(...)` on the persisted-workspace path; it already uses
  `runs.agentWorkspace ?? effective.parsed.workspace` and should not be
  widened unless tests prove a mismatch.

Errors:

- Throw `MaisterError("EXECUTOR_UNAVAILABLE")` with fields or message context for `runnerId`, `adapter`, `workspace`, `mode`, `permissionPolicy`, and `readOnlyCapable`.

Logging:

- Add or preserve structured debug/info logging around selected runner resolution:
  - `agentId`
  - `projectId`
  - `runnerId`
  - `adapter`
  - `workspace`
  - `runnerResolutionTier`
  - `readOnlyCapable`

Acceptance:

- Task 1.1 tests pass.
- No string match or adapter-name shortcut remains for read-only standalone compatibility.
- Launch override failures leave no run row, no token, and no workspace artifact.

### Task 2.3 - Complete supervisor parity

Files:

- `supervisor/src/acp-client.ts`
- `supervisor/src/__tests__/adapter-compatibility.integration.test.ts`
- `supervisor/test/fixtures/mock-acp-compatibility.mjs`
- `supervisor/src/__tests__/readonly-session.test.ts` if unit coverage needs the unknown-kind case.
- `supervisor/scripts/smoke-acp-adapter.ts` if live smoke cache needs a read-only mode.

Implementation:

- Keep L1 arbitration generic and adapter-independent.
- Add the unknown-kind deny assertion if missing.
- Parameterize adapter compatibility tests from the descriptor list rather than duplicating hard-coded opencode cases.
- Add a `--read-only-session` smoke mode that drives edit/read/unknown
  permission kinds and writes nested read-only evidence to the smoke cache.
- Preserve existing generic smoke behavior and cache fields.

Errors:

- Unknown permission kinds deny by default and must include `sessionId`, `toolCallId`, and `permissionKind` in structured logs.

Acceptance:

- Task 1.2 tests pass.
- Supervisor runtime descriptors and web adapter-support descriptors agree on which adapters are read-only capable.
- Smoke evidence distinguishes generic ACP startup from read-only-session parity.

### Task 2.4 - Timebox opencode native persona investigation

Files:

- `web/lib/acp-runners/adapter-support.ts`
- `web/lib/capabilities/adapter-home.ts`
- `docs/system-analytics/acp-runners.md`

Implementation:

- Inspect the installed opencode adapter/source only for a native persona/agent file convention.
- If it is a pure materialization addition with no new runtime contract, implement it behind the opencode descriptor.
- If it requires unclear runtime semantics, do not implement it in this scope; document that opencode standalone sessions use package skills and prompts without native persona mapping.

Acceptance:

- The decision is explicit in docs.
- Core read-only parity does not depend on this optional improvement.

## GREEN Phase 3: Providing-Package Skill Materialization

### Task 3.1 - Resolve the pinned providing package for standalone agents

Files:

- `web/lib/agents/effective.ts`
- `web/lib/agents/launch.ts`
- `web/lib/packages/attach.ts`
- New helper file only if it keeps functions single-purpose, for example `web/lib/agents/package-skills.ts`.
- Relevant integration tests under `web/lib/agents/__tests__/`.

Implementation:

- Extend `EffectiveAgentDefinition` with `installedPath`.
- For standalone `run_kind: "agent"` launches, resolve skills from the same attached package install that supplied the effective definition.
- Query selectable, non-disabled `capability_records` where:
  - `source === "flow-package"`.
  - `kind === "skill"`.
  - `material.packageInstallId` matches the effective package install id.
- Read the pinned package manifest and derive skill-bearing member roots from
  `manifest.spec.capabilities[*].path/skills`.
- Materialize from those member roots, not from a package-root `skills/`
  directory and not from the newest catalog projection.
- Treat a manifest capability with no `skills/` directory as zero skills.
- Treat a missing recorded skill file under a pinned manifest member root as a
  fail-fast `MaisterError("CONFIG")`.
- Treat a missing installed package path for a package-backed agent as a fail-fast `MaisterError("CONFIG")`.
- Do not include skills from project-local overlays or another package.
- Include package capability subagents for Claude only.
- Do not apply this to flow-driven or flow-node-bound execution paths.

Logging:

- Log a structured event before materialization:
  - `runId`
  - `agentId`
  - `projectId`
  - `packageInstallId`
  - `installedPath`
  - `capabilityRefIds`
  - `skillRoots`
  - `skillCount`
  - `workspace`
  - `adapter`

Acceptance:

- Tests prove stale/newer package catalog entries are ignored in favor of the pinned attached package.
- Tests prove package-root `skills/` is not required when manifest capability
  roots contain skills.
- Missing pinned skill records fail with context containing `agentId`,
  `packageInstallId`, and `capabilityRefId`.

### Task 3.2 - Materialize skills per workspace target and adapter

Files:

- `web/lib/agents/launch.ts`
- `web/lib/capabilities/adapter-home.ts`
- `web/lib/capabilities/__tests__/adapter-home.test.ts`
- `web/lib/agents/__tests__/launch-worktree-modes.integration.test.ts`

Implementation:

- Reuse or wrap `materializeAdapterCapabilityHome(...)` so standalone package
  skills can pass skill-bearing member roots rather than package roots.
- Add an explicit adapter-aware mode if reusing shared copy helpers so only
  Claude receives capability subagents.
- `workspace: worktree`: use the run worktree path, matching flow materialization.
- `workspace: repo_read`: use the detached read-only checkout path when one exists; otherwise use the repo-read cwd selected for the run.
- `workspace: none`: use the session cwd created for the agent run.
- Merge returned redirect env into `adapterLaunch.env`.
- Fail fast on env collisions with different values; do not silently override.
- Keep `mcpServers` composition unchanged except for existing capability profile MCPs and the agent facade server.

Logging:

- Log materialization result with:
  - `runId`
  - `adapter`
  - `workspace`
  - `materializedRoots`
  - `redirectEnvKeys`

Acceptance:

- Claude, gemini, codex, opencode, and mimo descriptor targets are covered by unit or integration tests.
- Launch tests assert the session `cwd` and adapter env match the selected workspace target.
- Launch tests assert capability-local `agents/` directories are copied for
  Claude and omitted for non-Claude adapters.
- Existing flow/scratch adapter-home behavior remains unchanged.

### Task 3.3 - Return precise materialization manifests

Files:

- `web/lib/capabilities/adapter-home.ts`
- `web/lib/capabilities/materialize-bundle.ts`
- `web/lib/agents/dirty-watchdog.ts`
- `web/lib/capabilities/__tests__/adapter-home.test.ts`

Implementation:

- Extend `AdapterHomeResult` with owned materialization paths:
  - `materializedRoots` for generated home directories.
  - `materializedFiles` or `materializedEntries` for cwd-dir skill copies.
- Update copy helpers to report paths they actually created or replaced.
- For claude standalone package skills, record copied skill entries only and do
  not copy or record `.claude/agents`.
- Preserve user-owned same-name cwd skill dirs when current behavior says preserve.
- Never record skipped existing user-owned paths as MAIster-owned.
- For codex project-wins replacement of generated home symlinks, the generated home root remains MAIster-owned and can be removed wholesale.

Acceptance:

- Unit tests prove the manifest includes only MAIster-owned paths.
- Cleanup tests prove same-name user-owned cwd skills survive.

### Task 3.4 - Join manifests to dirty-watchdog and cleanup

Files:

- `web/lib/agents/dirty-watchdog.ts`
- `web/lib/agents/launch.ts`
- `web/lib/agents/__tests__/dirty-watchdog.integration.test.ts`

Implementation:

- Extend materialization restore/filter APIs to accept session-specific owned materialization paths.
- Restore MAIster-owned read-only settings and skill materialization before `git status --porcelain` dirty checks.
- Filter only tracked MAIster-owned paths from porcelain output.
- Recompute or persist enough manifest data to work during terminal cleanup without a DB migration.
- Prefer deterministic recomputation from `runId`, `adapter`, `workspace`, `cwd`, and `effective.installedPath`; use a small MAIster-owned manifest file only if deterministic recomputation cannot distinguish user-owned collisions.
- Ensure terminal cleanup runs on normal completion and failure paths.

Errors:

- If restore fails for a MAIster-owned path, raise or quarantine with clear context; do not silently ignore cleanup failures that affect dirty decisions.

Logging:

- Log cleanup with:
  - `runId`
  - `agentId`
  - `workspace`
  - `restoredPathCount`
  - `dirtyAfterRestore`

Acceptance:

- Clean repo-read run with only generated package skills is not quarantined.
- Dirty repo-read run with real agent-created files is still quarantined.
- Cleanup does not delete user-owned files.

## GREEN Phase 4: Typed `capability_profile`

### Task 4.1 - Define strict profile schema and types

Files:

- `web/lib/agents/definition.ts`
- `web/lib/agents/__tests__/definition.test.ts`
- `web/lib/config.schema.ts` only if an existing id schema needs to be exported.

Implementation:

- Add `AgentCapabilityProfile` type:

```ts
export type AgentCapabilityProfile = {
  readonly mcps?: readonly string[];
};
```

- Replace `z.record(z.unknown())` with a strict zod object.
- Reuse the existing id-shaped capability ref validation where possible.
- Bound count and string length.
- Deduplicate `mcps` preserving first-seen order.
- Omit `capabilityProfile` or `mcps` when empty rather than rendering empty noise.

Errors:

- Parser/registration failures must surface as `MaisterError("CONFIG")` with source path and invalid key/value context.

Acceptance:

- Task 1.4 definition tests pass.
- TypeScript has no `Record<string, unknown>` capability-profile leaks in agent launch paths.

### Task 4.2 - Make registry resync report invalid legacy profiles without writing

Files:

- `web/lib/agents/registry.ts`
- `web/app/api/admin/agents/resync/route.ts` if route response shape already supports invalid item reporting.
- `web/lib/agents/__tests__/registry.integration.test.ts`
- Existing admin/studio tests if they cover resync feedback.

Implementation:

- During package agent resync, use the existing invalid-definition collection
  path with source path and parse error; strengthen messages/tests there rather
  than adding a parallel diagnostics channel.
- Return/report invalid items using existing resync diagnostics.
- Do not update or insert rows for now-invalid definitions.
- Do not erase the last valid installed agent row unless existing resync semantics already remove missing definitions and the invalid item is explicitly treated as missing.
- Keep package install state unchanged unless current code already marks resync failure.

Acceptance:

- Invalid legacy `capability_profile` is visible in resync response/logs.
- No invalid row is written to `agents`.

### Task 4.3 - Align capability-profile MCP resolution

Files:

- `web/lib/agents/launch.ts`
- `web/lib/capabilities/agent-map.ts` if the mapping contract needs a typed input.
- `web/lib/capabilities/__tests__/required-mcp-agent-support.test.ts`
- `web/lib/capabilities/__tests__/exec-trust-mcp-gate.test.ts`

Implementation:

- Replace silent filtering in `resolveAgentProfileMcpServers(...)` with typed strict inputs.
- Keep exec-trust gating for stdio MCPs.
- Preserve no implicit project-default MCP selection.
- Keep selected skills/rules/restrictions empty for this profile shape.

Acceptance:

- MCP profile tests show invalid values fail at registration, not at launch.
- Existing exec-trust MCP gating remains unchanged.

## Refactor Phase 5: Consistency and UX Maturity

### Task 5.1 - Remove duplicated adapter capability logic

Files:

- `web/lib/acp-runners/adapter-support.ts`
- `web/lib/acp-runners/resolve.ts`
- `supervisor/src/adapter-registry.ts`
- Tests touched in Phase 2.

Refactor rules:

- Keep descriptor lookup pure and deterministic.
- Do not add a broad abstraction shared across web and supervisor unless the repo already has a generated/shared contract path.
- Prefer small local helpers over cross-package coupling.

Acceptance:

- No behavior change from Phase 2 GREEN tests.
- The read-only capability cannot drift inside the same package without a failing test.

### Task 5.2 - Update docs to as-built behavior

Files:

- `docs/system-analytics/agents.md`
- `docs/system-analytics/acp-runners.md`
- `docs/system-analytics/capabilities.md`
- `docs/flow-dsl.md`
- `docs/screens/settings-acp-runners.md`
- `docs/screens/projects/project-settings-agents.md`
- `docs/screens/studio/editor.md` if applicable.
- `docs/api/web.openapi.yaml`, `docs/api/supervisor.openapi.yaml`, `docs/api/async/supervisor-sse.asyncapi.yaml` only if a wire shape actually changed.
- `docs/database-schema.md` only if a DB shape actually changed; expected unchanged.

Acceptance:

- Docs state current behavior, not a changelog.
- No duplicate documentation across files; deep details live in system analytics, screen docs keep user-visible expectations.
- OpenAPI/AsyncAPI are either unchanged with explicit verification, or updated and validated if a real contract changed.

### Task 5.3 - UI/UX validation of visible states

Files:

- `web/components` and `web/app` only if existing UI text/validation becomes inaccurate.
- Screen docs listed above.

Checks:

- Runner selection or validation UI no longer implies read-only equals claude-only.
- Error messages for invalid agent profiles are actionable and source-specific.
- Studio validation reports strict `capability_profile` errors clearly.
- No new in-app explanatory walls of text.

Acceptance:

- Any UI edits are minimal and tied to the changed concepts.
- Screen docs match the visible UI behavior.

## Verification Phase 6

Run focused tests first, then full relevant suites.

### Focused verification

```bash
pnpm --filter maister-web exec vitest run --project unit lib/acp-runners/__tests__/resolve-agent.test.ts
pnpm --filter maister-web exec vitest run --project unit lib/acp-runners/__tests__/readiness.test.ts lib/__tests__/supervisor-client.test.ts
pnpm --filter maister-web exec vitest run --project unit lib/agents/__tests__/definition.test.ts
pnpm --filter maister-web exec vitest run --project unit lib/capabilities/__tests__/adapter-home.test.ts
pnpm --filter maister-web exec vitest run --project integration lib/agents/__tests__/dirty-watchdog.integration.test.ts lib/agents/__tests__/launch-worktree-modes.integration.test.ts
pnpm --filter @maister/supervisor exec vitest run --project unit src/__tests__/types.test.ts src/__tests__/adapter-registry.test.ts
pnpm --filter @maister/supervisor exec vitest run --project integration src/__tests__/adapter-compatibility.integration.test.ts
```

### Full relevant suites

```bash
pnpm --filter maister-web typecheck
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration
pnpm --filter @maister/supervisor typecheck
pnpm --filter @maister/supervisor test:unit
pnpm --filter @maister/supervisor test:integration
pnpm --filter @maister/mcp typecheck
pnpm --filter @maister/mcp test
pnpm validate:docs
pnpm validate:contracts
```

### Check-only lint

Use check-only ESLint, not package `lint` scripts because those run `--fix`.

```bash
pnpm --filter maister-web exec eslint .
pnpm --filter @maister/supervisor exec eslint .
pnpm --filter @maister/mcp exec eslint .
```

### Optional live smoke

Run only where adapter binaries and credentials are installed:

```bash
pnpm --filter @maister/supervisor smoke:acp -- --read-only-session gemini
pnpm --filter @maister/supervisor smoke:acp -- --read-only-session opencode
pnpm --filter @maister/supervisor smoke:acp -- --read-only-session mimo
```

Acceptance:

- All focused and full relevant suites are green.
- If optional smoke cannot run locally, record that as environment unavailable and keep non-smoked adapters fail-closed unless cached evidence already exists.

## Completeness Checklist

- [x] Every attached request item maps to a task and acceptance criterion.
- [x] Every changed runtime behavior has a RED test before implementation.
- [x] Tests cover required edge cases with minimal overlap.
- [x] No tests assert trivial constructors or static constants without behavior.
- [x] API contracts are checked and either unchanged or updated.
- [x] AsyncAPI contracts are checked and either unchanged or updated.
- [x] DB migrations are checked and remain unchanged.
- [x] System analytics docs describe current as-built behavior.
- [x] Screen docs describe user-visible behavior and validation.
- [x] Runner compatibility uses `readOnlyCapable`, not adapter name.
- [x] Read-only capability uses descriptor support plus read-only-session smoke
      evidence, not a static flag alone.
- [x] Read-only compatibility is checked before launch side effects.
- [x] L1 read-only arbitration denies unknown permission kinds by default.
- [x] L2 materialization is best effort and manifest-owned.
- [x] L3 dirty-watchdog still catches real repo-read writes.
- [x] Package skills come from the pinned providing package install.
- [x] Package skills come from pinned manifest capability roots, not package-root
      `skills/`.
- [x] Standalone package materialization copies capability subagents for Claude
  and omits them for non-Claude adapters.
- [x] User-owned skill and subagent files are preserved.
- [x] `capability_profile` strictness is enforced at registration/resync.
- [x] Implementation uses structured logs and `MaisterError` for known domain failures.
- [x] Implementation follows project conventions, SOLID, KISS, DRY, strict
      typing, and single-purpose helpers.
- [x] Full verification commands are recorded with pass/fail results.

## Verification Results

- PASS: `CI=true pnpm validate:docs`.
- PASS: `CI=true pnpm validate:contracts`.
- PASS: web and supervisor `CI=true pnpm exec tsc --noEmit`.
- PASS: targeted web/supervisor `eslint` for changed TypeScript files.
- PASS: focused web unit tests for runner resolution, supervisor client
  diagnostics, agent definition parsing, adapter-home package skills,
  dirty-watchdog package-skill manifest restore, readiness summary, and adapter
  support panel.
- PASS: focused supervisor unit tests for adapter registry, smoke cache, and
  diagnostics response schema.
- PASS: focused supervisor smoke-script regression proves
  `--read-only-session` can produce nested `ok` evidence only after ACP prompt
  probes observe read allow, write deny, and unknown-kind deny decisions.
- BLOCKED BY ENV: web full unit suite has unrelated failures from sandboxed
  localhost listen denial and a `better-sqlite3` Node ABI mismatch.
- BLOCKED BY ENV: supervisor full unit suite has unrelated sandboxed localhost
  listen denial in route tests.
- BLOCKED BY ENV: Testcontainers-backed web integration tests cannot run because
  no working container runtime is available.

## Commit Plan

Use focused commits after tests are green; do not commit a deliberately red state.

1. `docs: specify agent runner parity contracts`
   - Phase 0 docs/system analytics/screens and ADR decision if needed.
2. `test: cover read-only runner parity and package skills`
   - RED tests adjusted to pass once implementation lands; commit only after GREEN if the repo policy requires green commits.
3. `feat: gate read-only agents by adapter capability`
   - Descriptor mirrors, runner resolution, supervisor parity, launch workspace consistency.
4. `feat: materialize providing package skills for agents`
   - Pinned package resolver, adapter materialization, env merge, dirty-watchdog manifest and cleanup.
5. `feat: type agent capability profiles`
   - Strict parser/types, registry resync reporting, MCP profile resolution.
6. `chore: verify contracts and lint changed surfaces`
   - Final docs parity, contract validation, no-migration proof, check-only lint fixes if needed.

## Final Go/No-Go

Go only when:

- All acceptance criteria are checked.
- The completeness checklist has no open item.
- No API or DB drift is unaccounted for.
- The implementation branch has a clean `git --no-pager diff` review with no unrelated changes.
- The Tact-3 overlap files have been rebased or manually reviewed for conflicts.

No-go when:

- Any adapter passes read-only standalone gating without descriptor support and
  ok read-only-session smoke evidence or a documented not-required
  classification.
- Any adapter is marked `readOnlyCapable` without behavior tests.
- Read-only runner incompatibility can create a worktree, detached checkout,
  run row, or session token before failing.
- Implementation assumes package-root `skills/`.
- Standalone package materialization omits capability subagents for Claude or
  copies them for non-Claude adapters.
- Materialized skill/subagent cleanup can delete user-owned files.
- Repo-read dirty-watchdog ignores real agent writes.
- Invalid legacy `capability_profile` rows can be silently written.
- Docs/screens still describe the old claude-only read-only constraint.
