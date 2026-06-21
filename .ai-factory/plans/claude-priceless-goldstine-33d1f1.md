# Implementation Plan: Shared-worktree review/promote ownership model

Branch: claude/priceless-goldstine-33d1f1 (existing worktree branch — NOT created by this plan)
Created: 2026-06-21

> Follow-up to M37 (orchestrator engine, ADR-098/099/100). Re-enables
> `workspace_mode: shared` for writable worktrees by specifying the tree-level
> review/promote ownership model. Origin: Codex adversarial-review Finding 2;
> design request `docs/plans/2026-06-21-shared-worktree-review-model-design.md`;
> chip `task_475bec6f`.

## Settings
- Testing: yes (TDD — every dev task is test-first: red → green)
- Logging: verbose (structured `log.debug/info` on the new settled-gate, the
  tree-workspace resolution, and the tree-settle fan-out)
- Docs: yes (mandatory docs checkpoint — SDD: the spec is a Phase-0 INPUT, not a
  trailing sync)
- Methodology: **SDD** for the spec/system-analytics phase (Phase 0 front-loads a
  complete, internally-consistent spec), **TDD** for the development phases.

## Roadmap Linkage
Milestone: "M37 — Orchestrator engine (shared-worktree review/promote, ADR-099/100 Phase-2 → Implemented)"
Rationale: This flips the one remaining gated piece of the M37 swarm Layer-2 (shared writable worktrees) from `CONFIG`-refused to Implemented.

## Owner decisions (resolved 2026-06-21 — the design doc's first job)

The four under-specified axes were surfaced and resolved by the owner. The chosen
options form one coherent, **migration-free** design:

1. **Review granularity = per-tree.** A shared tree is ONE branch = ONE diff →
   one Review, one promote. Per-child review of the same cumulative diff is wrong.
2. **Ownership = allocator row + orchestrator-driven tree promote.** Keep the
   allocator child's EXISTING `workspaces` row (`worktree_path` UNIQUE) as the
   tree handle; the orchestrator drives one tree-level promote (it alone holds
   `runs:promote`). Promote resolves the workspace by
   `(root_run_id, workspace_mode='shared')`. **No schema change, no migration.**
3. **Ordering = wake + promote-time guard (defense in depth).** Keep
   `orchestrator_resume`'s existing "wait for the last non-settled sibling" wake
   AND add a promote-time settled re-check under lock: refuse while any shared
   sibling is in a writable status. Reuses `SETTLED_RUN_STATUSES` +the
   `sharedWriterSiblingActive` shape.
4. **Promotable handle = uniform Review + idempotent tree-promote.** Every shared
   writable child finalizes to `Review` (fix `finalizeAgentRun` to key on
   `workspace_mode='shared' && agent_workspace='worktree'`, NOT `hasWorkspace`).
   `run_promote` on ANY shared child resolves the tree workspace by `root_run_id`,
   merges once, and flips ALL shared children `Review → Done` in one transaction —
   so the 2nd..Nth promote find nothing in `Review` and refuse. Exactly-once falls
   out of the cross-tree `Review → Done` CAS.

## Grounding facts (verified against code 2026-06-21)

- Gate to remove: `web/lib/agents/launch.ts:579-584` — `if (workspaceMode === "shared" && workspace === "worktree") throw CONFIG`. The `&& !rootRunId` gate at `:563-568` STAYS (a top-level run cannot share a tree).
- Review-vs-Done signal: `finalStatusForCleanAgentExit(hasWorkspace)` (`launch.ts:1169-1171`) → a reuser child (no `workspaces` row) lands `Done`. This is the bug.
- The dormant shared-allocation block (`isShared`, `sharedAgentWorktreePath`, `reuseSharedTree`, TOCTOU re-check → `CONFLICT`) at `launch.ts:660-737` already allocates correctly — it just sits behind the gate. Keep it.
- Serialized-writer guard `sharedWriterSiblingActive` (`web/lib/scheduler.ts:121-144`) is wired into BOTH `tryStartRun` (:249-252) and `promoteNextPending` (:463-471). **Keep it unchanged** — it prevents concurrent-writer corruption.
- Promote resolves the workspace BY `workspaces.runId` (`promote.ts:140-145` `loadWorkspaceForUpdate`; `:448` in the claim tx). A reuser child has no row → unpromotable today; the allocator's promote merges the whole branch. The tree-promote must resolve by `root_run_id` instead.
- `promoteChildRunForToken` (`promote.ts:1367`) already forces `local_merge` + `autoOnReady` (waives the reviewed-SHA/drift check; readiness re-gate still runs for `flow` runs — agent runs skip it). The ext route `web/app/api/v1/ext/runs/promote/route.ts` scopes `childRunId` to the bound orchestrator (`parentRunId`, server-derived) + `projectId` + `status='Review'`.
- A delegated child reaching `Review` already keeps `acp_session_id` (`preserveSessionForRework`, `launch.ts:1215`) and emits `run.review` — both fire for shared children (they have `parentRunId`).
- `SETTLED_RUN_STATUSES` (`web/lib/runs/run-status-sets.ts`) = terminal + `Review`; `orchestrator_resume` already waits for "no non-settled sibling" before a success-side wake.
- L3 dirty-watchdog already skips shared write children (`launch.ts:1273-1277`).
- **Workspace-by-runId fan-out (verified):** the review surfaces `web/lib/review-comments/run-diff-source.ts:74` AND the run-diff route `web/app/api/runs/[runId]/diff/route.ts` (workspace lookup ~line 237, throws `PRECONDITION "workspace not found"`) resolve the workspace by `run.id` → a reuser shared child would render an empty diff. Both need tree-resolution (T12). The `innerJoin` portfolio/board/activity read-models that EXCLUDE no-workspace runs are scoped OUT (non-goal — see below).
- **Promote finalize is single-child (verified):** `promoteRun`'s finalize tx (`promote.ts:681-795`) flips ONLY `runs WHERE id=runId` → Done and emits the `run.done` domain event for that single `runId` (`:760-774`) — it does NOT route through `finalizeAgentRun`. The tree-settle (T10) must generalize the flip to all shared children AND loop the `run.done` emit. Exactly-once is enforced by BOTH the M18 durable-claim CAS on the shared workspace (`:684-704`, concurrent promotes → `CONFLICT`) and the `loadRun` `status==='Review'` check (`:451`, sequential re-promote → `PRECONDITION`).
- **GC keys on the allocator run only (gap → T16):** `web/lib/gc/workspace-gc.ts:126-159` selects a workspace when its owning (allocator) run is `Abandoned|Done` past deadline; it never checks reuser siblings. The cascade abandons the whole tree together (safe), but an INDEPENDENT allocator terminal (`finalizeAgentRun` Abandoned branch `launch.ts:1244-1252`, or `promote.ts:707`) sets `scheduledRemovalAt` on the tree workspace while siblings may still write → GC would corrupt the live shared worktree. T16 makes GC tree-aware.
- **Verified — no change needed:** (1) the shared-tree resume/rework cwd is already handled — `startAgentSession` recomputes `sharedAgentWorktreePath` from `workspace_mode+root_run_id` (`launch.ts:1894`), so `run_rework` works free; (2) `reconcile.ts` is status-only (never removes worktrees — GC is the sole remover, so only T16 matters); (3) the launch dedup/error teardown already guards `!reuseSharedTree` (`launch.ts:832,845`) — no double-remove of a sibling-owned tree.

## Numbering (skill-context rule: reserve up front)
- **ADR:** next free = **ADR-101** (max at HEAD is ADR-100). This plan writes `### ADR-101`. ADR-099/100 are NOT renumbered (immutable) — ADR-101 supersedes ADR-099 §4's gating note and extends ADR-100 with the tree variant.
- **Migration:** **none.** The design reuses existing columns (`runs.root_run_id`, `runs.workspace_mode`, `runs.agent_workspace`, `runs.parent_run_id`) and the allocator's `workspaces` row (incl. M18 `promotion_attempt_id`). Migration `0061` is NOT consumed by this plan — a sibling branch may take it.

## Contract surfaces → spec files (skill-context rule: trace each)
| Surface that changes | Spec file |
| --- | --- |
| The tree-review/promote decision (4 resolved axes) | `docs/decisions.md` → **ADR-101** (new) |
| Shared-tree lifecycle, Expectations, edge-case flips | `docs/system-analytics/orchestrator.md` |
| `POST /api/v1/ext/runs/promote` tree-promote semantics + 409 settled-gate | `docs/api/external/operations.openapi.yaml` |
| New promote refusal call-sites (settled-gate, wrong-handle, conflict) | `docs/error-taxonomy.md` (reuse `PRECONDITION`/`CONFLICT`; **no new code**, ADR-008) |
| New DB column/table/index | **none** — no `db/*.md` / `database-schema.md` change |
| New env var / Flow DSL type | **none** — `workspace_mode: shared` already in `configuration.md`/`flow-dsl.md`; T5 only flips any "gated/Phase-2" note |

## Explicit non-goals (surgical scope)
- The `innerJoin workspaces` portfolio/board/activity/inbox read-models are NOT touched — reuser shared children remaining absent from those worktree-bearing rows is accepted; the tree is surfaced via the allocator child + the orchestrator. (Open question Q1 below confirms.)
- The serialized-writer guard, the `own`-mode path, `repo_read`, and ADR-041/043 enforcement boundaries are untouched.
- No new `MaisterError` code (ADR-008 closed union).

## Commit Plan
- **Commit 1** (Phase 0, T1–T5): `docs(orchestrator): ADR-101 shared-tree review/promote model + spec front-load`
- **Commit 2** (Phase 1, T6–T8): `feat(orchestrator): re-enable shared writable worktree + uniform-Review finalize + tree-workspace resolve`
- **Commit 3** (Phase 2, T9–T13 + T16): `feat(orchestrator): shared-tree settled-gate + idempotent tree-promote + reviewable diff + GC tree-awareness + auto-promote wait`
- **Commit 4** (Phase 3, T14–T15): `test+docs(orchestrator): shared-tree suite green + ADR-099/100 Implemented flip`

## Tasks

### Phase 0 — SDD: front-load the complete, internally-consistent spec (docs only, no code)
Exit criteria: ADR-101 header exists; the spec describes the FULL model as the single source of truth for the code phases; `pnpm validate:docs` + `npx @redocly/cli lint docs/api/external/operations.openapi.yaml` + the ADR-anchor check (`scripts/validate-docs-adr-anchors.mjs`) green on the docs diff.

- [x] **T1: Author ADR-101 in `docs/decisions.md`.** Write `### ADR-101: Shared-worktree tree-level review/promote ownership` recording the 4 resolved decisions (per-tree review; allocator-owned workspace + orchestrator tree-promote; wake + promote-time settled-gate; uniform-Review + idempotent tree-promote). State explicitly: NO new `MaisterError` code (reuse `CONFLICT`/`PRECONDITION`), NO migration. Note it supersedes ADR-099 §4's "GATED/Phase-2" decision and extends ADR-100's promote/rework with the shared-tree variant. Status: Accepted.
- [x] **T2: Rewrite the shared-mode sections of `docs/system-analytics/orchestrator.md`.** Add a process flow **(f) shared-tree review/promote** (uniform child→Review, settled-gate, one tree-promote settling all siblings); add Expectations bullets (allocator owns the tree `workspaces` row; every shared writable child finalizes `Review`; tree-promote gated on all shared siblings ∈ `SETTLED_RUN_STATUSES`; tree-promote merges once + flips all shared children `Review→Done` in one tx, exactly-once; serialized-writer guard retained; reuser diff resolves the tree workspace); update the "Source (Implemented)" list. Tag new pieces per docs R6 — the literal "Implemented" status flip of the edge-case bullets happens in T15 (as-built), but the design prose is complete here.
- [x] **T3: Extend `docs/error-taxonomy.md`.** Under `PRECONDITION`: add the shared-tree promote refusals — settled-gate not met (a shared sibling still writable), promote target is not a shared child / has no resolvable tree workspace, nothing in `Review` (already promoted). Under `CONFLICT`: the shared-tree `local_merge` conflict (tree stays `Review`). Restate the ADR-008 "no new code" note for this change.
- [x] **T4: Update `docs/api/external/operations.openapi.yaml`.** On `POST /api/v1/ext/runs/promote`, document that for a `workspace_mode='shared'` child the operation is a TREE promote: it resolves the tree workspace by `root_run_id`, merges once, and settles ALL shared siblings `Review→Done`; add the 409 responses (settled-gate `PRECONDITION`, merge `CONFLICT`). `childRunId` stays the body field but `root_run_id`/`parent_run_id` are server-derived (note the trust labels: `childRunId` = body-controlled, validated against the bound-run scope; `rootRunId` = server-state). Redocly-lint clean.
- [x] **T5: Grep-to-zero docs consistency sweep.** Search the whole `docs/` tree for stale "shared … Phase 2 / gated / unspecified / fail-closed" notes (`docs/configuration.md`, `docs/flow-dsl.md`, `docs/decisions.md` ADR-099 §4, `docs/db/*.md`, `error-taxonomy.md`) and reconcile each to the new model (or confirm none). Deliverable: a zero-hit grep for the old gating language outside historical ADR context. (Memory lesson M37: detection ≥ edit-set over the whole tree.)

### Phase 1 — TDD core: re-enable + uniform-Review finalize + tree-workspace resolve
Integration tests: `DOCKER_HOST=unix:///Users/developer/.docker/run/docker.sock pnpm exec vitest run --project integration <path>` (Bash `dangerouslyDisableSandbox: true`). Confirm each new test file is matched by the integration runner glob (`vitest list`).

- [x] **T6: Remove the writable-shared launch gate + restore the two former allocation tests.** TDD: first restore (from git `140d34d5^`) the two integration tests in `web/lib/agents/__tests__/launch-worktree-modes.integration.test.ts` — *"two shared-mode children of one root resolve to the SAME tree (2nd reuses, no duplicate workspaces row)"* and *"(C4) two CONCURRENT shared-mode allocations converge to one tree (no raw 500)"* — and DELETE the gate-refuse test. They go red (gate throws `CONFIG`). Then delete `launch.ts:579-584` (the writable-shared gate). Keep the `:563-568` no-`rootRunId` gate + the own-mode + repo_read tests. Green. LOGGING: `log.info` on allocator-vs-reuser decision in the shared block.
- [x] **T7: `finalizeAgentRun` — shared writable child → `Review` regardless of `hasWorkspace`.** TDD: write an integration test asserting BOTH the allocator AND a reuser shared child finalize to `Review` (not `Done`), emit `run.review` (carries `parent_run_id`), and keep `acp_session_id`. Red. Implement: change `finalStatusForCleanAgentExit` (or its call site in `finalizeAgentRun`) to return `Review` when `row.workspaceMode === 'shared' && row.agentWorkspace === 'worktree'`, else keep the `hasWorkspace` rule. Read `workspaceMode` in the finalize `returning(...)`. Confirm (no change needed) the dirty-watchdog L3 still skips shared (`launch.ts:1273-1277`) and `run.review` emit stays gated on a delegated child. Green. LOGGING: `log.debug` of the `{workspaceMode, agentWorkspace, hasWorkspace, status}` decision.
- [x] **T8: Promote core — resolve the shared tree workspace by `root_run_id`.** TDD: integration test that a tree-promote invoked on a REUSER shared child (no `workspaces` row of its own) resolves the allocator's row via `(root_run_id, workspace_mode='shared')`. Red (today `loadWorkspaceForUpdate` throws `PRECONDITION` "workspace not found"). Implement `resolveSharedTreeWorkspaceForUpdate(tx, run)` used by the claim tx when `run.workspaceMode === 'shared'`; `own`/scratch unchanged. Green. LOGGING: `log.debug` of the resolved `{rootRunId, workspaceId, worktreePath}`.

### Phase 2 — TDD tree-promote semantics: ordering + exactly-once + conflict + reviewability
- [x] **T9: Promote core — promote-time settled-gate.** TDD: integration test that a tree-promote is refused `PRECONDITION` while ANY shared sibling of the tree is in a writable status (`Running|NeedsInput|NeedsInputIdle|HumanWorking|Pending|WaitingOnChildren`); succeeds when all shared siblings ∈ `SETTLED_RUN_STATUSES`. Red. Implement an allow-list re-check inside the claim tx (under the workspace row lock): count shared siblings of `root_run_id` NOT in `SETTLED_RUN_STATUSES`; if > 0 → `PRECONDITION`. Reuse the `sharedWriterSiblingActive` shape. Green. LOGGING: `log.info` of `{rootRunId, blockingSiblingCount}` on refusal.
- [x] **T10: Promote core — idempotent tree-settle (exactly-once).** TDD: integration test that one tree-promote (a) merges once, (b) flips ALL shared children of `root_run_id` in `Review` → `Done` in ONE transaction, (c) emits `run.done` (with `parent_run_id`) **per** settled child, (d) a SECOND **sequential** promote on a different shared child finds its run no longer `Review` → `PRECONDITION` no-op, and (e) two **CONCURRENT** promotes on two different shared children → one wins, the other `CONFLICT`. Red. Implement in `promoteRun`'s **finalize tx** (`promote.ts:681-795`): it currently flips only `runs WHERE id=runId` → Done (`:713-721`) and emits the `run.done` domain event for that single `runId` (`:760-774`) — generalize BOTH to the tree set: flip all shared children `(root_run_id, status='Review')` → Done (CAS), and LOOP the `run.done` emit over every flipped child. Keep `promotionState='done'`/`scheduledRemovalAt` on the single allocator workspace row. Exactly-once = the M18 claim CAS (concurrent) + the `loadRun` `status==='Review'` check (sequential). Crash window: merge committed, finalize not → re-promote (`git merge` up-to-date/idempotent, finalize then flips). Green. LOGGING: `log.info` `{rootRunId, settledChildIds, commit}`.
- [x] **T11: Promote core — tree merge conflict.** TDD: integration test that a `local_merge` conflict on the shared branch → `CONFLICT` (409), ALL shared children STAY `Review`, no sibling is flipped, no partial settle. Red. Implement: ensure the conflict path (reusing `createMergeConflictAssignment` / the abort) runs BEFORE the tree-settle flip, so a conflict leaves the whole tree in `Review`. Green. LOGGING: `log.warn` `{rootRunId, targetBranch, failingCommand}`.
- [x] **T12: Reviewable surfaces — tree-resolve the diff for a shared child.** TDD: test that a reuser shared child's gate-diff source AND the run-diff route resolve the shared TREE workspace (by `root_run_id`) — opening any shared child shows the one shared diff, never an empty diff. Both resolve by `run.id` today and throw `PRECONDITION "workspace not found"` for a reuser child. Red. Implement the T8 tree-resolution helper at BOTH read sites for a shared `run_kind=agent` child only (`own`/scratch unchanged): `web/app/api/runs/[runId]/diff/route.ts` (workspace lookup ~line 237) and `web/lib/review-comments/run-diff-source.ts:74`. Green. (Portfolio/board innerJoin read-models stay out of scope.) LOGGING: `log.debug` of the resolved tree workspace at each diff site.
- [x] **T13: `auto_launch_run_plan` — benign settled-gate wait for shared children.** TDD: test that an EARLY `run.review` for a shared child whose sibling is still writable makes the auto-promoter SKIP (log, no throw), and the LAST sibling's `run.review` drives the single tree-promote that settles the tree. Red. Implement: treat the settled-gate `PRECONDITION` from `promoteChildRunForToken` as a benign "not yet — wait for the last sibling" skip in `web/lib/domain-events/auto-launch.ts` (same shape as its existing merge-conflict log). Green. **Also** add a rework-on-shared regression (resume cwd is already handled — `launch.ts:1894` `sharedAgentWorktreePath` from `workspace_mode+root_run_id`): `run_rework` on one shared child flips `Review→Running`, the child re-enters the serialized writer queue, and the settled-gate (T9) blocks the tree-promote until it re-settles. LOGGING: `log.info` `{childRunId, rootRunId, reason:"shared-tree not settled"}` on the skip.
- [x] **T16: GC tree-awareness for the shared worktree.** TDD: GC integration test — an `Abandoned` allocator whose shared sibling (same `root_run_id`) is still non-terminal must NOT be collected; once ALL shared siblings are terminal, it IS collected. Red. Cause: `web/lib/gc/workspace-gc.ts:126-159` (`loadCandidates`) selects the tree workspace on the allocator run alone, ignoring reuser siblings (no workspace row); an INDEPENDENT allocator terminal (`launch.ts:1244-1252` / `promote.ts:707`) sets `scheduledRemovalAt` while siblings may still write → GC would remove the live shared worktree. Implement: add a tree-awareness guard — exclude a workspace whose owning run has `workspace_mode='shared'` while EXISTS a shared sibling (same `root_run_id`) NOT in the terminal set (`Done|Failed|Crashed|Abandoned`). Keep preserve-then-prune + idempotent re-run. Green. LOGGING: `log.debug` `{workspaceId, rootRunId, blockingSiblingCount}` on skip.

### Phase 3 — verify + docs-as-built + gates
- [x] **T14: Full suite green.** Run `pnpm --filter maister-web typecheck` + `pnpm --filter maister-web test:unit`, then the integration tests (worktree-modes + promote-shared-tree + the GC tree-awareness test) via testcontainers (`DOCKER_HOST=…`). Confirm every new test file is matched by the integration runner glob (`vitest list`). Any pre-existing red is quarantined with a reason, not silently tolerated.
- [x] **T15: Docs-as-built flip + final gates.** Flip the literal status tags: `docs/decisions.md` ADR-099 §4 + `docs/system-analytics/orchestrator.md` edge cases — "`workspace_mode: shared` with a writable worktree → CONFIG (gated, Phase 2)" → "Implemented (tree-level review/promote, ADR-101)". Re-run `pnpm validate:docs`, `npx @redocly/cli lint docs/api/external/operations.openapi.yaml`, the ADR-anchor check, and `eslint` scoped to the changed `.ts` files. Confirm the design request doc's acceptance criteria are all met.

## Acceptance criteria (from the design request)
- Every writable shared-worktree child's contribution is reviewable (its diff resolves the shared tree) and promotable exactly once (one tree-promote settles all shared children `Review→Done`; 2nd..Nth refuse) — no sibling-merge surprise (settled-gate), no stranded diffs (uniform-Review + tree-settle), concurrent-writer corruption still prevented (serialized-writer guard untouched), and the shared worktree is never GC-removed while a sibling is still non-terminal (T16).
- Launch re-enabled (writable-shared `CONFIG` gate removed); the two former shared-allocation integration tests restored (replacing the gate-refuse test); review/promote-model tests added.
- ADR-099 + `orchestrator.md` flipped from gated/Phase-2 back to Implemented (under ADR-101).

## Unresolved questions (concise — owner)
1. **Видимость reuser-детей.** OK что reuser shared-дети НЕ показываются в portfolio/board/activity rail (innerJoin по workspace их отсекает)? Дерево видно через allocator + оркестратор. Если нужны в rail — отдельная задача (вне scope).
2. **shared + as-plan.** `workspace_mode: shared` бывает только as-run/manual, или и as-plan (`launch_mode='auto'`)? T13 покрывает оба; если только manual — T13 упрощается.
3. **ADR-101 vs правка ADR-099.** Беру новый ADR-101 (правило immutable: ADR не переписывают, supersede). Подтверди — vs дописать прямо в ADR-099 §4.
