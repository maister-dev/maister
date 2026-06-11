# MAIster

> The control plane for AI-powered software delivery.

MAIster turns backlog tasks into supervised delivery Flows: workspace creation,
ACP-driven agent execution, HITL, evidence-backed review, and branch-targeted
promotion. It is a Web control plane plus a separate ACP supervisor daemon. It
wraps existing agents and Flow plugins; it does not replace Claude Code, Codex,
or AI Factory.

## Quick Start

```bash
git clone <repo-url> mAIster
cd mAIster
pre-commit install                                # writes .git/hooks/pre-commit
pnpm install --frozen-lockfile                    # monorepo root install

# Run web + supervisor + postgres via compose (recommended):
docker compose up -d
docker compose logs -f                            # http://localhost:3000

# Or run the pieces standalone (two terminals):
pnpm --filter maister-web dev                     # http://localhost:3000
pnpm --filter @maister/supervisor dev             # http://localhost:7777
```

The repo is a pnpm monorepo (`web/` + `supervisor/`). The web tier is
Next.js 16 (Drizzle schema, error taxonomy, `maister.yaml` v2 loader);
the supervisor is the separate Node daemon that owns ACP sessions and
agent processes. See [Supervisor](docs/supervisor.md) for the wire
contract and [Architecture](docs/architecture.md) for the boundary rules.

## Key Features

- **Multi-project registry** — N projects per host, each configured by its
  own `maister.yaml` v2: project metadata, project runner defaults, and pinned
  Flow plugins.
- **Portfolio home (superset.sh-style)** — single grid of every active
  workspace across all projects, with filters by project + status.
- **Per-project task board** — Kanban-styled (7 derived columns
  `Backlog · Prepare · InProduction · OnReview · InDelivery · Crashed · Done`
  over a 4-value task state; no drag-and-drop / WIP limits yet). A Backlog
  card's **Launch** creates a Run. **task ↔ run is 1:N** — a failed/abandoned
  run returns the task to Backlog so Launch can fire attempt N+1 (ralph-loop
  friendly).
- **Backlog → Flow launch** — task created with title + prompt + Flow
  dropdown and optional platform runner override.
- **Workspace per run** — `git worktree add` with precondition checks
  (clean parent repo, branch free, worktree path free), isolated under
  `.maister/<project-slug>/runs/<run-id>/`.
- **Platform ACP runners** — Claude, Codex, Gemini CLI, and OpenCode runner
  families are configured at the platform layer, with project/Flow inheritance,
  CCR sidecars for Claude routing, and readiness-gated launch diagnostics.
- **Hybrid HITL** — ACP permission requests become durable HITL rows;
  structured form and human-review responses use atomic input artifacts and
  runner-owned resume.
- **Live run streaming** — supervisor writes per-step logs and
  `run.events.jsonl`; the web SSE bridge replays durable events with
  `Last-Event-ID`.
- **Diff + promotion** — server-rendered Shiki diff (split/inline, per-file
  +/-) in the workbench, then promote the run branch to a selected target
  branch by local merge or pull request. `local_merge` uses
  `git merge --no-ff`; conflicts abort to manual resolve.
- **Crash recovery** — startup reconciles the `runs` table against
  `git worktree list` per project; orphaned `Running` rows become `Crashed`.
- **Concurrency** — global cap `MAISTER_MAX_CONCURRENT_RUNS=3` across all
  projects; runs above the cap queue with a position badge.
- **Typed errors** — `MaisterError` with a discriminated `code`; UI branches
  on `code`, never on string matching.
- **Graph flow engine** — typed-node graph (`ai_coding/judge/cli/check/human`)
  with named transitions, bounded rework, six gate kinds, typed artifacts and
  a promotion-time readiness gate, over a `node_attempts` ledger.
- **Flow Studio** — in-app visual graph editor + authored catalog
  (draft→publish, content-addressed) for rules / skills / flows.
- **Capabilities & MCP** — per-session `settings.local.json` + MCP
  materialization with two-axis trust; platform + project MCP / runner catalogs.
- **Manual takeover & workbench lifecycle** — claim a run, edit the worktree
  locally, return for re-validation; plus stop / archive / drop / export /
  handoff-branch.
- **Scratch runs** — ad-hoc conversational agent sessions in a managed
  worktree, off the task board.
- **Observatory** — read-only Autonomy Score, correction-rate, and signal
  clusters over the run ledgers.
- **External API** — scoped project tokens + `/api/v1/ext/*` + an MCP facade
  (incl. HITL-over-MCP).

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
