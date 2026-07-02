# MAIster

> The control plane for AI-powered software delivery.

## What MAIster does

Running several coding agents by hand is operational noise: many terminals,
lost context, unclear progress, scattered artifacts, weak review, and the same
project mistakes repeated. MAIster is the control plane that turns that into
supervised delivery — it wraps existing coding agents (Claude Code, Codex, …)
and Flow plugins rather than replacing them.

**Challenges it answers**

- **Console babysitting** → one portfolio, board, and "needs-you" inbox across every project.
- **Unrepeatable runs** → versioned, trust-gated Flow packages, pinned to the exact revision a run used.
- **"Did the AI do it right?"** → typed evidence gates + a readiness summary that blocks promotion until proof passes.
- **Agents overreaching** → per-session capability materialization, guardrail hooks at the ACP seam, and read-only enforcement.
- **One agent isn't enough** → orchestrated run-trees, a persistent swarm, and consensus nodes that verify a plan before it runs.
- **Runaway cost/time** → token budgets with a warn → escalate → terminate ladder.
- **"When do I step in?"** → Flow-declared HITL, role-owned ownership, and local manual takeover with full audit.
- **Landing work safely** → branch-targeted promotion (PR or local merge), only after gates pass.

**Core functions**

1. **Portfolio & board control plane** — multi-project, active workspaces, HITL inbox.
2. **Flow packages** — install / trust / version / upgrade / rollback, pinned per run.
3. **Graph Flow engine** — typed nodes, gates, bounded rework, dynamic routing, consensus.
4. **Workspaces** — worktree isolation, scratch sessions, manual takeover, promotion.
5. **Capability & guardrail safety** — scoped materialization, ACP-seam hooks, read-only enforcement.
6. **Orchestration & agents** — governed run-trees, swarm, package-based platform agents, triggers.
7. **Evidence & governance** — typed artifacts, readiness, cost budgets, audit, external API/MCP facade.

**Top tasks** — see portfolio & what needs you · launch a controlled run from a
task (or a scratch session) · constrain what a node or agent may touch · answer
HITL, take over locally, steer rework · inspect readiness evidence & diff ·
promote to the target branch.

## Quick Start

```bash
git clone <repo-url> mAIster
cd mAIster
pre-commit install                                # writes .git/hooks/pre-commit
pnpm install --frozen-lockfile                    # monorepo root install
cp .env.example .env                              # then fill in DB_URL etc.

docker compose up -d                              # Postgres only (pgvector/pgvector:pg16)
pnpm --filter maister-web db:migrate              # main migration lineage
pnpm --filter maister-web db:migrate:brain        # Project-Brain lineage (ADR-122); no-op on SQLite
pnpm --filter maister-web db:seed                 # admin user + dev seed

# web + supervisor run on the HOST (ADR-023 — they spawn agent CLIs), two terminals:
pnpm --filter maister-web dev                     # http://localhost:3000
pnpm --filter @maister/supervisor dev             # http://localhost:7777
```

The repo is a pnpm monorepo (`web/` + `supervisor/`). The web tier is
Next.js 16 (Drizzle schema, error taxonomy, `maister.yaml` v2 loader);
the supervisor is the separate Node daemon that owns ACP sessions and
agent processes. See [Supervisor](docs/supervisor.md) for the wire
contract and [Architecture](docs/architecture.md) for the boundary rules.

## Stack

- Next.js 16 (App Router) · React 19 · TypeScript 5 (strict)
- HeroUI v3 · Tailwind CSS 4 · `tailwind-variants` · `next-themes`
- Drizzle ORM · Postgres 16 (SQLite via dialect switch for ultra-light dev)
- Fastify supervisor · ACP adapter binaries · optional CCR router
- vitest · Playwright · pnpm · Node 24

## Example

```bash
# Configure a project (one maister.yaml per repo)
cat > /repos/myapp/maister.yaml <<EOF
schemaVersion: 2
project:
  name: myapp
  repo_path: /repos/myapp
  default_branch: main
  branch_prefix: maister/
  default_runner: claude-code
flows:
  - id: bugfix
    source: github.com/org/maister-flow-bugfix
    version: v1.2.3
    runner: claude-code
EOF

# Launch the services, register the project, create a task on the board
pnpm --filter @maister/supervisor dev
pnpm --filter maister-web dev
```

Full manifest reference: [Configuration](docs/configuration.md).

---

## Documentation

| Guide | Description |
| ----- | ----------- |
| [Getting Started](docs/getting-started.md) | Install, dev workflow, first run |
| [Supervisor](docs/supervisor.md) | ACP daemon: HTTP+SSE API, lifecycle, env vars, cost.jsonl |
| [Database Schema](docs/database-schema.md) | Drizzle/Postgres tables, FK cascade chain, indexes |
| [Error Taxonomy](docs/error-taxonomy.md) | `MaisterError` codes — when each fires, what the UI does |
| [Configuration](docs/configuration.md) | `maister.yaml` v2 + `flow.yaml` v1 + `form_schema` versioning + env vars |
| [Flow Installer](docs/flow-installer.md) | `installFlowPlugin()` pipeline, system cache, symlink, DB upsert, ops CLI |
| [Flow DSL](docs/flow-dsl.md) | Flow graph DSL (+ legacy step DSL) and runner behavior |
| [AIF Flow Plugin](docs/flow-aif-plugin.md) | Bundled `aif` Flow plugin walkthrough |
| [Flow Studio](docs/system-analytics/flow-studio.md) | In-app flow authoring + visual graph editor |
| [Observatory](docs/system-analytics/observatory.md) | Autonomy Score, correction-rate, signal clusters |
| [Vision](docs/VISION.md) | One-liner, product spine, principles, MVP goal |
| [Product View](docs/PRODUCT_VIEW.md) | Target user, JTBD, current scope, Phase 2 |
| [Architecture](docs/architecture.md) | C4 views, component map, data flows |
| [Decisions](docs/decisions.md) | ADRs and locked technical choices |
| [System Analytics](docs/system-analytics/README.md) | Domain state machines and process flows |
| [Screens Reference](docs/screens/README.md) | User-facing screens and shared chrome |
| [Database ERDs](docs/db/README.md) | Mermaid ERDs by domain |
| [API: Web](docs/api/web.openapi.yaml) | Web Route Handler contract |
| [API: Supervisor](docs/api/supervisor.openapi.yaml) | Supervisor HTTP contract |
| [Events: Web Run SSE](docs/api/async/web-runs.asyncapi.yaml) | Browser-facing run event stream |
| [Events: Supervisor SSE](docs/api/async/supervisor-sse.asyncapi.yaml) | Supervisor session event stream |
| [External API References](docs/api/external/README.md) | ACP and transitive provider references |
| [Docs Rules](docs/CLAUDE.md) | Documentation structure and validation rules |
| [Project Spec](.ai-factory/DESCRIPTION.md) | Full project specification |
| [Agent Map](AGENTS.md) | Structural map for AI agents and new contributors |

## AI Context

This repo is set up for AI-assisted development. See `CLAUDE.md` (root) and
`web/CLAUDE.md` for locked architectural decisions and conventions, and
`.ai-factory/rules/` for area-specific rules (base, frontend, backend,
database).

## License

MIT — see [LICENSE](LICENSE).
