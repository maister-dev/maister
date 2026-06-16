# Run & Task context visibility — design

- **Date:** 2026-06-16
- **Status:** Approved (brainstorm), pending `/aif-plan`
- **Scope:** web only + one migration. No deploy, no supervisor change.

## Problem

Dogfooding the board surfaced that an in-flight run is opaque:

- The **board flight card** is built "about the run", not "about the task". Its
  top row and footer both show the **worktree branch**
  (`maister/task-<uuid>/attempt-2`) — a path with no human meaning, rendered
  **twice**. The task title only appears as a fallback inside the step row
  (`stepBody`), usually overwritten by `"<type> step"`. No flow, no readable
  node, no description. You cannot tell what is waiting for review without
  opening the run.
- The **run page header** shows only `status + branch + "<KEY-N> <branch>" +
  diff summary`. No task title, no task prompt/description, no flow, no current
  node. "What is this run about?" is unanswerable from the page.
- **Per-step prompts are not persisted.** The final (Mustache-rendered) prompt
  sent to each coding-agent node is computed at dispatch and thrown away. You
  cannot see what each step actually ran.

## Goals

1. The board flight card shows task identity at a glance and is **compact**.
2. The run page header answers "what is this run about" (task + flow + node +
   description).
3. Each node's resolved prompt is captured and viewable per step on the run
   page.
4. From the card you can reach the per-task run history to compare runs.

## Non-goals (Phase 2 / out of scope)

- **Parallel A/B benchmark runs** (several active runs per task at once,
  side-by-side). This is the explicit Phase-2 "A/B benchmark runs" item — it
  changes the board model and launch gating. Today launch is gated to one
  active run per task (`classifyManualTaskLaunchability`); comparison is
  sequential and already lives on the task detail page.
- Touching the flow engine, supervisor, SSE event format, or the HITL
  resolution loop.
- Changing the HITL Inbox or the run page's existing review controls.

## Design

### 1. Board flight card — compact restructure

File: `web/components/board/flight-card.tsx`, data: `web/lib/queries/board.ts`.

- **Row 1 (identity + meta):**
  `● [KEY-N] [task.title (clamp-1)]` · right cluster `[time] [flow-chip]
  [agent] [View]` + small badges (`readiness` / `↺` / `⚠` / `PR` / runs-count).
  - `KEY-N` is a **link to the task page** (`/projects/{slug}/tasks/{number}`).
  - `task.title` becomes the primary identity (replaces branch).
  - `time` moves up from the footer.
  - new `flow-chip` reusing the `FLOW_CHIP` map from `task-card.tsx`.
- **Row 2 (progress, non-done only):** slim spine bars + current node label +
  diff `+X / −Y`. The bordered "step" box is folded into this slim row.
- **Removed:**
  - the worktree branch **entirely** (top row + footer).
  - the **inline HITL form** for **all** kinds (permission / form / human):
    the `FlightCardHitl` block is dropped. A `needs`-status card shows a
    "needs-attention" badge + **View**; the response is given on the run page
    (diff visible for review decisions) or in the HITL Inbox. (Confirmed safe —
    see code facts.)
  - the bordered current-step box and the separate footer row.
- **Comparison entry:** `KEY-N` and the `runs-count` badge link to the task
  page, whose Runs table is the comparison surface (see §4).

### 2. Run page header enrichment

File: `web/components/runs/run-header.tsx`, data: `web/lib/queries/run.ts`,
host: `web/app/(app)/runs/[runId]/layout.tsx`.

- `<h1>` = **task.title** (was `"<KEY-N> <branch>"`).
- `KEY-N` chip beside the status badge; branch stays on its existing line.
- Eyebrow / subtitle = **flow › current node**.
- New **collapsible "Task" block** rendering `task.prompt`
  (`MarkdownBody`, mirroring the task page).
- The existing review controls (`RunHitlResponse` at `layout.tsx:1263`) are
  untouched.

### 3. Per-step prompts (capture + view)

- **Schema:** add `node_attempts.resolved_prompt text` (nullable), beside
  `stdout` (`web/lib/db/schema.ts`). One ALTER-TABLE migration.
- **Write:** in `runAgentStep` (`web/lib/flows/runner-agent.ts`, just after the
  `resolvedPrompt` is computed at line ~610) eagerly
  `UPDATE node_attempts SET resolved_prompt = … WHERE id = ctx.nodeAttemptId`.
  Eager (before dispatch) so the prompt is visible even on a crashed/stuck
  step. Per-attempt, so rework loops record their own prompt each attempt.
- **View:** a collapsible "Prompt" disclosure per node-attempt entry in the run
  timeline (mono + copy, mirroring the chat panel).
- **Old runs:** `resolved_prompt` is null → show the node's **template** from
  the flow manifest with a "resolved prompt not captured for this run" note.
  No best-effort re-render (it would lie on `{{ steps.*.output }}`).

### 4. Run comparison (already built — just link to it)

The task detail page `web/app/(app)/projects/[slug]/tasks/[number]/page.tsx`
already renders a **Runs table** (`#attempt · Flow · Runner/Model · Status ·
Delivery · Duration · Tokens · Started/Ended · Open`) plus token aggregates,
fed by `getTaskDetail` over all `runs WHERE taskId AND runKind=flow`. This is
the "ran on two flows, compare" surface. The only gap is reachability from the
flight card — closed by the `KEY-N`/runs-count links in §1.

## Data & code facts that make this cheap

- `board.ts:225-230` (`getBoardData`) already selects `title`, `prompt`,
  `flowRef` into `taskRows` → threading them into the `FlightCard` DTO is **zero
  new queries**. `slug` is available on the board page for the KEY-N link.
- `tasks.title` / `tasks.prompt` are already LEFT-joined in `getRunDetail`
  (`web/lib/queries/run.ts`) but not in the `select()` — adding them is ~free.
  Flow ref + current node name are already loaded in the run layout for the
  graph; thread them to the header.
- `resolvedPrompt` is computed **in the web process** (`runner-agent.ts:608`)
  and `ctx.nodeAttemptId` is already in context (`:647`) → no cross-process
  plumbing to the supervisor; write straight to the web DB.
- The run page already mounts `RunHitlResponse` (`layout.tsx:1263`), the richer
  variant (open/outdated thread badges, approve soft-warn) → removing the card's
  inline form is a **pure subtraction**, nothing to add on the run page.

## Orphan cleanup

The board's HITL DTO fields (`hitlOptions`, `hitlSchema`, `hitlKind`,
`criticality`, `hitlRequestId`) were consumed only by the card's inline form.
After removal, drop the now-orphaned fetch/projection from `getBoardData` /
`FlightCard` — **but only what is truly orphaned**. The HITL Inbox
(`hitl-inbox.tsx`) uses its own query path; verify before deleting. Keep a
minimal "needs attention" signal for the card's badge (derivable from
`status === "needs"`).

## i18n (EN + RU)

- Add: flow-chip / current-node / "needs-attention" badge labels for the card;
  run-header task-title eyebrow + "Task" block + per-step "Prompt" disclosure +
  "prompt not captured" note + copy.
- Remove: card-only HITL form strings if they become unreferenced (verify the
  Inbox/run page don't share them before deleting).

## Verification

- `pnpm --filter maister-web lint` (scoped), `tsc` 0.
- Unit: `flight-card` + `run-header` render tests updated; new
  `resolved_prompt` write covered.
- e2e: board card shows title/flow + KEY-N link; run page header shows
  task/prompt; a node's prompt is visible in the timeline.
- Migration: `drizzle-kit generate` clean; snapshot intact.

## Open items (confirm at plan time)

- Migration number — resolve against live `main` (an unmerged Flow Studio
  Phase C worktree reserved 0053). Pick next-free, keep journal `when`
  monotonic.
- Flow label on the card/header = `flowRefId` (e.g. `bugfix`), not a pretty
  manifest name (cheap; agreed).
