[← Configuration](configuration.md) · [Back to README](../README.md)

# Supervisor Daemon

The supervisor is a second Node process that owns the lifecycle of agent
processes (`claude-agent-acp`, `codex-acp`). It speaks **HTTP + SSE** to
the web tier and **stdio JSONL** to its spawned children. M3 scope: the
process skeleton — spawn, heartbeat, cost accounting, HTTP routes.
Structured ACP event parsing (M7), keep-alive + checkpoint + `--resume`
(M8), HITL input delivery (M7/M10) — explicitly deferred and stubbed.

```
                     ┌─────────────────────┐                ┌──────────────────────────┐
  web/                │  web/lib/           │   HTTP+SSE     │  supervisor/ (Fastify)   │
   - app/api/runs     │  supervisor-client  │ ─────────────▶ │   GET /health             │
   - app shell        │  (server-only)      │                │   POST/DELETE /sessions  │
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
[`ARCHITECTURE.md`](../.ai-factory/ARCHITECTURE.md). The M0 spike findings
(package versions, cross-process resume cost) live in
[`M0 Spike Findings`](kaa-maister-m0-spike-findings-20260525.md).

## HTTP API

All routes return `application/json`. Error responses match
[`SupervisorErrorBody`](#errors) and the web client translates them into
`MaisterError({ code })` via `web/lib/supervisor-client.ts`.

### `GET /health`

Readiness probe for the supervisor daemon itself. `200` means the
daemon is reachable and can accept new session work:

```json
{
  "status": "ready",
  "version": "0.0.1",
  "uptimeMs": 12345,
  "sessions": { "live": 2, "exited": 1, "crashed": 0 },
  "checkedAt": "2026-05-30T12:00:00.000Z"
}
```

The body intentionally contains no project ids, run ids, executor
secrets, env vars, or filesystem paths. The web tier treats network
errors, timeouts, non-200 responses, and malformed bodies as
`unavailable`; there is no "connected" fallback. `POST /api/runs`
checks this readiness after auth/project/Flow/executor validation and
before `git worktree add` or DB writes. On unavailable supervisor it
returns `503 EXECUTOR_UNAVAILABLE` and leaves the task in `Backlog`.

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
  "capabilityProfilePath": "/repos/myapp/.maister/runs/run-abc/profile.json",
  "adapterLaunch": {
    "env": { "MAISTER_CAPABILITY_PROFILE": "/repos/myapp/.maister/runs/run-abc/profile.json" },
    "preArgs": ["--config", "/repos/myapp/.maister/runs/run-abc/adapter.json"],
    "postArgs": []
  },
  "resumeSessionId": "uuid-abc"             // optional, M8 path (passed as `--resume`)
}
```

(Note: prompts are sent separately via `POST /sessions/:id/prompt`
since M5 — the body field is gone.)

When `executor.router === "ccr"`, the supervisor lazy-starts the
bundled `@musistudio/claude-code-router` daemon on the first such
session in the supervisor's lifetime, then injects
`ANTHROPIC_BASE_URL=<ccr-proxy-url>` and
`ANTHROPIC_AUTH_TOKEN=<resolved>` into the child env (see "Env merge"
below). Subsequent `router=ccr` sessions reuse the same daemon. See
[CCR lifecycle](#ccr-lifecycle) and
[executors §CCR setup](system-analytics/executors.md#ccr-setup).

`capabilityProfilePath` and `adapterLaunch` are Designed for scratch runs and
Flow capability-scoped sessions. The web tier owns capability policy,
resolution, trust checks, and materialization; the supervisor only receives a
server-derived absolute profile path plus a constrained set of materializer
outputs to pass to the adapter process. The request body must not allow callers
to override the adapter binary, `cwd`, run id, project slug, or worktree path.

`adapterLaunch` supports only:

- `env`: additional environment variables from the materializer. These are
  merged after `executor.env` and must not be logged as values.
- `preArgs`: extra adapter arguments inserted before the supervisor-managed
  `--resume <id>` pair.
- `postArgs`: extra adapter arguments appended after supervisor-managed args.

The supervisor rejects malformed paths, `..` segments, non-string env values,
and oversized arg/env lists with `409 PRECONDITION`.

#### Capability adapter support matrix (Designed)

| Capability kind | Claude adapter | Codex adapter | V1 behavior |
| --------------- | -------------- | ------------- | ----------- |
| MCP activation | Materialized MCP config path passed through `adapterLaunch`; enforced when the adapter accepts the config. | Materialized MCP config path passed through `adapterLaunch`; enforced when the adapter accepts the config. | Enforced when mapped for the selected adapter; refused when marked enforced but unsupported. |
| Skills | Materialized skill files and prompt references. | Materialized skill files and prompt references. | Instructed-only unless adapter-specific skill loading is proven in tests. Enforced skill loading is refused when unsupported. |
| Rules | Materialized rule files plus prompt policy. | Materialized rule files plus prompt policy. | Instructed-only in v1. |
| Settings | Adapter settings file path through `adapterLaunch`. | Adapter settings file path through `adapterLaunch`. | Enforced only for allow-listed settings generated by MAIster. Unknown settings are refused. |
| Restrictions | Prompt policy and adapter settings when available. | Prompt policy and adapter settings when available. | Refused for enforced restrictions the adapter cannot enforce; instructed-only restrictions are recorded as downgrades in the profile. |
| Tools / agent definitions | Not activated directly by supervisor. | Not activated directly by supervisor. | Refused as enforced capabilities in v1; optional entries are downgraded to instructed-only only when persisted in the profile. |

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

### `POST /sessions/:id/checkpoint` *(Implemented M8)*

Real graceful-checkpoint endpoint. Body is `{}` strictly (Zod-validated
empty object; unknown keys → 409 PRECONDITION). For each open
pending-permission deferred owned by the session, the supervisor
calls `pendingPermissions.cancel(sessionId, requestId, "checkpoint")`
— the same wire-level outcome shape M7's operator-cancel produces,
plus a supervisor-side `reason` marker that propagates onto the
`session.exited` event. The supervisor then `markIntentionalShutdown`s
the session with `reason="checkpoint"`, SIGTERMs the child, and waits
for graceful exit up to `MAISTER_KILL_GRACE_MS`. If the grace expires
the supervisor SIGKILLs and returns `500 EXECUTOR_UNAVAILABLE` — the
web sweeper treats this as retryable and re-attempts on the next tick.

Status codes:

- `200 { alreadyCheckpointed: boolean, sessionId, monotonicId }` —
  graceful exit completed (or idempotent ack if the session was
  already in `exited`/`crashed`).
- `404 { code: "PRECONDITION" }` — unknown sessionId.
- `409 { code: "PRECONDITION" }` — body contained unknown keys.
- `500 { code: "EXECUTOR_UNAVAILABLE" }` — SIGTERM grace expired,
  SIGKILL was issued; sweeper retries.

#### Checkpoint + Resume lifecycle

When a `NeedsInput` run's `keepalive_until` expires the web sweeper
calls this endpoint, which:

1. Cancels every pending permission with `reason="checkpoint"`. The
   agent observes `{outcome:"cancelled"}` at the ACP layer and records
   the cancellation in its own session JSONL store so a future
   `--resume <acpSessionId>` can replay the request. See
   [`kaa-maister-m8-spike-findings-20260529.md`](kaa-maister-m8-spike-findings-20260529.md)
   for the verified-via-mock-adapter contract.
2. Marks the session intentional with reason `"checkpoint"`. Heartbeat
   reads this on the child exit and emits
   `session.exited { reason: "checkpoint" }` (optional field —
   see AsyncAPI spec).
3. SIGTERMs the child with `MAISTER_KILL_GRACE_MS` grace.
4. On 200 the web sweeper runs `markCheckpointed(runId)` →
   `NeedsInputIdle` and `releaseSlotOnIdle` → `promoteNextPending`.
5. **Web-runner obligation (M8 Codex review fix #1).** The web
   runner-agent (`web/lib/flows/runner-agent.ts`) consumes the SSE
   stream concurrently with `sendPrompt`. When it observes
   `session.exited.reason="checkpoint"`, it MUST suppress step success
   regardless of the adapter's `stopReason` (which will be `end_turn`
   for a journaled-cancelled permission). The runner-agent calls
   `markCheckpointedFromExit(runId)` (identical SQL to
   `markCheckpointed` with a distinct log marker) and returns the step
   with `errorCode: "STEP_CHECKPOINTED"`. `runFlow` treats this as a
   pause: no terminal `Review`/`Failed`/`Crashed` write, no step
   advance, `promoteNextPending` to free the slot since the row is now
   in `NeedsInputIdle`. Without this contract a checkpoint mid-permission
   would race the sweeper's idle transition and the runner would
   silently mark the step succeeded with the cancelled-and-journaled
   permission un-replayed.

Operator response on `NeedsInputIdle` runs goes through web's
`POST /api/runs/:runId/hitl/:hitlRequestId/respond` (idle branch);
the web tier calls `resumeRun(runId)` which issues a fresh
`POST /sessions` with `resumeSessionId: <acpSessionId>`. The
supervisor passes `--resume <acpSessionId>` to the adapter binary
(see `spawn.ts:147-151`), the adapter's `newSession()` returns the
prior `acpSessionId`, and on the next prompt re-issues
`session.permission_request` for the cancelled tool call. The
runner-agent's permission handler auto-delivers the stored intent
against the new requestId; the original `hitl_requests` row's
`respondedAt` is set with audit
`{originalRequestId, reissuedRequestId, deliveredViaResume: true}`.

Each respawn costs ~$0.28 of `cache_creation_input_tokens` per the M0
spike — keep-alive is the cost lever, not just UX. Resumed sessions'
`cost.jsonl` entries carry `resumed: true` for ops attribution.

### `POST /sessions/:id/input` *(M7+)*

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

### Run-scoped durable event log: `<runId>/run.events.jsonl` *(M7+)*

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
| `EXECUTOR_UNAVAILABLE` | 503 | CCR-related failure for `router=ccr` executors (config missing / malformed JSON / daemon failed to become ready / identity mismatch / `ANTHROPIC_AUTH_TOKEN` missing). Also reserved for future resource-cap rejections. Implemented M6. |
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
| `MAISTER_KEEPALIVE_MINUTES` | `30` | NeedsInput keep-alive window (minutes). Bounds the pending-permission deferred timeout (M7) AND the web-side sweeper-driven NeedsInput → NeedsInputIdle transition (M8). Bumped by every web activity ping. |
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

**Env merge semantics for the spawned child:** implemented
`supervisor/src/spawn.ts` builds the child's env as
`{ ...process.env, ...ccrLayer, ...executor.env }`. The Designed
capability-launch extension appends `...adapterLaunch.env` as the final layer
after validating it was produced by the web materializer:

1. `process.env` — the supervisor's own env at startup (base).
2. `ccrLayer` — empty when `executor.router !== "ccr"`. When CCR is
   active, contains exactly two keys: `ANTHROPIC_BASE_URL=<ccr-proxy-url>`
   (from `ccrManager.getProxyUrl()`) and `ANTHROPIC_AUTH_TOKEN=<resolved>`
   (from `executor.env.ANTHROPIC_AUTH_TOKEN ?? MAISTER_CCR_AUTH_TOKEN`).
3. `executor.env` — per-executor block from `maister.yaml`.
4. `adapterLaunch.env` — Designed, run-scoped capability materializer output.
   It wins on collision so a run-scoped MCP/settings profile can point the
   adapter at the materialized files for that one session.

This means:

- `executor.env.ANTHROPIC_AUTH_TOKEN` wins over the supervisor's own
  `ANTHROPIC_AUTH_TOKEN` and over the CCR-injected token in the implemented
  path, which is what you want when pinning one particular executor through
  z.ai GLM, OpenRouter, etc. — even with CCR routing active. Designed
  `adapterLaunch.env` wins only for materializer-produced session-scoped
  values.
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

## M5 wire change

M5 (2026-05-27) lands the request-side ACP wire. The supervisor now
speaks JSON-RPC via `@agentclientprotocol/sdk@0.22.1`'s
`ClientSideConnection` for every session.

**Breaking change vs M3:**
`POST /sessions` no longer accepts a `prompt` field. The body is now:

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

**New endpoint:** `POST /sessions/:id/prompt`
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

`POST /sessions/:id/input` remains a 501 stub for M7 (HITL response
delivery — different semantics).

**New SSE event types** (in addition to `session.line`,
`session.exited`, `session.crashed`):

- `session.update` — carries the structured `acp.SessionNotification.update`
  payload (`agent_message_chunk`, `tool_call`, `plan`, etc.). Web tier
  bridges these as-is and decomposes them downstream (M7+).
- `session.permission_auto` — emitted whenever the supervisor
  auto-allows a `requestPermission` (M5 policy). Payload:
  `{toolCall, optionId}`. M7 replaces with a blocking
  `session.permission_request` + artifact-driven response.

The legacy `session.line` event type stays — `cost.ts` and any other
raw-line consumer keep working unchanged. The supervisor tees stdout
through a `PassThrough` so both consumers see every chunk.

## Limitations on POC

- **No structured HITL** — `requestPermission` is auto-allowed in M5
  with WARN log + `session.permission_auto` SSE event. M7 wires the
  blocking variant.
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
