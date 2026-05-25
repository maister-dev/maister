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
supervisor/  # NOT scaffolded yet — separate Node daemon hosting ACP sessions
.agents/     # codex agent bundles (do not hand-edit)
.codex/      # codex skills + config.toml
.claude/     # claude skills + agents (do not hand-edit; manage via /aif tooling)
.mcp.json    # MCP servers: github, filesystem, postgres, chromeDevtools, playwright
.ai-factory.json
.gitignore   # already configured for Next.js (.next/, node_modules/, .env*.local)
LICENSE      # MIT, Albert Kanischev, 2026
```

Backend split (none of it scaffolded yet, only web slice exists):
- `web/` — Next.js (UI + Route Handlers + Drizzle + server actions). NO
  long-running agent processes live here.
- `supervisor/` — separate Node daemon. Owns ACP sessions, spawns agent
  processes (`claude`, `codex`), heartbeat, checkpoint+resume. Reachable
  from Next.js over HTTP+SSE; can run on a different host than the web tier.

## How to run

```bash
cd web && pnpm install     # first time
cd web && pnpm dev         # http://localhost:3000
cd web && pnpm build && pnpm start
cd web && pnpm lint        # eslint --fix
```

Detailed code structure, conventions, HeroUI patterns: **`web/CLAUDE.md`**.

## Stack (locked — Approach B, post-ACP revision)

- **Framework**: Next.js 16+ App Router, server actions + RSC where it fits.
- **Lang**: TypeScript end-to-end. Python only when a specific Flow plugin
  ships Python CLIs (no longer mandatory in the container).
- **DB**: Postgres 16 primary (docker compose, named volume). SQLite via
  Drizzle dialect switch (`DB_URL=file:./dev.db`) for ultra-light dev only.
- **ORM**: Drizzle. SQL-flavored, JOOQ-like mental model. Do not swap for Prisma.
- **UI**: HeroUI v3 (Tailwind4-based). No other component lib.
- **i18n**: EN + RU from day one (REQUIRED per `web/CLAUDE.md`).
- **Agent runtime**: ACP (Zed-spec, vendor-neutral
  `@agentclientprotocol/sdk@0.22.1`) hosted by `supervisor/`.
  Per-agent adapter binaries: `claude-agent-acp` (from
  `@agentclientprotocol/claude-agent-acp@0.37.0`, wraps
  `@anthropic-ai/claude-agent-sdk@0.3.146`) and `codex-acp` (from
  `@agentclientprotocol/codex-acp@0.0.44`, bundles
  `@openai/codex@^0.128.0`). Supervisor spawns one adapter process per
  active session via Node `child_process.spawn`. Live process held
  across `NeedsInput` for up to 30 min (extended by web-console
  activity, env-tunable via `MAISTER_KEEPALIVE_MINUTES`); checkpoints
  by graceful exit (Claude Code's own JSONL session store at
  `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl` IS the checkpoint),
  respawned via `--resume <session-id>`. ⚠ Each respawn costs
  ~$0.28 cache_creation tokens.
- **Model routing**: Two modes supported. **(a) env-router** — set
  `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` in `executor.env` for
  single Anthropic-API-compatible third-party provider (z.ai GLM:
  `https://api.z.ai/api/anthropic`; OpenRouter; anyscale; etc.).
  Default and simplest. **(b) CCR**
  (`@musistudio/claude-code-router@2.0.0`, MIT) — optional, bundled for
  intelligent multi-provider routing within one session. Marked
  `router: ccr` on the executor.
- **Git**: thin worktree wrapper around `git worktree add/remove/list`.
- **Live updates**: SSE — supervisor publishes `session/update` events;
  Next.js Route Handler bridges to the browser at `/api/runs/[id]/stream`
  with `lastEventId` reconnect.
- **IPC Next.js ↔ supervisor**: HTTP+SSE (supervisor may run on a
  different host).
- **Flow plugins**: git repos pinned by tag (`v1.2.3`); installed system-wide
  to `~/.maister/flows/<id>@<tag>/` and symlinked into each consuming
  project's `.maister/<slug>/flows/`.
- **Tests**: vitest (unit/integration), playwright (E2E).
- **Pkg mgr**: pnpm.

## Architectural decisions you cannot quietly walk back

These were earned in two review passes. Reopen them only with new evidence.

### 1. ACP-driven execution with hybrid HITL (keep-alive + checkpoint+resume)

A Flow = sequence of **steps** typed `cli | agent | guard | human`, parsed
from the Flow plugin's `flow.yaml` manifest. `agent` steps run as ACP
sessions hosted by `supervisor/`, which spawns one agent process
(`claude`, `codex`) per active session. State transitions are driven by
**ACP notifications** (`session/update`, `session/request_permission`) on
the live path AND by **artifact presence** (`needs-input.json`) on the
durable / recovery path. Both signals coexist by design (hybrid).

HITL lifecycle:
- Agent emits `session/request_permission` (binary approve/deny) OR writes
  `.maister/<project-slug>/runs/<run-id>/needs-input.json` (structured
  form from JSON Schema). `human`-typed steps go through the artifact
  path with a richer `on_reject` flow that loops back to a `goto_step`.
- Run state → `NeedsInput`. The ACP session stays live for up to **30
  minutes**. Each web-console activity from the user (opening the run
  page, focusing it, typing in the form) **extends the window by 30
  minutes**, so an active human review never gets timed out mid-thought.
- On idle timeout → graceful checkpoint (the agent persists session state
  via its own session store on disk) → process exits → run state
  `NeedsInputIdle`. `runs.acp_session_id` is the resume handle.
- User submits a response → atomic write of `input-<step-id>.json` via
  `atomicWriteJson` → if the worker is still live, supervisor delivers an
  ACP message; if checkpointed, supervisor re-spawns the agent process
  with `--resume <session-id>` and the agent reads the input artifact.
- TTL 24h in `NeedsInputIdle` without user response → `Abandoned`.

**Do not** introduce `fs.watch`, `chokidar`, or polling for state
transitions. The live path is ACP notifications (kernel-level fd events
inside the supervisor); the recovery path is supervisor-side heartbeat +
artifact check on resume.

### 2. SSE pipe-to-disk

Supervisor streams every ACP `session/update` event line to
`.maister/<project-slug>/runs/<run-id>/<step-id>.log` via
`fs.createWriteStream` **in parallel** with the SSE emission to its HTTP
clients. Next.js Route Handler (`/api/runs/[id]/stream`) tails the file —
required so neither the supervisor nor the web tier OOMs on >10MB step
output, and so reconnect via `lastEventId` works without replaying from
memory.

### 3. Typed error taxonomy (`lib/errors.ts`)

`MaisterError extends Error` with discriminated `code`:
`PRECONDITION | SPAWN | NEEDS_INPUT | HITL_TIMEOUT | CRASH | CONFLICT |
CONFIG | EXECUTOR_UNAVAILABLE | FLOW_INSTALL | ACP_PROTOCOL | CHECKPOINT`.
UI branches on `code`, never on string matching. No string-matched errors.

### 4. Concurrency cap

`MAISTER_MAX_CONCURRENT_RUNS=3` for POC (env-configurable). Cap is **global**
across all projects, not per-project. Runs above the cap go to `Pending` and
auto-start when a slot frees. UI shows queue position. Hard cap (no override
from `maister.yaml`) — keeps RAM/token spend bounded on a single host.

### 5. Multi-executor via ACP (claude + codex on POC)

ACP standardizes the agent surface via vendor-neutral
`@agentclientprotocol/sdk`. On POC both `claude` and `codex` are
required, spawned by `supervisor/` via per-agent adapter binaries:
- `claude` → `claude-agent-acp` (from
  `@agentclientprotocol/claude-agent-acp`, wraps
  `@anthropic-ai/claude-agent-sdk`)
- `codex` → `codex-acp` (from `@agentclientprotocol/codex-acp`, bundles
  `@openai/codex`)

Cursor and other ACP-capable agents land in Phase 2 once the registry
shape is proven. The executor identity is
`{agent, model, env?, router?}` persisted in the `executors` table and
referenced from `runs.executor_id`.

Model routing:
- **env-router** (default, no extra dep) — set `ANTHROPIC_BASE_URL`
  + `ANTHROPIC_AUTH_TOKEN` in `executor.env` for any
  Anthropic-API-compatible provider (z.ai GLM, OpenRouter, anyscale).
- **CCR** (`router: ccr`, optional) — for intelligent multi-provider
  routing within one session, via
  `@musistudio/claude-code-router@2.0.0` (MIT).

Per-step executor override resolution (highest priority wins):
1. Run launcher override (set at Launch click, optional).
2. Project override in `maister.yaml` `flows[<id>].executor_override`.
3. Project `default_executor`.
4. Flow's `recommended_executor` in `flow.yaml` (optional, may be unset).

### 6. Flow Engine v2: plugin packaging + step DSL

Flows are **plugin bundles** — git repos with a manifest (`flow.yaml`),
shipped CLIs, optional `setup.sh`, skills, agents, and a step-typed YAML
DSL. Installed system-wide to `~/.maister/flows/<id>@<tag>/` and symlinked
into each consuming project's `.maister/<slug>/flows/`. Version-pinned by
git tag in the project's `maister.yaml`.

`maister.yaml` v2 (project-level):

```yaml
schemaVersion: 2
project:
  name: myapp
  repo_path: /repos/myapp
  main_branch: main
  branch_prefix: maister/
executors:
  - id: claude-sonnet
    agent: claude
    model: claude-sonnet-4-6
  - id: claude-glm-ccr
    agent: claude
    model: glm-4.6
    router: ccr
  - id: codex-default
    agent: codex
    model: gpt-5-codex
default_executor: claude-sonnet
flows:
  - id: bugfix
    source: github.com/<org>/maister-flow-bugfix
    version: v1.2.3                    # tag-pinned (lock semantics)
  - id: spec-kit
    source: github.com/<org>/maister-flow-spec-kit
    version: v0.4.1
    executor_override: claude-glm-ccr  # optional per-flow override
```

Flow manifest (`flow.yaml` inside the plugin):

```yaml
schemaVersion: 1
name: Bugfix
recommended_executor: claude-sonnet    # optional
setup: ./setup.sh                      # optional one-time install script
steps:
  - id: plan
    type: agent
    mode: new-session                  # or slash-in-existing
    prompt: "/aif-plan {{ task.prompt }}"
    pre_guards: []                     # cost/time/regex on POC = metric-only
    post_guards: []
  - id: review
    type: human
    form_schema: ./schemas/review.json
    on_reject:
      goto_step: plan
      comments_var: review_comments
```

Project `slug` is derived from `project.name` (kebab-cased). Both `slug`
and `repo_path` are unique across registered projects. Refuse to register
on: `schemaVersion` mismatch (project file or any installed Flow's
manifest), duplicate IDs within either file, unknown
`executor`/`executor_override` reference, unknown `goto_step` target,
slug collision, `repo_path` collision. Trust the Flow's `setup.sh` on
first install (POC = internal Flow sources only; sandboxing + trust UI
is Phase 2).

Templating: full Mustache-style interpolation with session context, task
fields, per-step output vars, executor metadata — required for
observability traces.

### 7. Workspace lifecycle

- Workspace artifacts live under `.maister/<project-slug>/runs/<run-id>/`
  (logs per step, `needs-input.json`, `input-<step-id>.json`, `cost.jsonl`,
  `session.json` with `acp_session_id` + `executor_id`). One isolated
  subtree per project — no cross-project bleed.
- On `POST /api/runs`: preconditions (project exists & active, clean parent
  repo, branch free, worktree path free, global concurrency cap not hit,
  selected executor registered & available) → `git worktree add` →
  `POST /sessions` to supervisor.
- On Next.js + supervisor startup: reconcile `runs` table vs
  `git worktree list` **per project** and vs supervisor's live session set.
  `Running` rows with no live ACP session and no checkpoint → `Crashed`,
  surface "Recover or discard". `NeedsInputIdle` rows with a valid
  `acp_session_id` checkpoint stay valid.
- Cron route GCs `Abandoned/Done` worktrees + checkpointed sessions older
  than 7d across all projects.

### 8. Merge policy

`git merge --no-ff` on parent's `main_branch`. Conflict → abort, run stays
`Review`, UI surfaces "Conflict — resolve manually" with parent repo path.
No auto-resolve.

## POC scope (what we build)

- **Multi-project registry**: N projects per host, each configured by its own
  `maister.yaml` v2. Registration via UI form (path to dir containing
  `maister.yaml`) or `MAISTER_PROJECTS_DIR` env auto-discovery (**recursive**
  scan; every `maister.yaml` under the root gets registered, slug/repo
  collisions are rejected).
- **Flow plugin engine**: install plugins from `git URL + tag` to
  `~/.maister/flows/<id>@<tag>/` system cache; symlink into each consuming
  project's `.maister/<slug>/flows/`. Manifest (`flow.yaml`) is the source
  of step DSL. Trust all sources on POC (internal Flows only).
- **Multi-executor via ACP**: `claude` and `codex` both required on POC.
  Per-step executor override resolution per §5. CCR support bundled.
- **`supervisor/` daemon**: separate Node process owning ACP sessions,
  process-per-session spawn, heartbeat, graceful checkpoint+resume,
  cost-token metric on disk. Talks HTTP+SSE to Next.js (may live on a
  different host).
- **Project portfolio (home)**: superset.sh-style grid of every active
  workspace across all projects — project · branch · status · last activity ·
  executor · quick actions (View / Resume / Abandon). Filters by project +
  status. "Needs you (N)" badge counts pending HITL across all projects.
- **Per-project task board**: 2 columns — **Backlog** | **In Flight**. In
  Flight bucket holds `Running | NeedsInput | NeedsInputIdle | Review |
  Crashed`. A task card in Backlog has a **Launch** button (no drag-and-drop
  in POC); click = precondition checks → create Run → task moves to In
  Flight. Done/Abandoned surface in a filter tab, not as additional columns.
- **HITL Inbox block**: dedicated panel on the per-project board listing
  pending `NeedsInput`/`NeedsInputIdle` requests (in-card form + send-back-
  with-comments flow for `human`-typed steps).
- **Task ↔ Run cardinality is 1:N**: one task can spawn many runs over its
  lifetime (retry loop / "ralph-loop"-friendly). If a run terminates with
  `Failed | Crashed | Abandoned`, the task auto-returns to `Backlog` and
  the Launch button re-appears — the user can fire another run against the
  same task without recreating it. Latest run is the one shown on the card.
- **Task creation**: title + prompt + Flow dropdown + optional executor
  override (populated from the project's `flows[]` and `executors[]`).
- **i18n**: EN + RU from day one.
- **ACP-driven HITL**, **SSE pipe-to-disk**, **typed errors**,
  **multi-executor**, **`maister.yaml` v2 + Flow plugins**, **worktree
  lifecycle**, **merge policy** — see §1-8 above.
- **Concurrency**: global cap = 3 (env-configurable). Queue + position badge.

## Out of POC scope (do not build, do not propose)

Flow designer UI · background agents (reviewer/log/dependency) · Telegram ·
A/B parallel runs · durable orchestration · auth/multi-user/RBAC · AI-Judge
(only design in DSL — implementation Phase 2) · full Kanban (Done as
drag-target / WIP limits / swim-lanes) · event log table · test-run UI button
· GitHub Actions CI/CD · syntax highlighting in diff view · project archival
UI (DB has `archived_at`, no button) · cross-project task moves · GitHub
issue / Linear / YouGile sync · **custom ACP extensions** (Stage 1 = Zed
standard only — structured-form HITL goes via artifact) · **cost/time/regex
guard enforcement** (parse-and-persist as metrics only on POC — no
kill-on-cap) · **Plugin trust UI / sandboxing** (trust all internal sources
on POC) · **HITL as separate swimlane cards** (POC = badge + Inbox block in
existing board) · **per-step `new-session-per-step` agent mode** is IN POC
alongside `slash-in-existing-session` · **Cursor / opencode / Aider
executors** (POC = claude + codex only via ACP).

If a task adds any of the above, push back with "out of POC scope" and link
to `docs/kaa-maister-design-20260522-174429.md` §"Out of POC (explicit)".

## Conventions

- **Errors**: throw `MaisterError` with `code`, never plain `Error` for known
  domain failures. See §3 above.
- **Atomic writes** to `.maister/`: always tmp + rename via `atomicWriteJson`.
  Never partial-write a JSON the Flow / agent will read.
- **SSE messages**: one per ACP `session/update` event line. Include
  monotonic `id` for `lastEventId` reconnect.
- **Agent process lifetime**: spawned and owned by `supervisor/`, NOT by
  Next.js. Lives across `NeedsInput` keep-alive (≤30 min, extended by
  user activity), checkpoints on idle timeout, respawns via
  `--resume <session-id>` on resume.
- **Server-only secrets**: API keys read from `.env` server-side (Next.js)
  or supervisor-side. Never logged, never streamed, never sent to client.
  Never embedded in ACP `session/update` payloads visible to the browser.
- **TypeScript**: strict mode. No `any` in committed code unless flagged with
  a `// FIXME(any):` comment.
- **No comments explaining WHAT** — names should do that. Only add comments
  for non-obvious WHY (invariants, workarounds, surprising constraints).
- **Surgical changes**: every changed line traces to the request. Don't refactor
  adjacent code "while you're there".

## M0 spike findings (2026-05-25 — completed)

Full report: **`docs/kaa-maister-m0-spike-findings-20260525.md`**.

1. ✅ **ACP packages pinned**: `@agentclientprotocol/claude-agent-acp@0.37.0`
   + `@agentclientprotocol/codex-acp@0.0.44` + `@agentclientprotocol/sdk@0.22.1`
   (all Apache-2.0). Canonical npm org `@agentclientprotocol`,
   GitHub: `github.com/agentclientprotocol`. The `@zed-industries/*` name
   was deprecated — moved to vendor-neutral org. Both adapters ship a CLI
   binary (`claude-agent-acp`, `codex-acp`). Underlying SDK is
   `@anthropic-ai/claude-agent-sdk@0.3.146` (NOT the `@anthropic-ai/claude-code`
   CLI package).
2. ✅ **Cross-process resume verified live**. `claude --session-id <uuid>` +
   `claude --resume <uuid>` from a fresh process returns the prior context
   ("ALBATROSS-42" round-trip). Sessions persist at
   `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl`, append-only, survive
   parent-process kill. **`runs.acp_session_id` is sufficient as the
   checkpoint handle — no separate checkpoint format needed.**
3. ✅ **Codex** has no native ACP, but `codex-acp` adapter (bundles its own
   `@openai/codex@^0.128.0`) exposes the same wire protocol as
   `claude-agent-acp`. Supervisor `spawn.ts` dispatches on
   `executor.agent` to pick the right binary.
4. ✅ **z.ai GLM works as plain env-router** — no CCR needed for
   single-provider routing. Set
   `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` +
   `ANTHROPIC_AUTH_TOKEN=<key>` in `executor.env`. CCR
   (`@musistudio/claude-code-router@2.0.0`, MIT) is for intelligent
   multi-provider routing in one session — keep optional.
5. ⚠ **NEW: cache-creation cost per respawn** (~$0.28 of cache_creation
   tokens on each cross-process resume — cache key does NOT survive
   process boundary even within 5-min Anthropic prompt-cache TTL). The
   30-min keep-alive in §1 is cost-saving, not just UX. Surface
   `MAISTER_KEEPALIVE_MINUTES` env var for ops tuning.

**Remaining loose ends** (not blocking M1):
- **tausik** — repo URL still TBD; defer to Phase 2.
- **External validation** — 3 installations target. Friend names not
  required in advance.

## Success criteria (POC, T+4 to T+5 weeks post-scope-expansion)

End-to-end: ≥2 projects registered via `maister.yaml` v2 (each pulling ≥2
Flow plugins from git URLs by tag) → portfolio home shows active workspaces
from both → task created from the project board with executor selected
from project `executors[]` → Launch click → worktree created with
precondition checks → supervisor spawns Claude Code OR Codex as an ACP
session, `session/update` events stream to UI → at least one HITL round-trip
works for both flavors (binary approve/deny via `session/request_permission`
AND structured form via artifact) → NeedsInput keep-alive extends on web
activity → on idle timeout, run checkpoints to `NeedsInputIdle`; user
response respawns via `--resume` → diff visible → merge-to-main works on
clean-merge case → run survives Next.js restart AND supervisor restart with
`Crashed` reconciliation → 3 concurrent runs scheduled across projects, 4th
queues with position badge → retry loop works (Failed/Abandoned run → task
back to Backlog → Launch again → attempt N+1) → per-step executor override
verified on at least one Flow.

Dogfood (T+5 to T+6w): register MAIster repo in itself, run a Flow against
its own backlog, ship ≥1 non-trivial PR.

External validation (T+8w): 3 installations on external repos, ≥1 PR
shipped end-to-end through MAIster on each. 0/3 → thesis not validated,
reassess wedge.

## Where to read next

- `web/CLAUDE.md` — Web UI slice: stack details, scripts, structure, conventions.
- `docs/VISION.md` — one-liner, principles, MVP goal.
- `docs/PRODUCT_VIEW.md` — Lean Canvas, JTBD, gaps, MVP / Phase 2 / Later.
- `docs/kaa-maister-design-20260522-174429.md` — locked design, stack
  rationale, HITL protocol, success criteria, reviewer concerns.
- `docs/kaa-maister-eng-review-test-plan-20260522-180855.md` — routes, key
  interactions, edge cases, critical paths.

When this file disagrees with `docs/`, `docs/` wins — update this file.
