# Implementation Plan: Run continuation controls (handoff round-trip + soft node interrupt)

Branch: `claude/flow-runs-continuation-controls-527f4c` (worktree; NO new branch created)
Created: 2026-08-31

## Settings

- Testing: yes — unit + integration + e2e; every promised test names its vitest project
- Logging: verbose (pino DEBUG on every CAS outcome, fence decision, git command, re-entry resolution step, option-matrix derivation)
- Docs: yes — mandatory documentation checkpoint at completion, routed through `/aif-docs`

## Roadmap Linkage

Milestone: `"none"`
Rationale: the only unchecked milestone in `.ai-factory/ROADMAP.md` is M45 (core-package process
qualification on private projects); this is new human↔agent loop surface, not M45 scope. Add a
milestone entry only if the owner wants it sequenced.

---

## Reserved numbers (allocated up front — skill-context rule)

| Artifact | Number | Source of truth |
| --- | --- | --- |
| Feature A ADR | **ADR-159** | `git show main:docs/decisions.md` → `max(### ADR-NNN) = 158` (verified) |
| Feature B ADR | **ADR-160** | same allocation pass |
| Drizzle migration | **`0125`** — `domain_events_kind_check` extension **only** | `git show main:web/lib/db/migrations/meta/_journal.json` → `max(idx) = 124` (verified) |

**Exactly one migration is required, and only because of the owner's decision to emit domain
events for the claim/return (Task 11A).** Verified at HEAD:

- `domain_events.kind` **HAS a DB CHECK** (`domain_events_kind_check`), currently listing 11 kinds
  (last rewritten by `0099_agent_human_ask.sql`). `web/lib/domain-events/taxonomy.ts` states the
  extension rule in its own header comment: *"one entry here + emit site(s) in the owning domain
  transaction + one doc row + a CHECK update via migration."* Adding `run.rework_claimed` /
  `run.rework_returned` therefore needs `0125` (DROP + ADD CONSTRAINT, the exact shape `0099` used).
  It touches no data and no column — nothing to back-fill, nothing to refuse loudly.

Everything else is migration-free — verified, not assumed:

- `hitl_requests.kind` is `"kind" text NOT NULL` in `0000_clumsy_nightshade.sql` with **no CHECK** —
  the enum lives only in the Drizzle `text(..., { enum: [...] })` TS type. Adding `node_interrupt`
  is a TS change.
- `assignments.action_kind` is `"action_kind" text NOT NULL` in `0018_m13_assignment_actors.sql`,
  **no CHECK** — same.
- `node_attempts.decision` is already a nullable plain `text` column and is **unwritten on takeover
  claim rows** (`claimTakeover` and `recordTakeoverReturn` never set it) — so it is free to carry
  the claim/restart provenance markers (`review_rework_claim`, `operator_interrupt`).
- `node_attempts` stays append-only; no status-enum value is added (locked).
- Feature B's interrupt reuses the **existing** `run.escalated` kind with `reason: "node_interrupt"`
  — no taxonomy entry, no CHECK change.

A migration is a **TRIPLE**: the SQL file + the `_journal.json` entry + `meta/0125_snapshot.json`.
Task 11B asserts the newest journal entry has a matching snapshot (a missing snapshot silently
starves future `db:generate`). If implementation discovers a *second* migration is needed, re-read
`max(idx)` at main's HEAD **at that moment** and fold it back into this table in the same pass.

**Renumber pass** — Task 30 is a dedicated renumber deliverable, run AFTER rebasing onto main.

---

## Verified anchors (read before touching code)

Every claim below was read at HEAD in this worktree. They are the load-bearing facts; a task that
contradicts one is wrong.

| # | Fact | Location |
| --- | --- | --- |
| A1 | On reaching `Review`, `runGraph` writes `currentStepId: null`. **The re-entry anchor for a `Review` run must be ledger-derived, never `runs.current_step_id`.** | `web/lib/flows/graph/runner-graph.ts` (Review terminal write) |
| A2 | `countLiveRuns` / cap predicate = `status IN ('Running','NeedsInput','HumanWorking')`. **`Review` is slot-free; `Review → HumanWorking` ACQUIRES a slot.** | `web/lib/scheduler.ts:158,188` |
| A3 | `SETTLED_RUN_STATUSES = TERMINAL + 'Review'`. A `Review` child flipping to `HumanWorking` **un-settles** an orchestrator parent that may already have completed. | `web/lib/runs/run-status-sets.ts` |
| A4 | ADR-141 sync solves A2+A3 by an eligibility allow-list: `status='Review'`, `run_kind ∈ {flow,agent}`, `parent_run_id IS NULL`, `workspace_mode <> 'shared'`, not a launched evaluation lineage, `workspace.removed_at IS NULL`; **cap-full → typed `CONFLICT`, never queued**. | `web/lib/runs/sync-target.ts` `assertSyncEligible` |
| A5 | The workspace lifecycle claim is **lease-based**: `promotionClaimTimeoutSeconds()` default **300 s** + a heartbeat at ¼ window. **A human-paced claim CANNOT hold `lifecycle_operation_name`.** | `web/lib/workbench-lifecycle/service.ts:2180+`, `web/lib/instance-config.ts:118` |
| A6 | `deriveWorkbenchLifecycleActions` returns `disabledActions("human-owned")` for **every** action when `runStatus === 'HumanWorking'`. `snapshotCommit`, `handoffBranch`, and `getWorkbenchHandoffMetadata` all gate on `requireActionAllowed(ctx, "exportBranch")`. | `web/lib/workbench-lifecycle/policy.ts`, `service.ts:393,1020,1101,955` |
| A7 | `promoteRun` refuses unless `status === 'Review'`; `assertSyncEligible` refuses unless `status === 'Review'`. **`HumanWorking` is therefore already fenced against promote and sync** — no new fence code is required for those two. | `web/lib/runs/promote.ts:612`, `sync-target.ts:169` |
| A8 | `hasPendingTakeoverResume(runId, reentryNodeId)` is **agnostic to the takeover row's own node** and probes freshness with `isNull(node_attempts.owner_user_id)`. A Review-claim row therefore drives the existing `isTakeoverResume` path unchanged. | `web/lib/flows/graph/ledger.ts:615` |
| A9 | `markDownstreamStale` iterates **`latestAttemptByNode`** and stales gates attached to that latest attempt only. A claim row appended at a node makes that node's *prior* gates unreachable to the staler. **This is the GENERAL case, not an edge case** — the claim anchor (the last executed node) is by construction downstream of any re-entry, so its `passed` gates are shielded on every claim. See D10. | `web/lib/flows/graph/ledger.ts:698`, `latestAttemptByNode:680` |
| A10 | `rollupCorrectionMetrics` counts `attempt.status === 'Reworked'` **and** `max(attempt) - 1` per `(run,node)`. `ObservatoryNodeAttemptInput` has **no `decision` field**. Operator restarts would inflate BOTH counters. | `web/lib/queries/observatory-core.ts:20-29,215-255` |
| A11 | The `rework.maxLoops` bound fires only when `!reusesCurrentAttempt`, comparing `effectiveAttempts(nodeAttemptCount, reworkBaseline) > maxLoops`. | `web/lib/flows/graph/runner-graph.ts` (~2718-2740) |
| A12 | `escalateHookTrip` is the canonical soft-halt: checkpoint pre-tx (`EXECUTOR_UNAVAILABLE` **re-throws**, no mutation), `needs-input.json` pre-tx (unlinked on tx failure), then ONE tx = CAS `Running→NeedsInput` + `markNodeNeedsInput` + HITL insert + assignment + `run.needs_input` webhook + `run.escalated` domain event. | `web/lib/runs/hook-trip.ts` |
| A13 | `respondToHitl` is the single chokepoint; human-actor-only kinds are rejected there **before any mutation** (`hitl.ts:5077-5099`), then dispatched per-kind (`hitl.ts:5151-5180`). | `web/lib/services/hitl.ts` |
| A14 | `MAISTER_ENGINE_VERSION = "3.4.0"`; per-feature floors are declared as `const X_ENGINE_MIN` in `web/lib/config.ts` (498-552) and gated by a `declaresX(nodes)` predicate + `semverGte` throw. | `web/lib/flows/engine-version.ts:66`, `web/lib/config.ts` |
| A15 | The graph manifest schema is `.passthrough()` and flow-level keys (`verdict_calibration`, `defaults`, `presentation`, `requirements`) sit beside `nodes`. `compileManifest` returns `{ entry, order, nodes, sessions }`. | `web/lib/config.schema.ts:1265-1291`, `web/lib/flows/graph/compile.ts:494` |
| A16 | vitest projects: `unit` (`lib/**`, `app/**/__tests__/**`, `components/**`, excluding `*.integration.test.ts`) and `integration` (`lib/**/*.integration.test.ts`, `app/**/*.integration.test.ts`). Suite command: `pnpm --filter maister-web test` = `test:unit && test:integration`. | `web/vitest.workspace.ts`, `web/package.json:14-19` |
| A17 | **RESOLVED in Task 3A.** The drift was far wider than the two headings first observed: **39 sites** across 15 files cited `ADR-142` for the *workspace-lifecycle* domain, which `docs/decisions.md` actually numbers **ADR-148**. Root cause established from history, not guessed: `55b990414` (2026-07-16) landed the workspace ADR already as **148**; `e8e260780` (same day) wrote the `runs.md`/`hitl.md` headings against a pre-renumber copy citing **142**; `3e25f8c31` (2026-07-17, `chore(evaluations): renumber onto main — ADR-139..144→142..147`) then gave 142 to the Evaluation Study domain, turning a stale citation into a wrong one. All 39 re-pointed to ADR-148; historical `.ai-factory/plans/*` and `.ai-factory/patches/*` records deliberately left as written. | `docs/system-analytics/runs.md:3`, `hitl.md:3`, `acp-runners.md:3`, `scratch-runs.md:3`, `scheduler.md:3`, `reconciliation-gc.md:3,5,346`, `workspaces.md:611,637`, `workbench-lifecycle.md:9,11`, `docs/db/erd.md`×6, `docs/db/runs-domain.md`×4, `docs/screens/admin-scheduler.md:72`, `docs/api/web.openapi.yaml`×12, `docs/decisions.md:1849`, `.ai-factory/ROADMAP.md:554`, `web/lib/db/schema.ts:3686`, `web/lib/gc/context-mount-gc.ts:142,212` |
| A18 | `domain_events.kind` **HAS** a DB CHECK (`domain_events_kind_check`, 11 kinds, last rewritten by `0099`). `taxonomy.ts`'s own header states the 4-part extension rule: taxonomy entry + emit sites + doc row + CHECK migration. | `web/lib/db/migrations/0046_domain_events.sql:24`, `0099_agent_human_ask.sql`, `web/lib/domain-events/taxonomy.ts:1-4` |
| A19 | Agent runs carry **no `node_attempts` rows at all** — `stepId` is the constant `"agent"`. This is what structurally excludes `run_kind='agent'` from Feature A. | `web/lib/runs/hook-trip.ts` (`runKind === "flow" ? fetchActiveAttempt : null`) |

---

## Locked decisions (do not re-litigate during implementation)

**D1 — The Feature-A claim is a run status, not a lifecycle claim.** Per A5, the 300 s leased
`lifecycle_operation_*` slot cannot hold a human-paced claim. Mutual exclusion comes from
`runs.status = 'HumanWorking'`, which per A6/A7 **already** refuses promote, sync, archive, drop,
export, snapshot, and handoff. The only new fence code is the *hole* we deliberately poke for the
claim owner (Task 8).

**D2 — Reuse `HumanWorking`; distinguish provenance on the ledger row.** No new `runs.status`
(locked). The claim row is a takeover-shaped `node_attempts` row (`owner_user_id` set,
`ended_at` null) carrying `decision = 'review_rework_claim'`. Every existing `HumanWorking`
consumer is re-audited in Task 12 for the new provenance (no `human_review` node, no
`transitions.takeover`, `current_step_id` NULL at claim time).

**D3 — Feature-A eligibility copies ADR-141 sync's allow-list but NARROWS `run_kind` to `flow`**
(A4), plus `hasWorkspace && removed_at IS NULL` (the workspace-presence guard) and a **cap gate at
claim time**: slot-full → typed `CONFLICT`, never `Pending`. Queueing a human claim would be
meaningless (the scheduler cannot "start" a human). `parent_run_id IS NULL` is what keeps A3 from
biting.

*Why `agent` is excluded although sync admits it:* sync is a **branch** operation — it needs only a
worktree and a branch, which an agent run has. Feature A is a **graph re-entry** operation. Agent
runs carry **no `node_attempts` rows at all** (`hook-trip.ts`: *"flow runs carry node_attempts;
agent runs do not (stepId is the constant `agent`)"*), therefore no node to anchor the claim row on,
no re-entry node to resolve, nothing for `markDownstreamStale` to stale, and no `runGraph` traversal
to resume. Reusing a predicate across two different concerns without re-deriving each term is the
exact failure the project's own rules name; the refusal is explicit and early (Task 9), not an
accidental fall-through to "no re-entry declared".

**D4 — Ingest is fast-forward-only, no merge, no AI resolve.** `git fetch <remote>` (no refspec,
matching ADR-141) then `git merge --ff-only <remote>/<branch>`. Divergence / non-FF → typed
`PRECONDITION` carrying the failing command, both SHAs, and copyable git instructions. The escape
hatch is the export/push → resolve elsewhere → push back loop. Routing conflicts through the
ADR-141 resolver is a **recorded future enhancement**, not v1.

**D5 — Re-entry resolution chain (ordered, server-state only, never body-controlled):**
1. flow-level manifest `reentry: <nodeId>` (compile-validated against `graph.nodes`);
2. else the **last executed `human` node in the ledger** whose compiled `transitions.takeover`
   resolves to a known node → that target;
3. else **the action is disabled** with a reason pointing the operator at "launch a new run from
   this branch" (existing `baseBranch` relaunch).
   Step 2 is ledger-derived because of A1. No operator-selected re-entry (out of scope).

**D6 — Feature-B correction comments are a server-side prompt APPEND**, mirroring the P7 run-context
pointer line (`runner-graph.ts` ~1538-1545), **not** `commentsVar`. This works on any node type and
needs no ADR-138 renderer validation. The appended block is fenced and labelled so it is
distinguishable in `resolved_prompt`.

**D7 — Operator restarts never burn `rework.maxLoops`.** Attempts whose closing row carries
`decision = 'operator_interrupt'` are excluded from the effective-attempt count (A11), and a
separate global `MAISTER_MAX_OPERATOR_RESTARTS` safety cap bounds them per run.

**D8 — Feature-B is human-actor-only**, enforced at the `respondToHitl` chokepoint (A13) alongside
`hook_trip`. No ext-API / MCP surface for `node_interrupt` in v1 (mirrors `hook_trip`).

**D9 — Flow Studio may not silently drop `reentry`.** v1 does not add a Studio editor for the field,
but the authored draft→publish round-trip must **preserve** it. Task 5 verifies this with a
round-trip test rather than asserting it.

**D10 — `markDownstreamStale` ignores claim rows, unconditionally. No flag, no follow-up.**
A takeover/rework **claim row is a human-handoff marker, not a node execution**, so it must never
be what `latestAttemptByNode` returns when deciding which gates to stale. The fix is one predicate:
pick the latest attempt **with `owner_user_id IS NULL`** per node. Applied to the shared helper for
every caller — Feature A *and* M11b — rather than behind an opt-in flag.

Rationale for doing it shared rather than scoped:
- It is **not** an edge case for Feature A (A9): the claim anchor is the last executed node, which is
  downstream of any re-entry, so its `passed` gates are shielded on **every** claim. A flag would
  make correctness opt-in for the one caller that always needs it.
- The change moves staling in the **fail-closed** direction (strictly more evidence re-run), which is
  the safe direction for a readiness gate.
- Two behaviours for one invariant is how the next reader gets it wrong.

**M11b impact is a real possibility, not an assumption.** M11b's claim row lands on the
`human_review` node, which IS in `downstreamOf(reentry)`, so the same shielding applies there.
Whether it is currently *exploitable* depends on whether that node carries `passed` `gate_results` at
claim time — `human_review` gates are deferred to node finish (`gates-exec.ts:703-717`), so the
node-finish gate row (`runner-graph.ts:1021`) is the thing to check. **Task 11 resolves this by
experiment, not by argument**: write the failing test first for both callers; if M11b proves
unaffected, the shared fix is still correct and the M11b test documents why. Migrating any M11b
assertion this changes is **in-scope for Task 11**, not a follow-up.

**D11 — Claim and return emit domain events + webhooks (owner decision).** New taxonomy kinds
`run.rework_claimed` and `run.rework_returned`, emitted **inside the same transaction** as the
domain write (ADR-086 exactly-once), mirroring how `hook-trip.ts` emits `run.needs_input` +
`run.escalated`. This costs migration `0125` (the `domain_events_kind_check` CHECK is real — see
Reserved numbers). Feature B's interrupt reuses the existing `run.escalated` kind with
`reason: "node_interrupt"`, so it adds no taxonomy entry.

---

## Contract surfaces → spec files (skill-context rule; `/aif-verify` re-derives this from the diff)

| Surface changed | Spec file(s) that MUST move in the same phase |
| --- | --- |
| `POST /api/runs/{runId}/rework-claim/claim` (new) | `docs/api/web.openapi.yaml` + new domain doc |
| `POST /api/runs/{runId}/rework-claim/return` (new) | `docs/api/web.openapi.yaml` + new domain doc |
| `POST /api/runs/{runId}/node-interrupt` (new) | `docs/api/web.openapi.yaml` + `docs/system-analytics/hitl.md` |
| `POST /api/runs/{runId}/hitl/{id}/respond` — new `node_interrupt` kind + body fields (`workspacePolicy`, `targetNodeId`, `correction`) | `docs/api/web.openapi.yaml` + `docs/system-analytics/hitl.md` |
| Run-detail **read model** (`getRunDetail`, RSC — **not** an HTTP route; the spec's `GET /api/runs/{runId}` was amended) — new `continuation` block (claim state, re-entry, available options) | none — no OpenAPI surface; covered by `docs/system-analytics/run-continuation.md` |
| New HITL kind `node_interrupt` | `docs/system-analytics/hitl.md` "Three kinds" + kinds table + Expectations |
| New assignment `action_kind` `node_interrupt` | `docs/system-analytics/hitl.md`, `docs/db/runs-domain.md` |
| Flow DSL flow-level `reentry` | `docs/flow-dsl.md` + `web/lib/config.schema.ts` + **`web/lib/flows/flow-dsl-grammar.ts`** (in-code SSOT shipped as the `/flow-authoring` skill) + its drift-guard test |
| Engine version `3.4.0 → 3.5.0` + `REENTRY_ENGINE_MIN` | `docs/flow-dsl.md` engine-floor table + `docs/system-analytics/flow-graph.md` |
| Run state machine: `Review → HumanWorking`, `HumanWorking → Running` (new provenance), `Running → NeedsInput` (interrupt) | `docs/system-analytics/runs.md` state diagram + `docs/system-analytics/manual-takeover.md` |
| Lifecycle action availability during `HumanWorking` | `docs/system-analytics/workbench-lifecycle.md` |
| New env var `MAISTER_MAX_OPERATOR_RESTARTS` | `.env.example`, `compose.yml`, `compose.production.yml`, `deploy/maister.env.example`, `docs/configuration.md` env table |
| Error-taxonomy cells (no new codes) | `docs/error-taxonomy.md` |
| New domain-event kinds `run.rework_claimed` / `run.rework_returned` | `web/lib/domain-events/taxonomy.ts` + migration `0125` (CHECK) + `docs/system-analytics/domain-events.md` kind table + `docs/api/async/*.asyncapi.yaml` |
| New webhook event types for claim/return | `docs/system-analytics/domain-events.md` (webhook section) + `docs/api/async/*.asyncapi.yaml` |
| DB migration `0125` (CHECK only, no column) | `docs/database-schema.md` + `docs/db/*.md` if the ERD names the constraint |

**No new `MaisterError` code.** Reuse `PRECONDITION` (409), `CONFLICT` (409), `UNAUTHORIZED` (403),
`CONFIG` (400), `EXECUTOR_UNAVAILABLE` (503). Add cell entries only.

**Config-state symmetry** — N/A: `reentry` is compile-time only and is never persisted into a DB
column, so the SET/CLEAR/re-SET round-trip rule does not apply. Task 4 asserts this explicitly
(removing `reentry` from a republished manifest must change nothing but the compiled graph).

---

## Route identifier trust table (skill-context rule)

Every identifier consumed by a new route, labelled. **No route accepts a `body-controlled`
cross-resource locator.**

| Route | Identifier | Label |
| --- | --- | --- |
| `rework-claim/claim` | `runId` | `url-param` |
| | `userId` (owner) | `auth-context` (`requireActiveSession`) |
| | `projectId`, `worktreePath`, `branch`, re-entry node | `server-state` (`loadRunProjectId` → `loadRun` → `compileManifest` → ledger) |
| | body | **empty** (`{}` only) |
| `rework-claim/return` | `runId` | `url-param` |
| | owner identity | `auth-context`, compared against `node_attempts.owner_user_id` (`server-state`) |
| | `remote` | `body-controlled` → validated against `listRemotes()` **allow-list** (`server-state`); unknown → `PRECONDITION` |
| | `baseRef`, `branch`, `worktreePath`, `parentRepoPath`, re-entry node | `server-state` |
| `node-interrupt` | `runId` | `url-param` |
| | `nodeId`, `nodeAttemptId`, `supervisorSessionId` | `server-state` (active attempt + `run_sessions`) — **never** from the body |
| | body | **empty** (`{}` only) |
| `hitl/{id}/respond` (node_interrupt) | `optionId` | `body-controlled` → **allow-list** `{resume, restart_node, restart_from, stop}` |
| | `workspacePolicy` | `body-controlled` → allow-list `{keep, rewind-to-node-checkpoint, fresh-attempt}` |
| | `targetNodeId` | `body-controlled` → allow-list = **ledger-derived** eligible set (nodes with ≥1 prior attempt in THIS run); anything else → `PRECONDITION` |
| | `correction` | `body-controlled` free text → length-capped, never interpolated as a template, appended verbatim inside a fence |

---

## Crash windows (multi-store transition rule — normative; a `(status, ledger)` pair absent here is a GAP)

| Window | Durable state | Recovery (exact predicate) |
| --- | --- | --- |
| **CA1** claim tx committed, response lost | `HumanWorking`, open claim row (`owner_user_id` set, `ended_at` null, `decision='review_rework_claim'`) | None needed — the claim IS the durable intent. UI re-reads it; a retry loses the CAS → `CONFLICT`. |
| **CA2** return: fetch/FF succeeded, ledger tx not started | `HumanWorking`, open claim row, worktree advanced | Idempotent: FF is a no-op on retry (already up to date); the operator re-clicks Return. |
| **CA3** return: ledger tx committed (return recorded + staled + `Running` + cursor parked), `runFlow` never dispatched | `Running`, `current_step_id = reentry`, `returned_diff` + `ended_at` set, re-entry gates `stale`, no post-claim re-entry attempt | **Existing `runTakeoverReturnRecoverySweep` covers this unchanged** — its predicate is exactly A8's `hasPendingTakeoverResume`. Task 11 adds a test proving a Review-claim return is reachable by it. |
| **CA4** return: partial ledger write | impossible — all writes (record + artifacts + stale + CAS `Running` + cursor) are ONE tx, copied from the M11b return | Tx rollback → `EXECUTOR_UNAVAILABLE` 503, run stays `HumanWorking`, retryable. |
| **CB1** interrupt: checkpoint delivered, tx not committed | `Running`, agent SIGTERMed, `needs-input.json` written | `needs-input.json` unlinked in the catch; the runner observes `session.exited.reason=checkpoint` → `STEP_CHECKPOINTED` → its OWN `markNodeNeedsInput` + park. Converges on the same parked state. **Test required.** |
| **CB2** interrupt: checkpoint returned `EXECUTOR_UNAVAILABLE` | no mutation | Re-throw (A12) → 503, run stays `Running`. No split-brain. |
| **CB3** restart: attempt closed `Reworked`, cursor parked, `runFlow` not dispatched | `NeedsInput`, latest attempt at node = `Reworked`, `current_step_id = target` | The HITL `already-delivered` self-heal branch re-drives `scheduleResume(runId)` (copied from `handleHookTripResponse`). |
| **CB4** restart: workspace policy applied (git), ledger tx not committed | worktree rewound, attempt still `NeedsInput` | Idempotent — re-deciding re-applies against the same `checkpoint_ref` (identical to the M30 rework X-ATOMIC ordering). |
| **CB5** interrupted run swept to `NeedsInputIdle`, then to `Abandoned` at 24 h | terminal | Normal `hook_trip` behaviour; Task 22 asserts the `node_interrupt` kind is included in both sweeper passes. |

---

## Consumer fanout checklist (run status / enum / route rule)

Every item is a **grep-and-fix** obligation, verified in Task 12 (Feature A) and Task 22 (Feature B).
Guards are written as **allow-lists**, never as `if (terminal) reject`.

| Consumer class | Feature A (`Review→HumanWorking` provenance) | Feature B (`node_interrupt` kind) |
| --- | --- | --- |
| Board read model | claimed-from-Review run must render in the correct derived column | `NeedsInput` — unchanged |
| Portfolio / home (cross-project) read model | must not vanish while holding a slot | unchanged |
| Rail / sidebar queries | same | same |
| Scheduler cap accounting | already counts `HumanWorking` (A2) — assert the claim consumed a slot | no slot change (`Running`→`NeedsInput` both counted) |
| `runResumeRecoverySweep` | `HumanWorking` excluded (filters `NeedsInput`) — assert unchanged | must classify `node_interrupt` parks as recoverable, not `Crashed` |
| `runTakeoverReturnRecoverySweep` | must reach a Review-claim return (CA3) | n/a |
| keepalive sweeper pass1/pass2 | `HumanWorking` never idled | `node_interrupt` HITL must idle → `NeedsInputIdle` → 24 h `Abandoned` |
| HITL form/human response guard | allow-list must NOT admit a claimed run | new kind admitted only via the `node_interrupt` branch |
| `abandonRun` | `releaseHumanWorking` path must handle a Review-provenance claim (no review HITL to re-open — the release target is `Review`, not `NeedsInput`) | unchanged |
| `promoteRun` / `syncRunTarget` | already fenced by their `status==='Review'` guards (A7) — assert with a matrix test | n/a |
| `deriveWorkbenchLifecycleActions` | owner carve-out for `exportBranch` (Task 8) | unchanged |
| Orchestrator child accounting (`SETTLED_RUN_STATUSES`) | excluded by `parent_run_id IS NULL` (D3) — **assert with a refusal test** | unchanged |
| Observatory | claim/return produce no `Reworked` row → no metric change; assert | **`operator_interrupt` excluded from BOTH `reworkCount` and `retryCount`** (A10) |
| OpenAPI | new paths in the same change | new kind + body fields in the same change |
| Domain events / webhooks | `run.escalated` not emitted for a claim (it is not an escalation); decide + document | `run.escalated` with `reason: "node_interrupt"` |

---

## Deployment wiring (skill-context rule)

| New dep | Files that MUST be touched |
| --- | --- |
| `MAISTER_MAX_OPERATOR_RESTARTS` (default `10`, per-run cap on `decision='operator_interrupt'` attempts) | `.env.example`, `compose.yml` (web `environment:`), `compose.production.yml`, `deploy/maister.env.example`, `docs/configuration.md` env-vars table |

No new port, sidecar, config file, or binary. Supervisor is unchanged except for reusing the
existing `POST /sessions/:id/checkpoint` contract (no new supervisor route, no adapter fork).

---

## Spec-driven contract (SDD)

**The spec is the source of truth for WHAT; this plan is the source of truth for HOW and in
what order.** `.ai-factory/specs/run-continuation-controls.spec.md` (Task 0) freezes the
requirement catalogue (`REQ-A1..A11`, `REQ-B1..B11`), the API/DB/analytics contracts, and the
acceptance-criteria traceability matrix (`AC-A1..A19`, `AC-B1..B13` → test ids `T-A*` / `T-B*`).

Rules that bind every downstream task:

1. **No implementation task may begin before Phase 0 is frozen.** Phase 0 produces the spec;
   Phases 1-4 consume it.
2. **Every implementation task cites the `REQ-*` it satisfies and the `AC-*` it must turn
   green.** A task with no `REQ` traceability is out of scope by definition — delete it or
   amend the spec first.
3. **Every test carries its `T-*` id** from the traceability matrix, as a comment on the
   `describe`/`it` block, so the matrix is greppable from the code.
4. **Spec drift is a bug.** If implementation reveals the spec is wrong, amend the spec in the
   same commit and say so in the commit body — never silently diverge, and never "fix" both
   sides in different directions.
5. **A phase cannot exit with an unsatisfied `AC`.** Tasks 19 and 29 each re-derive the matrix
   from the code and fail the phase on any AC without a green test.

## TDD charter

Implementation is **RED → GREEN → REFACTOR**, per task, not per phase.

- **RED** — write the named `T-*` test(s) first and **observe them fail for the intended
  reason**. A test that passes before the implementation exists is not a RED step; it is a
  tautology, and it must be rewritten or deleted.
- **GREEN** — the minimum implementation that turns exactly those tests green. No
  speculative generality, no unrequested configurability.
- **REFACTOR** — apply SOLID/KISS/DRY with the tests green; re-run before moving on.

Test-design rules (the plan is non-compliant if a task violates one):

- **One AC → one test (or one tight cluster).** Two tests asserting the same invariant through
  different doors are overlap; keep the one closest to the contract boundary.
- **No trivial tests.** Do not test the framework, the ORM, a getter, a constant, a type, or
  that a mock was called with what the same test just passed it. If a test cannot fail for a
  reason a reviewer cares about, it does not belong.
- **Test at the contract seam, not the implementation detail** — the route/service boundary
  and the DB state it leaves, not private helper internals. A refactor that keeps the contract
  must not turn the suite red.
- **Edge cases are first-class**, not an afterthought: every refusal row, every CAS loser,
  every crash window in the table above has a test id in the spec matrix.
- **Integration over mocked unit** for anything touching the DB, a CAS, a transaction boundary,
  or git. Thread the injected `db` through the service seam — **never** a `DB_URL` env
  workaround (a known trap in this repo: it silently skips `dbIsPostgres`-gated paths,
  advisory locks included).
- **`vitest list` before claiming a test exists.** A test under a path no project globs never
  runs; confirm the `unit` / `integration` include globs match the file.

## Implementation constraints (binding on every code task)

- **Typed errors only.** Throw `MaisterError` with a `code` from the closed union — never a
  plain `Error` for a domain failure, never a string-matched branch. No new code is added by
  this change; `docs/error-taxonomy.md` gains cell entries.
- **TypeScript strict.** No `any` in committed code unless flagged `// FIXME(any):` with a
  reason, matching the existing seams.
- **SOLID** — the re-entry resolver, the FF ingest, the option-matrix derivation, and the
  claim/return services are each one module with one reason to change, DB-injectable at the
  seam (single responsibility + dependency inversion, as `sync-target.ts` already does).
- **DRY, but not forced.** Reuse `markDownstreamStale`, `claimTakeover`, `downstreamOf`,
  `applyWorkspacePolicy`, `resolveSessionPolicy`, `scheduleResume`, and the M11b two-phase
  return skeleton. Do **not** factor a shared abstraction between Feature A's claim and
  Feature B's restart — they share a ledger, not a policy.
- **KISS.** The minimum that satisfies the spec. No unrequested flags, abstractions, or
  extension points — D10 exists precisely because a flag was the wrong answer.
- **Surgical.** Every changed line traces to a `REQ-*`. Do not refactor adjacent code, do not
  reformat, do not delete pre-existing dead code — mention it instead. Remove only the
  imports/symbols **your** change orphaned.
- **Comments explain WHY, never WHAT.** Match the surrounding density: the invariant, the
  ordering constraint, the surprising fence — as `promote.ts` and `hitl.ts` already do.
- **Client/server boundary.** Client components import `@/lib/errors-core`, never
  `@/lib/errors`. Server-only modules keep their `import "server-only"`.
- **UI affordances** per `web/CLAUDE.md`: icon or icon+label buttons over text-only; success is
  a green check glyph, never the word "Succeeded"; modals portalled to `document.body`.
- **Lint check-only.** `pnpm --filter maister-web exec eslint .` — **never** the bare `lint`
  script (it is `eslint --fix` with no path and reformats ~60 unrelated files).

## Task → requirement → acceptance → test traceability

The authoritative `REQ-*` / `AC-*` / `T-*` definitions live in the spec (Task 0). This table is the
**routing** between them and the tasks, so no task is orphaned and no AC is unowned. Each
implementation task writes its `T-*` tests **RED first**, then implements to GREEN, then refactors.

| Task | Satisfies | Turns green | Tests written RED first |
| --- | --- | --- | --- |
| 6 — `reentry` DSL + engine floor | REQ-A4 | AC-A7 | T-A7 (unit, 4 cases) |
| 7 — `resolveReentryNode` | REQ-A4 | AC-A6 | T-A6 (unit, 4 cases) |
| 8 — lifecycle owner carve-out | REQ-A5 | AC-A8 | T-A8 (unit, matrix) |
| 9 — claim route | REQ-A1, A2, A3 | AC-A1, A2, A3, A4, A5 | T-A1, T-A2 (unit); T-A3, T-A4, T-A5 (integ) |
| 10 — FF-only ingest | REQ-A6 | AC-A9, A10 | T-A9, T-A10 (integ) |
| 11 — return route | REQ-A7, A9, A11 | AC-A11, A12, A15, A17 | T-A11, T-A12, T-A15, T-A17 (integ) |
| 11A — shared staleness fix | REQ-A8 | AC-A13, A14 | T-A13, T-A14 (integ) |
| 11B — domain events + migration | REQ-A10 | AC-A16 | T-A16 (integ, 4 cases) |
| 11C — apply migration | REQ-A10 | — (operational gate) | — |
| 12 — Feature-A fanout sweep | REQ-A1, A5 | AC-A18 | T-A18 (integ, matrix) |
| 13 — `continuation` read model | REQ-A4, A5 | AC-A8 (server-owned availability) | extends T-A8 |
| 14 — Feature-A UI | REQ-A5 | — (rendering; AC-A19 covers behaviour) | component tests |
| 20 — interrupt route + kind | REQ-B1, B2, B3 | AC-B1, B2, B3 | T-B1 (unit); T-B2, T-B3 (integ) |
| 21 — option matrix + response handler | REQ-B4, B5, B6, B7 | AC-B4, B5, B6, B7, B8, B9 | T-B4, T-B5 (unit); T-B6, T-B7, T-B8, T-B9 (integ) |
| 22 — Feature-B fanout sweep | REQ-B11 | AC-B12 | T-B12 (integ) |
| 23 — correction prompt append | REQ-B8 | AC-B6 (prompt half) | extends T-B6 |
| 24 — maxLoops exclusion + cap | REQ-B9 | AC-B10 | T-B10 (unit) |
| 25 — Observatory + deployment | REQ-B10 | AC-B11 | T-B11 (unit) |
| 19 / 29 — phase AC conformance | all | AC-A19 / AC-B13 | T-A19 / T-B13 (e2e) |

Tasks 1–5, 3A, 15–18, 26–28, 30 are spec/docs/i18n/sweep/hygiene tasks; they own no `REQ` directly
and are gated by the Phase-0 and phase-exit criteria instead.

## Commit Plan

- **Commit 1** (Tasks 0, 3A): `docs(specs): SDD freeze for run continuation controls + ADR-142 citation fix`
- **Commit 2** (Tasks 1–5): `docs(flow-runs): ADR-159/160 + continuation-controls analytics and contracts`
- **Commit 3** (Tasks 6–11C): `feat(runs): review rework-claim, FF-only return, re-entry resolution`
- **Commit 4** (Tasks 12–16): `feat(runs): continuation-controls fanout, UI, i18n`
- **Commit 5** (Tasks 17–19): `test(runs): rework-claim edge-case sweep + AC conformance`
- **Commit 6** (Tasks 20–25): `feat(runs): soft node interrupt with corrective restart (ADR-160)`
- **Commit 7** (Tasks 26–29): `test(runs): node-interrupt edge-case sweep + docs as-built`
- **Commit 8** (Task 30): `chore: ADR renumber pass after rebase`

---

# Tasks

## Phase 0 — Analytics & contracts (docs-first; NO code)

> **Exit criteria for Phase 0.** Every artifact below is COMPLETE and INTERNALLY CONSISTENT before
> Task 6 starts. Every state transition and every refusal row is written **exactly as the code will
> gate it** (allow-list phrasing where the code uses an allow-list). Every described piece carries an
> implementation-status tag (`Designed` at this point, flipped to `Implemented` in Tasks 19/29).
> **Gates, all three:** `pnpm validate:docs` (Mermaid) · `pnpm validate:docs:adr` (ADR anchors —
> `validate:docs` does NOT resolve `[ADR-NNN](decisions.md#…)`) · **`pnpm validate:contracts`**
> (OpenAPI + AsyncAPI structural validation over `web.openapi.yaml` and the four AsyncAPI files).
> **Completeness gate:** every `REQ-*` in the spec is covered by at least one `AC-*`, and every
> `AC-*` names a `T-*` test id and an owning task. An orphan on either side fails Phase 0.

- [x] **Task 0: Freeze the SDD spec — `.ai-factory/specs/run-continuation-controls.spec.md`.**
  The project's SDD convention (28 existing `*.spec.md`; closest analogue
  `.ai-factory/specs/domain-event-outbox.spec.md`). Sections, in this order:
  `Status: SDD freeze for Phase 0. No production code is implemented by this spec.` + Date +
  Branch → Purpose → Scope source → Verified baseline → **Requirements** (`REQ-A1..A11`,
  `REQ-B1..B11`, one normative MUST per row) → **API contract** (path × method × success ×
  refusals) → **DB contract** (migration `0125` literal SQL + taxonomy additions) →
  **System-analytics contract** (the R5/R5a/R6 obligations) → **Acceptance criteria
  traceability** (`AC-*` → criterion → `REQ-*` → `T-*` test id) → Non-goals → Linked artifacts.
  This artifact is the source of truth for WHAT; the plan stays the source of truth for HOW.
  *Verify:* every `REQ-*` is referenced by ≥1 `AC-*`; every `AC-*` names a `T-*` and an owning
  task; every Non-goal in the plan appears in the spec and vice versa; no requirement restates
  an ADR's rationale (R7 — cite, don't duplicate).
  *Depends on:* none. **Nothing else in this plan may start until this is frozen.**

- [x] **Task 1: Write ADR-159 and ADR-160 headers + bodies in `docs/decisions.md`.**
  ADR-159 "Review-run rework claim with fast-forward-only handoff round-trip" (Status: Accepted);
  ADR-160 "Operator node interrupt with corrective restart" (Status: Accepted).
  Each MUST record: the eligibility allow-list (D3) **including why `agent` is excluded although
  ADR-141 sync admits it** — branch-operation vs graph-re-entry concern, agent runs carry no
  `node_attempts`; the claim-is-a-status decision + WHY the leased lifecycle slot is unusable (A5);
  the FF-only decision + the rejected alternatives (merge / AI resolve) (D4); the re-entry chain
  (D5); the prompt-append channel (D6); the maxLoops-exclusion + safety cap (D7); human-actor-only
  (D8); **the D10 shared-staleness correction and its M11b consequence**; the D11 event kinds; and
  **every accepted residual crash window from the table above**.
  Also add the two ADR entries to the decisions index table at the top of the file.
  Add row entries to `docs/error-taxonomy.md` cells (no new codes).
  *Verify:* `grep -c '^### ADR-159' docs/decisions.md` = 1, same for 160; anchor-check script green.
  *Logging:* n/a (docs).

- [x] **Task 2: Create `docs/system-analytics/run-continuation.md`** — the new domain doc. It owns
  BOTH features and cross-links `manual-takeover.md` rather than duplicating M11b.
  **`docs/CLAUDE.md` compliance is the acceptance criterion, not a style note:**
  - **R5** — exactly these sections, in this order: Purpose · Domain entities · State machine ·
    Process flows · Expectations · Edge cases · Linked artifacts. No extra top-level sections.
  - **R5a** — the Expectations section is the acceptance contract: **≤ 12 bullets**, one MUST-hold
    invariant per bullet, one sentence each, RFC-2119 phrasing (MUST / NEVER / exactly / at most),
    **every bullet testable** (turnable into an assertion or a SQL check), identifiers **verbatim**
    (`runs.status`, `owner_user_id`, `decision='operator_interrupt'`,
    `MaisterError("CONFLICT")`, `MAISTER_MAX_OPERATOR_RESTARTS`). No restating diagrams, no
    duplicating Edge cases. If it needs >12 bullets the boundary is wrong — split the file.
  - **R6** — every described piece tagged `(Implemented)` / `(Designed)` / `(Phase 2)`.
  - **R2** — Mermaid only. **R7** — cite ADR-159/160, never restate their rationale.
  Content: the `Review → HumanWorking → Running` and
  `Running → NeedsInput → {resume | restart_node | restart_from | stop}` `stateDiagram-v2`s; the
  **refusal matrix** (one row per precondition, phrased as the allow-list the code uses); the
  crash-window table verbatim from this plan; the re-entry chain; the option matrix.
  *Verify:* `pnpm validate:docs` green; Expectations bullet count ≤ 12; **each Expectations bullet
  maps to an `AC-*` in the spec** (this is the doc↔spec consistency check); every transition in the
  diagram maps to a named function that Phase 1/3 will create.
  *Depends on:* 0, 1.

- [x] **Task 3: Update the existing domain docs.**
  - `docs/system-analytics/runs.md` — add `Review --> HumanWorking: rework claim (ADR-159, cap-gated,
    top-level only)` and `Running --> NeedsInput: operator node interrupt (ADR-160)` to the state
    diagram; extend the `HumanWorking` invariants section with the Review provenance.
  - `docs/system-analytics/manual-takeover.md` — add a "Review-run rework claim (ADR-159)" section
    stating precisely what is shared with M11b and what differs (entry status, claim anchor, FF
    ingest, re-entry chain).
  - `docs/system-analytics/workbench-lifecycle.md` — document the owner carve-out: during
    `HumanWorking`, `exportBranch` / `snapshotCommit` / `handoffBranch` / handoff-metadata are
    available **to the claim owner only**; every other action stays `human-owned`-disabled.
  - `docs/system-analytics/hitl.md` — add `node_interrupt` to the kinds table, the human-actor-only
    list, the keep-alive/idle/24h-abandon behaviour, and the server-owned option matrix.
  - `docs/system-analytics/flow-graph.md` — the operator-restart attempt lifecycle and its exclusion
    from the rework epoch accounting.
  *Depends on:* 1, 2.

- [x] **Task 3A: Fix the ADR-142 citation drift in `runs.md` (standalone, pre-existing defect).**
  `docs/system-analytics/runs.md:3` carries the heading `## ADR-142 workspace-presence guard
  (Implemented)`, but `docs/decisions.md:169` assigns **ADR-142** to *"Evaluation Study domain and
  legacy Experiment compatibility"*. `docs/system-analytics/hitl.md:3` repeats the same mis-citation
  (`## ADR-142 removed-workspace boundary`). This is a pre-existing defect, unrelated to this
  feature, fixed here because the plan touches both files and would otherwise propagate the wrong
  number.
  Procedure — **investigate, do not invent**: `git log -S 'workspace-presence' -- docs/` and
  `git log --oneline -- docs/system-analytics/runs.md` to find the commit that introduced the
  heading and which ADR it was actually meant to cite. Then either (a) re-point both headings at the
  correct existing ADR number, or (b) if the guard genuinely has no ADR, demote both headings to
  un-numbered (`## Workspace-presence guard (Implemented)`) and note the absence. **Do not allocate a
  new ADR number for retro-documenting an already-shipped guard.** Sweep for other citations:
  `rg -n 'ADR-142' docs/ web/ supervisor/`.
  *Verify:* the ADR anchor-check script is green; `rg -n 'ADR-142' docs/` returns only citations that
  match `decisions.md`'s ADR-142 title.
  *Depends on:* none (can run first; independent of the feature).

- [x] **Task 4: Specify the flow-DSL `reentry` field.**
  - `docs/flow-dsl.md` — flow-level `reentry: <nodeId>`, compile-validated, engine floor **3.5.0**,
    engine-floor table updated, with an example. State explicitly that `reentry` is **compile-time
    only and never persisted to a DB column**, so the YAML→DB SET/CLEAR symmetry rule does not apply;
    republishing a manifest without `reentry` simply recompiles without it.
  - `docs/system-analytics/flow-graph.md` — how `reentry` participates in D5.
  *Depends on:* 2.

- [x] **Task 5: Specify the API + event contracts (concrete, convention-conforming).**
  `docs/api/web.openapi.yaml` — four new path objects (`rework-claim/claim`, `rework-claim/return`,
  `rework-claim/release`, `node-interrupt`), the extended `hitl/{id}/respond` body, and the new
  `continuation` block on the run-detail DTO. **Mirror the shape of the existing
  `/api/runs/{runId}/takeover/claim` object (`web.openapi.yaml:7596-7681`) exactly** — this repo has
  a specific convention and a partial match will fail review:
  - a `tags: [run-continuation]` entry, with the tag **registered in the document-root `tags:` list**
    (the `takeover` tag sits at `web.openapi.yaml:125-126`);
  - an `operationId` per path (`claimReworkClaim`, `returnReworkClaim`, `releaseReworkClaim`,
    `interruptNode`);
  - a `description` containing the **per-route identifier trust table** (`Identifier | Source |
    Trust`) — the convention at `:7617-7626`, populated from this plan's trust table — plus the
    "No new `MaisterError` code (ADR-008 closed union)" note;
  - `$ref`s to the shared `#/components/responses/Unauthenticated`, `.../Forbidden`, and
    `#/components/schemas/MaisterErrorBody`; inline 404/409/503 descriptions that **enumerate each
    refusal class by its error code**, as `:7676-7681` does;
  - at least one `examples:` entry per success response and per distinct refusal class.
  Events: `docs/api/async/web-runs.asyncapi.yaml` gains `run.rework_claimed` /
  `run.rework_returned` and the `run.escalated` `reason` enum value `node_interrupt`;
  `docs/api/async/outbound-webhooks.asyncapi.yaml` gains the matching webhook types.
  Record the decision that Feature A emits its own kinds while Feature B reuses `run.escalated`
  (D11) in ADR-159/160 so the asymmetry is a decision, not an omission.
  *Verify:* **`pnpm validate:contracts` green** (`scripts/validate-contracts.mjs` covers
  `web.openapi.yaml` + all four AsyncAPI files — it rejects unresolvable `$ref`s and external refs);
  every refusal row in Task 2's matrix has a matching status code **and** error code here; every
  `AC-*` that names an HTTP outcome finds it in this spec.
  *Depends on:* 0, 2, 3.
  <!-- Commit checkpoint: Commit 2 (Tasks 1-5, 3A) -->

---

## Phase 1 — Feature A backend (handoff round-trip)

> **Exit criteria for Phase 1+2.** Feature A is fully shippable — code, tests, docs — before Task 20
> starts. Full suite green: `pnpm --filter maister-web test`. Any test this phase touches that is left
> red fails the phase; a pre-existing red is quarantined by an explicit `exclude`/`.skip` with a reason
> and a tracked follow-up, never tolerated silently.

- [x] **Task 6: Add the flow-level `reentry` field end-to-end (schema → compile → engine floor).**
  Files: `web/lib/config.schema.ts` (add `reentry: z.string().min(1).optional()` beside `nodes`, in
  the `.passthrough()` graph manifest object — A15); `web/lib/config.ts` (add
  `const REENTRY_ENGINE_MIN = "3.5.0"`, a `declaresReentry(manifest)` predicate, and the `semverGte`
  throw mirroring `declaresDecideOrOnMismatch` at 1101 — **gate on the manifest, not on `nodes`**,
  since the field is flow-level); `web/lib/flows/engine-version.ts` (bump `MAISTER_ENGINE_VERSION`
  to `"3.5.0"`); `web/lib/flows/graph/compile.ts` (validate `reentry` resolves to a known node id →
  `CONFIG` with the unknown id in the message; add `reentry: string | null` to the compile result
  beside `entry`/`order`/`nodes`/`sessions`); `web/lib/flows/flow-dsl-grammar.ts` + its drift-guard
  test (the in-code SSOT shipped to agents as `/flow-authoring` — a docs-only sweep misses it).
  *Logging (verbose):* `log.debug({flowYamlPath, declared, required, ok}, "[engine-gate] reentry floor")`
  matching the existing gate log shape; `log.debug({reentry, resolved}, "[compile] reentry resolved")`.
  *Verify:* unit test — manifest with `reentry` + `engine_min: 3.4.0` throws `CONFIG`; with `3.5.0`
  compiles; unknown node id throws `CONFIG` naming the id; a manifest **without** `reentry` compiles
  at ANY `engine_min` (byte-identical to today).
  *Depends on:* 4.

- [x] **Task 7: Implement `resolveReentryNode(runId, graph, db)` — the D5 chain.**
  New module `web/lib/runs/reentry.ts`. Returns a discriminated result:
  `{ok: true, nodeId, source: 'manifest' | 'takeover_transition'}` or
  `{ok: false, reason: 'no_reentry_declared'}`. Step 2 reads the ledger
  (`getNodeAttemptsForRun`) for the **last executed node whose compiled node type is `human`** and
  whose `transitions.takeover` resolves — **because `runs.current_step_id` is NULL in `Review` (A1)**.
  Pure and DB-injectable so it is unit-testable without Postgres.
  *Logging (verbose):* DEBUG per chain step (`manifest declared? / scanning ledger / candidate node /
  resolved / exhausted`), INFO on the resolved result with `source`.
  *Verify:* unit tests for all three chain outcomes + the "manifest `reentry` wins over a present
  takeover transition" precedence case + "takeover target names a node absent from the compiled
  graph → falls through to disabled, never throws".
  *Depends on:* 6.

- [x] **Task 8: Open the lifecycle owner carve-out.**
  Files: `web/lib/workbench-lifecycle/policy.ts` — extend `WorkbenchLifecyclePolicyInput` with
  `claimOwnerUserId: string | null` and `viewerUserId: string | null`; when
  `runStatus === 'HumanWorking'` **and** `viewerUserId === claimOwnerUserId` **and** the workspace is
  present and not removed, enable `exportBranch` only (stop/archive/drop stay `human-owned`); every
  other case keeps today's `disabledActions("human-owned")` byte-for-byte.
  `web/lib/workbench-lifecycle/service.ts` — thread the two new fields through `LifecycleContext` /
  `loadContext` / `requireActionAllowed` (393). Per A6 this single carve-out is what enables
  `snapshotWorkbenchCommit`, `createWorkbenchHandoffBranch`, and `getWorkbenchHandoffMetadata` during
  a claim — verify each of the three is reached and that a **non-owner** is refused
  `PRECONDITION: human-owned`.
  *Logging (verbose):* DEBUG the derived action set with `{runStatus, claimOwnerUserId, viewerUserId,
  carveOut: true|false}`.
  *Verify:* pure unit tests over `deriveWorkbenchLifecycleActions` — the full status × owner ×
  workspace-presence matrix, including the regression case "HumanWorking + non-owner ⇒ all disabled".
  *Depends on:* 3.

- [x] **Task 9: Implement `POST /api/runs/{runId}/rework-claim/claim`.**
  New route `web/app/api/runs/[runId]/rework-claim/claim/route.ts` + service in
  `web/lib/runs/rework-claim.ts`. Order of operations, all cheap deterministic preconditions BEFORE
  any mutation:
  1. `requireActiveSession()` **auth-first**, then `loadRunProjectId` → 404 if absent, then
     `requireProjectAction(projectId, 'answerHitl')` — **before** `loadRun` parses the stored manifest
     (copied verbatim from the M11b claim route, so a malformed revision stays invisible to non-members).
  2. Eligibility **allow-list** (D3/A4): `status === 'Review'`, `run_kind === 'flow'`,
     `parent_run_id IS NULL`, `workspace_mode !== 'shared'`, not a launched evaluation lineage,
     `workspace !== null && removed_at === null`. Each failure → `PRECONDITION` with a distinct
     message. The `run_kind` refusal is **explicit and early**, and its message says *why* rather
     than leaving the caller to hit a confusing "no re-entry declared" later: e.g. *"only flow runs
     can be taken for rework — an agent run has no graph to re-enter; use branch sync or launch a
     new run from this branch"*.
  3. `resolveReentryNode` → `{ok:false}` ⇒ `PRECONDITION` whose message names the relaunch escape hatch.
  4. **Cap gate**: recheck `countLiveRuns() >= cap` **inside** the claim transaction, under the run
     row lock → `CONFLICT` ("concurrency cap full — free a slot or stop another run"). **Never queue.**
  5. ONE transaction: CAS `Review → HumanWorking` (new `markReworkClaimFromReview` in
     `web/lib/runs/state-transitions.ts`, exact-allow-list `WHERE status='Review'`, mirroring
     `markSyncFromReview`) → loser gets `CONFLICT`; then `claimTakeover(...)` extended to accept an
     explicit `nodeType` and `decision` (append the claim row at the **last executed node** with
     `decision='review_rework_claim'`); then the `manual_takeover`-shaped assignment
     (`action_kind: 'manual_takeover'`, title distinguishing the Review provenance).
     The CAS runs FIRST so a concurrent loser never reaches the `UNIQUE(run_id, node_id, attempt)`
     insert (the exact M11b ordering rationale).
  6. Response: `{worktreePath, branch, ownerUserId, reentryNodeId, reentrySource}`.
  *Logging (verbose):* DEBUG each eligibility check with its outcome; DEBUG the cap recheck with
  `{liveCount, cap}`; INFO on claim with `{runId, ownerUserId, anchorNodeId, reentryNodeId, reentrySource}`;
  WARN on every refusal with the code.
  *Depends on:* 7.

- [x] **Task 10: Implement fast-forward-only origin ingest (`web/lib/runs/rework-claim-ingest.ts`).**
  `fetch <remote>` with **no refspec** (matching ADR-141, so `<remote>/<branch>` really is refreshed),
  then `git merge --ff-only <remote>/<branch>` inside the worktree. Also FF the same-head handoff
  branch when `getWorkbenchHandoffMetadata`-derived handoff metadata names one and it is strictly
  ahead. Every git invocation goes through the existing `web/lib/worktree.ts` helpers / validators
  (`branchNameSchema`, `remoteNameSchema`, `absolutePathSchema`, the `/^[A-Za-z0-9_./-]+$/` ref check)
  — **no new unvalidated ref path**. Non-FF / divergence → `PRECONDITION` whose `details` carry
  `{command, localSha, remoteSha, aheadBy, behindBy, instructions: string[]}` so the UI can render a
  copyable block. No merge, no rebase, no AI resolve (D4). A missing remote or a branch with no
  upstream is a **no-op success**, not a failure (the purely-local loop must still work).
  *Logging (verbose):* DEBUG every git command + its exit code and stdout head; INFO
  `{runId, remote, branch, before, after, fastForwarded}`; WARN with the full failing command on non-FF.
  *Depends on:* 9.

- [x] **Task 11: Implement `POST /api/runs/{runId}/rework-claim/return` — two-phase commit.**
  New route + service. Structure copied from the M11b return route (which is the reference
  implementation for the ordering), with the FF ingest spliced in:
  - **Phase 1 (intent)**: `FOR UPDATE` on the run row; assert `status === 'HumanWorking'`; assert
    `getActiveTakeover(runId)` exists, is owner-matched (`403 UNAUTHORIZED` otherwise) and carries
    `decision='review_rework_claim'` (a M11b takeover must keep using the M11b route → `PRECONDITION`).
    **No AFTER-side marker is written here.**
  - **Phase 2a (git, no ledger writes)**: FF ingest (Task 10) → dirty check
    (`git status --porcelain=v1 --untracked-files=all` non-empty ⇒ `CONFLICT`, unchanged state,
    retryable) → `resolveBaseRef` / `logRange` / `diffRange` / `resolveRefSha` → **empty return
    (zero commits) ⇒ `CONFLICT`**, no ledger write. Every failure here leaves the run `HumanWorking`
    with no mutation.
  - **Phase 2b (ONE transaction)**: `recordTakeoverReturn` → `recordArtifact` ×2 (commit_set + diff,
    pinned to the immutable head SHA) → `markDownstreamStale([reentry, ...downstreamOf(graph, reentry)])`
    → re-pin still-current `requiredFor` git artifacts (`getCurrentRequiredForGitArtifacts` +
    `supersedePrior`) → `markReturnedToRunning` CAS (loser ⇒ `PRECONDITION`) → `current_step_id = reentry`
    → complete the assignment. A non-`MaisterError` throw inside ⇒ `EXECUTOR_UNAVAILABLE` 503, run
    stays `HumanWorking`, fully retryable.
  - **Phase 3**: `queueMicrotask(() => runFlow(runId))`. CA3 is covered by the existing
    `runTakeoverReturnRecoverySweep` — **add an integration test proving a Review-provenance return is
    reachable by that sweep's predicate**, per A8.
  - **Staleness correctness is handled once, in the shared helper (D10) — see Task 11A.** This route
    calls `markDownstreamStale` unchanged; Task 11A is what makes that call correct.
  - **Release path**: `POST .../rework-claim/release` (no changes) returns `HumanWorking → Review`
    (**not** `NeedsInput` — there is no review HITL to re-open in the Review provenance), closes the
    claim row via `endActiveTakeover`, and calls `promoteNextPending` because the slot is freed.
  *Logging (verbose):* INFO per phase boundary with the phase name; DEBUG each precondition; WARN with
  code on each refusal; ERROR on the 503 path with the underlying message.
  *Depends on:* 10, 11A (defined immediately below — read it first).

- [x] **Task 11A: Make `markDownstreamStale` ignore claim rows — shared, unconditional (D10).**
  `web/lib/flows/graph/ledger.ts`: when choosing the per-node latest attempt for staling, select the
  latest attempt **with `owner_user_id IS NULL`**. A claim row is a human-handoff marker, not a node
  execution, and must never shield the node's real last execution from the staler. No flag, no
  caller-scoped variant — one behaviour for every caller (`latestAttemptByNode:680`,
  `markDownstreamStale:698`).
  **TDD, and settle the M11b question by experiment, not argument:**
  1. Write the failing test for the **Feature-A** shape first: run reaches `Review` with a `passed`
     gate on the last executed node → claim (claim row appended at that node) → return → assert that
     node's prior `passed` gate is now `stale`. It must fail before the fix.
  2. Write the equivalent test for the **M11b** shape: parked at `human_review`, claim, return,
     assert the review node's prior gate rows. `human_review` gates are deferred to node finish
     (`gates-exec.ts:703-717`) and the finish row is written at `runner-graph.ts:1021` — so the test
     must construct the state that actually exists, not the state I assumed. **Record the observed
     result in ADR-159 either way.** If M11b proves unaffected, keep the test as documentation of
     why; if it proves affected, this task fixed a live defect and that must be stated plainly in the
     ADR and the commit message.
  3. **Assertion migration is in-scope here, not a follow-up.** Run the existing M11b suites first
     and enumerate what moves: `web/app/api/runs/[runId]/takeover/__tests__/takeover.integration.test.ts`,
     `takeover-lifecycle-fixes.integration.test.ts`, `takeover-resume.integration.test.ts`,
     `web/lib/flows/graph/__tests__/takeover-artifacts.integration.test.ts`,
     `web/lib/queries/__tests__/board-takeover.integration.test.ts`, plus any `ledger` unit test
     asserting stale counts. Any assertion this change invalidates is updated in THIS task.
  *Logging (verbose):* DEBUG per node `{nodeId, latestAttemptId, skippedClaimAttemptId, staled}` so the
  skip is observable; the existing INFO summary line gains `skippedClaimRows`.
  *Verify:* both new tests green; the full M11b suite green; `staledGates` counts in the summary log
  are ≥ their pre-change values (never fewer — the fix only ever stales more).
  *Depends on:* 9.

- [x] **Task 11B: Emit `run.rework_claimed` / `run.rework_returned` (D11) + migration `0125`.**
  Follow the extension rule written in `web/lib/domain-events/taxonomy.ts`'s own header — all four
  parts, or none:
  1. **Taxonomy**: add both kinds to `DOMAIN_EVENT_KINDS`. Neither is a run-terminal or run-settled
     kind, so **do not** add them to `RUN_TERMINAL_EVENT_KINDS` / `RUN_SETTLED_EVENT_KINDS` — that
     would make an orchestrator treat a claim as a settled child (A3 again, by a different door).
  2. **Migration `0125`** — the literal SQL is frozen in the spec's "DB contract" section; copy it
     verbatim (13 kinds, `DROP CONSTRAINT` + `ADD CONSTRAINT`, the exact shape
     `0099_agent_human_ask.sql` used). CHECK-only: no column, no data, nothing to back-fill, no
     abort-guard needed. Ship the **triple**: SQL + `_journal.json` entry +
     `meta/0125_snapshot.json`.
     **Hand-author the snapshot from `0124_snapshot.json`, changing only the constraint** — do NOT
     use `drizzle-kit generate --custom`: it copies the previous snapshot verbatim, which stales the
     diff baseline and silently breaks the *next* `db:generate`.
     Assert (a) the newest journal entry has a matching snapshot file, and (b) the journal `when`
     timestamps stay **monotonic** — a rebase that leaves a non-monotonic `when` makes the migrator
     silently SKIP the migration.
     Record the rollback in the ADR: the inverse `DROP`/`ADD` with the 11-kind list, valid only
     while no row carries a new kind.
  3. **Emit sites**: inside the claim transaction (Task 9 step 5) and the return's Phase-2b
     transaction (Task 11) — same tx as the domain write, ADR-086 exactly-once. Payload carries
     `{runId, taskId, ownerUserId, reentryNodeId, reentrySource}` and, for the return,
     `{returnedCommitCount, fastForwarded, remote}`. Actor is `{type:'user', id: ownerUserId}` — this
     is an operator action, not `system`. Emit the matching `emitWebhookEvent` alongside, mirroring
     `hook-trip.ts`.
  4. **Docs row**: `docs/system-analytics/domain-events.md` kind table **and** the ERD pair —
     `docs/database-schema.md` **and** `docs/db/domain-events.md`. Updating one is not updating the
     other; both must name the new CHECK contents.
  5. **Fourth registration point — FOUND during Task 5, not hypothetical.**
     `web/lib/ext-activity/types.ts` declares `PulseEventKind = DomainEventKind` (an alias, not a
     separate list), and `mapDomainEvent` in `web/lib/ext-activity/domain-events.ts` is an
     **exhaustive `switch` with no `default` arm**. Widening `DOMAIN_EVENT_KINDS` therefore breaks
     that switch's exhaustiveness at compile time. Add a `case` for BOTH new kinds with an
     appropriate `salience` / `action` / `summary`, and mirror them in
     `docs/api/external/operations.openapi.yaml` `ExtPulseEventKind` (**done in Task 5**) — that enum
     IS the domain-event taxonomy mirror, not a webhook one.
  Also confirm the permanent `noop` consumer and the per-consumer cursor dispatcher need no
  registration change for a new kind (they are kind-agnostic) — **verify, do not assume**. The
  webhook mirrors (`outbound-webhooks.asyncapi.yaml` payload schemas + `oneOf`, and BOTH
  `WebhookEventType` enums) are already updated by Task 5; Task 11B adds the matching
  `web/lib/webhooks/taxonomy.ts` entries so the enums and the code agree.
  *Logging (verbose):* DEBUG the emit with kind + payload keys (never secrets); the existing outbox
  INFO line is sufficient for delivery.
  **RED first:** `T-A16` (4 cases) fails against the un-migrated DB with a CHECK violation — that is
  the intended RED, and it proves the constraint is real before the migration lands.
  *Satisfies:* REQ-A10 · *Turns green:* AC-A16.
  *Logging (verbose):* DEBUG the emit with kind + payload keys (never secrets); the existing outbox
  INFO line is sufficient for delivery.
  *Verify:* `T-A16` — a claim and a return each write exactly one `domain_events` row with the right
  kind, actor, and payload, **in the same transaction** (roll the tx back and assert no row survives);
  a rejected claim writes none; the CHECK rejects an unknown kind.
  *Depends on:* 11.

- [x] **Task 11C: Apply and verify migration `0125` on the dev database.**
  Nothing in this plan runs the migrator, and an unapplied migration is a live failure mode here —
  not a formality. Run `pnpm --filter maister-web db:migrate` (the main lineage; the **brain**
  lineage `db:migrate:brain` is untouched by this change — confirm and say so rather than running it
  blindly).
  *Verify:* the constraint really moved, checked against the DB, not the file —
  `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='domain_events_kind_check';`
  returns the 13-kind list; inserting an unknown kind raises; inserting `run.rework_claimed`
  succeeds. Re-running `db:migrate` is a no-op (idempotent). If the migrator reports "no migrations
  to apply" while the constraint is still 11 kinds, that is the **non-monotonic `when` skip** — fix
  the journal ordering, do not hand-apply the SQL.
  *Satisfies:* REQ-A10.
  *Depends on:* 11B.
  <!-- Commit checkpoint: Commit 3 (Tasks 6-11, 11A, 11B, 11C) -->

- [ ] **Task 12: Feature-A consumer fanout sweep.**
  Work the Feature-A column of the fanout table above, **by grep, not by memory**: `rg 'HumanWorking'
  web/` and classify every hit into {board read model, portfolio read model, rail query, scheduler cap,
  each sweep's candidate filter, each state/precondition guard, `abandonRun`, `deriveWorkbenchLifecycleActions`,
  read-model DTOs}. For each: does the Review provenance change its answer? Fix or record "unchanged
  because …". Explicitly assert with tests: the orchestrator-child refusal (`parent_run_id NOT NULL` ⇒
  `PRECONDITION`, protecting `SETTLED_RUN_STATUSES` — A3); the promote fence and the sync fence (A7,
  matrix-tested in BOTH directions); `abandonRun` on a Review-provenance claim.
  *Deliverable:* a checklist in the PR body enumerating every `HumanWorking` consumer and its verdict.
  *Depends on:* 11.

- [ ] **Task 13: Extend the run-detail read model with a `continuation` block.**
  `web/lib/queries/run.ts` — add `continuation: { claim: {...} | null, reworkClaimAvailable: boolean,
  disabledReason: string | null, reentryNodeId: string | null, reentrySource: ... }`. The
  availability decision is **server-owned** (mirroring the `budget_breach` `availableOptions`
  precedent at `run.ts:449-455`), so the client never re-derives eligibility. When unavailable, carry
  a typed reason the UI turns into the "launch a new run from this branch" pointer (D5 step 3).
  *Logging (verbose):* DEBUG the derived availability with each contributing predicate.
  *Depends on:* 12.

## Phase 2 — Feature A UI, i18n, tests, docs

- [ ] **Task 14: UI — claim / return / release affordances.**
  `web/components/runs/review-panel.tsx` (and the run-detail lifecycle menu in
  `web/app/(app)/runs/[runId]/layout.tsx`): add **icon + label** buttons (per `web/CLAUDE.md` UI
  affordance conventions — never text-only; success renders as a green check glyph, never the word
  "Succeeded") for **Take for rework**, and while claimed: **Return to flow**, **Release**, plus the
  existing export/snapshot/handoff dialogs now reachable for the owner. Disabled states render the
  server-supplied `disabledReason`. The non-FF refusal renders the failing command + copyable git
  instructions from `details`. Reuse `web/components/board/run-takeover-actions.tsx` patterns; any
  modal is portalled to `document.body` (fixed-modal transform trap).
  *Verify:* `renderToStaticMarkup` component tests (no jsdom) covering enabled / disabled-with-reason /
  claimed-by-me / claimed-by-someone-else / non-FF-error rendering.
  *Depends on:* 13.

- [ ] **Task 15: i18n — EN + RU.** Add every new string to BOTH `web/messages/en.json` and
  `web/messages/ru.json` (both currently 4538 lines — they must stay key-identical). Covers: action
  labels, all disabled reasons, every refusal message surfaced to the user, the non-FF instruction
  block, and the re-entry source labels.
  *Verify:* the existing key-parity test/lint passes; no hardcoded English in the new components.
  *Depends on:* 14.

- [ ] **Task 16: Deployment wiring (Feature A).** Feature A adds **no** env var — record that
  explicitly in `docs/configuration.md` so the absence is a decision, not an omission. (The Feature-B
  env var lands in Task 25.) Confirm no compose/Dockerfile change is required and state why.
  *Depends on:* 13.
  <!-- Commit checkpoint: Commit 4 (Tasks 12-16) -->

- [ ] **Task 17: Feature-A test-integrity audit + edge-case sweep.**
  By this point every `T-A*` named in the traceability table already exists — each was written RED
  inside its owning task. This task closes the gaps that per-task TDD structurally cannot see:
  1. **Runnability.** `pnpm --filter maister-web exec vitest list --project unit` and
     `--project integration`; assert **every** `T-A*` file is matched by an include glob. A test in
     an unglobbed path has never run and is not evidence. New path families
     (`web/app/api/runs/[runId]/rework-claim/__tests__/**`) are already covered by
     `app/**/__tests__/**/*.test.ts` and `app/**/*.integration.test.ts` — confirm, don't assume.
  2. **Traceability closure.** Every `AC-A*` in the spec resolves to a green test; every `T-A*` in
     the code carries its id in the `describe`/`it` text so the matrix is greppable.
  3. **Overlap prune.** Two tests asserting one invariant through different doors → keep the one at
     the contract seam, delete the other. Record what was pruned and why.
  4. **Triviality prune.** Delete any test that cannot fail for a reason a reviewer cares about
     (framework behaviour, ORM behaviour, a constant, a mock asserted against its own input).
  5. **Edge cases not owned by any single task**, added here: `abandonRun` on a claimed
     Review-provenance run; a claim whose worktree is removed between eligibility check and CAS;
     a return whose remote disappears mid-operation; a second `release` after the first won.
  *Verify:* the audit produces a written list of (a) unglobbed files found, (b) ACs without a green
  test, (c) tests pruned as overlapping, (d) tests pruned as trivial — empty lists are a valid
  result, an absent list is not.
  *Depends on:* 6, 7, 8, 9, 10, 11, 11A, 11B, 12.

- [ ] **Task 18: Feature-A end-to-end integration pass.**
  One test that drives the whole contract rather than its parts, because no per-task test does:
  **happy path** `Review` → claim → export/snapshot (owner carve-out) → simulated remote push →
  return with FF ingest → staled gates rerun → fresh review → promotion still available.
  Project **`integration`**, testcontainers PG16, **injected `db` threaded through the service seam —
  never a `DB_URL` env workaround** (it silently skips `dbIsPostgres`-gated paths, advisory locks
  included).
  This is the one place overlap with per-task tests is **intended**: it asserts the composition, not
  the units. Keep it single — a second whole-path test is overlap, not coverage.
  *Turns green:* the composition half of AC-A19 (the e2e in Task 19 covers the UI half).
  *Depends on:* 17.

- [ ] **Task 19: Feature-A e2e + docs as-built.**
  Playwright spec `web/e2e/rework-claim.spec.ts` (stub-supervisor seeded, per project convention;
  kill the shared 3100/7788 ports and baseline-prove first). Drive: Review run → Take for rework →
  panel shows worktree path + branch → Return → run re-enters and reaches a fresh review.
  Then flip every Phase-0 Feature-A doc tag from `Designed` to `Implemented`, and run `/aif-docs`.
  **AC conformance gate (spec ↔ code):** walk `AC-A1..A19` in the spec and, for each, name the green
  test that satisfies it. **Any AC without a green test fails the phase** — it is either unimplemented
  work or a spec that drifted; resolve which, and if the spec was wrong amend it in this commit and
  say so in the commit body (never diverge silently).
  Also re-verify the spec's Non-goals still hold — nothing implemented that the spec excluded.
  *Phase exit:* `pnpm --filter maister-web test` fully green · `pnpm --filter maister-web exec eslint .`
  (check-only — **never** the bare `lint` script, which is `eslint --fix` with no path and reformats
  ~60 files) · `pnpm validate:docs` · `pnpm validate:docs:adr` · **`pnpm validate:contracts`** · the
  AC conformance walk above.
  *Turns green:* AC-A19.
  *Depends on:* 18, 15.
  <!-- Commit checkpoint: Commit 5 (Tasks 17-19) — FEATURE A IS SHIPPABLE HERE -->

---

## Phase 3 — Feature B backend (soft node interrupt + corrective restart)

- [ ] **Task 20: Add the `node_interrupt` HITL kind and the interrupt endpoint.**
  TS-only enum additions (no migration — verified): `hitl_requests.kind` in `web/lib/db/schema.ts`
  (~4703) and `assignments.action_kind` (~4574). New route
  `web/app/api/runs/[runId]/node-interrupt/route.ts` + `web/lib/runs/node-interrupt.ts`, modelled
  **exactly** on `escalateHookTrip` (A12):
  1. Auth-first + `requireProjectAction(projectId, 'answerHitl')`.
  2. Allow-list: `status === 'Running'`, `run_kind === 'flow'`, the current node has a live
     `node_attempts` row with `status='Running'`, and the node is agent-executed
     (`ai_coding | judge | orchestrator`). **`cli`/`check` nodes are refused with an explicit
     `PRECONDITION` naming the deferral** — the detached-group kill is NOT in v1 scope.
     `nodeId` / `nodeAttemptId` / `supervisorSessionId` are all `server-state`, never body fields.
  3. `checkpointSession(sessionId)` **pre-tx**: `EXECUTOR_UNAVAILABLE` ⇒ **re-throw, no mutation**
     (503, CB2); any other failure ⇒ log and proceed to the pause (the session is already gone).
  4. `needs-input.json` written pre-tx via `atomicWriteJson`, **unlinked in the catch** if the tx throws.
  5. ONE tx: CAS `Running → NeedsInput` (`WHERE status='Running'`) + `currentStepId = nodeId`;
     `markNodeNeedsInput(attemptId)`; insert the `node_interrupt` HITL; `createHitlAssignmentForRun`;
     `emitWebhookEvent('run.needs_input', {reason:'node_interrupt'})`;
     `emitDomainEvent('run.escalated', {reason:'node_interrupt'})`.
  **CB1**: if the tx never commits, the runner's own `STEP_CHECKPOINTED` handler
  (`runner-graph.ts:3354` → `markNodeNeedsInput` + park) converges on the same state — assert this
  with a test rather than assuming it.
  *Logging (verbose):* DEBUG every precondition; INFO `{runId, nodeId, nodeAttemptId, sessionId}` on
  checkpoint request and on successful park; WARN on a lost CAS; ERROR on the re-thrown 503.
  *Depends on:* 19, 5.

- [ ] **Task 21: Server-owned option matrix + response handler.**
  - Matrix derivation in `web/lib/runs/node-interrupt.ts`, surfaced through
    `web/lib/queries/run.ts` / `hitl.ts` / `inbox-context.ts` on the SAME `availableOptions` channel
    the `budget_breach` kind already uses (`run.ts:449-455`, `hitl.ts:332`, `inbox-context.ts:713`).
    Options: `resume` · `restart_node` (**default**) · `restart_from` (progressive disclosure) · `stop`.
    `restart_from`'s eligible target set is **ledger-derived** — nodes with ≥1 prior attempt in THIS
    run (the static graph has cycles, so it is not derivable from topology) — with the node's declared
    rework targets flagged `recommended: true` for the UI. **Forward skips are out of scope**: a target
    with no prior attempt is refused.
  - `handleNodeInterruptResponse` in `web/lib/services/hitl.ts`, added to the human-actor-only list at
    5077-5099 **and** the dispatch chain at 5151-5180 (D8). Structure copied from
    `handleHookTripResponse` (4481+), including the `lockHitlRow` → `respondedAt` → **already-delivered
    self-heal** branch that re-drives `scheduleResume(runId)` (CB3).
    - `resume` → leave the run awaiting; `scheduleResume(runId)`; the runner owns `NeedsInput→Running`.
    - `restart_node` / `restart_from` → ONE tx: `markNodeReworked(attemptId, {decision:'operator_interrupt',
      workspacePolicy})`; `markDownstreamStale(runId, [target, ...downstreamOf(graph, target)])` when the
      target differs from the interrupted node; `currentStepId = target`; stash the correction text and
      the resolved `session_policy`. The git `applyWorkspacePolicy` runs **BEFORE** the tx against the
      target's `checkpoint_ref`, exactly like the M30 rework X-ATOMIC ordering (CB4); a missing
      `checkpoint_ref` **degrades to `keep` with a WARN**, never a guess. Then `scheduleResume(runId)`.
      Because the closing row is `Reworked` (not `NeedsInput`), `resumingThisNode` is false, so
      `reusesCurrentAttempt` is false and `runGraph` appends a **fresh** attempt — the mechanism this
      design relies on (A11); pin it with a test.
    - `stop` → delegate to the existing `stopWorkbenchRun` terminal stop. No new stop semantics.
  - Session policy: resolve through the ADR-081 chain with an operator-restart tier leaning
    `new_session`, and **record the resolved value on `node_attempts.session_policy`** — never leave it
    implicit.
  *Logging (verbose):* DEBUG the full derived matrix with each option's enabled/disabled reason; INFO
  the chosen option + target + workspace policy + resolved session policy; WARN on the checkpoint_ref
  degrade; WARN on a rejected `targetNodeId`.
  *Depends on:* 20.

- [ ] **Task 22: Feature-B consumer fanout sweep.**
  Work the Feature-B column: `rg "'hook_trip'" web/` and mirror **every** hit for `node_interrupt`
  — `web/lib/run-transcript/transcript.ts` (60/81/386/434/442), `web/lib/ext-activity/run-feed.ts:241`,
  `web/lib/assignments/service.ts:81`, `web/lib/queries/observatory.ts:178,633`, the keepalive sweeper
  passes, the reconcile classifier, the inbox/board read models, `web/lib/errors-core.ts` if a new cell
  is needed. For each hit: mirror, or record "not mirrored because …". Assert with tests: the
  `node_interrupt` park is idled to `NeedsInputIdle` and 24h-abandoned like `hook_trip` (CB5); the
  recovery sweep does **not** classify it `Crashed`; a machine/agent token is refused at the chokepoint.
  *Deliverable:* a checklist in the PR body enumerating every `hook_trip` site and its verdict.
  *Depends on:* 21.

- [ ] **Task 23: Correction-comment prompt append (D6).**
  `web/lib/flows/graph/runner-graph.ts` — where the P7 run-context pointer is appended
  (~1538-1545), append a second fenced, labelled block carrying the operator correction for the
  restarted attempt only. It is **not** a template variable: it is never passed through Mustache and
  never touches `commentsVar`, so it works on any node type and cannot throw on strict-mode unknown
  vars. Length-capped, and captured in `node_attempts.resolved_prompt` like the rest of the prompt.
  *Logging (verbose):* DEBUG `{nodeId, attempt, correctionChars, truncated}`.
  *Verify:* unit test — the restarted attempt's `resolved_prompt` contains the fenced block; the next
  (non-restart) attempt does not; a node with no declared `commentsVar` still renders.
  *Depends on:* 21.

- [ ] **Task 24: Budget accounting — operator restarts must not burn `rework.maxLoops` (D7).**
  `web/lib/flows/graph/rework-baseline.ts` + the maxLoops check in `runner-graph.ts` (~2731):
  compute the node's effective attempt count as
  `attempt - (rework_baseline ?? 0) - operatorInterruptCount(runId, nodeId)`, where the operator count
  is the number of that node's closed attempts carrying `decision='operator_interrupt'`. Keep the
  helper pure and unit-testable; a run with zero operator restarts must be **byte-identical** to
  today. Add the safety cap: refuse `restart_node`/`restart_from` with `CONFLICT` once a run has
  `MAISTER_MAX_OPERATOR_RESTARTS` such attempts.
  *Logging (verbose):* DEBUG `{nodeId, attempt, baseline, operatorInterrupts, effective, maxLoops}` at
  every bound check; WARN when the safety cap refuses.
  *Verify:* unit tests — N operator restarts do not advance the rework epoch; a genuine rework still
  exhausts at `maxLoops + 1`; the cap refuses at N+1.
  *Depends on:* 21.

- [ ] **Task 25: Observatory exclusion + deployment wiring.**
  - `web/lib/queries/observatory-core.ts`: add `decision?: string | null` to
    `ObservatoryNodeAttemptInput` (20-29) and, in `rollupCorrectionMetrics` (215-255), exclude
    `decision === 'operator_interrupt'` rows from **`reworkCount`** *and* subtract them from the
    per-`(run,node)` `retryCount` (`max(attempt) - 1`) — **both**, per A10; excluding only one leaves
    the metric inflated. Thread `decision` through the feeding query in `web/lib/queries/observatory.ts`.
  - Deployment: add `MAISTER_MAX_OPERATOR_RESTARTS` (default `10`) to `.env.example`, the web
    `environment:` block in `compose.yml`, `compose.production.yml`, `deploy/maister.env.example`, and
    the env-vars **table** in `docs/configuration.md` (the table is canonical — prose is not enough).
  *Verify:* unit tests over `rollupCorrectionMetrics` — a run with only operator restarts has
  `correctionRate === 0`; a mixed run counts only the genuine reworks.
  *Depends on:* 24.
  <!-- Commit checkpoint: Commit 6 (Tasks 20-25) -->

## Phase 4 — Feature B UI, tests, docs

- [ ] **Task 26: UI — interrupt control + option matrix.**
  Run-detail node view (`web/app/(app)/runs/[runId]/layout.tsx` + the HITL response components
  `web/components/board/run-hitl-response.tsx` / `hitl-decision-controls.tsx`, which already consume
  `availableOptions`): an **icon + label** "Interrupt node" button on a live agent node; on the park,
  a card with **Restart this node** as the one-click default, an optional correction textarea, a
  workspace-policy selector, **Resume as-is**, **Stop run**, and "Restart from an earlier node" behind
  progressive disclosure (eligible targets from the server, declared rework targets visually flagged
  as recommended). Disabled options render their server-supplied reason.
  *Verify:* `renderToStaticMarkup` tests for each option state, the disclosure, and the disabled cases.
  *Depends on:* 22, 21.

- [ ] **Task 27: i18n (Feature B).** All new strings into BOTH `en.json` and `ru.json`, keys
  identical: option labels, the correction placeholder, workspace-policy labels + explanations, every
  refusal message, the safety-cap message, the `cli`/`check` deferral message.
  *Depends on:* 26.

- [ ] **Task 28: Feature-B test-integrity audit + edge-case sweep.**
  Same five-step audit as Task 17, over the `T-B*` set: **runnability** (`vitest list` for both
  projects, including the new `web/app/api/runs/[runId]/node-interrupt/__tests__/**` family);
  **traceability closure** (every `AC-B*` green, every `T-B*` id greppable in its `describe`/`it`);
  **overlap prune**; **triviality prune**; **unowned edge cases** added here:
  - an interrupt racing the node's own completion (CAS loser ⇒ no park, no orphan HITL);
  - a restart whose target node's `checkpoint_ref` was GC'd between park and response (degrade to
    `keep` + WARN, per REQ-B7);
  - two operators responding to the same `node_interrupt` HITL (the `already-delivered` branch, CB3);
  - a `restart_from` naming a node that exists in the graph but has **no** prior attempt in this run
    (refused — the forward-skip guard, REQ-B6);
  - the interaction of the safety cap with a genuine flow-authored rework budget (`humanGate`
    auto-pass × operator restart — a **policy-axis interaction**, which full single-axis coverage
    would miss).
  *Verify:* the same four written lists as Task 17.
  *Depends on:* 20, 21, 22, 23, 24, 25.

- [ ] **Task 29: Feature-B e2e + docs as-built + mandatory docs checkpoint.**
  Playwright spec `web/e2e/node-interrupt.spec.ts`: running agent node → Interrupt → card shows the
  four options → Restart this node with a correction → the node re-runs.
  Flip every Phase-0 Feature-B doc tag `Designed → Implemented`; run `/aif-docs` for the mandatory
  documentation checkpoint across `run-continuation.md`, `runs.md`, `manual-takeover.md`,
  `workbench-lifecycle.md`, `hitl.md`, `flow-graph.md`, `flow-dsl.md`, `web.openapi.yaml`,
  `error-taxonomy.md`, `configuration.md`, `database-schema.md` + `docs/db/domain-events.md` (the
  `0125` CHECK), and `flow-dsl-grammar.ts`.
  **AC conformance gate:** walk `AC-B1..B13` and name the green test for each; any AC without one
  fails the phase (same resolve-or-amend rule as Task 19). Re-verify the spec's Non-goals still hold.
  **Final spec reconciliation:** flip the spec header from
  `Status: SDD freeze for Phase 0. No production code is implemented by this spec.` to
  `Status: Implemented (ADR-159 / ADR-160).` and record any amendment made during implementation.
  *Phase exit:* `pnpm --filter maister-web test` fully green · `eslint .` check-only clean ·
  `pnpm validate:docs` · `pnpm validate:docs:adr` · **`pnpm validate:contracts`** · both AC walks.
  *Turns green:* AC-B13.
  *Depends on:* 28, 27.
  <!-- Commit checkpoint: Commit 7 (Tasks 26-29) -->

---

## Phase 5 — Integration hygiene

- [ ] **Task 30: ADR renumber pass (its own focused session, AFTER rebasing onto main).**
  Re-read `max(### ADR-NNN)` from `git show main:docs/decisions.md`; if a parallel branch has taken
  159/160, renumber **both** ADRs and every citation — including prose forms (`grep -rn 'ADR-159\|ADR-160'`
  across `docs/`, `web/`, `supervisor/`, `.ai-factory/`) and the decisions index table. Re-run the ADR
  anchor check. If a migration was introduced mid-implementation, re-read `max(idx)` from
  `_journal.json` at main's HEAD, renumber the **triple** (SQL file + `_journal.json` entry +
  `meta/<NNNN>_snapshot.json`), verify the newest journal entry has a matching snapshot, and fold it
  back into this plan's reserved-numbers table.
  *Verify:* `git diff main...HEAD --stat` shows no duplicate ADR header; anchor check green; suite green.
  *Depends on:* 29.

---

## Explicit non-goals (do not implement)

Operator-selected re-entry node for Feature A · `run_kind ∈ {agent, scratch}` for Feature A (agent runs
carry no `node_attempts`, so there is no anchor, no re-entry, and no traversal to resume — D3) ·
merge or AI conflict resolution on ingest (recorded as
a future ADR-141-resolver enhancement) · forward node skips · interrupting `judge`/gate **command**
executions mid-command (only node turns; `cli`/`check` interrupt refused with a named deferral) ·
multi-node batch restarts · per-run flow-manifest editing · `Done` runs (the ADR-141 reopen path stays
as-is) · a Flow Studio editor for `reentry` (round-trip preservation only, D9) · any ext-API / MCP
surface for `node_interrupt` (D8) · any new `runs.status` value, `node_attempts` status enum value, or
adapter fork.

---

## Owner decisions (resolved 2026-08-31 — locked, do not re-litigate)

1. **`run_kind = flow` only.** Confirmed. Rationale recorded in D3 and ADR-159: agent runs carry no
   `node_attempts`, so there is no anchor, no re-entry node, and no graph traversal to resume.
   Refusal is explicit and early (Task 9), not a fall-through.
2. **Release target = `Review`.** Confirmed as planned (Task 11).
3. **Claim anchor = last executed node.** Confirmed. Anchoring on the re-entry was never the better
   option — it would make the shielding collision happen *always* instead of sometimes. The real
   finding is that the collision is the general case either way, which is why D10 fixes the shared
   helper (Task 11A).
4. **`MAISTER_MAX_OPERATOR_RESTARTS = 10`.** Confirmed (Tasks 24-25).
5. **Emit domain events for claim/return.** Confirmed → D11 + Task 11B. **This costs migration
   `0125`** (the `domain_events_kind_check` CHECK is real); the Reserved-numbers table is corrected.
6. **No follow-up for the M11b staleness question — fix it properly now.** Confirmed → D10 is
   unconditional and shared (Task 11A), with the M11b behaviour settled by test rather than by
   argument, and assertion migration in-scope.
7. **ADR-142 citation drift gets its own task.** Confirmed → Task 3A, with an investigate-don't-invent
   procedure and no new ADR number allocated.

## Resolved (was "Still open")

- **Webhook types for claim/return** — **DECIDED 2026-08-31 (owner): domain events + webhooks.**
  Task 11B emits both, symmetrically with the domain events and mirroring `hook-trip.ts`. The
  matching webhook types land in `docs/api/async/outbound-webhooks.asyncapi.yaml` (Task 5).
