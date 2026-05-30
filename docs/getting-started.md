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
  for the wire contract.

## Prerequisites

- **Node 24** (per the locked container target — `nvm use 24` if you use nvm)
- **pnpm 11** (package manager — `npm install -g pnpm` if missing)
- **git** with `git worktree` support (any modern version)
- **pre-commit** (one-time `pre-commit install` writes the git hook)
- **Postgres 16** (required for `pnpm db:migrate` + `pnpm db:seed` and
  integration tests; not required to run `pnpm dev` against a stubbed DB)
- **Docker** (only for `compose up postgres` and the `testcontainers`
  integration test suite)
- **uv** + **Python 3.12** only when a Flow plugin needs Python tooling.

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

Only Postgres is containerized; `web` and `supervisor` run on the host (they
spawn agent CLIs and operate on host git repos — see ADR-023):

```bash
docker compose up -d postgres            # only Postgres runs in Docker
```

What you should see (M9+): the MAIster login page at `/login`. Sign in with
the credentials from `pnpm db:seed`. Active routes:

| Route | Description |
| ----- | ----------- |
| `/login` | Credentials sign-in (Auth.js v5). |
| `/` | Portfolio home — workspaces grid across all projects. |
| `/projects` | Registered projects list + "Add project" button (admin only). |
| `/projects/new` | Add-project form (admin only). Accepts absolute path to `maister.yaml` dir. |
| `/projects/[slug]` | Per-project board — Backlog, Prepare, In Delivery, In Review columns. |
| `/projects/[slug]/tasks/new` | Task creation form (member+). |

The old HeroUI template stubs (`/about`, `/blog`, `/docs`, `/pricing`) have
been removed.

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
backfill-flow-revisions  # M10 one-time backfill — seed flow_revisions from
                         # existing flows rows after applying migration 0007
                         # (idempotent; run once after upgrading to M10)
```

> **Upgrading to M10:** after `pnpm db:migrate` applies `0006`, run
> `pnpm --filter maister-web backfill-flow-revisions` once. It seeds a
> `flow_revisions` row per existing flow, points each project's enablement at
> it (grandfathered `Enabled` + `trusted_by_policy`), and links historical runs.
> Set `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES` (see
> [configuration](configuration.md)) to auto-trust your internal Flow sources.

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

## Authentication setup (M9)

MAIster requires `AUTH_SECRET` to start. Generate one and add it to `.env`:

```bash
openssl rand -base64 33   # paste the output as AUTH_SECRET=
```

The seed script (`pnpm db:seed`) creates the initial admin user. Defaults
are `SEED_ADMIN_EMAIL=admin@maister.local` and
`SEED_ADMIN_PASSWORD=maister-admin`. Override both in `.env` before any
shared use:

```env
AUTH_SECRET=<generated>
SEED_ADMIN_EMAIL=you@example.com
SEED_ADMIN_PASSWORD=<strong-password>
```

The single bootstrap admin is seeded by **migration `0005`** (defaults
`admin@maister.local` / `maister-admin`), so it exists right after
`pnpm db:migrate` — `pnpm db:seed` only adds dev project data and reuses that
admin. Sign in at `http://localhost:3000/login` with those credentials; the
account has `must_change_password = true`, so you are routed to
`/change-password` and must set a new password before reaching the app. **Public
registration always creates a `member`** — it never grants admin.

**Registering a project** requires the `admin` global role. After signing
in, navigate to `/projects/new`, paste the absolute path to a directory
containing `maister.yaml`, and submit. The server validates the manifest,
installs referenced Flow plugins, and creates the project row. You
(the admin) are automatically the project `owner`.

**EN/RU language toggle.** The UI ships with English and Russian. The
language is stored in the `NEXT_LOCALE` cookie. Use the toggle in the
top-right navbar to switch locales without a page reload. The selection
persists across sessions.

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
row into the `flows` table. The Add-Project UI will replace
this CLI for end users — it is a manual smoke-test surface only.

Full pipeline reference: [Flow Installer](flow-installer.md).

## Launch a run

After a task exists in `Backlog` for a project that has its Flow plugin
installed, kick off a run.

**Via HTTP** (the canonical surface that the future UI will call):

```bash
curl -X POST http://localhost:3000/api/runs \
  -H 'content-type: application/json' \
  -d '{ "taskId": "<task-uuid>" }'
```

Response (started): `202 { "runId": "...", "status": "Running" }`.
Response (over cap): `202 { "runId": "...", "status": "Pending", "queuePosition": 1 }`.

Optional body field: `executorOverrideId`. Full 5-level resolution
order at runtime: `launcher override → tasks.executorOverrideId →
flows.executorOverrideId → projects.defaultExecutorId →
flows.recommendedExecutorId`. Implementation in
`web/lib/executors.ts:resolveExecutor()` (pure, returns
`{executorId, tier}`).

### (Optional) CCR multi-provider routing

CCR (Claude Code Router) is bundled out-of-the-box for executors that
need intelligent multi-provider routing inside one session (z.ai GLM,
OpenRouter, MiniMax, …). There is NO need to globally install `ccr` —
MAIster ships the npm package as a supervisor dep.

1. Decide which providers you want to route through (see the upstream
   project for the provider catalog).
2. Create `~/.claude-code-router/config.json` per CCR's docs. Minimal
   shape (placeholders only — replace with real keys):

   ```json
   {
     "HOST": "127.0.0.1",
     "PORT": 3456,
     "Providers": [
       {
         "name": "z.ai",
         "api_base_url": "https://api.z.ai/api/anthropic",
         "api_key": "<Z_AI_KEY>",
         "models": ["glm-4.6"]
       }
     ],
     "Router": { "default": "z.ai,glm-4.6" }
   }
   ```

3. Mark the executor with `router: ccr` in `maister.yaml`:

   ```yaml
   executors:
     - id: claude-glm-ccr
       agent: claude
       model: glm-4.6
       router: ccr
       env:
         ANTHROPIC_AUTH_TOKEN: ${CCR_ADAPTER_TOKEN}
   ```

   (The adapter token here is consumed by the spawned adapter, not by
   CCR itself — provider keys live in `~/.claude-code-router/config.json`.
   Alternatively set `MAISTER_CCR_AUTH_TOKEN` on the supervisor's env.)

4. The supervisor's CCR manager starts the daemon automatically on
   the first `router=ccr` spawn and reuses it across the supervisor
   process lifetime. Missing config or health-check failure surfaces as
   503 `EXECUTOR_UNAVAILABLE` with a pointer to
   [executors §CCR setup](system-analytics/executors.md#ccr-setup).

**Docker note.** The Docker runtime ships with CCR pre-wired in
`compose.yml`: `MAISTER_CCR_AUTH_TOKEN` is forwarded into the
supervisor container, and `~/.claude-code-router` on the host is
bind-mounted read-only at `/app/.ccr` (overridable via
`MAISTER_CCR_CONFIG_HOST_PATH`). If `~/.claude-code-router/config.json`
is missing on the host, `router=ccr` sessions fail with 503
`EXECUTOR_UNAVAILABLE` — that's the contract, not a bug. To smoke-test
that the supervisor is reachable from inside the container:

```bash
docker compose run --rm supervisor node -e "fetch('http://127.0.0.1:7777/sessions').then(r=>console.log('supervisor ok', r.status))"
```

(Validating an actual `router=ccr` spawn end-to-end requires a real CCR
config file with provider keys — that part stays operator-managed.)

**Via the dev CLI** (operates against an already-Pending run):

```bash
DB_URL=postgres://maister:maister@localhost:5432/maister \
  pnpm --filter maister-web run-flow --task <task-uuid>
```

Behavior:

- The Route Handler creates the workspace + run rows, runs `git
  worktree add`, claims a global concurrency slot
  (`MAISTER_MAX_CONCURRENT_RUNS`, default 3), then kicks off the runner
  in the background.
- The runner walks `flow.manifest.steps[]`, persists per-step state to
  the `step_runs` table, drives `runs.status` through
  `Running ↔ NeedsInput → Review | Failed`.
- `agent` steps proxy to the supervisor at
  `POST /sessions` + `POST /sessions/:id/prompt` (see
  [Supervisor](supervisor.md)).
- `human` steps suspend the run with `NeedsInput`, writing
  a `hitl_requests` row. The response route writes
  `input-<stepId>.json` and the runner resumes from that durable input.

Full DSL reference: [Flow DSL](flow-dsl.md). Bundled plugin walkthrough:
[aif plugin](flow-aif-plugin.md).

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
  [web/CLAUDE.md](../web/CLAUDE.md). Both encode product spine,
  current implementation boundaries, and conventions.
- **For the product context**: [Vision](VISION.md) → [Product View](PRODUCT_VIEW.md).
- **For the code shape**: [Architecture](architecture.md) and [Decisions](decisions.md).
- **For contracts**: [Web OpenAPI](api/web.openapi.yaml),
  [Supervisor OpenAPI](api/supervisor.openapi.yaml), and
  [AsyncAPI specs](api/async/).

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

- [Database Schema](database-schema.md) — 8 tables, FK cascade chain,
  Drizzle workflow
- [Error Taxonomy](error-taxonomy.md) — `MaisterError` codes and when
  each one fires
- [Configuration](configuration.md) — `maister.yaml` v2 + `flow.yaml`
  v1 + every env var
- [Vision](VISION.md) — product spine and MVP goal
- [Architecture](architecture.md) — folder structure,
  dependency rules, code examples
- [Agent Map](../AGENTS.md) — structural map for AI agents
