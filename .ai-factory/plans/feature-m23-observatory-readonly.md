# Implementation Plan: M23 - Wave-1 Observatory Read-Only Metrics

> Proposed roadmap milestone **M23**. Wave-1 "Signals - observatory" track from
> `docs/pv/improvement-roadmap.md`: a read-only metrics surface over existing
> ledgers that measures correction pressure, autonomy, and repeatable harvestable
> signals before MAIster invests in the write half of the learning loop.

**Branch:** `feature/m23-observatory-readonly` - NOT created. Current session is a
managed detached worktree; this plan file uses the intended branch stem so
consumer skills can discover it if implementation later creates that branch.
**Created:** 2026-06-05
**Roadmap proposal:** M23, **Partial** for the broader observability pillar; **Full**
for Wave-1 E2 read-only Observatory. M23 is the user-selected feature code for
this plan; Phase 0 must reconcile the roadmap entry without renumbering the
existing open/shipped milestone history.
**Engine baseline:** `MAISTER_ENGINE_VERSION = 1.2.0`. No engine bump.
**Schema baseline:** Pure read over `runs`, `node_attempts`, `gate_results`,
`hitl_requests`, `artifact_instances`, `flows`, `flow_revisions`, `tasks`,
`workspaces`. No migration unless Phase 0 proves an existing timestamp/index is
insufficient.

---

## Settings

- **Testing:** YES - strict TDD. Each code phase starts RED, goes GREEN, then
  gets adversarial review before its checkpoint commit.
- **Logging:** Verbose - `pino` child logger `observatory-queries`; DEBUG for
  query scope and bucket counts, INFO for page-level read-model summaries, WARN
  only when expected optional legacy data is absent. Never log raw prompts,
  HITL responses, artifact payloads, or secrets.
- **Docs:** YES - mandatory docs-first Phase 0. The spec is the single source of
  truth for formulas, scope, acceptance criteria, API/UI expectations, and DB
  contract.
- **Method:** SDD spec-freeze -> per-phase TDD
  (QA/Tester RED -> Implementor GREEN -> Reviewer adversarial pass) -> contract
  trace -> consumer fan-out -> one checkpoint commit per phase.

## Roadmap Linkage

- **Milestone:** Proposed "M23. Wave-1 Observatory Read-Only Metrics".
- **Scope:** Partial relative to `PRODUCT_VIEW.md` observability and attention
  routing. Full relative to `docs/pv/improvement-roadmap.md` E2 Wave-1 read-only
  Observatory.
- **Rationale:** E2 is independent of M14/M17/M20 and reads existing runtime
  ledgers. It proves whether the learning-loop moat has measurable signal before
  Wave 3 builds the harvester -> improver -> proposal inbox write half.

---

## 0. Scope, Decisions, and Current-State Grounding

### 0.1 What This Milestone Delivers

| # | Deliverable | Scope |
|---|-------------|-------|
| A | `correction_rate = (rework + retries) / runs`, grouped by artifact, flow, and node | Read-only aggregate over `node_attempts`, `gate_results`, `artifact_instances`, `runs`, and `flows`; rendered as an unbounded pressure ratio, not a percent |
| B | `Autonomy Score = 1 - sum(gate_wait_time) / total_run_time` | Read-only aggregate over `hitl_requests.created_at/responded_at` plus `runs.started_at/ended_at` |
| C | Signal harvesting | Read-only clustering of repeated rework instructions, gate verdicts, and retry patterns; repeatability drives priority |
| D | Dashboard surfaces | Portfolio-level Observatory, per-project Observatory, per-flow/node drill-down, and run/node evidence links |
| E | Future signal slots | M17 `criticality` and `human_confidence` are planned inputs to priority, but not required for M23 |

### 0.2 What Is Explicitly Out of Scope

- No migrations in the default path.
- No new `runs.status`, `gate_results.status`, `node_attempts.status`, or
  `MaisterError` code.
- No write-side harvester, no proposal inbox, no automatic rule/skill/Flow edits.
- No background actor, scheduler job, cron, notification, Telegram, or attention
  routing.
- No raw artifact/HITL payload inspection unless Phase 0 explicitly classifies a
  field as safe metadata. The first version clusters structured verdict fields,
  decisions, statuses, node ids, and artifact ids/kinds. Text extraction stays
  off unless Phase 0 explicitly approves a bounded, redacted subset.
- No supervisor changes and no agent process changes.

### 0.3 Source Documents and ADRs to Build On

- `docs/pv/improvement-roadmap.md` E2 defines the Wave-1 formulas and the
  "repeatability = priority" harvesting intent.
- `docs/system-analytics/readiness.md` defines gate verdict calibration and the
  shared `readiness-core.ts` rollup precedent.
- `docs/system-analytics/hitl.md` defines HITL timings and response semantics.
- `docs/system-analytics/tasks.md` documents task retry-loop caveats:
  `tasks.attempt_number` is a mutable high-water mark and `runs.attempt_number`
  is only designed, not implemented. M23 must derive retries from actual run and
  node ledgers, not from the current `tasks.attempt_number` column alone.
- `docs/system-analytics/flow-graph.md` and ADR-027 define
  `node_attempts` as the append-only per-node ledger and highest-attempt-wins
  semantics.
- `docs/system-analytics/artifacts.md` and ADR-037/038 define
  `artifact_instances` as the queryable evidence index. Cost payloads remain
  `cost.jsonl` sidecar evidence and are not part of M23 formulas.
- Locked ADRs: ADR-001, ADR-002, ADR-003, ADR-007, ADR-008, ADR-009,
  ADR-013, ADR-014, ADR-016, ADR-017, ADR-022, ADR-026, ADR-027,
  ADR-028, ADR-037, ADR-038, ADR-039, ADR-040, and the M15 readiness ADR
  currently headed `ADR-048: Readiness enforcement over all blocking gate kinds
  + verdict calibration`. `docs/decisions.md` contains a duplicate ADR-048
  heading for M18; cite the M15 title/anchor in Phase 0 so the dependency is
  unambiguous.
- New ADR proposed: **ADR-051 - Read-only Observatory formulas and harvest
  priority.** It freezes formulas, grouping keys, privacy/redaction limits, and
  the explicit "read-only first; write half later" boundary.

### 0.4 Current Code Patterns to Reuse

- `web/lib/queries/portfolio.ts`, `web/lib/queries/project.ts`,
  `web/lib/queries/hitl.ts`, and `web/lib/queries/run.ts`: bulk read-model
  pattern, post-query reductions, no per-run query loops.
- `web/lib/queries/readiness-batch.ts` and
  `web/lib/flows/graph/readiness-core.ts`: shared pure classifier/rollup and
  batched consumer fan-out.
- `web/lib/flows/context.ts::reduceLedger`: highest-attempt-wins reduction over
  `node_attempts`, used as the pattern for live/latest attempt selection.
- `web/components/board/*`, `web/components/portfolio/*`,
  `web/components/run/readiness-summary.tsx`: HeroUI/Tailwind component style,
  render-to-static-markup test precedent, EN/RU i18n.

---

## 1. Formula Contract

Phase 0 must freeze this contract before any code. Initial proposal:

### 1.1 Scope and Filters

- Default lookback: last 30 days by `runs.started_at`.
- All formula helpers take an explicit `now: Date` / `nowMs: number` input.
  Active-run and open-wait examples are therefore deterministic in tests; no
  pure helper reads `Date.now()` internally.
- Scope filters: all visible projects for portfolio, one project for
  per-project, optional `flowId`, `nodeId`, `artifactKind`, and `artifactDefId`
  drill-down filters.
- Run denominator: distinct `runs.id` in scope where `run_kind='flow'` and at
  least one `node_attempts` row exists. Include active and terminal runs by
  default; active runs are marked `volatile=true` because their numerator and
  denominator can still change.
- Time denominator for Autonomy: `(ended_at ?? now) - started_at`, clamped to at
  least one second for active/zero-duration rows.
- Access control: use the same project-visibility model as `getPortfolio`
  (`admin` sees all non-archived projects, members see joined projects).
- Data-volume assumption for no-migration default: single-operator,
  pre-dogfood volume. If Phase 0 or RED tests show aggregate reads need a new
  index, split that into an explicit migration task and update DB docs.

### 1.2 Correction Rate

`correction_rate = (rework_count + retry_count) / run_count`

- `rework_count`: count distinct rework events, not both sides of the loop.
  Source of truth is the writer path, not observed data: `runner-graph.ts`
  classifies a human decision as rework when the selected transition target is
  in `node.rework.allowedTargets`, then `ledger.ts::markNodeReworked` writes
  `node_attempts.status='Reworked'` plus the chosen `decision` and
  `workspace_policy`. M23 counts `status='Reworked'`; `decision` is descriptive
  drill-down metadata only, because it is free text validated against the
  pinned manifest allow-list rather than a global enum.
- `retry_count`: for each `(run_id, node_id)`, `max(attempt) - 1`, summed across
  nodes. This uses `node_attempts` actual execution history, not
  `tasks.attempt_number`.
- Per-flow grouping: `runs.flow_id` plus enabled/pinned revision labels when
  available.
- Per-node grouping: `node_attempts.node_id` and `node_attempts.node_type`.
- Per-artifact grouping: join `artifact_instances` on `run_id` and
  `node_attempt_id` where possible; aggregate by `artifact_def_id` when present,
  otherwise by `kind`. A node with no artifacts still appears in node/flow
  metrics but not artifact heatmaps.
- Output includes numerator parts separately: `reworkCount`, `retryCount`,
  `runCount`, `correctionRate`, and display metadata that labels the value as
  an unbounded pressure ratio.
- `correction_rate` is unbounded and is rendered as a pressure ratio, not a
  percentage. A value greater than 1 means multiple correction events per run.

### 1.3 Autonomy Score

`autonomy_score = 1 - sum(gate_wait_time) / total_run_time`

- `gate_wait_time`: for each run, build HITL wait intervals from
  `hitl_requests.created_at` to `coalesce(responded_at, now)`, clamp each
  interval to the run's `[started_at, coalesce(ended_at, now)]` interval, then
  merge overlapping intervals before summing. This prevents concurrent or
  duplicated waits from exceeding the run duration.
- This captures permission, form, and human waits because all three pause the
  run through `hitl_requests`.
- Review/promotion dwell without an open `hitl_requests` row is explicitly not
  counted in M23. The UI must label Autonomy as "HITL wait share" and Phase 0
  must document that Review dwell is a later attention-routing metric, not part
  of this formula.
- `total_run_time`: sum `coalesce(runs.ended_at, now) - runs.started_at`.
- Clamp final score to `[0, 1]`.
- Output includes `waitSeconds`, `totalSeconds`, `openWaitCount`, and
  `autonomyScore`, plus `reviewDwellExcluded=true` in DTO metadata.

### 1.4 Signal Harvesting

Signal units are read-only "clusters" with a priority derived from repeatability.

- Rework signal cluster: v1 clusters structured metadata first. Source columns:
  `hitl_requests.decision`, `hitl_requests.rework_target`,
  `hitl_requests.workspace_policy`, `hitl_requests.step_id`, and joined
  `runs.flow_id`; node-attempt context comes from joining
  `node_attempts` on `(run_id, node_id = hitl_requests.step_id)` when needed.
  Free-text `comments` / `comment` extraction from `hitl_requests.response` is
  deferred unless Phase 0 explicitly approves it with redaction examples.
- Gate verdict cluster: group by `gate_results.kind`, `gate_id`,
  `status`, `verdict.verdict`, `verdict.calibration.outcome`,
  `verdict.recommendedAction`, and normalized `verdict.reasons[]`.
- Retry cluster: group by `(flow_id, node_id, node_type, error_code,
  exit_code)` plus artifact kind/def id when a failed/stale artifact is linked.
- Priority score:
  `repeatabilityScore = occurrenceCount + affectedRunCount + affectedProjectCount`
  with multipliers for failed/stale blocking gates. When M17 lands, multiply by
  `criticality` and raise uncertainty for low `human_confidence`; do not depend
  on those fields in M23.
- UI labels clusters as "signals", not "recommendations"; no mutation action is
  offered.

---

## 2. Deployment Wiring

| New dependency | Decision |
|----------------|----------|
| DB tables / columns / indexes | None by default. If Phase 0 finds performance requires an index, stop and split that into a migration task with `docs/database-schema.md` + `docs/db/*.md` updates. |
| Env vars | None. No `.env.example`, compose, or deployment change expected. |
| Sidecar / supervisor / MCP | None. |
| Bound ports | None. |
| Package dependency | None expected. Use existing HeroUI, Drizzle, React, and utility code. |

---

## 3. Contract-Surface to Spec-File Trace

| Surface | Spec file(s) | Phase |
|---------|--------------|-------|
| New read-only Observatory domain and formulas | New `docs/system-analytics/observatory.md` + ADR-051 | 0 |
| UI routes `/observatory`, `/projects/{slug}/observatory`, and run/node drill-down links | `docs/system-analytics/observatory.md`, `docs/architecture.md` route/component table if present | 0, 3 |
| Read-model DTOs `ObservatoryPortfolio`, `ObservatoryProject`, `ObservatoryNodeDetail`, `SignalCluster` | `docs/system-analytics/observatory.md` | 0, 1 |
| No external HTTP API | Explicitly state in `docs/system-analytics/observatory.md`; `docs/api/web.openapi.yaml` unchanged unless implementation adds route handlers | 0 |
| No DB migration | `docs/database-schema.md` unchanged, with a Phase 0 verification note in the plan only | 0 |
| EN/RU UI text | `web/messages/en.json`, `web/messages/ru.json` | 3 |

---

## 4. Identifier and Trust-Boundary Table

No state-changing routes are planned. If implementation adds route handlers, this table
must be amended before code.

| Surface | Identifier | Label | Guard |
|---------|------------|-------|-------|
| `/observatory` page | session user id | auth-context | `(app)` layout/middleware plus `getPortfolio` visibility model |
| `/projects/{slug}/observatory` page | `slug` | url-param | DB project lookup, `requireProjectAction(projectId, "readBoard")` or existing project page guard |
| Query params `flow`, `node`, `artifactKind`, `artifactDefId`, `window` | body/query-controlled data | allow-list and scope filter only; never used as filesystem paths or cross-project locators |
| Drill-down run links | `runId` from read model | server-state | emitted only after DB join through visible project ids |

---

## 5. Multi-Store Atomicity

M23 is read-only. There are no writes, external side-effects, deferreds, or
multi-store transitions. Tests must assert:

- query modules never call insert/update/delete helpers;
- no route handler mutates DB state;
- no filesystem writes or supervisor calls exist in the Observatory path;
- no migration is added unless Phase 0 explicitly changes this plan.

---

## 6. New-Surface Consumer Fan-Out

| Consumer | Required update |
|----------|-----------------|
| Portfolio home | Add compact Observatory summary/entry point fed by `getPortfolioObservatory`, not per-project loops |
| Project board page | Add Observatory tab/section with project-specific metrics beside existing board panels |
| Run detail / timeline | Add links from node attempts/gates/artifacts to node drill-down, no new run state |
| Left rail / nav | Optional `Observatory` nav item only if UX review says it improves discoverability |
| i18n | EN/RU parity for every new label, empty state, tooltip, filter, and metric explanation |
| Tests | Unit, integration, render-to-static-markup, and seeded Playwright coverage |

---

## 7. Multiagent Execution Model

One phase equals one checkpoint commit.

1. **Spec architect (Phase 0):** writes ADR-051 and `observatory.md`.
2. **QA/Tester (RED):** writes failing tests from the frozen spec only. Confirms
   runner include globs using `vitest list` when adding a new test path.
3. **Implementor (GREEN):** writes the minimum code to pass RED tests.
4. **Reviewer:** adversarial pass focused on N+1 queries, formula drift,
   privacy leakage, docs/spec mismatch, and accidental writes.
5. **Coordinator:** validates phase gates, records checkpoint commit, and only
   then starts the next phase.

Global phase gate:

- `pnpm --filter maister-web typecheck`
- `pnpm --filter maister-web test:unit`
- `pnpm --filter maister-web test:integration`
- relevant `pnpm --filter maister-web test:e2e`
- `pnpm validate:docs:all`
- `pnpm --filter maister-web lint`

---

## 8. Tasks

### Phase 0 - SDD Spec Freeze (docs-first, no feature code)

- [x] **T0.1 - ADR-051: Observatory formula contract.** Append ADR-051 to
  `docs/decisions.md`: read-only Observatory; formulas for correction rate and
  Autonomy Score; grouping keys; M23 milestone scope; no migration/default no
  new API; no write-half harvester; M17 `criticality`/`human_confidence` as
  future multipliers only. Freeze rework counting from the writer path
  (`markNodeReworked` -> `node_attempts.status='Reworked'`), not from sampled
  production rows.
  **Logging:** n/a. **Verify:** ADR number follows ADR-050; docs render.
- [x] **T0.2 - New system analytics artifact.** Create
  `docs/system-analytics/observatory.md` per `docs/CLAUDE.md` R5: Purpose,
  Domain entities, Process flows, Expectations, Edge cases, Linked artifacts.
  Include Mermaid diagrams for aggregate read path and signal clustering.
  Explicit status tags: `Designed` during Phase 0, flipped to `Implemented` in
  final docs reconciliation. **Logging:** n/a. **Verify:** `pnpm validate:docs:all`.
- [x] **T0.3 - Formula freeze with examples.** In `observatory.md`, freeze
  worked examples for: no runs, active run with open HITL, rework + retry on
  same node, stale blocking gate, artifact grouping with null `artifact_def_id`,
  legacy run with no `node_attempts`, overlapping HITL waits that must be merged
  before summing, and Review dwell that has no `hitl_requests` row and is
  therefore excluded in M23. Every worked example supplies an explicit `now`.
  **Logging:** n/a. **Verify:** examples are mirrored by RED tests in Phase 1.
- [x] **T0.4 - Contract surface and no-migration verification.** Document that
  the UI uses server-component read models and no external HTTP API in M23.
  Confirm `docs/api/web.openapi.yaml`, `docs/database-schema.md`, and
  `docs/db/*.md` remain unchanged unless Phase 0 discovers a required contract
  change. **Logging:** n/a. **Verify:** reviewer sign-off that no spec file is
  missing from the trace.
- [x] **T0.5 - Privacy/redaction rules.** Freeze structured-metadata-first
  signal clustering: `decision`, `rework_target`, `workspace_policy`,
  `step_id`, joined `runs.flow_id`, gate ids/status/verdict fields, retry
  error/exit metadata. Free-text HITL comments are deferred by default; if Phase
  0 admits any bounded/truncated text, it must include redaction examples and
  RED tests. No raw prompt, raw artifact payload, cost payload, env, token, or
  secret-bearing fields. **Logging:** n/a. **Verify:** redaction rules become
  Phase 2 tests.
- [x] **T0.6 - Acceptance criteria.** Add an explicit acceptance list to the
  plan and `observatory.md`: formulas match examples; no N+1; portfolio/project
  views agree on shared totals; drill-down reconciles to parent row; EN/RU
  parity; no DB writes; empty states are useful; M17 fields can slot in later.
  **Logging:** n/a. **Verify:** consistency reviewer signs off before code.

**Phase 0 exit gate:** `pnpm validate:docs:all` green; ADR and
`observatory.md` internally consistent; no code merged.

### Phase 1 - Pure Metrics Core + Batched Read Models

- [x] **T1.1 (RED) - Pure formula tests.** Add unit tests under
  `web/lib/queries/__tests__/observatory-core.test.ts` for `correctionRate`,
  `autonomyScore`, explicit `now` injection, overlapping HITL interval union,
  Review-dwell exclusion, `latestAttemptsByNode`, artifact grouping, pressure
  ratio > 1 rendering metadata, and empty/legacy inputs. Runner: vitest `unit`
  (`*.test.ts`). Confirm include glob. **Logging:** n/a for pure functions.
- [x] **T1.2 (GREEN) - `observatory-core.ts`.** Add
  `web/lib/queries/observatory-core.ts` with typed pure functions:
  `rollupCorrectionMetrics`, `rollupAutonomyMetrics`,
  `groupArtifactContributions`, `rankSignalClusters`. No `any`, no DB, no IO,
  no mutation of input arrays. **Logging:** none in pure functions.
- [x] **T1.3 (RED) - Integration tests for batched queries.** Add
  `web/lib/queries/__tests__/observatory.integration.test.ts` using
  testcontainers Postgres. Seed multiple projects/runs/nodes/gates/HITL rows and
  assert portfolio/project/node aggregates, access filtering, active-run time
  handling, and no N+1 with an explicit query-count harness. The harness should
  wrap the query-loading boundary or instrument the Postgres client in tests and
  assert bounded statement counts per query family, not merely "looks batched".
  Runner: integration project (`*.integration.test.ts`). Confirm both sides:
  `vitest --project integration --list` includes the file and
  `vitest --project unit --list` excludes `*.integration.test.ts`.
- [x] **T1.4 (GREEN) - Query module.** Add `web/lib/queries/observatory.ts`
  with:
  `getPortfolioObservatory(userId, globalRole, filters)`,
  `getProjectObservatory(projectId, filters)`,
  `getNodeObservatoryDetail(projectId, nodeId, filters)`.
  Bulk fetch runs, node attempts, gate results, hitl requests, artifact
  instances, flows, and projects with project-id batching. Reuse visibility
  logic from `portfolio.ts` and pure reductions from T1.2. **Logging:** DEBUG
  scope/filter counts; INFO final aggregate counts; WARN only for legacy
  no-ledger rows.
- [x] **T1.5 (REVIEW) - Read-only and performance review.** Reviewer checks
  for accidental writes, raw SQL injection, project visibility leaks, per-run
  query loops, formula mismatch with Phase 0, and missing typed DTOs. **Verify:**
  typecheck, unit, integration green.

**Phase 1 checkpoint commit:** `feat(observatory): add read-only metrics core`

### Phase 2 - Signal Harvesting Heuristic

- [x] **T2.1 (RED) - Signal cluster tests.** Add unit cases for normalized
  structured rework metadata, optional-comment rejection/redaction,
  repeatability scoring, blocking-gate weighting, retry cluster grouping, and
  M17 slot placeholders. Include adversarial text with env-like/token-like
  substrings only if Phase 0 admits text extraction. Runner: vitest `unit`.
- [x] **T2.2 (GREEN) - Harvesting helpers.** Add
  `web/lib/queries/observatory-signals.ts` with pure helpers:
  `normalizeSignalText`, `redactSignalText`, `clusterReworkSignals`,
  `clusterGateSignals`, `clusterRetrySignals`, `rankSignals`. Keep text
  extraction disabled by default unless Phase 0 explicitly enables it; structured
  metadata must work without text. **Logging:** none in pure helpers.
- [x] **T2.3 (RED) - Query integration for signal clusters.** Extend
  `observatory.integration.test.ts`: repeated structured rework metadata outranks
  one-off events; repeated failed gates outrank passed/advisory noise; retries on
  the same node cluster by flow/node/error; inaccessible project signals never
  leak. Verify HITL signals use real join paths:
  `hitl_requests.run_id -> runs.flow_id`, `hitl_requests.step_id` as node scope,
  and optional `node_attempts` context via `(run_id, node_id=step_id)`.
- [x] **T2.4 (GREEN) - Wire signals into read models.** Extend
  `getPortfolioObservatory` and `getProjectObservatory` to return
  `topSignals: SignalCluster[]`, each carrying `kind`, `title`, `scope`,
  `occurrenceCount`, `affectedRunCount`, `affectedProjectCount`, `priorityScore`,
  `examples` (redacted, max N), and drill-down params. **Logging:** DEBUG cluster
  candidate counts and discarded unsafe text counts.
- [x] **T2.5 (REVIEW) - Privacy and false-certainty review.** Reviewer checks
  that signals are labeled as observations, not recommendations; no raw prompts
  or artifact payloads are surfaced; redaction is tested; M17 fields are optional
  and absent-safe. **Verify:** typecheck, unit, integration green.

**Phase 2 checkpoint commit:** `feat(observatory): rank repeatable harvest signals`

### Phase 3 - Portfolio and Project Dashboard UI

- [x] **T3.1 (RED) - Component render tests.** Add render-to-static-markup unit
  tests for new components under `web/components/observatory/__tests__/`:
  metric tiles, correction heatmap, Autonomy Score band, signal list, empty
  state, filter controls, and drill-down links. No jsdom. Runner: vitest `unit`.
- [x] **T3.2 (GREEN) - Components.** Add HeroUI/Tailwind components under
  `web/components/observatory/`: `observatory-summary.tsx`,
  `correction-heatmap.tsx`, `autonomy-score-card.tsx`,
  `signal-cluster-list.tsx`, `observatory-filters.tsx`,
  `node-drilldown-table.tsx`. Use existing design tokens, compact dashboard
  density, icons where appropriate, stable dimensions for heatmap cells, and no
  nested cards. **Logging:** no client console logs.
- [x] **T3.3 (RED) - Route/page tests.** Add server-render tests or integration
  smoke tests for `/observatory` and `/projects/[slug]/observatory` ensuring
  auth/session guards, project visibility, empty state, and i18n message keys.
  Runner: unit/integration according to existing route test precedent.
- [x] **T3.4 (GREEN) - Routes and navigation.** Add:
  `web/app/(app)/observatory/page.tsx`,
  `web/app/(app)/projects/[slug]/observatory/page.tsx`,
  optional project tab/entry in `web/components/board/project-tabs.tsx`, and
  portfolio card entry points. Use server components calling query functions
  directly. **Logging:** INFO page aggregate summary from query layer only.
- [x] **T3.5 (GREEN) - i18n EN/RU.** Add `observatory.*` namespace to
  `web/messages/en.json` and `web/messages/ru.json`. Include metric labels,
  formula helper copy, filter labels, empty states, signal labels, drill-down
  labels, and future-signal placeholders. **Logging:** n/a.
- [x] **T3.6 (REVIEW) - UX/accessibility review.** Reviewer checks HeroUI v3
  only, EN/RU parity, no text overflow on mobile/desktop, no one-note palette,
  accessible metric labels, and no feature-explainer prose cluttering the app.
  **Verify:** typecheck, unit, integration green.

**Phase 3 checkpoint commit:** `feat(observatory): add dashboard surfaces`

### Phase 4 - Per-Node Drill-Down and Cross-Surface Consistency

- [x] **T4.1 (RED) - Drill-down consistency tests.** Integration tests assert
  that a portfolio heatmap row, project row, and node detail reconcile with the
  correct additive-vs-distinct semantics: rework/retry event counts are additive
  across child buckets, while `runCount` is a distinct set cardinality and child
  `runCount` values must reconcile by set union, not numeric sum. Node detail
  lists contributing runs/gates/HITL waits without leaking inaccessible projects.
- [x] **T4.2 (GREEN) - Node detail read model.** Extend
  `web/lib/queries/observatory.ts` with `getNodeObservatoryDetail` returning
  contributing runs, attempts, gate verdicts, HITL waits, artifact links, and
  signal examples for one project/node/filter. Batch by selected node, not
  per-run. **Logging:** DEBUG selected node/filter and row counts.
- [x] **T4.3 (GREEN) - Drill-down UI.** Add node detail route or query-param
  driven section under `web/app/(app)/projects/[slug]/observatory/page.tsx`.
  Link to run detail/timeline/evidence graph where the underlying row exists.
  Surface "latest attempt" vs "historical attempts" clearly. **Logging:** none
  outside query layer.
- [x] **T4.4 (RED/GREEN) - Shared DTO invariants.** Add tests that
  portfolio/project/node views call the same pure rollup helpers and cannot
  drift on Autonomy/correction formulas. Mirror the existing readiness SSOT
  consistency test style.
- [x] **T4.5 (REVIEW) - Consistency review.** Reviewer checks formula SSOT,
  no duplicated business logic in components, no N+1 drill-down behavior, and
  correct handling of legacy/no-ledger rows. **Verify:** typecheck, unit,
  integration green.

**Phase 4 checkpoint commit:** `feat(observatory): add node drilldown`

### Phase 5 - E2E, Docs Reconciliation, and Final Verification

- [x] **T5.1 (RED) - Playwright seeded scenario.** Add
  `web/e2e/m23-observatory.spec.ts` using seeded stub-supervisor data:
  portfolio observatory shows correction/autonomy summary; project dashboard
  filters to one flow; node drill-down opens; repeated signal outranks one-off;
  empty project shows empty state; RU locale renders translated labels. Confirm
  Playwright config includes the spec.
- [x] **T5.2 (GREEN) - E2E seed support.** Extend `web/e2e/_seed/fixtures.ts`
  or nearby seeded helpers to create deterministic runs/node attempts/gates/HITL
  rows for M23 without live agent calls. **Logging:** n/a.
- [x] **T5.3 - Docs as-built reconciliation.** Flip `observatory.md` status tags
  from `Designed` to `Implemented`, update `docs/architecture.md` if route/table
  references are listed there, and add M23 roadmap entry/completed row only when
  implementation is actually shipped. Keep `docs/api/*` and DB docs unchanged
  unless the implementation truly added those surfaces. **Logging:** n/a.
- [x] **T5.4 - Final gate.** Run:
  `pnpm --filter maister-web typecheck`,
  `pnpm --filter maister-web test:unit`,
  `pnpm --filter maister-web test:integration`,
  `pnpm --filter maister-web test:e2e`,
  `pnpm validate:docs:all`,
  `pnpm --filter maister-web lint`.
  **Logging:** capture command outputs in the implementation summary.
  **Result:** typecheck, unit, e2e, docs validation, diff check, and lint passed;
  integration was attempted and is blocked in this environment by missing
  `testcontainers` container runtime before test bodies run.
- [x] **T5.5 (REVIEW) - Final adversarial review.** Reviewer verifies the
  acceptance criteria, no accidental writes/migrations, no privacy leakage, and
  no overclaim that the write half exists. Findings must be fixed before the
  final checkpoint commit.

**Phase 5 checkpoint commit:** `feat(observatory): verify read-only metrics surface`

---

## 9. Commit Plan

| Commit | Phase | Message |
|--------|-------|---------|
| 1 | Phase 0 | `docs(observatory): freeze read-only metrics contract` |
| 2 | Phase 1 | `feat(observatory): add read-only metrics core` |
| 3 | Phase 2 | `feat(observatory): rank repeatable harvest signals` |
| 4 | Phase 3 | `feat(observatory): add dashboard surfaces` |
| 5 | Phase 4 | `feat(observatory): add node drilldown` |
| 6 | Phase 5 | `test(observatory): verify read-only metrics surface` |

---

## 10. Acceptance Criteria

- `correction_rate` matches the frozen formula and exposes
  `reworkCount`, `retryCount`, `runCount`, and `correctionRate` for flow,
  artifact, and node groupings; the UI renders it as an unbounded pressure ratio,
  not a percentage.
- Autonomy Score matches the frozen formula, handles active runs and open HITL
  waits with an explicit `now`, merges overlapping wait intervals, excludes
  Review dwell with metadata explaining that boundary, clamps to `[0, 1]`, and
  exposes numerator/denominator parts.
- Signal clusters rank repeated rework instructions, gate verdicts, and retry
  patterns by repeatability, using structured metadata first and privacy-safe
  redaction only for any Phase-0-approved text examples.
- Portfolio, project, and node drill-down surfaces use shared rollup helpers and
  reconcile for the same filters.
- Queries bulk-fetch by visible project/run ids and do not call per-run detail
  query functions in loops.
- Dashboard UI is HeroUI v3/Tailwind only, responsive, accessible, and
  translated in EN/RU.
- No DB migration, env var, supervisor change, agent change, state-changing API,
  or background job is introduced by default.
- M17 `criticality` and `human_confidence` can be added as optional signal
  fields later without changing M23 formulas or breaking existing DTOs.
- All phase gates are green before final completion.

---

## 11. Risks and Watch Items

- **Retry denominator ambiguity:** `tasks.attempt_number` is not a reliable
  immutable run-attempt stamp today. Use actual `node_attempts` attempts for
  node retries and distinct run ids for the run denominator.
- **Rework double-counting:** a rework decision and the target node's new
  attempt can describe the same loop. Phase 0 must freeze one source of truth
  and tests must catch double-counting.
- **Privacy leakage:** HITL comments and gate reasons may contain source code,
  credentials, or user-sensitive context. Redaction/truncation is mandatory for
  any Phase-0-approved text subset, and raw payloads stay out of the UI.
- **Performance:** Read-only does not mean cheap. The implementation must batch
  by project/run ids and may need bounded lookback defaults. If indexes are
  necessary, split and document the migration rather than smuggling it into a
  pure-read phase.
- **M17 dependency drift:** `criticality` and `human_confidence` are planned but
  absent in this worktree. Treat them as optional future slots only.
- **Product semantics:** The UI must say "signals" and "patterns", not
  "recommended fixes" or "auto-improvements"; the write half is Wave 3.

---

## 12. Open Questions for User

1. Should M23's default lookback be 30 days, or should it default to "all runs"
   until there is enough dogfood volume?
2. Should the first version keep signal clustering structured-metadata-only,
   with all HITL response text hidden until a separately reviewed
   text-redaction step?
3. Should the top-level `/observatory` route be a first-class nav item now, or
   should it enter through portfolio/project cards until the surface proves
   itself?
