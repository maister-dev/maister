[Back to README](../README.md) · [Vision →](VISION.md)

# Getting Started

Set up MAIster for local development. This guide assumes the Web slice
(Next.js 16 monolith in `web/`) — the backend runner, DB, and subprocess
Flow integration are not yet scaffolded.

## Prerequisites

- **Node 24** (per the locked container target — `nvm use 24` if you use nvm)
- **pnpm** (package manager — `npm install -g pnpm` if missing)
- **git** with `git worktree` support (any modern version)
- **Postgres 16** (later — when the DB layer lands; not required to run
  `pnpm dev` today)
- **uv** + **Python 3.12** (later — when the Flow subprocess lands; not
  required today)

Check versions:

```bash
node --version    # v24.x
pnpm --version    # 9.x or newer
git --version
```

## Install

```bash
git clone <repo-url> mAIster
cd mAIster/web
pnpm install
```

The lockfile (`pnpm-lock.yaml`) is committed — `pnpm install` reproduces the
exact dependency tree.

## Run the dev server

```bash
cd web
pnpm dev          # http://localhost:3000
```

What you should see: the HeroUI Next.js template home page in dark mode.
Navbar, theme toggle, and demo routes (`/about`, `/blog`, `/docs`,
`/pricing`) all work. These are template stubs that will be replaced as the
real MAIster routes land: portfolio home (`/`), projects list
(`/projects`), per-project board (`/projects/[slug]`), task creation
(`/projects/[slug]/tasks/new`), and run detail (`/runs/[id]`).

## Other scripts

```bash
pnpm build        # production build
pnpm start        # serve the production build
pnpm lint         # eslint --fix
```

There is no `typecheck` script yet — `npx tsc --noEmit` works because
`noEmit: true` is set in `web/tsconfig.json`. Add a `typecheck` script the
first time CI or a pre-commit hook needs it.

## Project layout

For the full structural map see [Agent Map](../AGENTS.md). The short version:

```
mAIster/
├── web/             # The entire MAIster app (Next.js 16 monolith)
│   ├── app/         # Routes + API handlers + server actions (feature folders)
│   ├── components/  # HeroUI-based React components
│   ├── config/      # site.ts (nav), fonts.ts
│   ├── lib/         # (planned) server-only modules: errors, atomic, worktree, runner, db
│   ├── styles/      # globals.css (Tailwind 4 + HeroUI styles)
│   └── types/       # Shared TS types
├── docs/            # Product + engineering docs (you are here)
├── .ai-factory/     # AI Factory context: DESCRIPTION, ARCHITECTURE, rules/, config.yaml
├── CLAUDE.md        # Root AI agent instructions (READ THIS FIRST)
└── web/CLAUDE.md    # Web slice AI agent instructions
```

## Where to read next

- **Before touching code**: read [CLAUDE.md](../CLAUDE.md) and
  [web/CLAUDE.md](../web/CLAUDE.md). Both encode locked architectural
  decisions earned in two review passes plus an explicit
  "Out of POC scope" list.
- **For the product context**: [Vision](VISION.md) → [Product View](PRODUCT_VIEW.md).
- **For the engineering plan**: [Design (Locked)](kaa-maister-design-20260522-174429.md)
  → [Eng Review Test Plan](kaa-maister-eng-review-test-plan-20260522-180855.md).
- **For the code shape**: [Architecture](../.ai-factory/ARCHITECTURE.md).

## Common pitfalls

- **Wrong Node version** — Next.js 16 + React 19 require recent Node.
  `nvm use 24` if you have it; otherwise install Node 24.
- **`npm install` instead of `pnpm install`** — the project is pnpm-only.
  An npm lockfile will diverge from the pnpm one and break CI later.
- **Editing `app/about`, `app/blog`, `app/docs`, `app/pricing`** — those are
  HeroUI template stubs. Delete them as real MAIster routes land; do not
  build features on top of them.
- **Adding another component library** — HeroUI v3 + Tailwind 4 +
  `tailwind-variants` covers all primitives. Do not add shadcn/ui, MUI,
  Chakra, or hand-rolled equivalents (see `.ai-factory/rules/frontend.md`).

## See Also

- [Vision](VISION.md) — product spine and MVP goal
- [Architecture](../.ai-factory/ARCHITECTURE.md) — folder structure,
  dependency rules, code examples
- [Agent Map](../AGENTS.md) — structural map for AI agents
