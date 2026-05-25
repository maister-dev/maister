# AGENTS.md

> Structural map for AI agents and new contributors. Read this file first to
> orient yourself, then drill into the referenced documents.
>
> Maintained by `/aif`. Update when the project structure changes
> significantly. The Documentation section is maintained by `/aif-docs`.

## Project Overview

**MAIster is the control plane for AI-powered software delivery.** POC wedge:
thin Web shell over a CLI-Flow runner with multi-project portfolio +
multi-workspace + HITL + per-project task board (Backlog | In Flight). Wraps
existing Flow frameworks (`aif`) — does **not** build a new Flow runner.

Full description: `.ai-factory/DESCRIPTION.md`.

## Tech Stack

- **Framework:** Next.js 16.2 (App Router)
- **Language:** TypeScript 5.6 (strict)
- **UI library:** HeroUI v3 (`@heroui/react` 3.0.4)
- **Styling:** Tailwind CSS 4 + `tailwind-variants`
- **Database (planned):** Postgres 16 via Drizzle ORM (SQLite for ultra-light
  dev via Drizzle dialect switch)
- **Subprocess runner (planned):** Node `child_process.spawn` of
  `uv run <flow-cmd>`
- **Tests (planned):** vitest + Playwright
- **Package manager:** pnpm
- **Node:** 24

## Project Structure

```
mAIster/
├── .ai-factory/                # AI Factory project context
│   ├── config.yaml             # AI Factory configuration (language, paths, git)
│   ├── DESCRIPTION.md          # Project specification
│   └── rules/
│       └── base.md             # Project-wide conventions for AI agents
├── .agents/                    # Codex agent bundles (do not hand-edit)
├── .claude/                    # Claude skills + agents (managed via /aif)
├── .codex/                     # Codex skills + config.toml
├── .mcp.json                   # MCP servers: github, filesystem, postgres,
│                               #              chromeDevtools, playwright
├── .ai-factory.json            # AI Factory installed-skills registry
├── docs/                       # Product & engineering documentation
│   ├── VISION.md
│   ├── PRODUCT_VIEW.md
│   ├── kaa-maister-design-20260522-174429.md           # Locked design
│   └── kaa-maister-eng-review-test-plan-20260522-180855.md
├── web/                        # The entire MAIster app (Next.js 16 monolith)
│   ├── app/                    # App Router (layout, pages, api/, server actions)
│   ├── components/             # HeroUI-based React components
│   ├── config/                 # Site config (navItems), fonts
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
├── LICENSE                     # MIT
└── .gitignore                  # Next.js-configured (.next/, node_modules/, .env*.local)
```

Backend (Drizzle, subprocess runner, `.maister/` artifacts) is **not yet
scaffolded** — only the web slice exists. Build server-side pieces inside
`web/` (Route Handlers + server actions), not as a separate process.

## Key Entry Points

| File | Purpose |
| ---- | ------- |
| `web/app/layout.tsx` | Root layout: Providers + Navbar + container |
| `web/app/page.tsx` | Home page (template stub — to replace with run list) |
| `web/app/providers.tsx` | next-themes ThemeProvider wrapper |
| `web/app/error.tsx` | Root error boundary |
| `web/config/site.ts` | Nav items, external links (template content) |
| `web/styles/globals.css` | Tailwind 4 + HeroUI styles import; dark variant |
| `web/package.json` | Scripts: `dev`, `build`, `start`, `lint`; pinned deps |
| `web/tsconfig.json` | strict; `@/*` → `./*` |
| `.mcp.json` | MCP server configuration |

## Documentation

| Document | Path | Description |
| -------- | ---- | ----------- |
| README | `README.md` | Landing page: quick start, key features, docs table |
| Getting Started | `docs/getting-started.md` | Install, dev workflow, first run |
| Database Schema | `docs/database-schema.md` | 7 tables, FK cascade chain, indexes, Drizzle workflow |
| Error Taxonomy | `docs/error-taxonomy.md` | `MaisterError` codes — when each fires, what the UI does |
| Configuration | `docs/configuration.md` | `maister.yaml` v2 + `flow.yaml` v1 + `form_schema` versioning + env vars |
| Vision | `docs/VISION.md` | One-liner, product spine, principles, MVP goal |
| Product View | `docs/PRODUCT_VIEW.md` | Lean Canvas, JTBD, gaps, MVP / Phase 2 / Later |
| Locked Design | `docs/kaa-maister-design-20260522-174429.md` | Stack rationale, HITL protocol, success criteria, reviewer concerns |
| ACP Pivot Revision | `docs/kaa-maister-design-20260525-acp-revision.md` | Multi-executor ACP pivot — what changed and why |
| Eng Review Test Plan | `docs/kaa-maister-eng-review-test-plan-20260522-180855.md` | Routes, key interactions, edge cases, critical paths |
| M0 Spike Findings | `docs/kaa-maister-m0-spike-findings-20260525.md` | ACP library validation + cross-process resume cost |
| README (web) | `web/README.md` | HeroUI template README — replace when something to say |

## AI Context Files

| File | Purpose |
| ---- | ------- |
| `AGENTS.md` | This file — structural map for AI agents and new contributors |
| `CLAUDE.md` | Root project instructions: product spine, locked architectural decisions, conventions, out-of-POC list |
| `web/CLAUDE.md` | Web/Next.js slice: stack details, scripts, structure, HeroUI conventions |
| `.ai-factory/DESCRIPTION.md` | Project specification synthesized from product docs |
| `.ai-factory/ARCHITECTURE.md` | Architecture pattern, folder structure, dependency rules, code examples |
| `.ai-factory/config.yaml` | AI Factory configuration (language, paths, git settings) |
| `.ai-factory/rules/base.md` | Project-wide conventions extracted from CLAUDE.md files |

When this file disagrees with `CLAUDE.md` or `docs/`, those win — update
this file.

## Agent Rules

- **Decompose shell commands** — run each command separately, not chained,
  so failures surface clearly and approvals stay scoped.
  - Wrong (combined): `git checkout main && git pull`
  - Right (decomposed): first `git checkout main`, then
    `git pull origin main`
- **Read `CLAUDE.md` and `web/CLAUDE.md` first** before touching any code.
  Both files encode locked architectural decisions earned in two review
  passes and an explicit "Out of POC scope" list.
- **Surgical changes only** — every changed line must trace directly to the
  user's request. Do not refactor adjacent code while you're there.
- **Throw `MaisterError` with `code`** for known domain failures. Never use
  plain `Error` for domain errors. UI branches on `code`, never on string
  matching.
- **Atomic writes to `.maister/`** — always tmp + rename via
  `atomicWriteJson`. The Flow may read mid-write otherwise.
- **No `chokidar` / `fs.watch` / polling.** Subprocess exit codes drive
  state transitions.
- **One block = one subprocess.** No long-running process held across a
  HITL wait.
- **Out-of-POC push-back** — if a task adds anything from the
  `CLAUDE.md` "Out of POC scope" list, push back and link the design doc.
