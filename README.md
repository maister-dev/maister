# MAIster

> The control plane for AI-powered software delivery.

MAIster turns backlog tasks into supervised agentic delivery Flows: workspace
creation, headless agent execution, HITL, AI-Judge, diff review, merge, and
project learning. The POC is a thin Web shell over a CLI-Flow runner with a
**multi-project portfolio**, multi-workspace, HITL, and a **per-project task
board** — it orchestrates existing Flow frameworks (`aif`), it does not build
a new Flow runner.

## Quick Start

```bash
git clone <repo-url> mAIster
cd mAIster
pre-commit install        # writes .git/hooks/pre-commit
cd web && pnpm install
pnpm dev                  # http://localhost:3000
```

Backend (Drizzle/Postgres, subprocess runner, `.maister/` artifacts) is not
yet scaffolded — only the web slice exists. Build server-side pieces inside
`web/` (Route Handlers + Server Actions), not as a separate process.

## Key Features (POC scope)

- **Multi-project registry** — N projects per host, each configured by its
  own `maister.yaml` v1. Registration via UI form or
  `MAISTER_PROJECTS_DIR` env auto-discovery.
- **Portfolio home (superset.sh-style)** — single grid of every active
  workspace across all projects, with filters by project + status.
- **Per-project task board** — 2 columns `Backlog | In Flight`. A Backlog
  card has a **Launch** button (no drag-and-drop in POC); click creates a
  Run. **task ↔ run is 1:N** — a failed/abandoned run returns the task to
  Backlog so Launch can fire attempt N+1 (ralph-loop friendly).
- **Backlog → Flow launch** — task created with title + prompt + Flow
  dropdown (from project's `flows[]`).
- **Workspace per run** — `git worktree add` with precondition checks
  (clean parent repo, branch free, worktree path free), isolated under
  `.maister/<project-slug>/runs/<run-id>/`.
- **Block-based HITL** — one subprocess per Flow block; UI form rendered
  from `response_schema` on `needs-input.json`; resumed via
  `--resume <block-id>` with no live process across the wait.
- **Live log streaming** — SSE via Route Handler, one message per stdout
  line, `lastEventId` reconnect, piped to disk in parallel.
- **Diff + merge** — raw `git diff` rendered as `<pre>`, `git merge --no-ff`
  on the parent's `main_branch`; conflicts abort to manual resolve.
- **Crash recovery** — startup reconciles the `runs` table against
  `git worktree list` per project; orphaned `Running` rows become `Crashed`.
- **Concurrency** — global cap `MAISTER_MAX_CONCURRENT_RUNS=3` across all
  projects; runs above the cap queue with a position badge.
- **Typed errors** — `MaisterError` with a discriminated `code`; UI branches
  on `code`, never on string matching.

## Stack

- Next.js 16 (App Router) · React 19 · TypeScript 5 (strict)
- HeroUI v3 · Tailwind CSS 4 · `tailwind-variants` · `next-themes`
- Drizzle ORM · Postgres 16 (SQLite via dialect switch for ultra-light dev)
- Node `child_process.spawn` · `uv run` for the Python Flow bridge
- vitest · Playwright · pnpm · Node 24

## Example

```bash
# Configure a project (one maister.yaml per repo)
cat > /repos/myapp/maister.yaml <<EOF
schemaVersion: 1
project:
  name: myapp
  repo_path: /repos/myapp
  main_branch: main
  branch_prefix: maister/
flows:
  - id: bugfix
    name: Bugfix
    command: uv run aif run --task '{prompt}' --flow bugfix --workspace '{workspace_path}'
  - id: feature
    name: Small feature
    command: uv run aif run --task '{prompt}' --flow feature --workspace '{workspace_path}'
EOF

# Launch the Web UI, register the project, create a task on the board
cd web && pnpm dev
open http://localhost:3000
```

---

## Documentation

| Guide | Description |
| ----- | ----------- |
| [Getting Started](docs/getting-started.md) | Install, dev workflow, first run |
| [Vision](docs/VISION.md) | One-liner, product spine, principles, MVP goal |
| [Product View](docs/PRODUCT_VIEW.md) | Lean Canvas, JTBD, gaps, MVP / Phase 2 / Later |
| [Design (Locked)](docs/kaa-maister-design-20260522-174429.md) | Stack rationale, HITL protocol, success criteria, reviewer concerns |
| [Eng Review Test Plan](docs/kaa-maister-eng-review-test-plan-20260522-180855.md) | Routes, key interactions, edge cases, critical paths |
| [Architecture](.ai-factory/ARCHITECTURE.md) | Architecture pattern, folder structure, dependency rules |
| [Project Spec](.ai-factory/DESCRIPTION.md) | Full project specification |
| [Agent Map](AGENTS.md) | Structural map for AI agents and new contributors |

## AI Context

This repo is set up for AI-assisted development. See `CLAUDE.md` (root) and
`web/CLAUDE.md` for locked architectural decisions and conventions, and
`.ai-factory/rules/` for area-specific rules (base, frontend, backend,
database).

## License

MIT — see [LICENSE](LICENSE).
