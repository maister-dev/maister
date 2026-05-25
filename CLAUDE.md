# CLAUDE.md — MAIster

## What this is

**MAIster is the control plane for AI-powered software delivery.**

Product spine:

```
Backlog → Flow → Workspace → Headless Agents → HITL → AI-Judge → Diff Review → Merge → Lessons
```

POC wedge:
**thin Web shell over a CLI-Flow runner with multi-workspace + HITL + minimal
run list.** We orchestrate and wrap existing Flow frameworks (e.g. aif). We do
NOT build a new Flow runner, Flow designer, or skill engine.

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
- Exit 0 + `.maister/<run>/needs-input.json` → run state `Needs input`.
- Exit ≠ 0 → run state `Failed`.

On `Needs input`: UI renders form from `response_schema` (zod-validated).
User submits → atomic write to `.maister/<run>/input-<block-id>.json` (via
`atomicWriteJson` helper: tmp + rename) → Flow re-invoked with
`--resume <block-id>`. No live process during the wait → no zombie to kill.

TTL 24h in `Needs input` → `Abandoned`.

**Do not** introduce `fs.watch`, `chokidar`, or polling. Transitions are
driven by subprocess exit codes.

### 2. SSE pipe-to-disk

Stdout is streamed to `.maister/runs/<id>/<block-id>.log` via
`fs.createWriteStream` **in parallel** with SSE emission. SSE read-side tails
the file. Required so server doesn't OOM on >10MB block output.

### 3. Typed error taxonomy (`lib/errors.ts`)

`MaisterError extends Error` with discriminated `code`:
`PRECONDITION | SPAWN | NEEDS_INPUT | HITL_TIMEOUT | CRASH | CONFLICT | CONFIG`.
UI branches on `code`, never on string matching. No string-matched errors.

### 4. Concurrency cap

`MAISTER_MAX_CONCURRENT_RUNS=1` for POC. Second run while first is `Running`
goes to `Pending`. Auto-starts on completion/abandon. UI shows queue position.

### 5. Single executor, hard-coded

Claude Code only. **No adapter interface in POC.** Refactor in dogfood week if
a real second executor appears. Resist premature abstraction.

### 6. `maister.yaml` minimal v0

```yaml
schemaVersion: 1
repo_path: /repos/myapp
main_branch: main
branch_prefix: maister/
flow:
  framework: aif
  command: uv run aif run --task '{prompt}' --workspace '{workspace_path}'
```

Refuse to start on `schemaVersion` mismatch. 4-5 fields. Resist growth.

### 7. Workspace lifecycle

- On `POST /api/runs`: preconditions (clean parent repo, branch free, worktree
  path free) → `git worktree add` → spawn.
- On Next.js startup: reconcile `runs` table vs `git worktree list`. `Running`
  rows with no live PID → `Crashed`, surface "Recover or discard".
- Cron route GCs `Abandoned/Done` worktrees older than 7d.

### 8. Merge policy

`git merge --no-ff` on parent's `main_branch`. Conflict → abort, run stays
`Review`, UI surfaces "Conflict — resolve manually" with parent repo path.
No auto-resolve.

## Out of POC scope (do not build, do not propose)

Flow designer UI · multi-executor pool · adapter interface · background agents
(reviewer/log/dependency) · Telegram · A/B parallel runs · durable
orchestration · auth/multi-user/RBAC · AI-Judge · Kanban board · event log
table · test-run UI button · GitHub Actions CI/CD · syntax highlighting in
diff view · skills invocation (read-only enumeration only).

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

End-to-end: project configured via `maister.yaml` → task launched through aif
Flow → worktree created with precondition checks → headless Claude Code runs,
logs streamed → at least one HITL round-trip works → diff visible →
merge-to-main works on clean-merge case → run survives restart with `Crashed`
reconciliation → concurrency cap honored.

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
