# Implementation Plan (SDD): Priority-Ordered Dependency-Draining Task Queue

Branch: claude/silly-tharp-febe29
Created: 2026-06-30
Method: Specification-Driven Development (spec is the contract) → Test-Driven implementation (RED → GREEN → refactor)

## Settings
- Testing: yes (TDD — every Acceptance Criterion binds to at least one test; RED first)
- Logging: verbose
- Docs: yes (mandatory checkpoint; specs are authored in Phase 0 BEFORE any code)

## Roadmap Linkage
Milestone: "none"
Rationale: Net-new activating layer + scheduler-admission unification over the shipped M31/M34 triage+relations substrate. Consciously promotes VISION "autonomous task pulling" out of Not-MVP — recorded in ADR-121.

---

## 1. Problem Statement & Verified Premise

The "operator writes raw tasks → triager assigns Flow/runner/dependencies → tasks auto-drain in dependency order" loop is **already built end-to-end** (M-triage, ADR-111/112). Three code audits confirmed it. This plan does **not** rebuild it. It adds the four Variant-B gaps plus the scheduler-admission unification the owner's answers require.

**Substrate to reuse unchanged** (verified, file:line):
- Relation graph `taskRelations` (`web/lib/db/schema.ts:3396`), kinds `blocks | depends_on | parent_of | requires | duplicate_of` (`web/lib/social/relations.ts:27-32`); `getOpenRelationBlockers` (`relations.ts:216`, `requires` success-gated).
- Launchability allow-list `classifyTaskLaunchability` (`web/lib/runs/launchability.ts:65`).
- 60s drain tick `runAutoLaunchTriagedJob` (`web/lib/scheduler/handlers/auto-launch-triaged.ts:139`) — kept as the BACKSTOP.
- Concurrency cap + promote (`web/lib/scheduler.ts`): `countLiveRuns:127`, `tryStartRun:299`, `promoteNextPending:432`, `releaseSlotOnIdle:413`.
- Triager verdict write `applyTriageVerdict` (`web/lib/services/triage.ts:165`) / `verdictColumns` (`:145`); human task write `updateTask` (`web/lib/services/tasks.ts:365`) / `updateColumns` (`:332`); project settings PATCH (`web/app/api/projects/[slug]/settings/route.ts:70-169`).

**Verified facts that shape the design:**
1. Slot is held by `runs.status ∈ {Running, NeedsInput, HumanWorking}` per pool (`scheduler.ts:127-150`). `NeedsInputIdle/WaitingOnChildren/Pending/Review`/terminals hold no slot.
2. Every slot-free event (17 sites, incl. hung-session kill `promoteAfterTimeoutKill` `keepalive-sweeper.ts:716`) already calls `promoteNextPending`, which today selects **only `runs WHERE status='Pending'` ordered by `started_at` FIFO** — never a Backlog task, no priority.
3. **Idle-run resume BYPASSES the cap by explicit design** (`web/lib/runs/resume.ts:58-59` "Resumes bypass the scheduler cap (D2)"). A burst of HITL answers can push a pool over cap.
4. No `priority` on `tasks`/`runs`. Concurrency cap is global (no per-project cap; reserved-unbuilt `scheduler.ts:642-646`).
5. `updateTaskVerdict` (`triage.ts:219`) is **dead** (test-only); there is no MCP tool literally named `triage_set` in the product facade — the agent write surface is the HTTP ext-API tree under `app/api/v1/ext/` (MCP tools wrap it).
6. Run status enum (`schema.ts:1302-1318`): `Pending·Running·NeedsInput·NeedsInputIdle·HumanWorking·WaitingOnChildren·Review·Crashed·Done·Abandoned·Failed`. Terminal = `Done·Failed·Crashed·Abandoned` (`run-status-sets.ts:10-27`).

## 2. Goals / Non-Goals

**Goals**
- G1 Cycle-safe relation authoring (no silent deadlock; sharper because an agent authors edges).
- G2 Priority as a first-class, dual-writable task attribute backed by a criticality dictionary.
- G3 A single priority-ordered admission gate that, on any freed slot, admits the most critical eligible unit of work among {Pending runs, eligible Backlog tasks, answered-idle resumables}.
- G4 Fix the resume over-cap correctness bug by routing resume through the gate ("smart return to queue").
- G5 Per-project queue settings (env global default + project override).
- G6 Advisory triage confidence (stored, queryable, Observatory-fed) — never a routing gate.
- G7 **Pause/dequeue safety valve** — an operator can ALWAYS pause a task's implementation: remove it from auto-admission (C2) and auto-resume (C3) without losing its config, reversibly; stopping any in-flight run reuses existing stop/abandon and the pause prevents auto-relaunch.

**Non-Goals (explicit)**
- NG1 Per-project concurrency cap (cap stays global; reserved-unbuilt).
- NG2 Cross-project fairness/weighted-share scheduling (global criticality order only).
- NG3 Confidence-based auto/human routing (owner: advisory only; any future gate = a new ADR).
- NG4 Replacing the 60s poll tick (it remains the crash/missed-event backstop).
- NG5 Priority starvation prevention / aging (note as future; v1 is operator-controlled).

## 3. Reserved Numbers (2026-06-30)
- ADR **ADR-121 — CLAIMED.** Next free across all committed branches was 120, but a parallel plan-only branch owns **ADR-120 and merges first** (owner directive) → this work moved to **ADR-121** (free on all committed branches). Stub header + Index row written in `docs/decisions.md` (Status: Proposed) so the number is owned and citations resolve.
- Migration **0087** (max idx in `_journal.json` = 86 on this branch; highest file `0086_yellow_pyro.sql`).
- ⚠ Uncommitted parallel-agent sessions could still grab 120/0087 → **Phase 8 mandatory renumber pass** after rebase onto main + `scripts/validate-docs-adr-anchors.mjs`. A green `pnpm validate:docs` is NOT numbering evidence.

---

## 4. SPECIFICATION (the contract — authored in Phase 0, binds all tests)

### 4.1 Data model (migration 0087, table `web/lib/db/schema.ts`)
| Change | Column | Type | Null | Default | Notes |
|---|---|---|---|---|---|
| `tasks` | `priority` | text + CHECK | NOT NULL | `'normal'` | closed set `{low,normal,high,urgent}`, mirrors `triageStatus` text-enum convention |
| `tasks` | `triage_confidence` | `numeric(4,3)` | NULL | NULL | advisory only; **DB CHECK** `triage_confidence IS NULL OR (triage_confidence >= 0 AND triage_confidence <= 1)` (precision alone permits 1.001/negatives — F4) |
| `projects` | `task_queue_settings` | `jsonb` | NULL | NULL | zod `taskQueueSettingsSchema`; NULL ⇒ env defaults |
| `runs` | `resume_requested_at` | `timestamptz` | NULL | NULL | set when an idle run's HITL is answered and it awaits a slot |
| `tasks` | `queue_paused` | `boolean` | NOT NULL | `false` | operator pause: excludes the task from auto-admission (C2) and auto-resume (C3); reversible, config-preserving |
| `tasks` | `queue_claimed_at` | `timestamptz` | NULL | NULL | **C2 admission CLAIM (F1):** CAS-set under the scheduler lock BEFORE `launchRun` — because `launchRun` is worktree-first (`runs.ts:972` addWorktree precedes `:1049` insert), no `runs` row exists at claim time, so the claim cannot live on `runs`. Prevents concurrent edge/poll/direct double-admission; cleared once the run row exists OR on launch failure; reconcile sweeps stale claims |
| `runs` | `queue_admitted_at` | `timestamptz` | NULL | NULL | **Origin marker (NOT the claim):** set at the run-INSERT inside `launchRun` (`runs.ts:1049`) for queue-admitted runs; the precise `liveAuto` counter (INV-9); immutable launch-origin snapshot. NULL ⇒ run was manual/scratch/resume (incl. ADR-119 force-relaunch of an auto task) |

No `priority` on `runs` (admission reads `tasks.priority` LIVE at selection — re-prioritization must take effect for not-yet-admitted work; not snapshotted). No new `runs.status` value (answered-idle reuses `NeedsInputIdle` + `resume_requested_at`).

### 4.2 Criticality dictionary (single source of truth, `web/lib/tasks/criticality.ts`)
Closed map enum→integer weight, higher = more critical: `{ low:100, normal:200, high:300, urgent:400 }`. The dictionary is the ONLY ordering source; admission and promote tiebreak both call it. Runs with no task default to `normal` weight.

### 4.3 Project queue settings + env defaults
- `taskQueueSettingsSchema` = `{ edgeDrain?: boolean, maxInFlightAuto?: number }` (`.strict()`, room to grow).
- Env global defaults, read like `capFromEnv()` (`scheduler.ts:80-91`):
  - `MAISTER_TASK_QUEUE_EDGE_DRAIN` (default `on`).
  - `MAISTER_TASK_QUEUE_AUTO_RESERVE` (default `2`) — flow-pool slots reserved from auto-drain (guaranteed headroom for scratch/manual/resume; see §4.4 capacity guards).
- Resolution (live, at admission): `project.task_queue_settings?.edgeDrain ?? envDefault`; `maxInFlightAuto` is per-project only (absent ⇒ unbounded). No launch snapshot (must be live-mutable).
- Write: extend `patchBodySchema` of `PATCH /api/projects/[slug]/settings` (`route.ts:24-29,132-145`), `editSettings` gate.
- **Capacity model context:** the **flow pool** (cap 6) is shared by `flow` + `scratch` run-kinds; the **agent pool** (cap 3) and the **assistant budget** (`MAISTER_MAX_CONCURRENT_ASSISTANTS`=5, `localPackageId`-scoped) are already fully separate (assistants never touch the flow pool — no reservation needed for them). The reserve protects scratch + manual flow launches from auto-drain only.

### 4.4 Unified admission gate (core algorithm)
`admitOnFreeSlot(pool)` replaces the body of `promoteNextPending`; same call sites unchanged (G3 needs no new event wiring). Under the existing scheduler advisory lock (`takeSchedulerLock`):
```
free = cap(pool) − countLiveRuns(pool); if free ≤ 0 → return
candidates =
  C1 Pending runs (pool)                               weight=taskWeight(run)   fifo=started_at
  C3 answered-idle runs (status=NeedsInputIdle ∧ resume_requested_at NOT NULL ∧ task NOT queue_paused, pool)
                                                        weight=taskWeight(run)   fifo=resume_requested_at
  C2 eligible Backlog tasks (pool=flow only) WHEN edgeDrain(project) enabled
        ∧ liveFlow < flowCap − AUTO_RESERVE                     (global reserve guard)
        ∧ liveAuto(project) < maxInFlightAuto(project)          (per-project share guard):
        classifyTaskLaunchability = launchable
        ∧ triageStatus='triaged' ∧ launchMode='auto' ∧ flow_id NOT NULL ∧ NOT queue_paused
        ∧ getOpenRelationBlockers = ∅
        ∧ NOT orchestrator/delegation (delegation_spec.agentId NULL ∧ not parent_of-under-orchestrator)
                                                        weight=taskWeight(task)  fifo=created_at
sort by (weight DESC, classRank, fifo ASC)
for c in first `free` candidates (FOR UPDATE SKIP LOCKED semantics):
   CLAIM c under lock; dispatch heavy work OUTSIDE lock (two-phase)
```
- **Ordering = strict criticality (Decision D-A, RESOLVED):** the primary key is criticality weight DESC, so a high-criticality fresh task (e.g. a blocker bugfix) preempts a freed slot ahead of a lower-criticality long-running resume. `classRank` is ONLY an **equal-weight tiebreak** (`C3 < C1 < C2`): at the same criticality, an answered-idle resume wins, then queued runs, then fresh tasks — this protects equal-priority sunk human cost without ever letting lower-priority work block critical work. Final tiebreak = `fifo` ASC. Accepted caveat: a *low*-criticality answered-idle resume can be starved by a stream of higher-criticality fresh tasks (v1; aging is the future fix — NG5).
- **Per-pool & separate (Q3 RESOLVED):** the gate runs INDEPENDENTLY per pool — flow cap `MAISTER_MAX_CONCURRENT_RUNS`=6 and agent cap `MAISTER_MAX_CONCURRENT_AGENTS`=3 stay fully separate (NG1). The **C2 Backlog-task source applies to the FLOW pool only** (Backlog tasks mint flow runs); the agent pool's candidates are C1+C3 only. INV-1 (cap-safe resume) applies to **both** pools — agent idle-resume (`web/lib/services/hitl.ts:608`) also bypasses the cap today and is routed through the gate.
- **Two-phase admission** (skill-context multi-store-atomic): under lock → CAS-claim only (C1: `Pending→Running` flip; C3: `NeedsInputIdle→Running` flip clearing `resume_requested_at`; C2: CAS `tasks.queue_claimed_at`); release lock → heavy launch (`launchRun` for C2 = git/worktree/insert; `session/resume` for C3; `runFlow`/`driveResume` for C1). Crash between claim and dispatch is recovered by the poll backstop + reconcile.
- **Capacity guards (C2 ONLY):** the two guards above gate ONLY the Backlog-task source. `liveFlow` = live runs in the flow pool; `liveAuto(project)` = live flow runs with `queue_admitted_at NOT NULL` **plus** outstanding C2 claims (`tasks.queue_claimed_at NOT NULL`) for that project — counting in-flight claims keeps the cap honored during the worktree window; it is NOT `task.launchMode='auto'`, which miscounts an ADR-119 force-relaunched manual run of an auto task. C1 (Pending runs), C3 (resume), and direct manual/scratch launches (`tryStartRun`) are NOT subject to these guards — they use the full cap. Effect: auto-drain's aggregate flow-pool footprint never exceeds `flowCap − AUTO_RESERVE`, and per project never exceeds `maxInFlightAuto`; the reserve stays available for scratch/manual/resume.
- **Single selection funnel (DRY):** the eligibility + ordering + capacity-guard logic is ONE shared selector. Both `admitOnFreeSlot` (slot-free gate) and the 60s `auto-launch-triaged` poll backstop call it — the poll never re-implements selection, so priority order, the reserve/`maxInFlightAuto` guards, and `queue_paused` apply identically on both paths.
- **C2 claim marker (F1 — task-level, executable):** a Backlog task has NO run row until `launchRun` creates it (worktree-first), so the claim CANNOT be `runs.queue_admitted_at`. The two-phase claim is a CAS on **`tasks.queue_claimed_at`** (`NULL → now()`) under the lock; the heavy `launchRun` runs after release; the new run row carries `queue_admitted_at` (origin) at insert. Clear `queue_claimed_at` once the run row exists (the run's `busy` status now serializes), or on `launchRun` failure (+ give-up→`flagged`). A stale `queue_claimed_at` (set, no run, past a timeout) is reconcile-swept. This is what makes INV-3 exactly-once executable under concurrent edge/poll/direct admission (today's singleton-tick assumption — `auto-launch-triaged.ts:120` — no longer holds).
- **Cap invariant:** admission count ≤ `free`; resume no longer bypasses (G4), both pools. Pool size never exceeds cap.

### 4.5 Resume re-entry ("smart return to queue", reverses D2)
Resume **ALWAYS** routes through the gate (cap-safe), **independent of `edgeDrain`** (F2 — cap-safety is a correctness property, not a feature toggle; gating it would reintroduce the very D2 over-cap bug G4 fixes). The HITL respond path for a `NeedsInputIdle` run sets `resume_requested_at = now()` and calls `admitOnFreeSlot` instead of the unconditional `resumeRun` bypass; the run is admitted when its criticality+classRank wins a free slot. `edgeDrain` gates ONLY the C2 fresh-Backlog-task source — NOT resume (C3) and NOT priority ordering (both unconditional).

### 4.6 Cycle-safe relations
A relation insert/modify of a **gating kind** (`blocks|depends_on|requires`) MUST be refused with `MaisterError("CONFLICT")` (HTTP 409) when it would close a cycle, evaluated INSIDE the insert transaction (no TOCTOU). `parent_of`/`duplicate_of` skip the check. Reachability normalizes `blocks` and its inverse `depends_on` to one directed edge.

### 4.7 API contract deltas (BOTH `docs/api/web.openapi.yaml` AND `docs/api/external/operations.openapi.yaml`)
| Route | Spec file | Change |
|---|---|---|
| `POST/DELETE …/tasks/[number]/relations` (web) | web.openapi | add `409 CONFLICT` response (relation cycle) |
| `POST/DELETE /api/v1/ext/…/tasks/{taskId}/relations` (agent) | **operations.openapi** | add `409 CONFLICT` response (relation cycle) |
| `PATCH/PUT …/tasks/[number]` (human) | web.openapi | add `priority` (enum), `triage_confidence` (number), `queue_paused` (bool) to request schema; `422 CONFIG` on out-of-set |
| `POST /api/v1/ext/…/tasks/{taskId}/triage` (agent) | **operations.openapi (`:369`)** | add `priority`, `confidence` request fields; `priority`/`confidence` are INDEPENDENT of `flag` (F6) |
| `PATCH …/projects/[slug]/settings` | web.openapi | add `taskQueueSettings` to `patchBodySchema` |

**Validation (acceptance):** BOTH `docs/api/web.openapi.yaml` and `docs/api/external/operations.openapi.yaml` MUST pass `npx @redocly/cli lint` with zero errors (docs/CLAUDE.md R3); leaving the external spec stale breaks MCP/agent-token clients (Codex-2).

### 4.8 Invariants (must-hold, testable)
- INV-1 A pool's live count NEVER exceeds its cap, including under a resume burst (G4 fix). **Unconditional — independent of `edgeDrain`.**
- INV-2 A blocked task is NEVER admitted; priority is a tiebreak WITHIN eligibility, never overrides a blocker or the cap.
- INV-3 Exactly-once admission per eligible unit across {edge, poll, direct launch, resume} (CAS claim).
- INV-4 The criticality dictionary is the ONLY ordering source; no ad-hoc weights.
- INV-5 `triage_confidence` is NEVER read by any admission/launch/routing path (advisory).
- INV-6 A gating-kind relation graph is acyclic at all times (enforced at write).
- INV-7 `edgeDrain` disabled ⇒ ONLY the C2 fresh-Backlog-task source is OFF (no slot-free auto-pull of new tasks; the 60s poll pulls none either). C1 (Pending promote) and C3 (resume) STILL flow through the cap-safe, priority-ordered gate. NOT a revert to pre-feature behavior — INV-1 (cap-safety) and priority ordering are unconditional (F2).
- INV-8 Auto-drain (C2) aggregate flow-pool footprint NEVER exceeds `flowCap − AUTO_RESERVE`; ≥`AUTO_RESERVE` flow slots are always claimable by scratch/manual/resume.
- INV-9 Per-project live auto-drained flow runs NEVER exceed `maxInFlightAuto` (when set).
- INV-10 A `queue_paused` task is NEVER admitted (C2), NEVER auto-resumed (C3), and NEVER picked by the 60s poll backstop, until unpaused; pause/unpause preserve all task config (deps/Flow/runner/priority).

---

## 5. Implementation Phases (TDD: RED → GREEN → refactor)

> Each task: write the failing tests named in its AC refs FIRST (RED), implement minimally to GREEN, then refactor to SOLID/KISS/DRY with the suite green. Per-phase exit = full suite green (`pnpm test:unit && pnpm test:integration`) + `vitest list` confirms each new test file is globbed.

### Phase 0 — SDD specs (docs-first, MANDATORY, no code)
- [x] **T1: expand ADR-121** (stub already claimed in `docs/decisions.md`, Status: Proposed → flip to Accepted at implementation): cycle-rule (gating-kinds, in-tx); unified admission gate (3 sources, classRank resume-first = Decision D-A); **D2 reversal** (resume through cap) with the explicit UX trade-off recorded; criticality dictionary; priority is tiebreak-not-override; confidence advisory-not-gate; queue setting live-not-snapshot; promotes VISION "autonomous task pulling" out of Not-MVP (+ 1-line cross-ref edit in `docs/VISION.md`). AC: anchor resolves.
- [x] **T2: system-analytics specs** (R5/R6 of `docs/CLAUDE.md`), each with Expectations as numbered ACs:
  - NEW `docs/system-analytics/task-queue.md` — Purpose, entities, the admission state machine (`stateDiagram-v2`), the `admitOnFreeSlot` flow (`flowchart`), Expectations = **ALL of INV-1..10** (F3 — reserve/per-project-share/pause/claim-exactly-once included, not just 1..7), Edge cases (each → `MaisterError` code), Linked artifacts.
  - UPDATE `scheduler.md` (gate replaces FIFO promote; cap invariant; task-level claim model), `tasks.md` (priority enum + criticality dict + confidence + `queue_paused` + `queue_claimed_at`), `triage.md` (confidence advisory note), `social-board.md` (cycle Expectation + Edge case), `hitl.md`/`runs.md` (resume re-entry + `resume_requested_at` + `queue_admitted_at` origin).
  - ERD artifacts: `docs/database-schema.md` + `docs/db/{runs-domain,projects-domain}.md` + the **consolidated `docs/db/erd.md`** (Codex-3 — docs/CLAUDE.md "Adding a new artifact" R4 requires the consolidated ERD update) for **all 7 columns** (`tasks`: `priority`, `triage_confidence`, `queue_paused`, `queue_claimed_at`; `projects`: `task_queue_settings`; `runs`: `resume_requested_at`, `queue_admitted_at`). **Schema-doc parity check (acceptance):** every one of the 7 columns MUST appear in the Drizzle schema, the migration snapshot, `database-schema.md`, the relevant domain ERD(s), AND `db/erd.md`.
  - API deltas §4.7 into **BOTH** `docs/api/web.openapi.yaml` AND `docs/api/external/operations.openapi.yaml` (ext relations 409 + ext triage `priority`/`confidence` — Codex-2), each passing `npx @redocly/cli lint` (zero errors); `docs/configuration.md` env table + `docs/error-taxonomy.md` (CONFLICT relation-cycle case).
  - Implementation-status tags `Designed` (flip per phase). AC: `pnpm validate:docs` green + manual anchor pass; no spec describes code absent at its phase HEAD.

### Phase 1 — Data model & criticality dictionary (foundation)
- [x] **T3 (RED→GREEN→refactor): criticality dictionary** `web/lib/tasks/criticality.ts` — enum, `weightOf(priority)`, total coverage. Tests: weight strictly monotonic; every enum value mapped; unknown → type error / throws. LOG: n/a (pure).
- [x] **T4: migration 0087 + schema** — `tasks.priority` (text+CHECK), `tasks.triage_confidence` (numeric+CHECK 0..1, F4), `tasks.queue_paused`, `tasks.queue_claimed_at` (F1), `projects.task_queue_settings`, `runs.resume_requested_at`, `runs.queue_admitted_at` (**7 columns**); `web/lib/db/schema.ts` columns; regenerate drizzle snapshot/journal via `generate` (NOT hand-edited; verify `when` monotonic above DB max — memory drizzle-journal hazard). Tests: migrate clean on fresh + existing DB; priority CHECK rejects out-of-set; **confidence CHECK boundary tests — `-0.001` and `1.001` REJECTED, `0` / `1` / `NULL` accepted (F4)**. LOG: boot column-presence assert if pattern exists.

### Phase 2 — Cycle-safe relations (G1, independent)
- [x] **T5 (RED first): in-tx cycle detection** in `addTaskRelation` (`relations.ts:72`): recursive-CTE/bounded-DFS reachability over gating-kind edges scoped to project, inside the insert tx; throw `CONFLICT`. Normalize `blocks`/`depends_on`. RED tests: AC-G1a direct A→B,B→A→409; AC-G1b transitive A→B→C→A→409; AC-G1c self (existing) ; AC-G1d parent_of/duplicate_of never checked; AC-G1f valid add succeeds. LOG: `[relations.addTaskRelation] cycle-check {from,kind,to,verdict}` DEBUG, WARN+path on reject.
- [x] **T6: concurrency + surface tests** — AC-G1e real-PG integration: two tx racing to close a cycle, at most one commits (in-tx guarantee, mocked-unit is blind — memory M42 lesson). Confirm 409 maps at web route, ext route, and agent-token actor with no bespoke handling. Files: tests under `web/lib/social/__tests__/` + route integration globs.

### Phase 3 — Priority + confidence write paths (G2, G6 write half)
- [x] **T7 (RED→GREEN→refactor): human write path** — `priority` + `triage_confidence` through `updateColumns` (`tasks.ts:332`) + `patchBodySchema`/`putBodySchema` (`tasks/[number]/route.ts`), `editTask` gate, `Backlog`-gated mutability. Tests: round-trip SET/CLEAR(→`'normal'`/NULL)/re-SET (both halves mandatory — skill-context symmetry); out-of-set→422.
- [x] **T8: agent write path** — `priority` + `confidence` through `verdictColumns` (`triage.ts:145`) + ext triage `postBodySchema` (`triage/route.ts:42`), scope `tasks:triage`. `priority`/`confidence` are **INDEPENDENT** of the `flag` set (owner decision, F6) — NOT added to `VERDICT_FIELDS`; settable alongside a `flag`. Tests: agent-actor SET/CLEAR/re-SET; confidence range 0–1 else 422; priority+flag together accepted. **Refactor (DRY):** extract one shared column-mapper used by both human + agent paths (the two mappers diverge today). LOG: `[triage.applyVerdict] priority,confidence` DEBUG.
- [x] **T9: advisory invariant test (INV-5)** — a grep/static test proving NO admission/launch/scheduler module reads `triage_confidence`; a behavioral test that confidence value does not change any admission outcome.
- [x] **T9b (RED→GREEN→refactor): pause/dequeue (G7, INV-10)** — `tasks.queue_paused` write via the human task PATCH (`updateColumns`, `editTask` gate); exclude paused tasks from the **60s poll backstop** candidate query (`auto-launch-triaged.ts`) too (the C2/C3 admission filters land in Phase 5 via §4.4). Reversible, config-preserving. Tests: pause → armed task with cleared blockers is NOT picked by the poll tick; unpause → picked again; pause preserves flow/runner/priority/relations; stopping an in-flight run of a paused task does NOT auto-relaunch (combine with existing stop/abandon). LOG: `[tasks.pause] {taskId,paused}` INFO.

### Phase 4 — Project queue settings + env default (G5)
- [x] **T10 (RED→GREEN): settings resolver** — `taskQueueSettingsSchema` = `{ edgeDrain?, maxInFlightAuto? }`; `resolveEdgeDrain(project)` = `project.task_queue_settings?.edgeDrain ?? envDefault(MAISTER_TASK_QUEUE_EDGE_DRAIN, on)`; `resolveAutoReserve()` = `envDefault(MAISTER_TASK_QUEUE_AUTO_RESERVE, 2)`; `resolveMaxInFlightAuto(project)` = `project.task_queue_settings?.maxInFlightAuto ?? Infinity` (env readers modeled on `capFromEnv`). Tests: env on + project NULL→true; project false overrides env on; project true + env off→true; reserve env parse + default; maxInFlightAuto absent→unbounded; set/clear/re-set symmetry. LOG: `[queue.resolve] {projectId,edgeDrain,reserve,maxInFlightAuto,source}` DEBUG.
- [x] **T11: settings WRITE + deployment wiring** — extend `patchBodySchema` (`settings/route.ts:24-29`) + `update.taskQueueSettings` line (`:132-139`), `editSettings` gate; add `MAISTER_TASK_QUEUE_EDGE_DRAIN` and `MAISTER_TASK_QUEUE_AUTO_RESERVE` to `.env.example`, web `environment:` in `compose.yml` (+ prod overlay), `docs/configuration.md` env table. Tests: PATCH persists `edgeDrain`+`maxInFlightAuto`; range-validate `maxInFlightAuto` (≥1) else 422; route authz 403 for under-editSettings. Identifiers (skill-context): slug = `url-param` + `editSettings` `auth-context`; no body-controlled cross-resource id.

### Phase 5 — Unified admission gate (G3) — CORE
- [x] **T12a (RED→GREEN→refactor): shared admission selector (F2, DRY foundation)** — extract one `selectAdmissions(pool, free)` that builds C1+C2+C3 candidate descriptors, applies eligibility (launchability, `getOpenRelationBlockers`, `queue_paused`, `edgeDrain`, the reserve + `maxInFlightAuto` capacity guards), and sorts `(weightOf DESC, classRank, fifo ASC)`. **Both** `admitOnFreeSlot` and the 60s `auto-launch-triaged` poll backstop consume it — no second selection path. Pure-as-possible (candidate descriptors in, ordered eligible list out) for unit-testability. Tests: ordering + every guard, in isolation. This is the keystone for T7/T12/T13/T14.
- [x] **T12 (RED first): wire the selector into promote for C1 (Pending source)** — `promoteNextPending` calls `selectAdmissions`; replace `started_at` ASC with the selector's `(weight DESC, classRank, fifo)`, joining `tasks` for run priority (no-task→`normal`). Keep advisory-lock + `FOR UPDATE SKIP LOCKED`. Tests: two Pending runs, higher criticality promotes first; equal→FIFO; INV-2 (blocked never admitted) still holds.
- [~] **T13: add Backlog-task candidate source (C2) into the shared selector** behind `resolveEdgeDrain` + capacity guards — eligible Backlog tasks (launchability+triaged+auto+flow+unblocked+non-orchestrator+`NOT queue_paused`), gated by `liveFlow < flowCap − resolveAutoReserve()` and `liveAuto(project) < resolveMaxInFlightAuto(project)` where `liveAuto` counts `runs.queue_admitted_at NOT NULL` PLUS outstanding `tasks.queue_claimed_at NOT NULL` (F1). **Two-phase task-level claim (F1):** under lock CAS `tasks.queue_claimed_at` (`NULL → now()`); heavy `launchRun` runs OUTSIDE the lock; the created run carries `queue_admitted_at` at insert; CLEAR `queue_claimed_at` once the run row exists, OR on `launchRun` failure (dirty repo / branch exists / precondition) + route give-up→`flagged` (no stuck claim). Tests: AC-G3a slot freed by hung-session kill (`promoteAfterTimeoutKill`) pulls the next eligible task (not just a Pending run); AC-G3b higher-criticality fresh task beats lower-criticality Pending run (strict weight); AC-INV8 with reserve=2 and 4 live flow runs, no C2 admission though 2 slots free (reserve held for scratch/manual); a scratch launch into that reserve still admits; AC-INV9 project at `maxInFlightAuto` (counted off `queue_admitted_at` + claims) admits no further C2 but other projects do — and a force-relaunched MANUAL run of an auto task does NOT count toward it (F1); AC-F1-claim two concurrent admissions of the SAME task → exactly one claims `queue_claimed_at`, the other skips; AC-F4 launchRun failure clears `queue_claimed_at` and re-eligibility restores on next tick; AC-INV7 edgeDrain off → no fresh task pulled (C1/C3 still flow).
- [ ] **T14: route resume through the gate (C3, G4, reverse D2) — UNCONDITIONAL** — EVERY `NeedsInputIdle` resume path — BOTH flow (`web/lib/runs/resume.ts`) AND agent (`web/lib/services/hitl.ts:608`) — records `runs.resume_requested_at = now()` and enters the C3 admission gate via `admitOnFreeSlot`, **regardless of `edgeDrain`**. The legacy cap-bypass (`resume.ts:58-59`) is **REMOVED entirely** — there is NO `edgeDrain` branch on the resume path (F2/Codex-2; `edgeDrain` gates only the C2 fresh-task source, never resume). Tests (RED first): AC-G4a resume burst never exceeds cap (INV-1) asserted with `edgeDrain` **both on AND off**, for **both flow and agent** idle resumes — the regression for the `resume.ts:58-59` bug; AC-G3c answered-idle vs equal-criticality fresh task → resume wins (classRank resume-first).
- [ ] **T15: exactly-once + crash-window recovery + call-site audit (INV-3)** — CAS claim across C1/C2/C3 so edge + 60s poll + direct launch + resume cannot double-admit. **Crash windows (F1/F5):** name each new partial state in the `reconcile.ts` sweep filter — (a) `tasks.queue_claimed_at` set but NO run row created (crash between claim and `launchRun` run-insert), past a timeout → clear the stale claim, return task to eligible; (b) run created with `queue_admitted_at` but crashed before/during spawn → the existing `Running`/no-session → `Crashed` reconcile path covers it (verify the new column doesn't break that filter); (c) `resume_requested_at` set on a `NeedsInputIdle` run, crash before admission → re-evaluate via the selector. Honor slot-release contract (every terminal still promotes). **17-site audit (F3):** changing `promoteNextPending` to the 3-source gate means EVERY freed-slot caller (reconcile, cascade-abandon, workbench-stop, watchdog-kill, abandon/discard, keepalive-idle, …) can now mint a fresh Backlog-task run, not just resume a Pending run. Audit each of the 17 sites and confirm "fill the freed slot with any eligible work" is the intended semantics there (or scope it out per-site); none may silently assume pure-FIFO-of-Pending. Update read models that surface queue order. Tests: simulated double-fire → one admission; claim-then-crash → backstop recovers exactly one; per-site smoke that a freed slot admits the correct source.

### Phase 6 — Observatory surface for confidence (G6 read half)
- [x] **T16 (RED→GREEN): confidence in Observatory** — extend read layer (`web/lib/queries/observatory-*.ts`) with a low-confidence signal cluster + per-task value; read-only. Tests: low-confidence tasks surface; no mutation; still INV-5.

### Phase 7 — UI surfaces + i18n
- [ ] **T17: priority + confidence + pause on task card/detail** (read + human edit via T7/T9b PATCH; a **Pause/Resume** affordance — icon button per UI conventions — on the card and detail); **queue setting** control in `settings-panel.tsx` (admin-gated, via T11 PATCH). EN+RU i18n keys. Tests: renderToStaticMarkup smoke (project convention — memory) for card/detail/settings; pause toggle + priority edit round-trip. LOG: n/a.

### Phase 8 — Renumber pass + as-built + suite-green gate
- [ ] **T18: ADR/migration renumber pass** (own session, AFTER rebase onto main): re-derive next free ADR (`git show main:docs/decisions.md`) + migration idx (`_journal.json` on main); renumber if 0087/ADR-121 taken; re-migrate clean; run `scripts/validate-docs-adr-anchors.mjs`. AC: no duplicate idx/tag; anchors resolve.
- [ ] **T19: as-built docs flip + validators + green gate** — flip `Designed`→`Implemented`; `/aif-docs` checkpoint; `pnpm --filter maister-web lint` (scoped, NOT bare `eslint --fix` — memory); `pnpm test:unit && pnpm test:integration` green; quarantine any pre-existing red with tracked reason. **Doc/contract validators (Codex-2/3):** `pnpm validate:docs` (Mermaid) + `npx @redocly/cli lint docs/api/web.openapi.yaml` + `npx @redocly/cli lint docs/api/external/operations.openapi.yaml` (zero errors) + the 7-column schema-doc parity check (T2) + `scripts/validate-docs-adr-anchors.mjs`. AC: all validators pass; suite green; no stale `Designed` for shipped code.

---

## 6. Commit Plan
- C1 (T1-T2): "docs(queue): ADR-121 + SDD specs for priority-ordered task queue"
- C2 (T3-T4): "feat(db): migration 0087 + criticality dictionary"
- C3 (T5-T6): "feat(relations): cycle-safe task-relation save (ADR-121)"
- C4 (T7-T9): "feat(tasks): dual-write priority + advisory confidence"
- C5 (T10-T11): "feat(projects): per-project queue settings + env default"
- C6 (T12a-T15): "feat(scheduler): shared admission selector + unified priority-ordered gate + cap-safe resume"
- C7 (T16-T17): "feat(ui): confidence observatory signal + priority/queue surfaces"
- C8 (T18-T19): "chore(queue): renumber pass + as-built docs + suite-green"

## 7. Test Matrix (AC ↔ test; minimal overlap, no trivial tests)
| AC / INV | Test (RED first) | Level |
|---|---|---|
| G1a-f cycle | cycle-detection unit + route 409 | unit + integ |
| G1e TOCTOU | concurrent-tx cycle race | real-PG integ |
| G2 priority round-trip (human/agent) | mapper SET/CLEAR/re-SET ×2 paths | integ |
| INV-5 advisory | static no-read + behavioral no-effect | unit |
| G5 resolution | env/project precedence matrix | unit |
| G3a slot-free-kill pull | hung-kill → task admitted | integ |
| G3b/c ordering | criticality + classRank selection | unit (selector) + integ |
| INV-1 cap-safe resume | resume burst ≤ cap (D2 regression) | integ |
| INV-3 exactly-once | double-fire + claim-crash | integ |
| INV-8 reserve | auto stops at cap−reserve; scratch fills reserve | integ |
| INV-9 per-project share | project at maxInFlightAuto; others unaffected | integ |
| F1 precise liveAuto | force-relaunched manual run of an auto task NOT counted as auto | integ |
| F1 task claim | concurrent admissions of one task → exactly one CAS `queue_claimed_at` | real-PG integ |
| F2 selector parity | poll backstop honors priority+reserve+maxInFlightAuto+pause | unit+integ |
| F4 claim-release | launchRun fail clears `queue_claimed_at`; task re-eligible next tick | integ |
| INV-10 pause | paused task not admitted/resumed/polled; unpause restores; config preserved | integ |
| INV-7 edgeDrain off | C2 off (no task pull); C1+C3 still cap-safe + priority-ordered (NOT pre-feature revert) | integ |
> Selector ordering logic is unit-tested in isolation (pure function over candidate descriptors) to avoid heavy integ overlap; integ tests assert wiring + cap + persistence only.

## 8. Risks & Decisions
- **Decision D-A (classRank policy) — RESOLVED: strict criticality.** Primary sort = criticality weight DESC; `classRank` (resume-first) is only an equal-weight tiebreak. Rationale (owner): a long-running low-criticality resume must NOT hold a slot ahead of a critical short feature/blocker-bugfix. Recorded in ADR-121.
- **Accepted caveat:** under strict criticality a low-criticality answered-idle resume can be starved by higher-criticality fresh tasks (a human answered, nothing runs). Accepted for v1 (NG5); aging is the future fix; ADR-121 notes it.
- **D2 reversal is UNCONDITIONAL (F2):** resume cap-safety is NOT gated by `edgeDrain` — gating it would reintroduce the over-cap bug. `edgeDrain` gates only the C2 fresh-task source. Cost: operator-resume UX changes (a just-answered run may wait for a slot when out-criticality'd) even with the queue feature "off". Mitigated: equal-weight resume tiebreak + cap-respect. Recorded in ADR-121.
- TOCTOU cycle + double-admit are the two correctness hot-spots → real-PG integ mandatory (mocked-unit blind).
- Priority starvation (NG5) accepted for v1; ADR notes aging as future.
- Migration/ADR contention (many unmerged branches) → Phase 8 renumber pass mandatory.

## 9. Decisions log (owner-resolved)
1. ✅ D-A classRank: **strict criticality** (equal-weight resume tiebreak). §4.4/§8.
2. ✅ `flag` mutual-exclusion: `priority`/`confidence` are **independent** of the verdict `flag` set.
3. ✅ C2 candidates: **flow pool only**; agent pool stays separate (per-pool gate); cap-safe resume covers both pools. §4.4.
4. ✅ `task_queue_settings` content: `{ edgeDrain, maxInFlightAuto }` + global env `MAISTER_TASK_QUEUE_AUTO_RESERVE` (reserve flow-pool headroom for scratch/manual/resume). `defaultPriority`/`autoDrainPaused` NOT included (deferred; jsonb grows cheaply). Assistants already isolated on a separate budget — no reservation needed.
