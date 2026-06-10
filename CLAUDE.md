# CLAUDE.md — MAIster

## What this is

**MAIster is the control plane for AI-powered software delivery.**

Product spine:

```
Project -> Flow package -> Task -> Run -> Workspace -> Headless Agents -> HITL -> Evidence Gates -> Review -> Promote
```

Current wedge:
**Web control plane + ACP supervisor daemon + Flow plugin engine** for
multi-project portfolio, multi-workspace execution, HITL, and a per-project
task board. We orchestrate and wrap existing agents and Flow frameworks.

Audience: solo-technical CEO/CIO/staff-eng

## Repo state right now

```
docs/        # Product, architecture, API contracts, DB docs, analytics
web/         # Next.js 16 + React 19 + HeroUI v3 app — see web/CLAUDE.md
supervisor/  # Fastify daemon hosting ACP sessions
.agents/     # codex agent bundles (do not hand-edit)
.codex/      # codex skills + config.toml
.claude/     # claude skills + agents (do not hand-edit; manage via /aif tooling)
.mcp.json    # MCP servers: github, filesystem, postgres, chromeDevtools, playwright
.ai-factory.json
.gitignore   # already configured for Next.js (.next/, node_modules/, .env*.local)
LICENSE      # MIT, Albert Kanischev, 2026
```

Backend split:
- `web/` — Next.js (UI + Route Handlers + Drizzle + server actions). NO
  long-running agent processes live here.
- `supervisor/` — separate Node daemon. Owns ACP sessions, spawns agent
  processes (`claude`, `codex`), heartbeat, and permission input delivery. Reachable
  from Next.js over HTTP+SSE; can run on a different host than the web tier.

## How to run

```bash
pnpm install --frozen-lockfile
pnpm --filter @maister/supervisor dev  # http://localhost:7777
pnpm --filter maister-web dev          # http://localhost:3000
pnpm --filter maister-web lint
```

Detailed code structure, conventions, HeroUI patterns: **`web/CLAUDE.md`**.

## Stack

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
  active session via Node `child_process.spawn`. Permission HITL is
  resolved live. Checkpoint/resume is implemented: a fresh adapter process
  is spawned and the prior conversation is restored via the ACP
  `session/resume` protocol call on `runs.acp_session_id` (NOT a `--resume`
  CLI flag — both adapters ignore that on argv; `session/resume` restores
  context without replaying history). Each respawn costs roughly `$0.28`
  cache_creation tokens.
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

### 1. ACP-driven execution with hybrid HITL

A Flow = a typed-node **graph** (`nodes[]`, canonical at runtime) — node
types `ai_coding | judge | cli | check | human`, wired by named
`transitions` with bounded `rework` loops — OR a legacy linear `steps[]`
list (`cli | agent | guard | human`); both parse from the `flow.yaml`
manifest and compile to one `FlowGraph`
(see `docs/flow-dsl.md` + `docs/system-analytics/flow-graph.md`).
`ai_coding`/`agent` nodes run as ACP sessions hosted by `supervisor/`,
which spawns one agent process (`claude`, `codex`) per active session. State transitions are driven by
**ACP notifications** (`session.update`, `session.permission_request`) on
the live path and by durable input artifacts for form/human responses.

HITL lifecycle:
- Agent emits ACP `requestPermission` or the runner reaches a form/human
  step. The runner persists a `hitl_requests` row before the run enters
  `NeedsInput`.
- User submits through `POST /api/runs/{runId}/hitl/{hitlRequestId}/respond`.
  Permission responses store `{optionId}` and resolve supervisor
  `/sessions/:id/input`; form/human responses write
  `input-<step-id>.json` via `atomicWriteJson`.
- The response route never flips `runs.status` back to `Running`; the
  runner owns `NeedsInput -> Running`.
- The idle checkpoint path (`NeedsInput -> NeedsInputIdle -> resume`) is
  implemented (M8): the web keep-alive sweeper idles `NeedsInput` rows past
  `keepalive_until`, the supervisor's real `POST /sessions/:id/checkpoint`
  cancels open permission deferreds and SIGTERMs the agent, and a stored HITL
  response respawns a fresh adapter and restores context via the ACP
  `session/resume` call on `acp_session_id`. The resume round-trip is
  exercised in CI via a mock ACP adapter; live-agent resume was verified in
  the M0 spike, not yet in CI.

**Do not** introduce `fs.watch`, `chokidar`, or polling for state
transitions. The live path is ACP notifications (kernel-level fd events
inside the supervisor); the recovery path is supervisor-side heartbeat +
artifact check on resume.

### 2. SSE pipe-to-disk

Supervisor writes raw step output to
`.maister/<project-slug>/runs/<run-id>/<step-id>.log` and appends structured
session events to `run.events.jsonl`. Next.js Route Handler
(`/api/runs/[id]/stream`) tails `run.events.jsonl`, so reconnect via
`lastEventId` works without replaying from memory.

### 3. Typed error taxonomy (`lib/errors.ts`)

`MaisterError extends Error` with discriminated `code`:
`PRECONDITION | SPAWN | NEEDS_INPUT | HITL_TIMEOUT | CRASH | CONFLICT |
CONFIG | EXECUTOR_UNAVAILABLE | FLOW_INSTALL | ACP_PROTOCOL | CHECKPOINT`.
UI branches on `code`, never on string matching. No string-matched errors.

### 4. Concurrency cap

`MAISTER_MAX_CONCURRENT_RUNS=3` by default (env-configurable). Cap is **global**
across all projects, not per-project. Runs above the cap go to `Pending` and
auto-start when a slot frees. UI shows queue position. Hard cap (no override
from `maister.yaml`) — keeps RAM/token spend bounded on a single host.

### 5. Platform ACP runners (claude + codex)

ACP standardizes the agent surface via vendor-neutral
`@agentclientprotocol/sdk`. Today both `claude` and `codex` are
required, spawned by `supervisor/` via per-agent adapter binaries:
- `claude` → `claude-agent-acp` (from
  `@agentclientprotocol/claude-agent-acp`, wraps
  `@anthropic-ai/claude-agent-sdk`)
- `codex` → `codex-acp` (from `@agentclientprotocol/codex-acp`, bundles
  `@openai/codex`)

Cursor and other ACP-capable agents land in Phase 2 once the registry
shape is proven. Runner identity is platform-scoped in
`platform_acp_runners`: `{adapter, capability_agent, model, provider,
permission_policy, sidecar?}`. Launches snapshot the effective runner into
`runs.runner_snapshot`; resume/recover reads the snapshot, not a mutable
catalog row.

Model routing:
- **provider config** — `anthropic`, `anthropic_compatible`, `openai`, and
  `openai_compatible` providers are runner config. Secret values are stored as
  `env:NAME` references only.
- **CCR sidecar** — for intelligent multi-provider Claude routing within one
  session, via
  `@musistudio/claude-code-router@2.0.0` (MIT).

Runner resolution (highest priority wins):
1. Launch override (set at Launch click, optional).
2. Flow step `settings.runner` target, remapped when imported if the platform
   does not have that runner id.
3. Project Flow default (`project_flow_runner_defaults`).
4. Platform Flow default (`flow_revisions.default_runner_id`).
5. Project default (`projects.default_runner_id`).
6. Platform default (`platform_runtime_settings.default_runner_id`).

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
  default_branch: main
  branch_prefix: maister/
  default_runner: claude-code
flows:
  - id: bugfix
    source: github.com/<org>/maister-flow-bugfix
    version: v1.2.3                    # tag-pinned (lock semantics)
    runner: claude-code                # optional project binding
  - id: spec-kit
    source: github.com/<org>/maister-flow-spec-kit
    version: v0.4.1
```

Flow manifest (`flow.yaml` inside the plugin):

```yaml
schemaVersion: 1
name: Bugfix
runner_profiles:
  claude-code:
    capability_agent: claude
    adapter: claude
    model: claude-sonnet-4-6
    provider:
      kind: anthropic
setup: ./setup.sh                      # optional one-time install script
steps:
  - id: plan
    type: agent
    mode: new-session                  # or slash-in-existing
    prompt: "/aif-plan {{ task.prompt }}"
    pre_guards: []                     # cost/time/regex are metric-only today
    post_guards: []
  - id: review
    type: human
    form_schema: ./schemas/review.json
    on_reject:
      goto_step: plan
      comments_var: review_comments
```

**Canonical runtime DSL = the typed-node graph (engine `1.3.0`), not linear
steps.** The `steps:` block above is the **legacy** linear DSL (still runs,
compiled to a degenerate success-chain). New flows use `nodes:` with named
`transitions`, bounded `rework`, typed `input.requires`/`output.produces`
artifacts (kind-matched, presence-enforced → `PRECONDITION`), six gate kinds
(`command_check | skill_check | ai_judgment | artifact_required |
external_check | human_review`, each `blocking | advisory`), a promotion-time
**readiness** gate, per-node capability `settings` + declared `enforcement`,
and per-capability engine-version floors. Legacy `guard` steps / `pre_guards`
/ `post_guards` stay metric-only; graph **gates** actually block. Flows are
also authorable **in-app** (`authored_capabilities`, draft→publish,
content-addressed, bridged into the same `flow_revisions` lineage) on the
**Flow Studio** visual graph editor (M25/M27). See
`docs/system-analytics/{flow-graph,artifacts,readiness,flow-studio}.md`.

Project `slug` is derived from `project.name` (kebab-cased). Both `slug`
and `repo_path` are unique across registered projects. Refuse to register
on: `schemaVersion` mismatch (project file or any installed Flow's
manifest), duplicate IDs within either file, unknown
`executor`/`executor_override` reference, unknown `goto_step` target,
slug collision, `repo_path` collision. Trust the Flow's `setup.sh` on
first install. Current target trusts internal Flow sources; sandboxing +
trust UI is Phase 2.

Templating: full Mustache-style interpolation (strict mode — unknown var
throws `CONFIG`) with session context, task fields, per-step output vars,
executor metadata. Note: structured agent/cli `vars` are not yet populated
(P1 roadmap); `{{ steps.<id>.output }}` carries stdout text today, only
`human` nodes emit structured `vars`.

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
  than 7d across all projects (now a `system_sweep` job of the polymorphic
  scheduler clock, M24).
- **Manual takeover** (M11b): a reviewer at a `human_review` node claims the
  run (`NeedsInput → HumanWorking`), edits the existing worktree locally on
  the host, and returns it for re-validation (downstream nodes go stale). No
  new branch/session. → `docs/system-analytics/manual-takeover.md`.
- **Workbench lifecycle** (M27): per-run `stop | archive | drop |
  snapshot-commit | export-branch | handoff-branch` to preserve/free work or
  hand a branch to a local dev. → `docs/system-analytics/workbench-lifecycle.md`.
- **Scratch runs**: ad-hoc conversational ACP session in a managed worktree
  (`run_kind=scratch`), outside the task board, reusing the run/HITL/diff/
  promote substrate. → `docs/system-analytics/scratch-runs.md`.

### 8. Promotion policy

After review/readiness gates pass, MAIster promotes the run branch to the
selected target branch. Initial promotion modes are `local_merge` and
`pull_request`. `local_merge` uses `git merge --no-ff`; conflict → abort, run
stays `Review`, UI surfaces "Conflict — resolve manually" with parent repo
path, run branch, target branch, and failing command. No auto-resolve.

## Current Scope

- **Multi-project registry**: N projects per host, each configured by its own
  `maister.yaml` v2. Registration via UI form (path to dir containing
  `maister.yaml`) or `MAISTER_PROJECTS_DIR` env auto-discovery (**recursive**
  scan; every `maister.yaml` under the root gets registered, slug/repo
  collisions are rejected).
- **Flow plugin engine**: install plugins from `git URL + tag` to
  `~/.maister/flows/<id>@<tag>/` system cache; symlink into each consuming
  project's `.maister/<slug>/flows/`. Manifest (`flow.yaml`) is the source
  of step DSL. Trust internal Flow sources today.
- **Multi-executor via ACP**: `claude` and `codex` both required.
  Per-step executor override resolution per §5. CCR support bundled.
- **`supervisor/` daemon**: separate Node process owning ACP sessions,
  process-per-session spawn, heartbeat, permission input delivery,
  cost-token metric on disk. Talks HTTP+SSE to Next.js (may live on a
  different host).
- **Project portfolio (home)**: superset.sh-style grid of every active
  workspace across all projects — project · branch · status · last activity ·
  executor · quick actions (View / Resume / Abandon). Filters by project +
  status. "Needs you (N)" badge counts pending HITL across all projects.
- **Per-project task board**: Kanban-**styled**. Task state is 4 values
  (`Backlog | InFlight | Done | Abandoned`), rendered as **7 derived columns**
  (`Backlog · Prepare · InProduction · OnReview · InDelivery · Crashed ·
  Done`). In-Flight covers `Running | NeedsInput | NeedsInputIdle |
  HumanWorking | Review | Crashed`. A Backlog card's **Launch** = precondition
  checks → create Run. **No drag-and-drop, no WIP limits** (full Kanban is
  Phase 2). → `docs/system-analytics/tasks.md`.
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
  lifecycle**, **promotion policy** — see §1-8 above.
- **Concurrency**: global cap = 3 (env-configurable). Queue + position badge.

## Built since the original baseline

This file was first written at the M8 (ACP/HITL) baseline; much shipped after.
Authoritative per-domain truth is in `docs/system-analytics/`. Beyond §1-8 +
Current Scope, these are **Implemented** today:

- **Graph flow engine** (M11a): typed-node graph, `node_attempts` ledger,
  gate execution, staleness, review-driven rework. → `flow-graph.md`
- **Typed artifacts + evidence graph** (M12): `artifact_instances`, validity
  FSM, produced-output enforcement. → `artifacts.md`
- **Capability materialization** (M14): per-session `settings.local.json` +
  ACP `mcpServers`, two-axis trust (`trust_status` + `exec_trust`); strict
  enforcement deferred (ADR-041). → `flow-settings.md`
- **Readiness gate** (M15): promotion gating over blocking gates + verdict
  calibration. → `readiness.md`
- **Observatory** (M23): read-only Autonomy Score, correction-rate, signal
  clusters. → `observatory.md`
- **Scheduler** (M24): one polymorphic cron tick (`system_sweep | command |
  agent_tick | flow_run | run_schedule`); user-facing task cron schedules
  shipped (M28) → `run-schedules.md`, `scheduler.md`
- **Authored catalog + Flow Studio** (M25/M27): in-app create/version of
  rules/skills/flows + visual graph editor; PR-to-catalog publication is
  roadmap E3. → `flow-studio.md`
- **Platform + project MCP & ACP-runner catalogs** (M27, ADR-065/070): CRUD
  + resolver precedence (project > platform > flow-package). → `acp-runners.md`
- **External operations API + project tokens + MCP facade** (M16/M17):
  `/api/v1/ext/*`, scoped tokens, HITL-over-MCP (`hitl_list`/`hitl_respond`).
  → `external-operations.md`

Product backlog/vision (not built): `docs/pv/improvement-roadmap.md` —
self-improvement loop, benchmarking, project memory, agents-as-actors.

## Phase 2 Candidates

These are not forbidden. They need an explicit implementation plan because
they change product surface, contracts, or operating model. (Items shipped
since the original list — visual Flow designer, diff syntax highlighting,
judge-node/`ai_judgment` gating — were removed; some below are partially
landed, see *Built since the original baseline*.)

background agents (reviewer/log/dependency) · Telegram ·
A/B benchmark runs · durable orchestration · full multi-user RBAC w/ action-
blocking · full Kanban (Done as drag-target / WIP limits / swim-lanes) ·
event log table · test-run UI button · GitHub Actions CI/CD · project
archival UI · cross-project task moves · GitHub issue / Linear / YouGile
sync · custom ACP extensions · cost/time/regex guard enforcement · plugin
sandboxing · HITL as separate swimlane cards · Cursor / opencode / Aider
executors · outbound webhooks (deferred in favor of agent-over-MCP).

## Conventions

- **Errors**: throw `MaisterError` with `code`, never plain `Error` for known
  domain failures. See §3 above.
- **Atomic writes** to `.maister/`: always tmp + rename via `atomicWriteJson`.
  Never partial-write a JSON the Flow / agent will read.
- **SSE messages**: one per ACP `session/update` event line. Include
  monotonic `id` for `lastEventId` reconnect.
- **Agent process lifetime**: spawned and owned by `supervisor/`, NOT by
  Next.js. Permission HITL stays live through supervisor deferreds.
  Checkpoint/idle resume is implemented via the ACP `session/resume` protocol
  call on `acp_session_id` (not a `--resume` CLI flag).
- **Server-only secrets**: API keys read from `.env` server-side (Next.js)
  or supervisor-side. Never logged, never streamed, never sent to client.
  Never embedded in ACP `session/update` payloads visible to the browser.
- **TypeScript**: strict mode. No `any` in committed code unless flagged with
  a `// FIXME(any):` comment.
- **No comments explaining WHAT** — names should do that. Only add comments
  for non-obvious WHY (invariants, workarounds, surprising constraints).
- **Surgical changes**: every changed line traces to the request. Don't refactor
  adjacent code "while you're there".

## ACP Spike Findings (Current Baseline)

1. ✅ **ACP packages pinned**: `@agentclientprotocol/claude-agent-acp@0.37.0`
   + `@agentclientprotocol/codex-acp@0.0.44` + `@agentclientprotocol/sdk@0.22.1`
   (all Apache-2.0). Canonical npm org `@agentclientprotocol`,
   GitHub: `github.com/agentclientprotocol`. The `@zed-industries/*` name
   was deprecated — moved to vendor-neutral org. Both adapters ship a CLI
   binary (`claude-agent-acp`, `codex-acp`). Underlying SDK is
   `@anthropic-ai/claude-agent-sdk@0.3.146` (NOT the `@anthropic-ai/claude-code`
   CLI package).
2. ✅ **Cross-process resume**. The M0 spike verified the raw CLI
   (`claude --session-id <uuid>` + `claude --resume <uuid>` returns prior
   context, "ALBATROSS-42" round-trip). Sessions persist at
   `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl`, append-only, survive
   parent-process kill. **`runs.acp_session_id` is sufficient as the
   checkpoint handle — no separate checkpoint format needed.** ⚠ Adapter
   caveat (found in dogfooding 2026-06-08): the **ACP adapter** does NOT
   resume via the `--resume` CLI flag — its binary ignores argv flags. The
   supervisor resumes at the protocol level with the ACP `session/resume`
   call (restores context, no history replay; both bundled adapters advertise
   `sessionCapabilities.resume`). Calling `session/new` on resume silently
   creates an EMPTY session and orphans the conversation — the original bug.
   See `supervisor/src/acp-client.ts`.
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
5. ⚠ **Cache-creation cost per respawn** (~$0.28 of cache_creation
   tokens on each cross-process resume — cache key does NOT survive
   process boundary even within 5-min Anthropic prompt-cache TTL). The
   30-min keep-alive in §1 is cost-saving, not just UX. Surface
   `MAISTER_KEEPALIVE_MINUTES` env var for ops tuning.

**Remaining loose ends**:
- **tausik** — repo URL still TBD; defer to Phase 2.
- **External validation** — 3 installations target. Friend names not
  required in advance.

## Success Criteria

End-to-end: at least 2 projects registered via `maister.yaml` v2 (each pulling at least 2
Flow plugins from git URLs by tag) → portfolio home shows active workspaces
from both → task created from the project board with executor selected
from project `executors[]` → Launch click → worktree created with
precondition checks → supervisor spawns Claude Code OR Codex as an ACP
session, `session/update` events stream to UI → at least one HITL round-trip
works for both flavors (binary approve/deny via `session/request_permission`
AND structured form via artifact) → NeedsInput keep-alive extends on web
activity → on idle timeout, run checkpoints to `NeedsInputIdle`; user
response respawns + resumes via `session/resume` → diff visible → branch-targeted promotion
works on clean local-merge or PR case → run survives Next.js restart AND supervisor restart with
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
- `docs/architecture.md` — current system shape and data flows.
- `docs/decisions.md` — ADRs and locked technical choices.
- `docs/api/` — OpenAPI and AsyncAPI contracts.
- `docs/system-analytics/` — domain-specific process docs and diagrams.

When this file disagrees with `docs/`, `docs/` wins — update this file.
