# Implementation Plan: Web shell hardening & nav unlock

Branch: claude/elegant-panini-e53b2f (existing worktree — no new branch created)
Created: 2026-06-13
Design spec: `docs/plans/2026-06-13-web-shell-and-nav-unlock-design.md`

## Settings
- Testing: yes (unit for evaluators/helpers; seeded e2e for nav/inbox/mcps/shortcut)
- Logging: standard (INFO at server-side boundaries via the logger boundary; no `console.log` in client code per frontend rule)
- Docs: yes (mandatory docs checkpoint — WI-6 + system-analytics updates are in scope)

## Roadmap Linkage (optional)
Milestone: "none"
Rationale: Skipped by user — UI-shell polish + nav unlock, not a standalone milestone; the Flows/package item is deferred until M34.

## Scope & out of scope
Six work items, **`web/` only** — no `supervisor/` changes, no DB migration (MCP readiness reuses existing columns).
- **Out of scope:** Flows / Flow Studio / package IA (original item 1) — deferred until M34 (agents-in-packages) merges; the `Agents` nav item stays `ready:false` (M34 territory). Project-scoped MCP UX (board `?tab=mcps`) unchanged.

## Decisions & constraints (carry into implementation)
- **No deployment touchpoints.** No new env var / config file / bound port / sidecar binary is introduced → no Deployment-wiring task required (skill-context rule satisfied by absence). State this in the final task.
- **No new HTTP routes.** `/inbox` and `/mcps` are RSC pages reusing existing queries/routes (`getCrossProjectHitlInbox`, `getInboxItems` + `/api/inbox/*`, `/api/admin/mcp-servers[/:id]`). No new body-controlled identifiers; the HITL respond path reuses the existing two-phase `respondToHitl`.
- **`needsYou` is one canonical number fanned to EVERY read model** (skill-context "fan to all consumers" rule): rail Inbox badge (`layout.tsx`), portfolio `totalNeeds` (`portfolio.ts:589`), board header (`projects/[slug]/page.tsx:198` — already correct). `needsYou = pendingHitlCount + unreadInboxCount`, where **`pendingHitlCount` = `getCrossProjectHitlInbox(userId, role).count`** (the respondable set `/inbox` renders), NOT the broader portfolio-scope count (`portfolio.ts:1079-1083` notes the two differ; `totalNeeds` narrows to the respondable count, shrinking the home headline accordingly). All four surfaces (rail, portfolio, board, `/inbox`) MUST read this one count or the "three badges agree" acceptance fails.
- **The rail badge changes its data SOURCE, not just its consumer.** `layout.tsx:55-62` derives the badge today from `railWorkspaceGroups` filtered by `statusTone === "needs"|"waiting"` — neither the HITL count nor unread-inbox. Task 6 adds `getUnreadInboxCount(userId)` + the canonical HITL count to `layout.tsx`'s `Promise.all` and replaces the workspace-tone derivation (layout ships zero inbox/HITL queries today).
- **`/inbox` REUSES `HitlInboxBlock` + `InboxPanel`; only the home summary card is new.** Both blocks have no importer except home `/` + their own unit tests (`hitl-inbox-block.test.ts` 8 cases, `inbox-panel.test.ts` 2 cases); rebuilding `/inbox` from fresh sections would orphan both components and their tests. Reuse keeps them green and satisfies the orphan rule.
- **`PlatformStatusDot` component STAYS.** Remove only the `top-nav.tsx:39` usage + its `:9` import; the component is still used by `components/auth/side-panel.tsx:24` (login). Do not delete `platform-status.tsx`. Removing the rail supervisor pill also orphans the `PlatformStatusPill` import in `left-rail.tsx` — drop that import.
- **MCP readiness reads supervisor `/diagnostics`** (an external read, not a side-effect): graceful `Unknown` + reason when unavailable; mirrors `lib/acp-runners/readiness.ts`. Recompute on the two write routes only.
- **Contract surface:** `docs/api/web.openapi.yaml` ALREADY documents `readinessStatus`/`readinessReasons` on `PlatformMcpServer` (~lines 10311-10316) — Task 8 confirms only, no edit expected.
- **Test integrity (skill-context rule):** every promised test names its runner (unit → web unit project `lib/**/*.test.ts`; e2e → playwright authed project). New e2e specs MUST join the playwright `AUTHED_SPEC` regex. Each phase exits only on a GREEN suite (`pnpm test:unit && pnpm test:integration` + touched e2e). Assertion migration is in-phase.
- **Analytics front-loaded (skill-context rule):** Phase 0 writes the behavior contracts (system-analytics) + the screens-doc scaffold/template BEFORE any code; per-screen layout sections are filled as each screen WI lands.
- **Lint:** scoped `eslint` on touched files only — never bare `pnpm lint` (it is `eslint --fix` with no path and reformats ~60 files). `web/` strict TS, HeroUI v3 + Tailwind 4, `@/*` imports, `kebab-case.tsx`, EN+RU i18n required.
- **Worktree:** all edits inside the worktree checkout; never `cd` into the main `/web` checkout.

## Commit Plan
- **Commit 1** (Phase 0, tasks 1-2): `docs(screens,analytics): scaffold screens reference + front-load shell/inbox/mcp contracts`
- **Commit 2** (Phase 1, tasks 3-4): `feat(web): runners-readiness rail block from live diagnostics; de-dup supervisor status`
- **Commit 3** (Phase 2, tasks 5-7): `feat(web): unified /inbox + canonical needs-you across read models`
- **Commit 4** (Phase 3, tasks 8-9): `feat(web): admin /mcps page + computed MCP readiness`
- **Commit 5** (Phase 4, tasks 10-11): `feat(web): launch dialog restyle + Cmd/Ctrl+K shortcut`
- **Commit 6** (Phase 5, task 12): `chore(web): final gates + refresh M9-deferral notes`

## Tasks

### Phase 0 — Analytics & docs front-load
- [x] Task 1: Scaffold `docs/screens/` (README index + nav/IA Mermaid map + per-doc template + classification rule); register in `docs/CLAUDE.md` glossary + "Adding a new artifact"; cross-link `web/CLAUDE.md` route map. Run `pnpm validate:docs`.
- [x] Task 2: Front-load target-behavior contracts in `docs/system-analytics/{mcp-management,social-board,hitl}.md` — MCP readiness computed on write; unified `/inbox`; canonical `needsYou` formula. (parallel with Task 1)
<!-- Commit checkpoint: tasks 1-2 -->

### Phase 1 — Runners readiness + supervisor de-dup (WI-3)
- [x] Task 3: Shared adapter-readiness summary helper (`lib/acp-runners/readiness-summary.ts`) from `/diagnostics` × `platform_acp_runners`; add diagnostics+runners fetch to `app/(app)/layout.tsx`; unit-tested. (depends on 1, 2)
- [x] Task 4: Rewrite rail block → "Runners readiness" (green/amber/hidden + tooltips; drop supervisor pill + cursor/aider); remove top-nav `PlatformStatusDot` usage + import (`top-nav.tsx:9,39`) but KEEP the component (login side-panel uses it); drop the now-unused `PlatformStatusPill` import in `left-rail.tsx`; EN+RU; fill `docs/screens/chrome/{left-rail,status-bar,top-nav}.md`. (depends on 3)
<!-- Commit checkpoint: tasks 3-4 -->

### Phase 2 — Unified Inbox (WI-1) + badge fan-out
- [ ] Task 5: `/inbox` page REUSING `HitlInboxBlock` + `InboxPanel` (don't rebuild — see decision) for HITL respond + unread mentions/comments; enable nav `ready:true`; EN+RU. (depends on 4)
- [ ] Task 6: Canonical `needsYou` = `getCrossProjectHitlInbox(...).count` + `getUnreadInboxCount`. ADD both to `layout.tsx`'s `Promise.all` and REPLACE the `statusTone` badge derivation (`layout.tsx:55-62`); align `totalNeeds` (`portfolio.ts:589`) to the same count; board `:198` already matches. Home `/` → compact "Needs you" summary card (the only new component) replacing the two blocks (now hosted on `/inbox`); update `e2e/portfolio-board.spec.ts` home assertions. (depends on 5)
- [ ] Task 7: Unit (needsYou helper) + seeded e2e (nav→/inbox, HITL respond, badge parity = rail == board == portfolio show the SAME count; new spec must match the playwright `AUTHED_SPEC` regex); add EN+RU keys together (`i18n-parity.test.ts` enforces parity; messages are NOT typechecked, so a missing key fails only at test time); write `docs/screens/inbox.md`. Phase GREEN gate. (depends on 6)
<!-- Commit checkpoint: tasks 5-7 -->

### Phase 3 — MCP page (WI-2) + readiness evaluator
- [ ] Task 8: `lib/mcp/readiness.ts evaluateMcpReadiness(row, diagnostics)` (mirror `evaluateRunnerReadiness`; check `env_keys`/`header_keys` against diagnostics `envRefs`); wire into POST + PATCH `/api/admin/mcp-servers[/:id]` (DELETE excluded — row gone); OpenAPI already documents the fields (confirm-only); unit-tested. (depends on 7)
- [ ] Task 9: Admin `/mcps` page (reuse `McpServersPanel` + `McpServerModal` + readiness column); move `mcps` nav into admin block `ready:true`; EN+RU; seeded e2e; write `docs/screens/mcps.md`. (depends on 8)
<!-- Commit checkpoint: tasks 8-9 -->

### Phase 4 — Launch UX (WI-4 + WI-5)
- [ ] Task 10: Restyle `scratch-launcher.tsx` (field → `bg-paper-warm`, drop `shadow-inner`; controls subtly raised); verify light+dark. (depends on 9)
- [ ] Task 11: Cmd/Ctrl+K global hook (preventDefault, open portfolio launcher, skip while typing/modal-open) + update `<kbd>` label; seeded e2e; write `docs/screens/chrome/launch-dialog.md`. (depends on 10)
<!-- Commit checkpoint: tasks 10-11 -->

### Phase 5 — Verify & finalize
- [ ] Task 12: Final gates (`pnpm typecheck`, scoped eslint, `pnpm test:unit && pnpm test:integration`, e2e, `pnpm validate:docs`); update `web/CLAUDE.md` M9-deferral + nav notes; confirm no deployment touchpoints. (depends on 11)
<!-- Commit checkpoint: task 12 -->

## Per-WI acceptance
See the design spec's per-WI **Acceptance** sections (`docs/plans/2026-06-13-web-shell-and-nav-unlock-design.md`). Each screen WI also updates its `docs/screens/*` file before its phase closes.
