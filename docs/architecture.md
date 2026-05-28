# Architecture

> Read [`VISION.md`](VISION.md) for the product spine and
> [`decisions.md`](decisions.md) for the why behind every locked
> choice. This file is the **how**: C4 diagrams, components, and
> their contracts.

Implementation status legend: **(Implemented Mx)** in `main` at
milestone Mx · **(Designed Mx)** locked, not yet coded · **(Phase 2)**
out of POC scope.

Current state: **M3** — supervisor daemon + foundation libs in `web/`.
No Next.js Route Handlers yet (web routes are template stubs).

## C4 Context — system and its world

The control plane MAIster runs on a single host, talks to a relational
database, spawns coding-agent CLIs as subprocesses, and routes their
LLM calls to one of several providers.

```mermaid
C4Context
    title MAIster — System Context (POC)

    Person(operator, "Operator", "Solo-technical CEO / CIO / staff engineer running several projects in parallel.")

    System(maister, "MAIster", "Control plane: portfolio, board, runs, HITL, diff review, merge.")

    System_Ext(anthropic, "Anthropic API", "Claude Sonnet / Haiku / Opus inference. Default LLM provider.")
    System_Ext(openai, "OpenAI Codex API", "Codex (GPT-5-Codex) inference for the codex executor.")
    System_Ext(thirdparty, "Third-party LLM provider", "Anthropic-API-compatible: z.ai GLM, OpenRouter, anyscale. Routed via env-router or CCR.")
    System_Ext(git, "Git host", "GitHub or self-hosted git remote for parent repos and Flow plugins.")
    System_Ext(fs, "Host filesystem", "Parent repos, .maister/ subtree, system Flow cache.")

    Rel(operator, maister, "Registers projects, launches tasks, reviews diffs, answers HITL", "HTTPS")
    Rel(maister, anthropic, "Claude inference", "HTTPS (via claude-agent-acp)")
    Rel(maister, openai, "Codex inference", "HTTPS (via codex-acp)")
    Rel(maister, thirdparty, "Alternative inference", "HTTPS (env-router or CCR)")
    Rel(maister, git, "Clones Flow plugins, may push merged branches", "HTTPS / SSH")
    Rel(maister, fs, "Reads parent repos, writes .maister/ subtree", "POSIX")
```

**Personas.**

- **Operator** — primary persona. One human running several projects.
  No teammates, no auth, no RBAC on POC.
- *(Phase 2)* Small-team member — receives HITL items via the same UI.

**External systems.**

- **Anthropic API** — default LLM. Reached by `claude-agent-acp` over
  HTTPS using `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN` when
  routed).
- **OpenAI Codex API** — backing for the codex executor, reached by
  `codex-acp`.
- **Third-party LLM provider** — any Anthropic-API-compatible endpoint
  (z.ai GLM, OpenRouter, anyscale) configured per-executor via
  `executor.env` (env-router) or via CCR.
- **Git host** — GitHub or self-hosted. Read-only for Flow plugin
  install. Push semantics for merged branches are operator-controlled.
- **Host filesystem** — parent repos at `executors[].repo_path`,
  per-run worktrees at `.maister/<slug>/runs/<run-id>/`, system Flow
  cache at `~/.maister/flows/<id>@<tag>/`.

## C4 Container — deployable units

MAIster ships as two long-running Node processes plus a Postgres
instance. The supervisor MAY run on a different host than the web tier
(only HTTP+SSE between them).

```mermaid
C4Container
    title MAIster — Container View (POC)

    Person(operator, "Operator")

    System_Boundary(maister, "MAIster") {
        Container(web, "Web tier", "Next.js 16 / React 19 / HeroUI v3", "UI + Route Handlers + server actions + Drizzle access. Bridges SSE to the browser.")
        Container(supervisor, "Supervisor daemon", "Node 24 / Fastify / pino", "Owns ACP sessions, spawns adapter binaries, heartbeat, cost accounting.")
        ContainerDb(pg, "Database", "Postgres 16", "Projects, executors, flows, tasks, runs, workspaces, HITL requests.")
        Container_Boundary(adapters, "Per-session spawned adapters") {
            Container(claude_acp, "claude-agent-acp", "Node binary", "ACP adapter wrapping @anthropic-ai/claude-agent-sdk.")
            Container(codex_acp, "codex-acp", "Node binary", "ACP adapter bundling @openai/codex.")
        }
        Container(ccr_daemon, "CCR daemon", "Node — @musistudio/claude-code-router@2.0.0", "Multi-provider Anthropic-API-compatible proxy. Lazy-started by the supervisor on the first router=ccr session; one daemon per supervisor process.")
    }

    System_Ext(anthropic, "Anthropic API", "HTTPS")
    System_Ext(openai, "OpenAI Codex API", "HTTPS")
    System_Ext(thirdparty, "Third-party LLM", "Anthropic-compatible HTTPS")
    System_Ext(git, "Git host")
    System_Ext(fs, "Host filesystem")

    Rel(operator, web, "Uses", "HTTPS / SSE")
    Rel(web, pg, "Reads / writes via Drizzle", "TCP 5432")
    Rel(web, supervisor, "Session lifecycle + SSE bridge", "HTTP + SSE")
    Rel(web, fs, "git worktree add/remove/list, .maister/ atomic writes", "POSIX")
    Rel(web, git, "Clones Flow plugins on project register", "HTTPS / SSH")

    Rel(supervisor, claude_acp, "child_process.spawn", "stdio JSONL")
    Rel(supervisor, codex_acp, "child_process.spawn", "stdio JSONL")
    Rel(supervisor, ccr_daemon, "Spawn + health-check + SIGTERM on shutdown", "child_process.spawn")
    Rel(supervisor, fs, "Writes step .log + cost.jsonl", "POSIX")

    Rel(claude_acp, anthropic, "Inference", "HTTPS")
    Rel(claude_acp, thirdparty, "Inference (env-router or CCR)", "HTTPS")
    Rel(claude_acp, ccr_daemon, "Inference (router=ccr)", "HTTP 127.0.0.1")
    Rel(ccr_daemon, thirdparty, "Routed inference (multi-provider)", "HTTPS")
    Rel(codex_acp, openai, "Inference", "HTTPS")
```

**Containers.**

| Container | Status | Tech | Purpose |
| --------- | ------ | ---- | ------- |
| Web tier | Implemented M0 (scaffold) | Next.js 16 + React 19 + HeroUI v3 + Tailwind 4 | UI, Route Handlers, server actions, Drizzle access. SSE bridge to supervisor. |
| Supervisor daemon | Implemented M3 | Node 24 + Fastify + pino + Zod | Owns ACP sessions, spawns adapters, heartbeat watcher, cost accounting. |
| Database | Implemented M2 | Postgres 16 (SQLite dev) | All persistent state for projects, executors, flows, tasks, runs, workspaces, HITL. |
| `claude-agent-acp` | Implemented M3 (spawn-only) | `@agentclientprotocol/claude-agent-acp@0.37.0` | ACP adapter wrapping Claude Agent SDK. One process per session. |
| `codex-acp` | Implemented M3 (spawn-only) | `@agentclientprotocol/codex-acp@0.0.44` | ACP adapter bundling Codex. One process per session. |
| CCR daemon | Implemented M6 | `@musistudio/claude-code-router@2.0.0` (MIT) | Multi-provider Anthropic-API-compatible proxy. Supervisor-owned: lazy `ensureRunning()` on first `router=ccr` spawn, graceful shutdown on supervisor SIGTERM/SIGINT, exactly one daemon per supervisor process. Host+port read from `~/.claude-code-router/config.json`. |

**Inter-container contracts.**

- **Web ↔ Supervisor** — HTTP + SSE.
  Contract: [`api/supervisor.openapi.yaml`](api/supervisor.openapi.yaml) (REST routes)
  + [`api/async/supervisor-sse.asyncapi.yaml`](api/async/supervisor-sse.asyncapi.yaml) (SSE event stream).
  Client: `web/lib/supervisor-client.ts`.
- **Web ↔ Database** — Drizzle ORM over `postgres` driver.
  Contract: [`database-schema.md`](database-schema.md) + [`db/erd.md`](db/erd.md).
- **Supervisor ↔ Adapter** — stdio JSONL (Adapter binary speaks ACP
  on stdin/stdout). One child per session, spawned with
  `cwd = worktreePath` and merged env. M3 ships opaque JSONL
  passthrough; structured ACP `session/update` parsing lands in M7.

## C4 Component — Supervisor (Implemented M3)

The supervisor is the only fully-implemented container at M3. Its
internal structure:

```mermaid
C4Component
    title Supervisor — Component View (M3)

    Container_Boundary(supervisor, "Supervisor daemon") {
        Component(main, "main.ts", "Node entrypoint", "Fastify boot, pino logger, graceful shutdown.")
        Component(http_api, "http-api.ts", "Fastify routes", "POST/DELETE /sessions, GET /sessions, GET /sessions/:id/stream, POST .../checkpoint (stub), POST .../input (501 stub).")
        Component(spawn, "spawn.ts", "child_process.spawn dispatch", "Picks binary by agent, builds env, line-buffers stdout, writes step .log.")
        Component(registry, "registry.ts", "In-memory Map", "Session records + per-session event ring buffer (1000 entries).")
        Component(heartbeat, "heartbeat.ts", "Lifecycle watcher", "exit/error -> session.exited/crashed; orphan-PID detection every interval.")
        Component(cost, "cost.ts", "Stream observer", "Lenient JSON parse, finds usage object, appends to cost.jsonl.")
        Component(types, "types.ts", "Zod schemas + types", "StartSessionRequest, SessionEvent union, SupervisorError, httpStatusForCode.")
    }

    ContainerDb_Ext(fs, "Filesystem", ".maister/{slug}/runs/{runId}/")
    Container_Ext(child, "Adapter binary", "claude-agent-acp / codex-acp")
    Container_Ext(web, "Web tier", "Next.js")

    Rel(web, http_api, "REST + SSE", "HTTP")

    Rel(http_api, spawn, "spawnSession()")
    Rel(http_api, registry, "register / get / list / subscribe")
    Rel(http_api, heartbeat, "attachHeartbeat()")
    Rel(http_api, cost, "attachCost()")
    Rel(http_api, types, "Zod parse / error mapping")

    Rel(spawn, child, "child_process.spawn", "stdio JSONL")
    Rel(spawn, fs, "Append step .log", "createWriteStream")

    Rel(heartbeat, registry, "emit terminal event")
    Rel(cost, fs, "Append cost.jsonl", "createWriteStream")

    Rel(main, http_api, "registerRoutes()")
    Rel(main, heartbeat, "startHeartbeatWatcher()")
    Rel(main, registry, "new SessionRegistry()")
```

**Component table — Supervisor.**

| Name | File | Purpose | Responsibilities | Dependencies |
| ---- | ---- | ------- | ---------------- | ------------ |
| `main` | `supervisor/src/main.ts` | Process entrypoint. | Read env, build Fastify + pino, wire components, listen, graceful shutdown. | `http-api`, `registry`, `heartbeat`. |
| `http-api` | `supervisor/src/http-api.ts` | HTTP surface. | 6 routes, Zod request validation, SSE pipe with `Last-Event-ID` replay from ring buffer, error handler maps `SupervisorError`/`ZodError` to status. | `spawn`, `registry`, `heartbeat`, `cost`, `types`. |
| `spawn` | `supervisor/src/spawn.ts` | Process launcher. | Pick binary by `executor.agent`, append `--resume <id>` when present, merge env, line-buffer stdout, write `<stepId>.log`, emit `session.line` events. When `executor.router === "ccr"`, await `ccr-manager.ensureRunning()` and inject `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` into childEnv beneath the explicit `executor.env` overlay. | `registry` (channel constant), `ccr-manager`, `types`. |
| `ccr-manager` | `supervisor/src/ccr-manager.ts` | CCR daemon lifecycle controller. **Implemented M6.** | Singleton state machine (`idle | starting | ready | failed | stopping`). Lazy-start the bundled CCR proxy on demand. Parse host+port from `~/.claude-code-router/config.json` (defaults `127.0.0.1:3456`). Exponential-backoff `GET /` health check ≤10 s. Graceful shutdown on SIGTERM/SIGINT via existing `main.ts` handler. | `node:child_process`, `node:fs/promises`, `types`. |
| `registry` | `supervisor/src/registry.ts` | In-memory session table. | Register, get, list, subscribe, snapshotEvents (1000-entry ring), markIntentionalShutdown. | `types`. |
| `heartbeat` | `supervisor/src/heartbeat.ts` | Lifecycle watcher. | exit/error → `session.exited`/`session.crashed`, orphan-PID polling via `process.kill(pid, 0)`. | `registry`, `types`. |
| `cost` | `supervisor/src/cost.ts` | Cost accounting. | Lenient JSON parse on every line, traverse for `usage` (depth ≤ 8), append record to `cost.jsonl`. | `registry` (channel constant). |
| `types` | `supervisor/src/types.ts` | Schemas + error. | Zod request/event schemas, `SessionEvent` union, `SupervisorError` class, `httpStatusForCode()`. | `zod`. |

## C4 Component — Web foundation (Implemented M2)

The web tier's library layer (no Route Handlers yet at M3 — those land
in M4/M5+).

```mermaid
C4Component
    title Web foundation — Component View (M2)

    Container_Boundary(web, "Web tier") {
        Component(errors, "lib/errors.ts", "MaisterError class", "Discriminated union over 11 codes. UI branches on code, never on message.")
        Component(atomic, "lib/atomic.ts", "Atomic file writer", "tmp + rename. Used for needs-input.json, input-{step}.json, etc.")
        Component(config_schema, "lib/config.schema.ts", "Zod schemas", "maister.yaml v2, flow.yaml v1, form_schema. Single source of truth for types.")
        Component(config, "lib/config.ts", "YAML loader", "Reads maister.yaml / flow.yaml, runs schema + cross-reference checks, throws MaisterError(CONFIG).")
        Component(supervisor_client, "lib/supervisor-client.ts", "HTTP+SSE client", "createSession, deleteSession, listSessions, checkpointSession, streamSession (async generator).")
        Component(db_schema, "lib/db/schema.ts", "Drizzle schema", "7 tables, FKs with cascade, indexes.")
        Component(db_client, "lib/db/client.ts", "Drizzle factory", "buildClient, getDb (lazy singleton), maskUrl.")
    }

    ContainerDb_Ext(pg, "Database", "Postgres 16 / SQLite")
    Container_Ext(supervisor, "Supervisor", "Fastify")
    ContainerDb_Ext(fs, "Filesystem", ".maister/ subtree")

    Rel(config, errors, "throws MaisterError(CONFIG)")
    Rel(supervisor_client, errors, "throws MaisterError(...)")
    Rel(db_client, errors, "throws MaisterError(CONFIG)")

    Rel(config, config_schema, "Zod parse")
    Rel(supervisor_client, supervisor, "REST + SSE", "HTTP")
    Rel(db_client, pg, "Drizzle queries", "TCP")
    Rel(atomic, fs, "tmp + rename", "POSIX")
```

**Component table — Web foundation.**

| Name | File | Purpose | Dependencies |
| ---- | ---- | ------- | ------------ |
| `lib/errors` | `web/lib/errors.ts` | `MaisterError` + `isMaisterError` type guard. | (none) |
| `lib/atomic` | `web/lib/atomic.ts` | `atomicWriteJson(path, data)` — tmp + rename. | `node:fs/promises`, `node:crypto`, `pino`. |
| `lib/config.schema` | `web/lib/config.schema.ts` | Zod schemas for `maister.yaml` v2, `flow.yaml` v1, `form_schema`. | `zod`. |
| `lib/config` | `web/lib/config.ts` | `loadProjectConfig`, `loadFlowManifest`, `validateFormSchemaVersion`. | `lib/config.schema`, `lib/errors`, `yaml`, `pino`. |
| `lib/supervisor-client` | `web/lib/supervisor-client.ts` | `createSession`, `deleteSession`, `listSessions`, `checkpointSession`, `streamSession`. | `lib/errors`, `pino`. |
| `lib/db/schema` | `web/lib/db/schema.ts` | Drizzle table definitions for the 7 tables. | `drizzle-orm/pg-core`. |
| `lib/db/client` | `web/lib/db/client.ts` | Drizzle client factory + lazy singleton. | `drizzle-orm`, `lib/errors`. |

## Component map — Designed but not yet implemented

These components have a locked design (in CLAUDE.md / ADRs) and will be
added as M4+ milestones land. Stubs and naming live in `web/CLAUDE.md`.

| Component | File (planned) | Purpose | Status |
| --------- | -------------- | ------- | ------ |
| `lib/projects` | `web/lib/projects.ts` | Registry CRUD, slug derivation, slug + repo_path uniqueness, recursive `MAISTER_PROJECTS_DIR` discovery, Flow plugin install on register. | Designed M4 |
| `lib/flows` | `web/lib/flows.ts` | Flow plugin loader: `git clone --branch <tag>`, symlink into project subtree, manifest validation. | Designed M5 |
| `lib/executors` | `web/lib/executors.ts` | Pure `resolveExecutor()` 5-level chain (launcher → task → flow override → project default → flow recommended) + `upsertExecutorsFromConfig()` helper (writes `executors` + `flows.executor_override_id` in one transaction). CCR env construction lives in `supervisor/src/spawn.ts`, not here. | Implemented M6 |
| `lib/worktree` | `web/lib/worktree.ts` | `git worktree add/remove/list` wrapper, project-scoped paths. | Designed M6 |
| `lib/scheduler` | `web/lib/scheduler.ts` | Global concurrency cap, Pending queue, auto-promote on slot free. | Designed M6 |
| `lib/reconcile` | `web/lib/reconcile.ts` | Startup reconciliation: `runs` vs `git worktree list` vs supervisor live sessions. | Designed M6 |
| `app/api/projects/route.ts` | Route Handler | Register / archive projects. | Designed M4 |
| `app/api/projects/[slug]/tasks/route.ts` | Route Handler | Create tasks → `Backlog`. | Designed M4 |
| `app/api/runs/route.ts` | Route Handler | Precondition + executor resolution (delegates to `lib/executors:resolveExecutor`, logs `resolvedFromTier`) + worktree add + supervisor `POST /sessions`. | Implemented M5 (M6 extended override chain) |
| `app/api/runs/[id]/stream/route.ts` | Route Handler | SSE bridge tailing the per-step log file. | Designed M7 |
| `app/api/runs/[id]/hitl-response/route.ts` | Route Handler | Atomic write `input-<step-id>.json` → supervisor `POST /sessions/:id/input`. | Designed M7 |
| `app/api/runs/[id]/activity/route.ts` | Route Handler | Bump `keepalive_until` by 30 min while user on the page. | Designed M8 |
| `app/api/runs/[id]/diff/route.ts` | Route Handler | Raw `git diff` rendered in `<pre>`. | Designed M9 |
| `app/api/runs/[id]/merge/route.ts` | Route Handler | `git merge --no-ff`; conflict → abort + Review. | Designed M9 |

## Dependency rules

Enforced informally on POC; CI gate is Phase 2. The current rules:

1. **`web/lib/` is server-only.** Every module in `web/lib/` imports
   `"server-only"` at the top. No Client Component may import from
   `lib/`.
2. **`supervisor/src/` may not import from `web/`.** They are separate
   workspaces; the only contract is the HTTP+SSE wire.
3. **`MaisterError` is thrown at the boundary, not above.** Validate
   user input, external APIs, subprocess exits, file reads. Trust
   internal invariants (no defensive `MaisterError` on impossible
   states).
4. **No `chokidar` / `fs.watch` / polling for state transitions.**
   Live path: supervisor ACP notifications → SSE. Recovery path:
   supervisor heartbeat + reconcile on startup.
5. **`drizzle-orm/pg-core` is the only DB driver shape.** SQLite uses
   the same schema via dialect switch — no parallel SQLite types.
6. **No re-exports of `pino` / `zod` / `yaml`.** Components import from
   the dep directly.

## Data flow — happy path Launch (Designed M6+)

This is the end-to-end flow once M6/M7 land. M3 ships only the
supervisor part of it.

```mermaid
sequenceDiagram
    actor U as Operator
    participant W as Web tier
    participant DB as Postgres
    participant FS as Filesystem
    participant S as Supervisor
    participant A as Adapter (claude-agent-acp)
    participant LLM as Anthropic API

    U->>W: Click Launch on Backlog task
    W->>DB: Load project, task, executors, flow row + manifest
    W->>W: resolveExecutor() — 5-level chain → {executorId, tier}
    W->>FS: Precondition checks (clean repo, branch free, worktree path free)
    W->>DB: Reserve run (status=Pending) + workspace row
    W->>FS: git worktree add ./maister/{slug}/runs/{runId}
    W->>S: POST /sessions { runId, projectSlug, worktreePath, stepId, executor }
    opt executor.router is ccr (first session only)
        S->>S: ccrManager.ensureRunning starts CCR if idle
    end
    S->>A: spawn claude-agent-acp with merged env (ANTHROPIC_BASE_URL/TOKEN injected for router=ccr)
    A-->>S: spawn event fires
    S-->>W: 201 { sessionId, pid }
    W->>DB: runs.acp_session_id = sessionId, status=Running

    A->>LLM: Inference call
    LLM-->>A: Streamed response
    A-->>S: stdout JSONL (one line per ACP event)
    S->>FS: Append {stepId}.log
    S->>FS: Append cost.jsonl (when usage seen)
    S-->>W: SSE session.line events

    Note over W,S: User can request stream via GET /sessions/:id/stream<br/>with Last-Event-ID for replay

    A->>A: exit 0 on step complete
    A-->>S: child exit event
    S->>S: heartbeat updates record.status=exited
    S-->>W: SSE session.exited (terminal)
    W->>DB: runs.status=Review, runs.ended_at=now
```

## Data flow — HITL keep-alive + resume (Designed M7/M8)

```mermaid
stateDiagram-v2
    [*] --> Running

    Running --> NeedsInput: agent emits session/request_permission<br/>or writes needs-input.json
    NeedsInput --> NeedsInput: user activity on run page<br/>bumps keepalive_until +30min
    NeedsInput --> NeedsInputIdle: now > keepalive_until<br/>(graceful checkpoint, agent exits)
    NeedsInput --> Running: user submits input<br/>(supervisor delivers via ACP)
    NeedsInputIdle --> Running: user submits input<br/>(supervisor respawns with --resume)
    NeedsInputIdle --> Abandoned: 24h elapsed<br/>without response

    Running --> Review: agent exits 0
    Running --> Crashed: agent exits non-zero<br/>or heartbeat dead

    Crashed --> Running: user clicks Recover<br/>(--resume from acp_session_id)
    Crashed --> Abandoned: user clicks Discard

    Review --> Done: user clicks Merge<br/>(git merge --no-ff succeeds)
    Review --> Review: conflict on merge<br/>(stays in Review)

    Done --> [*]
    Abandoned --> [*]
```

## Deployment

POC ships as Docker Compose on a single host. The two services
(`web`, `supervisor`) plus Postgres are defined in `compose.yml`, with
dev overrides in `compose.override.yml` and a hardened production
overlay in `compose.production.yml`.

```mermaid
flowchart LR
    subgraph host[Single host]
        subgraph compose[docker compose]
            web[web<br/>Next.js<br/>:3000]
            supervisor[supervisor<br/>Fastify<br/>:7777]
            pg[(postgres<br/>:5432)]
        end
        fs[(Host filesystem<br/>parent repos<br/>.maister/<br/>~/.maister/flows/)]
    end

    browser[Operator's browser] -->|HTTPS / SSE| web
    web -->|HTTP + SSE| supervisor
    web -->|TCP| pg
    web -->|POSIX| fs
    supervisor -->|POSIX| fs
    supervisor -->|child_process.spawn| adapter[claude-agent-acp<br/>codex-acp]
    adapter -->|HTTPS| llm[(Anthropic / OpenAI /<br/>third-party LLM)]
```

The supervisor MAY run on a different host than the web tier — the
only coupling surface is the HTTP+SSE wire described in
[`api/supervisor.openapi.yaml`](api/supervisor.openapi.yaml). For
multi-host the operator sets `MAISTER_SUPERVISOR_URL` on the web tier
to the supervisor's external address.

## Where to read next

- API contracts: [`api/supervisor.openapi.yaml`](api/supervisor.openapi.yaml),
  [`api/async/supervisor-sse.asyncapi.yaml`](api/async/supervisor-sse.asyncapi.yaml).
- Database: [`db/erd.md`](db/erd.md), [`database-schema.md`](database-schema.md).
- Why each piece is shaped this way: [`decisions.md`](decisions.md).
- Per-domain process flows, state machines, edge cases:
  [`system-analytics/`](system-analytics/).
- Local dev: [`getting-started.md`](getting-started.md).
- Supervisor prose reference: [`supervisor.md`](supervisor.md).
