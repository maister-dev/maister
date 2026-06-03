# Implementation Plan: M15 — Readiness Policy and Verdict Calibration

Branch: claude/hopeful-brown-b1af84
Created: 2026-06-03
Refined: 2026-06-03 (/aif-improve — deep code pass; SDD/TDD-multiagent restructure)

## Settings
- Testing: yes (vitest unit + integration via testcontainers, Playwright e2e)
- Logging: verbose (DEBUG flow + INFO key events; no secrets in any log line)
- Docs: yes — mandatory documentation checkpoint at completion
- Methodology: **SDD + TDD, multi-agent execution** (see "Execution model" below)

## Execution model (SDD + TDD multi-agent)

This plan is shaped to be run by `claude --agent implement-coordinator`, which
dispatches each task to an `implement-worker` in an **isolated git worktree**
(implement → verify → return), then runs review/security/best-practices/rules
**sidecars** after each slice.

- **SDD:** Phase 0 freezes the contract (ADR + truth tables in
  `docs/system-analytics/readiness.md`) **before any code**, single-owner.
  Every later task implements to that frozen contract.
- **TDD inside each slice:** because each task is one worker in one worktree, a
  red task and its green task **cannot** be split across workers (the green
  worker would not see the red worker's failing tests). So each implementation
  task is a **self-contained TDD slice**: write failing tests → implement to
  green → self-verify. The "reviewer" role of the classic SDD
  tester→implementor→reviewer loop is the coordinator's automatic **sidecars**
  + the Phase-7 verification gate.
- **Parallelizable batches** (the coordinator may run these concurrently;
  dependencies enforced by `blockedBy`):
  - **P1 batch:** Tasks 3, 4, 5 are independent → up to 3 workers.
  - **P3/P5 overlap:** Task 12 (P5) depends only on Task 8 (P3), so it can run
    alongside Task 10 (P4).
  - **P6 batch:** Tasks 14, 15, 16 are independent → up to 3 workers; Task 17
    (i18n) joins them; Task 18 (e2e) closes the phase.

## Scope boundary (locked)

Re-scoped by **ADR-028** (gate execution → M11a) and bounded by **ADR-045**
(external_check loop → M16; M18 promotion reuses the readiness check). Already
shipped — do NOT rebuild: full gate execution + lifecycle + blocking/advisory +
structured verdicts + staleness + override-without-erasure (M11a);
`assertEvidenceReady` at the Review chokepoint (but only `artifact_required` +
`external_check`, only for engine ≥ 1.2.0); the `external_check` report loop +
`getRunReadiness` 5-state DTO + board `externalGatePending`/`mergeBlocked`/
`evidenceStale` badges (M16).

M15's genuine gaps:
1. Readiness enforcement over **all evaluated blocking gate kinds** (today only 2 of 6).
2. **Verdict calibration** — `confidence` is stored but never consulted.
3. A **unified readiness summary** (`ready|blocked|stale|failed|waiting|overridden`)
   on run-detail (zero today), board (3 bespoke badges → one), and portfolio.
4. A **merge-phase guard** wired into the existing scratch promote route — as a
   reusable call site / future-proofing only. **This is NOT M15 coverage of the
   "merge refuse" AC** (scratch runs carry no flow gates, so it is vacuous in
   production). Real flow-run merge enforcement is **deferred to M18** — see the
   AC mapping + C3 below.

## Design decisions (frozen — see the P0 ADR)

- **Required-gate signal = existing `mode: blocking`.** No new `readiness_policy`
  grammar (AC defers "complex policy language"). Drawback: `blocking` conflates
  execution-abort with promotion-required — acceptable; a future
  `readiness_policy` block is purely additive.
- **Verdict calibration** = per-gate `calibration.confidence_min` + optional
  flow-level `verdict_calibration.confidence_min` default. The flow default is
  folded into each gate's *effective* calibration **at compile time**
  (`compile.ts`), so `gates-exec` only ever reads `gate.calibration`. Applies to
  **both** `ai_judgment` and `skill_check` (one shared case at
  `gates-exec.ts:271-341`). Applied at **execution** → `gate_results.status`
  becomes the calibrated truth; the outcome is persisted in `gate_results.verdict`
  JSONB (`calibration: { confidenceMin, rawVerdict, outcome }`) for observability.
  Because calibration sets `status` at execution, the readiness evaluator only
  ever reads `status` — it never needs to know about confidence.
  - *Fail-closed no-confidence (Codex finding 1):* a pass-string with confidence
    **below** the threshold → `failed` (`outcome: "below_threshold"`); a pass-string
    with **no** `confidence` while a threshold is set → **`failed`** by default
    (`outcome: "no_confidence"`) — fail-closed, because a promotion gate must not
    pass an unverifiable verdict (the readiness evaluator only reads `status`, so a
    fail-open here would be invisible downstream). A per-gate
    `allow_missing_confidence: true` opt-in restores the lenient pass (intended for
    `skill_check` gates that legitimately may not emit confidence). No threshold
    configured → unchanged legacy pass.
- **No engine gating, no version bump.** `MAISTER_ENGINE_VERSION` stays `1.2.0`.
  Enforcement + calibration apply to **all graph flows** (no prod flows; new
  fields are optional/additive). The `artifactEnforcementActive` guard at the
  chokepoint is removed — surgically, touching only the readiness-chokepoint call.
  Linear `steps[]` flows (old `runner.ts`) are unaffected (never call the evaluator).
- **Blocking `human_review` gate is rejected at validation (`CONFIG`).**
  `gates-exec.ts:424-442` always records `human_review` gates as `skipped`, so a
  blocking one would permanently deadlock promotion. Advisory is allowed; the
  bundled `aif` flow uses a human *node*, not a human_review gate.
- **Single source of truth.** A shared `readiness-core.ts` (live-attempt
  collection + external collapse + per-kind allow-list `{passed, overridden}` +
  priority classifier) is consumed by the enforcer (`assertEvidenceReady`), the
  read-model (`getRunReadiness`), and the board/portfolio queries — so all four
  classify gates identically.
- **`overridden` is a distinct surfaced state.** Priority
  `failed > stale > blocked > waiting > overridden > ready`.
- **Project-level command_profiles/skill_mappings/default-limits:** DEFERRED
  (not in AC; M14 already supplies env/agent/skill profiles).
- **No DB migration** (calibration rides the existing `verdict` JSONB); **no new
  `MaisterError` code**; **no new `runs.status`**.

## Acceptance criteria (ROADMAP M15) → coverage
- **Review refuse** on any required blocking gate missing/pending/running/failed/
  stale/skipped → **COVERED by M15**: P3 (Task 8 evaluator over all blocking kinds
  + runner integration test proving a graph run with a failed/stale blocking gate
  cannot reach `Review`).
- **Merge refuse for flow runs** → **DEFERRED to M18** (Codex finding 2). The only
  existing merge route is scratch-only and scratch runs carry no flow gates, so it
  cannot exercise this criterion. Task 12 wires `assertEvidenceReady(_, "merge")`
  into the scratch route as the reusable call site / future-proofing **only — it
  does NOT count as M15 coverage of the merge criterion.** M18 (flow-run promotion)
  enforces it for real, reusing the same evaluator. Task 20 records this deferral
  explicitly in the ROADMAP M15 as-built note.
- Run-detail & board readiness summary (6 states) → P4 (Task 10) + P6.
- Verdict calibration maps `ai_judgment` confidence → readiness state → P1/P2.
- `external_check` participates in the unified roll-up + staleness → already
  M16; confirmed in Task 8/10, verified in Task 21.

## Commit Plan
- **Commit 1** (P0, Tasks 1–2): `docs(m15): freeze readiness + calibration contract (ADR + readiness.md)`
- **Commit 2** (P1, Tasks 3–5): `feat(m15): gate calibration schema (+compile resolve, human_review reject), all-graph-flows chokepoint, GateVerdict.calibration`
- **Commit 3** (P2, Task 6): `feat(m15): verdict calibration at gate execution (ai_judgment + skill_check)`
- **Commit 4** (P3, Task 8): `feat(m15): shared readiness-core + authoritative evaluator over all blocking kinds`
- **Commit 5** (P4, Task 10): `feat(m15): unified readiness DTO (+overridden) via shared core`
- **Commit 6** (P5, Task 12): `feat(m15): merge-phase readiness guard on scratch promote`
- **Commit 7** (P6, Tasks 14–18): `feat(m15): readiness summary UI (run-detail, board, portfolio) + i18n + e2e`
- **Commit 8** (P7, Tasks 19–21): `docs(m15): as-built reconcile + aif flow + roadmap flip; final verify`

## Tasks
(IDs match the tracked task list; each implementation task is a self-contained TDD slice.)

### Phase 0 — SDD spec-freeze (solo, before code)
- [x] Task 1: Author ADR for M15 readiness policy & verdict calibration → `docs/decisions.md`
- [x] Task 2: Freeze readiness contract & truth tables → `docs/system-analytics/readiness.md` (depends on 1)
<!-- Commit checkpoint: tasks 1-2 -->

### Phase 1 — Schema & chokepoint contract (parallel batch: 3 ∥ 4 ∥ 5)
- [x] Task 3: Gate `calibration` schema + compile-time flow-default resolution + reject blocking `human_review` (depends on 2)
- [x] Task 4: Drop engine gating at the readiness chokepoint — all graph flows, no version bump (depends on 2)
- [x] Task 5: Extend `GateVerdict` type with `calibration` sub-object — no migration (depends on 2)
<!-- Commit checkpoint: tasks 3-5 -->

### Phase 2 — Verdict calibration at execution (TDD slice)
- [x] Task 6: Calibration at execution for `ai_judgment` + `skill_check` (red→green→verify) (depends on 3, 5)
<!-- Commit checkpoint: task 6 -->

### Phase 3 — Shared readiness-core + authoritative evaluator (TDD slice)
- [x] Task 8: `readiness-core.ts` (single source of truth) + extend `assertEvidenceReady` to all evaluated kinds + runner integration test (depends on 3, 4, 5, 6)
<!-- Commit checkpoint: task 8 -->

### Phase 4 — Unified readiness DTO (TDD slice)
- [x] Task 10: Add `overridden` + unify `skipped` + adopt shared core in `getRunReadiness` (depends on 8)
<!-- Commit checkpoint: task 10 -->

### Phase 5 — Merge-phase guard on scratch promote (TDD slice, M18-bound) — may run ∥ P4
- [x] Task 12: Wire `assertEvidenceReady(_, "merge")` into scratch promote (co-located route test) (depends on 8)
<!-- Commit checkpoint: task 12 -->

### Phase 6 — Readiness summary UI + i18n + e2e (parallel batch: 14 ∥ 15 ∥ 16 → 17 → 18)
- [ ] Task 14: Run-detail readiness summary panel + component tests (depends on 10)
- [ ] Task 15: Unify board flight-card to one readiness badge via shared core over bulk rows (depends on 10)
- [ ] Task 16: Portfolio card readiness state via shared core over bulk rows (depends on 10)
- [ ] Task 17: EN+RU i18n (`web/messages/en.json` + `ru.json`) for readiness states & panel (depends on 14, 15, 16)
- [ ] Task 18: Playwright e2e — blocking gate → blocked → resolve → ready/overridden (depends on 12, 15, 17)
<!-- Commit checkpoint: tasks 14-18 -->

### Phase 7 — Bundled flow + docs as-built + final verify
- [ ] Task 19: Update bundled `aif` Flow to exercise calibration (depends on 6, 8)
- [ ] Task 20: Reconcile docs to as-built + flip ROADMAP M15 (depends on 12, 18, 19)
- [ ] Task 21: Final verification gate (depends on 20, 18)
<!-- Commit checkpoint: tasks 19-21 -->

## Key files (verified against code)

| Concern | File:anchor |
| --- | --- |
| Readiness evaluator (enforce) | `web/lib/flows/graph/evidence-readiness.ts` (`assertEvidenceReady`; checks only artifact_required + external_check today) |
| Readiness read-model | `web/lib/queries/readiness.ts` (`getRunReadiness`, `ReadinessDTO`; already rolls up all blocking kinds for failed/stale/waiting at L164-169; skipped only handled for external at L346) |
| **NEW shared core** | `web/lib/flows/graph/readiness-core.ts` (Task 8) |
| External-gate collapse | `web/lib/flows/graph/external-gate-readiness.ts` (`isExternalGateReady`, `collapseLatestExternalPerGate`) |
| Gate execution + verdict | `web/lib/flows/graph/gates-exec.ts` (ai_judgment+skill_check share case L271-341; `human_review`→skipped L424-442; `isPassVerdict`/`parseVerdict`) |
| Gate store | `web/lib/flows/graph/gate-store.ts` (`markGate*`, `markGateOverridden`, `reportExternalGate`) |
| Compile (gate pass-through) | `web/lib/flows/graph/compile.ts` (gates passed as-is at L84 — per-gate `calibration` survives free; fold flow default here) |
| Gate schema (manifest) | `web/lib/config.schema.ts` (`gateSchema` L291-336; `flowYamlV1Schema` L551) + `web/lib/config.ts` |
| `GateVerdict` + `gate_results` | `web/lib/db/schema.ts` (GateVerdict L891-903; gate_results L909-960) |
| Engine version (NOT bumped) | `web/lib/flows/engine-version.ts` (stays 1.2.0) |
| Review chokepoint / runner | `web/lib/flows/graph/runner-graph.ts` (gates L1108-1143; `artifactEnforcementActive` guard L1481 — remove for readiness; Review entry L1651) |
| Promote route (scratch-only) | `web/app/api/runs/[runId]/promote/route.ts` (`runKind!=="scratch"` rejects L90; co-located test `promote/__tests__/route.test.ts`) |
| Run-detail page (no readiness UI) | `web/app/(app)/runs/[runId]/page.tsx` |
| Board card + query | `web/components/board/flight-card.tsx`, `web/lib/queries/board.ts` |
| Portfolio card + query | `web/components/portfolio/project-card.tsx`, `web/lib/queries/portfolio.ts` |
| i18n catalogs (next-intl) | `web/messages/en.json`, `web/messages/ru.json` |
| Bundled Flow | `plugins/aif/flow.yaml` |
| Test conventions | unit/integration `*.test.ts` / `*.integration.test.ts` under `web/lib/__tests__/`; route tests co-located in `**/__tests__/route.test.ts` (fake DB); component tests via `renderToStaticMarkup` (no jsdom); e2e `web/e2e/m15-*.spec.ts` |

## Risks / invariants
- **Applies to all graph flows now** (no engine gate, no bump) — justified by "no
  production flows." Adjust any existing tests that asserted the old 2-kind /
  engine-gated behavior (Tasks 4, 8).
- **Single source of truth:** enforcer, read-model, board, and portfolio MUST
  classify gates through `readiness-core.ts` — no divergent copies (Task 21 checks this).
- **No blocking `human_review` deadlock:** rejected at validation (Task 3).
- **No board N+1:** board/portfolio reuse the shared classifier over bulk-fetched
  rows, never per-run `getRunReadiness` (Tasks 15, 16).
- **C3 honesty:** the scratch-promote merge guard is additive future-proofing
  (scratch runs have no flow gates → vacuously ready in prod). The genuine M15
  enforcement is the Review chokepoint; **M18 owns flow-run promotion + its real
  merge verification**, reusing this evaluator.
- No regression of M11a `reworking`, M11b `HumanWorking`, M12 evidence, M16
  external-gate badges when unifying the board/portfolio cards.
- No new `runs.status`, no new `MaisterError` code, no DB migration.
