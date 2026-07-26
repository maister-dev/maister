# Fix Plan: Codex adversarial findings — recipe fidelity + pairwise integrity (Codex-1/2/4)

## Session handoff — START HERE (fresh session, context cleared)

- **Branch:** `feature/codex-eval-integrity` (off `main` @ `f89d1231`, which already carries the Codex-3 fix). Confirm with `git branch --show-current`; if not on it, `git checkout feature/codex-eval-integrity`.
- **Scope:** implement the 3 remaining Codex adversarial findings on the pushed Evaluation-Lab cut-over: **Codex-2, Codex-4, Codex-1**. **Codex-3 is already fixed + committed (`f89d1231`) — do NOT redo it.**
- **Decision LOCKED (owner, 2026-07-26): Codex-1 = C · partial thread** (thread pinned flow-revision + form inputs into `launchRun`; guard/defer overlay + package-pins). Do NOT re-open the fork — see the Codex-1 steps + "Decision (Codex-1)" section below.
- **Order (TDD, RED-first): Codex-2 → Codex-4 → Codex-1(C).** Commit each as a separate `fix(evaluations):` (NO AI / Co-Authored-By trailer). Integrate via rebase + FF for the owner to merge; do not push.
- **Gate battery per finding (repo conventions):** `set -o pipefail`; `rm -rf web/.next` before web `tsc`; `pnpm --filter maister-web typecheck`; `CI=true pnpm validate:contracts` + `validate:docs`; focused Vitest (integration needs Docker/Testcontainers UP); scope `eslint --fix` to changed files only, using `*` for `[slug]`/`[studyId]` bracket segments (NEVER bare `pnpm lint` — it reformats the repo); rebuild `mcp/dist` after any `mcp/src` edit (`pnpm --filter @maister/mcp build`).
- **Kick off:** run `/aif-fix` (no args) — it reads this file and executes it — OR implement Codex-2 directly. This plan is the SSOT; the prior conversation is not needed. This file was committed on the branch for durability; `/aif-fix` deletes it after the batch completes.

**Problem:** A `/codex:adversarial-review` of the pushed Evaluation-Lab cut-over (base `8375ff4e1..HEAD`) returned `needs-attention` with four HIGH findings, all verified in source. **Codex-3 (inline-idempotency digest reuse) was fixed immediately** (separate `fix(evaluations):` work + patch `2026-07-25-12.05.md`). This plan covers the three remaining, larger findings the owner deferred to a reviewed pass: **Codex-1** (controlled launches don't execute the frozen recipe), **Codex-2** (pairwise judge can't tell which candidates a match compares), **Codex-4** (pairwise provisioning/aggregation use live Study membership, not the sealed snapshot).
**Created:** 2026-07-25 12:08

> ⚠ **Owner decision required before executing Codex-1** — see "Open decision" at the end. Do NOT start Codex-1 coding until the fork (full-thread vs guarded-defer) is chosen; Codex-1 = the "trio full" the owner previously declined in favor of "trio minimal".

> ✓ **Pre-implementation investigation (2026-07-26) — Codex-2 & Codex-4 feasibility CONFIRMED; both are decision-independent and implemented first.** Branch `feature/codex-eval-integrity` (off `main` @ `f89d1231`).
> - **Codex-2:** `deriveBlinding(bound, d)` (`judges/facade.ts:208`) already yields `blinding.order` + `blinding.labels[participantId] → blindedLabel`; the bound attempt carries `matchA`/`matchB` (participant ids). Fix = add blinded `match: { a: blinding.labels[matchA], b: blinding.labels[matchB] }` to the pairwise context (only when matchA/matchB set) + scope `evidence` to that pair. No real participant id leaks.
> - **Codex-4:** freeze the set from `evaluationExecutions.evidenceSnapshotId → evaluationEvidenceSnapshots.participantWatermarks` (`schema.ts:2339`/`:2449`; keys = frozen participants, sorted deterministically for a stable round-robin). Replace the live `orderedStudyParticipantIds(studyId)` at BOTH `judges/launch.ts:245` (provision) and `aggregation/pairwise-aggregate.ts:113` (aggregate). (A `participant_ids` frozen array exists at `schema.ts:2886` — confirm whether it is the execution's and prefer it if so.)

## Analysis

### Codex-1 [HIGH] — Controlled launches do not execute the immutable recipe they claim to test
- **Where:** `web/lib/evaluations/launch-seam.ts:52-75` (`defaultLaunchRunSeam`).
- **Root cause:** the seam forwards only `taskId`, `allowConcurrent`, `autoPromote:false`, `evaluationStudyId`, `evaluationBatchItemId`, `executionPolicy`, and session-slot runner overrides. It OMITS the recipe's pinned Flow revision (`definition.flow.flowRevisionId`), form inputs (`definition.inputs.formValues`), capability overlay (`definition.capabilityOverlay`), materialization/package pins (`definition.materializationIntent.packagePins`), and any node-agent bindings. `launchRun` therefore resolves the flow from the task's **live enabled revision** and the project's live capabilities, so a variant executes the *current* configuration, not its frozen passport. Comparisons — and any standardization built on them — are invalid. This is the documented co-evolve deferral (`launch-seam.ts` header: "the capabilityOverlay and pinned flow-revision are likewise not yet threaded"), reframed by the adversarial pass as no-ship. Note: the `/aif-review` batch already added preflight WARN on unthreaded runner pins (H1) and records the run's ACTUAL revision in provenance (M4) — those SURFACE the gap; they do not close it.
- **Impact scope:** every controlled launch; the entire comparison + standardization value proposition.

### Codex-2 [HIGH] — Pairwise judges cannot determine what winner `a`/`b` refers to
- **Where:** `web/lib/evaluations/judges/facade.ts:267-273` (evaluator context), reading `blinding.order`; `evaluation_judge_attempts.match_a`/`match_b` (added in migration `0119`).
- **Root cause:** the bound attempt internally carries `matchA`/`matchB` (participant ids), but the evaluator context returns only `attempt {id,role,ordinal}` + the full randomized `candidates` list. It exposes NO mapping from the bound match sides to blinded candidate labels. So "Candidate A" is not guaranteed to be `match_a`, and with >2 participants the judge is not told which pair to compare. A valid `winner: a|b|tie` submission can systematically record the opposite or an unrelated result.
- **Impact scope:** every pairwise tournament verdict; the ranking is built on ungrounded picks.

### Codex-4 [HIGH] — Pairwise provisioning and aggregation use mutable Study membership
- **Where:** `web/lib/evaluations/aggregation/pairwise-aggregate.ts:109-122` (`computeTournamentForExecution` → `orderedStudyParticipantIds(args.studyId, d)`); the same live helper is used by pairwise provisioning in the dispatcher.
- **Root cause:** participants are reconstructed from currently non-`removed` Study rows, not from the execution's sealed evidence snapshot. A participant added during judging can enter attempts/standings with no captured evidence; a tombstoned one makes completed matches vanish from standings. The execution can still reach `completed` because `unresolvedMatchCount` counts recorded matches, not the frozen expected N·(N−1)/2 matrix.
- **Impact scope:** every pairwise execution whose Study membership changes mid-flight; standings integrity + terminal-state correctness.

## Fix Steps

### Codex-2 (do first — self-contained, unblocks correct pairwise verdicts)
1. [ ] Expose a **blinded pair mapping** on the pairwise evaluator context: `match: { a: "<blinded candidate label>", b: "<blinded candidate label>" }`, derived from the bound attempt's `matchA`/`matchB` mapped through the SAME blinding used for `candidates` — **never real participant ids**.
2. [ ] Scope the pairwise context/evidence (`evidence.itemCount`, evidence-list/read) to ONLY those two candidates, so the judge reads only the pair under comparison.
3. [ ] Update the external contract: `docs/api/external/operations.openapi.yaml` (judge context/`evaluation_context_get`) + the MCP tool schema (`mcp/src/tools.ts`) + rebuild `mcp/dist`.
4. [ ] Verify the `result_submit` seal path binds the pick to `match_a`/`match_b` (not positional candidate order).

### Codex-4 (do second — depends on the sealed snapshot the evidence layer already writes)
5. [ ] Freeze the participant set for an execution: derive provisioning AND aggregation participants from the attached evidence snapshot (`bound.evidenceSnapshotId` → the snapshot's `participantWatermarks`/participant list), NOT `orderedStudyParticipantIds(studyId)`. Both `pairwise-aggregate.ts` and the dispatcher provisioning site must use the frozen set.
6. [ ] Make `unresolvedMatchCount` / terminal detection compare against the frozen expected matrix (N·(N−1)/2 + byes), so a removed participant cannot let an execution complete with missing matches.
7. [ ] Reject or version Study membership mutations while an execution over that Study is active (add/remove participant routes gate on no-active-execution, or snapshot-scope the execution so mutations are inert to it).

### Codex-1 — CHOSEN 2026-07-26: **C · partial thread** (do last)
Thread the HIGH-VALUE axes so a variant runs the RIGHT revision + inputs; guard/defer the rarely-varied axes.
  8. [ ] Thread the recipe's pinned `flow.flowRevisionId` + `inputs.formValues` through `defaultLaunchRunSeam` → `launchRun`. Extend `launchRun`/`LaunchRunContext` to accept + HONOR a flow-revision override (the run pins the recipe's revision, NOT the task's live enabled revision) and the recipe's form inputs. **This subsumes the M4 provenance fix** — the run genuinely IS the pinned revision, so `runIdentity.flowRevisionId` is truthful by construction (the M4 read-actual patch stays correct/consistent).
  9. [ ] Re-run live preflight inside the seam immediately before the first side effect, failing closed on every hard refusal.
  10. [ ] GUARD the deferred axes (capability overlay, package pins): a recipe binding them — OR any run whose honored revision ≠ the recipe pin — is UN-standardizable (readiness/standardization gate), and preflight WARNS on them (extend the H1 `slot_runner_pin_not_threaded` pattern to overlay/packagePin). Document the remaining co-evolve boundary in `docs/system-analytics/evaluations.md` (Expectations + Edge cases).
  11. [ ] Tests: a variant pinned to a non-live flow revision RUNS on that revision (assert the run's `flowRevisionId` == recipe pin) with the recipe's form inputs; an overlay/packagePin recipe is refused at standardize; preflight warns on the deferred axes; non-evaluation `launchRun` callers (board/scratch/agent/flow) are unaffected by the new override params.

## Files to Modify
- `web/lib/evaluations/judges/facade.ts` — Codex-2 blinded match mapping + pair-scoped evidence.
- `web/lib/evaluations/judges/seal.ts`, `web/lib/evaluations/judges/launch.ts` — verify pick↔match binding.
- `docs/api/external/operations.openapi.yaml`, `mcp/src/tools.ts` (+ `mcp/dist` rebuild) — Codex-2 contract.
- `web/lib/evaluations/aggregation/pairwise-aggregate.ts`, `web/lib/evaluations/dispatcher/*` (provisioning), `web/lib/evaluations/membership.ts` — Codex-4 frozen participants.
- `web/app/api/projects/[slug]/evaluations/studies/[studyId]/participants/**` — Codex-4 mutation gate.
- `web/lib/evaluations/launch-seam.ts`, `web/lib/services/runs.ts` (`launchRun`/`LaunchRunContext`) — Codex-1 Option A; OR `web/lib/evaluations/readiness*`/`standardization.ts` — Codex-1 Option B.
- `docs/system-analytics/evaluations.md`, `docs/api/web.openapi.yaml` — reconcile (the web OpenAPI still says pairwise execution is refused — Codex noted this stale text).

## Risks & Considerations
- **Codex-2 blinding:** the pair mapping MUST use the existing blinding so no real participant id leaks; blinding must be deterministic per attempt so evidence scoping matches.
- **Codex-4 snapshot source:** confirm the evidence snapshot actually persists the participant set (`participantWatermarks`); if not, freeze participant ids on the execution row instead. Provisioning and aggregation MUST use the SAME frozen source or they desync.
- **Codex-1 Option A blast radius:** `launchRun` is the shared launch choke point (board/scratch/agent/flow all use it) — threading recipe axes must not change non-evaluation launches. Re-seed the launch test suite to preflight-passing recipes (the integration tests currently use fake digests).
- **Contract sweep:** any judge-context change fans into ext OpenAPI + MCP tool schema + `tool-contract.test.ts` + `mcp/dist` rebuild.
- **Reconcile stale docs:** `docs/api/web.openapi.yaml` pairwise-refused text is now false (pairwise executes) — fix in the same pass.

## Test Coverage
- Codex-2: pairwise judge context returns a blinded `match` mapping; a randomized ordering where `match_a` ≠ Candidate A records the correct winner; >2-participant execution routes each attempt to the right pair.
- Codex-4: add/remove a participant DURING capture and DURING judging — standings ignore the mutation; an execution with a removed participant does NOT reach `completed` with a missing match; provisioning and aggregation agree on the frozen set.
- Codex-1 (A): each recipe axis varied independently asserts the run's actual revision/inputs/package/capabilities/runners. Codex-1 (B): a study with an axis-mismatched run is refused at standardize/promote; the low-fidelity flag renders.
- All: `validate:contracts` + `validate:docs` + web `typecheck` + focused Vitest (integration, Testcontainers) + `mcp` contract suites.

## Decision (Codex-1) — RESOLVED 2026-07-26: **C · partial thread**
Thread the pinned flow-revision + form inputs (variants run the right revision/inputs — subsumes M4); guard/defer capability-overlay + package-pins (un-standardizable + preflight warn + documented co-evolve). See the Codex-1 steps above.
- Rejected **A** (full thread) — too large now, reverses "trio minimal", highest regression risk.
- Rejected **B** (guarded-defer only) — leaves the comparison itself invalid (just un-promotable); the core value (a variant runs its frozen revision) would stay broken.
