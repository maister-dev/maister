# Implementation Plan: Graded Runner Resolution

Branch: detached `HEAD` in Codex worktree; intended branch stem `feature/graded-runner-resolution`
Created: 2026-07-06
Improved: 2026-07-06

## Settings

- Testing: yes, TDD required
- Logging: verbose, structured fields only
- Docs: yes, SDD required

## Goal

Allow Flow runner slots to launch on an enabled and ready host runner with the
same `capability_agent` when only soft intent fields differ (`model` and/or
`provider.kind`). Exact matches stay silent. Same-capability fallback launches
and emits a durable warning that is visible before launch, stored on the run,
mirrored into `run.events.jsonl`, and surfaced in the run UI.

`capability_agent` remains a hard physical contract. A slot that requires
`claude` must never launch on `codex`, `gemini`, `opencode`, or `mimo`.

## SDD Operating Contract

The implementation starts with a contract pass before production code changes.
This feature changes semantics, API DTOs, a durable event union, DB schema, and
run UI. Those surfaces must agree before the resolver implementation lands.

1. Freeze the warning object shape once and reuse it across resolver return
   types, launch-options DTOs, `run_sessions.resolution_warning`, run event
   payloads, and UI props.
2. Update external contracts and product analytics docs in the same phase:
   `docs/api/web.openapi.yaml`, `docs/api/async/web-runs.asyncapi.yaml`,
   `docs/system-analytics/acp-runners.md`, `docs/system-analytics/sessions.md`
   if session persistence semantics need the warning field, DB docs/ERDs, and
   screen docs for the launch dialog and run detail.
3. Treat docs as current-state specs, not a changelog. Do not document fields
   that no implementation task below will deliver.
4. Run `pnpm validate:docs` and `pnpm validate:contracts` after docs/contract
   edits and again in final verification.

## TDD Operating Contract

Each implementation phase follows RED -> GREEN -> refactor.

- RED: write the smallest failing test that proves the required behavior or
  edge case. For contract/spec changes, first add or update the contract test or
  schema fixture that fails against the current code.
- GREEN: implement only enough code, migration, UI, or docs to pass that test.
- Refactor: remove duplication and tighten names/types without changing
  behavior. Re-run the phase's focused test before moving on.

Tests must be behavior-focused and non-overlapping. Do not add trivial coverage
that only repeats type declarations, snapshots static markup without an
asserted behavior, or mocks away the resolver path being validated.

## Verified Current State

- `web/lib/acp-runners/resolve.ts` exposes `autoMatchRunners()` as a boolean
  filter over enabled+ready runners, exact `capabilityAgent`, exact `model`,
  and exact `provider.kind`. `resolveRunnerSlot()` throws
  `EXECUTOR_UNAVAILABLE` when that filter returns zero matches.
- `resolveAgentRunner()` already refuses subagent-mode on non-Claude runners,
  `dangerously_skip_permissions` outside worktree mode, and read-only
  `none`/`repo_read` workspaces on non-Claude runners. Those refusals are out
  of scope for weakening.
- `resolveRunSessions()` applies project/flow/platform defaults only for
  config-less sessions. Slot-declared runner intent currently has no graded
  fallback path.
- `web/lib/flows/graph/consensus/roles.ts` resolves consensus runner slots with
  catalog + bindings only. It currently does not load project/platform default
  runner ids, so the fallback-default task must add real inputs there.
- `GET /api/runs/launch-options` degrades unresolved session previews to
  `runnerId: null`, while actual `POST /api/runs` still fails before worktree
  side effects on unresolved/ambiguous/no-capability slots.
- `run_sessions` is the sole source of truth for per-run runner state. There is
  no current `resolution_warning` column.
- `appendRunStreamEvent()` currently stamps `sessionName: "default"` for every
  appended event, so multi-session warning events need either a helper extension
  or a dedicated append path.
- The local task mirror directory `projects/maister/tasks/` is absent and must
  be created by the docs/spec task.

## Required Acceptance Criteria

- AC1 Exact match: one enabled+ready runner matching
  `capability_agent + model + provider.kind` is selected with no warning.
- AC2 Base-model variant mismatch: requested `claude-opus-4-8` may launch on
  same-capability `claude-opus-4-8[1m]`; the warning says the flow requested
  `claude-opus-4-8` and launched on `claude-opus-4-8[1m]`.
- AC3 Provider-kind mismatch: a same-capability runner may launch when only
  `provider.kind` differs; the warning names requested and launched provider
  kinds.
- AC4 Both soft fields differ: model and provider mismatch still launch only
  within the requested capability and emit one combined warning.
- AC5 Capability absent: no enabled+ready runner with the requested
  `capability_agent` throws `EXECUTOR_UNAVAILABLE`.
- AC6 Ambiguous exact match: more than one exact candidate still throws
  `CONFIG` and requires a per-project binding.
- AC7 Fallback priority: after no exact match, select same base model first,
  then project default of the same capability, then platform default of the same
  capability. Disabled/not-ready defaults are skipped as fallback candidates;
  if no same-capability fallback remains, throw `EXECUTOR_UNAVAILABLE`.
- AC8 Explicit override/binding/host-id refs stay explicit. Missing, disabled,
  or not-ready named runners still refuse through `assertLaunchableRunner()`;
  the soft fallback only applies to intent auto-resolution.
- AC9 Launch-options preview returns warning data for fallback previews and does
  not collapse those slots to `runnerId: null`. Capability-absent and ambiguous
  previews still use the existing unresolved preview behavior.
- AC10 Actual launch persists warnings in `run_sessions.resolution_warning` in
  the same transaction that inserts session rows.
- AC11 Actual launch appends one durable advisory event per warning to
  `.maister/<slug>/runs/<runId>/run.events.jsonl` after commit. Each event keeps
  the correct logical session name.
- AC12 The run UI surfaces persisted runner-resolution warnings even if the
  post-commit event append fails. The event log is a timeline/audit mirror; the
  DB column is the durable source of truth.
- AC13 `resolveAgentRunner()` compatibility refusals remain green and unchanged.
- AC14 No provider secrets, `env`, `authToken`, `apiKey`, sidecar auth refs, or
  full provider objects appear in API payloads, DB warning payloads, run events,
  or logs.

## Warning Data Contract

Use one typed object, with the exact name finalized during implementation:

```ts
type RunnerResolutionWarning = {
  readonly code: "runner_intent_soft_mismatch";
  readonly slotKey: string;
  readonly sessionName?: string;
  readonly requested: {
    readonly capabilityAgent: string;
    readonly model?: string;
    readonly providerKind?: string;
  };
  readonly launched: {
    readonly runnerId: string;
    readonly capabilityAgent: string;
    readonly model: string;
    readonly providerKind: string;
  };
  readonly message: string;
};
```

The resolver creates the object without side effects. Callers may add
`sessionName` when resolving full run sessions. The message is concise and
operator-facing: `flow requested model=X/provider=Y, launched on runner R
(model=A/provider=B)`.

## Resolution Matrix

| Case | Catalog state | Expected result |
| --- | --- | --- |
| Exact singleton | one enabled+ready exact same capability/model/provider | select `autoMatch`, no warning |
| Exact ambiguous | two enabled+ready exact same capability/model/provider | throw `CONFIG` |
| Model variant | only same capability `model[variant]` | select same-base candidate, warning |
| Provider skew | same capability/model, different provider kind | select fallback candidate, warning |
| Both skewed | same capability, model/provider both different | select fallback candidate, warning |
| Capability absent | only different capability runners exist | throw `EXECUTOR_UNAVAILABLE` |
| Soft fallback default points elsewhere | project/platform default has different capability | skip it, keep searching same capability only |
| Explicit bad override | override/binding/direct host id missing, disabled, or not ready | throw `EXECUTOR_UNAVAILABLE`; no graded fallback |

## Contract Surfaces

| Surface | Required update |
| --- | --- |
| `docs/api/web.openapi.yaml` | Add reusable `RunnerResolutionWarning` schema and optional warning fields on `TaskRunLaunchOptionsResponse.selectedRunnerWarning` and each `sessions[]` item. Keep secrets excluded. |
| `docs/api/async/web-runs.asyncapi.yaml` | Add a durable web-side advisory event, for example `run.runner_resolution_warning`, with required warning fields and correct `sessionName`. |
| `docs/system-analytics/acp-runners.md` | Specify hard capability matching, soft model/provider fallback ranking, exact ambiguity, capability absence, and warning surfaces. |
| `docs/system-analytics/sessions.md` | Add the run-session persistence rule only if the DB field lands there as part of the current session model. |
| `docs/database-schema.md`, `docs/db/runs-domain.md`, `docs/db/erd.md` | Add nullable `run_sessions.resolution_warning jsonb` and explain DB as durable audit source. |
| `docs/screens/chrome/launch-dialog.md` | Show launch warning behavior as non-blocking. |
| `docs/screens/runs/flow-run.md` or run-detail screen doc | Show persisted warning surface on a run. |
| `projects/maister/tasks/graded-runner-resolution.md` | Create the local task mirror with requirements, acceptance criteria, and test matrix. |

No new env vars, ports, sidecars, config files, external services, or HTTP
routes are planned. One additive nullable DB column and one additive durable run
event type are planned.

## Commit Plan

- Commit 1 after Tasks 1-3: `test(runners): specify graded slot resolution`
- Commit 2 after Tasks 4-6: `feat(runners): resolve soft intent mismatches`
- Commit 3 after Tasks 7-9: `feat(runs): persist runner resolution warnings`
- Commit 4 after Tasks 10-12: `feat(ui): surface runner resolution warnings`
- Commit 5 after Tasks 13-14: `test(runners): verify graded launch path`

## Tasks

### Phase 0: SDD Contract Freeze

- [x] Task 1: Create the local spec mirror and update contract docs.
  - RED: run `pnpm validate:docs` and `pnpm validate:contracts` before edits to
    capture the current baseline.
  - Deliverables: create `projects/maister/tasks/graded-runner-resolution.md`;
    update the contract surfaces listed above.
  - Requirements: the docs define hard vs soft matching, exact ambiguity,
    capability absence, fallback priority, warning shape, launch preview, DB
    persistence, durable event, and run UI surface.
  - Acceptance: docs validate; no contract documents a field/event that is not
    assigned to an implementation task below.

- [x] Task 2: Add contract/schema tests that fail against the current code.
  - RED tests:
    - launch-options contract test expects optional warning objects on selected
      runner and session preview payloads;
    - run-stream event helper test expects a non-default session name can be
      preserved for a web-side advisory event;
    - schema-shape test expects `run_sessions.resolution_warning`.
  - Acceptance: these tests fail for the expected missing-field/missing-event
    reasons before production code changes.

### Phase 1: Resolver RED Tests

- [x] Task 3: Add resolver tests before changing resolver behavior.
  - RED tests in `web/lib/acp-runners/__tests__/resolve-sessions.test.ts`:
    exact-match silent, base-model normalization, model-only mismatch fallback,
    provider-kind mismatch fallback, model+provider mismatch fallback,
    capability absent `EXECUTOR_UNAVAILABLE`, more-than-one exact `CONFIG`,
    same-capability project/platform default ranking, and explicit
    override/binding no-fallback refusal.
  - Regression tests in `resolve-agent.test.ts`: existing subagent/read-only
    refusals still throw `EXECUTOR_UNAVAILABLE`; standalone agent resolutions do
    not produce runner slot warnings.
  - Acceptance: targeted resolver tests fail only where graded behavior is
    missing; existing strict-agent tests remain meaningful.

### Phase 2: Resolver GREEN And Refactor

- [x] Task 4: Add pure base-model normalization and graded candidate selection.
  - Deliverable: replace `autoMatchRunners()` with a graded API or keep the name
    only if its return type no longer implies boolean filtering. Add a pure
    helper that strips exactly one trailing bracket suffix, e.g.
    `claude-opus-4-8[1m] -> claude-opus-4-8`.
  - Requirements: exact matching still compares original strings; normalization
    is used only for soft fallback ranking. Disabled, not-ready, and different
    capability runners are never candidates.
  - Logging: none in pure resolver helpers.
  - GREEN: resolver RED tests for ranking and normalization pass.

- [x] Task 5: Update `resolveRunnerSlot()` and `resolveRunSessions()`.
  - Deliverable: return `resolutionWarning?: RunnerResolutionWarning` on
    resolved slots/sessions; add fallback-default inputs to slot resolution.
  - Requirements: no warning on exact match or explicit override/binding/direct
    host id; one warning on soft fallback; exact ambiguity and capability
    absence throw the required `MaisterError` codes.
  - Refactor: keep the ranking code small and named by intent, not embedded in
    one large branch.
  - GREEN: all resolver tests pass.

- [x] Task 6: Update consensus slot resolution inputs.
  - Deliverable: `web/lib/flows/graph/consensus/roles.ts` loads/passes project
    default and platform default runner ids so consensus slots use the same
    fallback ranking.
  - Requirements: consensus keeps `CONFIG` when a role omits a runner; it does
    not lose binding priority.
  - Tests: add focused coverage if there is an existing consensus resolver test;
    otherwise include this path in the launch integration fixture only if it is
    practical without broad setup.

### Phase 3: Persistence And Durable Run Log

- [x] Task 7: Add nullable DB warning persistence.
  - RED: schema-shape/migration test fails before the column exists.
  - Deliverables: add `resolutionWarning` to `web/lib/db/schema.ts`, generate the
    next Drizzle migration after `0091`, update migration metadata, and update
    DB docs/ERDs.
  - Data shape: JSONB stores `RunnerResolutionWarning`; nullable for exact
    matches and legacy rows.
  - Acceptance: migration is additive/backward compatible; no existing reader
    requires the field.

- [x] Task 8: Thread warnings through actual launch.
  - RED: launch integration test expects an `aif-dev`-style flow requesting
    `claude-opus-4-8` to launch against only `claude-opus-4-8[1m]`, persist
    `run_sessions.resolution_warning`, and never leak secrets.
  - Deliverables: collect warnings from `sessionResolutions`; write each warning
    into the matching `run_sessions` insert inside the existing transaction.
  - Logging: emit one structured `WARN` per intentional soft fallback with
    `{ runId, taskId, projectId, sessionName, slotKey, warningCode,
    requestedModel, launchedModel, requestedProviderKind,
    launchedProviderKind, runnerId }`. Do not log provider/env secrets.
  - GREEN: launch integration passes for persistence and secret hygiene.

- [x] Task 9: Append durable warning events after launch commit.
  - RED: `appendRunStreamEvent` or a new helper test expects a caller-supplied
    `sessionName` to survive, and the launch integration expects a
    `run.runner_resolution_warning` line in `run.events.jsonl`.
  - Deliverables: extend the helper or add a sibling helper for web-side run
    advisory events; append one warning event after the run/session transaction
    commits and after the worktree/run directory exists.
  - Failure behavior: if event append fails, log structured `ERROR` with run and
    session context, keep the launch response successful, and rely on the DB
    warning as source of truth.
  - GREEN: durable event tests pass and multi-session warnings keep their
    session names.

### Phase 4: API Preview And UI

- [x] Task 10: Surface warning data in launch-options.
  - RED: `web/app/api/runs/launch-options/__tests__/route.test.ts` expects the
    soft mismatch preview to return warning data and a resolved runner id.
  - Deliverables: add `selectedRunnerWarning?: RunnerResolutionWarning` for the
    single-selector path and `warning?: RunnerResolutionWarning` on each
    `sessions[]` item; update local DTOs/types.
  - Requirements: soft mismatch preview remains launchable; capability absence
    and exact ambiguity still degrade unresolved preview slots to `runnerId:
    null`; response never includes provider secrets.
  - GREEN: route tests pass, including existing unresolved-preview regression.

- [x] Task 11: Render non-blocking warnings in the launch dialog.
  - RED: component test covers a pure warning-label/selection helper or render
    path using the existing no-jsdom static-render style where possible.
  - Deliverables: update `web/components/board/launch-popover.tsx` and EN/RU
    messages to show a compact amber warning near the runner/session selector.
  - Requirements: warning does not disable Launch; unresolved `runnerId: null`
    still blocks or requires binding as it does today. Text must fit the compact
    dialog and include requested/actual model/provider when present.
  - GREEN: launch-popover tests pass and EN/RU key parity remains green.

- [x] Task 12: Surface persisted warnings in run UI.
  - RED: run detail/query or component test expects persisted
    `run_sessions.resolution_warning` to appear in the run UI model/markup.
  - Deliverables: extend the run query DTO with session warning summaries and
    render a compact warning in the flow run detail/header or nearest existing
    run observability surface. Update the matching screen doc.
  - Requirements: UI reads DB warnings so it still works if post-commit event
    mirroring failed. The durable event remains the run-log/audit trail.
  - GREEN: focused run UI/query test passes.

### Phase 5: Edge Cases And Final Verification

- [x] Task 13: Complete resolver and launch edge-case coverage.
  - Tests:
    - same base model beats default fallback;
    - project default beats platform default only when same capability and
      enabled+ready;
    - platform default with wrong capability is skipped;
    - disabled/not-ready same-capability default is skipped;
    - no same-capability fallback after exact miss throws
      `EXECUTOR_UNAVAILABLE`;
    - `resolveAgentRunner()` strict refusals still fire.
  - Acceptance: no duplicate tests that assert the same branch through a
    different fixture name only.

- [x] Task 14: Run final verification and consistency checks.
  - Commands:
    - `pnpm --filter maister-web exec vitest run --project unit lib/acp-runners/__tests__/resolve-sessions.test.ts lib/acp-runners/__tests__/resolve-agent.test.ts`
    - `pnpm --filter maister-web exec vitest run --project unit lib/runs/__tests__/run-stream-event.test.ts lib/db/__tests__/schema-shape.test.ts lib/db/__tests__/migration-journal-integrity.test.ts`
    - `pnpm --filter maister-web exec vitest run --project unit app/api/runs/launch-options/__tests__/route.test.ts components/board/__tests__/launch-popover.test.ts`
    - `pnpm --filter maister-web exec vitest run --project integration app/api/runs/__tests__/route.enforcement.integration.test.ts`
    - `pnpm --filter maister-web db:generate`
    - `pnpm --filter maister-web typecheck`
    - `pnpm --filter maister-web lint`
    - `pnpm validate:docs`
    - `pnpm validate:contracts`
  - If the integration lane cannot run locally because Docker/Testcontainers is
    unavailable, record that explicitly and still run unit/typecheck/lint/docs
    and contract gates.
  - Result: focused unit suite passed after lint (`10` files, `112` tests);
    `typecheck`, `lint`, `validate:docs`, and `validate:contracts` passed.
    The integration lane was blocked before assertions by Testcontainers:
    `Could not find a working container runtime strategy`. `db:generate` exited
    `0` but still reports the existing Drizzle snapshot-parent collision between
    `0089_snapshot.json` and `0090_snapshot.json`; the additive `0092` migration
    and migration journal are covered by focused unit tests.

## Final Consistency Checklist

- [x] API contract, route DTO, and UI local type use the same warning field
  names.
- [x] AsyncAPI event type matches the event emitted to `run.events.jsonl`.
- [x] DB schema, migration snapshot, DB docs, and run query all agree on
  `run_sessions.resolution_warning`.
- [x] `capability_agent` is never normalized, ranked, or softened.
- [x] Base-model normalization is only used for fallback ranking.
- [x] Soft fallback cannot hide an ambiguous exact match.
- [x] Launch preview and actual launch disagree only in the existing intentional
  way: preview may degrade unresolved slots to `runnerId: null`; actual launch
  blocks before side effects.
- [x] Secret hygiene is asserted in API, event, DB warning, and log tests where
  those surfaces are touched.
- [x] All acceptance criteria AC1-AC14 map to at least one focused test or
  explicit manual verification line.
