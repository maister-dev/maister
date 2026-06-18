# Implementation Plan: Inbox Card Redesign

Branch: claude/agitated-murdock-50f2b0 (worktree `agitated-murdock-50f2b0`; plan in place, no new branch)
Created: 2026-06-18

Self-contained: this plan absorbs the design (surface + decisions). There is no separate spec file — the `docs/plans/2026-06-18-inbox-card-redesign-*.md` drafts were consolidated here and dropped.

## Settings
- Testing: yes — unit (`renderToStaticMarkup`, `.test.ts`) + route test + Playwright e2e. Each behavioral task names its runner project and is glob-confirmed (Rule: test-runnability).
- Logging: standard — web `no-console`; use the existing logger boundary. WARN (server) on `inbox-context` read failures and on an unresolved stage `step_id`; reducible via `LOG_LEVEL`/`DEBUG` without code edits. UI components log nothing (client).
- Docs: yes — mandatory docs checkpoint. Phase 0 front-loads the analytics/contract specs; Phase 5 reconciles as-built status tags.

## Roadmap Linkage
Milestone: "none"
Rationale: UX refinement of the shipped M17 HITL hybrid surface and M31 inbox; not a new roadmap milestone.

## Scope & non-goals
- Scope: web tier only (`web/`). No supervisor change, no DB migration, no new env var, no new `MaisterError` code, no new `runs.status`/enum, no Flow DSL change, **no new ADR** (governed by [ADR-057](../../docs/decisions.md#adr-057) HITL hybrid surface + [ADR-083](../../docs/decisions.md#adr-083) social board / inbox).
- Re-presents existing HITL data + actions; respond semantics, the typed-error taxonomy, the two-phase respond commit, and the supervisor/resume path are unchanged.
- The "Mentions & comments" `InboxPanel` on `/inbox` is NOT restyled.

## Design — the surface (the contract)
Three disclosure tiers: collapsed (scan) → expanded (decide) → run page (deep dive). One unified card used by both `/inbox` (cross-project) and the per-project board.

- **`/inbox` page:** full-bleed (drop `mx-auto max-w-[860px]`); HITL cards grouped by project (header `project · N waiting`); responsive grid → 2 columns on wide, 1 otherwise. Mentions panel unchanged below.
- **Board:** the unified card replaces the `<HitlInbox>` section; single project → no project-group header; assignment actions kept.
- **Collapsed tier:** agent avatar · task title · `KEY-N` · criticality pill · **stage chip** (node label + type icon) · **branch chip** (the workspace) · time · the prompt (1–2 lines) · for a binary permission ask the `Allow`/`Deny` buttons (act without expanding) · `View run`. Form/human asks show a Respond affordance + `View run`.
- **Expanded tier (lazy):** Gates & evidence (per-gate chips, blocking-first, capped ~5 with "+k more") + a **separate neutral stale chip** (`N stale`) · Task framing (task prompt snippet + relation chips + attempt N) · Last agent message · optional Changes line (`N files · +X −Y`) · the respond controls (reuse `components/board/hitl-decision-controls.tsx`) · `View run`. The stage chip shows the `progress` fraction here (from `inbox-context`, board parity).
- **Run tier:** everything else via `View run`.
- **Visual:** per-card criticality accent (critical red / high amber / medium info / low neutral). The block-level amber "alarm" chrome is removed.

### Resolved decisions (2026-06-18)
- **No ADR** — operate within ADR-057 / ADR-083.
- **Stage progress** — show `done/total` (the board already shows it) in the **expanded** tier (lazy, from `inbox-context`).
- **Diff** — one summary line `N files · +X −Y`, expanded-only.
- **Stale** — a separate neutral chip, never by recoloring a gate chip.
- **Quick act** — binary permission answerable from the collapsed card; form/human require expand.
- **Card doc** — described inside `docs/screens/inbox.md`; no separate block doc.

## Data sources (eager vs lazy)
- **Eager (list query — cheap):** add `tasks.title`; add `stage {label, type}` where **`label` = `hitl_requests.step_id`** (free; matches the board's `current?.stepId` label) and **`type`** = node kind resolved from the run's compiled graph, **batched by distinct flow revision** — load each manifest ONCE via `resolveManifest` + `compileManifest` (`web/lib/flows/graph/current-node-kind.ts`), then map `step_id → nodeType`. Do NOT call the per-run `resolveCurrentNodeKind` per item (it re-loads the manifest = N+1). Legacy linear runs → `{ label: step_id, type: "cli" }`. **`progress` is NOT eager** — it moves to the lazy payload.
- **Lazy (`GET /api/runs/[runId]/inbox-context`, on expand):** `{ lastAgentMessage, gates[], diff, progress }`, all via existing helpers:
  - `gates` + `progress` ← `getRunNodeStatuses(runId)` (`web/lib/queries/run-node-status.ts`) — current node's gates + `gateSummary`; `progress` = done/total over its node map (graph). Legacy → board `buildSpine` over `step_runs` (`web/lib/queries/board.ts`).
  - `lastAgentMessage` ← trailing coalesced `agent_message_chunk` from `run.events.jsonl`, reusing the `interpretScratchUpdate` logic (`web/lib/scratch-runs/transcript.ts`).
  - `diff` ← `prepareDiffSummary(rawDiff)` (`web/lib/diff/prepare.ts`) over the run's raw git diff (reuse the diff route's git invocation).

## Contract surfaces → spec files (Rule: trace every contract surface)
| Surface (changed/added) | Spec file(s) to update | Phase |
|---|---|---|
| NEW `GET /api/runs/{runId}/inbox-context` (path, 200 shape, 401/403/404) | `docs/api/web.openapi.yaml` + `docs/system-analytics/hitl.md` | 0 |
| `HitlItem` projection gains `taskTitle` + `stage {label,type}` (progress is lazy) | `docs/screens/inbox.md` (Data & APIs) + `docs/system-analytics/hitl.md` | 0 |
| `/inbox` surface: full-bleed, project grouping, 3-tier card, View-run | `docs/screens/inbox.md` (Layout & regions / States) | 0 |
| Board HITL block replaced by the unified card (behavior unchanged) | `docs/system-analytics/hitl.md` | 0 |

Explicitly empty sets (so `/aif-verify` cross-checks them as empty): no new env var · no migration · no new `MaisterError` code · no new `runs.status`/enum · no Flow DSL step/field · no new `package.json` script · no new ADR.

## Deployment touchpoints (Rule: enumerate deployment wiring)
None. No new dep, env var, config file, sidecar, or bound port. (Called out explicitly so `/aif-verify` confirms the empty set.)

## HTTP route identifiers (Rule: label each identifier; derive cross-resource ids from server state)
- `GET /api/runs/[runId]/inbox-context` (read-only): `runId` = **url-param** (trusted iff access-controlled → authz on the derived project); `projectId` = **server-state** (SELECT from the run row); **no body**. No `body-controlled` cross-resource id. Two-phase commit N/A (no side-effects). Authz `requireProjectAction(projectId, "readBoard")`; foreign/non-member → 403; missing run → 404.

## Consumer fan-out (Rule: fan a new value out to ALL consumers)
- **Both HITL read models** gain `taskTitle` + `stage`: `getHitlInbox` (board, `web/lib/queries/hitl.ts`) AND `getCrossProjectHitlInbox` (portfolio/inbox, `web/lib/queries/portfolio.ts`); shared `HitlRowBase` + `mapRowsToHitlItems` updated once, both selects add the same columns.
- **UI consumers** repointed: `web/app/(app)/inbox/page.tsx` and `web/app/(app)/projects/[slug]/page.tsx`.
- **Retired** (folded in): `components/portfolio/hitl-inbox-block.tsx`, `components/portfolio/inbox-respond.tsx`, `components/board/hitl-inbox.tsx`.
- **No** scheduler / concurrency-cap / recovery-sweep / state-guard impact (no status or enum added).

## Commit Plan
- **Commit 1** (Phase 0): `docs(screens,hitl,api): inbox card redesign contracts`
- **Commit 2** (Phase 1): `feat(inbox): list-query stage chip + inbox-context endpoint`
- **Commit 3** (Phase 2): `feat(inbox): unified 3-tier HITL card + project-grouped list`
- **Commit 4** (Phase 3-4): `test+i18n(inbox): EN/RU keys + unit/route/e2e, migrate invalidated tests`
- **Commit 5** (Phase 5): `docs(screens,hitl): mark inbox card redesign implemented`

No `Co-Authored-By` trailer (repo convention).

## Tasks

### Phase 0 — Docs & contract first (source of truth)
- [x] T0.1: Rewrite `docs/screens/inbox.md` — Layout & regions (full-bleed; Section 1 = project-grouped HITL cards, 2-col-on-wide grid; Section 2 = unchanged Mentions), States (collapsed/expanded/run tiers), Data & APIs (extended projection + `inbox-context` route). Card described inside this doc. Tag new pieces `(Designed)`. Logging: n/a. Files: `docs/screens/inbox.md`. Exit: `pnpm validate:docs` green.
- [x] T0.2: Update `docs/system-analytics/hitl.md` — Process flows (batched stage-resolution read; lazy `inbox-context` read = events.jsonl tail + `gate_results` + diff summary); Expectations (stage from `hitl_requests.step_id`; `inbox-context` read-only + project-scoped). Tag `(Designed)`. Files: `docs/system-analytics/hitl.md`.
- [x] T0.3: Add `GET /api/runs/{runId}/inbox-context` → 200 `InboxCardContext` ({lastAgentMessage, gates[], diff}) + 401/403/404 to `docs/api/web.openapi.yaml`. Exit: `npx @redocly/cli lint` zero errors.
<!-- Commit checkpoint: Phase 0 -->

### Phase 1 — Data layer
- [ ] T1.1: Extend the HITL list projection in BOTH read models — add `tasks.title`; add `stage {label, type}` (NO progress — progress is lazy, T1.2) via a new batched resolver `web/lib/queries/hitl-stage.ts`. `label` = `hitl_requests.step_id` (free). `type` = node kind: collect distinct `(flowRevisionId ?? flowId)`, call `resolveManifest` + `compileManifest` ONCE per distinct manifest (reuse the `current-node-kind.ts` building blocks — do NOT call the per-run `resolveCurrentNodeKind` per item), then map each `step_id → nodeType`. Legacy linear runs → `{ label: step_id, type: "cli" }`. Update `HitlItem`, `HitlRowBase`, `mapRowsToHitlItems`, the `getHitlInbox` select (add `tasks.title`), and `getCrossProjectHitlInbox` + `CrossProjectHitlItem` (add `tasks.title` to the select ~`portfolio.ts:1086`). Logging: WARN on an unresolved `step_id` → raw-label + null-type fallback (never throw — the inbox must render). Files: `web/lib/queries/hitl.ts`, `web/lib/queries/portfolio.ts`, `web/lib/queries/hitl-stage.ts`. Tests: a UNIT test for `hitl-stage` (graph hit, legacy fallback, unresolved id, single-compile across ≥2 revisions); extend the INTEGRATION test `lib/queries/__tests__/portfolio-inbox.integration.test.ts` for the new fields.
- [ ] T1.2: New `GET /api/runs/[runId]/inbox-context` route + read service `web/lib/queries/inbox-context.ts`. Returns `{ lastAgentMessage:{text,at}|null, gates[], diff:{files,additions,deletions}|null, progress:{done,total}|null }`, reusing existing helpers:
  - `gates` + `progress` ← `getRunNodeStatuses(runId)` (`web/lib/queries/run-node-status.ts`): current node's gates + `gateSummary`; `progress` = done/total over the node map (graph). Legacy run → board `buildSpine` over `step_runs`.
  - `lastAgentMessage` ← trailing coalesced `agent_message_chunk` from `.maister/<slug>/runs/<runId>/run.events.jsonl`, reusing the `interpretScratchUpdate` logic (`web/lib/scratch-runs/transcript.ts`).
  - `diff` ← `prepareDiffSummary(rawDiff)` (`web/lib/diff/prepare.ts`) over the run's raw git diff (reuse the diff route's git invocation).
  Authz `requireProjectAction(projectId,"readBoard")` (project from the run row; `runId` url-param, no body). Logging: WARN on a missing/malformed events file or diff failure → return the partial object with that field `null` (never 500). Files: `web/app/api/runs/[runId]/inbox-context/route.ts`, `web/lib/queries/inbox-context.ts`. Tests (INTEGRATION, real PG, `*.integration.test.ts`): authz 403 on a foreign run; shape; events-tail picks the latest `agent_message_chunk`; gates + progress mapped; missing events file → `lastAgentMessage:null` (not 500). (depends on T1.1)
<!-- Commit checkpoint: Phase 1 -->

### Phase 2 — Unified card + grouped list
- [ ] T2.1: `components/inbox/hitl-card.tsx` (`"use client"`) — 3-tier disclosure; collapsed = summary + stage chip (label + type icon) + (permission) Allow/Deny + View-run; expanded lazily fetches `inbox-context` (`role=status` loading, `role=alert`+retry error) → gate chips (blocking-first, "+k more") + separate neutral stale chip + task framing + last agent message + **progress** (expanded stage detail) + optional Changes line + respond controls (reuse `components/board/hitl-decision-controls.tsx` via `run-hitl-response.tsx` / `hitl-actions.tsx`) + View-run; optional assignment-actions slot (reuse `components/board/assignment-actions.tsx`); per-card criticality accent; header `<button aria-expanded>` (quick-act/links/form stop the toggle). Logging: none (client). Files: `components/inbox/hitl-card.tsx`. Tests (renderToStaticMarkup): collapsed+expanded per kind; criticality variants; stage chip per node type + legacy fallback; gates "+k more"; partial `inbox-context` (null message/diff/progress); Allow/Deny on collapsed only for permission. (depends on T1.x)
- [ ] T2.2: `components/inbox/hitl-inbox-list.tsx` — group by project (`project · N waiting`), responsive grid 2-col-on-wide, preserve criticality-then-age within a project. Files: `components/inbox/hitl-inbox-list.tsx`. Tests: grouping; 2-col wrapper; empty group omitted.
- [ ] T2.3: Wire `/inbox` — drop `mx-auto max-w-[860px]` → full-bleed; render the grouped list for the HITL section; leave `InboxPanel` unchanged. Files: `web/app/(app)/inbox/page.tsx`. (depends on T2.1, T2.2)
- [ ] T2.4: Board — replace the `<HitlInbox>` section (`web/app/(app)/projects/[slug]/page.tsx:224`) with the unified card list (single project → no group header); keep `canAct`/`currentUserId` + assignment actions. Files: `web/app/(app)/projects/[slug]/page.tsx`. (depends on T2.1)
- [ ] T2.5: Retire `components/portfolio/hitl-inbox-block.tsx`, `components/portfolio/inbox-respond.tsx`, `components/board/hitl-inbox.tsx`; grep + repoint all import sites (board + `/inbox` only). The vitest unit project ALREADY globs `components/**/__tests__/**/*.test.ts` (`web/vitest.workspace.ts`) → no config change; card tests land at `components/inbox/__tests__/`. NOTE: `components/board/hitl-decision-controls.tsx` + `run-hitl-response.tsx` + `hitl-actions.tsx` are REUSED, not retired (their tests stay). (depends on T2.3, T2.4)
<!-- Commit checkpoint: Phase 2 -->

### Phase 3 — i18n (EN + RU)
- [ ] T3.1 / T3.2: Add keys to BOTH `web/messages/en.json` and `web/messages/ru.json` (parity): `stage.ai_coding|judge|cli|check|human`; `gate.passed|pending|running|failed|stale|skipped|overridden`; `gatesEvidence|taskContext|lastAgentMessage|changes`; `expand|collapse|viewRun|respond|attempt|staleEvidence|moreGates|changesSummary|waiting|contextError|retry`. Reuse existing `run.*` decision labels. Remove only keys no longer referenced by any retired component.
- [ ] T3.3: Add a FULL-CATALOG EN/RU key-parity unit test (none exists today) — assert `web/messages/en.json` and `web/messages/ru.json` have identical key sets. If pre-existing drift surfaces, fix it OR `.skip` the offending keys with a reason + tracked follow-up (never silently tolerate). Files: `web/lib/__tests__/i18n-parity.test.ts`. Exit: the parity test is green.

### Phase 4 — Tests: e2e + suite-green + assertion migration
- [ ] T4.1: e2e — REWRITE the existing `web/e2e/inbox.spec.ts` (it asserts the OLD inbox and will break; `AUTHED_SPEC` in `playwright.config.ts` already matches `inbox` → NO config edit): seed a `NeedsInput` run → open `/inbox` → expand a card → `inbox-context` loads → respond (binary from collapsed; form/human from expanded) → item clears; View-run navigates; board parity smoke. Free `:3000` first (Next 16 single-dev-server lock). Files: `web/e2e/inbox.spec.ts` (rewrite in place).
- [ ] T4.2: Migrate invalidated tests (named): `components/portfolio/__tests__/hitl-inbox-block.test.ts` → rewrite as `components/inbox/__tests__/hitl-card.test.ts` (UNIT); extend `lib/queries/__tests__/portfolio-inbox.integration.test.ts` (INTEGRATION) for `taskTitle`+`stage`; confirm `lib/queries/__tests__/needs-you.test.ts` count semantics unchanged; the existing `web/e2e/inbox.spec.ts` is rewritten in T4.1. Exit (test-integrity gate): `pnpm typecheck` + `pnpm test:unit` + touched `test:integration` + the rewritten e2e all green; any pre-existing/harness-limited red gets an explicit `.skip` + reason.
<!-- Commit checkpoint: Phase 3-4 -->

### Phase 5 — Docs reconcile
- [ ] T5.1: Flip `(Designed)` → `(Implemented)` in `docs/screens/inbox.md` + `docs/system-analytics/hitl.md`; final `pnpm validate:docs` + redocly + i18n parity.
<!-- Commit checkpoint: Phase 5 -->

## Test integrity (Rule)
- Runnability: unit `.test.ts` under `components/inbox/__tests__/` + the `hitl-stage` unit test run on the vitest UNIT project (`components/**/__tests__/**`, `lib/**/__tests__/**` already globbed — confirmed). The `inbox-context` route test + the extended `portfolio-inbox` test are INTEGRATION (`*.integration.test.ts`). The e2e is `web/e2e/inbox.spec.ts` (already matched by `AUTHED_SPEC`).
- Per-phase green: each phase exits only on a green suite for what it touched.
- Assertion migration is in-scope (T4.2; files named) — not a follow-up.

## Risks & mitigations
- Stage `type` N+1 compile → one `compileManifest` per distinct flow revision (T1.1); never call the per-run `resolveCurrentNodeKind` per item; legacy never compiles.
- `progress` source differs by run kind → graph: `getRunNodeStatuses`/`node_attempts`; legacy: board `buildSpine` over `step_runs` (verify `step_runs` population for graph runs during impl); lazy/expanded only.
- events.jsonl tail cost → lazy, per-run, on expand; partial-null on read failure (never 500).
- e2e Next single-dev lock → free `:3000` before e2e.
- Retiring shared components → grep all import sites before delete (T2.5); the board respond controls (`hitl-decision-controls`/`run-hitl-response`/`hitl-actions`) are REUSED, not retired.
