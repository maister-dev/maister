# M12 — Typed Artifacts and Evidence Graph

> Make Flow inputs/outputs first-class runtime objects: typed metadata index in
> Postgres, payloads on disk/git. Artifacts become **evidence** that a run is
> ready or not. Adds the run-detail **evidence-graph explorer** and the
> review **evidence-refusal** path (flow-merge refusal guard ships now, is wired
> at flow promotion in M18 — see D6).

- **Branch:** `feature/m12-typed-artifacts-evidence-graph` (this worktree was
  switched to the milestone feature branch, off `main` at HEAD — see Decision D0).
- **Created:** 2026-06-01 · **Refined:** 2026-06-01 (iteration 2 — DoR/DoD/AC +
  promote-route/logger corrections; feature branch created + plan file renamed)
- **Plan id format:** slug (`feature-m12-typed-artifacts-evidence-graph`)

> ⚠ **Phase-0 freeze correction (authoritative — overrides §11.1, the §3.2
> `artifact_projection_cursors` table, and D2 wherever they say "per-step" /
> `<stepId>`).** Re-confirmed against `supervisor/src/spawn.ts:124-143`: the
> supervisor event log is the **run-scoped** `run.events.jsonl` (one file per
> run, shared across all steps/sessions) and `monotonicId` is **run-global**
> (seeded by `tailMaxMonotonicId` on each spawn). Therefore: projector cursor is
> **per-run** (cursor PK `<runId>`, `scope = "run"`, `events_log_path` =
> `…/runs/<runId>/run.events.jsonl`); projector artifact PK is
> `proj:<runId>:<monotonicId>` (NOT `proj:<runId>:<stepId>:<monotonicId>`);
> node-attempt attribution joins `event.sessionId ===
> node_attempts.acp_session_id` (unmatched → run-level, `node_attempt_id` NULL).
> Canonical record: ADR-034 + `docs/system-analytics/artifacts.md` +
> `docs/db/artifacts-domain.md`. All downstream phases (esp. Phase 5 projector)
> follow this, not the original §11.1 text.

## Settings

- **Testing:** YES — **TDD** (red → green → refactor) per phase. vitest
  (unit/integration) + Playwright (e2e). Non-negotiable for this plan.
- **Logging:** Verbose. Every new module logs at boundaries (artifact recorded,
  superseded, staled; gate evidence pass/fail; projector batch applied + cursor
  advance; review refusal). Use a **module-local `pino` logger** per the existing
  pattern (`import pino from "pino"`, e.g. `web/lib/flows/graph/gates-exec.ts`) —
  there is **no** shared `web/lib/log.ts`. Never `console.log` (ESLint
  `no-console: warn`). Secrets never logged.
- **Docs:** YES — **mandatory** documentation checkpoint at completion, routed
  through `/aif-docs`. SDD requires the analytics/contract docs to be COMPLETE
  and INTERNALLY CONSISTENT **before** any code phase (Phase 0), per the
  skill-context rule "front-load a complete, internally consistent
  analytics/design spec before any code phase".

## Roadmap Linkage

- **Milestone:** "M12. Typed artifacts and evidence graph"
- **Rationale:** Implements M12 verbatim from `.ai-factory/ROADMAP.md`
  (lines 73–127): four Expectations, eight Acceptance Criteria, the explicit
  deferral list, and the ADR-022 architecture note. Each AC is mapped to a task
  and a verification mechanic in **§8 Traceability Matrix**.

---

## 1. Context — what exists, what M12 adds

M11a/b/c shipped the Flow graph engine. M12 builds **directly** on it:

| Already in place (do not rebuild) | M12 uses it for |
| --- | --- |
| `node_attempts` append-only ledger (`web/lib/db/schema.ts:725`) | Artifacts FK to `node_attempts.id`; supersession follows attempts. |
| `gate_results` with `kind: artifact_required` (enum, currently **skipped** stub at `web/lib/flows/graph/gates-exec.ts:335`), plus `input_artifact_refs` / `output_artifact_ref` / `stale_from` columns | M12 activates the `artifact_required` gate against the evidence index; reuses the existing columns (no new gate columns). |
| `markDownstreamStale()` (`web/lib/flows/graph/ledger.ts:486`) — already stales downstream `node_attempts` + `passed`→`stale` gates on rework | M12 extends it to also stale downstream **artifact_instances**. |
| Manual-takeover return (`recordTakeoverReturn` + `node_attempts.returned_commits`/`returned_diff`, M11b) | M12 promotes returned commits/diff into typed `commit_set`/`diff` artifacts **before** rerunning downstream validation. |
| `node.input.requires[]` / `node.output.produces[]` Zod schema (`web/lib/config.schema.ts:244,259`) — parsed via `.passthrough()`, validated/enforced **nowhere** today | M12 validates them at manifest load and enforces them at runtime. |
| Supervisor `<stepId>.events.jsonl` writer (`supervisor/src/events-log.ts`) emitting `session.update` (raw ACP `update`) + `session.permission_request` (`toolCall`) with monotonic `monotonicId` | The ADR-022 projector tails these to derive event-stream evidence. |
| `getRunTimeline()` (`web/lib/queries/run.ts:185`) + run-detail page (`web/app/(app)/runs/[runId]/page.tsx`) + `FlightCard` board card | The evidence explorer is a new sibling section; the board gets an evidence badge. |
| `diffRunWorkspace()` (`web/lib/worktree.ts:322`), `logRange()` (`:605`), `resolveBaseRef()` (`:799`) | The canonical `diff`/`commit_set` payload sources (NOT fragile ACP `tool_call_update` reassembly). |
| Blocking gates in `pre_finish` already stop a node from finishing on failure (M11a) | The **review refusal** mechanism: a failed blocking `artifact_required` gate in the `human_review` node's `pre_finish` blocks `approve→done`. No new route needed. |

**Not built yet (confirmed):** no artifact table, no projector, no projection
cursor. **Flow-run merge/promotion is not built** — `web/app/api/runs/[runId]/
promote/route.ts` is **scratch-only** (`run is not scratch` rejection at :84) and
`pull_request` mode throws "not implemented" (:158); flow promotion is **M18**.
ADR-022 marked the projector `Designed`, "lands with M11/M12"; M11 wrote the
ledger **inline** at the runner — M12 keeps that and adds artifacts.

---

## 2. Key Decisions (ADR-frozen in Phase 0)

Next free ADR numbers: **ADR-033 / ADR-034 / ADR-035** (highest existing is
ADR-032).

### D0 — Branch
This worktree is on `feature/m12-typed-artifacts-evidence-graph`, branched from
`main` at HEAD. The plan file stem matches the branch with `/`→`-`
(`feature-m12-typed-artifacts-evidence-graph.md`) so branch-based consumers
(`/aif-implement`, `/aif-verify`, `/aif-rules-check`) discover it automatically.

### D1 — Artifact model (→ **ADR-033**)
- New table **`artifact_instances`** = the queryable evidence **index** only.
  Payloads stay on disk (run dir), in the worktree, or in git. **Deferred
  explicitly** (M12 roadmap): content-addressed blob store, marketplace,
  benchmark datasets, rich preview sandboxing, cross-run reuse, full
  payload-schema validation for every kind, external ingestion beyond M16.
- **Kinds** (closed catalog): `diff | log | test_report | lint_report |
  ai_judgment | human_note | commit_set | checkpoint | preview | generic_file`.
- **Validity** FSM: `current | stale | superseded | failed | skipped`. New
  successful attempts **supersede** (never erase) prior artifacts of the same
  `(run, node, artifact_def)`.
- Payload **locator** = typed discriminated jsonb (`git-range`, `git-log`,
  `file`, `gate-verdict`, `hitl-response`, `inline`) — **no** raw filesystem path
  trusted from the client (server-written only; payload route re-confines to the
  run dir).

### D2 — Hybrid write path (→ **ADR-034**, refines ADR-022)
Two write paths into one `artifact_instances` index, crash-safe via
**deterministic primary keys** (re-execution / replay upserts idempotently —
dialect-portable, no partial-unique-index gymnastics):
- **Runner-inline** (the majority): graph runner + linear `steps[]` runner record
  artifacts at node/step boundaries for evidence in hand — `diff`/`commit_set`
  (git refs), `lint_report`/`test_report` (check/cli stdout), `ai_judgment` (gate
  verdict), `human_note` (HITL comments), `checkpoint`, default `log` (per-step
  `.log` path), guard metrics (`guards.jsonl`), human/form answers. PK e.g.
  `run:<nodeAttemptId>:<artifactDefId>` or `run:<nodeAttemptId>:default:<kind>`.
- **ADR-022 projector** (scoped): web-side consumer of `<stepId>.events.jsonl`
  deriving **event-stream-only** evidence the runner cannot see — the structured
  **tool-call activity** artifact (`log`) and `preview` URLs in tool output —
  keyed `proj:<runId>:<stepId>:<monotonicId>`, with a per-`(run,stepId)` **cursor**
  for crash-safe replay. The projector does **not** reassemble diffs (git is the
  source) and does **not** own the M11 ledger.
- **Projector ordering (skill-context two-phase rule):** in one DB transaction,
  upsert derived artifacts **then** advance the cursor (`last_monotonic_id`). The
  cursor advance is the AFTER-side idempotency marker. Crash before commit → full
  replay from last committed cursor; idempotent on PK → no duplicates.
- **No watcher.** The projector runs as a **pull** at runner sync points (node
  start/finish/checkpoint/terminal) + an idempotent **startup catch-up sweep** in
  `web/instrumentation.ts`. Honors "no `fs.watch`/`chokidar`/polling for state
  transitions" (it derives data; never drives state).

### D3 — Evidence-graph explorer renderer (→ **ADR-035**)
Evaluated for MAIster's stack (React 19.2, Next 16 App Router, HeroUI v3 /
Tailwind 4, read-only explorer):

| Option | Verdict |
| --- | --- |
| **`@xyflow/react` (React Flow) + `@dagrejs/dagre`** | **Chosen.** Nodes are React components → HeroUI chips render inside; first-class read-only mode (`nodesDraggable`/`nodesConnectable`=false, `elementsSelectable`, pan/zoom, `fitView`); Tailwind-friendly; React 19 compatible; dagre gives LR auto-layout. |
| Cytoscape.js | Rejected: nodes not React components; tuned for thousands of nodes we don't have per run. |
| reaflow | Rejected: less actively maintained. |
| Hand-rolled SVG | Rejected by user. |

- MAIster's **first interactive UI dependency** beyond HeroUI; the "no other
  component lib" rule (`web/CLAUDE.md`) is about **component kits** — React Flow
  is a **visualization** primitive. ADR-035 records the sanctioned exception.
- Client-only: `"use client"` + `next/dynamic` `ssr:false` (uses
  `ResizeObserver`/`window`). Import `@xyflow/react/dist/style.css`. Pin v12+
  (verify React 19.2 peer range at install — DoR for Phase 7).

### D4 — No new `MaisterError` code
Per ADR-008 (closed union) + ADR-028 precedent. Manifest artifact violations →
**`CONFIG`** (at `loadFlowManifest`). Missing/stale required **input** → node
`Failed`, `errorCode: "PRECONDITION"`, before action. Missing required **output**
→ node `Failed` (`PRECONDITION`) before finish. `artifact_required` gate
unsatisfied → `gate_results.status="failed"` (no thrown code). Review refusal →
blocking gate failure (no HTTP code; node cannot finish). `error-taxonomy.md`
gets new **caller rows** under `CONFIG`/`PRECONDITION`, **no new code**.

### D5 — Engine version
Bump `MAISTER_ENGINE_VERSION` `1.1.0 → 1.2.0` (`web/lib/flows/engine-version.ts`).
`GRAPH_MIN_ENGINE_VERSION` **stays `1.1.0`** (graph flows valid at 1.1.0). The
**declared-artifact contract** (validating `input.requires`/`output.produces`
refs + `artifact_required` enforcement) requires `compat.engine_min ≥ 1.2.0`.
**Default** artifact recording (log, guard metrics, human/form answer, diff)
works for **all** runs at 1.1.0 without manifest changes (roadmap AC2).

### D6 — Scope boundaries (do not cross)
- **M12 ↔ M18 (CRITICAL):** flow-run **merge/promotion is not built** — the
  `promote` route is scratch-only (`:84`), `pull_request` unimplemented (`:158`).
  M12 ships the reusable guard `assertEvidenceReady(runId, "review" | "merge")`
  (`web/lib/flows/graph/evidence-readiness.ts`) and wires the **review** refusal
  via blocking `artifact_required` gates in `pre_finish` (M11a machinery) +
  `requiredFor:[review]`. The **merge** refusal is wired at the flow-promotion
  path **in M18**; M12 unit-tests the guard's `merge` phase but **does not modify
  the scratch-only promote route** and cannot demonstrate flow-merge end-to-end.
- **M12 ↔ M15:** M12 refuses **review** on artifact evidence only. The general
  **readiness-policy DSL + verdict calibration** stays M15. `external_check`
  stays `pending`-stubbed — **not** activated here.
- **M12 ↔ M14:** artifact `visibility`/`retention`/`artifactAccess` are
  **recorded/declared** only; capability materialization & access enforcement is
  M14. M12 enforces read-access only via project RBAC.
- **M12 ↔ M13:** human `role` refs untouched.
- **M19:** GC of artifacts for `Abandoned/Done` runs >7d — note the hook, defer
  the cron (consistent with existing M19 GC scope).

---

## 3. SDD Spec (embedded — Phase 0 formalizes into repo docs)

### 3.1 User stories

1. **As a reviewer**, I open a finished run and see an evidence graph: task input
   → each node attempt → the artifacts it produced (diff, lint report, judge
   verdict, human note) → gates → the review decision, with current/stale
   colouring, so I can approve **without** re-reading the worktree.
2. **As a reviewer**, when I request rework, downstream artifacts and gates go
   **stale** and the review will not approve until they are re-produced and pass.
3. **As an engineer**, I declare that `judge` *requires* `impl-diff` and
   *produces* `judge-verdict`; if `impl-diff` is missing the node fails **before**
   the agent runs, and if `judge-verdict` is missing it fails **before** finish.
4. **As an operator**, after a manual takeover I return commits; MAIster records a
   `commit_set` + `diff` artifact and forces downstream checks/judge/review to
   rerun.
5. **As anyone**, artifact metadata survives a web restart; MAIster never rescans
   arbitrary worktree state to explain why a run is blocked.

### 3.2 Domain entities / DB structure

New table **`artifact_instances`** (Drizzle `pg-core`, `text(..,{enum})` style):

```
artifact_instances
  id                text PK            -- deterministic; see D2 (idempotent upsert)
  run_id            text NOT NULL → runs(id) ON DELETE CASCADE
  node_attempt_id   text NULL → node_attempts(id) ON DELETE CASCADE  -- NULL for task-input / run-level
  node_id           text NULL          -- denormalized logical node id (grouping/query)
  attempt           integer NULL
  artifact_def_id   text NULL          -- manifest output.produces[].id; NULL for defaults / projector-derived
  kind              text NOT NULL enum(diff,log,test_report,lint_report,ai_judgment,
                                       human_note,commit_set,checkpoint,preview,generic_file)
  producer          text NOT NULL enum(runner,projector,takeover,gate,human)
  locator           jsonb NOT NULL     -- {kind:"git-range",baseCommit,headRef} | {kind:"git-log",baseRef,headRef}
                                        -- | {kind:"file",path} | {kind:"gate-verdict",gateResultId}
                                        -- | {kind:"hitl-response",hitlRequestId} | {kind:"inline",text}
  uri               text NULL          -- optional human/direct display ref
  hash              text NULL          -- content hash when cheap (head SHA / file digest)
  size_bytes        integer NULL
  validity          text NOT NULL enum(current,stale,superseded,failed,skipped) default 'current'
  required_for      jsonb NULL         -- $type<("review"|"merge")[]>  (snapshot from manifest)
  visibility        text NOT NULL enum(internal,shared) default 'internal'
  retention         text NOT NULL enum(run,ephemeral) default 'run'
  monotonic_id      integer NULL       -- supervisor event id (projector rows); NULL for inline
  superseded_by_id  text NULL → artifact_instances(id) ON DELETE SET NULL
  created_at        timestamptz NOT NULL default now()
  INDEX (run_id), (node_attempt_id), (run_id, kind), (run_id, validity)
```

New table **`artifact_projection_cursors`** (ADR-022 per-run resume cursor):

```
artifact_projection_cursors
  id                 text PK            -- `${run_id}::${stepId}`  (scope = stepId — see §11.1)
  run_id             text NOT NULL → runs(id) ON DELETE CASCADE
  scope              text NOT NULL      -- events-log scope (stepId)
  events_log_path    text NOT NULL
  last_monotonic_id  integer NOT NULL default 0
  status             text NOT NULL enum(idle,running,caught_up,failed) default 'idle'
  updated_at         timestamptz NOT NULL default now()
  UNIQUE (run_id, scope)
```

**Migration:** `web/lib/db/migrations/0015_m12_artifacts_evidence.sql` (next free
slot — `0014_fair_kulan_gath.sql` is taken by the scratch-workspace-dialogs
feature rebased into `main`; generate via `pnpm --filter maister-web db:generate`,
then rename to the M-significant convention of `0010_m11a_graph_ledger` /
`0013_m11c_enforcement_snapshot`).
Additive-only — no destructive change, no down-migration (forward-only per
project convention). `gate_results` reused as-is.

### 3.3 Artifact validity state machine

```
                produced (ok)
   (none) ─────────────────────────▶ current
                                       │  │ │
   new attempt of same (node,def)      │  │ └────────────▶ failed   (required output missing / gate fail)
        supersedes ──────────────────▶ superseded         (kept for history)
   downstream of rework/takeover/rewind │
        staled ───────────────────────▶ stale ──(re-produced)──▶ current
   gate kind unsupported / not run ────▶ skipped
```
Supersession and staleness mutate `validity` (lifecycle) + `superseded_by_id`;
they NEVER delete a row.

### 3.4 API surface (web tier)

| Route | Method | Purpose | Identifiers (trust label) | Auth |
| --- | --- | --- | --- | --- |
| `/api/runs/[runId]/artifacts` | GET | List artifact instances (evidence index + filters). | `runId` = **url-param** → run row = **server-state**; `projectId` derived from run row. | `requireActiveSession` + `requireProjectAction(projectId,"readBoard")` |
| `/api/runs/[runId]/artifacts/[artifactId]/payload` | GET | Raw payload (read `.log`/file from run dir; `git diff`/`git log` via `diffRunWorkspace`/`logRange`; gate verdict / HITL JSON). | `runId`, `artifactId` = **url-param**; `artifactId` validated by **server-state join** (`artifact_instances.run_id = runId`) → 404 on mismatch. **No body cross-resource ids.** File locators **re-confined** to the run dir (`path.resolve` must stay under `.maister/<slug>/runs/<runId>/`). | same as above |

- **Review refusal is NOT a new route.** It rides on the existing
  `human_review` node `pre_finish` blocking `artifact_required` gate (a failed
  blocking gate stops the node finishing, so `approve→done` cannot complete) and
  the `assertEvidenceReady(runId,"review")` guard. No HTTP surface added for it.
- **Flow-merge refusal is M18.** The scratch-only `promote` route is **not
  modified** in M12; the `assertEvidenceReady(runId,"merge")` guard is shipped
  and unit-tested, to be called by the M18 flow-promotion path.
- Both new routes are **read-only** (the two-phase commit rule applies only to
  routes with downstream side-effects — neither has one).

### 3.5 Interactions (happy path + rework)

```
Launch ──▶ node A (ai_coding) runs
   ├─ before action: validate input.requires → all current? else node Failed(PRECONDITION)
   ├─ action runs (agent session) ; supervisor appends session.update → <stepId>.events.jsonl
   ├─ projector pull (node boundary): derive tool-activity `log` + `preview` (idempotent + cursor, one tx)
   ├─ before finish: record output.produces → artifact_instances (current);
   │     missing required output ⇒ node Failed(PRECONDITION)
   ├─ supersede prior artifacts of same (node,def): current→superseded
   └─ default artifacts recorded (log path, diff git-range, guard metrics)
node B (check) ──▶ lint_report artifact ; gate command_check passes
node J (judge) ──▶ ai_judgment artifact (from verdict)
node R (human review):
   ├─ pre_finish blocking artifact_required gate: every inputArtifacts ref current+ok? pass/fail
   │     (fail ⇒ node cannot finish ⇒ review cannot approve — the REVIEW refusal)
   ├─ assertEvidenceReady(run,"review"): requiredFor:[review] artifacts present+current?
   └─ decision:
        approve ─▶ done            [flow-merge: assertEvidenceReady(run,"merge") guard ready, WIRED IN M18]
        rework  ─▶ markDownstreamStale(run, downstreamOf(target)) stales node_attempts + gates + ARTIFACTS
                   ─▶ target reruns ─▶ produces new artifacts (supersede the stale) ─▶ fresh review
manual takeover return (M11b path):
   ├─ record commit_set + diff artifacts from returned_commits/returned_diff  ◀── BEFORE rerun
   └─ markDownstreamStale(...) ─▶ rerun checks/judge/review
```

### 3.6 Expectations (acceptance contract — for `system-analytics/artifacts.md` §Expectations)

- Every `artifact_instances` row MUST belong to exactly one `run_id`; node-attempt
  rows MUST reference a live `node_attempts.id` (cascade-deleted with the run).
- An artifact's `id` MUST be deterministic for its origin so re-execution and
  projector replay **upsert** (never duplicate).
- A node with `input.requires` referencing artifact `X` MUST fail
  (`PRECONDITION`) **before** action execution if no `current` `X` exists upstream.
- A node declaring `output.produces` `Y` MUST fail (`PRECONDITION`) **before
  finishing** if `Y` was not produced.
- A new successful attempt MUST set prior same-`(node,def)` artifacts to
  `superseded` + set their `superseded_by_id`; it MUST NEVER delete them.
- Rework / rewind / fresh-attempt / takeover-return MUST set downstream artifacts
  (from the handoff node forward) to `stale`.
- Review MUST refuse (the node MUST NOT finish to `approve`) when any
  `requiredFor:[review]` artifact is missing/stale/failed/skipped or a blocking
  `artifact_required` gate failed.
- The `artifact_required` gate MUST pass only when all `inputArtifacts` are
  `current`; otherwise `failed` (blocking) or recorded advisory.
- The projector MUST advance its cursor in the **same transaction** as its
  upserts; a crash MUST cause replay from the last committed `last_monotonic_id`
  with no duplicate rows.
- The projector MUST NOT drive any `runs.status` transition and MUST NOT use
  `fs.watch`/polling.
- Payload reads MUST be confined to the run directory; a file locator resolving
  outside it MUST 404, never read.
- Manifest validation MUST reject duplicate artifact ids, unknown required
  inputs, unsupported kinds, invalid paths/refs, and `requiredFor` artifacts no
  node produces — all `CONFIG`.

### 3.7 Edge cases (each → a code)

- Required input exists but is `stale`/`failed`/`superseded` → **not** satisfied →
  node `Failed(PRECONDITION)`.
- Two attempts race on the same `(node,def)` → deterministic PK +
  `onConflictDoUpdate`; `superseded_by_id` chain stays consistent.
- Projector hits an unparseable/unknown `session.update` → skip that event, still
  advance the cursor (no poison-pill stall); WARN log.
- `git diff` base==head → empty diff is a **valid** `current` artifact (size 0).
- Payload file deleted (GC/manual) while row `current` → payload route 410 `gone`
  (typed reason); index row stays for audit.
- Linear `steps[]` flow (engine 1.1.0) → default artifacts recorded; **no**
  declared-artifact validation (requires 1.2.0).

---

## 4. Contract surfaces → spec files (skill-context rule; `/aif-verify` re-derives)

| Surface changed | Spec file(s) that MUST be updated |
| --- | --- |
| New tables `artifact_instances`, `artifact_projection_cursors` | Migration `0015_*` + `docs/database-schema.md` narrative + **new** `docs/db/artifacts-domain.md` `erDiagram` + `docs/db/erd.md` |
| New HTTP routes `GET …/artifacts`, `GET …/artifacts/[id]/payload` | `docs/api/web.openapi.yaml` (paths, params, 200/404/410, examples) + `web/CLAUDE.md` route list |
| Review-refusal mechanism (no new route — blocking gate at `human_review`) + `assertEvidenceReady` guard | `docs/system-analytics/artifacts.md` + `docs/system-analytics/flow-graph.md` cross-ref (gate machinery) |
| New Flow DSL fields: `output.produces[]` (`id,kind,schema?,path?,ref?,visibility?,retention?,requiredFor?`), `input.requires[]` artifact refs, `artifact_required` gate semantics | `docs/flow-dsl.md` + the Zod in `web/lib/config.schema.ts` |
| Artifact kind catalog + validity FSM + staleness/refusal semantics | **new** `docs/system-analytics/artifacts.md` (R5 structure) |
| `MAISTER_ENGINE_VERSION` 1.1.0→1.2.0 + `compat.engine_min` artifact gate | `docs/configuration.md` (engine row + `compat` semantics) |
| Projector consumes supervisor `session.update`/`session.permission_request` | consumer note in `docs/api/async/supervisor-sse.asyncapi.yaml` description + `docs/architecture.md` Component table (new `Projector` + `ArtifactStore`) |
| No new error code; new caller rows | `docs/error-taxonomy.md` (`CONFIG` + `PRECONDITION` caller rows; "no new code") |
| New ADRs | `docs/decisions.md` ADR-033/034/035 + index table |
| New deps `@xyflow/react`, `@dagrejs/dagre` | `web/package.json` + lockfile + `docs/getting-started.md` deps note |

---

## 5. Deployment touchpoints (skill-context rule)

- **New runtime deps:** `@xyflow/react`, `@dagrejs/dagre` → `web/package.json` +
  `pnpm-lock.yaml`. Client-bundle deps only — **no** env var, **no** new port,
  **no** compose change (ADR-023: `web` is a host `pnpm` process; Postgres-only
  container). Verify peer ranges under Node 24 / React 19.2.
- **No new env vars.** The projector is config-free (cursor in DB, boundary-pull
  + startup catch-up).
- **CSS:** import `@xyflow/react/dist/style.css` in the explorer component.
- **DB migration `0015`** runs on deploy (`pnpm --filter maister-web db:migrate`)
  — Postgres-only (the `migrate.ts` guard rejects `file:`).

---

## 6. Definition of Ready / Done + verification mechanics

### 6.1 Verification mechanic legend (every AC is verified by ≥1)

| Tag | Command / check |
| --- | --- |
| `UNIT` | `pnpm --filter maister-web test:unit` (vitest `unit`: `lib/**/*.test.ts`, `lib/**/__tests__/**/*.test.ts`, `app/**/__tests__/**/*.test.ts`, `components/**/__tests__/**/*.test.ts`) |
| `INTEG` | `pnpm --filter maister-web test:integration` (vitest `integration`: `lib/**/*.integration.test.ts`, `app/**/*.integration.test.ts`; testcontainers Postgres) |
| `E2E` | `pnpm --filter maister-web test:e2e` (Playwright; dedicated `maister_e2e` DB) |
| `TYPES` | `pnpm --filter maister-web typecheck` (`tsc --noEmit`, strict, no `any`) |
| `LINT` | `pnpm --filter maister-web lint` (eslint; `no-console`) |
| `DOCS` | `pnpm validate:docs:all` (Mermaid parse, repo root) |
| `OPENAPI` | `npx @redocly/cli lint docs/api/web.openapi.yaml` |
| `ASYNCAPI` | `npx @asyncapi/cli validate docs/api/async/supervisor-sse.asyncapi.yaml` |
| `MIGR` | `pnpm --filter maister-web db:generate` yields an **additive** diff (no destructive op; forward-only, no down-migration) |

### 6.2 Plan-level DoR (before Phase 0 starts)

- §11 ratified defaults accepted (cursor scope, `requiredFor` placement, preview
  link-only, aif gate, React Flow pin).
- Migration number `0015` is the next free slot — `0014_fair_kulan_gath.sql` was
  taken by `feat: scratch workspace launch dialogs` (rebased into `main`);
  reconfirm `0015` is free at impl time.
- On the `feature/m12-typed-artifacts-evidence-graph` branch (already switched).

### 6.3 Per-phase DoR (generic)

- The previous phase's DoD holds.
- The frozen Phase-0 spec section governing this phase is the single source of
  truth (SDD): the phase implements that section, it does not redesign it.
- Failing tests are written first (RED) and reference that spec section.

### 6.4 Per-phase DoD (generic — ALL must hold)

1. Every task's `AC (DoD)` in the phase is met and shown by its named `Mechanic`.
2. Full suite green: `TYPES` + `UNIT` + `INTEG` + `LINT` (and `E2E` from Phase 8).
3. No touched test left red; any pre-existing red / harness-limited test is
   quarantined with a reason + tracked follow-up (never silently tolerated/deleted).
4. Behavior that invalidates existing assertions migrates them **in this phase**
   (enumerated, not deferred — see §9 + per-task notes).
5. Contract-surface docs this phase touches are updated in lockstep (§4) and pass
   `DOCS`/`OPENAPI`/`ASYNCAPI` where applicable.
6. Surgical: every changed line traces to a task; no adjacent refactor.

### 6.5 Phase-0 DoD (spec-freeze gate — additionally)

- All M12 docs COMPLETE + INTERNALLY CONSISTENT; implementation-status tags
  present (R6).
- The artifact-kind catalog, validity FSM, deterministic-PK formats, locator
  union, and cursor scope are frozen **verbatim as code will implement them**.
- `DOCS` + `OPENAPI` + `ASYNCAPI` green. No later phase may reference a spec
  section not frozen here.

### 6.6 Milestone DoD (M12 complete)

- §8 traceability matrix fully green (every roadmap AC → a passing mechanic).
- M12 roadmap checkbox flipped with an as-built note (T9.1).
- Verify gate (T9.2) green end-to-end.

---

## 7. Phases & Tasks (TDD)

> Phase exit = §6.4 Per-phase DoD. Each task carries `DoR →` (entry),
> `Deliverable →`, `Tests (RED→GREEN) →`, `AC (DoD) →` (the checkable
> done-condition), `Mechanic →` (how it is verified).

### Phase 0 — Spec freeze (docs-first, NO code) — **gate**

**T0.1 — ADR-033/034/035** in `docs/decisions.md` (+ index table): ADR-033 typed
artifact model; ADR-034 hybrid write path (refines ADR-022's "lands with M12",
deterministic-PK idempotency, two-phase cursor ordering, no-watcher pull);
ADR-035 React Flow + dagre (sanctioned UI dep).
- `DoR →` §11 ratified. `AC (DoD) →` 3 ADRs, one decision each (R4), each
  `Accepted` + dated; index table updated. `Mechanic →` `DOCS` + manual R4 check.

**T0.2 — `docs/system-analytics/artifacts.md`** per R5: Purpose · Domain entities
(link ERD) · State machine (`stateDiagram-v2` validity) · Process flows
(produce/require/stale/supersede/refuse + projector replay) · Expectations (§3.6,
≤12 bullets, verbatim ids) · Edge cases (§3.7, each → code) · Linked artifacts.
Add to `docs/CLAUDE.md` glossary; document the WARN/INFO lines code will emit.
- `AC (DoD) →` every transition + refusal row written exactly as code will gate;
  R5 section order present. `Mechanic →` `DOCS` + reviewer R5 checklist.

**T0.3 — ERDs:** new `docs/db/artifacts-domain.md` (`erDiagram` both tables + FK
edges to `runs`/`node_attempts`); update `docs/db/erd.md` + `database-schema.md`
narrative (columns, indexes, cascade chain, deterministic-id contract).
- `AC (DoD) →` narrative AND Mermaid both updated. `Mechanic →` `DOCS`.

**T0.4 — API spec:** `docs/api/web.openapi.yaml` — the two GET routes (params,
200 list schema, 404/410, examples). Consumer note for the projector in
`supervisor-sse.asyncapi.yaml`.
- `AC (DoD) →` both routes specced with examples. `Mechanic →` `OPENAPI` +
  `ASYNCAPI`.

**T0.5 — Cross-cutting docs:** `error-taxonomy.md` (CONFIG/PRECONDITION caller
rows; "no new code"); `configuration.md` (engine 1.2.0, `compat.engine_min`
gate, default-vs-declared matrix); `flow-dsl.md` (produces/requires/
artifact_required contract); `architecture.md` Component table (Projector +
ArtifactStore, `Designed`). **Freeze** the kind catalog, validity FSM,
deterministic-PK formats, locator union, cursor scope (per `(run,stepId)`,
confirmed against the real `<stepId>.events.jsonl` filename).
- `AC (DoD) →` §6.5 Phase-0 DoD holds. `Mechanic →` `DOCS` + Phase-0 DoD checklist.

**Phase-0 exit:** §6.5.

### Phase 1 — DB schema + artifact store (TDD)

**T1.1 — Schema + migration.** Add `artifactInstances` + `artifactProjectionCursors`
to `web/lib/db/schema.ts` (+ inferred types + locator/`requiredFor` `$type<>`).
Generate → rename `0015_m12_artifacts_evidence.sql`.
- `DoR →` Phase 0 frozen. `Deliverable →` schema + migration + exported types.
- `Tests (RED→GREEN) →` `lib/db/__tests__/…` (or foundation integration):
  migration applies; FKs cascade with `runs`/`node_attempts`; enums accept catalog.
- `AC (DoD) →` migration additive; integration DB boots; cascade verified.
  `Mechanic →` `MIGR` + `INTEG` + `TYPES`.

**T1.2 — `artifact-store.ts`** (`web/lib/flows/graph/artifact-store.ts`): pure CRUD
+ lifecycle. `recordArtifact(args)→{id}` (deterministic id, `onConflictDoUpdate`),
`supersedePrior(runId,nodeId,artifactDefId,newId)`,
`markArtifactsStale(runId,nodeIds[])`, `getArtifactsForRun(runId)`,
`getCurrentArtifact(runId,artifactDefId)`, `failArtifact(id)`. INFO logs on
record/supersede/stale with `{runId,nodeId,kind,id}`.
- `Tests (RED→GREEN) →` `__tests__/artifact-store.test.ts`: idempotent re-record
  (same PK → 1 row), supersession flips `current→superseded`+sets
  `superseded_by_id`, stale flips `current→stale`, `getCurrent` ignores
  non-`current`.
- `AC (DoD) →` all six functions behave per §3.6; idempotency + supersession +
  staleness proven. `Mechanic →` `UNIT` + `TYPES` + `LINT`.

### Phase 2 — Manifest schema + validation (TDD)

**T2.1 — Schema tighten** (`web/lib/config.schema.ts`): add `ARTIFACT_KINDS`;
tighten `nodeOutputSchema.produces[].kind` to it; add `schema?`,`path?`,`ref?`,
`visibility?`,`retention?`,`requiredFor?:("review"|"merge")[]`; keep
`input.requires[]` union. Bump `MAISTER_ENGINE_VERSION`→`1.2.0`; keep
`GRAPH_MIN_ENGINE_VERSION` 1.1.0.
- `Tests (RED→GREEN) →` schema unit cases (valid produces/requires; bad kind
  rejected). `AC (DoD) →` schema accepts the full produces shape, rejects unknown
  kinds; engine const = 1.2.0. `Mechanic →` `UNIT` + `TYPES`.

**T2.2 — `validateGraphManifest`** (`web/lib/config.ts`): build the artifact
registry from all `output.produces[].id`; reject (all `CONFIG`): dup artifact
ids, unknown required-input refs (bare non-`steps.*` OR `{artifact}` not in
registry), unsupported kinds, invalid path/ref, `requiredFor` artifacts no node
produces, `artifact_required` gate `inputArtifacts` referencing unknown ids. Gate
declared-artifact validation on `compat.engine_min ≥ 1.2.0`.
- `Tests (RED→GREEN) →` new `config-artifacts.test.ts`: one rejection per rule +
  one valid graph + engine-gate case (declared artifacts at 1.1.0 → CONFIG).
- `Assertion migration →` the M11a comment-block at `config.ts:535-545` changes
  behavior — migrate any test asserting bare artifact strings are skipped.
- `AC (DoD) →` every §3.6 manifest rule rejects with `CONFIG`; valid graph passes.
  `Mechanic →` `UNIT` (maps 1:1 to roadmap AC1).

### Phase 3 — Runner-inline recording + templating (TDD)

**T3.1 — Compile carries input/output** (`web/lib/flows/graph/compile.ts`): add
`input`/`output` to `CompiledNode` (currently dropped).
- `Tests →` compile round-trips produces/requires. `AC (DoD) →` `CompiledNode`
  exposes `input`/`output`. `Mechanic →` `UNIT` + `TYPES`.

**T3.2 — Runtime input/output enforcement** (`runner-graph.ts` main loop): before
`executeNodeAction`, validate `node.input.requires` (current-wins) → missing ⇒
`markNodeFailed(PRECONDITION)`, break. After action ok / before finish, record
`node.output.produces`; missing required output ⇒ `markNodeFailed(PRECONDITION)`.
On success `supersedePrior`.
- `Tests (RED→GREEN) →` `runner-graph` INTEG: missing-input fails before action
  (spy: action never called); missing-output fails before finish; 2nd attempt
  supersedes.
- `AC (DoD) →` roadmap AC3 holds. `Mechanic →` `INTEG`.

**T3.3 — Default artifacts (linear + graph).** Shared helper
`recordDefaultArtifacts({runId,nodeAttemptId|stepRunId,nodeId,kindSet})` invoked
from BOTH `runner-graph.ts` and the linear `runner.ts` step path: `log` (per-step
`.log`), guard metrics (`guards.jsonl`), human/form answer (HITL locator),
generated `diff` (git-range).
- `Tests (RED→GREEN) →` a linear `steps[]` run at engine 1.1.0 records the four
  defaults with **no** manifest artifact syntax.
- `AC (DoD) →` roadmap AC2 holds. `Mechanic →` `INTEG`.

**T3.4 — Templating `artifacts` namespace** (`web/lib/flows/types.ts` +
`context.ts`): add `artifacts: Record<defId,{kind,uri?,validity,nodeId}>`
(current-wins) to `FlowContext`; populate in `buildContext`.
- `Tests →` `{{artifacts.<id>.uri}}` renders; unknown id → `CONFIG` via
  `renderStrict`. `AC (DoD) →` namespace resolvable; strict-undefined preserved.
  `Mechanic →` `UNIT`.

### Phase 4 — Staleness + review refusal + artifact gate (TDD)

**T4.1 — Extend `markDownstreamStale`** (`web/lib/flows/graph/ledger.ts`): in the
same pass that stales `node_attempts` + `passed` gates, also
`markArtifactsStale(runId, downstreamNodeIds)`.
- `Tests →` rework stales downstream artifacts; re-produce supersedes the stale
  row to `current`. `AC (DoD) →` staleness covers artifacts (roadmap AC4 half).
  `Mechanic →` `INTEG`.

**T4.2 — `artifact_required` gate** (`gates-exec.ts:335`): replace the stub — read
`gate.inputArtifacts`, check each is a `current` artifact → all present ⇒
`markGatePassed`; else `markGateFailed` (blocking) / advisory; set
`output_artifact_ref` when declared.
- `Tests (RED→GREEN) →` present→passed; missing/stale→failed; advisory→
  non-blocking. `Assertion migration →` the existing `artifact_required → skipped`
  + `TODO(M12)` WARN test migrates to executed behavior.
- `AC (DoD) →` gate executes per §3.6; this is the review-refusal mechanism.
  `Mechanic →` `INTEG`/`UNIT`.

**T4.3 — Takeover return records artifacts** (`runner-graph.ts` return path):
**before** `markDownstreamStale`/rerun, record `commit_set` (`git-log` from
`returned_commits`) + `diff` (`git-range`) artifacts.
- `Tests (RED→GREEN) →` INTEG: return → two artifacts exist → THEN downstream
  stale (ordering asserted). `AC (DoD) →` roadmap AC6 holds. `Mechanic →` `INTEG`.

**T4.4 — Review refusal + merge guard.** Ship `assertEvidenceReady(runId,
"review"|"merge")` (`web/lib/flows/graph/evidence-readiness.ts`): aggregates
`requiredFor` artifacts + blocking `artifact_required` gates → ready/blocked +
reasons. **Review** wiring: the `human_review` node's `pre_finish` blocking
`artifact_required` gate (T4.2) already prevents `approve→done` on failure; the
guard backs the run-detail/board "evidence" surface. **Do NOT modify the
scratch-only `promote` route**; the `merge` phase of the guard is shipped +
unit-tested for M18 to call.
- `Tests (RED→GREEN) →` INTEG: review node with a failing blocking
  `artifact_required` gate cannot reach `approve→done`; UNIT: guard returns
  `blocked` for missing/stale `requiredFor:[merge]`, `ready` when current+ok.
- `AC (DoD) →` roadmap AC4 review-half end-to-end; merge-half guard unit-proven
  (merge wiring → M18, per D6). `Mechanic →` `INTEG` + `UNIT`.

### Phase 5 — ADR-022 projector (scoped, TDD)

**T5.1 — Cursor store + projector core** (`web/lib/projector/artifact-projector.ts`):
`projectRunEvents(runId,{db})` — per `<stepId>.events.jsonl`, read from
`last_monotonic_id` to EOF, derive tool-activity `log` + `preview` artifacts from
`session.update`/`session.permission_request`, then in **one tx** upsert
(deterministic `proj:<runId>:<stepId>:<monotonicId>`) **and** advance the cursor.
Unknown shapes skipped but cursor advances.
- `Tests (RED→GREEN) →` `__tests__/artifact-projector.test.ts`: idempotent re-run
  (no dup); **crash-safe replay** (reset cursor → re-derives same rows); poison
  event skipped + cursor advances; never writes `runs.status`.
- `AC (DoD) →` §3.6 projector invariants hold; roadmap AC7 (restart) half.
  `Mechanic →` `INTEG` + `UNIT`.

**T5.2 — Wiring (pull, no watcher).** Call `projectRunEvents` from runner sync
points (node start/finish, checkpoint, terminal) in `runner-graph.ts`; add an
idempotent **startup catch-up sweep** in `web/instrumentation.ts` (after the
existing resume/takeover sweeps) over in-flight runs (`Running|NeedsInput|
NeedsInputIdle|HumanWorking|Review`).
- `Tests (RED→GREEN) →` catch-up sweep projects an in-flight run's pending events
  on boot; bounded (LIMIT) + idempotent on second call.
- `AC (DoD) →` no `fs.watch`/`chokidar`/polling introduced; sweep idempotent +
  bounded. `Mechanic →` `INTEG` + `LINT` (grep guard) + house-rule review.

### Phase 6 — API routes (TDD)

**T6.1 — `GET /api/runs/[runId]/artifacts`** (`…/artifacts/route.ts`): auth
(`requireActiveSession` + `requireProjectAction(projectId,"readBoard")`,
`projectId` from run row); evidence index + filters (`?node=&kind=&validity=`).
- `Tests (RED→GREEN) →` `__tests__`/`.integration`: 401/403 RBAC; 404 unknown
  run; 200 list; filters apply. `AC (DoD) →` route returns the index, RBAC
  enforced, filters work. `Mechanic →` `INTEG`/`UNIT`.

**T6.2 — `GET …/artifacts/[artifactId]/payload`** (`…/payload/route.ts`):
server-state join (`artifact.run_id===runId` else 404); dispatch by locator —
`file` (read under run dir, **path-confined**, 410 if gone),
`git-range`/`git-log` (via `diffRunWorkspace`/`logRange`),
`gate-verdict`/`hitl-response`/`inline` (DB JSON).
- `Tests (RED→GREEN) →` path-traversal locator → 404 (never reads outside run
  dir); missing file → 410; git diff returns text; cross-run artifactId → 404.
- `AC (DoD) →` payload returns per locator; confinement proven; roadmap AC5
  payload half. `Mechanic →` `INTEG`/`UNIT`.

### Phase 7 — Evidence-graph explorer UI + board badge + i18n (TDD where pure)

**T7.1 — Graph model query** (`web/lib/queries/evidence-graph.ts`):
`buildEvidenceGraph(runId)→{nodes,edges}` (server) — task-input, node attempts,
artifacts, gates, decisions, returned commits; edges (input→node, node→output,
supersession dashed, `staleFrom`), each with validity/state.
- `Tests (RED→GREEN) →` `.test.ts` (pure): graph shape for a seeded fixture;
  stale/superseded marking; filter. `AC (DoD) →` model matches the explorer
  contract; filterable. `Mechanic →` `UNIT`.

**T7.2 — Explorer component** (`web/components/board/evidence-graph.tsx`,
`"use client"` + `next/dynamic ssr:false`): React Flow read-only
(`nodesDraggable`/`nodesConnectable` false, `elementsSelectable`, pan/zoom,
`fitView`), dagre LR, custom `NodeAttemptNode` + `ArtifactNode` (HeroUI chips),
filter controls (URL `searchParams`), payload drawer (HeroUI modal + `<pre>`
reusing `HandoffBlock` styling) fetching the payload route. Add `@xyflow/react` +
`@dagrejs/dagre`; import CSS. New `<section>` in `runs/[runId]/page.tsx` between
timeline and `FlowSettingsPanel`.
- `DoR →` `@xyflow/react` v12+ peer-range verified vs React 19.2.
- `Tests →` pure layout/transform helpers `.test.ts`; rendered canvas at E2E (no
  RTL unit — React Flow needs DOM/canvas; the unit glob is `*.test.ts` not
  `*.test.tsx`).
- `AC (DoD) →` explorer renders nodes+artifacts with current/stale/superseded,
  filters by node/kind/state, opens payloads; **payload drawer modal follows the
  data-page a11y bar** (focus-trap + initial focus + restore, Escape-to-close,
  body scroll lock, `aria-labelledby`); filter state in URL `searchParams`
  (deep-linkable) per `web/CLAUDE.md`. `Mechanic →` `E2E` (T8.2) + `UNIT` (helpers)
  + manual a11y check.

**T7.3 — Board evidence badge** (`web/lib/queries/board.ts` + `flight-card.tsx`):
add `evidenceStale`/`mergeBlocked` to `FlightCard`; compute in `getFlightCards`
from `artifact_instances` (stale/required-missing) + blocking `artifact_required`
gate; render a pill in the existing badge cluster (alongside `refused`/
`reworking`).
- `Tests →` board query computes the flag from a fixture. `AC (DoD) →` flag
  computed + pill renders. `Mechanic →` `UNIT`/`INTEG` + `E2E`.

**T7.4 — i18n.** EN+RU keys in `web/messages/en.json` + `ru.json` under `run`
(`evidenceTitle`, `evidenceEmpty`, `artifactKind`, validity labels, `openPayload`,
`payloadGone`) and `board` (`evidenceStale`). Lockstep EN/RU.
- `AC (DoD) →` EN/RU key parity; no missing-key at render. `Mechanic →` `E2E`
  render + EN/RU key-set diff check.

### Phase 8 — `aif` flow migration + e2e

**T8.1 — Migrate `plugins/aif/flow.yaml`** + bump `compat.engine_min: 1.2.0`:
`plan` produces `{id:plan-summary,kind:human_note}`; `implement` requires
`plan-summary`, produces `{id:impl-diff,kind:diff,requiredFor:[review,merge]}`;
`checks` produces `{id:lint-report,kind:lint_report}`; `judge` requires
`impl-diff`+`lint-report`, produces `{id:judge-verdict,kind:ai_judgment}`;
`review` requires `judge-verdict` + one blocking `artifact_required` gate (on
`impl-diff`) in `review.pre_finish` to demonstrate review refusal.
- `Assertion migration →` update aif manifest fixtures/snapshots + the M11a/b/c
  e2e seeds that load the aif manifest (enumerate the affected `web/e2e/*.spec.ts`
  + `_fixtures` at the start of this phase; update **here**, not as follow-up).
- `AC (DoD) →` aif loads/validates at engine 1.2.0; existing m11a/b/c e2e stay
  green. `Mechanic →` `INTEG` + `E2E` (m11a/b/c regressions).

**T8.2 — Playwright e2e** `web/e2e/m12-evidence-graph.spec.ts` (seeded, authed,
`maister_e2e` DB): run produces artifacts → explorer renders node-attempt +
artifact nodes (current) → open a payload (diff) → request rework → downstream
artifacts show `stale` → re-run supersedes → **approve while a blocking
`artifact_required` gate is failed/stale → review refused (cannot finish)** →
after re-produce → approve succeeds.
- `DoR →` artifact seed fixture + dedicated `maister_e2e` DB (per M11a/b/c
  pattern). `AC (DoD) →` the roadmap AC list (review-refusal variant per D6) is
  demonstrably satisfied. `Mechanic →` `E2E`.

### Phase 9 — Docs as-built reconciliation + verify gate

**T9.1 — Reconcile docs to as-built.** Flip status tags `Designed→Implemented`
for M12 pieces; correct any Phase-0-spec ↔ code drift (code wins). Update
`web/CLAUDE.md` route list + `docs/getting-started.md` deps note. Flip the M12
roadmap checkbox `[x]` with an as-built paragraph via `/aif-roadmap` (roadmap
owned by that command — only the checkbox/as-built per ownership boundary).
- `AC (DoD) →` no `Designed` tag remains for shipped M12 pieces; route list +
  deps note current. `Mechanic →` `DOCS` + reviewer drift check.

**T9.2 — Verify gate.** `DOCS` + `OPENAPI` + `ASYNCAPI` + `TYPES` + `UNIT` +
`INTEG` + `E2E` + `LINT` all green; §8 traceability matrix fully green.
- `AC (DoD) →` §6.6 Milestone DoD holds. `Mechanic →` all tags + `/aif-verify`.

---

## 8. Acceptance-Criteria Traceability Matrix

Each roadmap M12 AC (lines 103–127) → owning task(s) → verifying mechanic. This is
the milestone DoD; `/aif-verify` re-derives it from the diff.

| # | Roadmap AC (abridged) | Task(s) | Verifying mechanic |
| --- | --- | --- | --- |
| AC1 | Validation rejects dup ids / unknown inputs / bad kinds / bad paths / unproducible merge-required | T2.2 | `UNIT` `config-artifacts.test.ts` (one case per rule) |
| AC2 | Linear v1 flows record default artifacts (log, guard metrics, human/form answer, diff) w/o graph syntax | T3.3 | `INTEG` (linear run @1.1.0 → 4 defaults) |
| AC3 | Graph node required inputs fail before action; required outputs fail before finish | T3.1, T3.2 | `INTEG` (spy: action not called; finish blocked) |
| AC4 | Rework/takeover stale downstream artifacts; **review** (and merge — M18) refuse on missing/stale/failed/skipped | T4.1, T4.2, T4.4 | `INTEG` (stale + review blocked) + `UNIT` (merge guard) — merge wiring → M18 (D6) |
| AC5 | Explorer renders attempts+artifacts (current/stale/superseded), filters, opens payloads | T7.1, T7.2, T6.2 | `UNIT` (model) + `E2E` (render/filter/payload) |
| AC6 | Takeover return records `commit_set` + `diff` before rerun | T4.3 | `INTEG` (ordering asserted) |
| AC7 | Artifact metadata survives restart; UI explains evidence without worktree rescan | T1.x, T5.1, T5.2 | `INTEG` (replay from cursor; boot catch-up) + DB-backed index |
| AC8 | Deferral list (blob store, marketplace, … external ingestion) | D1, T0.1, T0.2 | `DOCS` (ADR-033 + artifacts.md state deferrals; no code) |
| Arch note | Artifact instances written by the web-side **projector** from the event stream (ADR-022) | D2, T5.1, T0.1 | `INTEG` (projector) + `DOCS` (ADR-034 refines ADR-022) |

**Boundary note for AC4:** the **review** refusal is fully demonstrated in M12
(blocking `artifact_required` gate at `human_review`). The **merge** refusal guard
is shipped + unit-tested but **wired at flow promotion in M18** (the M12
promote route is scratch-only). This is an explicit, ADR-recorded boundary
(D6), not a dropped criterion.

---

## 9. Test integrity / runnability (skill-context rule)

- **Runner mapping** (`web/vitest.workspace.ts`): unit globs `lib/**/*.test.ts`,
  `lib/**/__tests__/**/*.test.ts`, `app/**/__tests__/**/*.test.ts`,
  `components/**/__tests__/**/*.test.ts`; integration globs
  `lib/**/*.integration.test.ts`, `app/**/*.integration.test.ts`. **All new test
  files land in these globs** — artifact-store/projector/config under
  `lib/**/__tests__/`, route tests under `app/api/runs/[runId]/**/__tests__/`,
  pure UI helpers under `components/board/__tests__/*.test.ts`. e2e under
  `web/e2e/*.spec.ts`.
- **Known glob constraint:** the unit glob matches `*.test.ts`, **not**
  `*.test.tsx`. The React Flow canvas is covered at **E2E** (T8.2); only its pure
  transform/layout helpers get `.test.ts` unit tests (T7.1). No
  `vitest.workspace.ts` change needed; extending to `*.test.tsx` for RTL would be
  a separate task with its own runnability check.
- **Per-phase green checkpoint** is the §6.4 Per-phase DoD (clause 2) — the exit
  for Phases 1–9. No phase leaves a touched test red.
- **Assertion migration is in-scope** and named: T2.2 (M11a bare-artifact-string
  skip comment), T4.2 (`artifact_required → skipped` + WARN), T8.1 (aif manifest
  fixtures + M11a/b/c e2e seeds loading the aif manifest). Enumerate exact files
  at each phase start; `/aif-verify` re-derives from the diff.

---

## 10. Commit Plan (checkpoints every ~1 phase)

1. **`docs(m12): spec freeze — ADR-033/034/035 + artifacts analytics + ERD/API + DoR/DoD`** (Phase 0)
2. **`feat(m12): artifact_instances + cursor schema + artifact-store`** (Phase 1)
3. **`feat(m12): manifest artifact validation + engine 1.2.0`** (Phase 2)
4. **`feat(m12): runner-inline artifact recording + templating namespace`** (Phase 3)
5. **`feat(m12): downstream staleness + artifact_required gate + review refusal guard`** (Phase 4)
6. **`feat(m12): ADR-022 artifact projector (event-stream evidence, crash-safe)`** (Phase 5)
7. **`feat(m12): artifacts + payload API routes (path-confined)`** (Phase 6)
8. **`feat(m12): evidence-graph explorer (React Flow) + board badge + i18n`** (Phase 7)
9. **`feat(m12): aif flow artifact contract + m12 e2e`** (Phase 8)
10. **`docs(m12): as-built reconciliation + verify gate`** (Phase 9)

Commit messages end with the required `Co-Authored-By` trailer.

---

## 11. Ratified decisions (prior open questions — Phase-0 DoR)

These were open in iteration 1; ratified here so the Phase-0 spec can freeze. Each
is the implementation default unless Phase-0 evidence contradicts it.

1. **Projector cursor scope = per-`(run, stepId)`.** The supervisor event log is
   `<stepId>.events.jsonl` and `monotonicId` is per-session/step, so
   `(runId, monotonicId)` is not run-global. Deterministic projector id
   `proj:<runId>:<stepId>:<monotonicId>`; cursor PK `<runId>::<stepId>`. Phase 0
   re-confirms the exact filename against `supervisor/src/events-log.ts`.
2. **`requiredFor` lives only on `output.produces[]`** (single source of truth);
   `artifact_required` gates reference artifact ids and do **not** duplicate the
   flag.
3. **`preview` = link/URL only** (locator `inline`/`file`); no sandbox/whitelist
   (roadmap defers rich preview sandboxing).
4. **`aif` flow gains one real blocking `artifact_required` gate** in
   `review.pre_finish` (on `impl-diff`) to demonstrate review refusal e2e.
5. **`@xyflow/react` pinned v12+** (React 19.2 peer) + `@dagrejs/dagre`; verify
   peer range at install (DoR for Phase 7).
