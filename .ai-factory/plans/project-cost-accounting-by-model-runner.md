# Plan — Project cost accounting: reliable scratch reconcile + by-model + by-runner breakdown

**Branch:** `claude/nostalgic-darwin-1d5f73` (worktree, at `main` HEAD — 0 divergence)
**Created:** 2026-06-29
**Type:** enhancement (analytics / cost observability)
**Reserved namespace:** ADR-117 · migration `0083` (next-free at `main` HEAD: max ADR-116, max migration idx 82 / tag `0082_m42_drop_runs_runner_mirror`)

## Settings

- **Testing:** yes — TDD, strict RED → GREEN → refactor. Tests cover all required behavior + edge cases, minimum overlap, no trivial/tautological tests.
- **Logging:** verbose (DEBUG for reconcile/aggregation internals, INFO for trigger fires, WARN for skipped/unattributed buckets). Use the `pino` logger boundary already present in each module — never `console.log` (eslint `no-console`).
- **Docs:** yes — mandatory docs checkpoint. SDD: analytics/specs are **front-loaded in Phase 0** and complete+consistent before any code phase; later phases only flip implementation-status tags `Designed → Implemented`.
- **Roadmap linkage:** Milestone: "none". Rationale: cost-observability hardening, not a roadmap milestone; aligns with the ADR-085/ADR-101 Observatory cost dimension already in `docs/system-analytics/observatory.md`.

## Owner decisions (resolved 2026-06-29)

1. **Reconcile trigger for scratch / never-opened terminal runs** → **Terminal-consumer + backstop sweep**, with clearly split roles (refined in the improve pass):
   - The **sweep is the completeness guarantee.** It keys on `runs.ended_at` (set on *every* terminal transition, null for active runs) — NOT on a terminal-status allow-list and NOT on a domain event. This is required because **scratch success emits no terminal domain event** (only `run.failed`/`run.crashed`/TTL-`run.abandoned` are emitted; `run.done` is emitted only by `promote.ts`). An `ended_at`-keyed sweep therefore reliably catches finished scratch runs that fire no event at all, plus pre-existing history and late cost-flush races.
   - The **consumer is a low-latency fast-path**, not the primary, for the terminals that *do* emit (`run.done|failed|crashed|abandoned`): it makes the rollup appear seconds after terminal instead of waiting for the next sweep tick.
   - Read-time reconcile is **forbidden** by the Observatory read-only boundary (`observatory.md` §272), so neither trigger lives in the read path.
2. **By-runner breakdown** → **Precise, new `by_runner` jsonb column** on `run_cost_rollups`, populated at reconcile by joining cost records to `run_sessions` on `(run_id, session_name)`. Symmetric to the existing `by_model` column; correctly splits multi-session / CCR per-node-runner flow runs.

## Problem (verified in code)

- `getCostSummary` (`web/lib/queries/observatory.ts:253`) sums `run_cost_rollups` by `projectId` with **no `run_kind` filter** — so scratch runs are structurally included **iff a rollup row exists**.
- Rollup rows are written only by `reconcileRunCostRollups` (`web/lib/runs/cost-rollups.ts:254`), triggered **lazily**: run-detail open (`run.ts:680,737`), task-detail (`task-detail.ts:302`), and the budget watchdog (`keepalive-sweeper.ts:1940`, only runs with a *set* budget limit). Scratch runs have no task and usually no budget → their **only** trigger is opening the run. An unopened scratch run → no rollup row → invisible in Observatory.
- `reconcileProjectScopeCostRollups` (`cost-rollups.ts:412`) exists for exactly this but is **never called** — and, being a full-project disk re-scan, it is the *wrong* tool inside the read path (violates §272). It will be **removed** as dead code (see Phase 2 note) in favor of the event-driven path.
- **No project-level model breakdown:** `run_cost_rollups.by_model` (jsonb) is written per-run but `getCostSummary` ignores it. `node_attempt_cost_rollups.model` is per-node only. There is **no runner breakdown anywhere**.

## Architecture decisions (Phase-0 spec, locked here)

- **D1 — Runner attribution bridge.** Cost records carry `sessionName` (M42/ADR-114, `supervisor/src/cost.ts:18`). `run_sessions` carries `runnerId` + `runner_snapshot` keyed by `(run_id, session_name)` and is populated for **every** run kind (flow `services/runs.ts:1058`, scratch `916/1562`, agent `launch.ts:1126`, consensus `drafts.ts:216`). So each cost event maps to exactly one runner via `(runId, sessionName) → run_sessions`.
- **D2 — Runner identity key.** Group by a **stable derived label** computed from `run_sessions.runner_snapshot`: `runnerKey = "<adapter>/<model>"` (e.g. `claude/claude-sonnet-4-6`), with a display object `{ adapter, capabilityAgent, model, providerKind, runnerId? }`. Snapshot-derived (not the catalog FK) so a deleted `platform_acp_runners` row never erases historical attribution. `runnerId` is carried as a secondary field only. Cost events with no matching `run_sessions` row (legacy pre-M42 / missing `sessionName`) bucket under `runnerKey = "unknown"`.
- **D2a — Precision is conditional (clarified in improve pass).** The multi-runner split is *exact* only when a flow declares multiple logical sessions (per-node `sessionName`, `topology.ts:186` / `runner-graph.ts:2480` → distinct `run_sessions` rows with distinct snapshots). A single-session flow, and every scratch/agent run, maps all cost to one runner via `sessionName="default"` — which is correct, not a loss. There is no per-node runner split *below* the session granularity; the spec must state this so "by runner" is not over-promised. Guarded by a test (single-session flow with N nodes → exactly one runner bucket).
- **D3 — By-model key.** Existing `by_model` semantics unchanged: keyed by the cost record `model` string, `"unknown"` when absent (`cost-rollups.ts:141`).
- **D4 — Read-only boundary preserved.** `getCostSummary` / `getProjectObservatory` / `getPortfolioObservatory` stay pure reads over derived rollups — they MUST NOT call any `reconcile*` function or read `cost.jsonl`. Reconciliation happens only on the terminal-event and sweep write paths. This is an explicit acceptance criterion with a guard test.
- **D5 — Idempotency.** Dispatch is at-least-once (ADR-086) and the sweep re-reconciles; `reconcileRunCostRollups` is already idempotent (delete-then-insert nodes, `onConflictDoUpdate` run row, `sourceCursor`). Re-reconcile after a runner/session change MUST refresh `by_runner` (no stale buckets) — covered by test.
- **D6 — Web-tier disk access.** `reconcileRunCostRollups` reads `cost.jsonl` from `configuredRuntimeRoot()` in the **web tier** (the existing run/task/budget call sites already do this). The new consumer + sweep run web-side and inherit the same assumption; no change to the web↔supervisor split. (If supervisor is remote-hosted, the same pre-existing limitation applies as for run-detail reconcile today — documented, not regressed.)
- **D7 — Consumer must be poison-safe (improve pass).** The dispatcher `break`s **without advancing the cursor** when a consumer's `handle` throws (`dispatch.ts:203`) — a single permanently-failing run would stall the entire `cost-rollup-reconcile` cursor and block all later events forever (poison message). Therefore `handle` MUST catch every per-run reconcile error (log WARN, skip the run) and **never throw**. A transient disk error is retried by the next sweep; a permanent one (`CONFIG` no-slug) is simply skipped. `handle(events[])` is a **batch** — filter to terminal kinds, dedupe runIds, reconcile each. `startFrom: "now"` (forward-only) — NOT `"beginning"`: a full historical replay is wasteful and the sweep owns backfill.
- **D8 — Sweep keys on `ended_at` + a settle grace (improve pass).** Candidate predicate: `runs.ended_at IS NOT NULL AND runs.ended_at > now − lookback AND (rollup row missing OR rollup.updated_at < runs.ended_at + SETTLE_GRACE)`. `ended_at` (not a status allow-list) makes it catch every finished run regardless of which terminal status or whether an event fired. The `+ SETTLE_GRACE` (e.g. 2 min) term forces one extra re-reconcile of a just-ended run so the supervisor's async final `cost.jsonl` flush (`cost.ts:118` `stream.end`) is captured; a long-settled fresh rollup is then skipped (no disk thrash).

## Contract surfaces → spec files (traceability)

| Surface | Change | Spec file(s) |
| --- | --- | --- |
| DB column + index | `run_cost_rollups.by_runner jsonb not null default '{}'` **and** a partial index `runs_ended_at_idx on runs(ended_at) where ended_at is not null` (supports the sweep's bounded `order by ended_at limit n` scan) | migration `web/lib/db/migrations/0083_run_cost_rollups_by_runner.sql` + snapshot; `docs/database-schema.md`; `docs/db/runs-domain.md` (ERD); `docs/db/erd.md` if table present |
| Domain-event consumer | new `cost-rollup-reconcile` consumer (id `cost-rollup-reconcile`, `startFrom: "now"`, **poison-safe** per D7 — no new event **kind**, subscribes to existing `run.done|failed|crashed|abandoned`; fast-path only, not the completeness guarantee) | `docs/system-analytics/domain-events.md` (consumer table); `docs/system-analytics/observatory.md` (reconcile triggers) |
| Scheduler job | backstop reconcile folded into existing `system_sweep` tick (no new job kind) | `docs/system-analytics/scheduler.md`; `docs/system-analytics/observatory.md` |
| Internal TS contract | `ObservatoryCostSummary` gains `byModel: CostDimensionRow[]`, `byRunner: CostDimensionRow[]` | `docs/system-analytics/observatory.md` (cost dimension) |
| ADR | ADR-117 (reliable reconcile + by-runner) | `docs/decisions.md` (index row + body) |
| Env var (if added) | `MAISTER_COST_RECONCILE_LOOKBACK_HOURS` (sweep lookback) | `.env.example`; `docs/configuration.md` env table; compose `web` service env |
| HTTP/OpenAPI | **none** — project/portfolio Observatory is RSC; only `/api/runs/{runId}/cost-summary` (web.openapi.yaml:3884) is HTTP and is **out of scope** | — |

> Note: `observatory.md` currently attributes the cost dimension to "ADR-085", which in `docs/decisions.md` is actually *MiMo Code adapter* — a stale/colliding citation. Phase 0 corrects that reference to ADR-085(cost)→the real cost ADR lineage (ADR-101 + new ADR-117) while flipping the model/runner pieces `Designed → Implemented`.

---

## Phase 0 — Spec & analytics (front-loaded, complete before any code)

**Exit criteria:** every artifact below written, internally consistent, with implementation-status tags; ADR-117 + migration 0083 reserved with stub headers; `pnpm validate:docs` + the ADR-anchor check green. No code yet.

- **T0.1 — ADR-117 body + index row.** `docs/decisions.md`: write `### ADR-117: Reliable cost-rollup reconciliation (sweep guarantee + fast-path consumer) and per-runner cost attribution`. Capture: the read-only-boundary rationale (why not read-time); the **role split** (sweep = `ended_at`-keyed completeness guarantee because scratch-success emits no event; consumer = low-latency fast-path, `startFrom:"now"`, poison-safe per D7); the `ended_at` + `SETTLE_GRACE` predicate (D8) and why a status allow-list is insufficient; `by_runner` column + `(runId, sessionName)→run_sessions` bridge (D1–D2) with the conditional-precision caveat (D2a); idempotency (D5); removal of dead `reconcileProjectScopeCostRollups`. Add the index table row. → verify: anchor resolves (`scripts/validate-docs-adr-anchors.mjs`).
- **T0.2 — `observatory.md` cost-dimension rewrite.** Replace the "Designed, ADR-085" cost section: document model + runner breakdown, the **two reconcile triggers with their distinct roles** (sweep guarantee vs consumer fast-path — explicitly state scratch-success has no event so the sweep is what guarantees its inclusion), the preserved read-only boundary (reads derived rollups only), the `"unknown"` runner/model buckets, the conditional by-runner precision (D2a), and volatile/active-run handling. Fix the stale ADR citation. Tag model/runner aggregation `Designed` now with a TODO marker the later phases flip to `Implemented`. → verify: section enumerates every trigger + bucket exactly as code will gate.
- **T0.3 — DB spec.** `docs/database-schema.md` + `docs/db/runs-domain.md` (+ `docs/db/erd.md` if it lists `run_cost_rollups`): add `by_runner jsonb not null default '{}'` with the value shape `{ "<adapter>/<model>": { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } }` (mirrors `by_model`). Update the Mermaid `erDiagram`. → verify: both narrative + ERD updated (rule: updating one is not updating the other).
- **T0.4 — domain-events + scheduler spec.** `docs/system-analytics/domain-events.md`: add the `cost-rollup-reconcile` consumer row (subscribes terminal run kinds, at-least-once, idempotent, self-exclusion N/A). `docs/system-analytics/scheduler.md`: document the `system_sweep` backstop reconcile (candidate predicate, lookback, per-tick bound). → verify: consumer + job described as implemented in Phases 2.
- **T0.5 — TS contract sketch.** In `observatory.md`, define `CostDimensionRow = { key: string; label: string; inputTokens; outputTokens; cacheReadTokens; cacheCreationTokens; totalTokens }` and the `ObservatoryCostSummary.byModel/byRunner` additions. Pure-read, no new HTTP surface. → verify: matches the interface Phase 3 implements.
- **T0.6 — Acceptance-criteria + edge-case register.** A consolidated table (carried into each phase) enumerating: scratch-included-without-open, **scratch-success-without-any-event (sweep-only path)**, multi-model split, multi-session→multi-runner split, **single-session flow → one runner bucket (D2a)**, `"unknown"` bucket, idempotent re-reconcile (no stale runner buckets), **poison-message safety (always-failing run never stalls the consumer cursor)**, **late cost-flush captured via SETTLE_GRACE**, read-only-boundary guard, resume-tax-not-double-counted, project-less run handling, empty-project empty-state. Each row names the test that proves it.

---

## Phase 1 — Data model + reconcile produces `by_runner`

**Exit:** migration applied; `reconcileRunCostRollups` writes `by_runner`; full unit + `cost-rollups` integration suite green (`pnpm test:unit && pnpm test:integration`).

- **T1.1 (RED) — pure aggregation unit tests.** `web/lib/runs/__tests__/cost-rollups.test.ts` (vitest unit, `lib/**` glob — already covered). Extend `aggregateCostJsonlLines` to also bucket totals **by `sessionName`** (pure, no DB). Tests: two sessionNames in one run → two buckets; missing `sessionName` → `"default"` bucket key (matches supervisor default, `supervisor-client.ts:104`); resume records not double-counted into the session bucket; empty input → `{}`. Assert the existing `by_model` + run totals are unchanged (no regression).
- **T1.2 (GREEN) — implement bySession aggregation.** Add a `bySession: Record<string, TokenTotals-subset>` field to `CostRollupAggregation.run`. KISS: reuse `addByModel`'s shape via a generic `addByKey(bucket, key, record)` (DRY — refactor `addByModel` to call it). → verify: T1.1 green.
- **T1.3 (RED) — reconcile integration tests.** `web/lib/runs/__tests__/cost-rollups.integration.test.ts` (real PG). Seed a run + `run_sessions` rows; write a `cost.jsonl` fixture under a temp runtimeRoot. Cases: (a) single-session run → one `by_runner` key = `adapter/model` from snapshot; (b) two sessions mapped to two distinct runners → two keys with correct split; (b2, D2a) **single-session flow with multiple nodes all on `sessionName="default"` → exactly one runner bucket** (no phantom per-node split); (c) cost event whose `sessionName` has no `run_sessions` row → `"unknown"` key; (d) re-reconcile after a session's runner_snapshot changes → `by_runner` reflects the new mapping, **no stale key** (D5); (e) scratch run (no task, no node_attempts) → `by_runner` written, run-level totals intact.
- **T1.4 (GREEN) — `reconcileRunCostRollups` joins run_sessions.** Load `run_sessions` for the run (`select sessionName, runnerId, runnerSnapshot where runId=...`), build a `sessionName → runnerKey/label` map, fold `aggregation.run.bySession` into a `byRunner` object, persist into the new column in the same `runValues` upsert. Derive `runnerKey` per D2; `"unknown"` fallback. → verify: T1.3 green.
- **T1.5 — migration `0083`.** `pnpm db:generate` after adding (a) `byRunner: jsonb("by_runner").$type<Record<string, Record<string, number>>>().notNull().default({})` to `runCostRollups` and (b) a partial index on `runs` — `index("runs_ended_at_idx").on(t.endedAt).where(sql\`ended_at is not null\`)` (supports the Phase-2 sweep scan). Confirm generated SQL = one `ADD COLUMN ... default '{}'` + one `CREATE INDEX`; rebuild snapshot clean; `pnpm db:check` (journal monotonic — see `[[drizzle-journal-when-skip]]` hazard) green. **Deployment wiring:** schema-only, no env/port — no compose change for this task.
- **Commit checkpoint:** "feat(cost): by_runner rollup column + reconcile (migration 0083)".

---

## Phase 2 — Reliable reconcile triggers (terminal consumer + backstop sweep)

**Exit:** an event-emitting terminal run reconciles via the consumer (fast-path); a no-event scratch-success run reconciles via the `ended_at` sweep (guarantee); full integration suite green; dead `reconcileProjectScopeCostRollups` removed.

- **T2.1 (RED) — terminal-consumer integration tests.** `web/lib/domain-events/__tests__/cost-rollup-reconcile.integration.test.ts` (real PG, temp runtimeRoot with a `cost.jsonl`). Runnability **confirmed** — precedent: `lib/domain-events/__tests__/*.integration.test.ts` already runs in the integration project (auto-launch, orchestrator-resume, dispatch). Cases: (a) `run.failed` for a never-opened scratch run → after one dispatch pass a `run_cost_rollups` row exists with correct totals + `by_runner`; (b) a **batch** containing two terminal events for two runs + one non-terminal (`run.escalated`) → both runs reconciled, the non-terminal ignored, runIds deduped; (c) the same event delivered twice (at-least-once) → exactly one rollup, `sourceCursor` stable; (d) terminal event for a run with no `cost.jsonl` on disk → `missing-cost-file`, no row, no throw; (e) **poison-message safety (D7): one run whose reconcile always throws (e.g. forced `CONFIG`) inside a batch → the consumer still reconciles the other runs in the batch AND `handle` resolves (does not throw) so the dispatch cursor advances** — assert via a follow-up that a later event for a healthy run is delivered (cursor not stalled); (f) project-less local-package run → handled gracefully (owner-slug resolved via `localPackageSlug` as today).
- **T2.2 (GREEN) — implement the consumer.** New `web/lib/domain-events/cost-rollup-reconcile.ts` exporting a `DomainEventConsumer` (mirror `auto-launch.ts` shape): `id: "cost-rollup-reconcile"`, `startFrom: "now"` (forward-only — the sweep owns historical backfill, NOT a `"beginning"` replay). `handle(events[])`: filter to `kind ∈ {run.done, run.failed, run.crashed, run.abandoned}`, dedupe `payload.runId`, `reconcileRunCostRollups` each **inside a per-run try/catch that logs WARN and continues** (D7 — never throw out of `handle`; a transient disk error is retried by the sweep, a permanent one is skipped). Register in `DOMAIN_EVENT_CONSUMERS` (`consumers.ts`). → verify: T2.1 green.
- **T2.3 (RED) — backstop sweep tests.** `web/lib/runs/__tests__/cost-reconcile-sweep.integration.test.ts` (real PG). Cases: (a) **a finished scratch run that fired no `run.done` (only `ended_at` set), never opened, no rollup → sweep reconciles it** (the core guarantee — proves the sweep does not depend on any event); (b) an ended run whose rollup `updated_at < ended_at + SETTLE_GRACE` → re-reconciled (late-flush capture, D8); (c) an ended run whose rollup is long-settled (`updated_at ≥ ended_at + SETTLE_GRACE`) → **skipped** (no redundant disk read — assert via a reconcile spy/counter); (d) bounded: ≤ `PER_TICK_LIMIT` candidates per tick, ordered by `ended_at`; (e) a still-active run (`ended_at IS NULL`) → not a candidate.
- **T2.4 (GREEN) — implement the sweep pass + wire into `system_sweep`.** New `reconcileTerminalCostRollups(db, { lookbackHours, limit, settleGraceMs })` in a sibling `web/lib/runs/cost-reconcile-sweep.ts` (KISS, near reconcile): select candidates by the D8 predicate (`ended_at IS NOT NULL AND ended_at > now − lookback AND (rollup missing OR rollup.updated_at < ended_at + SETTLE_GRACE)`), ordered by `ended_at`, bounded by `limit`; reconcile each concurrency-limited like the keepalive passes. `SETTLE_GRACE` is a module constant (~2 min); lookback from env (T2.6). Call it from the `system_sweep` branch (`lib/scheduler/jobs.ts:130` / `tick-service.ts:87`). → verify: T2.3 green.
- **T2.5 — remove dead `reconcileProjectScopeCostRollups`.** Delete the function (`cost-rollups.ts:412`) and any test referencing it; it is superseded by T2.4 and is read-path-unsafe. (Surgical: only this function; confirm zero non-test callers — already verified.)
- **T2.6 — deployment wiring.** Add `MAISTER_COST_RECONCILE_LOOKBACK_HOURS` (default e.g. 168h/7d, matching GC horizon) → `.env.example` + `compose.yml` `web` service `environment:` + `docs/configuration.md` env table. Per-tick limit reuses the existing sweep constant (no new var). → verify: env var documented in all three places.
- **Commit checkpoint:** "feat(cost): terminal-event consumer + system_sweep backstop reconcile".

---

## Phase 3 — Project / portfolio aggregation (by-model + by-runner)

**Exit:** `getCostSummary` returns `byModel` + `byRunner`; read-only boundary guard test green; suite green.

- **T3.1 (RED) — getCostSummary integration tests.** `web/lib/queries/__tests__/observatory-cost.integration.test.ts` (real PG). Seed a project with: a flow run (2 models, 2 runners across 2 node-sessions) + a scratch run (1 model/runner, no task/node_attempts), both with `run_cost_rollups` rows incl. `by_runner`. Assert: project totals include the scratch tokens; `byModel` rows summed across runs with correct per-model totals; `byRunner` rows summed across runs with `"<adapter>/<model>"` keys + labels; rows sorted deterministically (e.g. by `totalTokens` desc then key). Edge: empty project → `byModel:[], byRunner:[]`; a run that only has `"unknown"` runner → an `"unknown"` row.
- **T3.2 (RED) — read-only boundary guard.** A test asserting `getProjectObservatory` / `getCostSummary` perform **no** reconcile and **no** `cost.jsonl` read (spy on `reconcileRunCostRollups` / fs read → asserted not called). Enforces D4/§272.
- **T3.3 (GREEN) — aggregate `by_model` + `by_runner` in `getCostSummary`.** Select the two jsonb columns alongside the existing token columns; fold across rows into two `Map<key, totals>`; emit sorted `CostDimensionRow[]` with computed `totalTokens` + display `label`. Extend `ObservatoryCostSummary` + `emptyCostSummary()`. Keep `node`/`flow`/`project` counts unchanged. → verify: T3.1 + T3.2 green.
- **Commit checkpoint:** "feat(observatory): project/portfolio cost breakdown by model + runner".

---

## Phase 4 — UI (model & runner breakdown) + i18n

**Exit:** breakdown renders on portfolio + project Observatory cost tab; EN/RU parity; component tests green; e2e written.

- **T4.1 (RED) — component tests.** `web/components/observatory/__tests__/observatory-components.test.ts` (vitest dom). A new `CostBreakdownCard` (or two instances: model + runner): renders rows with formatted tokens, an empty-state row when the dimension is empty, accessible table semantics + `aria-label`, and uses i18n labels. Follow data-management page patterns (view-only table, no inline edit).
- **T4.2 (GREEN) — build the breakdown UI.** Add `cost-breakdown-card.tsx` (HeroUI table, forest tokens, `@heroicons/react`), wire two instances ("By model" / "By runner") into `app/(app)/observatory/page.tsx` and `app/(app)/projects/[slug]/observatory/page.tsx` cost tab. Reuse `formatTokens`. Affordance conventions: glyph + label headers, no text-only buttons.
- **T4.3 — i18n EN/RU.** Add `cost.byModel*` / `cost.byRunner*` keys to `messages/en.json` + `messages/ru.json` (parity — RU required). → verify: key-parity check green.
- **T4.4 (e2e, written; run gated) — `web/e2e/observatory-cost-breakdown.spec.ts`.** Seed a project with a scratch run + a multi-runner flow run; assert the breakdown tables show model + runner rows and the scratch tokens are present. Note: Next 16 single-dev-server lock — runs only when :3000 is free; mark in the spec header (`AUTHED_SPEC`) per existing convention. Not a phase-blocking gate when the lock prevents local run; static lint of the spec must pass.
- **Commit checkpoint:** "feat(observatory-ui): by-model + by-runner cost cards (EN/RU)".

---

## Phase 5 — Docs as-built reconcile + verification

**Exit:** every spec piece tagged `Implemented`; no `Designed` tag remains for shipped code; all gates green.

- **T5.1 — flip status tags.** `observatory.md` model/runner aggregation + reconcile triggers `Designed → Implemented`; confirm `domain-events.md` consumer + `scheduler.md` sweep marked Implemented.
- **T5.2 — final gate sweep.** `pnpm typecheck` (web + supervisor) `0`; `pnpm test:unit`; `pnpm test:integration` (real PG — mandatory: tsc + mocked-unit are blind to a dropped/added column per `[[m42-unified-runner-sessions-state]]` lesson); `pnpm lint` (run check-only `pnpm exec eslint` over changed files — never `eslint --fix` over dirs, it rewrites drift files per memory); `pnpm validate:docs` + ADR-anchor check; i18n parity. Record outputs.
- **T5.3 — migration journal sanity.** `pnpm db:check` green; journal `when` monotonic (the rebase hazard); snapshot matches schema.

---

## Test integrity (applies to every phase)

- **Runnability:** unit tests under `web/lib/**/__tests__/*.test.ts` (vitest unit project); integration under `*.integration.test.ts` (real-PG project). `web/lib/domain-events/__tests__/*.integration.test.ts` runnability is **confirmed** (existing precedent: auto-launch / orchestrator-resume / dispatch integration specs already run there) — no config change needed. Still run `vitest list` on each new file before marking its task done.
- **Per-phase green checkpoint:** each phase's exit runs `pnpm test:unit && pnpm test:integration` green. A touched test left red fails the phase; pre-existing red is quarantined explicitly with a reason, never tolerated silently.
- **No trivial tests / minimum overlap:** the pure aggregation (sessionName bucketing) is unit-tested once; the run_sessions join + persistence is integration-tested once; the read aggregation is tested once at the query layer. No re-testing the same fold at multiple layers.
- **Edge-case coverage (register from T0.6):** scratch-without-open · scratch-success-without-event (sweep-only) · multi-model split · multi-session→multi-runner split · single-session→one-runner (D2a) · `"unknown"` bucket · idempotent re-reconcile (no stale runner key) · poison-message safety (D7) · late-flush capture via SETTLE_GRACE (D8) · read-only-boundary guard · resume-tax-not-double-counted · project-less run · empty-project empty-state. Each maps to exactly one owning test named in T0.6 (minimum overlap — the sweep-only and poison cases live only in the Phase-2 integration specs, not duplicated at the unit layer).

## Risks / invariants

- **Read-only boundary (§272):** the single biggest constraint — guard test T3.2 is non-negotiable. Any reconcile in a read path is a defect.
- **At-least-once dispatch:** the consumer + sweep both rely on `reconcileRunCostRollups` idempotency; never introduce a non-idempotent side effect there.
- **Poison message (D7):** a throwing `handle` stalls the cursor (`dispatch.ts:203` breaks without advancing) — the consumer must swallow per-run errors. This is the single highest-risk regression; the T2.1(e) poison test is non-negotiable.
- **Event-coverage asymmetry:** scratch-success emits no terminal event, so correctness MUST NOT depend on the consumer for completeness — the `ended_at`-keyed sweep (T2.3(a)) is the guarantee. Do not "optimize away" the sweep on the assumption that the consumer covers everything.
- **Journal/migration collision:** branch is at `main` HEAD now, but allocate 0083 from `main` HEAD at merge time and budget a renumber check (per skill-context rule + `[[drizzle-journal-when-skip]]`).
- **No new domain-event kind / no new run status:** this feature adds a *consumer* and a *sweep pass* over existing kinds — the "fan-out a new enum to all consumers" rule does not trigger, but T0.4 still records the consumer in the domain-events doc.

## Неразрешённые вопросы

1. `MAISTER_COST_RECONCILE_LOOKBACK_HOURS` дефолт — 168ч (=7д GC-горизонт) ок, или короче/длиннее?
2. By-runner лейбл в UI — `adapter/model` (напр. `claude/claude-sonnet-4-6`) достаточно, или нужно показывать ещё providerKind (direct vs z.ai)?
3. Сортировка строк разбивки — по убыванию totalTokens (предлагаю) или алфавит по ключу?
4. Нужна ли разбивка by-runner/by-model также на run-level `/api/runs/{runId}/cost-summary` (сейчас вне scope, только проект/портфолио)?
