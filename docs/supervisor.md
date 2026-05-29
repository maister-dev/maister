[← Configuration](configuration.md) · [Back to README](../README.md)

# Supervisor Daemon

The supervisor is a second Node process that owns the lifecycle of agent
processes (`claude-agent-acp`, `codex-acp`). It speaks **HTTP + SSE** to
the web tier and **stdio JSONL** to its spawned children. Current scope:
spawn, ACP prompt delivery, heartbeat, cost accounting, structured ACP
events, permission HITL delivery, and durable run-event logging.
Checkpoint/resume remains designed.

```
                     ┌─────────────────────┐                ┌──────────────────────────┐
  web/                │  web/lib/           │   HTTP+SSE     │  supervisor/ (Fastify)   │
   - app/api/runs     │  supervisor-client  │ ─────────────▶ │   POST/DELETE /sessions  │
   - lib/reconcile    │  (server-only)      │ ◀─── SSE ───── │   GET /sessions/:id/stream
                      └─────────────────────┘                │   GET /sessions          │
                                                              │   POST .../checkpoint    │
                                                              │   POST .../input          │
                                                              └────────────┬─────────────┘
                                                                           │ child_process.spawn
                                                                           ▼
                                                ┌──────────────────────────────────────┐
                                                │ claude-agent-acp  /  codex-acp       │
                                                │  cwd = worktreePath                  │
                                                │  stdio: pipe/pipe/inherit            │
                                                └──────────────────────────────────────┘
                                                                           │ stdout JSONL
                                                                           ▼
                              .maister/<slug>/runs/<id>/<step>.log  (append-only)
                              .maister/<slug>/runs/<id>/cost.jsonl  (append-only)
```

## Why a separate process

Agent processes can run for tens of minutes. Holding them inside Next.js
makes every HMR reload (dev) and every Next.js restart (prod) kill live
runs. The supervisor isolates that failure mode and can run on a
different host than the web tier — only the HTTP+SSE wire is shared.

The architectural decision and its trade-offs live in
[`architecture.md`](architecture.md). Resume is intentionally designed
around keep-alive first because respawning an ACP session creates fresh
cache-creation cost.

## HTTP API

All routes return `application/json`. Error responses match
[`SupervisorErrorBody`](#errors) and the web client translates them into
`MaisterError({ code })` via `web/lib/supervisor-client.ts`.

### `POST /sessions`

Start a new agent process. Returns immediately after the child has been
spawned successfully (after the `spawn` event fires) — the SSE stream is
the source of truth for everything that happens next.

Request body:

```jsonc
{
  "runId": "run-abc",
  "projectSlug": "myapp",                   // kebab-case
  "worktreePath": "/repos/myapp-wt",        // cwd for the child
  "stepId": "plan",                         // log file: <runId>/<stepId>.log
  "executor": {
    "agent": "claude" | "codex",
    "model": "claude-sonnet-4-6",
    "env": { "ANTHROPIC_BASE_URL": "...", "ANTHROPIC_AUTH_TOKEN": "..." },
    "router": "ccr"                         // optional — see CCR lifecycle below
  },
  "resumeSessionId": "uuid-abc"             // optional checkpoint path (passed as `--resume`)
}
```

(Note: prompts are sent separately via `POST /sessions/:id/prompt`;
`POST /sessions` has no `prompt` field.)

When `executor.router === "ccr"`, the supervisor lazy-starts the
bundled `@musistudio/claude-code-router` daemon on the first such
session in the supervisor's lifetime, then injects
`ANTHROPIC_BASE_URL=<ccr-proxy-url>` and
`ANTHROPIC_AUTH_TOKEN=<resolved>` into the child env (see "Env merge"
below). Subsequent `router=ccr` sessions reuse the same daemon. See
[CCR lifecycle](#ccr-lifecycle) and
[executors §CCR setup](system-analytics/executors.md#ccr-setup).

Responses:

| Status | Body | When |
| ------ | ---- | ---- |
| `201` | `{ "sessionId": "<uuid>", "pid": 12345, "acpSessionId": "<uuid>" }` | Spawn succeeded; ACP handshake completed. |
| `409` | `{ "code": "PRECONDITION", "message": "<zod path>: <issue>" }` | Body failed Zod validation. |
| `500` | `{ "code": "SPAWN", "message": "spawn <bin> failed: ENOENT" }` | Adapter binary not found on PATH. |
| `503` | `{ "code": "EXECUTOR_UNAVAILABLE", "message": "..." }` | CCR-related failure for `router=ccr` executors: CCR config file missing (`~/.claude-code-router/config.json` / `MAISTER_CCR_CONFIG_PATH`), malformed JSON, daemon failed to become ready within ~10s (health check on `GET /health`), identity-mismatch (another process owns the port), or `ANTHROPIC_AUTH_TOKEN` missing (no `executor.env.ANTHROPIC_AUTH_TOKEN` and no `MAISTER_CCR_AUTH_TOKEN`). Also reserved for future resource-cap rejections. Web-tier translation: `MaisterError("EXECUTOR_UNAVAILABLE")` → HTTP 503. |

### `DELETE /sessions/:id`

Stop a running session: `SIGTERM` → grace (`MAISTER_KILL_GRACE_MS`,
default 5000 ms) → `SIGKILL`. Marks the session as an
**intentional shutdown** so the heartbeat reports `session.exited`,
not `session.crashed`, even on non-zero exit codes.

| Status | Body | When |
| ------ | ---- | ---- |
| `204` | empty | Termination initiated; the SSE stream will report the terminal event. |
| `404` | `{ "code": "PRECONDITION", "message": "unknown session" }` | No such session in the registry. |

### `GET /sessions/:id/stream`

Server-Sent Events. One event per child stdout line, structured ACP
update, permission request, and terminal event. Clients can set
`Last-Event-ID:` to skip events they already received from the
per-session in-memory ring buffer (capped at 1000 entries). Run-level
durable replay is served by the web bridge at
`GET /api/runs/{runId}/stream`.

Event grammar:

```
id: <monotonicId>
event: session.line | session.update | session.permission_request | session.exited | session.crashed
data: <JSON, see below>
[blank line]
```

Payload shapes (`SessionEvent` union):

```jsonc
// session.line — every \n-terminated child stdout line
{ "type": "session.line", "sessionId": "...", "monotonicId": 1, "line": "<raw JSONL line>" }

// session.update — structured ACP session/update payload
{ "type": "session.update", "sessionId": "...", "monotonicId": 2, "update": { "...": "..." } }

// session.permission_request — ACP requestPermission waiting for HITL
{ "type": "session.permission_request", "sessionId": "...", "monotonicId": 3,
  "requestId": "<uuid>", "toolCall": { "...": "..." }, "options": [{ "optionId": "allow", "...": "..." }] }

// session.exited — clean exit OR intentional shutdown via DELETE
{ "type": "session.exited", "sessionId": "...", "monotonicId": N+1, "exitCode": 0 }

// session.crashed — non-zero exit, killing signal, or orphan detected by heartbeat
{ "type": "session.crashed", "sessionId": "...", "monotonicId": N+1,
  "exitCode": 1 | null, "signal": "SIGSEGV" | null }
```

The stream closes automatically after the terminal event. `session.line`
stays available for raw adapter logs and cost parsing; structured ACP
notifications use `session.update` and `session.permission_request`.

### `GET /sessions`

Returns the current `SessionRecord[]` — sessionId, runId, projectSlug,
stepId, status (`live | exited | crashed`), pid, startedAt, exitedAt,
exitCode, signal, logPath, monotonicId. Used by `lib/reconcile.ts` and
admin views.

### `POST /sessions/:id/checkpoint` *(designed)*

Returns `202 { "status": "deferred", "milestone": "M8" }`; `milestone`
is a compatibility marker in the current response body. The full
implementation will gracefully pause the agent (the agent persists its
own JSONL session store) so `--resume <session-id>` can rebuild context
later. Prior spike measurements put respawn cache creation around $0.28,
so keep-alive is cost-saving, not just UX.

### `POST /sessions/:id/input`

Permission-only HITL surface. Body is a Zod-validated discriminated
union on `action`:

```
{ kind: "permission", action: "select" | "cancel",
  requestId: <uuid>, optionId?: string, reason?: string }
```

`action: "select"` resolves the live ACP `requestPermission` deferred
held by the supervisor's `PendingPermissionRegistry` with
`{outcome: "selected", optionId}`. `action: "cancel"` resolves it with
`{outcome: "cancelled"}`. Status codes:

- `200 { ok: true }` — deferred settled.
- `503 { code: "EXECUTOR_UNAVAILABLE" }` — unknown session
  (retryable; typically a supervisor restart between
  `session.permission_request` emission and the user's response).
- `410 { code: "HITL_TIMEOUT" }` — known session but no pending
  deferred with that `requestId` (the deferred either timed out via
  `MAISTER_KEEPALIVE_MINUTES` or another request already
  resolved/cancelled it).
- `409 { code: "PRECONDITION" }` — Zod validation failure on the
  request body (e.g. `action="select"` with no `optionId`).

The supervisor never writes input artifacts: durable form / human
responses are written by the web tier's
`POST /api/runs/[runId]/hitl/[hitlRequestId]/respond` route after
its row-level claim succeeds.

### Run-scoped durable event log: `<runId>/run.events.jsonl`

Every `SessionEvent` (`session.line`, `session.update`,
`session.permission_request`, `session.exited`, `session.crashed`)
is appended to a single per-run JSONL file at
`.maister/<projectSlug>/runs/<runId>/run.events.jsonl` alongside the
existing per-step raw `<stepId>.log` and the in-memory ring buffer
that backs `GET /sessions/:id/stream`. Multiple spawns for the same
run append to the same file (slash-in-existing reuses one session
across steps; new-session-per-step spawns are sequential). On spawn,
`record.monotonicId` is seeded from the tail of the existing log so
the per-run event sequence stays strictly increasing across sessions
— this is what the web SSE bridge at `GET /api/runs/[runId]/stream`
relies on for cross-session `Last-Event-ID` resume.

## Module layout

```
supervisor/
├── package.json
├── tsconfig.json                  # strict, ES2022, bundler resolution
├── eslint.config.mjs              # mirrors web/ (no-console, import/order, prettier)
├── vitest.workspace.ts            # unit | integration split
├── src/
│   ├── main.ts                    # Fastify boot, pino logger, graceful shutdown
│   ├── http-api.ts                # HTTP routes + error handler (zod → 409, SupervisorError → status)
│   ├── spawn.ts                   # child_process.spawn dispatch; line-buffered stdout
│   ├── heartbeat.ts               # exit/error → session.exited/crashed + orphan watcher
│   ├── cost.ts                    # lenient JSON-parse → cost.jsonl
│   ├── events-log.ts              # durable run.events.jsonl append
│   ├── pending-permissions.ts     # live ACP requestPermission deferreds
│   ├── registry.ts                # in-memory Map + per-session event ring buffer
│   └── types.ts                   # Zod schemas + SessionEvent union + SupervisorError
└── test/
    └── fixtures/
        └── fake-acp.mjs           # stand-in for the real adapter binary in tests
```

## Errors

`SupervisorError` is internal to the supervisor (it does not extend
`MaisterError`, which is server-only inside web). It is translated to
JSON at the HTTP boundary.

| Code | HTTP | When |
| ---- | ---- | ---- |
| `PRECONDITION` | 409 (or 404 for unknown session) | Validation failure, duplicate sessionId. |
| `SPAWN` | 500 | `child_process.spawn` failed (ENOENT, EACCES…). |
| `EXECUTOR_UNAVAILABLE` | 503 | CCR-related failure, unknown live session during permission delivery, or future resource-cap rejection. |
| `ACP_PROTOCOL` | 500 | Wire-level ACP failure. |
| `CHECKPOINT` | 500 | Reserved for checkpoint failures. |
| `CRASH` | 500 | Reserved for heartbeat-promoted crash conditions. |
| `HITL_TIMEOUT` | 410 | Known session, but no pending permission deferred exists for the request id. |

The web client `web/lib/supervisor-client.ts` parses `{ code, message }`
from the body and re-throws as `MaisterError({ code })`. The taxonomy
of `MaisterError` lives in [Error Taxonomy](error-taxonomy.md).

## Cost accounting (`cost.jsonl`)

`cost.ts` observes the same stdout-line stream the SSE bridge uses,
JSON-parses each line **leniently** (silently skips non-JSON), and looks
for a `usage` object anywhere in the structure (top-level or nested,
bounded depth 8). When found, it appends a record to
`.maister/<projectSlug>/runs/<runId>/cost.jsonl`:

```jsonc
{
  "ts": "2026-05-26T12:34:56.789Z",
  "sessionId": "uuid",
  "model": "claude-sonnet-4-6",      // optional, scraped from same object tree
  "input_tokens": 100,
  "output_tokens": 200,
  "cache_creation_input_tokens": 5000,
  "cache_read_input_tokens": 0
}
```

`cache_creation_input_tokens` is the load-bearing field for ops. Prior
spike work measured roughly `$0.28` of cache-creation tokens per
cross-process respawn, so the keep-alive window is a cost control, not
only a UX control.

Records with no token fields are dropped (no `service_tier`-only rows).
JSON parse failures are silently skipped — the supervisor never crashes
on malformed adapter output.

## Configuration

All knobs are environment variables. Defaults assume a single-host
docker compose; production overrides go in `.env`.

| Var | Default | Purpose |
| --- | ------- | ------- |
| `MAISTER_SUPERVISOR_PORT` | `7777` | Bind port on `0.0.0.0`. |
| `MAISTER_SUPERVISOR_URL` | `http://localhost:7777` | Read by `web/lib/supervisor-client.ts`. |
| `MAISTER_RUNTIME_ROOT` | `process.cwd()` | Root under which `.maister/<slug>/runs/...` is written. |
| `MAISTER_HEARTBEAT_INTERVAL_MS` | `5000` | Orphan-child detection interval. |
| `MAISTER_KILL_GRACE_MS` | `5000` | SIGTERM → SIGKILL grace per child on DELETE and graceful shutdown. |
| `MAISTER_SHUTDOWN_GRACE_MS` | `15000` | Total wall-clock budget for graceful supervisor shutdown. |
| `MAISTER_KEEPALIVE_MINUTES` | `30` | Permission deferred timeout and web-stream inactivity timeout; also used by the designed checkpoint keep-alive path. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Per-executor `env` in `maister.yaml` wins; this is a process-wide default for the adapters. |
| `ANTHROPIC_AUTH_TOKEN` | unset | Required when `ANTHROPIC_BASE_URL` points at a third-party (z.ai GLM, OpenRouter, …). |
| `MAISTER_CCR_AUTH_TOKEN` | unset | Fallback `ANTHROPIC_AUTH_TOKEN` for `router=ccr` executors that don't pin a per-executor token in `executor.env`. Missing → 503 `EXECUTOR_UNAVAILABLE` at spawn. |
| `MAISTER_CCR_CONFIG_PATH` | `/app/.ccr/config.json` (Docker) / `~/.claude-code-router/config.json` (otherwise) | Where the supervisor reads CCR's `HOST`/`PORT`. Missing file or malformed JSON → 503 `EXECUTOR_UNAVAILABLE` at spawn. |
| `LOG_LEVEL` | `debug` | pino level: `trace | debug | info | warn | error | fatal | silent`. |

Secrets MUST NEVER appear in:

- SSE events visible to the browser
- `cost.jsonl` (verified in the integration test with a sentinel token)
- the step `.log` file (sentinel-test enforced)
- the supervisor's own logs (env values are summarized as `hasEnv: true|false`, never echoed)

**Env merge semantics for the spawned child:** `supervisor/src/spawn.ts`
builds the child's env as
`{ ...process.env, ...ccrLayer, ...executor.env }` — three layers with
`executor.env` always winning on collision:

1. `process.env` — the supervisor's own env at startup (base).
2. `ccrLayer` — empty when `executor.router !== "ccr"`. When CCR is
   active, contains exactly two keys: `ANTHROPIC_BASE_URL=<ccr-proxy-url>`
   (from `ccrManager.getProxyUrl()`) and `ANTHROPIC_AUTH_TOKEN=<resolved>`
   (from `executor.env.ANTHROPIC_AUTH_TOKEN ?? MAISTER_CCR_AUTH_TOKEN`).
3. `executor.env` — per-executor block from `maister.yaml`.

This means:

- `executor.env.ANTHROPIC_AUTH_TOKEN` always wins over the supervisor's
  own `ANTHROPIC_AUTH_TOKEN` AND over the CCR-injected token, which is
  what you want when pinning one particular executor through z.ai GLM,
  OpenRouter, etc. — even with CCR routing active.
- The supervisor's `ANTHROPIC_API_KEY` is also inherited by the child
  even when not overridden — the adapter binary picks the right
  credential based on its own logic (`ANTHROPIC_AUTH_TOKEN` if the
  third-party base URL is set; `ANTHROPIC_API_KEY` otherwise). If you
  want to **deny** the supervisor's process env from reaching an
  executor (e.g., a CCR-routed executor that must NOT see the raw
  Anthropic key), unset the relevant variable in the supervisor's
  process env at startup; do not rely on `executor.env` to "shadow"
  values it doesn't list. Phase 2 may add an explicit allow-list mode.

## CCR lifecycle

When `executor.router === "ccr"` on `POST /sessions`, the supervisor
goes through `ccrManager.ensureRunning()` before spawning the adapter:

- **Singleton per supervisor process.** The CCR daemon spawns at most
  once per supervisor process — lazy on the first `router=ccr` session,
  reused by every subsequent one. No per-session daemon, no
  per-executor daemon.
- **Configuration is operator-managed.** Host+port come from
  `MAISTER_CCR_CONFIG_PATH` (default per env-vars table above), keys
  `HOST` and `PORT` at the JSON root. Defaults `127.0.0.1:3456` apply
  when those keys are absent but the file is valid JSON. The file is
  read-only from the supervisor's perspective.
- **Readiness probe validates target identity.** The supervisor polls
  `GET /health` (CCR's own endpoint). Only HTTP 200 counts as ready;
  404 surfaces as an "identity mismatch" 503 (another process owns the
  port). A child exit before readiness aborts the probe with a
  target-aware error.
- **Shutdown is gated on the existing supervisor handler.** The
  `SIGTERM`/`SIGINT` handler in `supervisor/src/main.ts` awaits
  `ccrManager.shutdown({ timeoutMs: 5000 })` before exiting, so the
  CCR daemon dies with the supervisor. Escalation: SIGTERM → observed
  exit event vs grace timer → SIGKILL on timer win → `await exited`
  (never `proc.killed`; see
  [`.ai-factory/rules/backend.md`](../.ai-factory/rules/backend.md)).
- **All failure modes surface as `EXECUTOR_UNAVAILABLE` (503).** Full
  table in
  [executors §CCR setup](system-analytics/executors.md#ccr-setup).

## Running locally

```bash
# From repo root — the workspace is monorepo-wide.
pnpm install --frozen-lockfile

# Standalone (handy for tests / smoke):
pnpm --filter @maister/supervisor dev          # tsx watch src/main.ts
pnpm --filter @maister/supervisor start        # tsx src/main.ts (no watch)

# Via compose (dev: with hot reload, ports 3000 + 7777 exposed):
docker compose up -d
docker compose logs -f supervisor

# Production-style compose (read-only, hardened):
MAISTER_IMAGE=registry.example.com/maister/app:1.2.3 \
docker compose -f compose.yml -f compose.production.yml up -d
```

When running locally without docker, the web tier defaults to
`http://localhost:7777` — start the supervisor first.

## Testing

```bash
pnpm --filter @maister/supervisor test:unit          # 30 tests: registry, types, cost, spawn
pnpm --filter @maister/supervisor test:integration   # 9 scenarios: lifecycle, SSE, crash, secret-redact
```

The integration test boots Fastify on an ephemeral port and spawns
`node test/fixtures/fake-acp.mjs` via `binaryOverride` so it never
needs the real adapter binaries on PATH. Same fixture is used by the
unit spawn test.

## Current Wire Shape

The supervisor speaks JSON-RPC via `@agentclientprotocol/sdk@0.22.1`'s
`ClientSideConnection` for every session. `POST /sessions` does not
accept a `prompt` field; prompts are sent to the live ACP session via
`POST /sessions/:id/prompt`.

`POST /sessions` body:

```json
{
  "runId":         "run-1",
  "projectSlug":   "demo-app",
  "worktreePath":  "/abs/path",
  "stepId":        "plan",
  "executor":      { "agent": "claude", "model": "claude-sonnet-4-6" },
  "resumeSessionId": "uuid-abc"        // optional
}
```

The response now also includes the negotiated ACP session id:

```json
{ "sessionId": "...", "pid": 1234, "acpSessionId": "..." }
```

`POST /sessions/:id/prompt`:
```json
{ "stepId": "plan", "prompt": "..." }
```
Body validated by `SendPromptRequestSchema` (`stepId` must match
`^[A-Za-z0-9._-]+$`, `prompt ≤ 1 MB`). Response:
```json
{ "stopReason": "end_turn", "meta": null }
```
`stopReason` ∈ `end_turn | max_tokens | max_turn_requests | refusal`.
`cancelled` is mapped to a 500 `ACP_PROTOCOL` error.

`POST /sessions/:id/input` resolves live ACP permission requests only.
Form and human responses stay in the web tier and are written as
durable input artifacts after the HITL row is claimed.

SSE event types:

- `session.update` — carries the structured `acp.SessionNotification.update`
  payload (`agent_message_chunk`, `tool_call`, `plan`, etc.).
- `session.permission_request` — carries the live ACP permission request
  and option ids. The web tier persists the HITL row, then resolves the
  deferred through `/sessions/:id/input` after the user responds.

The legacy `session.line` event type stays — `cost.ts` and any other
raw-line consumer keep working unchanged. The supervisor tees stdout
through a `PassThrough` so both consumers see every chunk.

## Remaining Designed Pieces

- **Checkpoint/resume:** `POST /sessions/:id/checkpoint` returns
  `202 {status:"deferred", milestone:"M8"}` with the current
  compatibility marker until the keep-alive and `--resume` path lands.
- **Session endpoint replay:** `GET /sessions/:id/stream` replays only
  the in-memory ring buffer. Durable replay is intentionally a web
  run-level concern through `GET /api/runs/{runId}/stream`.
- **Executor breadth:** current adapters are Claude and Codex via ACP.
  Additional executors remain Phase 2.
- **Plugin sandboxing and trust UI:** Current target trusts internal Flow sources;
  sandboxing is Phase 2.

## See Also

- [Configuration](configuration.md) — `maister.yaml` v2 + env vars
- [Error Taxonomy](error-taxonomy.md) — `MaisterError` codes the web tier raises after translation
- [Supervisor OpenAPI](api/supervisor.openapi.yaml) — exact HTTP contract
- [Supervisor SSE AsyncAPI](api/async/supervisor-sse.asyncapi.yaml) — exact SSE event union
- [Architecture](architecture.md) — dependency rules and current system shape
