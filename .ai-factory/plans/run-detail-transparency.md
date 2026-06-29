# Run-detail transparency improvements

> ✅ **IMPLEMENTED 2026-06-29** — all phases A–E landed on `claude/sleepy-ardinghelli-3f13f0`.
> Commits: `5cab90e6` (Phase 0 live-refresh) · `2b982617` (A) · `1eecc8b6` (B core, migration
> 0083) · `95333af3` (B UI) · `004fe3d9` (C) · `0aca50b1` (D cost) · `367e32d3` (E docs) ·
> `d88df2f9` (rename test fixtures). Gate green: web tsc + supervisor tsc; supervisor 390;
> web unit 5394; web integration 1894 (the 2 misses = a fixed migration-fixture + a Docker
> port-exhaustion flake that passes in isolation); eslint 0 errors; validate:docs;
> redocly/asyncapi 0 new errors.

- **Branch:** `claude/sleepy-ardinghelli-3f13f0` (existing worktree — no new branch created)
- **Created:** 2026-06-29
- **Mode:** full / SDD (spec-driven) → TDD implementation
- **Plan file:** `.ai-factory/plans/run-detail-transparency.md`

## Settings

- **Testing:** yes — TDD, RED → GREEN → refactor. Tests cover all required behavior + edge
  cases, minimal overlap, no trivial assertions.
- **Logging:** verbose (DEBUG during dev) on every new server path.
- **Docs:** mandatory — OpenAPI/AsyncAPI contracts + `docs/system-analytics/` are part of
  "done" for each phase (SDD).
- **Roadmap linkage:** none (UX/observability hardening, not a milestone).
- **Principles:** SOLID / KISS / DRY, project conventions (`web/CLAUDE.md`,
  `.ai-factory/rules/*`). Surgical changes — every changed line traces to a task.

## Problem & motivation

A flow run is a **black box**: the run-detail page shows node statuses and aggregate tokens
but not *what the coding agent is doing*, per-node token spend is wrong, and node statuses are
dense text. The triggering incident: a run looked "hung" while it had actually advanced
intake → plan → improve → plan_review → (rework) → plan#2 → improve#2 → approve → implement;
nobody could tell, because the page surfaces no live agent activity and the open tab did not
re-render. The opacity itself is the defect.

## Already shipped (context — DO NOT re-plan)

Live-refresh of the server-rendered run-detail tree on real transitions (fixes the stale-tab
"looks hung" half):

- `web/lib/runs/run-stream-event.ts` — `appendRunStreamEvent`: durable `run.needs_input`
  event appended to `run.events.jsonl` (monotonicId = file max + 1) at non-agent gates so the
  SSE tail ticks after the NeedsInput commit.
- `web/lib/runs/live-refresh.ts` (`runViewKey` / `shouldRefreshRunView`) +
  `web/components/runs/run-live-refresh.tsx` — `router.refresh()` ONLY on a status/current-node
  change (no refresh storm during streaming).
- Wired: `web/lib/flows/graph/runner-graph.ts` (3 non-agent gate sites) +
  `web/app/(app)/runs/[runId]/layout.tsx` (mount).
- Tests green: `lib/runs/__tests__/run-stream-event.test.ts`,
  `lib/runs/__tests__/live-refresh.test.ts`; tsc/eslint/full graph suite clean.

> **Contract debt from this work (folded into Phase E):** the new SSE event type
> `run.needs_input` on `GET /api/runs/{runId}/stream` is **not yet in
> `docs/api/async/web-runs.asyncapi.yaml`**. Phase E documents it.

## Confirmed facts (grounding — verified against code + live DB + on-disk artifacts)

1. **Agent output already exists in the stream.** Supervisor emits `agent_message_chunk`,
   `agent_thought_chunk`, `tool_call`/`tool_call_update`, `usage_update` as `session.update`
   into the durable per-run `run.events.jsonl` (SSE pipe-to-disk, root ADR §2). Events carry
   `sessionName`; multi-session runs interleave node sessions in one file. The flow page never
   renders them; only `flow-graph-view` consumes the stream (for status chips).
2. **Scratch already has the full transcript mechanism**: `interpretScratchUpdate` +
   `parseScratchMessageContent` (`web/lib/scratch-runs/transcript.ts`) and `ScratchTranscript`
   (`web/components/scratch/scratch-transcript.tsx`); scratch persists to `scratch_messages`
   via a live supervisor-stream consumer and renders from those rows.
3. **Per-node tokens are wrong**: `cost.jsonl` for the incident run held exactly ONE record —
   `plan#1` (`nodeAttemptId 9c5a1591`, total 69,044). `improve`, `plan#2`, `improve#2`,
   `implement` wrote NO cost records though they ran and emitted usage. Run-total = first
   session only; every later node shows 0. `supervisor/src/cost.ts#extractCost` matches only
   **snake_case** `usage.input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`;
   the ACP adapter's end-turn `result.usage` is **camelCase** (`inputTokens`, `cachedReadTokens`,
   `cachedWriteTokens`) → unmatched. `attachCost` is attached per session; M42 multi-session
   attach/attribution is the second suspect. Root-cause spike (T3.1) decides; the fix (T3.2)
   covers both defensively.
4. **Node statuses are raw text** in the "Ноды" list and the selected-node «СТАТУС» field
   (e.g. `Succeeded`, `NeedsInput` — not even localized), while the canvas localizes via
   `FlowNodeBody`. `web/lib/runs/run-status-tone.ts` maps **run** status → tone/dot/badge but
   node statuses (`Succeeded|Stale|Reworked|Pending|Running|NeedsInput|Failed|…`) have no shared
   icon helper.

## Key design decision (SDD) — flow transcript source

**Decision (confirmed by owner — Q1 = "persist like scratch"): ONE generalized, persisted
transcript mechanism shared by scratch AND flow.** Generalize `scratch_messages` →
`run_messages` (run-kind-agnostic, nullable `node_attempt_id`), generalize the scratch
ingestion + parse + render, and persist flow `ai_coding` node sessions into the same table,
attributed per `node_attempt_id`. Render both surfaces from the same rows via the same
component. No second implementation anywhere — identical mechanism end-to-end (ingest → persist
→ render).

Mechanism shape:
- **Store:** `run_messages` (generalized `scratch_messages`): `id, run_id, node_attempt_id?
  (NULL for scratch / single-session), sequence, role, content, supervisor_event_id?,
  created_at`. Unique `(run_id, node_attempt_id, sequence)` (scratch keeps `(run_id, sequence)`
  with NULL node_attempt_id).
- **Ingest (identical transform, two entry points by run kind):** the SAME
  `interpretSessionUpdate` coalescer + payload encoders write rows. Scratch keeps its live
  supervisor-stream consumer (repointed to `run_messages`). Flow uses a **projector** that
  tails the durable `run.events.jsonl` (the same pattern as `artifact-projector.projectRunEvents`
  + `cost-rollups.reconcileRunCostRollups`: reconcile-on-read, idempotent, **resume cursor =
  `max(run_messages.supervisor_event_id)` per run — identical to the scratch consumer, no
  separate cursor table**) over `type:"session.update"` lines and writes `run_messages` with
  `node_attempt_id` taken from the **supervisor-stamped `nodeAttemptId`** on the event (see
  T-B0). Both call the identical encode/coalesce code.

> **Attribution prerequisite (verified by the improve pass):** `run.events.jsonl` does NOT
> currently carry `nodeAttemptId` (0 occurrences) and `sessionName`
> (`default`/`implement`/`verify`) is not 1:1 per node — so the events log alone cannot
> attribute a message to a node. **T-B0 stamps `nodeAttemptId` on the events log** (mirroring
> `cost.ts`), which the projector then reads. Without T-B0 the whole flow side of Phase B
> cannot attribute output.
- **Render:** the shared `TranscriptView` over `TranscriptMessage[]` for both surfaces.

Rationale for the projector (not a second live consumer) on the flow side: flow node sessions
are spawned/owned by the graph runner and there is no scratch-style long-lived web consumer per
node; the durable `run.events.jsonl` already captures every event (ADR §2), so a
reconcile-on-read projector is the lowest-risk way to "persist like scratch" while keeping the
transform identical. This mirrors how cost + artifacts are already projected from the same log.

→ Confirmed. **Migration required** (see below).

## Migrations summary (SDD)

- Phase A (#1 status icons): **no migration.**
- Phase B (#2 transcript): **migration `0083`** — generalize `scratch_messages` → `run_messages`
  (rename, data-preserving) + add nullable `node_attempt_id` (FK → `node_attempts.id`,
  `ON DELETE CASCADE` consistent with run scoping) + index `(run_id, node_attempt_id, sequence)`.
  Next free index is **0083**; set journal `when` **strictly greater** than the current max
  (the m42 entries use `…004/005/006`) per the journal-skew hazard, run `pnpm db:check` +
  boot guard. Update Drizzle schema (`web/lib/db/schema.ts`) — rename the table object +
  add the column; rebuild the snapshot via `pnpm db:generate` (no hand-edit).
- Phase C (layout): **no migration.**
- Phase D (#3 token attribution): **no migration** — the web reconcile
  (`reconcileRunCostRollups` → `nodeAttemptCostRollups`) already attributes correctly *given a
  correct `cost.jsonl`*; the fix is supervisor-side cost capture. T-D1 confirms.

## Contract surfaces touched (SDD — traced to spec files)

| Surface | Change | Spec file |
| --- | --- | --- |
| `run_messages` table (generalized from `scratch_messages`) + `node_attempt_id` (NEW, Phase B) | persisted transcript store | migration `0083` + `docs/database-schema.md` + `docs/db/*` ERD |
| `GET /api/runs/{runId}/transcript?node={nodeId}` (NEW, Phase B) | per-node-attempt transcript read model | `docs/api/web.openapi.yaml` |
| SSE `run.needs_input` on `GET /api/runs/{runId}/stream` (shipped) | new event type | `docs/api/async/web-runs.asyncapi.yaml` |
| `session.update` gains `nodeAttemptId` (NEW, Phase B / T-B0) | per-node event attribution | `docs/api/async/supervisor-sse.asyncapi.yaml` + `web-runs.asyncapi.yaml` |
| `cost.jsonl` record shape (Phase D, if `extractCost` widens) | camelCase usage accepted | `docs/system-analytics/runs.md` (cost section) + `supervisor.md` if a contract line names usage shape |
| run-detail UX (all phases) | screens behavior | `docs/system-analytics/runs.md` + `docs/screens/*` (run detail) |

No new env var / sidecar / bound port / package script → **no deployment-touchpoint task**
(skill-context rule satisfied by explicit "none").

---

## Phase A — Node-status icons + tooltips (#1)

> ✅ Implemented (T-A1, T-A2) — 2026-06-29. `node-status-visual.ts` helper + `run.nodeStatus.*`
> i18n (en+ru) + shared `NodeStatusIcon`; applied to the Ноды list, canvas chip, and selected
> «СТАТУС» field. tsc/eslint/45 unit tests green.

Goal: replace dense status **text** with an icon + accessible tooltip in the three surfaces,
consistently localized. Web-only, no contract, no migration.

### T-A1 — Shared node-status presentation helper
- **Deliverable:** `web/lib/runs/node-status-visual.ts` — pure module: `NODE_STATUS_KEYS`
  union (`Pending|Running|Succeeded|Failed|NeedsInput|Stale|Reworked|Skipped|…` — derive the
  exact set from `node_attempts.status` + `RunNodeStatuses`), `nodeStatusVisual(status) →
  { iconName, tone }` reusing existing `--cv-*`/tone tokens, and an i18n key per status for the
  tooltip text. No React, no DB. Icons from `@heroicons/react/24/outline` (project standard).
- **Files:** new `web/lib/runs/node-status-visual.ts`; i18n keys in `web/messages/{en,ru}.json`
  (`run.nodeStatus.<Status>`).
- **AC:** every node-status value maps to exactly one `{icon,tone,i18nKey}`; an unknown status
  falls back to a neutral icon (never throws); EN+RU keys at parity.
- **Tests (RED first):** `node-status-visual.test.ts` — every known status returns a distinct,
  defined visual; unknown → neutral fallback; key set ⊆ message catalog (parity guard).
- **Logging:** n/a (pure).

### T-A2 — Apply to the three render sites
- **Deliverable:** status rendered as icon + `title`/`aria-label` tooltip (icon-only where
  tight, per UI-affordance rule) in:
  (a) "Ноды" list — `web/components/runs/flow-run-center.tsx` (`node.runtimeStatus` span);
  (b) canvas chip — `web/components/board/flow-graph-view.tsx` / `FlowNodeBody` (replace the
  uppercase status word with the icon, keep tooltip);
  (c) selected-node «СТАТУС» field — `flow-run-center.tsx` dl.
- **Files:** `flow-run-center.tsx`, `flow-graph-view.tsx` (+ `FlowNodeBody`).
- **AC:** no raw English status text remains in these three places; every status icon has an
  accessible name = localized status; existing e2e/testids preserved; visual parity light/dark.
- **Tests:** extend the existing static-markup component tests (`renderToStaticMarkup`) to
  assert the icon's `aria-label`/`title` equals the localized status and that the raw status
  word is gone; canvas node test asserts status icon present with accessible name.
- **Blocked by:** T-A1.

---

## Phase B — Flow per-node live agent output (#2, PRIMARY)

Goal: surface the coding-agent transcript (assistant text, thinking, tool calls, usage) for a
flow's `ai_coding` nodes, in the **center** node block / chronology, active node expanded by
default — reusing scratch's mechanism (decision above).

### T-B0 — Supervisor: stamp `nodeAttemptId` on `run.events.jsonl` (keystone)
- **Deliverable:** extend `supervisor/src/events-log.ts` `openEventsLog`
  (`OpenEventsLogOptions`) to accept `nodeAttemptId` and include it on every appended event
  (next to `sessionName`); wire it from the spawn/session-start path (the id is already
  available at `spawn.ts` and passed to `attachCost`). Mirrors `cost.ts` attribution exactly.
- **Why (verified):** `run.events.jsonl` has 0 `nodeAttemptId` today and `sessionName` is not
  1:1 per node — the flow projector (T-B2) cannot attribute messages without this.
- **Contract:** `session.update` gains `nodeAttemptId` → `docs/api/async/supervisor-sse.asyncapi.yaml`
  + `web-runs.asyncapi.yaml` (T-E1).
- **AC:** every event line of a node session carries its `nodeAttemptId`; single-session/scratch
  runs keep `sessionName=default` with `nodeAttemptId` absent/optional; existing events-log
  tests pass.
- **Tests (RED first):** `events-log.test.ts` — appended line includes `nodeAttemptId` when
  provided, omits cleanly when not; spawn-wiring test that a node session's events carry its
  attempt id.
- **Blocks:** T-B2, T-E1.

### T-B1 — Extract shared transcript substrate (no behavior change)
- **Deliverable:** move the run-kind-agnostic pieces out of `scratch-runs`/`scratch` into a
  shared home, with scratch re-exporting for back-compat (zero behavior change):
  - parse/types → `web/lib/run-transcript/transcript.ts` (`interpretScratchUpdate` →
    `interpretSessionUpdate`, `parseScratchMessageContent` → `parseTranscriptMessageContent`,
    payload encoders/types). Keep thin `scratch-runs/transcript.ts` re-export shims.
  - render → `web/components/run-transcript/transcript-view.tsx` (the current
    `ScratchTranscript` body, renamed `TranscriptView`); `scratch-transcript.tsx` re-exports.
- **AC:** ALL existing scratch transcript tests stay green unchanged (proves no behavior
  drift); no duplicated parse/render logic remains (DRY); public scratch imports unbroken.
- **Tests:** existing scratch transcript + conversation suites are the regression gate; add a
  re-export smoke test asserting `scratch-transcript` still exports `ScratchTranscript`.
- **Logging:** n/a (pure move).

### T-B1b — Generalize `scratch_messages` → `run_messages` (migration + schema + repoint scratch)
- **Deliverable:** migration `0083` (data-preserving rename + nullable `node_attempt_id` FK +
  index `(run_id, node_attempt_id, sequence)`); Drizzle schema rename `scratchMessages` →
  `runMessages` + new column; repoint ALL scratch reads/writes
  (`web/lib/scratch-runs/{messages,events,state,…}.ts`, the scratch GET route) to `run_messages`
  (node_attempt_id stays NULL for scratch). Snapshot via `pnpm db:generate`.
- **Files:** `web/lib/db/migrations/0083_*.sql` + `meta/_journal.json` (`when` > max), schema,
  scratch-runs modules, `docs/database-schema.md` + `docs/db/*` ERD.
- **Config/state-symmetry & data-migration AC:** existing `scratch_messages` rows survive the
  rename with NULL `node_attempt_id`; `pnpm db:check` clean; boot guard passes; ALL scratch
  tests pass against `run_messages` unchanged (behavior identical). Single forward migration,
  no destructive drop of data.
- **Tests (RED first):** schema/migration journal lint (ledger count vs journal, ordering);
  a scratch persistence test re-pointed to `run_messages` proving round-trip; an integration
  test that a flow row with non-null `node_attempt_id` and a scratch row with NULL coexist
  under the unique index.
- **Blocked by:** none (schema axis; parallel to T-B1).

### T-B2 — Flow transcript projector + shared query (persist like scratch)
- **Deliverable:** `web/lib/runs/run-transcript-projector.ts` —
  `projectRunTranscript(runId)`: reconcile-on-read, idempotent (resume cursor =
  `max(run_messages.supervisor_event_id)` per run — identical to the scratch consumer, NO
  separate cursor table), tail `run.events.jsonl` consuming **`type:"session.update"` lines**
  (the unwrapped form `interpret*` expects — NOT `session.line`), run each through the SHARED
  `interpretSessionUpdate` + the SAME coalescer/encoders as the scratch consumer (reuse, do not
  fork), and upsert `run_messages` rows (`ON CONFLICT DO NOTHING` on the unique index) with
  `node_attempt_id` from the **T-B0-stamped `nodeAttemptId`**. Plus a shared read
  `getRunNodeTranscript(runId, nodeId)` → `TranscriptMessage[]` (+ latest usage) selecting
  `run_messages` for the node's **latest** attempt, parsed via the SHARED
  `parseTranscriptMessageContent`.
- **Identifiers (skill-context trust rule):** `runId` = url-param (route-scoped); `nodeId` =
  **server-state-validated** (must be a node of this run's compiled graph; attempt resolved from
  `node_attempts` by `(runId,nodeId)` — never a body path). Events-log path resolved from the
  run's project/local-package slug (server-state), path-confined to the run dir.
- **AC:** after projection, a finished `ai_coding` node yields ordered, coalesced
  assistant/thinking/tool messages identical in structure to scratch for the same event
  sequence (golden test); projection is idempotent (re-run adds nothing); multi-session log
  attributes each message to the right `node_attempt_id`; sessionless node → empty; unknown
  node → typed `PRECONDITION`; never reads/writes outside the run dir.
- **Tests (RED first):** `run-transcript-projector.test.ts` with fixture `run.events.jsonl`
  (multi-session, two nodeAttemptIds): (1) projects rows attributed per node; (2) coalesces
  chunked assistant text; (3) groups `tool_call`+`tool_call_update`; (4) latest usage;
  (5) idempotent re-projection (no dupes — unique index honored); (6) `getRunNodeTranscript`
  filters to the node's latest attempt; (7) path-confinement guard.
- **Logging:** DEBUG (runId, nodeId, lines scanned, rows upserted, cursor); WARN skip-tolerant
  on malformed line.
- **Blocked by:** T-B1, T-B1b.

### T-B3 — Transcript HTTP route + OpenAPI
- **Deliverable:** `GET /api/runs/{runId}/transcript?node={nodeId}` → `{ messages: TranscriptMessage[], usage?: {...} }`.
  Handler calls `projectRunTranscript(runId)` (reconcile-on-read) then `getRunNodeTranscript`.
  **Authz `requireProjectAction(readRepoFiles)` (MEMBER)** — a transcript exposes tool outputs
  / file contents a viewer must not see (mirrors the workbench file-content gate; NOT
  `readBoard`/viewer). Typed errors via `MaisterError` → status map.
- **Files:** `web/app/api/runs/[runId]/transcript/route.ts`; spec in `docs/api/web.openapi.yaml`.
- **Identifiers:** `runId` url-param; `node` query = **server-state-validated** (see T-B2).
- **AC:** 200 shape matches OpenAPI; 403 for non-member; 404/`PRECONDITION` for unknown node;
  secrets never serialized (no acpSessionId/handles in payload).
- **Tests:** route handler test — happy path shape; authz 403; unknown-node error; ensure no
  internal handle leaks. OpenAPI example validated by the repo's redocly/openapi check.
- **Blocked by:** T-B2.

### T-B4 — Center node-block transcript UI (live)
- **Deliverable:** in the center selected-node block / chronology, an expandable transcript
  region per node rendering `TranscriptView` (shared) from the T-B3 route; the **current/active
  node expanded by default**. Live updates via the panel's OWN `useRunStream` subscription
  refetching the transcript route on **content ticks** (debounced) — INDEPENDENT of the shipped
  `RunLiveRefresh` (which refreshes only on status/node transitions, so it would NOT append
  output during a running node). Same pattern as scratch `loadDetail`-on-`eventCount`. Terminal
  runs fetch once (no live polling). Token/usage shown as the existing header-meter style.
- **Files:** `web/components/runs/flow-run-center.tsx` (+ a small client
  `node-transcript-panel.tsx`); i18n keys `run.transcript.*`.
- **AC:** opening a finished node shows its full transcript; the active node auto-expands and
  appends live while the agent streams; collapsing/expanding is per-node and deep-linkable via
  the existing `?node=` param; empty state for sessionless nodes; no transcript fetch for
  terminal runs beyond first load.
- **Tests:** component static-markup test (renders TranscriptView when messages present, empty
  state otherwise, active-node default-open); a DOM-free unit for the "active node expanded by
  default" selection rule.
- **Blocked by:** T-B1, T-B3.

---

## Phase C — Center declutter / sidebar repurpose (#2 layout)

Goal: reduce center noise so the transcript is the focus; give the near-empty sidebar "Flow"
tab a purpose. Web-only, no contract, no migration.

### T-C1 — Move capability/settings blocks to the sidebar "Flow" tab
- **Deliverable:** relocate the three center blocks — **node settings**, **capability profile**,
  **resolved capability set** — out of the center (`layout.tsx` collapsible `<details>` at the
  bottom) into the right-inspector **Flow** tab (`web/components/runs/run-inspector.tsx`).
  Remove the resolved-capability-set block from the main run block.
- **Files:** `web/app/(app)/runs/[runId]/layout.tsx`, `web/components/runs/run-inspector.tsx`
  (+ panels `capability-profile-panel`, `flow-settings-panel`, `resolved-capability-set-panel`
  are reused as-is — moved, not rewritten).
- **AC:** the three blocks render in the Flow tab; center no longer renders them; existing
  panel tests still pass against their new mount; no data/query changes (pure relocation).
- **Tests:** inspector test asserts Flow-tab renders the three panels; a center test asserts
  they are gone from the center.

### T-C2 — Collapse assignment journal by default + trim capability noise
- **Deliverable:** "ЖУРНАЛ НАЗНАЧЕНИЙ" (`run-timeline.tsx`) wrapped in a `<details>` collapsed
  by default; the "no restricted capabilities" empty-state text removed from any always-on
  surface — represented at most by an icon on the node (a small "enforced/restricted" glyph in
  `FlowNodeBody`, shown only when classes exist).
- **Files:** `web/components/board/run-timeline.tsx`, `web/components/board/flow-graph-view.tsx`
  (`FlowNodeBody`), the capability panel empty-state.
- **AC:** assignment journal hidden until expanded (state deep-linkable or local — match
  existing collapsible convention); no "Нет ограниченных возможностей" text on the default
  view; node shows a restriction glyph only when `refusedClasses`/enforcement is non-empty,
  with an accessible tooltip.
- **Tests:** run-timeline test asserts journal collapsed by default + expandable; FlowNodeBody
  test asserts the restriction glyph appears only when classes exist (and its aria-label).
- **Blocked by:** (independent of C1; can parallelize).

---

## Phase D — Per-node token attribution fix (#3)

Goal: per-node token spend is correct for every node of a multi-session run.

### T-D1 — Root-cause spike (supervisor cost capture)
- **Deliverable:** a written root-cause note (`.ai-factory/patches/…` or inline in the PR)
  confirming WHICH defect(s) apply, by replaying the incident `run.events.jsonl` through
  `extractCost`/`attachCost`: (a) usage key-shape — adapter end-turn `result.usage` camelCase
  (`inputTokens`/`cachedReadTokens`/`cachedWriteTokens`) not matched; and/or (b) M42
  multi-session: `attachCost` not (re)attached, or attached without the per-session
  `nodeAttemptId`, for nodes after the first.
- **Files:** read `supervisor/src/{cost.ts,spawn.ts,http-api.ts,acp-client.ts}`,
  `web/lib/runs/cost-rollups.ts`.
- **AC:** the note states the exact failing line(s) + which fix(es) T-D2 must make, and whether
  any web reconcile change is needed (expected: none).
- **Tests:** n/a (spike) — but it produces the fixture used by T-D2 tests.

### T-D2 — Fix cost capture (TDD)
- **Deliverable:** per the spike — at minimum widen `extractCost` to accept the camelCase
  `result.usage` shape and normalize to the canonical snake-case record
  (`inputTokens→input_tokens`, `cachedReadTokens→cache_read_input_tokens`,
  `cachedWriteTokens→cache_creation_input_tokens`, `outputTokens→output_tokens`) WITHOUT
  double-counting when both streaming + result usage appear; and/or ensure `attachCost`
  attaches for every node session in a multi-session run with the correct `nodeAttemptId`.
- **Files:** `supervisor/src/cost.ts` (+ `spawn.ts`/`http-api.ts` if attach/attribution is the
  cause).
- **AC (config/round-trip & no-double-count):** replaying the incident log yields one cost
  record per node session with the right `nodeAttemptId`; totals match the adapter's reported
  usage; **`result.usage` is canonical PER TURN, fall back to streaming usage ONLY when a turn
  emits no `result.usage`, never count both** (a streaming-only turn is still recorded — not
  lost); single-session runs unchanged (regression).
- **Tests (RED first):** `cost.test.ts` extensions — (1) camelCase `result.usage` →
  normalized record; (2) snake-case still works; (3) no double-count when both shapes appear in
  one turn; (4) multi-session fixture → one attributed record per session/nodeAttemptId;
  (5) missing/zero usage → null (existing behavior).
- **Blocked by:** T-D1.

### T-D3 — End-to-end attribution assertion (web reconcile)
- **Deliverable:** an integration test proving the full chain: a multi-node `cost.jsonl`
  (post-fix shape) → `reconcileRunCostRollups` → `nodeAttemptCostRollups` → `getRunTimeline`
  per-node tokens non-zero for each node, and run-total = sum of nodes.
- **Files:** `web/lib/runs/__tests__/` (real-PG integration, existing harness).
- **AC:** per-node timeline tokens match the per-session cost; the selected-node panel
  `tokenTotal` would be non-zero (assert via the timeline DTO); run-total equals the sum.
- **Tests:** the integration test above (no UI).
- **Blocked by:** T-D2.

---

## Phase E — Contracts & system-analytics sync (SDD close-out)

### T-E1 — OpenAPI/AsyncAPI
- `docs/api/web.openapi.yaml`: add `GET /api/runs/{runId}/transcript` (params, 200 schema =
  `TranscriptMessage`, 403/404/PRECONDITION).
- `docs/api/async/web-runs.asyncapi.yaml`: document the shipped `run.needs_input` SSE event
  (the live-refresh contract debt) and note transcript events reuse the existing
  `session.update` stream.
- **AC:** repo OpenAPI/redocly + asyncapi validators pass; examples match handler output.

### T-E2 — system-analytics
- `docs/system-analytics/runs.md`: new "Run transparency" section — per-node transcript read
  model (jsonl-sourced, shared with scratch), node-status iconography, the
  declutter/Flow-tab layout, and the corrected per-node cost attribution (cost.jsonl usage
  shapes + reconcile). Cross-link `scratch-runs.md` (shared transcript substrate).
- Update `docs/screens/*` run-detail doc if present.
- **AC:** docs match shipped behavior; `validate:docs` / mermaid checks pass; CLAUDE.md/docs
  precedence respected (docs win → update both if they disagree).

### T-E3 — Final verification gate
- `pnpm typecheck` (web + supervisor), full `pnpm vitest run` (unit + integration, real PG),
  `pnpm exec eslint` (check-only on changed files), docs validators, supervisor tests.
- **AC:** all green; every new test exercises real behavior (no trivial/over-mocked tests);
  RED→GREEN evidence captured per task.

---

## Commit plan (checkpoints)

1. **Phase A** (T-A1, T-A2) — `feat(runs): node-status icons + tooltips`.
2. **Phase B core** (T-B0, T-B1, T-B1b, T-B2, T-B3) — `feat(runs): stamp nodeAttemptId on events log + generalize transcript store to run_messages + node transcript projector/API` (migration 0083).
3. **Phase B UI** (T-B4) — `feat(runs): live per-node agent output on flow run detail`.
4. **Phase C** (T-C1, T-C2) — `refactor(runs): declutter run-detail center, repurpose Flow tab`.
5. **Phase D** (T-D1–T-D3) — `fix(cost): attribute tokens per node session (multi-session usage shapes)`.
6. **Phase E** (T-E1–T-E3) — `docs(runs): transcript + cost contracts & system-analytics`.

(Commit messages omit the AI trailer per project preference.)

## Resolved decisions (owner-confirmed 2026-06-29)

1. **Транскрипт flow — ПЕРСИСТИТЬ как scratch.** Генерализуем `scratch_messages` → `run_messages`
   (+`node_attempt_id`), общий проектор/парс/рендер, миграция `0083`. (Phase B, design decision
   above.)
2. **#1 иконки — только run-detail** (граф + список нод + панель выбранной ноды). Доска
   (`board.tsx`) — НЕ в этом плане; опциональный follow-up по запросу.
3. **#3 — `result.usage` канонический** за ход; streaming-usage игнорируется при наличии
   `result.usage` (анти-задвоение). (T-D2 AC.)
4. **Flow-таб сайдбара — оставляем и наполняем** 3 блоками возможностей (T-C1).
