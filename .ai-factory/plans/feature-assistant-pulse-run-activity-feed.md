# Assistant Pulse + Run Activity Feed v1 Implementation Plan

> Planning-only pass. No git branch/worktree was created in this step so the
> repo state stays unchanged outside this artifact.

**Goal:** Expose one assistant-friendly ext API pulse that answers "what
happened since I last looked?" and "what are active runs doing right now?",
plus a per-run semantic activity feed, without shipping raw ACP frames or
changing supervisor/runtime collection.

**Architecture:** Keep the existing storage and runtime boundaries. Build one
server-only assistant-activity layer on top of `domain_events`, the durable
`run.events.jsonl` + transcript coalescer/projector, `run_messages`
`supervisor_event_id`, and existing run/HITL read models. The ext routes and
MCP facade both read that shared layer. No supervisor changes, no raw ACP
passthrough, and no new collection paths.

**Tech Stack:** Next.js 16 App Router, strict TypeScript, Drizzle/Postgres
(default path: no migration unless Phase 0 disproves it), vitest unit +
integration, existing ext-token auth + audit boundary, existing MCP
tool-contract guard, existing docs validation lane.

Branch: none
Created: 2026-07-26

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage

Milestone: "none"
Rationale: This slice changes the assistant/ext surface, semantic projection,
and analytics narrative, but it does not cleanly map onto a single named
roadmap milestone in this planning pass.

## Research Context

Source:
`/Users/developer/.codex/attachments/8a27a9d5-e0ad-40fd-8bf9-b613523d6d64/pasted-text.txt`

Feature ask distilled into delivery requirements:
- Ship `GET /api/v1/ext/activity` and `GET /api/v1/ext/runs/{runId}/activity`
  plus matching MCP tools so an assistant can answer "what happened?" and
  "what is happening now?" in one or two calls.
- Make the plan SDD-driven and implementation TDD-driven with explicit
  `RED -> GREEN -> REFACTOR` slices.
- Treat API contracts, DB migrations, system analytics, and UX maturity as
  first-class deliverables rather than cleanup.
- Verify the plan for completeness, consistency, logical gaps, concrete
  expectations, requirements, and acceptance criteria before coding starts.

Non-negotiable constraints:
- No supervisor changes.
- No raw ACP / JSON-RPC passthrough.
- No new data collection.
- Adapter-agnostic DTO kinds across Claude/Codex fixtures.
- Cursor replay must resurface in-place mutations.
- Liveness states are synthesized, not stored.
- Implementation must stay consistent with specs/requirements/acceptance
  criteria and project code conventions.

## Scope Lock

In scope:
- A shared assistant-activity server module that powers both ext routes and MCP.
- One cross-run pulse surface for "happened", "now", and "needs-you".
- One per-run semantic activity feed with cursor-based replay.
- Spec/doc work across OpenAPI, system-analytics, configuration, and DB notes.
- Runtime config for liveness thresholds if the truth table needs tunable ages.
- Focused tests that cover required behavior and edge cases without duplicate or
  trivial cases.

Out of scope for v1 unless Phase 0 proves otherwise:
- New supervisor event kinds or runtime collection hooks.
- A new internal product screen or a redesign of existing run-detail UI.
- A new token scope, unless route authorization proof shows `runs:read` is
  insufficient.
- A DB migration, unless the Phase 0 proof shows the current substrate cannot
  satisfy cursor stability or semantic replay requirements.

## SDD Freeze Requirements

Before implementation starts, the specification pass MUST leave the following
artifacts internally consistent:
- `docs/api/external/operations.openapi.yaml` defines both routes, all query
  params, response DTOs, error shapes, and examples.
- `docs/system-analytics/assistant-activity.md` is created as the canonical
  analyst view for this domain and follows the required structure from
  `docs/CLAUDE.md`.
- `docs/system-analytics/external-operations.md`, `runs.md`, and `hitl.md`
  link to the new assistant-activity boundary instead of restating it.
- `docs/system-analytics/README.md` glossary includes the new domain file.
- `docs/CLAUDE.md` only changes if the glossary/routing rules require a new
  reference for the added artifact; avoid unrelated prose changes.
- If DB semantics or invariants need explanation, link to the canonical DB docs
  instead of duplicating schema descriptions in system-analytics prose.

The spec freeze is not complete until every unresolved choice below is either
decided or explicitly moved into a documented non-goal:
- Opaque cursor shape for pulse vs per-run feed.
- Whether pulse `now` is always a full snapshot or only rereturns runs whose
  mutation horizon advanced.
- Exact `salience` contract.
- Exact `needs-you` inclusion rules.
- The fallback rule if `run_messages.supervisor_event_id` is insufficient for
  mutation replay.

## Current State

- `domain_events` already provides a project-scoped append-only fact log via
  `web/lib/domain-events/taxonomy.ts` and `web/lib/domain-events/dispatch.ts`.
- The durable transcript substrate already exists in
  `web/lib/run-transcript/transcript.ts`,
  `web/lib/run-transcript/coalesce.ts`, and
  `web/lib/runs/run-transcript-projector.ts`.
- Flow runs already materialize coalesced transcript rows into `run_messages`
  with `supervisor_event_id`; standalone agent/scratch runs already have a
  whole-run coalescer path in `getAgentRunTranscript()` from
  `web/lib/services/runs.ts`.
- Ext auth/audit/project binding already lives in
  `web/lib/tokens/ext-handler.ts` and existing routes under
  `web/app/api/v1/ext/*`.
- Existing `GET /api/v1/ext/hitl` is global personal-token inbox behavior and
  is not the same contract as the planned project-scoped assistant pulse.
- Existing `web/lib/queries/activity.ts` is a separate portfolio/project
  activity query surface and should not silently become the source of truth for
  this feature.
- MCP already fronts ext routes through `mcp/src/tools.ts` with drift tests in
  `mcp/src/__tests__/tool-contract.test.ts` and
  `mcp/src/__tests__/tools.test.ts`.

## Decisions

- **D1 Route/auth contract:** add `GET /api/v1/ext/activity` and
  `GET /api/v1/ext/runs/{runId}/activity`; both reuse `handleExt()`, stay
  project-bound, and require the existing `runs:read` scope unless the spec
  freeze proves that a narrower or broader scope is required.
- **D2 Shared DTO layer:** ext routes, MCP, and future internal reuse must read
  one shared, client-safe DTO model for items, salience, cursors, and pulse
  snapshots so the surfaces do not drift.
- **D3 Default DB strategy:** assume no migration first and prove the feature on
  top of `domain_events.id`, `run_messages.supervisor_event_id`,
  `runs.current_step_id`, and existing HITL/read-model timestamps.
- **D4 Migration fallback:** if the proof shows the current substrate cannot
  deliver stable replay, mutation resurfacing, or required semantics, stop and
  add one explicit additive migration slice before shipping code. Do not hide
  a schema dependency behind "best effort" logic.
- **D5 Active-run set for `now`:** `Running`, `NeedsInput`, `NeedsInputIdle`,
  and `HumanWorking` only, across `flow`, `scratch`, and standalone `agent`
  runs. Do not invent flow-node ids for runs that do not have them.
- **D6 Needs-you semantics:** keep this project-scoped and reuse the existing
  HITL/clarification read models. Do not piggyback the global `hitl_inbox`
  contract.
- **D7 Liveness is synthesized only:** `working`, `silent`,
  `waiting-on-tool`, `waiting-on-human`, and `stalled` are rendered states, not
  stored statuses or new event kinds.
- **D8 UX maturity contract:** even without a new UI screen, the DTO and copy
  semantics must be human-readable, stable across calls, localized-ready, and
  explicit about uncertainty or waiting states. No raw protocol jargon should
  leak into user-facing fields.
- **D9 Contract drift prevention:** OpenAPI, route JSON, MCP schemas, and
  system-analytics expectations are a single contract. Any divergence found in
  Phase 0 or verification is a defect, not a follow-up idea.

## Requirements

- The pulse route MUST let an assistant answer both "what changed?" and "what
  is active right now?" without a second cross-run route.
- The per-run route MUST expose semantic items rather than raw ACP frames and
  MUST preserve mutation replay semantics across repeated polling.
- Every response MUST remain project-scoped and MUST NOT accept a client-chosen
  project slug or filesystem locator.
- The contract MUST clearly distinguish persisted facts from synthesized
  liveness/summary judgments.
- The implementation MUST either prove the no-migration path or land one
  explicit additive migration plus DB doc updates.
- The implementation MUST stay reusable for future UI work and MUST NOT bake
  MCP- or route-specific formatting into core activity builders.
- The implementation MUST follow SOLID, KISS, DRY, and the repository's
  current conventions without introducing speculative abstractions or
  multi-mode helpers that hide domain rules.

## UX Maturity Contract

This feature does not add a new product screen in v1, but the implementation
still needs UI-grade semantics because assistants and future internal surfaces
will render the same DTOs.

- Item fields MUST be descriptive enough to display without a second lookup for
  common assistant/status surfaces.
- `needs-you` entries MUST say what kind of human attention is required and
  MUST NOT blur permission prompts, clarifications, and human tasks.
- Liveness labels MUST be deterministic from the documented truth table and
  MUST NOT depend on undocumented heuristics.
- Empty states MUST be explicit: no hidden meaning between "nothing changed",
  "no active runs", and "no pending human input".
- The plan MAY reuse existing run-detail transcript and inbox UX as reference
  behavior, but MUST NOT promise a new internal UI unless a separate scope
  change is approved.

## Contract Surfaces

- HTTP route contract:
  `docs/api/external/operations.openapi.yaml`,
  `web/app/api/v1/ext/activity/route.ts`,
  `web/app/api/v1/ext/runs/[runId]/activity/route.ts`
- System-analytics contract:
  `docs/system-analytics/assistant-activity.md`,
  `docs/system-analytics/external-operations.md`,
  `docs/system-analytics/runs.md`,
  `docs/system-analytics/hitl.md`,
  `docs/system-analytics/README.md`
- Ext auth/audit boundary:
  `web/lib/tokens/ext-handler.ts`,
  `web/types/token-scopes.ts`
- Shared activity substrate:
  `web/lib/ext-activity/*`,
  `web/lib/run-transcript/*`,
  `web/lib/runs/run-transcript-projector.ts`,
  `web/lib/services/runs.ts`
- Existing read models that may be reused but not repurposed carelessly:
  `web/lib/queries/hitl.ts`,
  `web/lib/queries/run.ts`,
  `web/lib/queries/portfolio.ts`,
  `web/lib/queries/activity.ts`
- MCP facade:
  `mcp/src/tools.ts`,
  `mcp/src/__tests__/tool-contract.test.ts`,
  `mcp/src/__tests__/tools.test.ts`,
  `mcp/package.json`
- Config/deployment docs:
  `web/lib/instance-config.ts`,
  `.env.example`,
  `compose.yml`,
  `compose.production.yml`,
  `docs/configuration.md`
- DB docs only if the fallback migration path is activated:
  `web/lib/db/schema.ts`,
  `web/lib/db/migrations/*`,
  `web/lib/db/migrations/meta/_journal.json`,
  `docs/database-schema.md`,
  `docs/db/erd.md`,
  `docs/system-analytics/domain-events.md`

## Database Strategy

Primary path:
- Use the current persisted boundaries only.
- Prove that event ids, transcript mutation horizons, and run/HITL state are
  sufficient for stable assistant activity semantics.

Fallback path if the proof fails:
- Add one additive migration only after the spec freeze records the exact gap.
- Update the canonical schema/docs and migration metadata in the same slice.
- Re-run migration integrity checks, including journal/snapshot consistency.
- Do not ship a partial semantic contract that silently drops required replay or
  mutation guarantees.

Questions the DB proof MUST answer explicitly:
- Can `domain_events.id` alone back the pulse `happened` cursor contract?
- Is `run_messages.supervisor_event_id` sufficient to resurface edited or
  coalesced semantic items on repeated per-run polling?
- Can standalone agent/scratch runs preserve the same replay semantics without
  inventing new persisted identifiers?
- Are current run/HITL timestamps sufficient for liveness and needs-you truth
  tables without new columns?

## Test Strategy

Testing is part of implementation design, not a final cleanup step. The suite
should maximize semantic coverage while minimizing overlap.

Unit/low-level responsibilities:
- Cursor parsing/serialization invariants and invalid-input behavior.
- Salience mapping/filtering rules.
- Liveness truth table decisions.
- Domain-event to assistant-item classification.
- Transcript semantic-item shaping where pure fixtures are sufficient.

Integration responsibilities:
- Actual ext route response JSON, auth, project isolation, and error behavior.
- Cursor replay and mutation resurfacing across repeated polling.
- Scratch/agent/flow run coverage at the route or projector boundary.
- HITL/clarification inclusion in `needs-you`.
- DB-backed or projector-backed seams where persistence identity matters.

MCP responsibilities:
- Tool schema parity with OpenAPI.
- Query mapping/coercion behavior.
- Error forwarding only where the facade actually transforms behavior.

Test design rules:
- Every required behavior and edge case MUST be covered at the cheapest layer
  that still proves the contract.
- Avoid duplicate tests that assert the same rule through unit, integration,
  and MCP layers unless a boundary transformation exists.
- Avoid trivial tests that only restate TypeScript typing or happy-path
  serialization with no branching logic.
- Prefer fixtures that model real transcript/domain-event shapes already used by
  the repo over synthetic toy payloads.

## Completeness Gates

The implementation is not ready to start until the plan answers all of these:
- Which artifact is the canonical assistant-activity analyst doc.
- Which exact DTO fields are wire-visible and which are internal-only.
- Which semantics are synthesized vs persisted.
- Whether the no-migration proof passed, or which additive migration is needed.
- Which route/MCP inputs are accepted, rejected, or defaulted.
- Which edge cases are expected to return empty results vs 4xx/404.
- Which verification commands are mandatory before the feature is considered
  done.

The feature is not done until all of these hold:
- Specs, code, MCP, and docs all describe the same contract.
- Acceptance criteria below are satisfied without known holes.
- Focused tests are fully green.
- Typecheck/build/doc validation lanes are green for touched surfaces.
- No open logical hole remains around replay stability, project isolation, or
  liveness ambiguity.

## Acceptance Criteria

- `GET /api/v1/ext/activity` returns a project-scoped pulse with separate
  `happened`, `now`, and `needsYou` semantics documented and exercised.
- `GET /api/v1/ext/runs/{runId}/activity` returns semantic, assistant-safe run
  items with stable cursor semantics and mutation resurfacing.
- Both routes reject cross-project access and honor the final scope contract.
- The pulse and per-run feed share DTO types and salience behavior through one
  server-side substrate.
- `docs/system-analytics/assistant-activity.md` exists as the canonical domain
  artifact with the required sections, testable expectations, and explicit
  implementation-status tags.
- No raw ACP frames, protocol method names, or transport-specific payload blobs
  leak into the external contract.
- The final implementation either uses the existing schema honestly or ships the
  explicitly documented additive migration plus matching DB docs.
- MCP tools stay in exact request/response contract parity with the ext routes.
- Liveness and needs-you behavior are documented, deterministic, and covered by
  tests.

## Deployment Wiring

- If liveness thresholds remain configurable after the spec freeze, add the
  exact env vars to `.env.example`, `compose.yml`, and `docs/configuration.md`
  in the same slice as the runtime read.
- Update `compose.production.yml` only if production needs non-default values
  or explicit pass-through documentation.
- Boot-time/config logs may expose only active threshold values and never
  secrets or token material.

## Trust Boundary Notes

- `GET /api/v1/ext/activity`
  - `auth-context`: project binding via ext token.
  - `query-controlled`: cursor/since horizon, salience, and any final filter
    inputs frozen in Phase 0.
  - `server-state`: `domain_events`, active runs, pending HITL/clarification
    rows, transcript projections.
  - No client-supplied project slug, filesystem path, or cross-project id.
- `GET /api/v1/ext/runs/{runId}/activity`
  - `url-param`: `runId`.
  - `query-controlled`: per-run cursor, `limit`, `salience`.
  - `server-state`: run ownership, current node/attempt, transcript rows,
    pending HITL/clarification.
  - The route MUST derive the run's project from server state and 404 on
    cross-project mismatch.
- MCP tools
  - Must forward only documented route/query arguments.
  - Must not invent project identifiers, filesystem locators, or hidden
    default behaviors not present in the ext contract.

## Commit Plan

- **Commit 1** (after Phase 0): `feat: freeze assistant activity contracts`
- **Commit 2** (after Phases 1-3): `feat: add assistant activity substrate`
- **Commit 3** (after Phases 4-5): `feat: add assistant activity routes and mcp facade`

## Tasks

### Phase 0 - SDD Freeze and Feasibility Proof

- [ ] Task 1: Freeze the external and analyst contracts before code. Create
  `docs/system-analytics/assistant-activity.md`; define the two routes, query
  params, DTOs, salience contract, liveness truth table, cursor examples,
  auth/project binding, empty-state semantics, and "no raw ACP frames"
  boundary; update the relevant glossary/linking docs.
  Files:
  `docs/api/external/operations.openapi.yaml`,
  `docs/system-analytics/assistant-activity.md`,
  `docs/system-analytics/external-operations.md`,
  `docs/system-analytics/runs.md`,
  `docs/system-analytics/hitl.md`,
  `docs/system-analytics/README.md`
  Logging:
  no new runtime logging in this task; document required audit/redaction
  expectations instead.
  Acceptance:
  the spec resolves every open contract choice listed above and
  `CI=true pnpm validate:docs:all` passes.

- [ ] Task 2: Prove or disprove the no-migration path before production code.
  Write failing tests around domain-event replay, per-run mutation resurfacing,
  standalone agent/scratch behavior, and liveness/needs-you derivation using
  the existing schema and projector seams only.
  Files:
  `web/lib/ext-activity/__tests__/domain-events.test.ts`,
  `web/lib/ext-activity/__tests__/run-activity.test.ts`,
  `web/lib/runs/__tests__/run-transcript-projector.integration.test.ts`
  Logging:
  structured `WARN` only for uninterpretable cursor/transcript shapes with ids
  and source kind; never raw frames or transcript bodies.
  Acceptance:
  an explicit yes/no decision is recorded for "no migration needed"; if "no",
  the plan is amended with the exact additive migration slice before Phase 1.

### Phase 1 - TDD Slice A: Shared Contract Substrate

- [ ] Task 3 (RED): Add failing tests for shared DTO typing rules, cursor
  parsing/serialization, invalid cursor handling, salience filtering, and
  liveness truth-table decisions.
  Files:
  `web/lib/ext-activity/__tests__/cursor.test.ts`,
  `web/lib/ext-activity/__tests__/salience.test.ts`,
  `web/lib/ext-activity/__tests__/liveness.test.ts`
  Acceptance:
  tests fail for the missing or incomplete implementation only, without
  depending on route/MCP layers.

- [ ] Task 4 (GREEN -> REFACTOR): Implement the shared DTO, cursor, salience,
  and liveness helpers so the Phase 1 RED tests pass with minimal logic first,
  then refactor for readability and reuse without changing behavior.
  Files:
  `web/lib/ext-activity/types.ts`,
  `web/lib/ext-activity/cursor.ts`,
  `web/lib/ext-activity/salience.ts`,
  `web/lib/ext-activity/liveness.ts`
  Logging:
  `DEBUG` parsed cursor horizons and filtered counts; `WARN` invalid cursor
  parses before returning the final route error mapping.
  Acceptance:
  all Phase 1 tests are green and the helpers remain route-agnostic.

### Phase 2 - TDD Slice B: Semantic Replay and Projection

- [ ] Task 5 (RED): Add failing tests for `domain_events` mapping,
  monotonic pulse replay, per-run semantic-item projection, mutation
  resurfacing, and fallback handling for shapes that cannot map cleanly.
  Files:
  `web/lib/ext-activity/__tests__/domain-events.test.ts`,
  `web/lib/ext-activity/__tests__/run-activity.test.ts`,
  `web/lib/runs/__tests__/run-transcript-projector.integration.test.ts`
  Acceptance:
  failures isolate the semantic replay/projection gap and do not depend on
  route auth or MCP schema wiring.

- [ ] Task 6 (GREEN -> REFACTOR): Implement the shared `happened` mapper and
  per-run semantic feed projector on top of `domain_events`,
  `projectRunTranscript()`, `run_messages.supervisor_event_id`, and
  `getAgentRunTranscript()`; refactor only after the failing tests are green.
  Files:
  `web/lib/ext-activity/domain-events.ts`,
  `web/lib/ext-activity/run-feed.ts`,
  `web/lib/ext-activity/semantic-transcript.ts`,
  `web/lib/runs/run-transcript-projector.ts`,
  `web/lib/services/runs.ts`
  Logging:
  `DEBUG` batch stats `{projectId, since, returned, maxEventId}` and
  `{runId, nodeAttemptId, itemCount, mutationHorizon}`; `WARN` fallback-to-
  generic-item decisions without raw payload dumps.
  Acceptance:
  pulse replay and per-run mutation replay both satisfy the frozen contract for
  flow, scratch, and standalone agent runs.

### Phase 3 - TDD Slice C: Pulse Snapshot and Needs-You Composition

- [ ] Task 7 (RED): Add failing tests for active-run selection, `needs-you`
  composition, empty-state distinctions, and deterministic liveness labeling.
  Files:
  `web/lib/ext-activity/__tests__/pulse.test.ts`,
  `web/lib/ext-activity/__tests__/needs-you.test.ts`,
  `web/lib/ext-activity/__tests__/run-activity.test.ts`
  Acceptance:
  failures prove the missing aggregation semantics without needing route-level
  HTTP assertions yet.

- [ ] Task 8 (GREEN -> REFACTOR): Implement the shared pulse builders for
  `now`, `needsYou`, last-meaningful-action summaries, and any final liveness
  threshold config reads; refactor only after the RED tests are green.
  Files:
  `web/lib/ext-activity/pulse.ts`,
  `web/lib/ext-activity/needs-you.ts`,
  `web/lib/queries/hitl.ts` or `web/lib/queries/portfolio.ts` (reuse only when
  it reduces duplication without redefining their domain contract),
  `web/lib/instance-config.ts`
  Logging:
  structured `DEBUG`/`INFO` counts and liveness ages only; no full HITL bodies,
  no token data.
  Acceptance:
  empty states, liveness labels, and needs-you composition match the SDD freeze
  exactly.

### Phase 4 - TDD Slice D: Ext Routes, Auth, and Deployment Wiring

- [ ] Task 9 (RED): Add failing integration tests for route auth, project
  isolation, actual response JSON shape, salience filtering, cursor replay,
  empty states, scratch/agent/flow coverage, and invalid query handling.
  Files:
  `web/app/api/v1/ext/activity/__tests__/route.integration.test.ts`,
  `web/app/api/v1/ext/runs/[runId]/activity/__tests__/route.integration.test.ts`
  Acceptance:
  the failing assertions are against actual `Response` JSON and HTTP status,
  not helper internals.

- [ ] Task 10 (GREEN -> REFACTOR): Implement the ext routes and any final env
  wiring needed for liveness thresholds, then refactor for clarity while
  preserving the tested wire contract.
  Files:
  `web/app/api/v1/ext/activity/route.ts`,
  `web/app/api/v1/ext/runs/[runId]/activity/route.ts`,
  `.env.example`,
  `compose.yml`,
  `compose.production.yml`,
  `docs/configuration.md`
  Logging:
  reuse `handleExt()` audit and add structured route logs with ids, cursor,
  salience, returned counts, and status only; never tokens or full payload
  bodies.
  Acceptance:
  route tests prove `runs:read` handling, 404 cross-project protection,
  deterministic empty states, and repeat-call cursor behavior.

### Phase 5 - TDD Slice E: MCP Facade, As-Built Sync, and Final Verification

- [ ] Task 11 (RED): Add failing MCP tests for tool schema parity, request
  mapping, numeric coercion boundaries, and error forwarding only where the
  facade transforms behavior.
  Files:
  `mcp/src/__tests__/tools.test.ts`,
  `mcp/src/__tests__/tool-contract.test.ts`
  Acceptance:
  failures prove contract drift against the frozen OpenAPI schema.

- [ ] Task 12 (GREEN -> REFACTOR): Implement the MCP tools, finish as-built doc
  sync, and run the focused verification lane across docs, web, DB artifacts if
  touched, and MCP. If the fallback migration path was activated, include its
  schema/doc/integrity updates here as part of done.
  Files:
  `mcp/src/tools.ts`,
  `mcp/package.json` (only if scripts/fixtures need alignment),
  `docs/api/external/operations.openapi.yaml`,
  `docs/system-analytics/assistant-activity.md`,
  `docs/system-analytics/external-operations.md`,
  `docs/system-analytics/runs.md`,
  `docs/system-analytics/hitl.md`,
  `docs/system-analytics/README.md`,
  `docs/error-taxonomy.md` (only if route-level error narratives change),
  `docs/database-schema.md`,
  `docs/db/erd.md`,
  `docs/system-analytics/domain-events.md`,
  `web/lib/db/schema.ts`,
  `web/lib/db/migrations/*`,
  `web/lib/db/migrations/meta/_journal.json`
  Logging:
  no new production logging beyond what prior tasks required; verification
  output belongs in implementation notes, not runtime code.
  Acceptance:
  `CI=true pnpm validate:docs:all`
  `pnpm --filter maister-web typecheck`
  `pnpm --filter maister-web exec vitest run --project unit web/lib/ext-activity/__tests__/cursor.test.ts web/lib/ext-activity/__tests__/salience.test.ts web/lib/ext-activity/__tests__/liveness.test.ts web/lib/ext-activity/__tests__/domain-events.test.ts web/lib/ext-activity/__tests__/run-activity.test.ts web/lib/ext-activity/__tests__/pulse.test.ts web/lib/ext-activity/__tests__/needs-you.test.ts`
  `pnpm --filter maister-web exec vitest run --project integration 'web/app/api/v1/ext/activity/__tests__/route.integration.test.ts' 'web/app/api/v1/ext/runs/[runId]/activity/__tests__/route.integration.test.ts' web/lib/runs/__tests__/run-transcript-projector.integration.test.ts`
  `pnpm --filter @maister/mcp typecheck`
  `pnpm --filter @maister/mcp exec vitest run --project unit mcp/src/__tests__/tools.test.ts mcp/src/__tests__/tool-contract.test.ts`
  `pnpm --filter @maister/mcp build`
  if a migration landed, the corresponding migration integrity/doc checks also
  pass before the feature is called done.

## Open Questions

- Should pulse `now` be a full snapshot on every call, or only rereturn runs
  whose mutation horizon advanced past the cursor? Phase 0 must lock one answer
  and show it in OpenAPI examples.
- For standalone agent/scratch runs with no flow-node ledger, should
  `currentNode` be `null` or a documented synthetic session label? The contract
  must choose one explicit answer and keep it stable.
- If the DB proof finds a real insufficiency, what is the smallest additive
  persisted identity or timestamp that satisfies replay semantics without
  broadening the storage model? This must be documented before any migration is
  written.
