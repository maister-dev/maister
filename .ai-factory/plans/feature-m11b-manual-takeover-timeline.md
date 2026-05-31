# M11b — Manual takeover (local worktree handoff) + run-detail timeline

> Second slice of the split M11 milestone. Implement on a matching
> `feature/m11b-manual-takeover-timeline` branch so branch-based consumers
> (`/aif-implement`, `/aif-verify`) discover this file.

## Context

M11 ("Flow graph maturity") was split into **M11a / M11b / M11c** (ADR-029,
landed by the M11a plan). M11a ships the execution-model foundation: Flow graph
v1 manifest + node lifecycle compile + append-only `node_attempts` ledger +
review-driven rework loop + full-featured gate execution
(`command_check` / `ai_judgment` / `skill_check` / `human_review`), with
staleness propagation (`markDownstreamStale`) and override-without-erasure.
M11a deliberately defers **manual takeover** and the **rich run-detail timeline**
to M11b, and **node typed settings + enforcement** to M11c.

This plan delivers **M11b**: the **manual-takeover** slice and the
**run-detail-timeline** slice of roadmap M11.

Today the run-detail page (`web/app/(app)/runs/[runId]/page.tsx`) is minimal —
header + a single pending-HITL panel sourced from `getRunDetail`
(`web/lib/queries/run.ts`). There is no timeline, no notion of current-vs-stale
gates on the page, no concept of a human claiming a run to work on it locally,
and the `runs.status` enum union (`web/lib/db/schema.ts`, `runs` table) has no `HumanWorking`
state. `web/lib/worktree.ts` exposes only `addWorktree` / `removeWorktree` /
`listWorktrees` — no `git log`, no `git diff`, no checkout helpers — so the
worktree handoff has no plumbing yet.

**Manual takeover = LOCAL WORKTREE HANDOFF** (ADR-011-consistent: no remote
required). The run already owns an isolated worktree
(`workspaces.worktree_path`) on a run branch (`workspaces.branch`) cut from the
project's parent repo. M11b exposes that *existing* path + branch to the
reviewer, who checks out / edits / commits **in place on the same host**. A
"return" action through the UI records the returned commit set
(`git log <base>..<branch>`) and the returned raw diff (`git diff <base>..<branch>`),
marks the validation re-entry node and everything after it **STALE** (reusing M11a's
`markDownstreamStale` + `gate_results` staleness), and forces a rerun before
merge. While claimed, the board card must show **owner, elapsed time, branch,
and a pending-return action**, and must NOT look like a normal running task.

Intended outcome of M11b: from a run paused at a `human_review` node (M11a), a
reviewer clicks **Take over** → run enters `HumanWorking`, the board card flips
to a takeover surface (owner / elapsed / branch / "return" action) → the
reviewer commits locally in the exposed worktree → clicks **Return** through the
UI → MAIster runs `git log`/`git diff` against the run branch, records the
returned commits + raw diff, marks downstream `checks`/`judge`/`review` gates
stale, and resumes the M11a graph runner from the declared validation re-entry
point so those gates **rerun** and the run reaches a **fresh review gate**. The
run-detail page renders the whole history in one timeline that distinguishes
**current vs stale** gates and shows every node attempt, decision, checkpoint,
handoff, returned commit, and rerun result.

## Scope boundary — what M11b does and does NOT include

| In M11b | Deferred |
| ------- | -------- |
| New run status `HumanWorking` (a REAL run status, unlike M11a rework which stays inside `Running`) | Branch targeting / base-branch selection / PR promotion mode (**M18**) |
| Manual takeover claim + return as a **local worktree handoff** (ADR-011, no remote) | Conflict-handoff promotion path + `Promote to <target>` (**M18**) |
| `worktree.ts` git ops: `logRange` (`git log <base>..<branch>`), `diffRange` (`git diff <base>..<branch>`) — read-only | `human_edit` / `merge` node *types* as first-class graph nodes (**M18** for `merge`; M11b models takeover as a run-state transition off the existing `human_review` node, not a new node type) |
| Record returned commit set + returned raw diff **MINIMALLY** (raw `git log`/`git diff` text into the ledger) | Typed `commit_set` / `diff` artifact *instances* + evidence-graph explorer (**M12**) |
| Reuse M11a `markDownstreamStale` + `gate_results` staleness on return; force downstream rerun | Node typed `settings` + capability enforcement (**M11c** / **M14**) |
| Single run-detail timeline: current vs stale gates, all `node_attempts`, decisions, checkpoints, handoffs, returned commits, rerun results | Role-based claim restriction (**M13** — claim is open to any project member in M11b) |
| Board takeover card: owner, elapsed time, branch, pending-return action | SLA / staleness-hint enforcement, takeover assignment object (**M13**) |
| EN+RU i18n for takeover + timeline + return strings | Graph / ledger / rework / gate-execution engine (**M11a**) |
| Playwright e2e: claim → board surface → local commits → return → diff in timeline → stale → rerun → fresh review | Push to a remote, GitHub PR, or any network git op (out of product scope per ADR-011) |

## Locked architecture decisions (from this session's directive → new ADR in Phase 0)

1. **`HumanWorking` is a real `runs.status` enum value** — distinct from M11a
   rework, which is a node-pointer move *within* `Running`. A run enters
   `HumanWorking` on a takeover claim and leaves it on return (→ `Running`, the
   graph runner reruns the declared validation path) or on release/abandon
   (→ back to `NeedsInput` or `Abandoned`). It counts against the global
   concurrency cap (ADR-009) exactly like `Running`/`NeedsInput`, because a
   claimed worktree holds a real slot. → **ADR-030**.
2. **Manual takeover is a LOCAL worktree handoff** (ADR-011-consistent). The
   takeover branch **IS the existing run branch** (`workspaces.branch`); no new
   target/PR/base-branch selection (that is M18). MAIster exposes the existing
   `worktree_path` + branch; the reviewer commits in place on the same host.
   No git push, no remote, no network op. → **ADR-030**.
3. **Return records commits + diff MINIMALLY as raw text in the ledger.** The
   return route runs `git log <base>..<branch>` (oneline) and
   `git diff <base>..<branch>` against the *existing* worktree, stores the raw
   output in the takeover `node_attempts` row's `vars` jsonb (and/or dedicated
   columns added in Phase 2). The full typed `commit_set`/`diff` *artifact
   instances* + evidence-graph explorer are **M12** — M11b does not create
   artifact rows. → **ADR-030**.
4. **On return, reuse M11a staleness.** The return path resolves the validation
   re-entry node from the **current `human_review` node's `transitions.takeover`**
   (NOT a hard-coded id) and stales **the re-entry node AND its downstream** —
   `markDownstreamStale(runId, [reentryNode, ...downstreamOf(graph, reentryNode)], db)`.
   The explicit `reentryNode` inclusion is REQUIRED: the as-built `downstreamOf`
   **excludes its start node** (in rework the start is the rework target — a
   gate-free ai_coding node that simply re-runs), but the takeover re-entry is a
   **gate-bearing** validation node whose prior PASS validated *pre-takeover*
   code and MUST flip stale so the human's commits are re-validated. `downstreamOf`
   is module-private in `web/lib/flows/graph/runner-graph.ts` — M11b **exports**
   it; `markDownstreamStale(runId, nodeIds, db)` is 2-arg as-built in
   `web/lib/flows/graph/ledger.ts`. This flips the re-entry + downstream
   `node_attempts`→`Stale` + their `gate_results`→`stale`, then the graph runner
   resumes at the re-entry so those gates rerun over the human's commits and a
   fresh `human_review` gate is produced. No new staleness machinery. → **ADR-030**.
5. **No new `MaisterError` code** (ADR-008 closed union). Takeover precondition
   failures map to existing codes: not-claimable / wrong-state → `PRECONDITION`
   (409); concurrent claim or conflicting return → `CONFLICT` (409); git op
   failure on return → `CONFLICT` (the `worktree.ts` convention for failed git
   ops). → **ADR-030**.

## Settings

- **Testing:** yes (project norm; every prior milestone shipped unit +
  integration suites, plus the M11b Playwright e2e below).
- **Logging:** verbose (`pino` DEBUG/INFO at each takeover transition: claim,
  return-start, `git log`/`git diff` capture, `markDownstreamStale` call, resume
  hand-back).
- **Docs:** mandatory checkpoint (route through `/aif-docs`). Docs are
  **Phase 0** (analytics-first per skill-context), reconciled as-built before
  completion.

## Development methodology (SDD + TDD)

This milestone is executed **spec-first then test-first**. Two disciplines bind
every phase; both are gates, not suggestions.

**SDD — the spec is the frozen contract.** Phase 0 produces the normative
artifacts (ADR-030, the run/HITL/manual-takeover analytics, `web.openapi.yaml`
for the two routes, the ERD, the failure-classification table, and the
per-route identifier-trust tables). These are **frozen before Phase 1**. Task
**0.11** authors a **spec→test traceability matrix** that maps every normative
clause (each OpenAPI status code, each failure-class row, each run-state
transition, each identifier-trust row) → the exact RED test that proves it → AC
→ Verify item. The matrix is the structural guard against a *mechanism that
contradicts its own acceptance prose* — the exact defect an adversarial review
caught in this plan once (patch `2026-05-31-13.53`: the staleness mechanism
disagreed with AC-4/Verify-#4). **Forward rule (0.12):** if a code phase needs
to deviate, update the spec artifact FIRST, then the matrix/test, then code —
never the reverse. (Phase 7 reconciles the *as-built* direction at the end; that
does not license skipping the forward rule mid-flight.)

**TDD — no production code without a failing test first (Iron Law).** Every code
task in Phases 1–5 follows **red → green → refactor**. Each phase opens with a
`(RED)` task: write the test, run it, and **watch it fail for the right reason**
(feature missing, not a typo). The RED task **blocks** its `(GREEN)` impl
task(s); refactor only while green. Pure-config artifacts (Drizzle schema, SQL
migrations, i18n message catalogs, the `flow.yaml` manifest) are the documented
TDD exception — tagged `(schema)` / `(i18n)` / `(manifest)` — but their
*behavioral consequences* (a new enum value counting toward the cap, a new
status surviving recovery) are still driven by a RED test.

**Test hygiene (folded from patches `2026-05-31-14.34` / `-13.53`):**

1. **Real `flows` row in every integration seed.** `tasks.flow_id` /
   `runs.flow_id` are `NOT NULL` + FK since migration `0000`. Any seed that
   inserts a `tasks`/`runs` row MUST insert a real `flows` row first and thread
   the non-null `flowId` — a `flowId: null` seed is a bug even when TypeScript
   accepts it (loosely-typed `drizzle(pool)` does not enforce insert nullability).
2. **Per-test / per-worker fixture isolation.** Unique ids per test (or
   `beforeEach` cleanup); never share a mutable row a unique constraint can
   collide on. E2e seeds are keyed by Playwright worker-index / spec-slug under
   `fullyParallel` so `m11a/m11b/m11c` authed specs cannot race.
3. **Verify gate runs bare.** Never pipe vitest/playwright through
   `tail`/`head`/`grep` when asserting pass/fail — the pipeline reports the last
   stage's exit code (a green `| tail` over a red suite is the worst false-green).
   Use `set -o pipefail` and check the bare exit status.

## Roadmap Linkage

- **Milestone:** "M11. Flow graph maturity: node lifecycle, typed settings,
  rework, and human takeover" — this plan delivers the **M11b** slice (manual
  takeover + run-detail timeline). M11a (graph + ledger + rework + gates) ships
  first and is a **hard dependency**; M11c (node settings + enforcement)
  follows.

### Hard dependency on M11a (state explicitly, order phases accordingly)

M11b **cannot** start its code phases until M11a has merged the following, all
consumed directly by M11b:

- `node_attempts` table + ledger helpers (`appendNodeAttempt`,
  `markNode*`, `getNodeAttemptsForRun`, `nextAttemptFor`) —
  `web/lib/flows/graph/ledger.ts`.
- `gate_results` table + gate-store helpers + the
  `pending|running|passed|failed|stale|skipped|overridden` lifecycle —
  `web/lib/flows/graph/gate-store.ts`.
- `markDownstreamStale(runId, nodeIds, db)` — `web/lib/flows/graph/ledger.ts`
  (2-arg as-built). The caller computes the set via `downstreamOf(graph, node)`
  (module-private in `web/lib/flows/graph/runner-graph.ts` — M11b exports it),
  which **excludes the start node**, so the takeover return passes
  `[reentryNode, ...downstreamOf(graph, reentryNode)]` to also stale the
  gate-bearing re-entry node.
- Graph compiler + runner (`web/lib/flows/graph/compile.ts`,
  `runner-graph.ts`) with the resume/CAS claim machinery and `runs.current_step_id`
  carrying the node id.
- The migrated `aif` flow on `nodes[]` reaching a `human_review` node.

Phase ordering below puts the M11a-consumption surface (Phase 0 design +
Phase 2 schema additive to M11a's `0010`) first, then the worktree git ops
(Phase 1, the one piece M11b owns end-to-end and can build in parallel), then
the takeover state machine + routes that need the ledger.

---

## Acceptance Criteria (M11b)

Each M11b AC names its originating roadmap **M11** criterion and the
Verification item that proves it. The M11a plan already carved roadmap #1/#2/#3
(graph/validation/rework), the gate/ledger sub-clause, and the #7-rework /
#8-graph-schema docs to M11a; #6-settings / #8-settings-schema to M11c;
#1-roles to M13; #1-MCP/tool/skill to M14. M11b owns the remainder.

**M11b owns:**

- **AC-1 (roadmap #4) — Manual takeover into `HumanWorking`.** A reviewer can
  claim a run paused at a `human_review` node; the run transitions to the real
  `HumanWorking` status; the *existing* worktree path + run branch are exposed;
  no new branch/target/PR is created (ADR-011 local handoff). → Verify #1.
- **AC-2 (roadmap #4) — Board takeover surface.** While `HumanWorking`, the
  board card shows owner, elapsed time, branch, and a pending-**return** action,
  and is visually distinct from a normal running task. → Verify #2.
- **AC-3 (roadmap #4) — Return imports commits + records returned diff.** The
  return action runs `git log <base>..<branch>` + `git diff <base>..<branch>`
  against the existing worktree and records the returned commit set + returned
  raw diff in the takeover `node_attempts` ledger row (minimal raw text; typed
  artifacts = M12). → Verify #3, #5.
- **AC-4 (roadmap #4) — Return marks downstream stale + forces rerun.** On
  return, the re-entry node and everything after it (`checks`/`judge`/`review`)
  go `stale` (M11a `markDownstreamStale` + `gate_results`, re-entry node
  included) and **must rerun** before merge; the
  graph runner resumes at the declared validation re-entry and produces a fresh
  `human_review` gate. → Verify #4, #6.
- **AC-5 (roadmap #5) — Single run-detail timeline.** The run-detail page renders
  ONE timeline that distinguishes **current vs stale** gates and shows ALL
  `node_attempts`, decisions, checkpoints, handoffs, returned commits, and rerun
  results (reading M11a `node_attempts` + `gate_results`). → Verify #7.
- **AC-6 (roadmap #7, takeover half) — `aif` demonstrates manual takeover.** The
  M11a-migrated `aif` flow's `human_review` node supports the `takeover`
  decision end-to-end. (`aif` rework half was AC-6 of M11a.) → Verify #1, #4.
- **AC-7 (roadmap #8, takeover docs) — Docs** cover manual-takeover semantics
  (local handoff, claim/return lifecycle, returned commits/diff, downstream
  staleness) and the run-detail timeline contract. → Verify #8.
- **AC-8 — Two-phase return commit.** The return route's commit-import is a
  downstream side-effect (git ops + ledger writes against the worktree); it uses
  a two-phase commit with the idempotency marker on the AFTER side and an
  explicit failure-classification table. → Verify #3, #9.

**Explicitly NOT M11b (hand-off carve — no clause double-listed):**

| Clause / capability | Owner | Why not M11b |
| ------------------- | ----- | ------------ |
| Flow graph v1, validation, node lifecycle compile (#1/#2 graph half) | **M11a** | Engine foundation; M11b consumes it |
| Review-driven rework loop within `Running` (#3) | **M11a** | M11b's takeover is a separate REAL status (`HumanWorking`), not the in-`Running` rework jump |
| Append-only `node_attempts` ledger + `gate_results` + `markDownstreamStale` | **M11a** | M11b reads/extends them; does not introduce them |
| Full-featured gate execution (`command_check`/`ai_judgment`/`skill_check`/`human_review`) | **M11a** | M11b reruns them on return; does not build the gate engine |
| Node typed `settings` + runtime capability enforcement (#6, #8-settings) | **M11c** / **M14** | Out of scope; takeover does not enforce node capabilities |
| Typed `commit_set` / `diff` **artifact instances** + evidence-graph explorer | **M12** | M11b records raw `git log`/`git diff` text in the ledger only |
| Base-branch / target-branch selection, PR promotion mode, `Promote to <target>` | **M18** | Takeover branch == existing run branch; no remote, no target |
| `merge` node type + conflict-handoff manual-resolution assignment | **M18** | M11b has no promotion/merge surface |
| Role-restricted claim, takeover assignment object, SLA enforcement | **M13** | M11b claim is open to any project member; ownership recorded, not gated by role |
| Roles validation in human nodes (#1 roles) | **M13** | — |
| Unknown MCP/tool/skill refs (#1 caps) | **M14** | — |

> The `aif` takeover demo (AC-6) requires only the `takeover` decision to be
> present on the `human_review` node's `transitions` and the
> `finish.human.decisions` — the M11a manifest schema already supports this
> (the `flow-dsl.md:104` example lists `takeover`). M11b wires the runtime
> behaviour behind that already-valid decision.
>
> **(P9) `transitions.takeover` routes to a REAL M11a node, NOT `human_edit`.**
> The `flow-dsl.md` design example (`:107`) wires `takeover → human-edit`, but
> `human_edit` is an M18-Designed node TYPE that M11b does not implement. In
> M11b the takeover is a run-state transition (`HumanWorking`) off the existing
> `human_review` node, and on RETURN the runner resumes at
> `transitions.takeover` pointing to a **validation re-entry node — `checks`**
> (re-run the gates over the human's commits), **never `implement`** (that would
> re-run the agent and clobber the human's local edits) and **never
> `human_edit`**. Phase 0.7 corrects `flow-dsl.md:107` accordingly.

---

## Phase 0 — Analytics, schema design, ADR (docs-first; no code) 🔴 gate before any code

Per skill-context: analytics is an **input** to implementation. This phase MUST
be complete and internally consistent before Phase 1. Exit criterion: every
artifact below exists, cross-references resolve, and implementation-status tags
(Implemented/Designed/Phase 2) are correct for HEAD-after-M11b.

| # | Task | Files | Acceptance |
| - | ---- | ----- | ---------- |
| 0.1 | ADR-030 (manual-takeover local worktree handoff: `HumanWorking` real status, existing run branch, raw `git log`/`git diff` recorded, reuse M11a staleness, no new MaisterError code) | `docs/decisions.md` (append, index row) | 1 ADR `Accepted`, sequential after ADR-029 (M11a), template-conformant; cites ADR-006/008/009/011/018/021/028/029 |
| 0.2 | Update run state machine for `HumanWorking`: add the enum state + transitions `NeedsInput→HumanWorking` (claim), `HumanWorking→Running` (return → rerun validation path), `HumanWorking→NeedsInput` (release without changes), `HumanWorking→Abandoned` (abandon). **MUST state three invariants:** (1) `HumanWorking` is a REAL run status (unlike M11a rework, which is a node-pointer move within `Running`); (2) `HumanWorking` counts against the global cap exactly like `Running`/`NeedsInput` (ADR-009) — a claimed worktree holds a slot; (3) the takeover branch IS `workspaces.branch` (no new branch/target — M18); **(4) (P6) `HumanWorking` is session-less BY DESIGN (the human edits locally, no live ACP session) yet HOLDS a worktree — so it MUST be EXCLUDED from the startup recovery sweep classification — as-built that orphan→`Crashed` path is `runResumeRecoverySweep` in `web/lib/runs/resume-recovery.ts` (there is NO `reconcile.ts`), whose SELECT filters `status='NeedsInput'`, so `HumanWorking` is excluded by construction; and the "at most one live ACP session" invariant in `runs.md` must be amended to "`HumanWorking` runs intentionally have no live session"** | `docs/system-analytics/runs.md` | new state drawn in the `stateDiagram-v2`; recovery flowchart confirms `HumanWorking` is excluded; "at most one live ACP session" invariant updated; status names match `runs.status` enum exactly |
| 0.3 | Update HITL flow for the `takeover` decision: the `human_review` HITL's `takeover` decision drives `NeedsInput→HumanWorking` (a state transition, not an artifact write); on **return**, the validation re-entry mirrors the M11a rework re-entry but is triggered by the takeover return, not a reviewer `rework` decision. Mark the live HITL `permission/form/human` paths unchanged | `docs/system-analytics/hitl.md` | takeover decision tree + return sequence drawn; states the return path is two-phase (claim intent → git/ledger side-effect → AFTER-side marker) |
| 0.4 | New system-analytics doc: manual-takeover domain (per `docs/CLAUDE.md` R5 — Purpose / Domain entities / State machine / Process flows / Expectations / Edge cases / Linked). Cover claim, the exposed worktree contract, return (`git log`/`git diff` capture), downstream staleness, rerun, and the run-detail timeline read model | `docs/system-analytics/manual-takeover.md` (new) | every claim/return precondition + transition enumerated **exactly as code will gate** (allow-list shape); timeline read model (current-vs-stale) specified |
| 0.5 | ERD: `node_attempts` takeover columns (`owner_user_id`, `returned_commits`, `returned_diff`, `base_ref`) and the `HumanWorking` run status; document that M11b's migration is `0011` (additive to M11a's `0010`) (BOTH artifacts) | `docs/database-schema.md` + `docs/db/runs-domain.md` (+ `docs/db/erd.md`) | narrative AND Mermaid `erDiagram` both updated; M11a `node_attempts` table shown with the new columns appended |
| 0.6 | API contract: new routes `POST /api/runs/{runId}/takeover/claim` and `POST /api/runs/{runId}/takeover/return`. Document method, path, request body (claim: empty; return: empty — `git log`/`git diff` run server-side against the pinned worktree, NO body-controlled refs), status codes (claim: 200 / 401 / 403 / 404 / 409; return: 200 / 401 / 403 / 404 / 409 / 503), and the per-route identifier-trust table. Document the two-phase return commit + failure-classification | `docs/api/web.openapi.yaml` | both routes present with bodies, statuses, example payloads; identifier-trust table inline in prose; return route documents idempotency marker on AFTER side |
| 0.7 | Promote `docs/flow-dsl.md` "Planned M11" manual-takeover paragraph (`flow-dsl.md:182-186`) → Implemented for the **M11b subset**; tag the typed `commit_set`/`diff` artifact half as **M12-Designed** and the `human_edit`/`merge` node types as **M18-Designed**. Note the run-detail timeline in the run domain. **(P9) ALSO fix `flow-dsl.md:107`: the canonical example currently wires `transitions.takeover → human-edit` (an M18 node type); change it so `takeover` routes to a real M11a validation node (`checks`) matching the M11b runtime, and annotate that the `human_edit` node TYPE remains M18-Designed.** | `docs/flow-dsl.md` | manual-takeover prose marked Implemented for the local-handoff subset; artifact-instance + node-type halves tagged deferred; `:107` example points `takeover → checks`, not `human-edit` |
| 0.8 | **Contract-surface tracing table** (skill-context): map each changing surface → spec file (see below) | this plan + Phase 0 docs | every surface in the table has an owning task |
| 0.9 | **(P10) Roadmap reconciliation** (delegate to roadmap owner). M11b inherits roadmap #4/#5/#7-takeover/#8-takeover. Roadmap criterion #4's Expectation prose says the reviewer "commit and **push** changes" — this contradicts ADR-011 (local handoff, no remote). Rewrite the #4 Expectation from "commit and push" to "commit changes **locally**". VERIFY (do not re-distribute) that M11b's inherited roadmap row matches the **authoritative three-way carve authored in the M11a plan** — every slice must run roadmap reconciliation, none silently skips it | `.ai-factory/ROADMAP.md` via `/aif-roadmap` | #4 prose says "commit locally"; M11b inherited row verified against M11a carve; ownership boundary respected |
| 0.10 | **(P12) Pin the real run-abandon surface.** **FINDING (0.10): there is NO user-facing run-abandon surface today.** `web/app/api/runs/[runId]/` contains only `activity`/`hitl`/`stream` — no `abandon/` route. The ONLY code path that sets a *run* to `Abandoned` is the automated idle-TTL sweeper `runPass2` in `web/lib/runs/keepalive-sweeper.ts:254` (`NeedsInputIdle → Abandoned` on TTL). `markIntentAbandoned` in `web/lib/runs/resume-driver.ts:137` abandons an HITL *intent* (writes `hitl_requests` audit metadata), NOT the run status. `web/lib/runs/state-transitions.ts` has NO abandon helper. So **abandon is ADDED in M11b/Phase 3.5**, with these concrete paths: route handler `web/app/api/runs/[runId]/abandon/route.ts` (new) calling a new CAS helper `markAbandoned(runId)` in `web/lib/runs/state-transitions.ts` (new); for a `HumanWorking` run the route first calls `releaseHumanWorking(runId)` then the standard abandon transition, then `promoteNextPending` to free the slot. (`web/CLAUDE.md` already lists `POST /api/runs/[id]/abandon` as a planned-but-unbuilt route.) | this plan + the located file | the real abandon surface named (or "to be added in Phase 3.5"); Phase 3.5 file path is concrete, not `[runId]/...` |
| 0.11 | **Spec→test traceability matrix (SDD).** Author the matrix below: every normative spec clause (each OpenAPI status code for both routes, each failure-classification row, each run-state transition, each per-route identifier-trust row) → the exact RED test (`file::name`) that proves it → owning AC → Verify item. The matrix is the gate that **mechanism == acceptance prose**; an unmapped clause or a clause whose mechanism contradicts its AC blocks Phase 1 | this plan (matrix table below) + Phase 0 specs | every normative clause has exactly one owning RED test; no clause unmapped; matrix cross-references resolve to AC + Verify ids |
| 0.12 | **Spec-freeze (SDD forward rule).** Record that Phase 0 artifacts are frozen before Phase 1: any code-phase deviation updates the spec artifact FIRST, then the matrix/test, then code. Phase 7 owns the reverse (as-built) reconciliation and does not license skipping the forward rule mid-flight | this plan + Phase 0 docs | rule recorded; Phase 7 reconciliation cross-referenced as the as-built (not forward) pass |

**Contract surfaces this milestone touches (skill-context trace):**

| Surface | Spec file |
| ------- | --------- |
| New `POST /api/runs/{runId}/takeover/claim` route (path, method, statuses, body, two-phase semantics) | `docs/api/web.openapi.yaml` + this route prose |
| New `POST /api/runs/{runId}/takeover/return` route (path, method, statuses, body, two-phase + failure table) | `docs/api/web.openapi.yaml` + this route prose |
| New `runs.status` value `HumanWorking` (enum change) | `web/lib/db/schema.ts` + `docs/database-schema.md` + `docs/db/runs-domain.md` + `docs/system-analytics/runs.md` |
| New `node_attempts` columns (`owner_user_id`, `returned_commits`, `returned_diff`, `base_ref`) | migration `0011` + `docs/database-schema.md` + `docs/db/runs-domain.md` ERD |
| New `worktree.ts` read-only git ops (`logRange`, `diffRange`) — internal lib, not a wire surface | `docs/system-analytics/manual-takeover.md` + `docs/system-analytics/workspaces.md` (note the new ops) |
| Run-detail timeline read model (current-vs-stale gates, attempts, handoffs) | `docs/system-analytics/manual-takeover.md` + `docs/system-analytics/runs.md` |
| (none — see note) M11b adds **NO new `MaisterError` code** (closed union, ADR-008) | `docs/error-taxonomy.md` unchanged; takeover precondition → `PRECONDITION`/`CONFLICT`; git-op failure → `CONFLICT` |

> **Deployment-touchpoints (skill-context rule):** M11b introduces **NO new env
> var, bound port, sidecar binary, or config-file path**. The two new routes run
> in the existing Next.js web tier; git ops run via the existing `execFile`
> plumbing in `worktree.ts`; no supervisor change is required (takeover does not
> spawn an agent — the human edits locally). Therefore **no
> `Dockerfile`/`compose.*`/`.env.example` change is required**. This is stated
> explicitly per the skill-context deployment rule: nothing to wire.

### Spec→test traceability matrix (SDD — authored in 0.11, frozen before Phase 1)

Each normative clause maps to the RED test that proves it, the owning AC, and the
Verify item. `file::name` is the canonical test id used by the `(RED)` tasks in
Phases 1–6. No row may ship green until its mechanism matches its AC prose.

| Normative clause (spec source) | RED test (`file::name`) | AC | Verify |
| ------------------------------ | ----------------------- | -- | ------ |
| `claim` 200 + body `{worktreePath,branch,ownerUserId}` (OpenAPI 0.6) | `takeover.test.ts::claim-from-NeedsInput-returns-200-context` | AC-1 | V1 |
| `claim` 409 `PRECONDITION` wrong run state / non-`human_review` node | `takeover.test.ts::claim-wrong-state-409` | AC-1 | V1 |
| `claim` 409 `CONFLICT` concurrent claim (CAS lost) | `takeover.test.ts::concurrent-claim-409` | AC-1 | V1 |
| `claim` 401/403 unauth / non-member (authz spec) | `takeover.test.ts::claim-unauthorized-401-403` | AC-1 | V1 |
| `claim` 404 run not found / not visible (OpenAPI 0.6) | `takeover.test.ts::claim-run-not-found-404` | AC-1 | V1 |
| `return` 401/403 unauth / non-owner (OpenAPI 0.6) | `takeover.test.ts::return-unauthorized-401-403` | AC-1 | V7 |
| `return` 404 run not found / not visible (OpenAPI 0.6) | `takeover.test.ts::return-run-not-found-404` | AC-1 | V7 |
| `return` 200 only AFTER side-effects commit (two-phase, AC-8) | `takeover.integration.test.ts::return-flips-Running-after-sideeffects` | AC-8 | V7 |
| `return` 409 `PRECONDITION` not-`HumanWorking` (already returned) | `takeover.test.ts::return-not-HumanWorking-409` | AC-8 | V7 |
| `return` 403 session user ≠ `owner_user_id` | `takeover.test.ts::non-owner-return-403` | AC-1 | V7 |
| `return` 409 `CONFLICT` git op fails → no statechange, no ledger write | `takeover.integration.test.ts::git-failure-no-statechange` | AC-8 | V7 |
| `return` 503 `EXECUTOR_UNAVAILABLE` ledger throw mid-side-effect → stays `HumanWorking` | `takeover.integration.test.ts::ledger-throw-503-stays-humanworking` | AC-8 | V7 |
| `return` records `returned_commits`+`returned_diff`+`base_ref` on takeover attempt | `takeover.integration.test.ts::return-records-commits-and-diff` | AC-3 | V3 |
| `return` stales `[reentryNode, …downstreamOf]` incl. re-entry's prior gate | `takeover.integration.test.ts::return-stales-reentry-and-downstream` | AC-4 | V4 |
| runner resumes at `transitions.takeover` (`checks`), staled gates rerun → fresh `human_review` | `takeover.integration.test.ts::resume-reruns-staled-gates` | AC-4 | V4 |
| `HumanWorking` holds a cap slot through BOTH predicates (`scheduler.ts:78`+`:160`) | `scheduler.integration.test.ts::humanworking-occupies-slot-both-paths` | AC-1 | V1 |
| `HumanWorking` excluded from recovery sweep (survives restart, not `Crashed`) | `resume-recovery.test.ts::humanworking-survives-restart` | (ADR-030) | V1 |
| Identifier trust: `return` accepts EMPTY body, ALL refs (worktreePath/branch/baseRef/owner) server-derived (no body-controlled ref) | `takeover.integration.test.ts::return-ignores-body-refs-uses-server-state` | AC-8 | V7 |
| `logRange`/`diffRange`/`resolveBaseRef` + ref/path validation + diff truncation marker | `worktree-range.test.ts::*` | AC-3 | V3 |
| Timeline current-vs-stale gates + handoff block (owner/elapsed/branch/commits/diff) | `run-timeline.integration.test.ts::*` + `run-timeline.test.ts::*` | AC-5 | V5/V6 |
| Board: `HumanWorking` in-flight + owner/elapsed/branch/return, distinct from running | `board*.test.ts::*` + `flight-card*.test.ts::*` | AC-2 | V2 |
| Transition `HumanWorking → NeedsInput` (release, no changes — review HITL re-opens) | `state-transitions.integration.test.ts::release-humanworking-returns-needsinput` | (ADR-030) | V1 |
| Transition `HumanWorking → Abandoned` (abandon via Phase-3.5 surface, then `promoteNextPending`) | `state-transitions.integration.test.ts::abandon-humanworking-frees-slot` | (ADR-030) | V1 |
| Failure-class row 5: resume kickoff fails AFTER status flip → 200, runner handles crash (no new mechanism — reuses M11a `runFlow` terminal precedence) | `web/lib/flows/__tests__/runner.*` (M11a, already green — no new RED) | AC-8 | V7 |
| e2e: claim→board→commit→return→diff→stale→rerun→fresh-review | `m11b-takeover.spec.ts` | AC-1..6 | V9 |

> **Matrix completeness note (0.11).** Every normative clause above has exactly
> one owning row. Three clauses are owned outside the takeover route tests by
> design: the `HumanWorking → NeedsInput` (release) and `HumanWorking → Abandoned`
> (abandon) run-state transitions are proven by the **Phase-2 `state-transitions`
> CAS-idempotency RED tests** (helpers `releaseHumanWorking` / `markAbandoned`),
> not by a route contract test; and failure-class row 5 (resume kickoff fails
> *after* the AFTER-side status flip → still 200) is **not a new mechanism** — it
> reuses M11a's already-tested `runFlow` terminal-precedence path, so it carries
> no new RED test. No clause is unmapped.

### Spec-freeze (0.12 — recorded)

**Phase 0 artifacts are FROZEN as of this gate** (ADR-030; `runs.md` / `hitl.md` /
`manual-takeover.md`; the `RUNS.status` + `node_attempts` ERD in
`database-schema.md` / `db/runs-domain.md` / `db/erd.md`; the two
`web.openapi.yaml` takeover routes; `flow-dsl.md`; `ROADMAP.md` #4; and the
matrix above). They were authored and validated (`pnpm validate:docs:all` →
77/77 Mermaid blocks pass; `redocly lint web.openapi.yaml` → valid) before any
Phase-1 code.

**Forward rule (binding through Phases 1–6).** If a code phase needs to deviate
from a frozen artifact, update **the spec artifact FIRST, then the matrix row +
the RED test, then the code** — never the reverse. A code change whose mechanism
contradicts its AC prose (the patch `2026-05-31-13.53` defect) is rejected at
review. **Phase 7 owns the reverse, AS-BUILT reconciliation** (flip
Implemented/Designed tags, re-derive contract surfaces from the diff); Phase 7's
existence does NOT license skipping this forward rule mid-flight.

---

## Phase 1 — `worktree.ts` git ops for the handoff (M11b-owned, no M11a dependency)

This is the one piece M11b owns end-to-end and can build in parallel with M11a
landing. `worktree.ts` today has only `addWorktree`/`removeWorktree`/`listWorktrees`
— no `git log`, `git diff`, or checkout. Add read-only range ops; no merge, no
push, no checkout-switch (the worktree is already on the run branch).

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 1.0 (RED) | New `web/lib/__tests__/worktree-range.test.ts` (**verified: no `worktree` test file exists today** → new file, not extend) against a temp git fixture (real `git init` + commits in `os.tmpdir()`): assert `logRange`/`diffRange`/`resolveBaseRef` happy path; ref/path validation **rejects `..` and bad branch names**; diff **truncation marker** on an oversized diff. Run `vitest run --project unit worktree-range` and **watch every case fail** (functions absent) | `web/lib/__tests__/worktree-range.test.ts` (new) | RED verified — fails because feature missing, not a typo; `vitest list` shows the file under `unit` (glob `lib/**/*.test.ts`) |
| 1.1 (GREEN) | `logRange({ worktreePath, baseRef, branch })` → runs `git -C <worktreePath> log --oneline --no-color <baseRef>..<branch>`, returns the raw stdout text (commit oneline list). Reuse the existing `execFileAsync` + `AbortSignal.timeout(GIT_TIMEOUT_MS)` + `EXEC_MAX_BUFFER` plumbing and the `branchNameSchema`/`absolutePathSchema` validators; `baseRef` validated by a ref schema (`/^[A-Za-z0-9_./-]+$/`, no `..`) | `web/lib/worktree.ts` | DEBUG log on invocation; git failure → `MaisterError("CONFLICT", …)` (matching the file's convention); INFO on success with commit count; 1.0's `logRange` cases GREEN |
| 1.2 (GREEN) | `diffRange({ worktreePath, baseRef, branch })` → runs `git -C <worktreePath> diff --no-color <baseRef>..<branch>`, returns raw unified diff text (bounded by `EXEC_MAX_BUFFER`; on overflow truncate with a marker, do not throw) | `web/lib/worktree.ts` | DEBUG log; same error convention; 1.0's truncation-marker case GREEN |
| 1.3 (GREEN) | `resolveBaseRef({ worktreePath, branch, mainBranch })` → resolves the merge-base for the range: `git -C <worktreePath> merge-base <mainBranch> <branch>` (the run branch was cut from the project default branch per ADR-011). Returns the base SHA used as `<baseRef>` for 1.1/1.2 | `web/lib/worktree.ts` | base SHA returned; missing/ambiguous → `CONFLICT`; 1.0 case GREEN |
| 1.4 (GREEN) | Export `LogRangeArgs`, `DiffRangeArgs` types | `web/lib/worktree.ts` | consumed by the return route; full file GREEN, suite still green |

> **Trust-before-execute note (skill-context):** these ops do NOT fetch/install
> third-party content — they read git state from an already-trusted, already-on-disk
> worktree created by `addWorktree`. The fetch-then-execute rule (M10) does not
> apply. No `bash -c` of repo-sourced scripts here; `execFile("git", [...])` with
> validated args only.

---

## Phase 2 — DB migration `0011`: `HumanWorking` status + `node_attempts` takeover columns

Additive to M11a's `0010`. Depends on M11a's `node_attempts` table existing.

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 2.0 (RED) | Author the failing tests for ALL Phase-2 **behavior** before the helpers exist: (a) ledger `claimTakeover`/`recordTakeoverReturn`/`getActiveTakeover` append + read; (b) CAS `markHumanWorking`/`markReturnedToRunning`/`releaseHumanWorking` status-guard idempotency (concurrent loser → `{ok:false}` → 409); (c) scheduler counts `HumanWorking` through BOTH the initial-promote (`scheduler.ts:78`) AND under-lock-recheck (`:160`) predicates; (d) a `HumanWorking` run **survives a simulated restart** without flipping `Crashed`. **Integration seeds MUST insert a real `flows` row and thread a non-null `flowId` into `tasks`/`runs` (NOT-NULL + FK since `0000`, patch 14.34); unique fixture ids per test (no shared mutable rows).** Run and **watch all fail** | `web/lib/runs/__tests__/state-transitions.integration.test.ts` (extend), `web/lib/__tests__/scheduler.integration.test.ts` (extend), `web/lib/flows/graph/__tests__/ledger.test.ts`, `web/lib/runs/__tests__/resume-recovery.test.ts` | RED verified; seeds non-null `flowId`; per-test isolation; owns matrix rows `humanworking-occupies-slot-both-paths` + `humanworking-survives-restart` |
| 2.1 (schema) | Add `HumanWorking` to the `runs.status` enum union in the Drizzle schema; the Postgres column is `text` (enum constraint enforced in TS), so the migration is a metadata-only change — confirm `drizzle-kit generate` emits an additive `0011` (no destructive alter). Update `RunStatus` type consumers | `web/lib/db/schema.ts`, `web/lib/db/migrations/0011_*.sql` | `RunStatus` includes `HumanWorking`; migration additive; existing rows unaffected |
| 2.2 (schema) | Add takeover columns to M11a's `node_attempts`: `owner_user_id text` (FK → `users.id`, `ON DELETE SET NULL`), `base_ref text`, `returned_commits text`, `returned_diff text` (raw git output; nullable — only the takeover attempt rows populate them). Index unchanged (already `(run_id)`) | `web/lib/db/schema.ts`, migration `0011` | columns additive; only takeover attempts populate them; FK to users |
| 2.3 (GREEN) | Takeover ledger helpers extending M11a's `web/lib/flows/graph/ledger.ts`: `claimTakeover({ runId, nodeId, userId })` (append a `node_attempts` row of the human node with `status='NeedsInput'`-equivalent takeover marker + `owner_user_id`), `recordTakeoverReturn({ runId, nodeId, baseRef, returnedCommits, returnedDiff })`, `getActiveTakeover(runId)` | `web/lib/flows/graph/ledger.ts` (extend) | DEBUG log per transition incl. attempt number + owner; helpers reuse `nextAttemptFor` |
| 2.4 (GREEN) | Run state-transition helpers (mirror M8 `web/lib/runs/state-transitions.ts` CAS pattern): `markHumanWorking(runId, userId)` (`UPDATE runs SET status='HumanWorking' WHERE id=:id AND status='NeedsInput'`), `markReturnedToRunning(runId)` (`… status='Running' WHERE id=:id AND status='HumanWorking'`), `releaseHumanWorking(runId)` (`… status='NeedsInput' WHERE id=:id AND status='HumanWorking'`) — all status-guarded for idempotency | `web/lib/runs/state-transitions.ts` (extend) | each helper returns `{ok}`; concurrent claim loses the CAS → `{ok:false}` → 409; no direct `runs.status` writes outside helpers |
| 2.5 (GREEN) | Scheduler cap: add `HumanWorking` to the cap predicate (ADR-009 — a claimed worktree holds a slot). **(P6) Update BOTH sites in `web/lib/scheduler.ts` — the initial-promote predicate (`scheduler.ts:78`) AND the under-advisory-lock recheck predicate (`scheduler.ts:160`); as-built both read `inArray(runs.status, ["Running", "NeedsInput"])` → add `"HumanWorking"`.** | `web/lib/scheduler.ts` | both predicates include `HumanWorking`; unit test asserts a `HumanWorking` run occupies a slot through BOTH the initial-promote and under-lock-recheck paths |
| 2.6 (GREEN) | **(P6) Recovery + sweeper enumeration for `HumanWorking`.** Verify `web/lib/runs/resume-recovery.ts` (`runResumeRecoverySweep`, as-built selects `status='NeedsInput' AND acpSessionId IS NOT NULL`) does NOT classify a `HumanWorking` run (session-less by contract, holds a worktree) orphan→`Crashed` on startup — excluded by construction, but add an explicit guard + test; confirm the keepalive sweeper SELECTs (`web/lib/runs/keepalive-sweeper.ts`) do not sweep `HumanWorking` (it has no `keepalive_until` / is not `NeedsInputIdle`). Regression: a `HumanWorking` run survives a simulated restart WITHOUT flipping to `Crashed` | `web/lib/runs/resume-recovery.ts`, `web/lib/runs/keepalive-sweeper.ts` | recovery skips `HumanWorking`; regression green |
| 2.7 (types) | Type export refresh (`RunStatus`, `NodeAttempt` with new columns) + drizzle peer-dep `as any` cast pattern matching M11a/`runner.ts` | `web/lib/db/schema.ts` | — |

> **DB symmetry note (skill-context):** no YAML→DB removable field is persisted
> in M11b (takeover columns are runtime-derived, not config-sourced), so the
> SET/CLEAR/re-SET round-trip rule does not apply (N/A).

---

## Phase 3 — Takeover claim + return routes (state machine + two-phase return)

The hard core. Two routes wired to the M11a graph runner. Claim is a pure state
transition; return is the two-phase commit with the git/ledger side-effect.

### Identifier trust labels (skill-context — per route)

**`POST /api/runs/{runId}/takeover/claim`:**

| Identifier | Source | Trust |
| ---------- | ------ | ----- |
| `runId` | path parameter validated by route shape | `url-param` |
| `userId` (claim owner) | Auth.js session | `auth-context` |
| `projectId` | DB join from the run row | `server-state` |
| current `human_review` node id | `runs.current_step_id` (server-state) | `server-state` |

No `body-controlled` field. Claim body is empty.

**`POST /api/runs/{runId}/takeover/return`:**

| Identifier | Source | Trust |
| ---------- | ------ | ----- |
| `runId` | path parameter | `url-param` |
| `userId` (must equal current owner) | Auth.js session | `auth-context` |
| `projectId`, `worktreePath`, `branch`, `mainBranch` | DB join from run → workspace → project | `server-state` |
| `baseRef` | `resolveBaseRef` over server-state branch/mainBranch | `server-state` |

**No body-controlled cross-resource id.** The return route takes an empty body
— the worktree path, branch, base ref, and owner are ALL derived from
server-state (the pinned run/workspace/project rows). This is the skill-context
default: never accept a body field naming a filesystem path / branch / ref when
the handler already holds a server-state value for it.

### Two-phase commit for the **return** route (downstream side-effect)

The return route's success depends on git ops + ledger writes against the
worktree (a side-effect outside the route's own status row). Two-phase per
skill-context:

1. **Order of operations.** BEFORE the side-effect: under a `SELECT … FOR
   UPDATE` on the run row, assert `status='HumanWorking'` AND
   `owner_user_id = session.userId` AND not terminal; this is the *intent* read,
   no idempotency marker yet. THEN run `git log`/`git diff` + write
   `returned_commits`/`returned_diff`/`base_ref` into the takeover
   `node_attempts` row + call `markDownstreamStale`. AFTER all side-effects
   succeed: `markReturnedToRunning(runId)` (the AFTER-side idempotency marker is
   the `status='Running'` flip + the `node_attempts.ended_at` on the takeover
   row), then resume the graph runner. The status flip to `Running` is the
   AFTER-side marker — never set before the git/ledger side-effect completes.
2. **Idempotency guard.** The `FOR UPDATE` read checks the run is still
   `HumanWorking` (not already returned) AND not in any terminal status before
   any git op runs. A retry against an already-returned run (now `Running`/
   later) returns 409, not a re-import.

**Failure-classification table (return route):**

| Failure class | HTTP | Run/ledger state | Retry semantics |
| ------------- | ---- | ---------------- | --------------- |
| Run not `HumanWorking` (already returned / wrong state) | 409 `PRECONDITION` | unchanged | terminal — no re-import |
| Session user ≠ current `owner_user_id` | 403 `UNAUTHORIZED` | unchanged | not retryable by this actor |
| `git log`/`git diff`/`merge-base` fails (worktree gone, git error) | 409 `CONFLICT` | run stays `HumanWorking`; NO ledger write; NO status flip | retryable after operator fixes the worktree; idempotency marker still null |
| `markDownstreamStale` / ledger write throws mid-side-effect | 503 `EXECUTOR_UNAVAILABLE` | run stays `HumanWorking`; partial-write guarded by transaction; status NOT flipped | retryable — the `FOR UPDATE` re-read finds it still `HumanWorking` |
| Graph-runner resume kickoff fails after status flip | 200 (return recorded) + async runner handles crash via M11a `runFlow` terminal precedence | `Running` | resume retried by runner / reconcile |

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 3.0a (RED — SDD contract) | OpenAPI-derived contract tests: both routes return EXACTLY the documented status codes/bodies (claim 200 + `{worktreePath,branch,ownerUserId}` / 401 / 403 / 404 / 409; return 200 / 401 / 403 / 404 / 409 / 503). Mirror the in-memory db-mock harness of the existing `respond` route test (`app/api/runs/[runId]/hitl/[hitlRequestId]/respond/__tests__/route.test.ts`). Run and **watch fail** (routes absent) | `web/app/api/runs/__tests__/takeover.test.ts` (new, unit) | RED verified; one assertion per documented status code; `vitest list` shows it under `unit` (glob `app/**/__tests__/**/*.test.ts`) |
| 3.0b (RED — behavior + failure table) | One failing test per matrix row: `claim-from-NeedsInput-returns-200-context`; `claim-wrong-state-409`; `concurrent-claim-409`; `claim-unauthorized-401-403`; `return-records-commits-and-diff`; `return-stales-reentry-and-downstream` (re-entry's prior gate flips `stale` BEFORE the rerun creates fresh attempts); `resume-reruns-staled-gates`; `return-not-HumanWorking-409`; `non-owner-return-403`; `git-failure-no-statechange` (run stays `HumanWorking`, `returned_diff` null, `markDownstreamStale` NOT called); `ledger-throw-503-stays-humanworking`; `return-flips-Running-after-sideeffects` (two-phase ordering). **Integration seeds: real `flows` row + non-null `flowId`; unique fixture per test.** Run and **watch all fail** | `web/app/api/runs/[runId]/takeover/__tests__/takeover.integration.test.ts` (new, integration) | RED verified; honors the full failure-classification table; matrix `return`/`resume` rows owned here |
| 3.1 (GREEN) | `POST /api/runs/{runId}/takeover/claim`: `requireActiveSession` + `requireProjectAction(projectId, 'answerHitl')` (project member+; role-restriction is M13); load run+workspace; assert `status='NeedsInput'` AND the current node is a `human_review` node whose manifest `finish.human.decisions` includes `takeover` (server-state from the pinned revision manifest); `claimTakeover` + `markHumanWorking` under one transaction; return 200 with `{ worktreePath, branch, ownerUserId }` so the UI can show checkout context | `web/app/api/runs/[runId]/takeover/claim/route.ts` (new) | INFO log `takeover claimed` with run/node/owner; CAS-lost concurrent claim → 409 `CONFLICT`; wrong state → 409 `PRECONDITION`; 3.0a/3.0b claim cases GREEN |
| 3.2 (GREEN) | `POST /api/runs/{runId}/takeover/return`: the two-phase commit above. Phase 1 `FOR UPDATE` intent read; Phase 2 `resolveBaseRef`→`logRange`→`diffRange`→`recordTakeoverReturn`→ resolve `reentryNode` = the `human_review` node's `transitions.takeover` target →`markDownstreamStale(runId, [reentryNode, ...downstreamOf(graph, reentryNode)], db)` (include the re-entry node — `downstreamOf` excludes it; staleness recorded BEFORE the status flip, so the AFTER-side marker stays the `Running` flip); Phase 3 `markReturnedToRunning` + `queueMicrotask(runFlow)` resume at the declared validation re-entry | `web/app/api/runs/[runId]/takeover/return/route.ts` (new), `web/lib/flows/graph/runner-graph.ts` (**export** `downstreamOf`, today module-private at `runner-graph.ts:273`) | INFO per phase; failure-classification table honored exactly; returns 200 only after the AFTER-side status flip; 3.0b `return`/two-phase cases GREEN |
| 3.3 (GREEN) | Graph-runner resume after return: the runner resumes from `runs.current_step_id` (the takeover node), follows the node's `transitions.takeover` target (the declared validation re-entry — **`checks`** per P9, NOT `implement`); the staled downstream gates rerun over the human's commits before the next `human_review` HITL. Reuse M11a's resume/CAS machinery — NO new runner entry point, just a `HumanWorking`-aware resume gate alongside the existing `NeedsInput` resume gate | `web/lib/flows/graph/runner-graph.ts` (extend) | resume continues at the takeover node's `transitions.takeover` target; the re-entry node's PRIOR `gate_results` flip `stale` BEFORE the rerun creates fresh attempts; staled gates show `running`→fresh verdict; rerun recorded as new `node_attempts` rows; 3.0b `resume-reruns-staled-gates` GREEN |
| 3.4 (note) | **Deferred-release (skill-context):** the claim/return routes create NO supervisor deferred (takeover does not spawn an agent — the human works locally). State this explicitly. The ONLY resource the claim holds is the `HumanWorking` status + the slot; the release path is `releaseHumanWorking` on abandon and `markReturnedToRunning` on return. (The mid-return git-failure regression that proves no partial write is `git-failure-no-statechange` in 3.0b) | tests + this plan | architectural statement recorded; 3.0b `git-failure-no-statechange` GREEN: on `diffRange` throw, run stays `HumanWorking`, `returned_diff` null, `markDownstreamStale` NOT called |
| 3.5 (GREEN) | Wire release/abandon into the run-abandon path **pinned by Phase 0.10** (P12 — not the placeholder `[runId]/...`; today there is no `abandon/` route): a `HumanWorking` run can be abandoned → `releaseHumanWorking` then the standard abandon transition; document that release-without-changes returns to `NeedsInput` (the original review HITL is re-opened) | the abandon surface named in 0.10, `web/lib/runs/state-transitions.ts` | abandon of `HumanWorking` works; release returns to `NeedsInput`; slot freed via `promoteNextPending` on terminal |

**Test-runnability (skill-context):** The integration tests land under
`app/**/*.integration.test.ts`, which the **existing** `integration` vitest
project already globs (`vitest.workspace.ts:35` includes
`"app/**/*.integration.test.ts"`). The unit tests land under
`app/**/__tests__/**/*.test.ts`, already globbed by the `unit` project
(`vitest.workspace.ts:21`). **No runner-config extension task is required** —
confirm with `vitest list` that both files match. Per-phase exit gate:
`pnpm test:unit && pnpm test:integration` green (Docker-gated integration cases
noted, never silently red).

---

## Phase 4 — Run-detail timeline (current vs stale gates, all attempts/decisions/handoffs/returned commits/rerun results)

Build the timeline on the existing minimal run-detail page. Reads M11a
`node_attempts` + `gate_results` + M11b takeover columns.

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 4.0 (RED) | Failing tests for the timeline before the query/component exist: `getRunTimeline` returns current+stale entries + the takeover handoff block (integration against M11a-seeded `node_attempts`/`gate_results` — **real `flows` row, non-null `flowId`, unique fixture per test**); the timeline component renders stale-vs-current + handoff (component unit). Run and **watch fail** | `web/lib/queries/__tests__/run-timeline.integration.test.ts` (new), `web/components/board/__tests__/run-timeline.test.ts` (new) | RED verified; runner globs (`lib/**`, `components/**`) match; owns matrix `Timeline current-vs-stale …` row |
| 4.1 (GREEN) | Timeline read query: `getRunTimeline(runId)` returns ordered timeline entries from `node_attempts` (attempt N per node, with `decision`, `rework_from_node`, takeover `owner_user_id`/`returned_commits`/`returned_diff`/`base_ref`, `acp_session_id` checkpoint refs) joined to `gate_results` (each gate's `kind`/`mode`/`status`/`verdict`, with `status='stale'` flagged as **stale** vs current). Extend `web/lib/queries/run.ts` (do NOT fork a parallel module) | `web/lib/queries/run.ts` (extend `RunDetail` / add `getRunTimeline`) | one query, highest-attempt-wins ordering matches M11a templating; stale gates flagged; checkpoint refs surfaced |
| 4.2 (GREEN) | Timeline component: render attempts chronologically; per node show its gates with a clear **current vs stale** visual (stale = struck/greyed + "rerun required" hint); show decisions (approve/rework/takeover), checkpoints, and **handoff blocks** (owner + elapsed + branch + returned commit list + returned diff in a `<pre>`, no syntax highlighting per M9 deferral); show rerun results as new attempt rows. HeroUI + forest tokens, mirror `flight-card.tsx` patterns | `web/components/board/run-timeline.tsx` (new) | renders all entry kinds; current/stale distinct; returned diff in `<pre>`; no regression to the existing pending-HITL panel |
| 4.3 (GREEN) | Wire the timeline into the run-detail page below the pending-HITL panel; keep the existing header + pending-HITL section intact (surgical) | `web/app/(app)/runs/[runId]/page.tsx` (extend) | timeline renders for a graph run; minimal/legacy linear runs render an empty-but-valid timeline (no crash) |
| 4.4 (GREEN) | Take-over / return UI affordances on the run-detail page: a **Take over** button when `status='NeedsInput'` on a `human_review` node with `takeover` decision (posts to `claim`); when `status='HumanWorking'`, show the checkout context (worktree path + branch, copy-able) + a **Return** button (posts to `return`) gated to the owner. Client component, mirrors `run-hitl-response.tsx` | `web/components/board/run-takeover-actions.tsx` (new), run-detail page | buttons appear only in the right states; owner-gating on Return; posts to the Phase 3 routes |

---

## Phase 5 — Board takeover surface + i18n + `aif` takeover demo

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 5.0 (RED) | Failing tests before the board changes, AND migrate the existing tests whose assertions change (do not defer): `deriveStage` places `HumanWorking` in the in-flight bucket (`web/lib/__tests__/board*.test.ts`); `flight-card` renders the `humanworking` surface (owner/elapsed/branch/return) **distinct from running** and **no regression to the M11a `reworking` indicator** (`web/components/board/__tests__/flight-card*.test.ts`); `RunDetail` extended (`web/lib/queries/__tests__/run.test.ts`). Run and **watch the new assertions fail** | board / flight-card / run-query test files (enumerated above) | RED verified; each migrated test named here, not deferred; owns matrix `Board: HumanWorking …` row |
| 5.1 (GREEN) | Board card status mapping: add a `humanworking` `CardStatus` (the existing `BoardAgent` already includes `"dev"` — reuse it as the takeover agent pill). `deriveStage` keeps `HumanWorking` in the in-flight bucket (treat like `NeedsInput`/`Running` for column placement — `InProduction`). The card must NOT look like a normal running task | `web/lib/board.ts`, `web/lib/queries/board.ts` | `HumanWorking` → in-flight column; new card status surfaced; unit test asserts placement |
| 5.2 (GREEN) | Takeover board card surface: when a card is `humanworking`, render **owner, elapsed time (from the takeover `node_attempts.started_at`), branch, and a pending-Return action**; distinct styling (e.g. `dev` pill + a "claimed by <owner>" badge) from running cards | `web/components/board/flight-card.tsx` (extend), `web/lib/queries/board.ts` (surface owner + claimedAt) | owner/elapsed/branch/return-action all shown; visually distinct; no regression to running/needs cards or the **M11a `reworking` indicator** (already in `flight-card.tsx`/`board.ts` — extend, don't replace) |
| 5.3 (i18n) | i18n keys for takeover + timeline + return (EN + RU, ADR-014): `takeOver`, `return`, `claimedBy`, `elapsed`, `checkoutContext`, `returnedCommits`, `returnedDiff`, `staleGate`, `currentGate`, `rerunRequired`, `timelineTitle`, `handoff`, etc., in `run` + `board` namespaces | `web/messages/en.json`, `web/messages/ru.json` | both locales present; no hard-coded UI strings in the new components |
| 5.4 (manifest) | `aif` takeover demo: confirm the M11a-migrated `plugins/aif/flow.yaml` `human_review` node's `finish.human.decisions` + `transitions` include `takeover` → **`transitions.takeover: checks`** (P9 — re-validate gates over the human's commits; NOT `implement`, NOT `human_edit`). If M11a left it at `[approve, rework]` only, add `takeover` (manifest-only change; M11a schema already accepts it per `flow-dsl.md:104`) | `plugins/aif/flow.yaml` | manifest validates; `takeover` decision wired to `checks`; demonstrates AC-6 |
> **(P15) Intermediate WARN note (informational, no structural change):** between
> M11a and M11c the M11a `SETTINGS_NOT_ENFORCED_WARN` (`[flow] node settings
> parsed but not enforced until M11c`) still fires on every `aif` load — M11b
> never touches the `settings` field. This WARN is **expected** during M11b
> verification and is NOT a regression; it disappears when M11c lands.

---

## Phase 6 — Playwright e2e (claim → board surface → local commits → return → diff in timeline → stale → rerun → fresh review)

**(P5b/P5c)** The M11a auth+seed harness now EXISTS as-built and M11b REUSES it,
but its shape differs from the original M11a-plan wording — reconcile to reality:
`web/playwright.config.ts` has `globalSetup` (provisions + seeds the e2e DB,
applies migrations through `0010`), a `setup` project (`web/e2e/auth.setup.ts`)
that signs in the seeded admin and persists `storageState` to the auth file, and
an `authed` project (`storageState`) whose `testMatch` is **`/m11a-.*\.spec\.ts$/`
ONLY** (chromium `testIgnore`s the same pattern). The seed
`web/e2e/_seed/seed-e2e.ts` **direct-inserts** (raw `pg`) a run parked at
`NeedsInput` + a `human_review` HITL — it does NOT drive a run via the
mock-acp-adapter, and it creates **no real on-disk git worktree** (only a
`workspaces` row with a `worktree_path`). M11b therefore must (a) **extend the
seed to provision a real git worktree** (see 6.0) and (b) **broaden the `authed`
`testMatch` + chromium `testIgnore`** to pick up its `m11b-*` spec, and (c) **isolate the seed fixture per spec** under
`fullyParallel` (see 6.0). Task 6.0 below is a **mandatory** predecessor of 6.1,
not a conditional.

| # | Task | Files | Acceptance |
| - | ---- | ----- | ---------- |
| 6.1 | E2e spec covering the full takeover loop: (a) seed a graph run paused at the `aif` `human_review` node (reuse the integration seed harness / a test fixture flow); (b) **claim** via the run-detail Take over button → run becomes `HumanWorking`; (c) assert the **board card** shows owner + branch + elapsed + pending-Return action and is visually distinct; (d) **simulate local commits** in the exposed worktree (the spec runs `git commit` in the worktree path via a Node child-process step — this is the "human edits locally" simulation, no remote); (e) **Return** via the UI; (f) assert the **returned diff** appears in the run-detail **timeline**; (g) assert downstream gates are marked **stale** then **rerun** (gate rows flip stale→running→fresh verdict); (h) assert the run reaches a **fresh review gate** (new `human_review` HITL) | `web/e2e/m11b-takeover.spec.ts` (new) | spec passes against `pnpm dev` + a seeded DB; covers claim→board→commit→return→diff→stale→rerun→fresh-review end-to-end |
| 6.2 | Document the e2e prerequisites (running web tier + supervisor + seeded project/flow) in the spec header and `docs/getting-started.md` "Scripts" note for `pnpm --filter maister-web test:e2e` | `web/e2e/m11b-takeover.spec.ts`, `docs/getting-started.md` | prerequisites documented; spec self-describes its seed |

> **6.0 (MANDATORY predecessor of 6.1, P5b/P5c):** reuse the AS-BUILT M11a
> harness — `web/e2e/global-setup.ts` (DB provision + seed + migrations), the
> `setup` project / `web/e2e/auth.setup.ts` `storageState`, and
> `web/e2e/_seed/seed-e2e.ts` (direct-insert of a parked `NeedsInput` run + a
> `human_review` HITL). Two REQUIRED extensions M11a did not ship: (1)
> **provision a real git worktree** — `git init` a parent repo, `git worktree
> add` the run branch at the seeded `worktree_path`, and add a base commit, so
> the return route's `resolveBaseRef`/`logRange`/`diffRange` and the spec's
> "commit in the worktree" step operate on real git state (the as-built seed only
> writes a `workspaces` DB row); (2) **register the spec** — name it
> `web/e2e/m11b-takeover.spec.ts` and broaden the `authed` project `testMatch`
> (and chromium `testIgnore`) from `/m11a-.*/` to `/m11[ab]-.*\.spec\.ts$/` so it
> runs authenticated; (3) **isolate the fixture per spec (Codex F2)** —
> `web/playwright.config.ts` is `fullyParallel: true` and the M11a global seed
> creates exactly ONE shared parked run/workspace. Parameterize `seed-e2e.ts` by
> a unique key (Playwright worker index / spec slug) so each authed spec seeds
> its OWN project/run/worktree (distinct ids + `.worktrees/<slug>` path) and
> claims/returns against its own run, never the shared M11a fixture — so
> M11a/M11b/M11c authed specs cannot race or hide order-dependent regressions.
> 6.1's acceptance is gated on a real green run, not a skip.

---

## Phase 7 — As-built docs reconciliation + verify

| # | Task | Files | Acceptance |
| - | ---- | ----- | ---------- |
| 7.1 | Reconcile Phase-0 docs against shipped code; flip implementation-status tags (manual-takeover local-handoff subset → Implemented; artifact-instance + node-type halves stay Designed/M12/M18); confirm contract-surface table fully satisfied | all Phase-0 docs | `/aif-verify` re-derives surfaces from the diff with no gaps |
| 7.2 | Run `pnpm validate:docs` (Mermaid gate) + OpenAPI validator on `web.openapi.yaml` | docs | zero errors |
| 7.3 | Full suite green; enumerate any quarantined (Docker-only) tests with reasons; run the Playwright spec. **Run every verify command BARE with `set -o pipefail` — never pipe vitest/playwright through `tail`/`head`/`grep` when asserting pass/fail (patch 14.34: a green `\| tail` over a red suite is a false-green); check the bare exit status** | — | `pnpm test:unit && pnpm test:integration` green; `pnpm --filter maister-web test:e2e` green (Docker-gated cases noted); no piped exit codes |

---

## Commit Plan (checkpoints every ~1 phase)

1. **Phase 0** → `docs(m11b): manual-takeover ADR + analytics + ERD + openapi + flow-dsl + spec→test matrix`
2. **Phase 1** → `feat(m11b): worktree logRange/diffRange/resolveBaseRef git ops`
3. **Phase 2** → `feat(m11b): HumanWorking status + node_attempts takeover columns migration 0011`
4. **Phase 3** → `feat(m11b): takeover claim + two-phase return routes + runner resume`
5. **Phase 4** → `feat(m11b): run-detail timeline (current vs stale gates, attempts, handoffs)`
6. **Phase 5** → `feat(m11b): board takeover surface + i18n + aif takeover demo`
7. **Phase 6** → `test(m11b): playwright e2e — claim → return → stale → rerun → fresh review`
8. **Phase 7** → `docs(m11b): as-built reconciliation + verify gate`

## Verification (end-to-end)

1. **Takeover claim (criterion #4):** from a graph run paused at the `aif`
   `human_review` node, click Take over → `runs.status='HumanWorking'`; the
   exposed worktree path + run branch returned; no new branch/target created.
2. **Board surface (criterion #4):** the in-flight card for a `HumanWorking` run
   shows owner, elapsed time, branch, and a pending-Return action, visually
   distinct from a running card.
3. **Return imports commits + diff (criterion #4):** after simulating local
   commits in the worktree, Return runs `git log`/`git diff` against the run
   branch and stores `returned_commits` + `returned_diff` + `base_ref` on the
   takeover `node_attempts` row.
4. **Downstream stale + rerun (criterion #4):** Return calls
   `markDownstreamStale` with `[reentryNode, ...downstreamOf(reentryNode)]`; the
   re-entry node + downstream (`checks`/`judge`/`review`) `gate_results`
   flip to `stale`, the runner resumes at the declared `transitions.takeover`
   re-entry, gates rerun, and a fresh `human_review` HITL is produced.
5. **Returned diff in timeline (criterion #5):** the run-detail timeline shows
   the handoff block with owner + elapsed + branch + returned commit list +
   returned raw diff.
6. **Current vs stale timeline (criterion #5):** the timeline distinguishes
   current vs stale gates and shows all node attempts, decisions, checkpoints,
   handoffs, returned commits, and rerun results in ONE view.
7. **Two-phase return (skill-context):** a simulated git failure on Return
   leaves the run `HumanWorking` with no ledger write and no status flip (409
   `CONFLICT`, retryable); a successful Return flips to `Running` only AFTER the
   git/ledger side-effects commit.
8. **Docs gate:** `pnpm validate:docs` + OpenAPI lint clean; suite green.
9. **e2e:** the Playwright `takeover.spec.ts` passes the full
   claim→board→commit→return→diff→stale→rerun→fresh-review loop.

Run locally: `pnpm --filter maister-web test:unit`,
`pnpm --filter maister-web test:integration` (Docker-gated cases on CI),
`pnpm --filter maister-web test:e2e`, `pnpm --filter maister-web lint`,
`pnpm validate:docs`.

---

## Неразрешённые вопросы (ответь до старта)

1. ✅ **РЕШЕНО — M11a реализован** (ветка `feature/m11a-flow-graph-lifecycle`).
   `node_attempts`, `gate_results`, `markDownstreamStale` (2-арг), `downstreamOf`,
   graph-runner, `run-hitl-response.tsx` — все на месте. Фазы 2-6 разблокированы.
2. **`HumanWorking` считается в cap (ADR-009)?** Я заложил
   `count(IN ('Running','NeedsInput','HumanWorking'))` — claimed worktree держит
   слот. Ок, или takeover должен быть вне cap (как resume)?
3. **Release без изменений → `NeedsInput`?** Если ревьюер claim-нул, но ничего
   не закоммитил и жмёт "release" — возвращаемся в исходный `human_review`
   HITL. Согласен, или release = abandon?
4. ✅ **РЕШЕНО (P9)** — `transitions.takeover → checks` (ре-валидация гейтов
   поверх коммитов человека). НЕ `implement` (перезатёр бы ручные правки),
   НЕ `human_edit` (это M18-тип). `flow-dsl.md:107` правится в Phase 0.7.
5. **Owner-gating на Return в M11b:** только claim-овладелец может вернуть
   (403 остальным). M13 разрешит "take over stale work" другим. Ок, что в M11b
   жёстко owner-only?
6. **Returned diff в таймлайне — сырой `<pre>`** без подсветки (M9 deferral).
   Достаточно для M11b, или нужен хотя бы diff-stat (+N/−M)?
7. **Что показывать как "owner" на карточке** — `users.name` или `email`?
   (RBAC у нас есть, имя может быть null.)
8. ✅ **РЕШЕНО** — M11a закоммитил `0010_m11a_graph_ledger.sql` (ceiling=0010),
   ADR ceiling=029. M11b забирает `0011` + ADR-030 — оба свободны. Конфликта нет.
9. **Контракт-тесты (3.0a):** ассертить против самого `web.openapi.yaml`
   программно (грузим YAML → сверяем статусы/тела), или ручные unit-тесты,
   зеркалящие спеку? Программный путь дороже, но ловит дрейф спек↔код напрямую.
10. **Матрица spec→test (0.11):** держим в плане (как сейчас), или выносим в
    отдельный `docs/`-артефакт, на который ссылается `/aif-verify` при as-built сверке?
