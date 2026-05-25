# CLAUDE.md — `web/` (MAIster Web Control Plane)

> Read `../CLAUDE.md` first. It holds the product spine, locked architectural
> decisions (block-based HITL, SSE pipe-to-disk, typed `MaisterError`,
> concurrency cap, single hard-coded executor) and the out-of-POC list.
> This file is the Web/Next.js slice only.

## What lives here

This is **the entire MAIster app** for the POC. Next.js 16 monolith: UI +
Route Handlers + server actions + (eventually) subprocess runner, Drizzle DB
access, and SSE log streams. There is no separate backend service.

Current state: scaffolded from the official HeroUI Next.js template
(`heroui-inc/next-app-template`). The `app/`, `components/`, `config/` content
is template demo material to be **replaced** as we implement MAIster routes.

## Stack (concrete versions in `package.json`)

| Layer        | Choice                                      |
| ------------ | ------------------------------------------- |
| Framework    | Next.js `16.2.6` (App Router)               |
| React        | `19.2.6`                                    |
| Language     | TypeScript `5.6.3`, strict, `@/*` → `./*`   |
| UI library   | `@heroui/react` `3.0.4` + `@heroui/styles`  |
| Styling      | Tailwind CSS `4.1.11` via `@tailwindcss/postcss` |
| Variants     | `tailwind-variants` `3.2.2`                 |
| Theming      | `next-themes` `0.4.6` (default `dark`)      |
| Lint         | ESLint `9` flat config + Prettier           |
| Pkg manager  | pnpm                                        |
| Node         | 24 (per root CLAUDE.md container target)    |

Not yet installed (add when we wire backend per `../docs/`):
`drizzle-orm`, `pg`, `zod`, `vitest`, `@playwright/test`.

**Do not** add other component libraries (no shadcn/ui, no MUI, no Chakra).
HeroUI v3 + Tailwind 4 + `tailwind-variants` covers all UI primitives.
Main/default UI language - EN, project should be i18n-ized. RU interface support is **REQUIRED**

## Scripts

```bash
pnpm dev      # next dev — http://localhost:3000
pnpm build    # next build
pnpm start    # next start (after build)
pnpm lint     # eslint --fix
```

No `typecheck` script yet — `tsc --noEmit` works (`noEmit: true` in tsconfig).
Add a `typecheck` script the first time CI or a pre-commit hook needs it.

## Current code structure

```
web/
├── app/                  # Next.js App Router
│   ├── layout.tsx        # Root layout: Providers + Navbar + container
│   ├── page.tsx          # Home (template stub — to replace with run list)
│   ├── providers.tsx     # next-themes ThemeProvider wrapper
│   ├── error.tsx         # Root error boundary
│   ├── about/            # template stub
│   ├── blog/             # template stub
│   ├── docs/             # template stub
│   └── pricing/          # template stub
├── components/
│   ├── navbar.tsx        # HeroUI Navbar wired to siteConfig.navItems
│   ├── theme-switch.tsx  # next-themes toggle
│   ├── icons.tsx         # inline SVG icons (IconSvgProps type)
│   ├── primitives.ts     # title()/subtitle() via tailwind-variants
│   └── counter.tsx       # HeroUI <Button> demo (delete when no longer used)
├── config/
│   ├── site.ts           # navItems, navMenuItems, external links
│   └── fonts.ts          # Inter (sans) + Fira Code (mono) via next/font
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
  `Backlog | In Flight`. In Flight bucket: `Running | NeedsInput | Review |
  Crashed`. A task card in Backlog shows a **Launch** button — click runs
  precondition checks and creates a new Run (no drag-and-drop in POC).
  Done/Abandoned in a filter tab beside the board.
- `app/projects/[slug]/tasks/new/page.tsx` (or modal) → **Task creation**:
  title + prompt + Flow dropdown (from `maister.yaml` `flows[]`).
- `app/runs/[id]/page.tsx` → **Run detail**: status, live logs, HITL form
  panel, diff view, action buttons (mark ready, merge, abandon). Worktree
  context shown (project + branch + worktree path).

Route Handlers under `app/api/`:

- `POST /api/projects` (validate `maister.yaml`, persist row)
- `DELETE /api/projects/[slug]` (soft-archive — sets `archived_at`)
- `POST /api/projects/[slug]/tasks` (create task → status `Backlog`)
- `POST /api/runs` (precondition checks, `git worktree add`, spawn — body
  carries `taskId` + `flowId`; `projectId` derived from task)
- `GET /api/runs/[id]/stream` (SSE; `lastEventId` reconnect; tails
  `.maister/<project-slug>/runs/<run-id>/<block-id>.log`)
- `POST /api/runs/[id]/hitl-response` (atomic write `input-<block-id>.json`
  under the project subtree → re-invoke Flow with `--resume`)
- `GET /api/runs/[id]/diff` (`git diff` raw → `<pre>`, no syntax highlighting)
- `POST /api/runs/[id]/merge` (`git merge --no-ff`; conflict → abort, run
  stays `Review`)
- `POST /api/runs/[id]/abandon` (SIGTERM if a block is alive; mark worktree
  stale; task → `Abandoned`)
- `GET /api/cron/gc` (Abandoned/Done worktrees >7d, all projects)

Nav items in `config/site.ts`: **Portfolio** (`/`), **Projects**
(`/projects`), **Settings** (`/settings`). Project switcher in the navbar
links to the current project's board.

Server-side modules (add as needed, names suggested — not yet present):

- `lib/errors.ts` — `MaisterError` discriminated union (see root §3).
- `lib/atomic.ts` — `atomicWriteJson` (tmp + rename).
- `lib/worktree.ts` — `git worktree add|remove|list` wrapper, project-scoped
  paths.
- `lib/runner.ts` — `child_process.spawn` of `uv run <flow-cmd>`; pipe stdout
  to SSE **and** to `.maister/<project-slug>/runs/<run-id>/<block-id>.log`
  simultaneously.
- `lib/config.ts` — `maister.yaml` v1 loader (project + flows[]),
  `schemaVersion` check, zod-validated, slug derivation, dup-flow-id check.
- `lib/projects.ts` — registry CRUD, slug derivation, slug + `repo_path`
  uniqueness enforcement, recursive `MAISTER_PROJECTS_DIR` auto-discovery.
- `lib/scheduler.ts` — global concurrency cap (`MAISTER_MAX_CONCURRENT_RUNS`),
  Pending queue, auto-promote on slot free.
- `lib/db/` — Drizzle schema (`projects`, `tasks`, `runs`, `workspaces`,
  `hitl_requests`) + client.
- `lib/reconcile.ts` — startup hook: per-project `runs` vs `git worktree
  list`; orphaned `Running` → `Crashed`.

Drizzle schema sketch (server-only, `lib/db/schema.ts`):

```ts
// projects
{ id, slug (unique), name, repo_path (unique), main_branch, branch_prefix,
  maister_yaml_path, created_at, archived_at? }

// tasks
{ id, project_id, title, prompt, flow_id, status:
  'Backlog' | 'InFlight' | 'Done' | 'Abandoned',
  latest_run_id?,                       // FK to runs; null until first Launch
  created_at, updated_at }

// runs                                  // task : runs is 1 : N (retry / ralph-loop)
{ id, project_id, task_id, flow_id, workspace_id, status:
  'Pending' | 'Running' | 'NeedsInput' | 'Review' | 'Done' |
  'Abandoned' | 'Crashed' | 'Failed',
  attempt_number,                        // monotonic per task, starts at 1
  current_block_id?, started_at, finished_at? }

// workspaces
{ id, project_id, run_id, branch, worktree_path, status, created_at,
  removed_at? }

// hitl_requests
{ id, run_id, block_id, question, context, response_schema (jsonb),
  response (jsonb)?, requested_at, responded_at?, expires_at }
```

Task status is the **board** axis (Backlog | InFlight | Done | Abandoned).
Run status is the **execution** axis (richer state machine).

**Task lifecycle (1:N task→run)**:

- New task → `Backlog`.
- **Launch** click → precondition checks → spawn run (attempt N) → task →
  `InFlight`. Task stays `InFlight` while the latest run is in any of
  `Pending/Running/NeedsInput/Review/Crashed`.
- Latest run merged → task → `Done` (terminal).
- Latest run `Failed | Abandoned` → task auto-returns to `Backlog`; Launch
  button reappears on the card; next click spawns attempt N+1 against the
  **same** task with a fresh worktree. New `attempt_number = max + 1`.
- "Discard task" (single explicit user action on the card) → task →
  `Abandoned` (terminal). No automatic transition to `Abandoned` — it always
  takes an explicit user click. (Run-level abandon ≠ task-level abandon.)

This shape supports ralph-loop style retry without recreating tasks.

## Conventions

### TypeScript
- `strict: true` is on. Honor it. No `any` unless flagged with `// FIXME(any):`.
- Use the `@/...` alias for imports rooted at `web/` — never deep relative `../../..`.
- `target: "es5"` is the template default; do not narrow further. Modern syntax compiles fine.

### React / Next.js
- Default to **Server Components**. Add `"use client"` only when a component uses state, effects, browser APIs, or HeroUI components that require client context (most do — `<Button>`, themed inputs, modals). Match the template: `providers.tsx`, `counter.tsx`, `theme-switch.tsx` are explicit `"use client"`.
- Route handlers and server actions live in `app/`. Keep secret-touching logic server-side; **never** ship API keys to client.
- Default theme is `dark` (`<Providers themeProps={{ attribute: "class", defaultTheme: "dark" }}>` in `app/layout.tsx`). Use `next-themes` `useTheme()` to toggle.

### Styling
- Tailwind 4 utility classes. Use HeroUI `Button`, `Card`, `Modal`, `Input`, `Navbar` etc. instead of hand-rolling.
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

## HeroUI integration notes

- `@heroui/styles` is imported once in `styles/globals.css`. Don't re-import it in components.
- Providers chain in `app/providers.tsx` currently wraps `next-themes` only. When HeroUI ships a top-level provider for v3 features (toast, modal stack), add it inside `<NextThemesProvider>`.
- For new themes/colors prefer extending CSS variables in `globals.css` over forking HeroUI tokens.

## Template leftovers to clean (when you next touch them)

- `LICENSE` inside `web/` duplicates the root MIT — keep root only, drop this one when convenient.
- `README.md`: HeroUI template README; replace when we have something to say.
- Stub routes (`app/about`, `app/blog`, `app/docs`, `app/pricing`) and `components/counter.tsx`: delete as MAIster routes land.
- `app/page.tsx` and `config/site.ts` still reference HeroUI demo content (`navItems: Docs/Pricing/Blog/About`). Replace `navItems` with MAIster nav (`Portfolio`, `Projects`, `Settings`) when wiring real pages.

Flag these in PRs but do NOT mass-delete in unrelated commits (surgical-changes rule from root `CLAUDE.md`).

## House rules (carried over from root, repeated for the slice)

- No `chokidar` / `fs.watch` / polling. SSE + subprocess exit codes drive UI transitions.
- All writes to `.maister/<project-slug>/runs/<run-id>/` are atomic (`tmp + rename` via `atomicWriteJson`). Flow may read them mid-write otherwise.
- Throw `MaisterError` with a `code` for known domain failures; UI branches on `code`.
- Stdout from a block must go to **both** SSE and `.maister/<project-slug>/runs/<run-id>/<block-id>.log` — read-side tails the file.
- One block = one subprocess. No long-running process held across HITL waits.
- Anything in the root CLAUDE.md "Out of POC scope" list does not get implemented here either.
