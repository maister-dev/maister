# Run Inspector Cost And Time Facts - Fast Implementation Plan

**Branch:** detached `HEAD` in `/Users/developer/.codex/worktrees/d7b6/mAIster` (fast plan; no branch created)
**Created:** 2026-06-25

## Settings

- **Testing:** yes. Add focused unit coverage for any new pure formatter/helper, then run the relevant web checks.
- **Logging:** standard. This is presentation-only; do not add runtime logs unless implementation unexpectedly touches a server read path. If that happens, use structured fields and keep log level at DEBUG for diagnostic-only reads.
- **Docs:** yes. Update the screen reference docs in the same implementation.

## Roadmap Linkage

- **Milestone:** none.
- **Rationale:** This is a focused screen-quality fix for an already-implemented run inspector surface, not a new roadmap milestone.

## Scope

Fix the run inspector overview facts so cost and time are not collapsed into a misleading single value:

- Stop showing `Cost and time` as a single total-token fact.
- Show token usage as a breakdown: token total, input, output, cache-read input, cache-creation input, and resume tax when non-zero.
- Show time as separate facts. Normal flow/agent run keeps active time and wall-clock time; scratch run gains wall-clock time instead of showing no time at all.
- Update EN/RU labels so the RU surface no longer mixes Russian with English token labels.
- Update screen docs for `/runs/{runId}` and `/scratch-runs/{runId}` inspector behavior.

## Contract Surface Checklist

- **HTTP/API/SSE contracts:** none. No route, body, response, or event shape changes.
- **DB/schema/migrations:** none. Existing `getRunCostSummary()` and `getRunDetail()` data is sufficient.
- **Config/env/deployment:** none. No new env vars, ports, host files, sidecars, package scripts, or Docker/Compose changes.
- **State machine/run status:** none. No new enum values, transitions, recovery, scheduler, or concurrency behavior.
- **Docs surfaces:** `docs/screens/runs/run-inspector.md` and `docs/screens/runs/scratch-run.md` only.

## Current Findings

- `web/lib/queries/run.ts` already returns `RunCostSummary` with `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `resumeTokens`, and `totalTokens`.
- `web/app/(app)/runs/[runId]/layout.tsx` currently shows total tokens under `costSummaryTitle`, then separately shows `activeTime` and `wallClock`.
- `web/app/(app)/scratch-runs/[runId]/layout.tsx` currently shows only total tokens under `costSummaryTitle`; it does not show time.
- `web/messages/ru.json` has several run cost/time labels still in English.

## Implementation Progress

- [x] Task 1: Update screen docs before code
- [x] Task 2: Add a small pure helper for cost facts
- [x] Task 3: Wire cost and time facts into normal and scratch run layouts
- [x] Task 4: Run focused verification (blocked by missing pnpm offline tarballs before test/typecheck startup)

## Phase 0 - Screen Contract

### Task 1: Update screen docs before code

**Deliverable:** Screen reference docs describe the target inspector behavior before implementation.

**Files:**

- `docs/screens/runs/run-inspector.md`
- `docs/screens/runs/scratch-run.md`

**Implementation notes:**

- In `run-inspector.md`, change the Overview description from a generic "token/cost summary, active time, wall-clock duration" to explicit facts: token total, input tokens, output tokens, cache-read input tokens, cache-creation input tokens, optional resume tax, active time, and wall-clock time.
- In `scratch-run.md`, note that the shared inspector overview shows token breakdown plus wall-clock session time; keep the conversation context meter described in the run header/transcript area.
- Keep these docs screenshot-free and current-state oriented.

**Logging requirements:** no logging changes. Docs-only task.

**Acceptance criteria:**

- Docs do not imply a money-cost display exists when the UI only has token counts.
- Docs separate token usage from duration.
- Docs do not mention any new API, DB, or state-machine contract.

## Phase 1 - UI Fact Model

### Task 2: Add a small pure helper for cost facts

**Deliverable:** A reusable pure helper builds token facts for both normal and scratch run layouts without duplicating label/order logic.

**Files:**

- Create `web/lib/runs/cost-summary-facts.ts`
- Create `web/lib/runs/__tests__/cost-summary-facts.test.ts`

**Implementation notes:**

- Export a typed helper that accepts `RunCostSummary` plus translated labels and returns ordered `{ label, value }` facts.
- Required order: token total, input tokens, output tokens, cache-read tokens, cache-creation tokens, resume tax only when `resumeTokens > 0`.
- Use `Intl.NumberFormat("en-US")` for token values, matching existing `formatTokens` behavior in the layouts.
- Import `RunCostSummary` with `import type` only so the helper remains client-safe/pure and does not pull DB query code into unintended bundles.

**Logging requirements:** no logs. Pure formatting helper.

**Acceptance criteria:**

- Unit tests cover the full breakdown, zero values, thousands formatting, and omission of zero resume tax.
- Unit tests are runnable by the web unit Vitest project; confirm with `pnpm --filter maister-web exec vitest list --project unit web/lib/runs/__tests__/cost-summary-facts.test.ts`.

### Task 3: Wire cost and time facts into normal and scratch run layouts

**Deliverable:** The inspector overview shows token breakdown and time as separate facts on both run detail surfaces.

**Files:**

- `web/app/(app)/runs/[runId]/layout.tsx`
- `web/app/(app)/scratch-runs/[runId]/layout.tsx`
- `web/messages/en.json`
- `web/messages/ru.json`

**Implementation notes:**

- In `/runs/[runId]/layout.tsx`, replace the single `{ label: t("costSummaryTitle"), value: formatTokens(costSummary.totalTokens) }` fact with the helper-generated token facts, then keep existing `activeTime` and `wallClock` facts.
- In `/scratch-runs/[runId]/layout.tsx`, replace the single `costSummaryTitle` total-token fact with the helper-generated token facts and add a wall-clock fact computed from `detail.startedAt` and `detail.endedAt ?? Date.now()`.
- Do not add scratch `activeTime` unless the implementation also reads a real scratch timeline/attempt duration source; avoid a misleading `0s`.
- Reuse or locally add the existing duration formatter semantics: `-` for null, seconds below 60, minutes below 60, rounded hours after that.
- Update RU labels for run cost/time keys touched here: input tokens, output tokens, cache-read tokens, cache-creation tokens, resume tax, wall-clock, and token total.
- Do not remove `costSummaryTitle` unless a quick grep proves it is unused and removal is safe; the important behavior is that it is no longer used as a fact label for a total-token value.

**Logging requirements:** no new logs. Server layouts already rely on query/read-model behavior; do not add diagnostic logging for rendering facts.

**Acceptance criteria:**

- Normal run inspector no longer shows `Cost and time` as a token count.
- Scratch run inspector shows wall-clock time.
- Token facts are ordered consistently across `/runs/{runId}` and `/scratch-runs/{runId}`.
- RU UI labels are localized instead of English placeholders.

## Phase 2 - Verification

### Task 4: Run focused verification

**Deliverable:** The plan exits with focused tests and type safety checks green, or records any pre-existing blocker with exact output.

**Files:**

- `web/lib/runs/__tests__/cost-summary-facts.test.ts`
- Any existing tests touched by implementation, especially run layout or run inspector tests if assertions change.

**Implementation notes:**

- Run the new focused unit test:
  `pnpm --filter maister-web exec vitest run --project unit web/lib/runs/__tests__/cost-summary-facts.test.ts`
- Run typecheck:
  `pnpm --filter maister-web typecheck`
- If the implementation touches docs with Mermaid, run:
  `pnpm validate:docs`
- If layout changes are visually risky, inspect the run inspector in browser for one normal run and one scratch run; no local dev server is required unless doing this visual check.

**Logging requirements:** no app logging changes. Verification output should be captured in the final implementation summary, not committed into source files.

**Acceptance criteria:**

- Focused unit test is green and listed by the unit project.
- Typecheck is green.
- Documentation wording matches the implemented facts.
- No unrelated files are changed.

## Out Of Scope

- Money pricing or dollar cost estimates. This plan only clarifies token usage and time.
- New DB columns, cost rollup semantics, or model pricing tables.
- Live ticking timers in the inspector. Wall-clock is computed at render time like the current run detail page.
- Redesigning the inspector component tabs or converting facts into a new card layout.
