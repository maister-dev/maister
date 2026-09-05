[Back to README](../README.md) · [Database Schema →](database-schema.md)

# Getting Started

Set up MAIster for local development. The repo is a pnpm monorepo with
two long-running Node processes:

- **`web/`** — Next.js 16 (Drizzle schema, error taxonomy, `maister.yaml`
  v2 loader, vitest + Playwright). The user-facing surface plus the
  Route Handlers that bridge SSE to the browser.
- **`supervisor/`** — a separate Node daemon (Fastify + pino) that owns
  ACP sessions and spawns the per-session agent processes
  (`claude-agent-acp`, `codex-acp`, `gemini --acp`, `opencode acp`,
  `mimo acp`). Gemini, OpenCode, and MiMo launchability is readiness-gated by
  supervisor diagnostics and smoke evidence. See [Supervisor](supervisor.md)
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
- **At least one coding agent authenticated on every supervisor host.** Choose
  Claude Code, Codex, Gemini CLI, OpenCode, or MiMo. The supervisor must run
  under the operating-system account that owns the native agent login, unless
  the runner receives provider credentials through environment references.
- **`gh` (GitHub CLI) — optional** (Designed, [ADR-093](decisions.md#adr-093-project-onboarding--optional-maisteryaml-host-ambient-git-auth-onboarding-modes-advisory-clone-reasons)). When present and authed (`gh auth login`), the Add-project flow auto-uses its token (`gh auth token`) for `github.com` HTTPS clones. Absent or unauthed degrades gracefully to SSH / the one-off HTTPS-token field — `gh` is never required for onboarding.
- **PR-mode promotion (Implemented) — only needed for `pull_request` promotion;
  `local_merge` needs none.** Per the run's provider: `gh` CLI on `PATH` (github),
  `glab` CLI on `PATH` (gitlab) — each with host auth (`gh auth` / `glab auth`, or
  `GH_TOKEN` / `GITLAB_TOKEN` in the env); or `GITEA_TOKEN` / `GITVERSE_TOKEN` in the
  env (gitea / gitverse, via the Gitea-compatible REST adapter — no CLI). All providers
  also need a host **git push credential helper** (SSH key or HTTPS helper) for the
  run's remote. **Not provisioned in the default compose** — the default compose stays
  Postgres-only ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)),
  so these are a host-operator concern. See [`configuration.md`](configuration.md) for
  the per-provider table.

Check versions:

```bash
node --version    # v24.x
pnpm --version    # 9.x or newer
git --version
```

## Install

```bash
git clone https://github.com/maister-dev/maister.git
cd maister
pre-commit install                # one-time: writes .git/hooks/pre-commit
pnpm install --frozen-lockfile    # from repo root — installs both workspaces
```

[`scripts/quickstart.sh`](../scripts/quickstart.sh) performs the install,
env-file, Postgres, migration, and MCP-build steps of this page in one go
(`./scripts/quickstart.sh` from a checkout, or
`curl -fsSL https://imaister.dev/quickstart.sh | bash` from an empty
directory). It never overwrites an existing env file and is safe to repeat; the
`pre-commit` hook and the dev seed stay manual.

The lockfile (`pnpm-lock.yaml` at the repo root) is committed —
`pnpm install --frozen-lockfile` reproduces the exact dependency tree
for both `web/` and `supervisor/`. CI uses the frozen lockfile.

`maister-web` now includes `@xyflow/react` (v12) + `@dagrejs/dagre` for the
evidence-graph explorer (React 19 compatible, already in the lockfile, no
extra setup). See [ADR-039](decisions.md#adr-039-xyflowreact--dagrejsdagre-as-the-evidence-graph-renderer).

## Prepare a coding agent

`pnpm install` installs the `claude-agent-acp` and `codex-acp` adapter binaries.
Authenticate the underlying agent before launching a Flow. For example, Codex
supports the following login command from the repository root:

```bash
pnpm --filter @maister/supervisor exec codex-acp login
```

For Claude Code, Gemini CLI, OpenCode, or MiMo, complete the application's native
login under the supervisor's operating-system account. Gemini, OpenCode, and
MiMo also require their executable on that account's `PATH`. Provider credentials
can instead be supplied to the supervisor through the runner's `env:NAME`
references.

After the services are running, sign in as an administrator and open
**Settings → ACP runners**. Create a profile for the prepared agent, wait for
diagnostics to report **Ready**, and only then enable it. A Flow cannot start
until at least one enabled, Ready profile satisfies its runner requirements.
See [Supervisor](supervisor.md) for adapter diagnostics and
[Configuration](configuration.md) for environment handling.

## Run the dev servers

The web tier defaults to `MAISTER_SUPERVISOR_URL=http://localhost:7777`,
so start the supervisor first when running both locally.

```bash
# Terminal 1: supervisor (Fastify + tsx watch on src/main.ts)
pnpm --filter @maister/supervisor dev    # http://localhost:7777

# Terminal 2: web (Next.js dev server)
pnpm --filter maister-web dev            # http://localhost:3000

# Or both in one terminal, output prefixed per package
pnpm dev
```

Only Postgres is containerized; `web` and `supervisor` run on the host (they
spawn agent CLIs and operate on host git repos — see ADR-023). Both read the
same `MAISTER_RUNTIME_ROOT`; the supervisor additionally keeps its
execution-host state (identity, fences, adopted-workspace handles, command
receipts — ADR-166) under `<runtimeRoot>/.maister/execution-host/`,
created on first boot (override with `MAISTER_EXECUTION_HOST_STATE_DIR`):

```bash
docker compose up -d postgres            # only Postgres runs in Docker
```

For a production VPS install (systemd services, TLS reverse proxy, firewall),
see [`deployment.md`](deployment.md).

What you should see: the MAIster login page at `/login`. Sign in with
the credentials from `pnpm db:seed`. Active routes:

| Route                        | Description                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/login`                     | Credentials sign-in (Auth.js v5).                                                                        |
| `/`                          | Portfolio home — workspaces grid across all projects.                                                    |
| `/projects`                  | Registered projects list + "Add project" button (admin only).                                            |
| `/projects/new`              | Add-project form (admin only). Accepts a repository directory and bootstraps `maister.yaml` when needed. |
| `/projects/[slug]`           | Per-project board — Backlog, Prepare, In Delivery, In Review columns.                                    |
| `/projects/[slug]/tasks/new` | Task creation form (member+).                                                                            |
| `/flows`                     | Authored Flow drafts and installed package inventory.                                                    |

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
test:e2e           # Playwright (authed UI specs — see note below)
db:generate        # generate a Drizzle migration from lib/db/schema.ts
db:migrate         # apply MAIN-lineage migrations against $DB_URL
db:migrate:brain   # apply the Project-Brain lineage (brain_* + pgvector); AFTER
                   # db:migrate. Requires a
                   # pgvector-enabled Postgres image (pgvector/pgvector:pg16).
db:seed            # idempotent dev seed (admin + platform runners + sample project)
db:studio          # drizzle-kit studio
validate-authored-flow   # validate a portable authored Flow package directory
import-flow-package-draft # import a portable package as an inert authored draft
export-authored-flow     # export an authored Flow draft/published revision
                         # to a git-ready portable directory
install-authored-flow-package # install an exported authored package as
                              # untrusted; trust/enable remains separate
```

> **Engine 3 upgrade:** do **not** run `backfill-flow-revisions`. It is retired
> after the graph-only cut-over and exits with `PRECONDITION`; the ordered
> 0094 D2/D1, 0095 stale-C2-claim, and 0096 cut-over-event-index main-lineage
> sequence is the only supported
> upgrade path. Follow the ordered
> [deployment preflight](deployment.md#13-engine-300-postgresgraph-only-upgrade)
> instead.

> **`test:e2e` prerequisites (no manual database setup):** `pnpm --filter
maister-web test:e2e` (or `cd web && pnpm test:e2e`) creates one disposable
> pgvector Postgres Testcontainer, applies main then Brain migrations, seeds
> fixtures, and tears the database down after Playwright exits. It requires a
> reachable **Docker runtime**; unit/build commands do not. Playwright's
> `webServer` boots `next dev` on `E2E_PORT` (3100) against the wrapper-provided
> `DB_URL`; no fixed `E2E_DB_URL` or manual schema reset exists.
> The seed `git init`s a real parent repo + `git worktree add`s each authed
> spec's run branch under `<repo>/.worktrees/`, so the manual-takeover spec
> (`m11b-takeover.spec.ts`) exercises real `git log`/`git diff`/`merge-base` on
> return. If a prior run
> left a prior E2E process running, stop that process and re-run; the wrapper
> owns a new database for every invocation.

**Supervisor (`pnpm --filter @maister/supervisor …`):**

```bash
dev                # tsx watch src/main.ts (auto-restart on changes)
start              # tsx src/main.ts (one-shot)
lint               # eslint --fix
typecheck          # tsc --noEmit
test               # vitest unit + integration
test:unit          # 30 tests (registry, types, cost, spawn)
test:integration   # 9 lifecycle scenarios via the fake-acp.mjs fixture
smoke:acp          # cache adapter smoke evidence (readOnlySession + capabilityEnforcement dimensions)
```

**Adapter evidence ritual (ADR-090 / ADR-130).** Some launches are gated on cached
live-adapter smoke evidence written by `smoke:acp` into
`MAISTER_ADAPTER_SMOKE_CACHE_PATH`:

```bash
# Read-only-session evidence (none/repo_read platform-agent runs — ADR-090):
pnpm -C supervisor smoke:acp --cache <path> --read-only-session gemini opencode mimo
# Capability-enforcement evidence (strict tools/mcps flow/agent runs — ADR-130):
pnpm -C supervisor smoke:acp --cache <path> --capability-enforcement claude codex gemini opencode mimo
```

Until an adapter's `capabilityEnforcement` dimension is cached `ok`, a strict
`tools`/`mcps` launch on it **refuses** with a diagnostic naming the missing
evidence (never a false-enforce). CI runs the probe against the mock-ACP adapter;
the live confirmation for real adapters is this operator ritual. Full checklist:
[`system-analytics/guardrail-hooks.md`](system-analytics/guardrail-hooks.md).

## Database

```bash
docker compose up postgres -d
cd web
DB_URL=postgres://maister:maister@localhost:5432/maister pnpm db:migrate
DB_URL=postgres://maister:maister@localhost:5432/maister pnpm db:migrate:brain
DB_URL=postgres://maister:maister@localhost:5432/maister pnpm db:seed
```

> **Project Brain (ADR-122).** `compose.yml` uses the pgvector-enabled image
> `pgvector/pgvector:pg16` (data-compatible with `postgres:16-alpine`). Run
> `db:migrate:brain` AFTER `db:migrate` — it applies the separate `brain_*` +
> `CREATE EXTENSION vector` lineage into its own ledger.

Full reference: [Database Schema](database-schema.md). For the full env-var
list (incl. `MAISTER_DB_POOL_MAX`, `MAISTER_MAX_CONCURRENT_RUNS`,
`MAISTER_KEEPALIVE_MINUTES`): [Configuration](configuration.md).

### Local destructive reset

This repository currently has only local/disposable MAIster installs. For
platform ACP runner schema changes, it is acceptable to reset every
MAIster-owned local artifact and re-bootstrap from scratch.

The reset boundary is deliberately narrow:

- Stop web and supervisor processes.
- Drop/recreate the MAIster Postgres database.
- Remove MAIster runtime artifacts under `.maister/` roots created by the app.
- Remove MAIster cache directories for Flow packages and capability imports.
- Remove stale MAIster-created worktrees.
- Remove generated platform runtime config files that the old schema cannot
  consume.
- Run migrations and seed again; seed recreates default platform runners,
  sidecars, admin/bootstrap rows, and sample data.
- Re-register projects.

The reset must not delete arbitrary source repositories. Removing a project
repo is a separate explicit operator action, not part of "blast MAIster-owned
state".

The project-local reset command is dry-run unless the confirmation token is
passed:

```bash
pnpm local:blast-maister-state
pnpm local:blast-maister-state -- --confirm BLAST_MAISTER_LOCAL_STATE
pnpm local:blast-maister-state -- --confirm BLAST_MAISTER_LOCAL_STATE --reset-postgres
pnpm --filter maister-web db:migrate
pnpm --filter maister-web db:seed
```

`--reset-postgres` uses `DB_URL` and resets only the `public` schema. It
refuses a missing, malformed, or non-Postgres URL before deleting any local
state or invoking `psql`.
The script prints every root it will remove and refuses to delete the MAIster
repository cwd or `MAISTER_REPOS_ROOT`.

## Authentication setup

MAIster requires `AUTH_SECRET` to start. Generate one and add it to
`web/.env.local` (the quickstart script does this for you):

```bash
openssl rand -base64 33   # paste the output as AUTH_SECRET=
```

The seed script (`pnpm db:seed`) creates the initial admin user. Defaults
are `SEED_ADMIN_EMAIL=admin@maister.local` and
`SEED_ADMIN_PASSWORD=maister-admin`. Override both in `web/.env.local` before
any shared use:

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
in, navigate to `/projects/new`, paste the absolute path to a repository
directory, and submit. If the directory has no manifest, the server bootstraps a
minimal `maister.yaml`; otherwise it validates the existing file. It then installs
referenced Flow plugins and creates the project row. You
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

## Install a multi-flow package (ADR-088)

A package (`maister-package.yaml` + flows + capability bundle) installs as
ONE import — every member flow and the bundle share the package's resolved
revision:

```bash
DB_URL=postgres://maister:maister@localhost:5432/maister \
  pnpm --filter maister-web install-package \
    --project maister-dev \
    --source /abs/path/to/maister-plugins \
    --version aif/v2.0.0 \
    --path packages/aif
```

Declaratively the same import is one `packages[]` entry in `maister.yaml`
(see `docs/configuration.md`); the platform catalog flow (add source →
refresh → install → attach) lives on `/settings` and the project packages
tab.

Full pipeline reference: [Flow Installer](flow-installer.md).

## Author a portable Flow package

The `/flows` section manages authored Flow drafts and installed executable
packages in one place. Authored packages are inert until explicitly installed
through the trust-gated Flow package lifecycle. A portable package directory
contains `flow.yaml` plus optional files such as `README.md`, `setup.sh`,
`schemas/*`, `skills/*`, `rules/*`, `agents/*`, `scripts/*`, and `templates/*`.

Validate the canonical AIF package without touching the database:

```bash
pnpm --filter maister-web validate-authored-flow \
  --source-dir ../../maister-plugins/packages/aif/flows/dev
```

Import it as a project-scoped authored draft:

```bash
DB_URL=postgres://maister:maister@localhost:5432/maister \
  pnpm --filter maister-web import-flow-package-draft \
    --project maister-dev \
    --source-dir ../../maister-plugins/packages/aif/flows/dev
```

Export a valid authored Flow by capability id or package slug. Export writes a
new directory via temp + rename, refuses invalid package bodies, and does not
run `setup.sh`, mutate `flow_revisions`, enable a project attachment, or launch
anything:

```bash
DB_URL=postgres://maister:maister@localhost:5432/maister \
  pnpm --filter maister-web export-authored-flow \
    --project maister-dev \
    --slug aif \
    --output-dir /tmp/maister-aif-flow
```

To bridge an exported package into the executable package lifecycle, install
the exported directory as an explicitly untrusted package revision:

```bash
DB_URL=postgres://maister:maister@localhost:5432/maister \
  pnpm --filter maister-web install-authored-flow-package \
    --project maister-dev \
    --source-dir /tmp/maister-aif-flow \
    --version authored-aif-local \
    --flow-id aif
```

This creates or selects the installed revision and leaves it `Installed` /
`untrusted`; use the existing Flow package trust and enable UI/API to run
`setup.sh` and enable it.

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

Optional body field: `runnerId`. Runtime resolution is fail-closed:
`launch override → AI-coding step target → project Flow default → platform
Flow default → project default → platform default`. The run snapshots
`runnerId`, `runnerResolutionTier`, `capabilityAgent`, and `runnerSnapshot`
before creating the workspace.

### Anthropic-compatible provider routing

Configure third-party Anthropic-compatible providers directly on the runner.
Secret values remain supervisor environment references:

```yaml
platform:
  default_runner: claude-glm
acp_runners:
  - id: claude-glm
    adapter: claude
    model: glm-5.1
    provider:
      kind: anthropic_compatible
      base_url: https://api.z.ai/api/anthropic
      auth_token: env:ZAI_API_KEY
    permission_policy: default
```

Set `ZAI_API_KEY` in the supervisor environment. MAIster resolves the env ref
at launch and passes the resulting provider environment only to the adapter.

**Via the dev CLI** (operates against an already-Pending run):

```bash
DB_URL=postgres://maister:maister@localhost:5432/maister \
  pnpm --filter maister-web run-flow --task <task-uuid>
```

Behavior:

- The Route Handler creates the workspace + run rows, runs `git
worktree add`, claims a global concurrency slot
  (`MAISTER_MAX_CONCURRENT_RUNS`, default 6), then kicks off the runner
  in the background.
- The runner traverses the validated `flow.manifest.nodes[]` graph, persists
  append-only attempts to `node_attempts`, and drives `runs.status` through
  `Running ↔ NeedsInput → Review | Failed`.
- AI coding nodes proxy to the supervisor at
  `POST /sessions` + `POST /sessions/:id/prompt` (see
  [Supervisor](supervisor.md)).
- Form and human-review nodes suspend the run with `NeedsInput`, writing
  a `hitl_requests` row. The response route writes
  `input-<stepId>.json` and the runner resumes from that durable input.

Full DSL reference: [Flow DSL](flow-dsl.md). Bundled plugin walkthrough:
[aif plugin](flow-aif-plugin.md).

## Scheduler cron

The unified scheduler clock is exposed at `GET`/`POST /api/cron/tick`
(Implemented). Point external cron there in production. The route is
stateless: every tick claims due jobs atomically, runs bounded handlers, and
records attempt results. Set `MAISTER_CRON_TOKEN` to a secret and pass it in the
`X-Maister-Cron-Token` header:

```bash
curl -H "X-Maister-Cron-Token: $MAISTER_CRON_TOKEN" \
  http://localhost:3000/api/cron/tick
```

An empty `MAISTER_CRON_TOKEN` disables cron routes (`503 cron disabled`); a wrong
token returns `401`. On success `/api/cron/tick` returns `200` with a scheduler
summary, or `207` if a claimed attempt failed/skipped. The token is a
server-only secret — never commit a real value or log it.

`GET`/`POST /api/cron/gc` remains a compatibility route for the original GC
contract (ADR-033..036).
It delegates to the scheduler `system_sweep` service while preserving the old
GC summary shape and `200`/`207` behavior. Single-box deployments may enable the
fallback timer with `MAISTER_SCHEDULER_TIMER_ENABLED=true`, but external cron is
the preferred production clock.

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
- **Moving `MAISTER_WORKTREES_ROOT` without `MAISTER_WORKSPACE_ROOTS`**
  (ADR-166) — the supervisor only adopts worktrees under its
  configured roots; a moved web root that is not mirrored fails every launch
  at adoption with `PRECONDITION workspace_rejected`. Mirror both in
  `supervisor/.env`.
- **Copying `.maister/execution-host/` between machines** (ADR-166) — a
  `MAISTER_EXECUTION_HOST_KEY` pin that differs from the copied
  `state.sqlite` refuses boot. Unset the pin or wipe the directory; never
  point two supervisors at one state dir.
- **Upgrading to the execution-host contract with live runs** (ADR-166) — the
  supervisor's pre-ADR-166 sessions die with the old process and nothing
  backfills them: restart the supervisor first (drain recommended); in-flight
  runs follow the supervisor-restart semantics — see
  [deployment.md §11](deployment.md#11-updates).

## See Also

- [Database Schema](database-schema.md) — 8 tables, FK cascade chain,
  Drizzle workflow
- [Error Taxonomy](error-taxonomy.md) — `MaisterError` codes and when
  each one fires
- [Configuration](configuration.md) — `maister.yaml` v2 + `flow.yaml`
  v1 + every env var
- [Vision](VISION.md) — product spine and validation goal
- [Architecture](architecture.md) — folder structure,
  dependency rules, code examples
- [Agent Map](../AGENTS.md) — structural map for AI agents
