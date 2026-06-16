# Plan — Run & Task context visibility

- **Branch:** `claude/relaxed-swartz-062cf3` (existing worktree — no new branch)
- **Created:** 2026-06-16 · **Refined:** 2026-06-16 (`/aif-improve` — 6 code-traced refinements, mostly T2.2)
- **Design spec:** `docs/plans/2026-06-16-run-task-context-visibility-design.md` (approved)
- **Scope:** web only + one migration (`0053`). No supervisor / SSE / engine / HITL-loop change.

## Settings

- **Testing:** yes — unit + e2e; per-phase green gate; assertion migration in-scope.
- **Logging:** verbose (DEBUG), especially the `resolved_prompt` write in `runner-agent.ts`.
- **Docs:** yes — mandatory docs checkpoint at completion (route changes through `/aif-docs`).

## Roadmap Linkage

- **Milestone:** "none"
- **Rationale:** Skipped by user — dogfooding-driven UX/observability fix, no matching roadmap milestone.

## Contract surfaces (traced per project plan rules)

| Surface | Changes? | Spec file to update |
| ------- | -------- | ------------------- |
| New DB column (`node_attempts.resolved_prompt`) | **Yes** | Drizzle migration `0053` + `docs/database-schema.md` + `docs/db/*.md` ERD |
| HTTP route (path/method/body/status) | No | — (no route added/changed) |
| SSE / WebSocket event | No | — |
| New domain error code | No | — |
| New env var / config path / sidecar / port | No | — (no deployment-wiring task needed) |
| Flow DSL step type / mode / field | No | — |
| Internal server query DTOs (`getRunDetail`, `getRunTimeline`, `getBoardData`) | Yes (internal, RSC-only) | not a wire contract — covered by unit tests + screens docs |
| External `/api/v1/ext/*` / MCP facade | No | verify untouched (T5.3) |

## Phase 0 — Docs-first (analytics + ERD), before any code

> Project rule: a DB-schema change requires a complete, internally consistent
> analytics/ERD spec BEFORE code. Implementation follows it as SSOT.

### T0.1 — Analytics & ERD for `resolved_prompt` + UX surfaces
- **Deliverable:** docs updated to describe (a) the new `node_attempts.resolved_prompt` column (purpose: captured per-attempt resolved agent prompt; nullable; pre-0053 rows null), (b) run-page per-step prompt surfacing + manifest-template fallback for old runs, (c) the compact board flight card + enriched run header.
- **Files:**
  - `docs/db/*.md` — the `node_attempts` `erDiagram` gains `resolved_prompt`.
  - `docs/database-schema.md` — narrative row for the column.
  - `docs/system-analytics/runs.md` — "Resolved prompt capture" + timeline surfacing; implementation-status tag `Implemented` (this branch).
  - `docs/screens/*` — board card (identity-first compact) + run page (task header + per-step prompt) screen specs.
- **Logging:** n/a (docs).
- **Acceptance:** ERD + schema-doc + analytics consistent and match the column/DTO names the code will use; both ERD artifacts updated (Mermaid + narrative). No spec section describes code that won't exist at branch HEAD.

## Phase 1 — Schema + per-step prompt capture (backend)

### T1.1 — Migration `0053` + `node_attempts.resolved_prompt` column
- **Deliverable:** add `resolvedPrompt: text("resolved_prompt")` (nullable) to `nodeAttempts` beside `stdout`; generate migration `0053_*.sql`.
- **Files:** `web/lib/db/schema.ts`; `web/lib/db/migrations/0053_*.sql` (+ snapshot via `drizzle-kit generate`).
- **Logging:** n/a (schema).
- **Acceptance:** `drizzle-kit generate` clean (one additive `ALTER TABLE … ADD COLUMN`); snapshot + `_journal.json` intact, `when` monotonic above current max. **If a sibling branch lands `0053` first → renumber to next-free, keep `when` monotonic** (known repo gotcha).
- **Deps:** T0.1.

### T1.2 — Eager `resolved_prompt` write in the agent runner
- **Deliverable:** in `runAgentStep` (`web/lib/flows/runner-agent.ts`, right after `resolvedPrompt` is computed ~L608-610, before dispatch), `UPDATE node_attempts SET resolved_prompt = resolvedPrompt WHERE id = ctx.nodeAttemptId`. Per-attempt; eager so it survives a crashed/stuck step. Write is **best-effort**: on failure log `WARN [runner-agent] resolved_prompt persist failed` and continue (never block dispatch / crash the run — it is audit data, no deferred is created).
- **Files:** `web/lib/flows/runner-agent.ts` (+ `ctx.db` is in scope).
- **Logging:** verbose — DEBUG `resolved_prompt persisted {runId, nodeAttemptId, promptLen}` on success; WARN on failure.
- **Acceptance:** after a node dispatches, its `node_attempts` row has `resolved_prompt` set; a rework attempt writes its own row's prompt; a simulated UPDATE failure logs WARN and the step still dispatches.
- **Deps:** T1.1.

## Phase 2 — Board flight card (compact restructure)

### T2.1 — `FlightCard` DTO: thread identity, drop orphaned HITL fields
- **Deliverable:** extend `FlightCard` with `title`, `flowRef` (both already in `taskRows`, `board.ts:225-230` → no new query). **`slug` is NOT in the DTO** — it is passed to `FlightCard` as a render prop from `board.tsx` (mirrors `TaskCard`); the KEY-N link is built from `slug` + DTO `number`. **Remove** the now-orphaned card-only HITL fields (`hitlOptions`, `hitlSchema`, `hitlKind`, `criticality`, `hitlRequestId`) from the `FlightCard` DTO and their projection in `getBoardData`; keep a minimal `needs`-attention signal (derive from `status === "needs"`). HITL Inbox uses `lib/queries/hitl` (verified) — unaffected.
- **Files:** `web/lib/queries/board.ts`.
- **Logging:** standard (query is hot; no per-row logs).
- **Acceptance:** board query returns `title`/`flowRef` per flight card; HITL option/schema fields gone from the DTO; `getHitlInbox` path untouched; a `needs` card still flags attention without the removed fields.
- **Deps:** none (parallel with Phase 1).

### T2.2 — `flight-card.tsx` + `board.tsx`: compact layout, remove branch & inline HITL
- **Deliverable:**
  - **Layout:** Row 1 `● [KEY-N→/projects/{slug}/tasks/{number}] [task.title clamp-1] · [time] [flow-chip] [agent]` + small badges (readiness/↺/⚠/PR/runs). Row 2 (non-done): slim spine + current node label. Reuse `FLOW_CHIP` from `task-card.tsx`.
  - **Remove:** the worktree branch entirely (top + footer); the `FlightCardHitl` block (all kinds); the bordered step box; the footer row; **and the vestigial diff `+X/−Y`** — `getBoardData` hardcodes `plus/minus = null` (`board.ts:549`), so the diff block never renders today. Drop it (don't "relocate").
  - **Nested-anchor fix:** the card container is **always a `<div>`** (never an outer `<Link>` — it now always contains the KEY-N link). For click-anywhere→run, add a **stretched-link overlay** `<Link href=/runs/{runId}>` at `z-0` (e.g. `absolute inset-0`); raise the KEY-N link (→ task) and any lifecycle/launch buttons above it (`relative z-10`). The explicit "View" link becomes redundant (overlay covers it) — **drop it**.
  - **Node label:** Row 2 shows `stepId` (`board.ts:539`) — `getBoardData` does not load the manifest, so **no pretty `displayLabel` on the card** (the run header does that, see T3.2).
  - **`board.tsx`:** extend `flightLabels` (`board.tsx:73`) with flow-chip / needs-attention / node labels; pass `slug` (in scope, `board.tsx:65`) as a new `FlightCard` prop.
- **Files:** `web/components/board/flight-card.tsx`; `web/components/board/board.tsx`; retire `flight-card-hitl.tsx` if fully orphaned (verify no other importer); `web/messages/en.json` + `ru.json`.
- **Logging:** n/a (presentational).
- **Acceptance:** card shows KEY-N (links to task page) + title + flow + time; no branch text anywhere; no inline approve/rework/confidence; no dead diff block; click-anywhere opens the run without nested-anchor warnings; compact (fewer rows); EN+RU parity.
- **Deps:** T2.1.

## Phase 3 — Run page header + per-step prompt view

### T3.1 — `getRunDetail`: add task + flow + current node
- **Deliverable:** add `tasks.title`, `tasks.prompt` to the `select()` (already LEFT-joined, `run.ts:210`); `currentStepId` + `flowId`/`flowRevisionId` are already selected — surface flow ref + the manifest-resolved current node label (loaded in the run layout for the graph) to the header data.
- **Files:** `web/lib/queries/run.ts`; `web/app/(app)/runs/[runId]/layout.tsx` (wire new fields into the header props; `shellTitle` becomes `task.title`).
- **Logging:** standard.
- **Acceptance:** run detail data carries task title/prompt, flow ref, current node label.
- **Deps:** none (parallel with Phase 1/2).

### T3.2 — `run-header.tsx`: task-first header + collapsible Task block
- **Deliverable:** H1 = `task.title`; `KEY-N` chip beside status; eyebrow = `flow › current node`; branch stays on its line; new collapsible "Task" block rendering `task.prompt` (`MarkdownBody`). **Node label:** unlike the card (`stepId`), the run layout already loads the manifest/topology for the graph → the eyebrow uses the human-readable node `displayLabel`. Watch: don't duplicate what `RunInspector` already shows.
- **Files:** `web/components/runs/run-header.tsx`; `layout.tsx` (header composition); `web/messages/en.json` + `ru.json`.
- **Logging:** n/a.
- **Acceptance:** run page header shows task title + KEY-N + flow›node + expandable prompt; existing `RunHitlResponse` (`layout.tsx:1263`) untouched; EN+RU parity.
- **Deps:** T3.1.

### T3.3 — Timeline: per-attempt "Prompt" disclosure
- **Deliverable:** surface the captured prompt per node-attempt in the run timeline. Data path (concrete):
  1. add `resolvedPrompt` to the `attemptRows` select in `getRunTimeline` (`run.ts:523-546`) **and** to the `TimelineEntry` interface (`run.ts:407`);
  2. thread it through the `TimelineEntry → FlowNodeAttemptResult` view-model transform (in `layout.tsx`);
  3. render a collapsible "Prompt" (mono + copy, mirroring the chat panel) in `AttemptRows` (`flow-run-center.tsx:170`).
  When `resolved_prompt` is null (pre-0053 runs) show the node's manifest **template** with a "resolved prompt not captured for this run" note (no re-render).
- **Files:** `web/lib/queries/run.ts` (`getRunTimeline` + `TimelineEntry`); `web/app/(app)/runs/[runId]/layout.tsx` (view-model transform); `web/components/runs/flow-run-center.tsx`; `web/messages/en.json` + `ru.json`.
- **Logging:** n/a.
- **Acceptance:** a run with captured prompts shows each step's prompt; an old run shows the template + the "not captured" note; copy works; EN+RU parity.
- **Deps:** T1.1 (column). (Shares `run.ts`/`layout.tsx` with T3.1 — keep #6→#8 ordering to serialize those edits.)

## Phase 4 — Tests

### T4.1 — Unit tests (+ migrate existing)
- **Deliverable:** new/updated unit tests:
  - `flight-card.test.ts` — renders KEY-N link + title + flow + time; **no** branch text; **no** inline HITL controls; **no** diff block; stretched-overlay link present. Migrate existing `flight-card.test.ts` / `flight-card-refused.test.ts` assertions that referenced branch/HITL form.
  - run-header render test — title H1 + KEY-N + eyebrow + Task block.
  - `board.ts` query test — DTO carries title/flowRef, HITL fields removed.
  - `run.ts` query test — `getRunDetail` returns task title/prompt + flow/node; `getRunTimeline` entries carry `resolvedPrompt`.
  - `runner-agent` — `resolved_prompt` eager write (success + WARN-on-failure-still-dispatches).
- **Runner:** all under `maister-web` vitest unit (`*.test.ts`); confirm the include glob matches each file (extend if a new path family is introduced — none expected).
- **Acceptance:** suite green; no stale assertions; each promised test executes.
- **Deps:** Phases 1-3.

### T4.2 — e2e
- **Deliverable:** e2e covering board card (title + flow visible, KEY-N → task page), run header (task title + prompt block), and timeline prompt disclosure. **Seed:** the e2e seed must populate `node_attempts.resolved_prompt` for the "prompt visible" assertion, OR assert the manifest-template fallback path on an unseeded (pre-0053-style) run. If a new spec file is added, register it in the Playwright AUTHED_SPEC regex (known gotcha).
- **Runner:** `maister-web` Playwright (kill `:3000`/e2e ports first; never `--last-failed`).
- **Acceptance:** authed e2e green ×1 (baseline-prove if a pre-existing red appears).
- **Deps:** Phases 1-3.

## Phase 5 — Verification & docs checkpoint

### T5.1 — Gates green
- `pnpm --filter maister-web lint` scoped / `eslint .` check-only (do NOT run no-path `lint` — reformats repo); `tsc` 0; `pnpm test:unit && pnpm test:integration` green; `drizzle-kit generate` clean; `pnpm validate:docs:all`.

### T5.2 — Mandatory docs checkpoint
- Route Phase-0 doc changes through `/aif-docs`; confirm ERD (both artifacts) + schema-doc + system-analytics + screens are consistent with shipped code.

### T5.3 — Orphan & contract sweep
- Confirm `flight-card-hitl.tsx` (and any now-unused i18n keys / HITL DTO fields) are removed only where truly orphaned; `getHitlInbox` + run-page `RunHitlResponse` + `/api/v1/ext/*` + MCP facade unaffected.

## Commit Plan (checkpoints every 3-5 tasks)

1. **`docs(plans): analytics + ERD for resolved_prompt and run/task context`** — T0.1.
2. **`feat(runs): capture resolved per-step prompt on node_attempts`** — T1.1 + T1.2.
3. **`feat(board): compact flight card — task identity, drop branch + inline HITL`** — T2.1 + T2.2.
4. **`feat(runs): task-first run header + per-step prompt timeline`** — T3.1 + T3.2 + T3.3.
5. **`test(runs,board): unit + e2e for context visibility`** — T4.1 + T4.2.
6. **`chore: gates, docs checkpoint, orphan sweep`** — T5.1 + T5.2 + T5.3.

(Commit trailer per project convention — no AI trailer.)
