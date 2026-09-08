# MAIster

## Overview

**MAIster is the self-hosted execution and governance layer for reproducible
AI-powered SDLC processes over private code.** It turns backlog tasks into
supervised agentic delivery Flows: package-pinned process execution, workspace
creation, ACP-driven agents, structured HITL, evidence review, and promotion.

Current validation wedge: repeatable processes from **core packages** running
against internal/private projects through a **Web shell, ACP supervisor daemon,
and graph-only Flow engine**. The control plane spans a multi-project portfolio,
platform ACP runners (`claude`, `codex`, and readiness-gated `gemini`,
`opencode`, and `mimo`), multiple workspaces, manual scratch workspaces, hybrid
HITL, and a per-project task board. MAIster orchestrates agents through the
Zed-standard Agent Client Protocol (ACP); Flow packages shipped as git-tagged
bundles compose graph nodes, CLI tools, agent skills, subagents, and platform
agents. External ACP adapters remain the runtimes; MAIster provides the
execution and governance layer around them.

Audience: a technical owner or small engineering team running multiple private
repositories and AI coding agents in parallel and tired of babysitting
consoles.

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
- **Package management (ADR-088)**: multi-flow **packages** from git
  monorepos (`maister-package.yaml`; per-package tags `<name>/vX.Y.Z`) —
  platform sources + discovery, immutable `package_installs`, per-project
  attachments with `maister.yaml packages[]` bootstrap/write-back, package
  trust fan-out, local versions. The AIF package lives in the external
  `maister-plugins` repo.
- **Flow plugin engine**: Flows are git-repo plugins pinned by tag, installed
  to `~/.maister/flows/<id>@<tag>/` system cache and symlinked per project.
  Each plugin carries a graph-only `flow.yaml` manifest with typed `nodes[]`,
  transitions, gates, optional `setup.sh`, shipped CLIs, skills, and agents.
- **Multi-executor via ACP**: `claude` and `codex` are the ready default
  adapters; `gemini`, `opencode`, and `mimo` are code-owned adapter families
  whose launch/default readiness is gated by supervisor diagnostics and cached
  ACP smoke evidence.
  Executor identity = `{agent, model, env?}` defined per project in
  `executors[]`. Anthropic-compatible providers are configured through runner
  provider fields and supervisor environment references. Per-step override resolution: run
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
  with in-card form + send-back-with-comments for graph human-review nodes.
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
  process, loopback HTTP+SSE IPC on the supported single host) owns ACP
  sessions and is addressed as a registered execution host. Repository and
  worktree material remains local until Stage C; Stage B runtime events and
  objects cross only durable, path-free contracts (ADR-166/167).
  One agent process per session. Spawned on Launch; permission HITL is
  resolved live. Checkpoint/idle resume is implemented.
- **Hybrid HITL**: ACP `session/request_permission` for binary approve/deny
  - artifact `input-<nodeId>.json` for structured forms (JSON Schema) + graph
    human-review finishes with typed decisions and bounded rework targets.
- **Live execution streaming**: supervisor commits redacted ACP events to a
  private durable outbox; the manager ingests canonical Postgres events and
  serves `/api/runs/[id]/stream` with `lastEventId` replay. Raw logs remain
  host-owned runtime objects.
- **Diff view + merge**: raw `git diff` rendered as `<pre>`,
  `git merge --no-ff` on the parent's `main_branch`.
  Conflicts abort and surface "Conflict — resolve manually" in UI.
- **Concurrency cap**: `MAISTER_MAX_CONCURRENT_RUNS=6`
  (env-configurable, global across projects). Runs above the cap go to
  `Pending`; UI shows queue position; auto-promote on slot free.
- **Typed error taxonomy**: `MaisterError` with discriminated `code`
  (`PRECONDITION | SPAWN | NEEDS_INPUT | HITL_TIMEOUT | CRASH | CONFLICT |
CONFIG | EXECUTOR_UNAVAILABLE | FLOW_INSTALL | ACP_PROTOCOL |
CHECKPOINT`). UI branches on `code`, never on string matching.
- **i18n**: EN + RU from day one.
- **Evaluation Lab** (M46, in progress; ADR-142..147): a project-level
  Evaluation Study compares 2..N observed (existing) or launched Runs for one
  task without changing observed-Run semantics. Package-sourced versioned
  Evaluation Methods run behind trust/compatibility through independently
  configured Judge Panels over immutable, private, bounded evidence snapshots.
  Objective facts stay separate from AI opinion; aggregation/disagreement are
  versioned and auditable; the human verdict is append-only and conclusive
  (judges never conclude or promote). Evolves the task-bound Experiment
  Comparison Studio (ADR-124). See
  `.ai-factory/plans/feature-evaluation-lab.md`.

## Tech Stack

| Layer             | Choice                                                            |
| ----------------- | ----------------------------------------------------------------- |
| Framework         | Next.js 16+ App Router (server actions + RSC where it fits)       |
| Language          | TypeScript end-to-end, strict mode                                |
| UI library        | HeroUI v3 (`@heroui/react`), no other component lib               |
| Styling           | Tailwind CSS 4 via `@tailwindcss/postcss`, `tailwind-variants`    |
| Theming           | `next-themes` (default `dark`)                                    |
| i18n              | EN + RU from day one (REQUIRED)                                   |
| Database          | Postgres 16 only (docker, named volume)                           |
| ORM               | Drizzle (SQL-flavored, JOOQ-like). Not Prisma.                    |
| Agent runtime     | ACP hosted by `supervisor/`, via                                  |
|                   | `@agentclientprotocol/claude-agent-acp`,                          |
|                   | `@agentclientprotocol/codex-acp`, and                             |
|                   | `@agentclientprotocol/sdk`.                                       |
|                   | One agent process (`claude`, `codex`) per active session via      |
|                   | Node `child_process.spawn`. Permission HITL resolves live;        |
|                   | checkpoint+respawn via the ACP `session/resume` call implemented. |
| Model routing     | Anthropic-compatible providers configured through runner fields   |
|                   | and supervisor environment references.                            |
| Web ↔ supervisor | Loopback HTTP + SSE on ONE host through the ADR-166/167 execution-host contracts; no web runtime-data mount |
|                   | Repository/worktree placement remains local until Stage C; remote trust/relay remains Stage D             |
| Flow plugins      | git repos pinned by tag; installed to                             |
|                   | `~/.maister/flows/<id>@<tag>/` and symlinked per project          |
| Git workspaces    | Thin wrapper around `git worktree add/remove/list`                |
| Live updates      | SSE — supervisor publishes ACP `session/update`; Next.js Route    |
|                   | Handler bridges to browser                                        |
| Python            | Optional — only when a specific Flow plugin ships Python CLIs     |
|                   | (no longer required in the base container image).                 |
| Tests             | vitest (unit/integration), Playwright (E2E)                       |
| Lint              | ESLint 9 flat config + Prettier                                   |
| Package manager   | pnpm                                                              |

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
  watchdog, checkpoint + respawn via the ACP `session/resume` call, canonical
  usage events, durable event outbox, and private runtime objects. HTTP+SSE
  runs over loopback in the supported single-host deployment. Repository and
  worktree placement stays local until Stage C; the web tier does not mount
  supervisor runtime data.

Hard architectural commitments (post-ACP revision — see root `CLAUDE.md`
§1-8 for the canonical statement):

1. **ACP-driven execution with hybrid HITL**: ACP notifications drive the
   live path; artifact presence (`needs-input.json`) drives the durable
   path. `NeedsInput` keep-alive ≤30 min, extended by web-console
   activity; the checkpoint path moves `NeedsInput` to `NeedsInputIdle`
   and later respawns + resumes via the ACP `session/resume` call.
   No `fs.watch`, no `chokidar`, no polling for state transitions.
2. **Durable execution-host data plane**: the supervisor may stream raw output
   to private files, but externally visible events commit to its SQLite outbox
   before publication. The manager owns canonical Postgres replay and runtime
   metadata; content is streamed by opaque object ID with bounded ranges.
3. **Typed error taxonomy**: `MaisterError extends Error` with
   discriminated `code` (including new codes `EXECUTOR_UNAVAILABLE`,
   `FLOW_INSTALL`, `ACP_PROTOCOL`, `CHECKPOINT`). UI branches on `code`.
4. **Multi-executor via ACP**: claude + codex both required. ACP
   IS the adapter interface. Override resolution: run launcher ->
   task override -> project per-flow override -> project default ->
   flow recommended.
5. **Flow Engine 3 graph-only plugin model**: Flows are git-tag-pinned plugin
   bundles with a typed `nodes[]` `flow.yaml` graph, optional `setup.sh`, and
   shipped skills/CLIs. Installed to
   `~/.maister/flows/<id>@<tag>/`, symlinked per project. `maister.yaml`
   v2 carries `project` + `executors[]` + `flows[]`. Refuse to register
   on `schemaVersion` mismatch (project or any flow manifest), legacy
   `steps[]`, duplicate IDs, unknown runner reference, or unknown graph target, slug
   collision, or `repo_path` collision (one repo = one project).
6. **Atomic writes** to `.maister/`: tmp + rename via `atomicWriteJson`.
   Never partial-write a JSON the Flow / agent will read.

Current productization gaps: core-process qualification · end-to-end preflight
and Run Doctor · visual/browser evidence · strong process/container isolation ·
OIDC/SSO/MFA and organization administration · notification routing · automated
backup/restore drills · provider-specific issue/CI intake. Public marketplace,
full Kanban, cross-project task moves, and Temporal-class durable orchestration
stay later.

## Non-Functional Requirements

- **Crash recovery**: on startup, reconcile `runs` table vs `git worktree
list` vs supervisor's live session set. `Running` rows with no live ACP
  session AND no checkpoint → `Crashed`; UI surfaces "Recover or discard"
  (Recover attempts the ACP `session/resume` call if `acp_session_id` present).
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
run checkpoints to `NeedsInputIdle`; user response respawns + resumes via `session/resume`
→ diff visible → merge-to-main works on clean-merge case → run survives
Next.js restart AND supervisor restart with `Crashed` reconciliation →
3 concurrent runs scheduled across projects, 4th queues with position
badge → retry loop works (Failed/Abandoned run → task back to Backlog →
Launch again → attempt N+1) → per-step executor override verified on at
least one Flow.

**Dogfood and external-adoption signal:** confirmed by the owner on 2026-07-15.
Repository state does not reconstruct the original installation count or
shipped-change metrics.

**Current qualification target:** run at least three representative processes
from core packages across at least three internal/private repositories, with
three consecutive runs per process/project profile. Record package/engine/
runner provenance, prerequisites, expected evidence, failure class,
time-to-first-success, review reach, human-attention time, promotion outcome,
and recovery guidance without retaining private source, prompts, diffs,
secrets, or artifact bodies.

## Authoritative Sources

When `.ai-factory/DESCRIPTION.md` (this file) disagrees with `docs/` or
`CLAUDE.md`, the project documentation in `docs/` and the root `CLAUDE.md`
win — update this file.

- `docs/VISION.md` — product spine, principles, validation goal.
- `docs/PRODUCT_VIEW.md` — Lean Canvas, JTBD, gaps, current scope / Phase 2 /
  Later.
- `docs/architecture.md` — current system architecture and diagrams.
- `docs/decisions.md` — ADRs and locked technical choices.
- `docs/api/` — OpenAPI and AsyncAPI contracts.
- `docs/system-analytics/` — domain process docs.
- `CLAUDE.md` — architectural decisions and conventions for AI agents.
- `web/CLAUDE.md` — Web/Next.js slice: stack details, scripts, structure,
  conventions.
