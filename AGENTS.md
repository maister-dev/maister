# AGENTS.md

> Structural map for AI agents and new contributors. Read this file first to
> orient yourself, then drill into the referenced documents.
>
> Maintained by `/aif`. Update when the project structure changes
> significantly. The Documentation section is maintained by `/aif-docs`.

## Project Overview

**MAIster is the control plane for AI-powered software delivery.** Current
wedge: Web control plane + ACP supervisor + Flow plugin engine with
multi-project portfolio, multi-workspace execution, HITL, and a per-project
task board (Backlog | In Flight). Wraps existing agents and Flow frameworks.

Full description: `.ai-factory/DESCRIPTION.md`.

## Tech Stack

- **Framework:** Next.js 16.2 (App Router)
- **Language:** TypeScript 5.6 (strict)
- **UI library:** HeroUI v3 (`@heroui/react` 3.0.4)
- **Styling:** Tailwind CSS 4 + `tailwind-variants`
- **Database:** Postgres 16 via Drizzle ORM (SQLite for ultra-light dev via
  Drizzle dialect switch)
- **Supervisor daemon (`supervisor/`):** Fastify 5 + pino + zod; ACP via
  `@agentclientprotocol/sdk@0.22.1` spawning `claude-agent-acp@0.37.0`,
  `codex-acp@0.0.44`, and readiness-gated `gemini --acp`, `opencode acp`,
  and `mimo acp` adapter binaries
- **Tests:** vitest (unit + integration), Playwright (E2E)
- **Package manager:** pnpm (monorepo workspace: `web` + `supervisor`)
- **Node:** 24

## Project Structure

```
mAIster/
├── .ai-factory/                # AI Factory project context
│   ├── config.yaml             # AI Factory configuration (language, paths, git)
│   ├── DESCRIPTION.md          # Project specification
│   ├── ARCHITECTURE.md         # Architecture pattern, folder structure, deps
│   ├── ROADMAP.md              # Roadmap and completed work
│   ├── plans/                  # Full-mode /aif-plan output, branch-keyed
│   └── rules/                  # Project conventions for AI agents
│       ├── base.md             # Project-wide rules
│       ├── frontend.md         # Web-tier rules (HeroUI, RSC, lint)
│       ├── backend.md          # Server-tier rules (subprocess, SSE, errors)
│       └── database.md         # Drizzle / Postgres rules
├── .agents/                    # Codex agent bundles (do not hand-edit)
├── .claude/                    # Claude skills + agents (managed via /aif)
├── .codex/                     # Codex skills + config.toml
├── .mcp.json                   # MCP servers: github, filesystem, postgres,
│                               #              chromeDevtools, playwright
├── .ai-factory.json            # AI Factory installed-skills registry
├── .pre-commit-config.yaml     # Pre-commit hooks: lint/typecheck/prettier (web + supervisor)
├── pnpm-workspace.yaml         # Monorepo workspace: web + supervisor
├── pnpm-lock.yaml              # Frozen lockfile (root)
├── Dockerfile                  # Single image; web/supervisor selected via command:
├── compose.yml                 # Base: app + supervisor + postgres
├── compose.production.yml      # Prod hardening: read_only, cap_drop, tmpfs
├── docs/                       # Product & engineering documentation
│   ├── VISION.md
│   ├── PRODUCT_VIEW.md
│   ├── supervisor.md           # HTTP+SSE API, lifecycle, cost.jsonl
│   ├── configuration.md
│   ├── database-schema.md
│   ├── error-taxonomy.md
│   ├── getting-started.md
│   ├── architecture.md
│   ├── decisions.md
│   ├── api/
│   ├── db/
│   └── system-analytics/
├── supervisor/                 # ── ACP SUPERVISOR DAEMON ──
│   ├── src/
│   │   ├── main.ts             # Fastify boot + graceful shutdown
│   │   ├── http-api.ts         # 6 routes (POST/DELETE/GET /sessions, SSE, checkpoint/input stubs)
│   │   ├── spawn.ts            # child_process dispatch (claude-agent-acp | codex-acp)
│   │   ├── heartbeat.ts        # exit/error → session.exited/crashed + orphan watcher
│   │   ├── cost.ts             # cache_creation/input/output tokens → cost.jsonl
│   │   ├── registry.ts         # In-memory SessionRecord map + per-session event ring buffer
│   │   ├── types.ts            # Zod schemas + SessionEvent union + SupervisorError
│   │   └── __tests__/          # 30 unit + 9 integration tests
│   ├── test/fixtures/
│   │   └── fake-acp.mjs        # Stand-in for the real ACP binary in tests
│   ├── package.json            # @maister/supervisor; tsx runtime
│   ├── tsconfig.json
│   ├── vitest.workspace.ts     # unit | integration split
│   └── eslint.config.mjs
├── web/                        # ── NEXT.JS WEB TIER ──
│   ├── app/                    # App Router (layout, pages, api/, server actions)
│   ├── components/             # HeroUI-based React components
│   ├── config/                 # Site config (navItems), fonts
│   ├── lib/                    # Server-only modules (errors, atomic, config, db, supervisor-client)
│   ├── i18n/                   # EN + RU translations (required from day one)
│   ├── styles/                 # globals.css (Tailwind 4 + HeroUI styles)
│   ├── types/                  # Shared TS types
│   ├── public/                 # Static assets
│   ├── CLAUDE.md               # Web slice conventions — READ THIS
│   ├── package.json            # Dependencies, scripts (dev/build/start/lint)
│   ├── tsconfig.json           # strict, @/* path alias
│   ├── next.config.mjs
│   ├── eslint.config.mjs       # ESLint 9 flat config
│   └── postcss.config.mjs      # @tailwindcss/postcss
├── CLAUDE.md                   # Root project instructions for AI agents
├── AGENTS.md                   # This file
├── README.md                   # Landing page: quick start, docs index
├── .env.example                # Server env vars (web + supervisor)
├── .dockerignore
├── LICENSE                     # MIT
└── .gitignore
```

Two Node processes: `web/` (Next.js — UI + Route Handlers + server actions
+ Drizzle DB access + SSE bridge) and `supervisor/` (Fastify daemon —
owns ACP sessions and spawns agent processes). They communicate over
HTTP+SSE through `web/lib/supervisor-client.ts`; the supervisor can run
on a different host than the web tier.

## Key Entry Points

| File | Purpose |
| ---- | ------- |
| `web/app/layout.tsx` | Root layout: Providers + Navbar + container |
| `web/app/page.tsx` | Home page (template stub — to replace with portfolio grid) |
| `web/app/providers.tsx` | next-themes ThemeProvider wrapper |
| `web/app/error.tsx` | Root error boundary |
| `web/lib/supervisor-client.ts` | The ONLY place `web/` talks to `supervisor/` (HTTP+SSE) |
| `web/lib/errors.ts` | `MaisterError` discriminated union (11 codes) |
| `web/lib/db/schema.ts` | Drizzle schema: 8 tables (projects, executors, flows, tasks, runs, workspaces, step_runs, hitl_requests) |
| `web/lib/config.ts` | `maister.yaml` v2 loader (zod-validated) |
| `supervisor/src/main.ts` | Supervisor daemon entrypoint (Fastify on `:7777`) |
| `supervisor/src/http-api.ts` | Six HTTP routes + SSE bridge |
| `supervisor/src/spawn.ts` | `child_process.spawn` dispatcher (claude-agent-acp / codex-acp) |
| `supervisor/package.json` | `@maister/supervisor`; scripts: `dev`, `start`, `test:unit`, `test:integration` |
| `pnpm-workspace.yaml` | Monorepo: `web` + `supervisor` |
| `.mcp.json` | MCP server configuration |

## Documentation

| Document | Path | Description |
| -------- | ---- | ----------- |
| README | `README.md` | Landing page: quick start, key features, docs table |
| Getting Started | `docs/getting-started.md` | Install, dev workflow, first run |
| Supervisor | `docs/supervisor.md` | ACP daemon: HTTP+SSE API, lifecycle, env vars, cost.jsonl |
| Database Schema | `docs/database-schema.md` | 8 tables, FK cascade chain, indexes, Drizzle workflow |
| Error Taxonomy | `docs/error-taxonomy.md` | `MaisterError` codes — when each fires, what the UI does |
| Configuration | `docs/configuration.md` | `maister.yaml` v2 + `flow.yaml` v1 + `form_schema` versioning + env vars |
| Vision | `docs/VISION.md` | One-liner, product spine, principles, MVP goal |
| Product View | `docs/PRODUCT_VIEW.md` | Lean Canvas, JTBD, gaps, MVP / Phase 2 / Later |
| Architecture | `docs/architecture.md` | Current system architecture, C4 diagrams, data flows |
| Decisions | `docs/decisions.md` | ADRs and locked technical decisions |
| System Analytics | `docs/system-analytics/` | Domain flows for projects, runs, HITL, executors, Flow DSL |
| API Contracts | `docs/api/` | Web/supervisor OpenAPI and SSE AsyncAPI contracts |
| README (web) | `web/README.md` | HeroUI template README — replace when something to say |

## AI Context Files

| File | Purpose |
| ---- | ------- |
| `AGENTS.md` | This file — structural map for AI agents and new contributors |
| `CLAUDE.md` | Root project instructions: product spine, locked architectural decisions, conventions |
| `web/CLAUDE.md` | Web/Next.js slice: stack details, scripts, structure, HeroUI conventions |
| `.ai-factory/DESCRIPTION.md` | Project specification synthesized from product docs |
| `.ai-factory/ARCHITECTURE.md` | Architecture pattern, folder structure, dependency rules, code examples |
| `.ai-factory/config.yaml` | AI Factory configuration (language, paths, git settings) |
| `.ai-factory/ROADMAP.md` | Roadmap and completed work |
| `.ai-factory/rules/base.md` | Project-wide conventions extracted from CLAUDE.md files |
| `.ai-factory/rules/frontend.md` | Web-tier rules (HeroUI, RSC, lint) |
| `.ai-factory/rules/backend.md` | Server-tier rules (supervisor, SSE, errors, concurrency) |
| `.ai-factory/rules/database.md` | Drizzle / Postgres rules |

When this file disagrees with `CLAUDE.md` or `docs/`, those win — update
this file.

## Agent Rules

- **Decompose shell commands** — run each command separately, not chained,
  so failures surface clearly and approvals stay scoped.
  - Wrong (combined): `git checkout main && git pull`
  - Right (decomposed): first `git checkout main`, then
    `git pull origin main`
- **Read `CLAUDE.md` and `web/CLAUDE.md` first** before touching any code.
  Both files encode product spine, current implementation boundaries, and
  project conventions.
- **Surgical changes only** — every changed line must trace directly to the
  user's request. Do not refactor adjacent code while you're there.
- **Throw `MaisterError` with `code`** for known domain failures. Never use
  plain `Error` for domain errors. UI branches on `code`, never on string
  matching.
- **Atomic writes to `.maister/`** — always tmp + rename via
  `atomicWriteJson`. The Flow may read mid-write otherwise.
- **No `chokidar` / `fs.watch` / polling.** State transitions are driven
  by ACP notifications (live path) plus artifact presence (recovery path);
  process exit codes feed the heartbeat-promoted crash event.
- **Agent processes live in `supervisor/`, not `web/`.** The web tier
  reaches the supervisor through `web/lib/supervisor-client.ts` only.
  ACP sessions are held live across permission HITL; designed checkpoint
  resume uses the same `acp_session_id` handle.
- **Scope labels are descriptive, not blockers** — use docs labels
  (`Implemented`, `Designed`, `Phase 2`) to explain trade-offs. Do not
  block useful work solely because an old planning note called it out of
  scope.
