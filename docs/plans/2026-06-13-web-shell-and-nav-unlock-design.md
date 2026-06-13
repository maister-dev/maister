# Web shell hardening & nav unlock — design

- **Date:** 2026-06-13
- **Status:** Draft (input for `/aif-plan`)
- **Tier:** `web/` only. No `supervisor/` changes. No DB migration (MCP
  readiness reuses existing columns).
- **Branch:** `claude/elegant-panini-e53b2f` (off `main` `0282235f`, M33 in,
  M34 not).

## Summary

Surface already-built backend behind the two dead nav items (**Inbox**,
**MCPs**), and polish the application shell. Most of this is **wiring +
consolidation, not greenfield**: the cross-project HITL inbox, the social
inbox, and the full MCP catalog CRUD already exist — they are just not reachable
from the nav or are duplicated across surfaces. Plus: a real launch shortcut,
a runner-readiness rail block built from live diagnostics, a launch-dialog
restyle, and a new `docs/screens/` documentation discipline.

## Out of scope (explicit)

- **Flows / Flow Studio / package IA (original item 1).** Deferred until
  **M34** (agents-inside-flow-packages) merges to `main` — M34 reworks the
  package model and adds the `Agents` nav, so touching Flows/package IA now
  would collide. The `/flows` page already works ("Platform package
  workbench"); leave it untouched this round. → follow-up below.
- **`Agents` nav item.** M34 territory. Stays `ready: false`.
- **Project-scoped MCP UX.** Already on the board `?tab=mcps`; unchanged.
- **`supervisor/` daemon, DB migrations, new domain tables.** None needed.

## Verified current state (the premises that changed)

| Area | Reality (file:line) |
| --- | --- |
| Inbox nav | `ready: false`, no `/inbox` page. Badge counts HITL-waiting rail workspaces (`app/(app)/layout.tsx:55`), not the social inbox. |
| Cross-project HITL | **Already exists** on home `/` with inline respond — `getCrossProjectHitlInbox` (`lib/queries/portfolio.ts`), `HitlInboxBlock` + `InboxRespond` (`app/(app)/page.tsx:84`). |
| Social inbox | **Already exists** on home `/` — `getInboxItems`/`getUnreadInboxCount` (`lib/queries/inbox.ts`), `InboxPanel` (`app/(app)/page.tsx:109`). Carries `comment_added` + `task_mentioned` only. |
| Badge formula | Inconsistent. Board "Need you" = HITL + unread (`projects/[slug]/page.tsx:198`); home `totalNeeds` = HITL only (`portfolio.ts:589`); rail badge = needs/waiting workspaces. Docs require HITL + unread in both scopes (`social-board.md`). |
| MCP mgmt | **Fully built** (M27/ADR-070). Platform CRUD `McpServersPanel`+`McpServerModal` on `/settings`; routes `/api/admin/mcp-servers[/:id]`. `/mcps` nav dead. `readiness_status` column exists but is **never computed** (always `Unknown`) — no MCP evaluator, unlike runners. |
| Readiness rail block | `Platform readiness` (`left-rail.tsx:425-449`) shows the supervisor pill (also in footer `status-bar.tsx` + top-nav dot) and **hardcoded fake `cursor`/`aider` chips** (`left-rail.tsx:438-447`) — not real adapters. |
| Adapter data | Real adapters: `claude, codex, gemini, opencode, mimo` (`lib/acp-runners/adapter-support.ts`). Availability + smoke from supervisor `/diagnostics` (`checkSupervisorDiagnostics`); configured runners + `readinessStatus`/`readinessReasons` in `platform_acp_runners`. The tool×runner matrix is already rendered in `/settings` (`adapter-support-panel.tsx`). |
| Launch shortcut | **No handler exists.** `<kbd>Cmd L</kbd>` (`left-rail.tsx:455`) is decorative. |
| Launch dialog | Field card bg = `color-mix(in oklab, var(--paper) 86%, var(--ink) 8%)` + `shadow-inner` (`scratch-launcher.tsx:585`) ≈ gray over the `--paper-warm` `#0c120d` backdrop; controls use near-invisible `border-line-soft`, no shadow, no hover (`iconButton` const `scratch-launcher.tsx:105`, runner/mode/priority labels `:722-824`). |
| Screen docs | None exist. New category. `docs/` R1 forbids screenshots (Markdown + Mermaid + YAML); R8 English-only; registry = glossary in `docs/CLAUDE.md`. |

---

## WI-1 — Unified Inbox (`/inbox`)

**Goal.** One cross-project working surface for everything waiting on the user;
enable the nav item; collapse the two home blocks into a summary; make the
"Needs you" number consistent.

**Target.**
- New page `app/(app)/inbox/page.tsx` (RSC, session-required) with two
  sections:
  - **Needs your action** — pending HITL across visible projects, with inline
    respond. Reuse `getCrossProjectHitlInbox(userId, role)` + `InboxRespond`.
  - **Mentions & comments** — unread social inbox. Reuse `getInboxItems` +
    the mark-read routes (`PATCH /api/inbox/[itemId]/read`,
    `POST /api/inbox/read-all`).
- Flip `inbox` nav to `ready: true` (`left-rail.tsx:154`).
- **Home `/`**: replace the full `HitlInboxBlock` + `InboxPanel` with one
  compact **"Needs you (N)"** summary card — count + top 3 items + "See all →
  `/inbox`". (Keep the inline-respond affordance on `/inbox`, not home.)
- **Badge fix.** Define one canonical number `needsYou = pendingHitlCount +
  unreadInboxCount` and use it in all three sites: rail Inbox badge
  (`layout.tsx:55`/`left-rail.tsx:194`), home `totalNeeds` (`portfolio.ts:589`),
  board header (already correct). RBAC scoping preserved (admin = all, member =
  own).

**Reuse:** `getCrossProjectHitlInbox`, `getInboxItems`, `getUnreadInboxCount`,
`InboxRespond`, existing respond/mark-read routes. **New:** the page, a small
combined loader, the home summary card, the shared `needsYou` helper.

**Acceptance.** Nav enabled → `/inbox` lists respondable HITL + unread
mentions; home shows the compact summary; the three badges agree; respond
round-trip works from `/inbox`; EN+RU strings; viewer/member/admin scoping holds.

---

## WI-2 — MCP management page (`/mcps`) + readiness fix

**Goal.** Make the existing platform MCP catalog reachable; stop reporting
every server as `Unknown`.

**Target.**
- New page `app/(app)/mcps/page.tsx`, **admin-only**. Render the existing
  `McpServersPanel` (view-only table) + `McpServerModal` (create/edit/delete)
  with data from `platformMcpServers`. Follows the data-management page
  pattern (full-width, view-only table, edits in modal — `web/CLAUDE.md`).
- Move the `mcps` nav item into the **admin push** block (alongside
  Users/Scheduler), `ready: true`, `href: "/mcps"`. Route still enforces
  `requireGlobalRole("admin")`. (Project members keep managing project MCPs on
  the board tab — platform MCPs are admin scope.)
- **Readiness evaluator** `lib/mcp/readiness.ts` `evaluateMcpReadiness(row,
  diagnostics)`, mirroring `lib/acp-runners/readiness.ts`:
  - stdio: `command` present, else `NotReady` "missing command".
  - sse/http: `url` present, else `NotReady` "missing url".
  - each referenced `env_keys`/`header_keys` present in diagnostics `envRefs`,
    else `NotReady` "env ref missing: NAME".
  - all satisfied → `Ready`. Diagnostics unavailable → `Unknown` with reason.
  - Wire it into both write routes (`POST /api/admin/mcp-servers`,
    `PATCH /api/admin/mcp-servers/[id]`) — the only two write sites — so
    `readiness_status`/`readiness_reasons` are recomputed on every write,
    exactly as runners do.

**Reuse:** `McpServersPanel`, `McpServerModal`, both admin routes,
`platformMcpServers` schema, `checkSupervisorDiagnostics`. **No migration**
(columns exist).

**Acceptance.** Admins see `/mcps` in nav and can list/create/edit/delete
platform MCP servers; non-admins do not; `readiness_status` reflects real
config/env state on write and shows in the table; EN+RU.

---

## WI-3 — Runners readiness rail block + supervisor de-dup

**Goal.** Turn the fake "Platform readiness" block into a truthful
"Runners readiness" view; stop showing supervisor status three times.

**Target.**
- Rename block title → **"Runners readiness"** (new i18n key).
- **Remove** the supervisor pill from the rail block and the hardcoded
  `cursor`/`aider` chips (`left-rail.tsx:438-447`). Supervisor status lives in
  the **footer only** (`StatusBar`, always-visible) — also **remove the
  top-nav `PlatformStatusDot`** (`top-nav.tsx:39`, beside the breadcrumb), so
  the status is shown exactly once.
- Render real adapters from a new server loader combining `getPlatformStatus`
  (already fetched), `checkSupervisorDiagnostics`, and `platform_acp_runners`:
  - 🟢 **green** — adapter has ≥1 `enabled` runner with `readinessStatus =
    Ready`.
  - 🟡 **amber** — adapter binary `available` but no Ready runner (none
    configured, or all `NotReady`).
  - **hidden** — adapter binary not available.
  - tooltip surfaces the blocking reason (`readinessReasons` / smoke reason).
- Extract the matrix logic already in `adapter-support-panel.tsx` into a shared
  helper so the rail block and `/settings` agree.

**Data note.** `layout.tsx` currently fetches only `getPlatformStatus()`; add
the diagnostics + runners fetch to the same `Promise.all`. WI-1 and WI-3 both
edit `left-rail.tsx` + `layout.tsx` — sequence them together.

**Acceptance.** Block titled "Runners readiness"; only available adapters shown
with correct green/amber; cursor/aider gone; supervisor shown exactly once
(footer only; gone from rail + top-nav); tooltips explain amber; EN+RU.

---

## WI-4 — Launch dialog restyle

**Goal.** Field background matches the black dialog backdrop; control-bar
buttons read as subtly raised (per "чуть выделяющимся").

**Target (`scratch-launcher.tsx`, token-correct — no hardcoded hex):**
- Field card (`:585`): bg → `bg-paper-warm` (the `#0c120d` backdrop), drop
  `shadow-inner`. Textarea stays `bg-transparent`.
- Control-bar controls (`iconButton` `:105`, runner `:722`, mode `:750`,
  priority `:808`): `border-line` (not `border-line-soft`) + `bg-ivory` + top
  inset highlight `shadow-[0_1px_0_color-mix(in_oklab,var(--paper)_60%,transparent)_inset]`
  + a `hover:bg-*` step — mirroring the app's existing "raised" recipe
  (`scratch-launch-popover.tsx:51`, `settings/page.tsx:63`). Subtle, not heavy.
- Submit button unchanged. Verify light theme (tokens are theme-aware).

**Acceptance.** Field is visually flush with the backdrop; controls look
tappable/raised but understated; no layout regressions; holds in light + dark.

---

## WI-5 — Launch shortcut → Cmd/Ctrl+K

**Goal.** A working global launch shortcut that does not fight the browser.

**Target.**
- Global `keydown` listener (in `ScratchLaunchPopover` or a small
  `use-launch-hotkey` hook): `(metaKey || ctrlKey) && key === "k"` →
  `preventDefault()` + open the primary (portfolio) launch popover.
  `preventDefault` is required — FF binds Ctrl/Cmd+K to address-bar search; K
  is reliably overridable where L (address bar) often is not.
- Do **not** fire while focus is in an `input`/`textarea`/`contenteditable`
  (don't hijack typing), nor when a modal is already open. Respect the existing
  button availability (supervisor state).
- Update the `<kbd>` label (`left-rail.tsx:455`) to `⌘K` / `Ctrl K` (locale/OS
  aware). Esc-to-close already works.

**Acceptance.** Cmd/Ctrl+K opens the launch dialog in Chrome **and** Firefox
without focusing the address bar; never fires mid-typing; label correct.

---

## WI-6 — Screens documentation (`docs/screens/`)

**Goal.** Start a maintained, screenshot-free reference of the app's screens
and shared chrome; wire it into the docs registry; seed the screens this work
touches.

**Target.**

- **Directory layout** — start light, nest by IA area as it grows:

  ```
  docs/screens/
    README.md          # index + global nav/IA map + the template + classification rule
    chrome/            # cross-cutting shell present on every screen
      left-rail.md     # nav sections + runners-readiness + launch button + Needs-you badge
      status-bar.md    # footer supervisor status (single source)
      top-nav.md       # breadcrumb + locale/theme/user menu
      launch-dialog.md # scratch/launch popover + Cmd/Ctrl+K
    inbox.md           # /inbox
    mcps.md            # /mcps (admin)
  ```

  **Classification rule:** one file per **screen** (a route), per **block** (a
  self-contained panel reused across screens), or per **chrome** element
  (persistent shell). Group into an area subdirectory (`project/`, `admin/`,
  `flows/`, …) once that area reaches ≥3 files; until then keep flat + `chrome/`.

- **Per-doc template** (defined in `README.md`, every file follows it):
  1. **Header** — name · route(s) · status `(Implemented Mxx | Planned)` · source component.
  2. **JTBD** — the job(s) the screen is hired for ("When ⟨situation⟩ … I want … so I can …").
  3. **Roles & capabilities** — table: role (global `viewer/member/admin`; project `viewer/member/admin/owner`) × what they can see and do here; tie to `requireProjectAction` / `requireGlobalRole`.
  4. **Navigation** — entry points (how you arrive) + exits (where each action leads), as links to other `screens/*` docs; a small Mermaid `flowchart` for non-trivial flows.
  5. **Layout & regions** — prose walkthrough of regions/blocks/components, linking to their block docs.
  6. **States** — Mermaid `stateDiagram-v2` for meaningful states (empty / loading / error / role-gated / live) when present.
  7. **Data & APIs** — feeding routes/queries/SSE; link to `system-analytics/*` for behavior, don't restate (R7).
  8. **i18n** — `web/messages` namespace(s).
  9. **Linked artifacts** — ADRs (bare `#adr-NNN`), `system-analytics/*`, source paths.

- **Seed now:** `README.md` + `chrome/{left-rail,status-bar,top-nav,launch-dialog}.md`
  + `inbox.md` + `mcps.md` (exactly the screens this work touches).
- **Register:** glossary row/section in `docs/CLAUDE.md` + a clause under
  "Adding a new artifact"; cross-link the `web/CLAUDE.md` route map.
- **Constraints:** no screenshots (R1), English-only (R8), Mermaid for diagrams
  (avoid `;` inside `note` lines — parser gotcha). `pnpm validate:docs` must pass
  (Mermaid parse + ADR anchors).

**Acceptance.** `docs/screens/` exists with index + seeded screens, each
following the template (JTBD + roles&capabilities table + navigation links +
layout + states + data); `pnpm validate:docs` passes; registered in
`docs/CLAUDE.md` + README; no screenshots; English. Going forward, each screen
WI updates its screens doc.

---

## Cross-cutting

- **Shared files / sequencing.** WI-1 + WI-3 both edit `left-rail.tsx` +
  `app/(app)/layout.tsx` (do together). WI-4 + WI-5 both edit
  `scratch-launch-popover.tsx`/`scratch-launcher.tsx` (do together).
- **i18n.** Every new string in `web/messages/{en,ru}.json` (RU required).
- **Errors.** Known failures throw `MaisterError` with a `code`; UI branches on
  `code`, never string match.
- **Admin page pattern.** `/mcps` follows the data-management bar (full-width,
  view-only table, modal edits, URL-synced state) per `web/CLAUDE.md`.
- **Lint.** Scope eslint to touched files (`pnpm lint` is `eslint --fix`
  no-path and reformats the repo). Run `pnpm typecheck`.
- **Tests.** Unit: `evaluateMcpReadiness`, the `needsYou` helper, the adapter
  readiness summary. E2E (seeded): nav now reaches `/inbox` + `/mcps`; an
  inbox HITL respond round-trip; an MCP create shows computed readiness. New
  e2e specs must join the playwright authed-spec regex.

## Suggested phasing

1. **WI-6 scaffold** — `docs/screens/` skeleton + chrome doc (so subsequent
   WIs document into it).
2. **WI-3 + WI-1** — shared rail/layout edits (readiness block, then inbox +
   badge), with their screens docs.
3. **WI-2** — `/mcps` page + readiness evaluator, with `mcps.md`.
4. **WI-4 + WI-5** — dialog restyle + Cmd/Ctrl+K, with the launch-dialog doc.

## Follow-ups (not this round)

- After **M34** merges: revisit Flows / Flow Studio / package IA + the `Agents`
  nav as a separate spec (rename "Flows" → "Flow Studio", decide top-level
  Packages surface).
- MCP `supported_agents` could gate amber/green on adapter availability later;
  out of scope now.
