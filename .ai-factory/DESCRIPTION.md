# MAIster

## Overview

**MAIster is the control plane for AI-powered software delivery.** It turns
backlog tasks into supervised agentic delivery Flows: workspace creation,
ACP-driven agent execution, structured HITL, diff review, and merge.

Current wedge: a **Web shell + ACP supervisor daemon + Flow plugin engine**
spanning multi-project portfolio + multi-executor (claude + codex) +
multi-workspace + manual scratch workspaces + hybrid HITL + per-project task
board. MAIster orchestrates agents through the Zed-standard Agent Client
Protocol (ACP); Flow plugins shipped as git-tagged bundles compose CLI tools,
agent skills, and YAML-DSL steps. It does **not** build a new agent runtime —
claude and codex are the runtimes; MAIster is the control plane around them.

Audience: solo-technical CEO / CIO / staff-eng running multiple repos and AI
coding agents in parallel and tired of babysitting consoles.

For the full vision, product model, architecture, and roadmap see
`docs/VISION.md`, `docs/PRODUCT_VIEW.md`, `docs/architecture.md`, and
`.ai-factory/ROADMAP.md`.

## Core Features

- **Multi-project registry**: N projects per host, each configured by its own
  `maister.yaml` v2 (`project` + `executors[]` + `flows[]` with version
  pins). Registration via UI form (path to dir containing `maister.yaml`) or
  `MAISTER_PROJECTS_DIR` env **recursive** auto-discovery on startup. Slug
  derived from `project.name` (kebab-case); both `slug` and `repo_path` are
  unique across projects (one repo = one project). Collisions reject the
  registration.
- **Flow plugin engine**: Flows are git-repo plugins pinned by tag, installed
  to `~/.maister/flows/<id>@<tag>/` system cache and symlinked per project.
  Each plugin carries a `flow.yaml` manifest with step DSL (`cli | agent |
  guard | human`), optional `setup.sh`, shipped CLIs, skills, and agents.
- **Multi-executor via ACP**: `claude` and `codex` both required.
  Executor identity = `{agent, model, env?, router?}` defined per project in
  `executors[]`. CCR (Claude Code Router) bundled for `router: ccr` to route
  z.ai GLM / MiniMax through `claude`. Per-step override resolution: run
  launcher -> task override -> project per-flow override -> project
  default -> flow recommended.
- **Portfolio and active workspaces**: project-grouped active workspaces across
  all visible projects. Each group shows project name, active count, a compact
  scratch `+`, and rows with branch/name · status label/dot · kind/executor ·
  launched-by · last activity. "Needs you (N)" badge counts pending HITL across
  all projects.
- **Scratch workspaces**: manual conversation-style coding-agent sessions
  outside the task board. The prompt-first command-box launcher keeps optional
  scratch branch/workspace name, project, base branch, and submit in the main
  composer, with configured executor profile, work mode, reasoning effort,
  metadata/binary attachments, and run-scoped MCP/skill/rule/agent-pack
  capability profile in compact expandable controls. Scratch runs appear in
  project-grouped active workspaces but keep `task_id = NULL`.
- **Per-project task board**: 2 columns `Backlog | In Flight`. In Flight
  holds `Running | NeedsInput | NeedsInputIdle | Review | Crashed`. A
  Backlog card has a **Launch** button; click runs
  preconditions and creates a Run via supervisor `POST /sessions`. A
  dedicated **Inbox** block beside the board lists pending HITL requests
  with in-card form + send-back-with-comments for `human` step type.
  Done/Abandoned in a filter tab.
- **Backlog → Flow launch**: task created on the board with title + prompt +
  Flow dropdown (from project's `flows[]`) + optional executor override.
  **task ↔ run is 1:N** — a failed/abandoned run returns the task to
  `Backlog`, Launch reappears, next click = attempt N+1 (ralph-loop
  friendly).
- **Workspace lifecycle**: `git worktree add` per run under
  `.maister/<project-slug>/runs/<run-id>/`, precondition checks (clean parent
  repo, branch free, worktree path free, global cap not hit, executor
  registered), per-project + supervisor-aware reconciliation on Next.js
  startup, GC of `Abandoned/Done` worktrees + checkpointed sessions older
  than 7d.
- **ACP-driven agent execution**: `supervisor/` daemon (separate Node
  process, HTTP+SSE IPC, may run on a different host) owns ACP sessions.
  One agent process per session. Spawned on Launch; permission HITL is
  resolved live. Checkpoint/idle resume is implemented.
- **Hybrid HITL**: ACP `session/request_permission` for binary approve/deny
  + artifact `input-<stepId>.json` for structured forms (JSON Schema) +
  `human` step type with review comments. `on_reject.goto_step` is
  designed but not executed today.
- **Live log streaming**: supervisor publishes ACP `session/update` →
  per-step log file on disk + SSE stream → Next.js Route Handler bridge
  (`/api/runs/[id]/stream`) with `lastEventId` reconnect.
- **Diff view + merge**: raw `git diff` rendered as `<pre>`,
  `git merge --no-ff` on the parent's `main_branch`.
  Conflicts abort and surface "Conflict — resolve manually" in UI.
- **Concurrency cap**: `MAISTER_MAX_CONCURRENT_RUNS=3`
  (env-configurable, global across projects). Runs above the cap go to
  `Pending`; UI shows queue position; auto-promote on slot free.
- **Typed error taxonomy**: `MaisterError` with discriminated `code`
  (`PRECONDITION | SPAWN | NEEDS_INPUT | HITL_TIMEOUT | CRASH | CONFLICT |
  CONFIG | EXECUTOR_UNAVAILABLE | FLOW_INSTALL | ACP_PROTOCOL |
  CHECKPOINT`). UI branches on `code`, never on string matching.
- **i18n**: EN + RU from day one.

## Tech Stack

| Layer            | Choice                                                            |
| ---------------- | ----------------------------------------------------------------- |
| Framework        | Next.js 16+ App Router (server actions + RSC where it fits)       |
| Language         | TypeScript end-to-end, strict mode                                |
| UI library       | HeroUI v3 (`@heroui/react`), no other component lib               |
| Styling          | Tailwind CSS 4 via `@tailwindcss/postcss`, `tailwind-variants`    |
| Theming          | `next-themes` (default `dark`)                                    |
| i18n             | EN + RU from day one (REQUIRED)                                   |
| Database         | Postgres 16 primary (docker, named volume); SQLite via Drizzle    |
|                  | dialect switch (`DB_URL=file:./dev.db`) for ultra-light dev only  |
| ORM              | Drizzle (SQL-flavored, JOOQ-like). Not Prisma.                    |
| Agent runtime    | ACP hosted by `supervisor/`, via                                  |
|                  | `@agentclientprotocol/claude-agent-acp`,                          |
|                  | `@agentclientprotocol/codex-acp`, and                             |
|                  | `@agentclientprotocol/sdk`.                                       |
|                  | One agent process (`claude`, `codex`) per active session via      |
|                  | Node `child_process.spawn`. Permission HITL resolves live;         |
|                  | checkpoint+respawn via `--resume <session-id>` is implemented.    |
| Model routing    | CCR (Claude Code Router) bundled for `router: ccr` — z.ai GLM,    |
|                  | MiniMax via Anthropic-API-compatible providers.                   |
| Web ↔ supervisor | HTTP + SSE (supervisor may run on a different host)               |
| Flow plugins     | git repos pinned by tag; installed to                             |
|                  | `~/.maister/flows/<id>@<tag>/` and symlinked per project          |
| Git workspaces   | Thin wrapper around `git worktree add/remove/list`                |
| Live updates     | SSE — supervisor publishes ACP `session/update`; Next.js Route    |
|                  | Handler bridges to browser                                        |
| Python           | Optional — only when a specific Flow plugin ships Python CLIs     |
|                  | (no longer required in the base container image).                 |
| Tests            | vitest (unit/integration), Playwright (E2E)                       |
| Lint             | ESLint 9 flat config + Prettier                                   |
| Package manager  | pnpm                                                              |

## Architecture

See `.ai-factory/ARCHITECTURE.md` for the full architecture guidelines,
folder structure, dependency rules, and code examples.

**Pattern:** Structured Modules (Technical Layers), adapted to Next.js App
Router — feature-folder routes under `app/` + technical-concern modules
under `lib/`.

## Architecture Notes

MAIster is split into two Node processes:

- **`web/`** — Next.js 16 app: UI + Route Handlers + server actions +
  Drizzle DB access + SSE bridge to supervisor. No agent processes here.
- **`supervisor/`** — separate Node daemon: owns ACP sessions, spawns one
  agent process (`claude`, `codex`) per active session, heartbeat
  watchdog, checkpoint + respawn via `--resume`, token-count →
  cost-on-disk. HTTP+SSE interface; can run on a different host than `web/`.

Hard architectural commitments (post-ACP revision — see root `CLAUDE.md`
§1-8 for the canonical statement):

1. **ACP-driven execution with hybrid HITL**: ACP notifications drive the
   live path; artifact presence (`needs-input.json`) drives the durable
   path. `NeedsInput` keep-alive ≤30 min, extended by web-console
   activity; the checkpoint path moves `NeedsInput` to `NeedsInputIdle`
   and later respawns via `--resume`.
   No `fs.watch`, no `chokidar`, no polling for state transitions.
2. **SSE pipe-to-disk**: every ACP `session/update` line streamed to per-
   step log file via `fs.createWriteStream` *in parallel* with SSE
   emission, so neither tier OOMs on >10MB output. SSE read-side tails
   the file for `lastEventId` reconnect.
3. **Typed error taxonomy**: `MaisterError extends Error` with
   discriminated `code` (including new codes `EXECUTOR_UNAVAILABLE`,
   `FLOW_INSTALL`, `ACP_PROTOCOL`, `CHECKPOINT`). UI branches on `code`.
4. **Multi-executor via ACP**: claude + codex both required. ACP
   IS the adapter interface. Override resolution: run launcher ->
   task override -> project per-flow override -> project default ->
   flow recommended. CCR bundled.
5. **Flow Engine v2 plugin model**: Flows are git-tag-pinned plugin
   bundles with `flow.yaml` manifest, `cli | agent | guard | human` step
   DSL, optional `setup.sh`, shipped skills/CLIs. Installed to
   `~/.maister/flows/<id>@<tag>/`, symlinked per project. `maister.yaml`
   v2 carries `project` + `executors[]` + `flows[]`. Refuse to register
   on `schemaVersion` mismatch (project or any flow manifest), duplicate
   IDs, unknown executor reference, unknown `goto_step` target, slug
   collision, or `repo_path` collision (one repo = one project).
6. **Atomic writes** to `.maister/`: tmp + rename via `atomicWriteJson`.
   Never partial-write a JSON the Flow / agent will read.

Phase 2 candidates: Flow designer UI · background agents · Telegram ·
A/B parallel runs · durable orchestration · auth / multi-user / RBAC ·
AI-Judge · full Kanban · event log table · test-run UI button · GitHub
Actions CI/CD · syntax highlighting in diff view · project archival UI ·
cross-project task moves · GitHub issue / Linear / YouGile sync · project
lesson capture · custom ACP extensions · cost / time / regex guard
enforcement · plugin trust UI / sandboxing · HITL as separate swimlane
cards · Cursor / opencode / Aider executors.

## Non-Functional Requirements

- **Crash recovery**: on startup, reconcile `runs` table vs `git worktree
  list` vs supervisor's live session set. `Running` rows with no live ACP
  session AND no checkpoint → `Crashed`; UI surfaces "Recover or discard"
  (Recover attempts `--resume <session-id>` if `acp_session_id` present).
  `NeedsInputIdle` rows with a valid checkpoint stay valid.
- **TTL**: runs sitting in `NeedsInputIdle` for 24h without user response
  transition to `Abandoned`.
- **Keep-alive window**: ACP session lives ≤30 min in `NeedsInput`;
  web-console activity extends by +30 min each event.
- **GC**: cron route removes `Abandoned/Done` worktrees + checkpointed
  sessions older than 7d.
- **Server-only secrets**: API keys read from `.env` server-side (Next.js)
  or supervisor-side. Never logged, never streamed, never sent to client.
  Never embedded in ACP `session/update` payloads visible to the browser.
- **Error handling**: throw `MaisterError` with `code` for known domain
  failures, never plain `Error`. UI never string-matches errors.
- **Surgical changes**: every changed line traces directly to the user's
  request. Don't refactor adjacent code "while you're there".
- **TypeScript**: strict mode. No `any` in committed code unless flagged
  with `// FIXME(any):`.

## Success Criteria

**Current target:** ≥2 projects registered
via `maister.yaml` v2 (each pulling ≥2 Flow plugins from git URLs by tag)
→ portfolio home shows active workspaces from both → task created on a
project board with executor selected from `executors[]` → Launch click →
worktree created with precondition checks → supervisor spawns Claude Code
**OR** Codex as an ACP session, `session/update` events stream to UI →
at least one HITL round-trip works for both flavors (binary approve/deny
via `session/request_permission` AND structured form via artifact) →
NeedsInput keep-alive extends on web-console activity → on idle timeout
run checkpoints to `NeedsInputIdle`; user response respawns via `--resume`
→ diff visible → merge-to-main works on clean-merge case → run survives
Next.js restart AND supervisor restart with `Crashed` reconciliation →
3 concurrent runs scheduled across projects, 4th queues with position
badge → retry loop works (Failed/Abandoned run → task back to Backlog →
Launch again → attempt N+1) → per-step executor override verified on at
least one Flow.

**Dogfood (T+5 to T+6w):** register MAIster repo in itself, run a Flow
against its own backlog, ship ≥1 non-trivial PR.

**External validation (T+8w):** 3 installations on external repos, ≥1 PR
shipped end-to-end through maister on each. 0/3 → thesis not validated,
reassess wedge.

## Authoritative Sources

When `.ai-factory/DESCRIPTION.md` (this file) disagrees with `docs/` or
`CLAUDE.md`, the project documentation in `docs/` and the root `CLAUDE.md`
win — update this file.

- `docs/VISION.md` — product spine, principles, MVP goal.
- `docs/PRODUCT_VIEW.md` — Lean Canvas, JTBD, gaps, MVP / Phase 2 / Later.
- `docs/architecture.md` — current system architecture and diagrams.
- `docs/decisions.md` — ADRs and locked technical choices.
- `docs/api/` — OpenAPI and AsyncAPI contracts.
- `docs/system-analytics/` — domain process docs.
- `CLAUDE.md` — architectural decisions and conventions for AI agents.
- `web/CLAUDE.md` — Web/Next.js slice: stack details, scripts, structure,
  conventions.
