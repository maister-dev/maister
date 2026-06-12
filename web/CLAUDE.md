# CLAUDE.md — `web/` (MAIster Web Control Plane)

> Read `../CLAUDE.md` first. It holds the product spine, locked architectural
> decisions (ACP-driven HITL + checkpoint/resume, SSE pipe-to-disk, typed
> `MaisterError`, concurrency cap, multi-executor via ACP, Flow Engine v2
> plugin model) and the out-of-POC list. This file is the Web/Next.js slice
> only. Agent processes live in `../supervisor/`, NOT here.

## What lives here

This is the **web tier** of MAIster: UI + Route Handlers + server actions +
Drizzle DB access + SSE bridge to `supervisor/`. Agent processes (`claude`,
`codex`) and ACP sessions live in the separate `../supervisor/` daemon —
this slice is the human-facing surface and the registry/board/HITL UX.

Current state: scaffolded from the official HeroUI Next.js template
(`heroui-inc/next-app-template`). The `app/`, `components/`, `config/` content
is template demo material to be **replaced** as we implement MAIster routes.

## Stack (concrete versions in `package.json`)

| Layer       | Choice                                           |
| ----------- | ------------------------------------------------ |
| Framework   | Next.js `16.2.6` (App Router)                    |
| React       | `19.2.6`                                         |
| Language    | TypeScript `5.6.3`, strict, `@/*` → `./*`        |
| UI library  | `@heroui/react` `3.0.4` + `@heroui/styles`       |
| Styling     | Tailwind CSS `4.1.11` via `@tailwindcss/postcss` |
| Variants    | `tailwind-variants` `3.2.2`                      |
| Theming     | Local script-free theme provider (default `dark`) |
| Lint        | ESLint `9` flat config + Prettier                |
| Pkg manager | pnpm                                             |
| Node        | 24 (per root CLAUDE.md container target)         |

**Do not** add other component libraries (no shadcn/ui, no MUI, no Chakra).
HeroUI v3 + Tailwind 4 + `tailwind-variants` covers all UI primitives.
Main/default UI language - EN, project should be i18n-ized. RU interface support is **REQUIRED**

## M9 additions (shipped 2026-05-29)

### Design tokens (forest theme)

`styles/globals.css` defines the `@theme` block with `forest-*` CSS custom
properties (backgrounds, surfaces, borders, text, accent, status colours).
Light/dark variants switch through `lib/theme.tsx`, which toggles the
`.light` / `.dark` class on `<html>` without injecting client-rendered script
tags. Components import
the tokens as Tailwind utilities (`bg-forest-bg`, `text-forest-text-primary`,
etc.). The tokens are also referenced via the `@custom-variant dark` rule so
`dark:` prefixes resolve correctly.

### Authentication (Auth.js v5 credentials)

Two-file edge/Node split:

- `auth.config.ts` — edge-safe (no DB). `jwt` / `session` callbacks seed
  `id` / `role` / `mustChangePassword` from `user` at sign-in, plus
  `trustHost: true`. Imported by `middleware.ts` (which builds
  `NextAuth(authConfig)`).
- `auth.ts` — Node.js runtime only. `@auth/drizzle-adapter` + the
  `CredentialsProvider` (email + password, bcrypt), and a DB-backed `jwt`
  callback that re-reads `users.role` / `users.mustChangePassword` on every
  refresh and **returns `null` (signs the user out) if the user row is gone**.
  Re-exports `auth`, `signIn`, `signOut`, `handlers`.

`web/middleware.ts` protects all `(app)` route-group pages. Unauthenticated
requests redirect to `/login`. API routes under `app/api/` call
`requireSession()` / `requireProjectAction()` from `lib/authz.ts` directly
to return machine-readable JSON errors.

**Admin bootstrap:** the single default admin is seeded by **migration
`0005`** (`admin@maister.local` / `maister-admin`, `must_change_password =
true`) — NOT by first-user registration. `register()` always creates
`member` (no admin auto-promotion → no concurrent-first-user admin race).
`must_change_password` is enforced by the `(app)` layout, which redirects to
`/change-password` until the user sets a new password (`changePassword`
server action). The column is reusable for admin-forced resets.

### RBAC model

`lib/authz.ts` exports:

- `requireSession()` — throws `UNAUTHENTICATED` (401) if no session.
- `requireGlobalRole(min)` — throws `UNAUTHORIZED` (403) if `users.role`
  is below `min`. Order: `viewer < member < admin`.
- `requireProjectRole(projectId, min)` — checks `project_members.role`.
  Global `admin` users bypass this check and receive `owner` access.
  Order: `viewer < member < admin < owner`.
- `requireProjectAction(projectId, action)` — convenience wrapper mapping
  named actions (`readBoard`, `launchRun`, `createTask`, `answerHitl`,
  `editSettings`, …) to minimum project roles via `PROJECT_ACTION_MIN`.
  **M22 (ADR-053) adds `readRepoFiles`** (`member`), gating the workbench
  git-tracked file routes — strictly above `readBoard`/`viewer`, so a viewer
  cannot browse source. The flow-graph **view** is read-only (authored layout in
  `flow.yaml`, ADR-064 — no layout write action). The workbench **diff** stays
  `readBoard` (`viewer`, run-scoped).
- `httpStatusForAuthz(code)` — maps `UNAUTHENTICATED`→401,
  `UNAUTHORIZED`→403 for use in API route error handlers.

The `projectId` passed to project-scoped functions must always be a
server-derived value (from a DB row), never a body field.

**DB-authoritative:** `getSessionUser()` re-reads the live `users` row
(role + `mustChangePassword` + existence) from the DB on every call — the
JWT supplies only the user `id`. A demoted/deleted user therefore loses
authority on their next request, not at the 30-day JWT expiry. Never branch
authorization on the cached `session.user.role`.

### i18n (next-intl, cookie-based)

- `i18n/request.ts` — locale resolution: `NEXT_LOCALE` cookie first,
  then `Accept-Language` header, defaulting to `en`.
- `messages/en.json` and `messages/ru.json` — message catalogs.
- In-app toggle calls the `setLocale` server action (sets the cookie).
- No URL-prefix routing. Locale is purely cookie-driven.
- Server Components use `getTranslations()` from `next-intl/server`.
  Client Components use `useTranslations()`.

### Route groups

```
app/
  (auth)/          # Public: /login — no session required.
    login/
  (app)/           # Protected: session required (middleware redirect).
    page.tsx        # Portfolio home (/)
    projects/
      page.tsx      # Project list (/projects)
      new/
        page.tsx    # Add project form (/projects/new)
      [slug]/
        page.tsx    # Project board (/projects/[slug])
        tasks/
          new/
            page.tsx  # Task creation (/projects/[slug]/tasks/new)
```

### Scope note

Auth.js/NextAuth, project RBAC, the 6-column board design, and the
credentials login flow are M9 additions that go beyond the original POC
"out of scope" list in `../CLAUDE.md`. They were sanctioned by the user as
part of this milestone.

**Known M9 deferrals (do not implement without explicit instruction):**

- PRs and MCPs board tabs exist in the UI as placeholders; there is no
  backend for them.
- The `projects` table now has `repo_url` and `provider` columns
  (ADR-025). It still does not have `lang`, `description`, `tags`, or
  `mcps` columns — those design ideas remain omitted from the schema
  until a migration is added.
- The settings panel (`/projects/[slug]/settings`) is read-only; there is
  no settings-write API route in M9.
- The board's "In Delivery" stage is an approximation computed in
  `web/lib/board.ts` from recently-merged run status — not a persisted
  board column.
- Admin user management is limited to global users: `/admin/users` can
  activate pending registrations, disable/re-enable accounts, change global
  roles, and reset passwords. Project member invite/remove flows are still not
  implemented; `project_members` rows are written only by `POST /api/projects`
  (owner) and existing seed/test flows.

## Scripts

```bash
pnpm dev      # next dev — http://localhost:3000
pnpm build    # next build
pnpm start    # next start (after build)
pnpm lint     # eslint --fix
pnpm install-package          # ADR-087: install a multi-flow package (all flows + bundle)
pnpm validate-authored-flow   # validate a portable authored Flow package dir
pnpm import-flow-package-draft # import a package as an inert authored draft
pnpm export-authored-flow     # export an authored Flow to a portable dir
pnpm install-authored-flow-package # bridge export as untrusted installed package
```

`pnpm typecheck` runs `tsc --noEmit` (`noEmit: true` in tsconfig).

## Current code structure

```
web/
├── app/                  # Next.js App Router
│   ├── layout.tsx        # Root layout: Providers + Navbar + container
│   ├── page.tsx          # Home (template stub — to replace with run list)
│   ├── providers.tsx     # local theme provider wrapper
│   ├── error.tsx         # Root error boundary
│   ├── about/            # template stub
│   ├── blog/             # template stub
│   ├── docs/             # template stub
│   └── pricing/          # template stub
├── components/
│   ├── navbar.tsx        # HeroUI Navbar wired to siteConfig.navItems
│   ├── theme-switch.tsx  # local theme toggle
│   ├── icons.tsx         # inline SVG icons (IconSvgProps type)
│   ├── primitives.ts     # title()/subtitle() via tailwind-variants
│   └── counter.tsx       # HeroUI <Button> demo (delete when no longer used)
├── config/
│   ├── site.ts           # navItems, navMenuItems, external links
│   └── fonts.ts          # system font CSS variable class names
├── styles/
│   └── globals.css       # @import "tailwindcss"; @import "@heroui/styles";
│                         # declares @custom-variant dark (&:is(.dark *))
├── types/
│   └── index.ts          # IconSvgProps
├── public/
├── next.config.mjs       # empty config
├── postcss.config.mjs    # @tailwindcss/postcss plugin only
├── eslint.config.mjs     # flat config (see Conventions below)
├── tsconfig.json         # strict; paths `@/*` → `./*`; jsx: react-jsx
└── pnpm-workspace.yaml   # only declares allowBuilds for native deps
                          # (NOT a real monorepo workspace)
```

## What to build here (mapped from `../docs/`)

Pages — replace template stubs:

- `app/page.tsx` → **Portfolio home** (superset.sh-style): grid of active
  workspaces across all projects. Card = project · branch · status · last
  activity · quick actions. Filters by project + status.
- `app/projects/page.tsx` → **Projects list**: registered projects + "Add
  project" button. Each row links to its board.
- `app/projects/new/page.tsx` (or modal) → **Add project**: paste path to a
  directory containing `maister.yaml`; server validates & stores.
- `app/projects/[slug]/page.tsx` → **Project board**: 2 columns
  `Backlog | In Flight`. In Flight bucket: `Running | NeedsInput |
NeedsInputIdle | Review | Crashed`. A task card in Backlog shows a
  **Launch** button — click runs precondition checks and creates a new Run
  (no drag-and-drop in POC). HITL form renders inline on the In-Flight
  card when state is `NeedsInput*`. Dedicated **Inbox** block beside the
  board lists pending HITL requests across all flows of the project.
  Done/Abandoned in a filter tab beside the board.
- `app/projects/[slug]/tasks/new/page.tsx` (or modal) → **Task creation**:
  title + prompt + Flow dropdown (from `maister.yaml` `flows[]`). Runner
  selection happens at launch time from the platform ACP runner catalog.
- `app/runs/[id]/page.tsx` → **Run detail**: status, live logs, HITL form
  panel, diff view, action buttons (mark ready, merge, abandon, recover).
  Worktree context shown (project + branch + worktree path + executor).
  Page sends periodic `POST /api/runs/[id]/activity` while visible to
  extend `keepalive_until` and prevent premature checkpoint.

Route Handlers under `app/api/`:

- `POST /api/projects` (validate `maister.yaml` v2 + install referenced Flow
  plugins from git tags, persist row)
- `DELETE /api/projects/[slug]` (soft-archive — sets `archived_at`)
- `POST /api/projects/[slug]/tasks` (create task → status `Backlog`)
- `POST /api/runs` (precondition checks, ACP runner resolution, `git worktree
add`, supervisor `POST /sessions` — body carries `taskId` and optional
  `runnerId`; `projectId` derived from task)
- `GET /api/runs/[id]/stream` (SSE; `lastEventId` reconnect; tails the
  per-step log file populated by `supervisor-client`)
- `POST /api/runs/[id]/hitl-response` (atomic write `input-<step-id>.json`
  under the project subtree → if worker live, supervisor delivers ACP
  message; if checkpointed, supervisor respawns + resumes via `session/resume`)
- `POST /api/runs/[id]/activity` (extend `keepalive_until` by 30 min while
  user is actively on the run page)
- `GET /api/runs/[id]/diff` (raw diff + per-file `+`/`−` summary; rendered split/inline via `@git-diff-view/react`, ADR-066)
- `GET/POST /api/runs/[id]/review-comments` (ADR-072 — list line-anchored
  review threads with computed `inline|outdated` placement; create a root
  comment or reply at an open review gate)
- `PATCH/DELETE /api/runs/[id]/review-comments/[commentId]` (ADR-072 —
  author-only body edit or root-only resolve/unresolve; author-only delete,
  root cascades replies)
- `POST /api/runs/[id]/merge` (`git merge --no-ff`; conflict → abort, run
  stays `Review`)
- `POST /api/runs/[id]/abandon` (supervisor `DELETE /sessions/:id` if alive;
  mark worktree stale; task → `Abandoned`)
- `POST /api/runs/[id]/recover` (Crashed → respawn + `session/resume` on
  `acp_session_id` if present; otherwise force-discard worktree)
- `GET /api/runs/[id]/artifacts` (M12 — list the typed-artifact evidence index;
  optional `node`/`kind`/`validity` filters)
- `GET /api/runs/[id]/artifacts/[artifactId]/payload` (M12 — raw payload per
  locator; `text/plain` or `application/json`; path-confined to the run dir)
- `GET /api/cron/gc` (Abandoned/Done worktrees + checkpointed sessions >7d,
  all projects)

Nav items in `config/site.ts`: **Portfolio** (`/`), **Projects**
(`/projects`), **Settings** (`/settings`). Project switcher in the navbar
links to the current project's board.

Server-side modules (add as needed, names suggested — not yet present):

- `lib/errors.ts` — `MaisterError` discriminated union (see root §3, expanded
  taxonomy includes `EXECUTOR_UNAVAILABLE | FLOW_INSTALL | ACP_PROTOCOL |
CHECKPOINT`).
- `lib/atomic.ts` — `atomicWriteJson` (tmp + rename).
- `lib/worktree.ts` — `git worktree add|remove|list` wrapper, project-scoped
  paths.
- `lib/config.ts` — `maister.yaml` v2 loader (project + flows[] with version
  pins and optional project runner refs), `schemaVersion` check,
  zod-validated, slug derivation. Also loads Flow plugin manifests
  (`flow.yaml`) with portable `runner_profiles`.
- `lib/flows.ts` — Flow plugin loader: `git clone --branch <tag>` into
  `~/.maister/flows/<id>@<tag>/` system cache, symlink into
  `.maister/<slug>/flows/<id>/`, manifest validation, version-pin enforcement.
- `lib/acp-runners/*` — platform runner catalog, sidecar readiness, usage
  references, Flow runner remaps, and launch-time runner resolution
  (launch override → Flow step target → project Flow default → platform Flow
  default → project default → platform default).
- `lib/supervisor-client.ts` — HTTP+SSE client to `../supervisor/`:
  `POST /sessions`, `DELETE /sessions/:id`, `GET /sessions/:id/stream`,
  `POST /sessions/:id/input` (deliver HITL response when worker is live).
  Reconnect with `lastEventId`.
- `lib/projects.ts` — registry CRUD, slug derivation, slug + `repo_path`
  uniqueness enforcement, recursive `MAISTER_PROJECTS_DIR` auto-discovery,
  Flow plugin install on register.
- `lib/scheduler.ts` — global concurrency cap (`MAISTER_MAX_CONCURRENT_RUNS`),
  Pending queue, auto-promote on slot free.
- `lib/db/` — Drizzle schema (`projects`, `platform_acp_runners`,
  `platform_router_sidecars`, `flows`, `flow_revisions`, `tasks`, `runs`,
  `workspaces`, `hitl_requests`) + client.
- `lib/reconcile.ts` — startup hook: per-project `runs` vs `git worktree
list` vs supervisor's live session set; orphan `Running` with no live
  ACP session and no checkpoint → `Crashed`. `NeedsInputIdle` with valid
  checkpoint stays valid.

There is NO `lib/runner.ts` — agent subprocess lifecycle lives in
`../supervisor/`, not Next.js. The web tier talks to supervisor via
`lib/supervisor-client.ts` only.

Drizzle schema sketch (server-only, `lib/db/schema.ts`):

```ts
// projects
{ id, slug (unique), name, repo_path (unique), main_branch, branch_prefix,
  maister_yaml_path, default_runner_id?, created_at, archived_at? }

// platform_acp_runners                   // platform-scoped launch catalog
{ id, adapter: 'claude' | 'codex', capability_agent: 'claude' | 'codex',
  model, provider (jsonb), permission_policy, sidecar_id?,
  readiness_status, enabled, created_at, updated_at }

// flows                                  // installed Flow plugins per project
{ id, project_id, flow_id, source_url, version_tag,                 // tag-pinned
  install_path,                            // resolved symlink target
  manifest (jsonb),                        // parsed flow.yaml (steps, etc.)
  enabled_revision_id?,
  installed_at }

// tasks
{ id, project_id, title, prompt, flow_id, status:
  'Backlog' | 'InFlight' | 'Done' | 'Abandoned',
  latest_run_id?,                          // FK to runs; null until first Launch
  attempt_number,                          // monotonic per task, starts at 1
                                           // UNIQUE (task_id, attempt_number) on runs
  created_at, updated_at }

// runs                                    // task : runs is 1 : N (retry / ralph-loop)
{ id, project_id, task_id?, flow_id?, workspace_id, runner_id?,
  runner_resolution_tier?, capability_agent?, runner_snapshot?,
  acp_session_id?,                         // resume handle for session/resume
  flow_version_tag,                        // snapshot at launch time
  status:
    'Pending' | 'Running' | 'NeedsInput' | 'NeedsInputIdle' | 'Review' |
    'Done' | 'Abandoned' | 'Crashed' | 'Failed',
  // attempt counter lives on tasks.attempt_number in M5; (Designed M8)
  // moves to runs.attempt_number with UNIQUE (task_id, attempt_number).
  current_step_id?,
  checkpoint_at?,                          // when graceful checkpoint happened
  keepalive_until?,                        // 30 min sliding window in NeedsInput
  started_at, finished_at? }

// workspaces
{ id, project_id, run_id, branch, worktree_path, status, created_at,
  removed_at? }

// hitl_requests
{ id, run_id, step_id, kind: 'permission' | 'structured_form' | 'human_review',
  question, context, response_schema (jsonb)?,        // null for binary permission
  response (jsonb)?, on_reject_goto?,                  // for human-review send-back
  requested_at, responded_at?, expires_at }
```

Task status is the **board** axis (Backlog | InFlight | Done | Abandoned).
Run status is the **execution** axis (richer state machine).

**Task lifecycle (1:N task→run)**:

- New task → `Backlog`.
- **Launch** click → precondition checks (project active, clean repo,
  branch free, worktree path free, global cap not hit, selected executor
  registered) → supervisor `POST /sessions` → task → `InFlight`. Task stays
  `InFlight` while the latest run is in any of `Pending/Running/NeedsInput/
NeedsInputIdle/Review/Crashed`.
- Latest run merged → task → `Done` (terminal).
- Latest run `Failed | Abandoned` → task auto-returns to `Backlog`; Launch
  button reappears on the card; next click spawns attempt N+1 against the
  **same** task with a fresh worktree. New `attempt_number = max + 1`.
- "Discard task" (single explicit user action on the card) → task →
  `Abandoned` (terminal). No automatic transition to `Abandoned` — it always
  takes an explicit user click. (Run-level abandon ≠ task-level abandon.)

**Run lifecycle (ACP keep-alive + checkpoint+resume)**:

- `Pending` → scheduler promotes within concurrency cap → `Running`.
- ACP session emits `session/request_permission` or agent writes
  `needs-input.json` → `Running` → `NeedsInput`. `keepalive_until` set to
  `now + 30 min`.
- Each web-console activity (run page open/focus/keystroke in form) →
  bump `keepalive_until` by +30 min.
- `now > keepalive_until` while still `NeedsInput` → supervisor checkpoints
  the agent (graceful exit, `acp_session_id` retained), sets
  `checkpoint_at = now` → `NeedsInput` → `NeedsInputIdle`.
- User submits response → `lib/atomic.ts` writes `input-<step-id>.json` →
  - If `Running/NeedsInput` (worker live) → supervisor delivers ACP message
    → resume in-process.
  - If `NeedsInputIdle` → supervisor spawns a fresh process and restores
    context via `session/resume` on `acp_session_id` → reads the input
    artifact → `Running`.
- 24h in `NeedsInputIdle` without response → `Abandoned`.
- Crash mid-`Running` (heartbeat dead, no checkpoint) → `Crashed`. UI
  surfaces "Recover or discard" — Recover attempts `session/resume` with the
  last `acp_session_id` if present, otherwise discard worktree.

This shape supports ralph-loop style retry without recreating tasks, AND
keeps long human reviews from being penalized for thinking time.

## Conventions

### TypeScript

- `strict: true` is on. Honor it. No `any` unless flagged with `// FIXME(any):`.
- Use the `@/...` alias for imports rooted at `web/` — never deep relative `../../..`.
- `target: "es5"` is the template default; do not narrow further. Modern syntax compiles fine.

### React / Next.js

- Default to **Server Components**. Add `"use client"` only when a component uses state, effects, browser APIs, or HeroUI components that require client context (most do — `<Button>`, themed inputs, modals). Match the template: `providers.tsx`, `counter.tsx`, `theme-switch.tsx` are explicit `"use client"`.
- Route handlers and server actions live in `app/`. Keep secret-touching logic server-side; **never** ship API keys to client.
- Default theme is `dark` (`<Providers themeProps={{ attribute: "class", defaultTheme: "dark" }}>` in `app/layout.tsx`). Use `@/lib/theme` `useTheme()` to toggle.

### Styling

- Tailwind 4 utility classes. Use HeroUI `Button`, `Card`, `Modal`, `Input`, `Navbar` etc. instead of hand-rolling. Exception: `components/workbench/lifecycle-actions.tsx` owns a custom accessible lifecycle dialog matched to the compact workbench surface; preserve that convention unless the whole surface is redesigned.
- For variant-based class composition use `tailwind-variants` (`tv(...)`), mirroring `components/primitives.ts`.
- Dark variant is declared in `styles/globals.css` as `@custom-variant dark (&:is(.dark *))`. Use `dark:` prefix as usual.
- Class merging: `clsx` is fine for ad-hoc combos (already in the layout); for variant APIs use `tailwind-variants`.

### Linting (auto-enforced by `pnpm lint`)

- `no-console`: warn. Use a logger boundary, not `console.log` in committed code.
- `react/jsx-sort-props`: callbacks last, shorthand first, reserved first. Auto-fixable.
- `import/order`: type → builtin → object → external → internal → parent → sibling → index, with blank lines between. Auto-fixable.
- `padding-line-between-statements`: blank line before `return`; blank line after `const/let/var` blocks. Auto-fixable.
- `unused-imports/no-unused-imports`: warn. Strip dead imports.
- `react/self-closing-comp`: warn.

### Files & naming

- React components: `kebab-case.tsx` file, named exports preferred (template uses both — pick named for new components).
- Route handlers: `app/api/<segment>/route.ts`, exporting `GET`/`POST` etc.
- Server-only modules importing `node:*`/secrets: keep in `lib/` and never import from a Client Component.

### Data-management page patterns (list / table / admin pages)

Build these pages to this bar the **first time** — the explicit goal is to not
rewrite page functionality later. Reference impl:
`components/admin/users-table.tsx` + `components/admin/user-edit-modal.tsx` +
`app/(app)/admin/users/page.tsx`.

The admin `/settings` **platform ACP runner catalog** is a second instance of
this pattern: `components/settings/acp-runners-panel.tsx` (view-only table) +
`components/settings/acp-runner-modal.tsx` (one `create | edit` modal, also owns
delete) + the `DELETE /api/admin/acp-runners/[runnerId]` usage-guard. Runner
CRUD is admin-only and the page is reachable from the admin section of
`left-rail.tsx`. Domain contract: [`docs/system-analytics/acp-runners.md`](../docs/system-analytics/acp-runners.md)
+ ADR-065. (Filters are intentionally omitted — small N.)

- **Tables are view-only.** No inline editing, row dropdowns, or row-level
  mutate buttons. Rows display data only.
- **Edit lives in a popup or a dedicated edit page**, never inline. Popup =
  modal following `user-edit-modal.tsx`; heavier edits get their own route.
- **Filter on the main fields** of the list (e.g. users: name search, role,
  status, project access) — not just one field.
- **Apply changes through ONE aggregating endpoint** (partial body in a single
  server transaction), never a client-side fan-out of per-field calls + manual
  compensation. See `lib/users.ts` `updateAdminUser` + `PATCH
  /api/admin/users/[userId]`.
- **Full-width** list/table pages: drop `mx-auto max-w-[...]`; rely on the
  `main` px gutter for air, put a `min-w-[...]` on the table inside
  `overflow-x-auto`, and use responsive `md:` breakpoints (mobile is a target).
  **Forms stay narrow** (520–760px) — do not widen forms.
- **URL-synchronized, deep-linkable state.** Filters, tabs, pagination, and
  expanded/selected state belong in URL query params (anchors / `searchParams`,
  or nuqs) so views are shareable, survive refresh, and respect back/forward —
  not `useState`-only.
- **Accessible interactions, built right:** modals get focus-trap + initial
  focus + focus-restore via refs, Escape-to-close, body scroll lock,
  `aria-labelledby`; form controls get `<label>`/`aria-label`; async
  updates/errors get `role="alert"`/`aria-live`; locale dates use `Intl` +
  `suppressHydrationWarning`. Use refs for focus/measurement, not to mask
  re-renders.
- **Role-driven nav + access:** admin-only areas live in the left sidebar
  (`components/chrome/left-rail.tsx`), gated by role; the route still enforces
  `requireGlobalRole`. The hidden nav item is convenience, never the
  authorization boundary.
- **Cursor:** enabled `<button>`/`[role=button]` get `cursor: pointer`
  app-wide via the `@layer base` rule in `styles/globals.css` — don't add
  per-button `cursor-pointer`.

## HeroUI integration notes

- `@heroui/styles` is imported once in `styles/globals.css`. Don't re-import it in components.
- Providers chain in `app/providers.tsx` currently wraps the local theme provider only. When HeroUI ships a top-level provider for v3 features (toast, modal stack), add it inside `<ThemeProvider>`.
- For new themes/colors prefer extending CSS variables in `globals.css` over forking HeroUI tokens.

## Template leftovers to clean (when you next touch them)

- `LICENSE` inside `web/` duplicates the root MIT — keep root only, drop this one when convenient.
- `README.md`: HeroUI template README; replace when we have something to say.
- Stub routes (`app/about`, `app/blog`, `app/docs`, `app/pricing`) and `components/counter.tsx`: delete as MAIster routes land.
- `app/page.tsx` and `config/site.ts` still reference HeroUI demo content (`navItems: Docs/Pricing/Blog/About`). Replace `navItems` with MAIster nav (`Portfolio`, `Projects`, `Settings`) when wiring real pages.

Flag these in PRs but do NOT mass-delete in unrelated commits (surgical-changes rule from root `CLAUDE.md`).

## House rules (carried over from root, repeated for the slice)

- No `chokidar` / `fs.watch` / polling for state transitions. The live path is supervisor's ACP notifications bridged through SSE; the recovery path is supervisor heartbeat + reconcile-on-startup.
- All writes to `.maister/<project-slug>/runs/<run-id>/` are atomic (`tmp + rename` via `atomicWriteJson`). Flow / agent may read them mid-write otherwise.
- Throw `MaisterError` with a `code` for known domain failures; UI branches on `code`. New codes: `EXECUTOR_UNAVAILABLE`, `FLOW_INSTALL`, `ACP_PROTOCOL`, `CHECKPOINT`.
- Every ACP `session/update` line must be written to **both** the SSE bridge AND `.maister/<project-slug>/runs/<run-id>/<step-id>.log` — read-side tails the file for reconnect via `lastEventId`.
- Agent processes live in `../supervisor/`, NOT in Next.js. Web tier talks to them via `lib/supervisor-client.ts` only.
- Anything in the root CLAUDE.md "Out of POC scope" list does not get implemented here either.
