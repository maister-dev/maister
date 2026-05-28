# M9 — Web UI core: login + portfolio + board, theming, EN/RU i18n, NextAuth + RBAC

**Branch:** `feature/m9-web-ui-auth-rbac`
**Base:** `132c281` (M7 merged; M8 proceeds independently in the primary worktree)
**Created:** 2026-05-29
**Milestone:** ROADMAP **M9** (expanded — see Scope note)

---

## Overview

Replace the HeroUI template stubs with the real MAIster control-plane surface, built to a
bespoke editorial design handoff (Claude Design). Three primary screens — **Login/Register**,
**Portfolio home (projects grid)**, **Project task-board** — on one shared, fully-themed
(light/dark) token system, with **EN/RU i18n everywhere**, **NextAuth (Auth.js v5) credentials
auth with DB user storage**, and **RBAC (global role + per-project membership)** guarding the
Next.js API routes.

Design source persisted in-repo at **`.ai-factory/references/m9-design/`**:
- `project/auth/login.{html,css,js}` — sign-in/register (split-spine layout)
- `project/portfolio/home.{html,css,js}` — portfolio grid (= projects list + home)
- `project/portfolio/task-board.{html,css,js}` — per-project board
- `project/landing/02-hifi.css` — **shared token system** (forest palette, fonts, shadows)
- `README.md`, `chats/` — handoff intent + iteration history; `project/screenshots/` — reference renders

### Scope note (read before implementing — anti-drift)

This milestone **deliberately expands the locked POC scope** at the user's explicit direction.
Two departures from `CLAUDE.md` / ROADMAP are intentional, not accidental:

1. **Auth / multi-user / RBAC** is on the CLAUDE.md "Out of POC scope — do not build" list.
   The user explicitly asked for NextAuth + RBAC. We build it. Recorded here so a future
   reviewer doesn't flag it as scope creep — it is sanctioned.
2. **6-column board** (`Backlog · Prepare · In production · On review · In delivery · Done`)
   is the design the user iterated to in Claude Design (see `chats/chat4.md`), a superset of
   ROADMAP M9's "2-column Backlog | In Flight". The user chose **full, data-backed** 6 columns.

**Honest deferrals inside the 6-column / multi-tab design** (no backing subsystem exists in the
POC, and building them contradicts other locked decisions — they are out of POC and out of M9):
- **PRs tab** — needs GitHub PR sync (not built). Rendered as a clearly-marked deferred placeholder.
- **MCPs tab** — needs an MCP-management backend (out of POC). Deferred placeholder.
- **"In delivery" / canary / deploy %** — no deploy pipeline. Approximated as the *merged-but-recent*
  bucket (run `Done`, workspace not yet GC'd). Documented in `lib/board.ts`.
- **Flow designer**, palette/vibe switchers, agents/MCP management screens — out of scope.

## Settings

- **Testing:** yes — unit tests embedded per feature task; consolidated integration + E2E in Task 21.
- **Logging:** verbose — server (routes/actions/lib/queries) log via the pino boundary; **never**
  `console.*` in committed code (eslint `no-console`); **never** log secrets (passwords, hashes,
  AUTH_SECRET, session tokens). Client components surface errors via UI/toast, not console.
- **Docs:** yes — mandatory documentation checkpoint at completion (Task 20), routed through `/aif-docs`.

## Roadmap Linkage

- **Milestone:** "M9. Web UI core: registry + portfolio + board + RU i18n"
- **Rationale:** Delivers the M9 deliverables (registry add-project form, portfolio grid, per-project
  board, Launch, task↔run 1:N retry loop, EN+RU from day one) using the Claude Design handoff, plus
  the user-sanctioned auth/RBAC expansion. `/aif-verify --strict` should treat the auth/RBAC + 6-column
  additions as in-scope for this plan (recorded above), not as undocumented scope.

---

## Resolved decisions (the four forks)

| Fork | Decision | Consequence |
| ---- | -------- | ----------- |
| Board scope | **Full 6-column, fully data-backed** | `lib/board.ts` derivation over existing domain state; `tasks.stage` added; PRs/MCPs/canary honestly deferred (no fake data). |
| Auth method | **Credentials only (email+password, DB)** | Auth.js v5 Credentials + bcryptjs + `@auth/drizzle-adapter`; no OAuth, no email server. Matches the login design ("single-host POC, no external providers"). |
| RBAC model | **Global role + per-project membership** | `users.role` (admin/member/viewer) + `project_members` (owner/admin/member/viewer). Matches the team avatars in the design. |
| i18n | **next-intl, cookie-based (no URL prefix)** | `NEXT_LOCALE` cookie → Accept-Language → `en`; in-app EN/RU toggle sets the cookie; **no** `app/[locale]/` restructuring. |

### Theming approach (token system)

The design is **bespoke editorial CSS**, not HeroUI defaults. Per the handoff README ("recreate
the visual output in whatever tech fits; don't copy the prototype's structure"):
- Port the **forest palette** (light + dark) from `02-hifi.css` into `web/styles/globals.css` as CSS
  variables, and map Tailwind 4 `@theme` tokens onto them. `--amber` is the brand accent and in the
  forest palette resolves to **fern green** (not orange).
- Drive light/dark via `next-themes` with `attribute="data-theme"`, `themes=["light","dark"]`,
  `enableSystem`, default `dark` (keep project convention); static `data-palette="forest"` on `<html>`.
  **No** palette/vibe switcher (single forest brand).
- Build the bespoke layout pieces (rail, project/flight cards, HITL items, board) with Tailwind
  utilities + `tailwind-variants`; use **HeroUI v3** for form controls / modals / dropdowns / tabs /
  avatars themed to the tokens. Fonts: **Inter** (sans) + **JetBrains Mono** (mono) via `next/font`.

**Forest palette token values to embed** (from `02-hifi.css`; the file is also in
`.ai-factory/references/m9-design/project/landing/02-hifi.css`):

```
LIGHT  --ink #0c120d  --ink-2 #1f2a25  --body #344c34  --mute #64724c  --mute-2 #9a958c(*)
       --line #dad7cd  --line-soft #f0efeb  --paper #ffffff(*)  --paper-warm #f8f7f5  --ivory #e9e7e1
       --amber #588157  --amber-2 #466645  --amber-soft #dae0d0  --amber-line #b9cfb9
       --accent-2 #3a5a40  --accent-3 #344e41  --accent-4 #a3b18a  (+ *-soft)
DARK   --ink #edefe8  --ink-2 #c8d0b9  --body #b6c1a2  --mute #859865
       --line #1f2e26  --line-soft #141f1a  --paper #0a0f0d  --paper-warm #0c120d  --ivory #141f1a
       --amber #96b795  --amber-2 #b9cfb9  --amber-soft #233323  --amber-line #344c34
       --accent-2 #7aaa83  --accent-3 #75a38c  --accent-4 #c8d0b9  (+ *-soft)
fonts  --sans "Inter", ui-sans-serif, system-ui, …   --mono "JetBrains Mono", ui-monospace, …
radii  --radius-sm 4  --radius 6  --radius-lg 10  --radius-xl 14
```
(*) forest light leaves `--mute-2` and `--paper` at the base-token defaults — read the file for the
authoritative full set; the embedded table is a quick reference, the file is the contract.

---

## Skill-context compliance (mandatory plan-time checklists)

### Deployment touchpoints (every new env var / dep / sidecar must land in deploy artifacts)

| New thing | Lands in |
| --------- | -------- |
| `AUTH_SECRET` (required) | `.env.example` + `compose.yml` web `environment:` + `compose.production.yml` |
| `AUTH_URL` / `NEXTAUTH_URL` | `.env.example` + compose web env (+ prod overlay) |
| `NEXT_LOCALE` cookie name (if configurable) | `.env.example` (documented) |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (optional dev seed) | `.env.example` + seed reads them |
| deps: `next-intl`, `next-auth@5`, `@auth/drizzle-adapter`, `bcryptjs` (+ `@types/bcryptjs`) | `web/package.json` + `pnpm-lock.yaml`; bcryptjs is pure-JS (no native build) — verify image builds |

→ **Task 19** owns this. No silent dev/prod skew.

### Contract surfaces → spec files (Task 20 enumerates; `/aif-verify` re-derives from diff)

| Surface | Spec file |
| ------- | --------- |
| `POST /api/projects` (new) | `docs/api/web.openapi.yaml` |
| `POST /api/projects/[slug]/tasks` (new) | `docs/api/web.openapi.yaml` |
| `/api/auth/[...nextauth]` (new) | `docs/api/web.openapi.yaml` |
| 401/403 RBAC responses added to `POST /api/runs`, HITL respond, stream | `docs/api/web.openapi.yaml` |
| new tables `users/accounts/sessions/verificationTokens/project_members`, `tasks.stage` | `docs/database-schema.md` + ERD + Drizzle migration |
| new env vars | env-vars table in `docs/configuration.md` (table is canonical) + `.env.example` |
| new error codes `UNAUTHENTICATED`, `UNAUTHORIZED` | `docs/error-taxonomy.md` + `lib/errors.ts` |
| new scripts/routes / nav | `docs/getting-started.md` + `web/CLAUDE.md` slice |

### Body-controlled cross-resource identifiers (label every route handler; derive from server state)

| Route | Identifiers & labels |
| ----- | -------------------- |
| `POST /api/runs` | `taskId` = **body-controlled** → resolve `projectId` via server-state (task→project) and authorize on *that*; never trust a body `projectId`. |
| `POST /api/runs/[runId]/hitl/[hitlRequestId]/respond` | `runId`,`hitlRequestId` = url-param; `projectId` = server-state (run→project join). |
| `GET /api/runs/[runId]/stream` | `runId` = url-param; `projectId` = server-state. |
| `POST /api/projects` | dir path = **body-controlled** → must resolve to a real `maister.yaml` via existing safe-path handling; `slug` derived **server-side** from `project.name`, never from body. |
| `POST /api/projects/[slug]/tasks` | `slug` = url-param → resolve project server-state; `flowId`,`executorOverrideId` = **body-controlled** → must belong to the resolved project (else 422). |
| all | `session.user.id` / `role` = **auth-context** (server-issued, trusted). |

### Two-phase commit (routes with downstream side-effects)

- `POST /api/projects` — side-effects: `git clone`/`setup.sh` (flow install), DB writes. Order:
  validate `maister.yaml` → write durable project intent → run flow-install side-effects → mark success.
  Failure table: validation→422 CONFIG (no row); flow-install→5xx FLOW_INSTALL (roll back / mark);
  slug/repo collision→409 (idempotent). The success marker is the **after** write.
- `POST /api/runs/[runId]/hitl/[hitlRequestId]/respond` — **do not regress M7's two-phase / atomic-claim
  contract** when adding the RBAC guard. The `respondedAt` write stays the after-delivery marker; the
  RBAC check happens before any mutation. (Task 7.)

### Config-state symmetry / deferred-release

- No new YAML→DB persistence loop in M9 (executors/flows symmetry was settled in M6). N/A.
- No new deferred/pending-promise creators in M9 (the supervisor-side HITL deferred is M7). N/A — but
  Task 7 must not break the existing release paths when inserting RBAC checks.

---

## Tasks

> 21 tasks across 8 phases. IDs match the tracked task list. `←` = depends on.

### Phase A — Foundation: theming + i18n + shared chrome
- **T1** Theme tokens + fonts + `next-themes(data-theme)` foundation. → `web/styles/globals.css`,
  `web/app/providers.tsx`, `web/app/layout.tsx`, `web/config/fonts.ts`.
- **T2** next-intl cookie-based i18n (EN/RU). → `web/i18n/request.ts`, `web/messages/{en,ru}.json`,
  `web/lib/i18n.ts`, `web/app/actions/locale.ts`, `web/next.config.mjs`, `web/app/layout.tsx`.
- **T3** Shared chrome components (Logo, TopNav, LeftRail, StatusBar, LiveTicker, Theme/Lang switches).
  `← T1, T2`. → `web/components/chrome/*`, `web/components/{theme-switch,lang-switch,logo}.tsx`.

### Phase B — Auth + RBAC backend
- **T4** Auth + RBAC DB schema (users/accounts/sessions/verificationTokens, `users.role`,
  `project_members`, `tasks.stage`) + migration + seed admin. → `web/lib/db/schema.ts`, migration,
  `web/lib/db/seed.ts`.
- **T5** Auth.js v5 config (Credentials + bcrypt + Drizzle adapter + role-claim session) + register action.
  `← T4`. → `web/auth.ts`, `web/app/api/auth/[...nextauth]/route.ts`, `web/lib/password.ts`,
  `web/app/(auth)/actions.ts`.
- **T6** RBAC authz lib + middleware + `UNAUTHENTICATED`/`UNAUTHORIZED` error codes. `← T5`. →
  `web/lib/authz.ts`, `web/middleware.ts`, `web/lib/errors.ts`.
- **T7** Harden existing API routes (`POST /api/runs`, HITL respond, stream) with RBAC; preserve
  two-phase/atomic-claim. `← T6`. → those route files.

### Phase C — Login / Register
- **T8** Login/Register page UI (`(auth)` route group, split-spine) + i18n. `← T1, T2, T3`. →
  `web/app/(auth)/layout.tsx`, `web/app/(auth)/login/page.tsx`, `web/components/auth/*`.
- **T9** Wire auth flows: credentials sign-in, register, redirects, forgot-password placeholder.
  `← T5, T8`.

### Phase D — Portfolio home
- **T10** Portfolio home (projects grid) + `(app)` shell layout + data queries (+ admin-badged avatars).
  `← T3, T4, T6`. → `web/app/(app)/layout.tsx`, `web/app/(app)/page.tsx`,
  `web/components/portfolio/*`, `web/lib/queries/portfolio.ts`.

### Phase E — Registry
- **T11** Add-project form → `POST /api/projects` (admin-only RBAC, two-phase). `← T6, T10`. →
  `web/app/(app)/projects/new/page.tsx`, `web/app/api/projects/route.ts`.

### Phase F — Project board
- **T12** Board stage-derivation lib (6-column mapping) + unit tests. `← T4`. → `web/lib/board.ts`.
- **T13** Board page shell: hero + meta strip + tabs + board-tools (layout modes). `← T3, T6, T12`. →
  `web/app/(app)/projects/[slug]/page.tsx`, `web/components/board/*`.
- **T14** Board columns + task/flight cards (6 data-backed columns) + Launch → `POST /api/runs`.
  `← T7, T13`. → `web/components/board/*`, `web/lib/queries/board.ts`.
- **T15** HITL inbox block (permission/form/human shapes) + inline respond. `← T7, T13`. →
  `web/components/board/hitl-inbox.tsx`, `web/lib/queries/hitl.ts`.
- **T16** New-task modal → `POST /api/projects/[slug]/tasks` (member+ RBAC). `← T6, T13`. →
  `web/app/api/projects/[slug]/tasks/route.ts`, `web/components/board/new-task.tsx`.
- **T17** Project tabs panels: Activity (data) + Flows (data) + Settings (admin edit) + PRs/MCPs deferred.
  `← T13`. → `web/components/board/panels/*`, `web/lib/queries/activity.ts`.

### Phase G — Cleanup + deployment + docs
- **T18** Nav/config cleanup: replace `site.ts` + metadata, remove template stubs (about/blog/docs/
  pricing, counter). `← T8, T10, T13`.
- **T19** Deployment wiring: deps + env (`.env.example`, `compose.yml`, `compose.production.yml`,
  `Dockerfile`). `← T2, T5`.
- **T20** Contract + docs (OpenAPI, DB schema/ERD, configuration, error taxonomy, getting-started,
  web slice + scope note). `← T11, T14, T15, T16, T17, T19`. **Mandatory docs checkpoint.**

### Phase H — Verification
- **T21** Integration + E2E tests (auth, RBAC matrix, registration two-phase, board/portfolio queries;
  playwright: login, theme persist, EN/RU toggle, portfolio, board, Launch). `← T9, T11, T14, T15, T16`.

---

## Commit Plan (checkpoints every 3–5 tasks)

1. **`feat(m9): theming tokens + EN/RU i18n + shared chrome`** — after T1–T3.
2. **`feat(m9,auth): schema + Auth.js credentials + RBAC + route hardening`** — after T4–T7.
3. **`feat(m9): login/register page wired to credentials auth`** — after T8–T9.
4. **`feat(m9): portfolio home + add-project registry`** — after T10–T11.
5. **`feat(m9,board): stage derivation + board shell + columns/launch`** — after T12–T14.
6. **`feat(m9,board): HITL inbox + new-task + project tab panels`** — after T15–T17.
7. **`chore(m9): nav cleanup + deployment wiring`** — after T18–T19.
8. **`docs(m9): contract surfaces + schema/ERD + getting-started`** — after T20.
9. **`test(m9): integration + E2E (auth/RBAC/board/i18n)`** — after T21.

---

## Risks & open items

- **Auth.js v5 (beta) + Next.js 16 + React 19** compatibility — verify the adapter + middleware APIs
  against the installed versions early in T5/T6 (use context7 docs if APIs drifted).
- **next-themes `data-theme` + HeroUI** — HeroUI v3 expects `.dark` class by default; confirm token
  mapping works with `attribute="data-theme"` or adapt (may need `.dark`/`.light` class instead and
  alias the design's `[data-theme]` selectors). Resolve in T1 before building screens.
- **6-column "fully data-backed"** is bounded by what the POC domain actually stores; `lib/board.ts`
  documents the approximation (esp. "In delivery"). PRs/MCPs stay honest deferrals — do **not** fabricate.
- **Worktree/branch**: this runs in the Claude worktree on `feature/m9-web-ui-auth-rbac`; M8 is on
  `feature/m8-worker-lifecycle` in the primary worktree. Independent; merge order is M8 then M9 (or
  rebase) at integration time.

---

## Unresolved questions (ответить перед/во время имплементации)

1. **Тема по умолчанию**: оставить `dark` (как сейчас в проекте) или ставить `system`? Дизайн —
   light-first.
2. **Первый пользователь = admin** автоматически, или сидим только через `SEED_ADMIN_*`? (сейчас план:
   первый зарегистрированный → admin).
3. **«Keep me signed in 30 days»** — фиксируем `session.maxAge=30d` для всех или только при галочке?
4. **PRs/MCPs табы** — показывать заглушку «later milestone» или вообще скрыть до бэкенда?
5. **`tasks.stage`** — нужен ли ручной перевод Backlog→Prepare в UI в M9, или Prepare только из
   `run.Pending`? (план: и то, и то — подтвердить нужен ли ручной перевод сейчас).
6. **Скриншоты дизайна** (~1.3MB в `.ai-factory/references/m9-design/`) — коммитить в репо или
   `.gitignore`?
