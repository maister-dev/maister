# CLAUDE.md — MAIster

## What this is

**MAIster is the control plane for AI-powered software delivery.**

Product spine:

```
Backlog → Flow → Workspace → Headless Agents → HITL → AI-Judge → Diff Review → Merge → Lessons
```

POC wedge:
**thin Web shell over a CLI-Flow runner with multi-project portfolio +
multi-workspace + HITL + per-project task board.** We orchestrate and wrap
existing Flow frameworks (e.g. aif). We do NOT build a new Flow runner, Flow
designer, or skill engine.

Audience: solo-technical CEO/CIO/staff-eng 

## Repo state right now

```
docs/        # VISION.md, PRODUCT_VIEW.md, design doc, eng-review test plan
web/         # Next.js 16 + React 19 + HeroUI v3 app — see web/CLAUDE.md
.agents/     # codex agent bundles (do not hand-edit)
.codex/      # codex skills + config.toml
.claude/     # claude skills + agents (do not hand-edit; manage via /aif tooling)
.mcp.json    # MCP servers: github, filesystem, postgres, chromeDevtools, playwright
.ai-factory.json
.gitignore   # already configured for Next.js (.next/, node_modules/, .env*.local)
LICENSE      # MIT, Albert Kanischev, 2026
```

Backend (Drizzle/PG, subprocess runner, `.maister/` artifacts) is not scaffolded
yet — only the web slice exists. Build server-side pieces inside `web/` (Route
Handlers + server actions), not as a separate process.

## How to run

```bash
cd web && pnpm install     # first time
cd web && pnpm dev         # http://localhost:3000
cd web && pnpm build && pnpm start
cd web && pnpm lint        # eslint --fix
```

Detailed code structure, conventions, HeroUI patterns: **`web/CLAUDE.md`**.

## Stack (locked — Approach B)

- **Framework**: Next.js 16+ App Router, server actions + RSC where it fits.
- **Lang**: TypeScript end-to-end. Python only as subprocess (`uv run aif ...`).
- **DB**: Postgres 16 primary (docker compose, named volume). SQLite via
  Drizzle dialect switch (`DB_URL=file:./dev.db`) for ultra-light dev only.
- **ORM**: Drizzle. SQL-flavored, JOOQ-like mental model. Do not swap for Prisma.
- **UI**: HeroUI v3 (Tailwind4-based). No other component lib.
- **Subprocess**: Node `child_process.spawn`. One spawn per block, runs to natural
  exit. No long-running process across HITL waits.
- **Git**: thin worktree wrapper around `git worktree add/remove/list`.
- **Live updates**: SSE via Route Handlers (`/api/runs/[id]/stream`), one message
  per stdout line, `lastEventId` reconnect.
- **Python bridge**: `uv run <flow-cmd>` in the same container image (Node 24 +
  Python 3.12 + uv). Single image, ~1-2GB, accepted.
- **Tests**: vitest (unit/integration), playwright (E2E). aif determinism eval
  before dogfood.
- **Pkg mgr**: pnpm.

## Architectural decisions you cannot quietly walk back

These were earned in two review passes. Reopen them only with new evidence.

### 1. Block-based HITL (no polling, no chokidar, no SIGTERM-on-timeout)

A Flow = sequence of **blocks**. One block = one subprocess invocation that
runs to natural completion. Block exit conventions:

- Exit 0, no artifact → block done, advance.
- Exit 0 + `.maister/<project-slug>/runs/<run-id>/needs-input.json` → run
  state `Needs input`.
- Exit ≠ 0 → run state `Failed`.

On `Needs input`: UI renders form from `response_schema` (zod-validated).
User submits → atomic write to
`.maister/<project-slug>/runs/<run-id>/input-<block-id>.json` (via
`atomicWriteJson` helper: tmp + rename) → Flow re-invoked with
`--resume <block-id>`. No live process during the wait → no zombie to kill.

TTL 24h in `Needs input` → `Abandoned`.

**Do not** introduce `fs.watch`, `chokidar`, or polling. Transitions are
driven by subprocess exit codes.

### 2. SSE pipe-to-disk

Stdout is streamed to `.maister/<project-slug>/runs/<run-id>/<block-id>.log`
via `fs.createWriteStream` **in parallel** with SSE emission. SSE read-side
tails the file. Required so server doesn't OOM on >10MB block output.

### 3. Typed error taxonomy (`lib/errors.ts`)

`MaisterError extends Error` with discriminated `code`:
`PRECONDITION | SPAWN | NEEDS_INPUT | HITL_TIMEOUT | CRASH | CONFLICT | CONFIG`.
UI branches on `code`, never on string matching. No string-matched errors.

### 4. Concurrency cap

`MAISTER_MAX_CONCURRENT_RUNS=3` for POC (env-configurable). Cap is **global**
across all projects, not per-project. Runs above the cap go to `Pending` and
auto-start when a slot frees. UI shows queue position. Hard cap (no override
from `maister.yaml`) — keeps RAM/token spend bounded on a single host.

### 5. Single executor, hard-coded

Claude Code only. **No adapter interface in POC.** Refactor in dogfood week if
a real second executor appears. Resist premature abstraction.

### 6. `maister.yaml` minimal v1

```yaml
schemaVersion: 1
project:
  name: myapp                    # human label
  repo_path: /repos/myapp        # absolute path to the parent repo
  main_branch: main
  branch_prefix: maister/
flows:                           # list of Flows the project supports
  - id: bugfix
    name: Bugfix
    command: uv run aif run --task '{prompt}' --flow bugfix --workspace '{workspace_path}'
  - id: feature
    name: Small feature
    command: uv run aif run --task '{prompt}' --flow feature --workspace '{workspace_path}'
```

Project `slug` is derived from `project.name` (kebab-cased). Both `slug` and
`repo_path` are **unique across registered projects** (one repo = one
project — no two `maister.yaml` files may point at the same `repo_path`).
User picks one Flow from `flows[]` at task-creation time. Refuse to register
on: `schemaVersion` mismatch, duplicate `flows[].id` within the file,
a Flow command missing the `{prompt}`/`{workspace_path}` placeholders,
slug collision with an existing project, or `repo_path` collision with an
existing project. Resist growth beyond this shape — no per-Flow secrets,
no inline scripts, no `if`-blocks.

### 7. Workspace lifecycle

- Workspace artifacts live under `.maister/<project-slug>/runs/<run-id>/`
  (logs, `needs-input.json`, `input-<block-id>.json`). One isolated subtree
  per project — no cross-project bleed.
- On `POST /api/runs`: preconditions (project exists & active, clean parent
  repo, branch free, worktree path free, global concurrency cap not hit) →
  `git worktree add` → spawn.
- On Next.js startup: reconcile `runs` table vs `git worktree list` **for
  every registered project**. `Running` rows with no live PID → `Crashed`,
  surface "Recover or discard".
- Cron route GCs `Abandoned/Done` worktrees older than 7d across all projects.

### 8. Merge policy

`git merge --no-ff` on parent's `main_branch`. Conflict → abort, run stays
`Review`, UI surfaces "Conflict — resolve manually" with parent repo path.
No auto-resolve.

## POC scope (what we build)

- **Multi-project registry**: N projects per host, each configured by its own
  `maister.yaml`. Registration via UI form (path to dir containing
  `maister.yaml`) or `MAISTER_PROJECTS_DIR` env auto-discovery (**recursive**
  scan; every `maister.yaml` under the root gets registered, slug/repo
  collisions are rejected).
- **Project portfolio (home)**: superset.sh-style grid of every active
  workspace across all projects — project · branch · status · last activity ·
  quick actions (View / Resume / Abandon). Filters by project + status.
- **Per-project task board**: 2 columns — **Backlog** | **In Flight**. In
  Flight bucket holds `Running | NeedsInput | Review | Crashed`. A task card
  in Backlog has a **Launch** button (no drag-and-drop in POC); click =
  precondition checks → create Run → task moves to In Flight.
  Done/Abandoned surface in a filter tab, not as additional columns.
- **Task ↔ Run cardinality is 1:N**: one task can spawn many runs over its
  lifetime (retry loop / "ralph-loop"-friendly). If a run terminates with
  `Failed | Crashed | Abandoned`, the task auto-returns to `Backlog` and
  the Launch button re-appears — the user can fire another run against the
  same task without recreating it. Latest run is the one shown on the card.
- **Task creation**: title + prompt + Flow dropdown (populated from the
  project's `maister.yaml` `flows[]`).
- **Block-based HITL**, **SSE pipe-to-disk**, **typed errors**, **single
  executor (Claude Code)**, **`maister.yaml` v1**, **worktree lifecycle**,
  **merge policy** — see §1-8 above.
- **Concurrency**: global cap = 3 (env-configurable). Queue + position badge.

## Out of POC scope (do not build, do not propose)

Flow designer UI · multi-executor pool · adapter interface · background agents
(reviewer/log/dependency) · Telegram · A/B parallel runs · durable
orchestration · auth/multi-user/RBAC · AI-Judge · full Kanban (Done as
drag-target / WIP limits / swim-lanes) · event log table · test-run UI button
· GitHub Actions CI/CD · syntax highlighting in diff view · skills invocation
(read-only enumeration only) · project archival UI (DB has `archived_at`,
no button) · cross-project task moves · GitHub issue/Linear/YouGile sync.

If a task adds any of the above, push back with "out of POC scope" and link
to `docs/kaa-maister-design-20260522-174429.md` §"Out of POC (explicit)".

## Conventions

- **Errors**: throw `MaisterError` with `code`, never plain `Error` for known
  domain failures. See §3 above.
- **Atomic writes** to `.maister/`: always tmp + rename via `atomicWriteJson`.
  Never partial-write a JSON the Flow will read.
- **SSE messages**: one per stdout line. Include monotonic `id` for
  `lastEventId` reconnect.
- **Subprocess lifetime**: bounded by a single block. No process held across
  a user-input wait.
- **Server-only secrets**: API keys read from `.env` server-side. Never logged,
  never streamed, never sent to client.
- **TypeScript**: strict mode. No `any` in committed code unless flagged with
  a `// FIXME(any):` comment.
- **No comments explaining WHAT** — names should do that. Only add comments
  for non-obvious WHY (invariants, workarounds, surprising constraints).
- **Surgical changes**: every changed line traces to the request. Don't refactor
  adjacent code "while you're there".

## Open questions (validate before/during 48h assignment)

1. **`aif --resume <block-id>` semantics** — native, or shim required?
2. **Claude Code headless binary + version** — `claude`, `claude-code`,
   `openclaw`? Validate non-interactive stdin/stdout.
3. **`uv run` stdin propagation** — clean subprocess pass-through?
4. **tausik** — repo URL? If unknown by Day 1, drop from integration list.
5. **Named first external dogfood friend** — pick by name + target repo
   before coding starts.

## Success criteria (POC, T+1 to T+1.5 weeks)

End-to-end: ≥2 projects registered via `maister.yaml` (each with ≥2 Flows in
`flows[]`) → portfolio home shows active workspaces from both → task created
from the project board → Launch click → worktree created with precondition
checks → headless Claude Code runs, logs streamed → at least one HITL
round-trip works → diff visible → merge-to-main works on clean-merge case →
run survives restart with `Crashed` reconciliation → 3 concurrent runs
scheduled across projects, 4th queues with position badge → retry loop works:
abandon a run, click Launch on the same task → run #2 spawns against the same
task with a fresh worktree.

Dogfood (T+1.5–2w): run aif against the maister repo itself, produce a
non-trivial PR-sized diff, manually merge.

External validation (T+3w): ≥1 of 2 friends ships ≥1 PR end-to-end through
maister on their own repo. 0/2 → thesis not validated, reassess wedge.

## Where to read next

- `web/CLAUDE.md` — Web UI slice: stack details, scripts, structure, conventions.
- `docs/VISION.md` — one-liner, principles, MVP goal.
- `docs/PRODUCT_VIEW.md` — Lean Canvas, JTBD, gaps, MVP / Phase 2 / Later.
- `docs/kaa-maister-design-20260522-174429.md` — locked design, stack
  rationale, HITL protocol, success criteria, reviewer concerns.
- `docs/kaa-maister-eng-review-test-plan-20260522-180855.md` — routes, key
  interactions, edge cases, critical paths.

When this file disagrees with `docs/`, `docs/` wins — update this file.
