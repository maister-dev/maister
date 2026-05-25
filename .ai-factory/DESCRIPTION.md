# MAIster

## Overview

**MAIster is the control plane for AI-powered software delivery.** It turns
backlog tasks into supervised agentic delivery Flows: workspace creation,
headless agent execution, HITL, AI-Judge, diff review, merge, and project
learning.

The POC wedge is intentionally narrow: a **thin Web shell over a CLI-Flow
runner with multi-project portfolio + multi-workspace + HITL + per-project
task board**. MAIster orchestrates and wraps existing Flow frameworks (e.g.
`aif`, `spec-kit`, `open-spec`). It does **not** build a new Flow runner,
Flow designer, or skill engine.

Audience: solo-technical CEO / CIO / staff-eng running multiple repos and AI
coding agents in parallel and tired of babysitting consoles.

For the full vision, principles, and roadmap see `docs/VISION.md`,
`docs/PRODUCT_VIEW.md`, and the locked design at
`docs/kaa-maister-design-20260522-174429.md`.

## Core Features (POC scope)

- **Multi-project registry**: N projects per host, each configured by its own
  `maister.yaml` v1 (`project` block + `flows[]`). Registration via UI form
  (path to dir containing `maister.yaml`) or `MAISTER_PROJECTS_DIR` env
  **recursive** auto-discovery on startup. Slug derived from `project.name`
  (kebab-case); both `slug` and `repo_path` are unique across projects (one
  repo = one project). Collisions reject the registration.
- **Portfolio home (superset.sh-style)**: single grid of every active
  workspace across all projects. Card = project · branch · status · last
  activity · quick actions (View / Resume / Abandon). Filters by project +
  status.
- **Per-project task board**: 2 columns `Backlog | In Flight`. In Flight
  holds `Running | NeedsInput | Review | Crashed`. A Backlog card has a
  **Launch** button (no drag-and-drop in POC); click runs preconditions and
  spawns a Run. Done/Abandoned in a filter tab.
- **Backlog → Flow launch**: task created on the board with title + prompt +
  Flow dropdown (from project's `flows[]`); launched on Launch click. **task
  ↔ run is 1:N** — a failed/abandoned run returns the task to `Backlog`,
  Launch reappears, next click = attempt N+1 (ralph-loop friendly).
- **Workspace lifecycle**: `git worktree add` per run under
  `.maister/<project-slug>/runs/<run-id>/`, precondition checks (clean parent
  repo, branch free, worktree path free, global cap not hit), per-project
  reconciliation on Next.js startup, GC of `Abandoned/Done` worktrees older
  than 7d across all projects.
- **Headless agent execution**: Claude Code only in POC, spawned via
  `child_process.spawn` of `uv run <flow-cmd>`.
- **Block-based HITL**: each Flow block is one subprocess invocation that runs
  to natural completion. `needs-input.json` artifact triggers a UI form
  rendered from `response_schema`; submission writes
  `input-<block-id>.json` atomically and re-invokes the Flow with
  `--resume <block-id>`. No live process held across a user-input wait.
- **Live log streaming**: SSE via Route Handler
  (`/api/runs/[id]/stream`), one message per stdout line,
  `lastEventId` reconnect. Stdout is piped to disk
  (`.maister/<project-slug>/runs/<run-id>/<block-id>.log`) in parallel.
- **Diff view + merge**: raw `git diff` rendered as `<pre>` (no syntax
  highlighting in POC), `git merge --no-ff` on the parent's `main_branch`.
  Conflicts abort and surface "Conflict — resolve manually" in UI.
- **Concurrency cap**: `MAISTER_MAX_CONCURRENT_RUNS=3` for POC
  (env-configurable, global across projects). Runs above the cap go to
  `Pending`; UI shows queue position; auto-promote on slot free.
- **Typed error taxonomy**: `MaisterError` with discriminated `code`
  (`PRECONDITION | SPAWN | NEEDS_INPUT | HITL_TIMEOUT | CRASH | CONFLICT |
  CONFIG`). UI branches on `code`, never on string matching.

## Tech Stack (locked — "Approach B")

| Layer            | Choice                                                            |
| ---------------- | ----------------------------------------------------------------- |
| Framework        | Next.js 16+ App Router (server actions + RSC where it fits)       |
| Language         | TypeScript end-to-end, strict mode                                |
| UI library       | HeroUI v3 (`@heroui/react`), no other component lib               |
| Styling          | Tailwind CSS 4 via `@tailwindcss/postcss`, `tailwind-variants`    |
| Theming          | `next-themes` (default `dark`)                                    |
| Database         | Postgres 16 primary (docker, named volume); SQLite via Drizzle    |
|                  | dialect switch (`DB_URL=file:./dev.db`) for ultra-light dev only  |
| ORM              | Drizzle (SQL-flavored, JOOQ-like). Not Prisma.                    |
| Subprocess       | Node `child_process.spawn`. One spawn per block, runs to natural  |
|                  | exit. No long-running process across HITL waits.                  |
| Git workspaces   | Thin wrapper around `git worktree add/remove/list`                |
| Live updates     | SSE via Route Handlers, one message per stdout line               |
| Python bridge    | `uv run <flow-cmd>` in the same container image (Node 24 +        |
|                  | Python 3.12 + uv). Single image, ~1-2GB, accepted.                |
| Tests            | vitest (unit/integration), Playwright (E2E); aif determinism eval |
|                  | before dogfood                                                    |
| Lint             | ESLint 9 flat config + Prettier                                   |
| Package manager  | pnpm                                                              |

## Architecture

See `.ai-factory/ARCHITECTURE.md` for the full architecture guidelines,
folder structure, dependency rules, and code examples.

**Pattern:** Structured Modules (Technical Layers), adapted to Next.js App
Router — feature-folder routes under `app/` + technical-concern modules
under `lib/`.

## Architecture Notes

The entire MAIster app for the POC is a **Next.js 16 monolith** living in
`web/`: UI + Route Handlers + server actions + (eventually) subprocess runner +
Drizzle DB access + SSE log streams. There is no separate backend service.

Hard architectural commitments (do not quietly walk back — earned in two
review passes):

1. **Block-based HITL**: subprocess exit codes drive state transitions. No
   `fs.watch`, no `chokidar`, no polling. `Needs input` is a server-side
   state with no live process attached.
2. **SSE pipe-to-disk**: stdout streamed to file via
   `fs.createWriteStream` *in parallel* with SSE emission, so the server
   never OOMs on >10MB block output. SSE read-side tails the file.
3. **Typed error taxonomy**: `MaisterError extends Error` with discriminated
   `code`. UI branches on `code`.
4. **Single executor, hard-coded**: Claude Code only in POC. No adapter
   interface (resist premature abstraction). Refactor in dogfood week if a
   real second executor appears.
5. **Minimal `maister.yaml` v1**: `project` block + `flows[]`. Refuse to
   register on `schemaVersion` mismatch, duplicate `flows[].id`, a Flow
   command missing `{prompt}` / `{workspace_path}` placeholders, slug
   collision, or `repo_path` collision (one repo = one project).
6. **Atomic writes** to `.maister/`: tmp + rename via `atomicWriteJson`.
   Never partial-write a JSON the Flow will read.

Out-of-POC items (do not build, do not propose): Flow designer UI ·
multi-executor pool · adapter interface · background agents · Telegram · A/B
parallel runs · durable orchestration · auth / multi-user / RBAC · AI-Judge ·
full Kanban (Done as drag-target / WIP limits / swim-lanes) · event log
table · test-run UI button · GitHub Actions CI/CD · syntax highlighting in
diff view · skills invocation (read-only enumeration only) · project archival
UI (DB has `archived_at`, no button) · cross-project task moves · GitHub
issue / Linear / YouGile sync · project lesson capture.

## Non-Functional Requirements

- **Crash recovery**: on Next.js startup, reconcile `runs` table vs
  `git worktree list`. `Running` rows with no live PID become `Crashed` and
  the UI surfaces "Recover or discard".
- **TTL**: runs sitting in `Needs input` for 24h transition to `Abandoned`.
- **GC**: cron route removes `Abandoned/Done` worktrees older than 7d.
- **Server-only secrets**: API keys read from `.env` server-side. Never
  logged, never streamed, never sent to client.
- **Error handling**: throw `MaisterError` with `code` for known domain
  failures, never plain `Error`. UI never string-matches errors.
- **Surgical changes**: every changed line traces directly to the user's
  request. Don't refactor adjacent code "while you're there".
- **TypeScript**: strict mode. No `any` in committed code unless flagged
  with `// FIXME(any):`.

## Success Criteria

**POC (T+1 to T+1.5 weeks):** ≥2 projects registered via `maister.yaml` v1
(each with ≥2 Flows) → portfolio home shows active workspaces from both →
task created on a project board → Launch click → worktree created with
precondition checks → headless Claude Code runs, logs streamed from the
project-scoped log file → at least one HITL round-trip → diff visible →
merge-to-main works on clean-merge case → run survives restart with
`Crashed` reconciliation (per-project) → 3 concurrent runs scheduled across
projects, 4th queues with position badge → retry loop works: abandon a run
→ task returns to Backlog → Launch again → attempt N+1 spawns against the
same task with a fresh worktree.

**Dogfood (T+1.5 – 2w):** run aif against the maister repo itself, produce a
non-trivial PR-sized diff, manually merge.

**External validation (T+3w):** ≥1 of 2 friends ships ≥1 PR end-to-end
through maister on their own repo. 0/2 → thesis not validated, reassess
wedge.

## Authoritative Sources

When `.ai-factory/DESCRIPTION.md` (this file) disagrees with `docs/` or
`CLAUDE.md`, the project documentation in `docs/` and the root `CLAUDE.md`
win — update this file.

- `docs/VISION.md` — product spine, principles, MVP goal.
- `docs/PRODUCT_VIEW.md` — Lean Canvas, JTBD, gaps, MVP / Phase 2 / Later.
- `docs/kaa-maister-design-20260522-174429.md` — locked design, stack
  rationale, HITL protocol, success criteria.
- `docs/kaa-maister-eng-review-test-plan-20260522-180855.md` — routes, key
  interactions, edge cases, critical paths.
- `CLAUDE.md` — architectural decisions and conventions for AI agents.
- `web/CLAUDE.md` — Web/Next.js slice: stack details, scripts, structure,
  conventions.
