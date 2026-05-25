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

- `app/page.tsx` → **flat run list** (`docs/...test-plan....md` §"Affected Pages/Routes"). Status badge column, filter by status.
- `app/runs/[id]/page.tsx` → **run detail**: status, live logs, HITL form panel, diff view, action buttons (mark ready, merge, abandon).
- `app/tasks/new/page.tsx` (or modal) → task creation: title + prompt + target Flow (preselected from `maister.yaml`).

Route Handlers under `app/api/`:

- `POST /api/tasks`
- `POST /api/runs` (precondition checks, `git worktree add`, spawn)
- `GET /api/runs/[id]/stream` (SSE; `lastEventId` reconnect; tails `.maister/runs/<id>/<block-id>.log`)
- `POST /api/runs/[id]/hitl-response` (atomic write `input-<block-id>.json` → re-invoke Flow with `--resume`)
- `GET /api/runs/[id]/diff` (`git diff` raw → `<pre>`, no syntax highlighting)
- `POST /api/runs/[id]/merge` (`git merge --no-ff`; conflict → abort)
- `POST /api/runs/[id]/abandon` (SIGTERM if a block is alive; mark worktree stale)
- `GET /api/cron/gc` (Abandoned/Done worktrees older than 7d)

Server-side modules (add as needed, names suggested — not yet present):

- `lib/errors.ts` — `MaisterError` discriminated union (see root §3).
- `lib/atomic.ts` — `atomicWriteJson` (tmp + rename).
- `lib/worktree.ts` — `git worktree add|remove|list` wrapper.
- `lib/runner.ts` — `child_process.spawn` of `uv run <flow-cmd>`; pipe stdout to SSE **and** to disk simultaneously.
- `lib/config.ts` — `maister.yaml` loader, `schemaVersion` check, zod-validated.
- `lib/db/` — Drizzle schema (`runs`, `tasks`, `workspaces`, `hitl_requests`) + client.
- `lib/reconcile.ts` — startup hook: `runs` vs `git worktree list`; orphaned `Running` → `Crashed`.

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
- `app/page.tsx` and `config/site.ts` still reference HeroUI demo content (`navItems: Docs/Pricing/Blog/About`). Replace `navItems` with MAIster nav (`Runs`, `Tasks`, `Settings`) when wiring real pages.

Flag these in PRs but do NOT mass-delete in unrelated commits (surgical-changes rule from root `CLAUDE.md`).

## House rules (carried over from root, repeated for the slice)

- No `chokidar` / `fs.watch` / polling. SSE + subprocess exit codes drive UI transitions.
- All writes to `.maister/<run>/` are atomic (`tmp + rename` via `atomicWriteJson`). Flow may read them mid-write otherwise.
- Throw `MaisterError` with a `code` for known domain failures; UI branches on `code`.
- Stdout from a block must go to **both** SSE and `.maister/runs/<id>/<block-id>.log` — read-side tails the file.
- One block = one subprocess. No long-running process held across HITL waits.
- Anything in the root CLAUDE.md "Out of POC scope" list does not get implemented here either.
