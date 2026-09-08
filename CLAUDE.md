# CLAUDE.md — MAIster

## What this is

**MAIster is the self-hosted execution and governance layer for reproducible
AI-powered SDLC processes over private code.**

What it does, the challenges it answers, and the core functions are the
canonical short description in [README](README.md) (section "What MAIster
does"). The product spine, principles, and validation goal live in
[`docs/VISION.md`](docs/VISION.md); the detailed product model and JTBD in
[`docs/PRODUCT_VIEW.md`](docs/PRODUCT_VIEW.md). What follows here is the
agent-facing operating contract — locked decisions and current scope.

Audience: a technical owner or small engineering team operating multiple
private repositories and coding agents.

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
  processes through the platform ACP runner registry, heartbeat, and
  permission input delivery. Reachable
  from Next.js over HTTP+SSE. Both processes share the host filesystem
  (ADR-023) — a different host for the supervisor is not supported today;
  ADR-166 (Implemented) makes the supervisor a registered _execution host_
  behind `web/lib/execution-host/` so later stages can move it.

## How to run

```bash
pnpm install --frozen-lockfile
docker compose up -d                        # Postgres (pgvector/pgvector:pg16)
pnpm --filter maister-web db:migrate        # main migration lineage
pnpm --filter maister-web db:migrate:brain  # brain lineage (ADR-122)
pnpm --filter @maister/supervisor dev  # http://localhost:7777
pnpm --filter maister-web dev          # http://localhost:3000
pnpm --filter maister-web lint
```

Detailed code structure, conventions, HeroUI patterns: **`web/CLAUDE.md`**.

## Stack

- **Framework**: Next.js 16+ App Router, server actions + RSC where it fits.
- **Lang**: TypeScript end-to-end. Python only when a specific Flow plugin
  ships Python CLIs (no longer mandatory in the container).
- **DB**: Postgres 16 only (docker compose, named volume).
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
- **Model routing**: set
  `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` in `executor.env` for
  single Anthropic-API-compatible third-party provider (z.ai GLM:
  `https://api.z.ai/api/anthropic`; OpenRouter; anyscale; etc.).
- **Git**: thin worktree wrapper around `git worktree add/remove/list`.
- **Live updates**: SSE — supervisor publishes `session/update` events;
  Next.js Route Handler bridges to the browser at `/api/runs/[id]/stream`
  with `lastEventId` reconnect.
- **IPC Next.js ↔ supervisor**: HTTP+SSE through `web/lib/execution-host/`
  (Implemented — ADR-166: durable host identity, per-run epoch-fenced
  assignments, enveloped command ledger, opaque adopted-workspace handles);
  the supported single-host deployment still shares repository/worktree
  material until Stage C, but the Stage B event and runtime-data plane is
  path-free (ADR-167).
- **Flow plugins**: git repos pinned by tag (`v1.2.3`); installed system-wide
  to `~/.maister/flows/<id>@<tag>/` and symlinked into each consuming
  project's `.maister/<slug>/flows/`.
- **Tests**: vitest (unit/integration), playwright (E2E).
- **Pkg mgr**: pnpm.

## Architectural decisions you cannot quietly walk back

These were earned in two review passes. Reopen them only with new evidence.

### 1. ACP-driven execution with hybrid HITL

A Flow = a typed-node **graph** (`nodes[]`, current engine 3.7.0) — node
types `ai_coding | judge | cli | check | human | form | orchestrator`
and `consensus`, wired by named `transitions` with bounded `rework` loops.
Manifests with a top-level `steps` key are incompatible and must be
republished as `nodes[]`
(see `docs/flow-dsl.md` + `docs/system-analytics/flow-graph.md`).
`ai_coding`/`agent` nodes run as ACP sessions hosted by `supervisor/`,
which spawns one adapter process per active session. State transitions are driven by
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

**Execution-host addressing (ADR-166, Implemented):** every host-bound command
(create/prompt/input/cancel/checkpoint/delete, workspace adopt/release) is
issued through a `BoundClient` bound to the run's active
`execution_assignments` row — it carries a unique `command.id` and the
fence `{hostKey, assignmentId, assignmentEpoch, runId}`, is persisted
`queued` before the wire call, and the supervisor rejects a stale epoch with
`409 FENCED` → `CONFLICT {details.reason:"assignment_fenced"}`, on which the
driver MUST yield without writing run state. Placement re-entries mint the
epoch inside their existing CAS claim. `POST /workspaces/adopt` is the only
path-bearing route; session routes take the opaque `executionWorkspaceId`.
Every `session.prompt` additionally carries a durable owner (ADR-167 S2.12):
the unowned issue path refuses a prompt at compile time and
`execution_commands_prompt_owner_required` refuses the row, so a prompt no
restart could finish is never sent. Command evidence is reclaimed only by the
two-sided retirement handshake (S2.11) — never by age — and deleting a run or
assignment around it is refused by `execution_commands_protected_evidence`.
→ `docs/system-analytics/execution-hosts.md`.

### 2. Durable execution-host event and runtime-data plane

The supervisor keeps raw step output and runtime bytes as host-private files.
It commits redacted, sequence-numbered events to its SQLite outbox; the manager
ingests them idempotently into Postgres and serves browser replay from
`execution_events`. Runtime content crosses typed opaque-object APIs with
manager-owned metadata. Web code must never tail `run.events.jsonl`, read a
host runtime path, or use filesystem polling as a state-transition mechanism.

### 3. Typed error taxonomy (`lib/errors.ts`)

`MaisterError extends Error` with discriminated `code`:
`PRECONDITION | SPAWN | NEEDS_INPUT | HITL_TIMEOUT | CRASH | CONFLICT |
CONFIG | EXECUTOR_UNAVAILABLE | FLOW_INSTALL | ACP_PROTOCOL | CHECKPOINT |
BUDGET_EXCEEDED | EMBEDDING_UNAVAILABLE | STEP_CHECKPOINTED | UNAUTHENTICATED |
UNAUTHORIZED | PASSWORD_CHANGE_REQUIRED | ACCOUNT_INACTIVE`
(client-safe union in `web/lib/errors-core.ts`, re-exported by `lib/errors.ts`).
UI branches on `code`, never on string matching. No string-matched errors.

### 4. Concurrency cap

`MAISTER_MAX_CONCURRENT_RUNS=6` by default (env-configurable). Cap is **global**
across all projects, not per-project. Runs above the cap go to `Pending` and
auto-start when a slot frees. UI shows queue position. Hard cap (no override
from `maister.yaml`) — keeps RAM/token spend bounded on a single host.

### 5. Platform ACP runners

ACP standardizes the agent surface via vendor-neutral
`@agentclientprotocol/sdk`. `claude` and `codex` are the ready default
adapter families; `gemini`, `opencode`, and `mimo` are code-owned adapter families
whose launch/default readiness is gated by supervisor diagnostics and cached
ACP smoke evidence. The supervisor spawns adapters via per-agent binaries:

- `claude` → `claude-agent-acp` (from
  `@agentclientprotocol/claude-agent-acp`, wraps
  `@anthropic-ai/claude-agent-sdk`)
- `codex` → `codex-acp` (from `@agentclientprotocol/codex-acp`, bundles
  `@openai/codex`)
- `gemini` → `gemini --acp`
- `opencode` → `opencode acp`
- `mimo` → `mimo acp`

Other ACP-capable agents land after their registry, diagnostics, and smoke
contracts are proven. Runner identity is platform-scoped in
`platform_acp_runners`: `{adapter, capability_agent, model, provider,
permission_policy}`. Launches snapshot the effective runner into
`runs.runner_snapshot`; resume/recover reads the snapshot, not a mutable
catalog row.

Model routing:

- **provider config** — `anthropic`, `anthropic_compatible`, `openai`, and
  `openai_compatible` providers are runner config. Secret values are stored as
  `env:NAME` references only.

Runner resolution (highest priority wins):

1. Launch override (set at Launch click, optional).
2. Flow node `settings.runner` target, remapped when imported if the platform
   does not have that runner id.
3. Project Flow default (`project_flow_runner_defaults`).
4. Platform Flow default (`flow_revisions.default_runner_id`).
5. Project default (`projects.default_runner_id`).
6. Platform default (`platform_runtime_settings.default_runner_id`).

### 6. Flow Engine 3: plugin packaging + typed-node graph

Flows are **plugin bundles** — git repos with a manifest (`flow.yaml`),
shipped CLIs, optional `setup.sh`, skills, agents, and a graph-only `nodes[]`
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
    version: v1.2.3 # tag-pinned (lock semantics)
    runner: claude-code # optional project binding
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
setup: ./setup.sh # optional one-time install script
nodes:
  - id: plan
    type: ai_coding
    action:
      prompt: "/aif-plan {{ task.prompt }}"
    transitions:
      success: review
  - id: review
    type: human
    finish:
      human:
        decisions: [approve, rework]
    transitions:
      approve: done
      rework: plan
    rework:
      allowedTargets: [plan]
      workspacePolicies: [keep]
      maxLoops: 3
      commentsVar: review_comments
```

**The only runtime DSL is the typed-node graph (current engine `3.7.0`; the
graph-only cut-over began at `3.0.0`).** Flows use
`nodes:` with named
`transitions`, bounded `rework`, typed `input.requires`/`output.produces`
artifacts (kind-matched, presence-enforced → `PRECONDITION`), six gate kinds
(`command_check | skill_check | ai_judgment | artifact_required |
external_check | human_review`, each `blocking | advisory`), a promotion-time
**readiness** gate, per-node capability `settings` + declared `enforcement`,
and per-capability engine-version floors. Graph **gates** block. A node's
opt-in `output.result` rides a transport fixed by node type (ADR-162, engine
3.6.0): sentinel block for `ai_coding | judge | orchestrator`, per-attempt
`MAISTER_OUTPUT_FILE` for `cli | check`, engine-produced `vars` validated in
place for `consensus`, and a load-time refusal for `human | form`. A run's
**public result** is a separate, run-level plane (ADR-165, engine 3.7.0): a
`{schemaRef, value}` envelope in the `run_results` revision ledger, produced by a
flow's `result.export` or by an agent delegated under a package `result_profiles`
name, contract snapshotted on `runs.result_contract` at launch, and served to a
coordinator by `run_collect`. Flows are
also authorable **in-app** (`authored_capabilities`, draft→publish,
content-addressed, bridged into the same `flow_revisions` lineage) on the
**Flow Studio** visual graph editor (M25/M27). See
`docs/system-analytics/{flow-graph,artifacts,readiness,flow-studio}.md`.

Project `slug` is derived from `project.name` (kebab-cased). Both `slug`
and `repo_path` are unique across registered projects. Refuse to register
on: `schemaVersion` mismatch (project file or any installed Flow's
manifest), legacy `steps[]`, duplicate IDs within either file, unknown
runner reference, or unknown graph transition/rework target,
slug collision, `repo_path` collision. Trust the Flow's `setup.sh` on
first install. Current target trusts internal Flow sources; sandboxing +
trust UI is Phase 2.

Templating: full Mustache-style interpolation (strict mode — unknown var
throws `CONFIG`) with session context, task fields, per-step output vars,
executor metadata. Structured `vars` are populated by any node declaring
`output.result` (`ai_coding | cli | check | judge` — ADR-063 P1 + M38
`decide` routing); `{{ steps.<id>.output }}` carries stdout text,
`{{ steps.<id>.vars.<name> }}` reads `node_attempts.vars`; artifact bodies
inject via `{{ artifacts.<id>.content }}` (ADR-120).

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
- **Result-only completion** (ADR-165): a flow whose manifest declares
  `result.export` and which finishes with a valid public result over a CLEAN
  workspace goes `Running -> Done` WITHOUT promotion — no merge commit, no
  promoted head, `promotion_state` stays `none`, and the workspace is GC'd by
  `scheduled_removal_at` on the existing path. Its answer is the result, not a
  diff.
- **Execution assignments** (ADR-166, Implemented): one `active`
  `execution_assignments` row per run (epoch = driver-ownership generation,
  minted at launch and at every resume/recover/rework/interrupt re-entry);
  the worktree is adopted once per host handle into a host-scoped opaque
  handle stored on the assignment (the host refuses a wiped or released
  handle and the client re-adopts once); `run_sessions.host_session_id` is
  written by the create ack.
  → `docs/system-analytics/execution-hosts.md`.
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
- **Branch sync + reopen** (ADR-141, Implemented): `sync` claims the same
  `lifecycle_operation_name` slot as `archive | drop | snapshot-commit |
export-branch | handoff-branch` above (its 6th value — `stop` takes no
  claim) to rebase/merge a `Review` run's branch onto the moved target
  inside its worktree (mechanical, or an AI resolver ACP session on
  conflict), and `reopen` flips a `Done` run back to `Review` when its PR
  conflicts. PR lifecycle state (`open|merged|closed(+conflicts)`) is polled
  onto `workspaces` by the `pr_state_scan` scheduler job (ADR-140). →
  `docs/system-analytics/branch-sync.md`.
- **Run continuation controls** (ADR-160/161, Implemented): two operator
  re-entries into a run the flow cannot advance itself. A **rework claim**
  returns a finished `Review` run to `HumanWorking` and back into the graph at a
  server-resolved re-entry node (manifest `reentry`, else the last executed
  `human` node's `transitions.takeover`, else refused); the return ingest is
  **fast-forward only** — divergence refuses `PRECONDITION` with copyable
  remediation. Unlike the ADR-030 takeover it ACQUIRES a concurrency slot, so a
  cap-full claim is refused inside the claim transaction, never queued. An
  **operator node interrupt** parks a live agent node into `NeedsInput` with a
  `node_interrupt` HITL whose four options are server-owned; `restart_from`
  targets are ledger-derived (the graph has cycles — forward skips are refused),
  and operator restarts are excluded from `rework.maxLoops` and both Observatory
  correction counters, bounded by `MAISTER_MAX_OPERATOR_RESTARTS`. Provenance
  for both rides `node_attempts.decision`; no new run status. →
  `docs/system-analytics/run-continuation.md`.

### 8. Promotion policy

After review/readiness gates pass, MAIster promotes the run branch to the
selected target branch. Initial promotion modes are `local_merge` and
`pull_request`. `local_merge` uses `git merge --no-ff`; conflict → abort, run
stays `Review`, UI surfaces "Conflict — resolve manually" with parent repo
path, run branch, target branch, and failing command. No auto-resolve.

Not every `Done` run was promoted: a run that finishes by **result-only
completion** (§7, ADR-165) never enters this path at all — it publishes a result
and changes nothing, so there is no branch to promote.

Promotion is manual by default, but **lane-bounded auto-promotion** exists
(ADR-126, Implemented): project-scoped diff classes (`docs | tests | deps |
config`) may auto-promote through the SAME `promoteRun` choke point when
readiness is green, gated by a non-configurable hard deny-list. `docs/PRODUCT_VIEW.md`
is canonical for the product framing; this note only mirrors it.

The `ai_rebase_merge` mode is resolver-backed (ADR-141, Implemented): a clean
rebase finalizes to `Done` like `rebase_merge`; a conflict delegates to the
branch-sync AI resolver (under the sync lifecycle claim, never the promotion
claim), returning the run to `Review` (two-step default) or — with the opt-in
`autoFinalize` flag — best-effort chaining the finalize to `Done`.

PR lifecycle state is owned by `workspaces` (`pr_state`, `pr_has_conflicts`,
`pr_merged_at`, `pr_merge_commit_sha`) and written ONLY by the `pr_state_scan`
job (ADR-140) — never by the supervisor, and never onto `runs.merge_commit_sha`,
which stays the local-promotion merge commit.

## Current Scope

- **Multi-project registry**: N projects per host, each configured by its own
  `maister.yaml` v2. Registration via UI form (path to dir containing
  `maister.yaml`) or `MAISTER_PROJECTS_DIR` env auto-discovery (**recursive**
  scan; every `maister.yaml` under the root gets registered, slug/repo
  collisions are rejected).
- **Multi-repo enablement** (M49, ADR-155/156/157): `project = repo` STAYS.
  Multi-repo work is decomposed into per-project tasks coordinated through the
  task graph, plus read-only context sharing. Three axes: **cross-project task
  relations** (any of the 5 kinds may span projects; the row is owned by the
  from-task's project and every gating insert serializes on ONE platform-wide
  advisory lock — per-project locking cannot catch a 4-cycle); **cross-project
  agent facade reach** (opt-in per attachment via
  `agent_project_links.cross_project_reach`, limited to the read/comment/relate
  `CROSS_PROJECT_AGENT_SCOPES` allow-list, bounded by `runs.agent_chain_depth`
  ≤ `MAISTER_MAX_AGENT_CHAIN_DEPTH`); and **read-only sibling-repo context
  mounts** (`settings.context_repos` on `ai_coding`/`judge`/`orchestrator`,
  engine floor 3.4.0, materialized under the run dir and snapshotted on
  `runs.context_mounts`). **Relations may cross projects; the automation they
  drive may not** — auto-launch, the abandon cascade, and C2 admission all stay
  same-project. Explicit non-goals: multi-repo runs/workspaces, coordinated
  cross-repo promotion, orchestrator cross-project delegation, a
  meta-project/project-group entity, cross-project task moves.
- **Flow plugin engine**: install plugins from `git URL + tag` to
  `~/.maister/flows/<id>@<tag>/` system cache; symlink into each consuming
  project's `.maister/<slug>/flows/`. Manifest (`flow.yaml`) is the source
  of the typed-node graph DSL. Trust internal Flow sources today.
- **Multi-executor via ACP**: `claude` and `codex` both required.
  Per-step executor override resolution per §5.
- **`supervisor/` daemon**: separate Node process owning ACP sessions,
  process-per-session spawn, heartbeat, permission input delivery,
  cost-token metric on disk. Talks HTTP+SSE to Next.js (same host, shared
  filesystem — ADR-023; addressed as a registered execution host, ADR-166).
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
- **Concurrency**: global flow/scratch cap = 6 (env-configurable
  `MAISTER_MAX_CONCURRENT_RUNS`); platform-agent runs use a separate cap = 3
  (`MAISTER_MAX_CONCURRENT_AGENTS`). Queue + position badge.

## Built since the original baseline

This file was first written at the M8 (ACP/HITL) baseline; much shipped after.
Authoritative per-domain truth is in `docs/system-analytics/`. Beyond §1-8 +
Current Scope, these are **Implemented** today:

- **Graph flow engine** (M11a): typed-node graph, `node_attempts` ledger,
  gate execution, staleness, review-driven rework. → `flow-graph.md`
- **Typed artifacts + evidence graph** (M12): `artifact_instances`, validity
  FSM, produced-output enforcement. → `artifacts.md`
- **Capability materialization** (M14): per-session `settings.local.json` +
  ACP `mcpServers`, two-axis trust (`trust_status` + `exec_trust`); `tools`/
  `mcps`/`hooks` are enforced at the supervisor ACP seam since ADR-130
  (`capability_guard`); residual: flow-path `workspaceAccess` seam delivery +
  the destructive-agent launch gate. → `flow-settings.md`, `guardrail-hooks.md`
- **Readiness gate** (M15): promotion gating over blocking gates + verdict
  calibration. → `readiness.md`
- **Observatory** (M23): read-only Autonomy Score, correction-rate, signal
  clusters. → `observatory.md`
- **Scheduler** (M24): one polymorphic cron tick (`system_sweep | command |
agent_tick | flow_run | run_schedule`); user-facing task cron schedules
  shipped (M28) → `run-schedules.md`, `scheduler.md`
- **Authored catalog + Flow Studio** (M25/M27): in-app create/version of
  rules/skills/flows + visual graph editor; publish→PR to the package source
  (ADR-113) and bidirectional upstream sync (ADR-132) shipped. →
  `flow-studio.md`, `local-packages.md`
- **Platform + project MCP & ACP-runner catalogs** (M27, ADR-065/070): CRUD
  - resolver precedence (project > platform > flow-package). → `acp-runners.md`
- **External operations API + project tokens + MCP facade** (M16/M17):
  `/api/v1/ext/*`, scoped tokens, HITL-over-MCP (`hitl_list`/`hitl_respond`).
  → `external-operations.md`
- **Social board substrate** (M31, ADR-083): `KEY-N` task identity
  (platform-unique `task_key` + counter-allocated `number`), typed relations
  gating launch (`blocked` classification at every entry point), comments
  with write-time mention expansion, domain-only `task_activity`,
  auto-subscriptions, per-recipient inbox + "Needs you" sum, task detail
  page, ext comment ops + MCP `comment_*` tools. Polymorphic
  `(actor_type, actor_id)` is `agent`-ready; Stage 1 writes `user`/`system`
  only. → `social-board.md`
- **Domain-event outbox / shared trigger bus** (M32, ADR-086):
  `domain_events` append-only fact log emitted in the SAME transaction as
  the domain write (11-kind taxonomy: task.created/comment_added/
  triage_requeued/clarification_answered, run.done/failed/crashed/abandoned/
  review/escalated, gate.failed;
  polymorphic actor, xid8 commit horizon), per-consumer cursor dispatcher
  (`domain_event_dispatch` singleton on the M24 clock, CAS lease + fenced
  advance, at-least-once) with a permanent `noop` consumer. Webhooks
  (ADR-077) keep their own outbox until their drainer re-points; the TTL
  `run.abandoned` webhook gap is closed (`source: "ttl"`).
  → `domain-events.md`

- **Platform-agent substrate** (M34, ADR-089/090): `.md`-defined agents
  shipped INSIDE flow packages (`agents/<stem>.md`, same trust contour +
  versioning + Studio authoring path; package-qualified ids
  `<flowRefId>:<stem>`) projected into the `agents` catalog from each
  package's newest Installed revision; what a launch runs is the
  per-project EFFECTIVE definition resolved through that project's pinned
  revision behind the flow enablement+trust gates (pin divergence refuses);
  project attachments (require the package enabled in the project,
  pre-filled from the definition's `recommended` bindings) + cron/event
  trigger bindings; standalone runs as `runs.run_kind='agent'` under a
  separate budget (`MAISTER_MAX_CONCURRENT_AGENTS`, default 3; flow/scratch
  default raised to 6) with a per-agent runner chain; workspace axis
  `none|repo_read|worktree` (+ `workspace_ref: trigger|branch` — ephemeral
  detached read-only checkout at the trigger-derived ref) with 3-layer
  read-only enforcement (L1 supervisor `readOnlySession` inline
  arbitration, L2 materialized deny rules, L3 dirty-watchdog → one-tx
  quarantine; ADR-041 untouched); five triggers (manual / cron singleton /
  domain-event consumer with self-exclusion / inbound webhook / flow-node
  `settings.agent` binding, engine `1.5.0`); per-launch ephemeral agent
  tokens feeding the maister MCP facade (`agent:<id>` audit identity) +
  capability-profile MCPs resolved from the platform catalog (exec-trust
  stdio gate); triage verdict ops + simple-intent tasks (`unconfigured`
  launchability, set-up-&-launch dialog) + the `task.triage_requeued`
  emitter; package upgrade preview with agent break-impact warnings.
  → `agents.md`

- **Post-M34 (compact; per-domain docs are authoritative):** orchestrator
  engine + run-tree + shared-worktree review (M37, ADR-098/099/100/102) ·
  output-driven `decide` routing + run-context (M38, ADR-103) · Studio
  package authoring + local packages + fork↔upstream loop (M39,
  ADR-105/107/110/113/116/132) · guardrail/hook engine (M40, ADR-108;
  `capability_guard` ADR-130) · consensus node (M41, ADR-109) · unified
  runner config + first-class sessions (M42, ADR-114) · Postgres-only +
  graph-only cut-over, engine 3.0 (M43, ADR-131) · Flow Review Workspace
  (M44, ADR-138) + branch sync / PR lifecycle / `ai_rebase_merge`
  (ADR-140/141) · Project Brain A/B/C (ADR-122/127/128) · Evaluation Lab +
  Experiments cut-over (M46–M48, ADR-142..147/150) · agent mentions +
  pulse + per-attachment memory (ADR-151/152) · env isolation +
  `MAISTER_FLOW_DIR` (ADR-153/154) · cross-project relations / agent reach
  / context mounts (M49, ADR-155/156/157) · RU user manual (ADR-158) ·
  generated DBML ERD + docs gates (ADR-159) · local execution-host contract
  — durable host identity, epoch-fenced assignments, command ledger, opaque
  adopted workspaces, strict envelope (Stage A, ADR-166).

Historical product backlog/wave rationale: `docs/pv/improvement-roadmap.md`.
Current sequencing lives in `.ai-factory/ROADMAP.md`; M45 qualifies
core-package processes on private projects. Many original backlog foundations
(Observatory, Project Brain, the Evaluation Lab, agents-as-actors) are implemented.

## Phase 2 Candidates

These are not forbidden. They need an explicit implementation plan because
they change product surface, contracts, or operating model. (Re-cut
2026-08-31: shipped items removed — A/B benchmarking became the Evaluation
Lab (ADR-142..147/150), RBAC action-blocking is live (`web/lib/authz.ts`),
the event log table is `domain_events` (ADR-086), PR-to-catalog is ADR-113,
opencode/gemini/mimo are gated adapter families, cost/time guard enforcement
shipped (ADR-101 + `maxDurationMinutes` watchdog), CI exists
(`.github/workflows/ci.yml`); outbound webhooks (ADR-077) left earlier.)

continuous background agents (Mγ: heartbeat daemons + crash-loop backoff —
the M34 substrate covers catalog/triggers/one-shot runs) · Telegram /
notifier consumers on the webhook primitive · durable orchestration · full
Kanban (Done as drag-target / WIP limits / swim-lanes) · test-run UI button ·
CD pipeline (CI exists) · project archival UI (schema half exists —
`projects.archived_at` is read, never written) · cross-project task moves ·
GitHub issue / Linear / YouGile sync · custom ACP extensions · writable
competing-code consensus drafts · regex guard enforcement (cost/time
shipped) · `maxCostUsd` enforcement flip (declared, record-only today) ·
plugin sandboxing · HITL as separate swimlane cards · Cursor / Aider
executors.

## Conventions

- **Errors**: throw `MaisterError` with `code`, never plain `Error` for known
  domain failures. See §3 above.
- **Atomic writes** to `.maister/`: always tmp + rename via `atomicWriteJson`.
  Never partial-write a JSON the Flow / agent will read.
- **SSE messages**: one per ACP `session/update` event line. Include
  monotonic `id` for `lastEventId` reconnect.
- **Supervisor boundary**: `web/lib/supervisor-client.ts` is the local-direct
  transport and is importable ONLY from `web/lib/execution-host/**`
  (ESLint-fenced, ADR-166 Implemented); domain code uses `BoundClient` /
  `HostAdminClient` from `@/lib/execution-host`.
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
- **UI affordances**: prefer icon (or icon + label) buttons over text-only, and
  show success as a green check glyph — not the word "Succeeded". Full rules in
  `web/CLAUDE.md` → "UI affordance conventions" (mirrored in
  `.ai-factory/rules/frontend.md`).

## ACP Spike Findings (Current Baseline)

1. ✅ **ACP packages pinned**: `@agentclientprotocol/claude-agent-acp@0.37.0`
   - `@agentclientprotocol/codex-acp@0.0.44` + `@agentclientprotocol/sdk@0.22.1`
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
4. ✅ **z.ai GLM works through environment configuration.** Set
   `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` +
   `ANTHROPIC_AUTH_TOKEN=<key>` in `executor.env`.
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

Dogfood and installations by other users are confirmed. Current validation is
repeatable execution of representative core-package processes across
internal/private projects, with package/engine/runner provenance, actionable
preflight, expected evidence, classified failures, human-attention and
promotion outcomes, and no private source or artifact bodies in telemetry.

## Where to read next

- `web/CLAUDE.md` — Web UI slice: stack details, scripts, structure, conventions.
- `docs/VISION.md` — one-liner, principles, validation goal.
- `docs/PRODUCT_VIEW.md` — Lean Canvas, JTBD, gaps, current scope / Phase 2 /
  Later.
- `docs/architecture.md` — current system shape and data flows.
- `docs/decisions.md` — ADRs and locked technical choices.
- `docs/api/` — OpenAPI and AsyncAPI contracts.
- `docs/system-analytics/` — domain-specific process docs and diagrams.

When this file disagrees with `docs/`, `docs/` wins — update this file.
