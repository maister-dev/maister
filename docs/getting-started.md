[Back to README](../README.md) · [Database Schema →](database-schema.md)

# Getting Started

Set up MAIster for local development. The repo is a pnpm monorepo with
two long-running Node processes:

- **`web/`** — Next.js 16 (Drizzle schema, error taxonomy, `maister.yaml`
  v2 loader, vitest + Playwright). The user-facing surface plus the
  Route Handlers that bridge SSE to the browser.
- **`supervisor/`** — a separate Node daemon (Fastify + pino) that owns
  ACP sessions and spawns the per-session agent processes
  (`claude-agent-acp`, `codex-acp`). See [Supervisor](supervisor.md)
  for the wire contract and limitations on POC.

## Prerequisites

- **Node 24** (per the locked container target — `nvm use 24` if you use nvm)
- **pnpm 11** (package manager — `npm install -g pnpm` if missing)
- **git** with `git worktree` support (any modern version)
- **pre-commit** (one-time `pre-commit install` writes the git hook)
- **Postgres 16** (required for `pnpm db:migrate` + `pnpm db:seed` and
  integration tests; not required to run `pnpm dev` against a stubbed DB)
- **Docker** (only for `compose up postgres` and the `testcontainers`
  integration test suite)
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
cd mAIster
pre-commit install                # one-time: writes .git/hooks/pre-commit
pnpm install --frozen-lockfile    # from repo root — installs both workspaces
```

The lockfile (`pnpm-lock.yaml` at the repo root) is committed —
`pnpm install --frozen-lockfile` reproduces the exact dependency tree
for both `web/` and `supervisor/`. CI uses the frozen lockfile.

## Run the dev servers

The web tier defaults to `MAISTER_SUPERVISOR_URL=http://localhost:7777`,
so start the supervisor first when running both locally.

```bash
# Terminal 1: supervisor (Fastify + tsx watch on src/main.ts)
pnpm --filter @maister/supervisor dev    # http://localhost:7777

# Terminal 2: web (Next.js dev server)
pnpm --filter maister-web dev            # http://localhost:3000
```

Or use Docker Compose for both plus Postgres in one command:

```bash
docker compose up -d
docker compose logs -f                   # follow web + supervisor + postgres
```

What you should see: the HeroUI Next.js template home page in dark mode.
Navbar, theme toggle, and demo routes (`/about`, `/blog`, `/docs`,
`/pricing`) all work. These are template stubs that will be replaced as the
real MAIster routes land: portfolio home (`/`), projects list
(`/projects`), per-project board (`/projects/[slug]`), task creation
(`/projects/[slug]/tasks/new`), and run detail (`/runs/[id]`).

## Other scripts

All commands work from the repo root via `pnpm --filter <pkg> <script>`.

**Web (`pnpm --filter maister-web …`):**

```bash
build              # production build
start              # serve the production build
lint               # eslint --fix
typecheck          # tsc --noEmit
test               # vitest unit + integration
test:unit          # unit only (fast)
test:integration   # spins up Postgres via testcontainers (slower)
test:e2e           # Playwright (scaffolded, no specs yet)
db:generate        # generate a Drizzle migration from lib/db/schema.ts
db:migrate         # apply migrations against $DB_URL
db:seed            # idempotent dev seed (1 project + 2 executors + 1 flow)
db:studio          # drizzle-kit studio
```

**Supervisor (`pnpm --filter @maister/supervisor …`):**

```bash
dev                # tsx watch src/main.ts (auto-restart on changes)
start              # tsx src/main.ts (one-shot)
lint               # eslint --fix
typecheck          # tsc --noEmit
test               # vitest unit + integration
test:unit          # 30 tests (registry, types, cost, spawn)
test:integration   # 9 lifecycle scenarios via the fake-acp.mjs fixture
```

## Database

```bash
docker compose up postgres -d
cd web
DB_URL=postgres://maister:maister@localhost:5432/maister pnpm db:migrate
DB_URL=postgres://maister:maister@localhost:5432/maister pnpm db:seed
```

Full reference: [Database Schema](database-schema.md). For the full env-var
list (incl. `MAISTER_DB_POOL_MAX`, `MAISTER_MAX_CONCURRENT_RUNS`,
`MAISTER_KEEPALIVE_MINUTES`): [Configuration](configuration.md).

## Install a Flow plugin

Once a project row exists (the seed creates `maister-dev`), install a
Flow plugin against it with the ops CLI:

```bash
DB_URL=postgres://maister:maister@localhost:5432/maister \
  pnpm --filter maister-web install-flow \
    --project maister-dev \
    --source <git-url-or-local-path> \
    --version v0.1.0 \
    --flow-id bugfix
```

The installer clones the git repo at `<version>` into
`~/.maister/flows/<flowId>@<version>/`, validates `flow.yaml`,
creates the per-project symlink at
`<project repo>/.maister/<slug>/flows/<flowId>/`, and upserts the
row into the `flows` table. The Add-Project UI in M9 will replace
this CLI for end users — it is a manual smoke-test surface only.

Full pipeline reference: [Flow Installer](flow-installer.md).

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

- [Database Schema](database-schema.md) — 7 tables, FK cascade chain,
  Drizzle workflow
- [Error Taxonomy](error-taxonomy.md) — `MaisterError` codes and when
  each one fires
- [Configuration](configuration.md) — `maister.yaml` v2 + `flow.yaml`
  v1 + every env var
- [Vision](VISION.md) — product spine and MVP goal
- [Architecture](../.ai-factory/ARCHITECTURE.md) — folder structure,
  dependency rules, code examples
- [Agent Map](../AGENTS.md) — structural map for AI agents
