# Backend Rules

> Area-specific conventions for the server-side runtime: Route Handlers,
> Server Actions, `web/lib/*` modules, subprocess runner, SSE, worktree
> management. Loaded after `rules/base.md`. Authoritative sources:
> root `CLAUDE.md` (locked architectural decisions) and `web/CLAUDE.md`.

## Rules

- One block = one `child_process.spawn` invocation. The subprocess runs to natural exit. No long-running process is held across a HITL wait.
- Drive state transitions from subprocess exit code plus presence of `.maister/<project-slug>/runs/<run-id>/needs-input.json`. Never use `fs.watch`, `chokidar`, or polling.
- Block exit conventions: exit 0 with no artifact → block done, advance; exit 0 plus `needs-input.json` → run state `Needs input`; exit ≠ 0 → run state `Failed`.
- Pipe block stdout to `.maister/<project-slug>/runs/<run-id>/<block-id>.log` via `fs.createWriteStream` in parallel with SSE emission. Server must not buffer >10MB block output in memory.
- One SSE message per stdout line. Include a monotonically increasing `id` so reconnects with `lastEventId` resume cleanly.
- Throw `MaisterError` with a discriminated `code` (`PRECONDITION | SPAWN | NEEDS_INPUT | HITL_TIMEOUT | CRASH | CONFLICT | CONFIG`) for known domain failures. Never throw plain `Error` for domain errors. Never wrap third-party errors to "look typed" — extend the taxonomy if a new failure mode is real.
- All writes under `.maister/<project-slug>/runs/<run-id>/` go through `atomicWriteJson` (tmp + rename via `lib/atomic.ts`). The Flow may read these files mid-write otherwise.
- HITL handoff sequence: Flow writes `needs-input.json` (in the project-scoped subtree) on graceful exit → UI renders form from `response_schema` (zod-validated) → user submits → server writes `input-<block-id>.json` via `atomicWriteJson` → Flow re-invoked with `--resume <block-id>`. No live process during the wait.
- TTL: a run sitting in `Needs input` for 24 hours transitions to `Abandoned` (and its task → `Abandoned`). Implement via a deterministic check on each list query, not a background timer.
- Run creation preconditions (enforced in `POST /api/runs` before spawn): project exists & not archived, parent repo clean, target branch free, worktree path free, global concurrency cap not hit. Reject with `MaisterError('PRECONDITION', …)` if any check fails — never spawn against a dirty repo.
- **task ↔ run is 1:N**: a task may spawn many runs over its lifetime (retry / ralph-loop). `tasks.latest_run_id` points at the current attempt; each run has a monotonic `attempt_number` per task starting at 1.
- **Task lifecycle**: new task → `Backlog`. Launch click → preconditions → run spawned → task → `InFlight`. Latest run merged → task → `Done` (terminal). Latest run `Failed | Abandoned` → task auto-returns to `Backlog` (Launch reappears). Only an explicit "Discard task" UI action sets task → `Abandoned` (terminal). Run-level abandon is **not** task-level abandon.
- **Board interaction**: a Backlog task card carries a **Launch** button; click triggers `POST /api/runs` with `taskId` + `flowId`. There is **no drag-and-drop** in POC — the button is the only entry point.
- Concurrency cap for POC: `MAISTER_MAX_CONCURRENT_RUNS=3` (env-configurable, **global** across projects). Runs above the cap enter `Pending` and auto-promote when a slot frees. The UI surfaces queue position. No per-project sub-cap.
- Single executor, hard-coded: Claude Code only. No `ExecutorAdapter`, no `FlowAdapter`, no plugin loader. Refactor only when a real second executor appears.
- Crash recovery on Next.js startup: reconcile the `runs` table vs `git worktree list` **per registered project**. `Running` rows with no live PID become `Crashed`, and the UI surfaces "Recover or discard" on the relevant project board and the portfolio card.
- Use `git merge --no-ff` for run merges. On conflict, abort the merge cleanly and surface `MaisterError('CONFLICT', …)`; the run stays in `Review` and the UI tells the user to resolve manually. No auto-resolve.
- GC: a cron Route Handler (`/api/cron/gc`) removes `Abandoned/Done` worktrees older than 7 days across all projects. Triggered externally (cron job or scheduled fetch), not via setInterval.
- `maister.yaml` v1: `project` block + `flows[]`. Validate `schemaVersion` strictly and refuse to register on mismatch, on duplicate `flows[].id`, or on a Flow command missing `{prompt}`/`{workspace_path}` placeholders. Do not silently migrate.
- Project registration: register N projects via `POST /api/projects` (path to dir containing `maister.yaml`) or `MAISTER_PROJECTS_DIR` env **recursive** auto-discovery on startup. Slug derived from `project.name` (kebab-case). Both `slug` and `repo_path` are unique across registered projects (one repo = one project). Collisions on either column reject the registration with `MaisterError({code: 'CONFLICT'})`. Auto-discovery skips collisions with a logged warning (no hard crash). Project archival is soft (`archived_at`); no hard delete in POC; archived `repo_path` stays reserved.
- Server-only secrets: read API keys and tokens from `.env` server-side only. Never log them, never include them in SSE payloads, never expose them in subprocess argv visible to the frontend.
- Suggested layering inside `web/lib/`, lowest first: `errors` → `atomic` → `config` → `db` → `projects` → `worktree` → `scheduler` → `runner` → `reconcile`. A lower module never imports a higher module.
- `web/lib/*` modules are server-only. Add a top-level `import 'server-only'` to any module that must never be bundled for the browser.
- Route Handlers stay thin: validate input, call into `web/lib/*`, format the response. Do not put orchestration logic, subprocess spawning, or `execSync` calls in `app/api/*/route.ts`.
- If two Route Handlers need shared logic, extract it into `web/lib/`. Do not call one Route Handler from another.
- Out-of-POC scope is real: AI-Judge, background agents (reviewer/log/dependency), Telegram, A/B parallel runs, multi-executor pool, adapter interface, durable orchestration, auth/multi-user/RBAC, Flow designer UI, event log table, full Kanban (Done as drag-target / WIP limits / swim-lanes), syntax highlighting in diff view, skills invocation, project archival UI, cross-project task moves, external issue-tracker sync, project lesson capture. Push back with "out of POC scope" and link `docs/kaa-maister-design-20260522-174429.md` §"Out of POC (explicit)".
