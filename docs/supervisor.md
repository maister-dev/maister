[← Configuration](configuration.md) · [Back to README](../README.md)

# Supervisor Daemon

The supervisor is a second Node process that owns the lifecycle of agent
processes (`claude-agent-acp`, `codex-acp`). It speaks **HTTP + SSE** to
the web tier and **stdio JSONL** to its spawned children. M3 scope: the
process skeleton — spawn, heartbeat, cost accounting, six HTTP routes.
Structured ACP event parsing (M7), keep-alive + checkpoint + `--resume`
(M8), HITL input delivery (M7/M10) — explicitly deferred and stubbed.

```
                     ┌─────────────────────┐                ┌──────────────────────────┐
  web/                │  web/lib/           │   HTTP+SSE     │  supervisor/ (Fastify)   │
   - app/api/runs     │  supervisor-client  │ ─────────────▶ │   POST/DELETE /sessions  │
   - lib/reconcile    │  (server-only)      │ ◀─── SSE ───── │   GET /sessions/:id/stream
                      └─────────────────────┘                │   GET /sessions          │
                                                              │   POST .../checkpoint    │
                                                              │   POST .../input  (501)  │
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
[`ARCHITECTURE.md`](../.ai-factory/ARCHITECTURE.md). The M0 spike findings
(package versions, cross-process resume cost) live in
[`M0 Spike Findings`](kaa-maister-m0-spike-findings-20260525.md).

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
  "prompt": "/aif-plan ...",                // M3: not yet plumbed into the child
  "executor": {
    "agent": "claude" | "codex",
    "model": "claude-sonnet-4-6",
    "env": { "ANTHROPIC_BASE_URL": "...", "ANTHROPIC_AUTH_TOKEN": "..." },
    "router": "ccr"                         // optional, reserved for CCR routing
  },
  "resumeSessionId": "uuid-abc"             // optional, M8 path (passed as `--resume`)
}
```

Responses:

| Status | Body | When |
| ------ | ---- | ---- |
| `201` | `{ "sessionId": "<uuid>", "pid": 12345 }` | Spawn succeeded. |
| `409` | `{ "code": "PRECONDITION", "message": "<zod path>: <issue>" }` | Body failed Zod validation. |
| `500` | `{ "code": "SPAWN", "message": "spawn <bin> failed: ENOENT" }` | Adapter binary not found on PATH. |
| `503` | `{ "code": "EXECUTOR_UNAVAILABLE", "message": "..." }` | Reserved for resource-cap rejections (not used in M3). |

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

Server-Sent Events. One event per child stdout line plus the terminal
event. Newer clients can set `Last-Event-ID:` to skip events they already
received — M3 honors it via a per-session in-memory ring buffer
(capped at 1000 entries); full log-file replay (for older terminal events
after the registry GC'd the entry) lands in M7+M9.

Event grammar:

```
id: <monotonicId>
event: session.line | session.exited | session.crashed
data: <JSON, see below>
[blank line]
```

Payload shapes (`SessionEvent` union):

```jsonc
// session.line — every \n-terminated child stdout line
{ "type": "session.line", "sessionId": "...", "monotonicId": 1, "line": "<raw JSONL line>" }

// session.exited — clean exit OR intentional shutdown via DELETE
{ "type": "session.exited", "sessionId": "...", "monotonicId": N+1, "exitCode": 0 }

// session.crashed — non-zero exit, killing signal, or orphan detected by heartbeat
{ "type": "session.crashed", "sessionId": "...", "monotonicId": N+1,
  "exitCode": 1 | null, "signal": "SIGSEGV" | null }
```

The stream closes automatically after the terminal event. M3 treats
each `line` as opaque JSONL — the web tier (M7+) will parse it into
structured ACP `session/update` events.

### `GET /sessions`

Returns the current `SessionRecord[]` — sessionId, runId, projectSlug,
stepId, status (`live | exited | crashed`), pid, startedAt, exitedAt,
exitCode, signal, logPath, monotonicId. Used by `lib/reconcile.ts` and
admin views.

### `POST /sessions/:id/checkpoint` *(stub — M8)*

Returns `202 { "status": "deferred", "milestone": "M8" }`. The full
implementation will gracefully pause the agent (the agent persists its
own JSONL session store) so `--resume <session-id>` can rebuild context
later. See M0 spike findings on the ~$0.28 cache-creation cost per
respawn — the implication is that **keep-alive is cost-saving**, not just
UX.

### `POST /sessions/:id/input` *(stub — M7)*

Returns `501 { "code": "ACP_PROTOCOL", "message": "Not implemented in M3 — see M7" }`.
M7 will wire HITL input delivery: `session/request_permission` for binary
approve/deny, and structured-form responses via artifact + ACP message.

## Module layout

```
supervisor/
├── package.json
├── tsconfig.json                  # strict, ES2022, bundler resolution
├── eslint.config.mjs              # mirrors web/ (no-console, import/order, prettier)
├── vitest.workspace.ts            # unit | integration split
├── src/
│   ├── main.ts                    # Fastify boot, pino logger, graceful shutdown
│   ├── http-api.ts                # 6 routes + error handler (zod → 409, SupervisorError → status)
│   ├── spawn.ts                   # child_process.spawn dispatch; line-buffered stdout
│   ├── heartbeat.ts               # exit/error → session.exited/crashed + orphan watcher
│   ├── cost.ts                    # lenient JSON-parse → cost.jsonl
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
| `EXECUTOR_UNAVAILABLE` | 503 | Reserved for resource limits / executor pool exhaustion (M6). |
| `ACP_PROTOCOL` | 500 | Wire-level failure (used by the input stub today). |
| `CHECKPOINT` | 500 | Reserved for M8 checkpoint failures. |
| `CRASH` | 500 | Reserved for heartbeat-promoted crash conditions. |

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

`cache_creation_input_tokens` is the load-bearing field for ops:
[M0 spike findings](kaa-maister-m0-spike-findings-20260525.md) measured
~$0.28 of cache-creation tokens per cross-process respawn. The 30-min
keep-alive window (M8) is the lever that controls this.

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
| `MAISTER_KEEPALIVE_MINUTES` | `30` | Reserved for M8 (NeedsInput keep-alive window). |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Per-executor `env` in `maister.yaml` wins; this is a process-wide default for the adapters. |
| `ANTHROPIC_AUTH_TOKEN` | unset | Required when `ANTHROPIC_BASE_URL` points at a third-party (z.ai GLM, OpenRouter, …). |
| `LOG_LEVEL` | `debug` | pino level: `trace | debug | info | warn | error | fatal | silent`. |

Secrets MUST NEVER appear in:

- SSE events visible to the browser
- `cost.jsonl` (verified in the integration test with a sentinel token)
- the step `.log` file (sentinel-test enforced)
- the supervisor's own logs (env values are summarized as `hasEnv: true|false`, never echoed)

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

## Limitations on POC

- **No structured ACP parsing** — M3 ships opaque JSONL passthrough; M7
  decomposes `session/update` into the typed event union.
- **No HITL input** — `POST /sessions/:id/input` returns 501; M7 wires
  binary `session/request_permission`, M10 adds the structured-form path.
- **No keep-alive or `--resume` plumbing** — `POST /sessions/:id/checkpoint`
  is 202 stub; M8 ships the keep-alive window + JSONL session-store
  checkpoint + cross-process resume.
- **`lastEventId` replay is bounded to the in-memory ring buffer** (1000
  entries per session). Older terminal events after the 30 s post-exit
  grace period are gone. The web tier's eventual log-file tail bridge
  (M7+M9) fills that gap.
- **No Cursor / opencode / Aider executors** — POC = `claude` + `codex`
  only via the `@agentclientprotocol/*` adapter binaries.
- **No plugin sandboxing or trust UI** — POC trusts internal Flow
  sources; sandboxing is Phase 2.

## See Also

- [Configuration](configuration.md) — `maister.yaml` v2 + env vars
- [Error Taxonomy](error-taxonomy.md) — `MaisterError` codes the web tier raises after translation
- [ACP Pivot Revision](kaa-maister-design-20260525-acp-revision.md) — the multi-executor design that motivated the supervisor split
- [M0 Spike Findings](kaa-maister-m0-spike-findings-20260525.md) — adapter package versions and cross-process resume cost
- [Architecture](../.ai-factory/ARCHITECTURE.md) — dependency rules; the supervisor↔web wire contract
