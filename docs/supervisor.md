[← Configuration](configuration.md) · [Back to README](../README.md)

# Supervisor Daemon

The supervisor is a second Node process that owns the lifecycle of agent
processes. Implemented adapters are `claude-agent-acp` and `codex-acp`;
ADR-084/ADR-085 add `gemini --acp`, `opencode acp`, and `mimo acp` as
readiness-gated code-owned ACP adapter families. It speaks **HTTP + SSE** to
the web tier and **ACP JSON-RPC over stdio** to its spawned adapter children.
The current contract includes spawn, asynchronous prompt admission, structured
ACP event parsing, permission HITL, checkpoint, resume, heartbeat promotion,
and canonical cost facts.

**ADR-136 non-expansion:** task-bound `agent_question` clarification is a web
and Postgres handoff. V1 adds no ACP method, notification, input delivery, or
resume behavior to this supervisor contract.

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
                                                │ claude-agent-acp / codex-acp         │
                                                │ gemini --acp / opencode acp / mimo acp│
                                                │  cwd = worktreePath                  │
                                                │  stdio: pipe/pipe/inherit            │
                                                └──────────────────────────────────────┘
                                                                           │ stdout JSONL
                                                                           ▼
                              private <step>.log (host diagnostics)
                              state.sqlite outbox (durable host events)
```

## Why a separate process

Agent processes can run for tens of minutes. Holding them inside Next.js
makes every HMR reload (dev) and every Next.js restart (prod) kill live
runs. The supervisor isolates that failure mode. The two processes share
the HTTP+SSE wire. Stage B removes the runtime-data filesystem dependency:
browser replay, transcripts, costs, artifacts, and prompt completion read
manager-owned Postgres state. Repository/worktree/Git operations remain
web-side under ADR-023, so a different supervisor host is still a Stage C/D
boundary. The execution-host contract below is the seam later stages build on.

The architectural decision and its trade-offs live in
[`ARCHITECTURE.md`](../.ai-factory/ARCHITECTURE.md). The ACP spike findings
(package versions, cross-process resume cost) live in
root `CLAUDE.md` §ACP Spike Findings (historical doc removed).

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
  "checkedAt": "2026-05-30T12:00:00.000Z",
  "host": {
    "hostKey": "eh_0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    "bootId": "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
    "protocolVersion": 1
  }
}
```

The body intentionally contains no project ids, run ids, runner
secrets, env vars, or filesystem paths. **(Implemented — ADR-166)** `host` is
the durable execution-host identity: `hostKey` survives restarts (it lives
in the [state store](#execution-host-state-store)), `bootId` changes on
every restart, `protocolVersion` is `1`. The web registrar upserts
`execution_hosts` from it on startup and lazily (30 s memo); a changed
`bootId` triggers one reconcile sweep. The web tier treats network
errors, timeouts, non-200 responses, and malformed bodies as
`unavailable`; there is no "connected" fallback. `POST /api/runs`
checks this readiness after auth/project/Flow/runner validation and
before `git worktree add` or DB writes. On unavailable supervisor it
returns `503 EXECUTOR_UNAVAILABLE` and leaves the task in `Backlog`.

### `POST /sessions`

Start a new agent process. Returns immediately after the child has been
spawned successfully (after the `spawn` event fires) — the SSE stream is
the source of truth for everything that happens next.

**(Implemented — ADR-166)** The body is a [command envelope](#command-envelope-fences-and-receipts-implemented--adr-166)
with `command.kind = "session.create"` whose `payload` is the request shown
below in its **handle form**: `executionWorkspaceId` (from
[`POST /workspaces/adopt`](#post-workspacesadopt-implemented--adr-166))
replaces `runId` + `projectSlug` + `worktreePath` + `repoPath` +
`confineRoot` + `contextMounts` — the host derives `cwd`, the content-block
confinement roots, the run dir, and the mounts from the handle. The contract
is strict: a bare body without an envelope is `409 PRECONDITION
{reason: missing_envelope}` on every command route; a payload carrying one of
the former path fields is `409 PRECONDITION {reason: legacy_field, field}`.

Request payload (`envelope.payload`):

```jsonc
{
  "executionWorkspaceId": "ws_5f3a8a2b7e344f6d9d2c1d4e5f6a7b8c",
  "stepId": "plan",                         // log file: <runId>/<stepId>.log
  "runner": {
    "version": 1,
    "runnerId": "claude-code-env-router",
    "adapter": "claude",
    "capabilityAgent": "claude",
    "model": "glm-5.1",
    "env": { "ANTHROPIC_MODEL": "env:CLAUDE_CODE_MODEL" },
    "provider": {
      "kind": "anthropic_compatible",
      "baseUrl": "https://api.z.ai/api/anthropic",
      "authTokenEnv": "ZAI_API_KEY"
    },
    "permissionPolicy": "default"
  },
  "executor": {
    "agent": "claude" | "codex",
    "model": "claude-sonnet-4-6",
    "env": { "ANTHROPIC_BASE_URL": "...", "ANTHROPIC_AUTH_TOKEN": "..." }
  },
  "capabilityProfilePath": "/repos/myapp/.maister/runs/run-abc/profile.json",
  "adapterLaunch": {
    "env": { "MAISTER_CAPABILITY_PROFILE": "/repos/myapp/.maister/runs/run-abc/profile.json" },
    "preArgs": ["--config", "/repos/myapp/.maister/runs/run-abc/adapter.json"],
    "postArgs": []
  },
  "resumeSessionId": "uuid-abc"             // optional, checkpoint-resume path (resumed via the ACP session/resume call, NOT a CLI flag)
}
```

(Note: prompts are admitted separately via `POST /sessions/:id/prompts`
— the body field is gone. Context mounts — ADR-157, max 8 — travel on the
`workspace.adopt` payload and are derived from the handle.)

(Note: `readOnlySession` (ADR-090) and `hooksConfig` (Designed — ADR-108)
are optional behavioral-policy fields beside the launch fields; both arbitrate
ACP permission requests pre-hoc at the supervisor seam. A `hooksConfig` trip
emits the `session.hook_trip` SSE event. Supervisor `/diagnostics` reports both
generic adapter ACP smoke and nested `smoke.readOnlySession` evidence. The web
tier treats generic pending/skipped smoke as advisory for normal runner
readiness, but standalone `workspace: none | repo_read` agent launches require
ok read-only-session evidence when the adapter descriptor says
`readOnlySessionSmoke: required`. Generic initialize/newSession smoke is not
enough for this nested dimension; `ok` must come from an adapter
prompt/permission probe that actually exercised the permission wire. See
`StartSessionRequest` and
`SupervisorDiagnosticsResponse`
in [`api/supervisor.openapi.yaml`](api/supervisor.openapi.yaml), plus
[`system-analytics/guardrail-hooks.md`](system-analytics/guardrail-hooks.md).)

The web tier resolves runner ids, checks readiness, materializes safe launch
metadata, and sends only normalized spawn intent. The supervisor remains the
only layer that resolves env refs into values and maps typed permission
policies to adapter argv.

ADR-084/ADR-085 adapter launch commands are fixed by the supervisor adapter registry:
`gemini` maps to `gemini --acp`; `opencode` maps to `opencode acp`; `mimo`
maps to `mimo acp`. Unsupported
adapter/provider/policy combinations, missing required env refs, binary
diagnostic failures, and unsupported checkpoint strategies are refused before
spawn when readiness has enough information. There is no fallback to
Claude/Codex and no operator-entered arbitrary command runner.

`capabilityProfilePath` and `adapterLaunch.env` are Implemented for scratch
runs. The web tier owns capability policy, resolution, trust checks, and the V1
materialization of `profile.json` plus `instructions.md`; the supervisor only
receives server-derived absolute paths and constrained materializer outputs to
pass to the adapter process. The request body must not allow callers to
override the adapter binary, `cwd`, run id, project slug, or worktree path.

`adapterLaunch` supports only:

- `env`: additional environment variables from the materializer. These are
  merged after `executor.env` and must not be logged as values.
- `preArgs`: extra adapter arguments inserted before supervisor-managed args.
- `postArgs`: extra adapter arguments appended after supervisor-managed args.

#### `contextMounts[]` and `MAISTER_CONTEXT_REPOS` (Implemented — ADR-157)

`contextMounts` is an optional array (max 8) of read-only sibling-repo context
mounts the **web tier** already materialized for this session. Each entry is
`{slug, path, ref, commit}`: the sibling project's slug, the absolute mount
root, the committish it was resolved from, and the commit sha it is detached
at. It is projected from the run's launch snapshot (`runs.context_mounts` —
`[{projectId, slug, repoPath, mountPath, committish}]`); the supervisor never
resolves a slug, a ref, or a repo path, and never creates or removes a
worktree. Mount roots live under the run dir
(`.maister/<slug>/runs/<runId>/context/<siblingSlug>/`), which is already inside
the prompt content-block confinement allow-set, so mounts imply no confinement
change. Each mount is validated at adoption like the workspace path itself
(`409 PRECONDITION {reason: "workspace_rejected", rule, mount: <slug>}` — see
[`POST /workspaces/adopt`](#post-workspacesadopt-implemented--adr-166)); an
over-length array is a Zod `409 PRECONDITION`.

It is a **first-class request field**, the same shape of thing as
`capabilityProfilePath` — deliberately **not** an overload of `executor.env`,
which is the provider-secret channel and stays that. From it the supervisor
derives exactly one child environment variable:

```
MAISTER_CONTEXT_REPOS=[{"slug":"api","path":"/abs/mount","ref":"main","commit":"<sha40>"}]
```

A JSON array of exactly those objects. JSON rather than a `:`-joined path list
because a path list throws away the two fields a consumer actually wants — the
slug (which sibling a path is) and the resolved commit (what was actually read).
A shell consumer needs `jq`; that cost is accepted because the primary consumer
is the agent, which reads the prompt preamble.

**It does NOT reach `cli`/`check` children.** Those run under the ADR-153
allow-listed env, and `MAISTER_CONTEXT_REPOS` is deliberately not on that list —
matching the DSL side, where `settings.context_repos` is accepted only on
`ai_coding` / `judge` / `orchestrator` nodes. If a packaged script ever needs
sibling paths, that is a separate ADR-153 allow-list change.

**Prompt preamble.** Beyond the env var, the supervisor renders a preamble on
the session's prompt listing each mount's **slug, absolute path, ref, and
read-only status**. The env var serves scripts; the preamble is how the agent
learns the mounts exist at all.

**Read-only path guard (L2).** When `contextMounts` is non-empty the ACP
permission handler denies, **unconditionally**, every write-class tool call
whose resolved path lands under any mount root. It is evaluated in the same
handler as `hooksConfig.pathGuard`, but it is not opt-in through
`settings.hooks` — the read-only contract is the mount's whole point. It
composes with `readOnlySession` (which covers only `none`/`repo_read` agent
runs; a writable-worktree flow session cannot use a session-wide read-only
without breaking its own work) and with `hooksConfig.pathGuard`; all three are
pre-hoc denies and the strictest wins. The guard matters even though mounts are
ephemeral: `git worktree add --detach` writes a `.git` **file** pointing into
the sibling repo's `.git/worktrees/<name>`, so an escaped write could touch
another project's repository metadata.

Contract: `StartSessionRequest.contextMounts` in
[`api/supervisor.openapi.yaml`](api/supervisor.openapi.yaml). DSL side:
[`flow-dsl.md`](flow-dsl.md) §`settings.context_repos`. Kill switch
`MAISTER_CONTEXT_MOUNT_ENABLED`: [`configuration.md`](configuration.md).

(Resume is NOT a CLI argument: when `resumeSessionId` is set the supervisor
restores the prior conversation via the ACP `session/resume` protocol call —
see the "Checkpoint + Resume lifecycle" section below.)

The supervisor rejects malformed paths, `..` segments, non-string env values,
and oversized arg/env lists with `409 PRECONDITION`.

### `GET /diagnostics`

Read-only runtime diagnostics for remote supervisor setup. Unlike `/health`,
this endpoint reports launch-specific readiness inputs: adapter binary
availability, binary source/path/version/error, cached adapter smoke evidence,
env-ref presence and supervisor version. It never returns
raw secret values.

Adapter diagnostic entries are:

```ts
{
  id: "claude" | "codex" | "gemini" | "opencode" | "mimo";
  binary: string;
  source: "path" | "override";
  path: string | null;
  available: boolean;
  version: string | null;
  error: string | null;
  smoke: {
    status: "not_required" | "pending" | "ok" | "skipped" | "error";
    reason: string | null;
    checkedAt: string | null;
    protocolVersion: number | null;
    readOnlySession: {
      status: "not_required" | "pending" | "ok" | "skipped" | "stale" | "error";
      reason: string | null;
      checkedAt: string | null;
      protocolVersion: number | null;
      probeVersion: number | null;
      staleReason: "probe_contract" | "freshness" | null; // required; non-null exactly for status="stale"
    }
  }
}
```

`source="path"` means the binary was resolved from the supervisor PATH.
`source="override"` means an explicit `MAISTER_ADAPTER_BINARY_*` env var was
used. `available=false` distinguishes missing PATH entries, non-executable
override paths, version probe failures, and adapter first-run writable-state
failures. This matters for OpenCode: a Homebrew binary can exist while the
process still fails to initialize its user state directory.

Gemini, OpenCode, and MiMo report cached ACP smoke evidence in diagnostics. The
supervisor reads the cache from `MAISTER_ADAPTER_SMOKE_CACHE_PATH` when set;
otherwise it looks for `adapter-smoke-cache.json` under its runtime root.
Operators update the cache with the opt-in smoke script:

```bash
pnpm -C supervisor smoke:acp --cache /path/to/adapter-smoke-cache.json gemini opencode mimo
```

Generic `smoke.status` is operator-visible health evidence: `error` makes the
adapter unavailable, while `pending` and `skipped` are advisory. Standalone
`workspace: none | repo_read` launches use the nested
`smoke.readOnlySession.status` evidence described above. When invoked with
`--read-only-session`, the smoke script opens an ACP session and sends dedicated
prompt probes that must observe read-like permission allow, write-like
permission deny, and unknown-kind deny decisions before writing nested `ok`
evidence. If the adapter does not produce those wire observations, the nested
dimension is written as `error` and read-only standalone launch stays refused.
The v2 cache also records the read-only probe contract version. Cache-v1 nested
read-only **`ok`** evidence, a mismatched probe version, a future `checkedAt`,
or evidence aged seven days or more is reported as diagnostic `stale`; a nested
cache-v1 `error` remains `error`, and generic v1 smoke remains readable for
ordinary readiness. `staleReason` is `probe_contract` for legacy/mismatched
probe evidence and `freshness` for future/expired evidence; Settings localizes
from this typed value rather than matching `reason` prose.
Starting a new read-only probe invalidates the targeted old evidence before
adapter work begins, so a crashed or partial probe cannot leave a reusable `ok`
behind. A per-cache SQLite mutex serializes the entire invalidation → probe →
write lifecycle across smoke processes; its OS lock is released if a process
crashes, so an older probe cannot overwrite a newer generic failure. Initialize, session
creation, and each permission probe are independently bounded to ten seconds;
a timeout is an error and never produces fresh eligibility evidence.

`envRefs` contains a fixed safe catalog of known runner env-ref names plus the
comma-separated names in `MAISTER_DIAGNOSTIC_ENV_REFS`. It reports presence
only, never values.

Diagnostics logs include `adapter`, binary source, executable path if known,
exit code, and a bounded stderr tail only. They must not include env values,
provider tokens, generated config bodies, or raw ACP frames.

#### Capability adapter support matrix (Implemented snapshot + designed native activation)

| Capability kind           | Claude adapter                                                                                              | Codex adapter                                                                                               | V1 behavior                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP activation            | Selected MCP ids are persisted in the profile and exposed to the adapter through profile/instruction paths. | Selected MCP ids are persisted in the profile and exposed to the adapter through profile/instruction paths. | Snapshot + instruction handoff is implemented. Adapter-specific MCP config generation is not yet implemented; enforced unsupported entries are refused by resolver policy. |
| Skills                    | Selected skill ids are persisted and listed in instructions.                                                | Selected skill ids are persisted and listed in instructions.                                                | Snapshot + instruction handoff is implemented. Adapter-native skill loading is designed, not implemented.                                                                  |
| Rules                     | Selected rule ids are persisted and listed in instructions.                                                 | Selected rule ids are persisted and listed in instructions.                                                 | Instructed-only in V1.                                                                                                                                                     |
| Settings                  | No adapter settings file is generated in V1.                                                                | No adapter settings file is generated in V1.                                                                | Designed follow-up; unknown enforced settings are refused by policy.                                                                                                       |
| Restrictions              | Persisted in the profile and listed in instructions.                                                        | Persisted in the profile and listed in instructions.                                                        | Refused for enforced restrictions the adapter cannot enforce; instructed-only restrictions are recorded as downgrades in the profile.                                      |
| Tools / agent definitions | Not activated directly by supervisor.                                                                       | Not activated directly by supervisor.                                                                       | Refused as enforced capabilities in v1; optional entries are downgraded to instructed-only only when persisted in the profile.                                             |

Responses:

| Status | Body                                                                | When                                                                                                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `201`  | `{ "sessionId": "<uuid>", "pid": 12345, "acpSessionId": "<uuid>" }` | Spawn succeeded; ACP handshake completed.                                                                                                                                                                                                                                                                            |
| `409`  | `{ "code": "PRECONDITION", "message": "<zod path>: <issue>" }`      | Body failed Zod validation.                                                                                                                                                                                                                                                                                          |
| `500`  | `{ "code": "SPAWN", "message": "spawn <bin> failed: ENOENT" }`      | Low-level spawn failed despite readiness: ENOENT, EACCES, first-run state failure, or OOM at fork.                                                                                                                                                                                                                   |
| `503`  | `{ "code": "EXECUTOR_UNAVAILABLE", "message": "..." }`              | Runner, adapter, env-ref, or checkpoint strategy is not launchable before spawn: adapter unsupported, binary diagnostics unavailable, required env ref missing, unsupported provider or permission policy, or supervisor readiness failure. Web-tier translation: `MaisterError("EXECUTOR_UNAVAILABLE")` → HTTP 503. |

### `POST /workspaces/adopt` _(Implemented — ADR-166)_

The ONLY path-bearing route. Body: a command envelope
(`command.kind = "workspace.adopt"`) whose payload is
`{ runId, projectSlug, kind, path, repoPath?, contextMounts? }` with
`kind ∈ git_worktree | repo_checkout | directory`. The host validates the
path per kind (absolute, no `..`, realpath exists, no symlink escape, not
inside the state dir; `git_worktree` under `MAISTER_WORKSPACE_ROOTS` with a
`.git` FILE whose `gitdir:` resolves under `<repoPath>/.git/worktrees/`;
`repo_checkout` = a git repo root equal to `repoPath`, any location;
`directory` under the roots, no `repoPath`), validates every `contextMounts[]`
entry as a git checkout (absolute, no `..`, realpath is a directory, a `.git`
directory or a linked worktree's `.git` file, not inside the state dir; stored
by realpath), derives and stores `run_dir` from its runtime root +
`projectSlug` + `runId`, and returns
`200 { executionWorkspaceId: "ws_<uuid>", kind, replayed }`. Idempotent on the
ACTIVE `(runId, realpath)` — the partial unique index `workspaces_active_uq`
covers `released_at IS NULL` only, so a released handle is history and
re-adopting the same path mints a NEW handle (an ADR-141 reopen re-creates the
worktree at the same path). Rejections are `409 PRECONDITION {reason:
"workspace_rejected", rule}` (+ `mount: <slug>` for a mount) — never 500; the
message names only the offending path (the configured roots and `repoPath`
are logged at debug, never echoed). The web tier adopts lazily before
the first `session.create` of an assignment and derives every value from
server state (`workspaces.worktree_path`, `projects.repo_path`,
`local_packages.working_dir`, the agent launch snapshot,
`runs.context_mounts`).

### `GET /workspaces/:id` · `DELETE /workspaces/:id` _(Implemented — ADR-166)_

`GET` returns the path-free projection `{ executionWorkspaceId, runId,
projectSlug, kind, adoptedAt, releasedAt? }` or 404 (the web reconciler
logs `workspace-handle-lost`; the next create re-adopts). `DELETE` takes a
`workspace.release` envelope, marks the handle released (a later create is
refused `workspace_released`), and returns `{ released }`; issued as a
`driverless` command by GC after worktree removal and by run-terminal drop
paths.

### `GET /commands/:commandId` _(Implemented — ADR-166)_

Returns the host's durable receipt for a command id —
`{ commandId, runId, kind, assignmentEpoch, phase: accepted | completed |
rejected, httpStatus, body, receivedAt, completedAt?, inflight }` — or 404
(`inflight` is process memory: `accepted` + `inflight: false` is the
restart-mid-turn signature). Read by
the web tier exactly once after an unknown-outcome transport failure on an
accepted prompt and during startup recovery of `delivering` / `accepted`
ledger rows.

### Command envelope, fences, and receipts _(Implemented — ADR-166)_

Every host-bound mutating route (`POST /sessions`, `POST /sessions/:id/
{prompt,input,cancel,checkpoint}`, `DELETE /sessions/:id`,
`POST /workspaces/adopt`, `DELETE /workspaces/:id`) takes:

```jsonc
{
  "command": {
    "id": "<uuid>",
    "kind": "session.prompt",
    "issuedAt": "<RFC 3339>",
  },
  "fence": {
    "hostKey": "eh_…",
    "assignmentId": "<uuid>",
    "assignmentEpoch": 2,
    "runId": "run-abc",
  },
  "payload": {
    /* kind-specific — the pre-ADR-166 body of that route */
  },
}
```

Handler order (`parseCommandBody` + `runCommand`): registry / handle lookup
(the 404 and the run the fence is checked against) → parse envelope → **fence**
(persist the high-water) → **receipt lookup / in-flight join** → execute
(evict lower-epoch sessions first, INSIDE the in-flight execution) → write
receipt → respond. Fence rules, in order: `fence.hostKey` ≠ own key →
`409 PRECONDITION host_mismatch`; `fence.runId` ≠ the session's / handle's run
→ `409 PRECONDITION run_mismatch`; `assignmentEpoch` below the persisted
per-run high-water → **`409 FENCED`** (`details: {reason: "assignment_fenced",
runId, commandEpoch, hostEpoch}`); equal epoch with a different
`assignmentId` → `409 PRECONDITION assignment_mismatch`; a HIGHER epoch →
persist it, then **evict** every live session of that run under a lower epoch
(cancel its deferreds with reason `fenced`,
`markIntentionalShutdown(reason="fenced")`, SIGTERM with kill grace,
`session.exited {reason: "fenced"}`, its pending prompt request answers
`409 FENCED`), then execute. The eviction runs inside the command's in-flight
execution, so a concurrent duplicate of the same `command.id` joins it instead
of executing beside a dying session. The high-water lives in the
[state store](#execution-host-state-store-implemented--adr-166) (`run_fences`)
and is written BEFORE execution, so it survives a restart. Receipts: a
duplicate `command.id` with a `completed` / `rejected` receipt replays the
stored response verbatim with `X-Maister-Command-Replayed: true` — replay wins
over the liveness and handle guards, which are judged inside the
receipt-guarded execution (a duplicate prompt id replays after the session
exited; a duplicate create id replays after its handle was released); a
duplicate while the original is in flight (any kind) **joins** it; an
`accepted` receipt with no in-flight promise (restart mid-turn) → `409
PRECONDITION turn_lost`; a receipt write failure → `500 ACP_PROTOCOL` (the
effect may have happened — the web reconcile catches an orphan session).
Receipts prune at boot and hourly (7-day TTL). Prompt completion additionally
emits the SSE `session.command` event (`phase: accepted`, then `phase:
completed` with `status` + `result` / `error`), also appended to
`run.events.jsonl`; a completion that lands after the session's terminal event
is appended once the closed per-run writer has drained, so the file keeps its
`monotonicId` order.

### `DELETE /sessions/:id`

Stop a running session: `SIGTERM` → grace (`MAISTER_KILL_GRACE_MS`,
default 5000 ms) → `SIGKILL`. Marks the session as an
**intentional shutdown** so the heartbeat reports `session.exited`,
not `session.crashed`, even on non-zero exit codes. **(Implemented —
ADR-166)** Takes a `session.delete` envelope; issued `driverless` so web
startup recovery may re-deliver it.

| Status | Body                                                       | When                                                                  |
| ------ | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `204`  | empty                                                      | Termination initiated; the SSE stream will report the terminal event. |
| `404`  | `{ "code": "PRECONDITION", "message": "unknown session" }` | No such session in the registry.                                      |
| `409`  | `{ "code": "PRECONDITION" \| "FENCED", "details": {…} }`   | Missing envelope, fence refusal, or stale epoch (ADR-166).            |

### `GET /sessions/:id/stream`

Server-Sent Events. One event per child stdout line plus the terminal
event. Newer clients can set `Last-Event-ID:` to skip events they already
received — honored via a per-session in-memory ring buffer
(capped at 1000 entries); full log-file replay (for older terminal events
after the registry GC'd the entry) lands with the web tier's log-file tail bridge.

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

The stream closes automatically after the terminal event. Each `line` is
treated as opaque JSONL — the web tier parses it into
structured ACP `session/update` events.

### `GET /sessions`

Returns the current `SessionRecord[]` projection — sessionId, adapter, runId,
projectSlug, stepId, nodeAttemptId, sessionName, status
(`live | exited | crashed`), pid, startedAt, exitedAt, exitCode, signal,
monotonicId, acpSessionId. Used by
`lib/reconcile.ts` and admin views. **(Implemented — ADR-166)** The projection
carries `executionWorkspaceId`, `assignmentId`, `assignmentEpoch`, and
`createdByCommandId`; host-private paths (`logPath`, `worktreePath`,
`repoPath`, `confineRoot`, `contextMounts`) never leave the host.

### `POST /sessions/:id/checkpoint` _(Implemented)_

Real graceful-checkpoint endpoint. Body is `{}` strictly (Zod-validated
empty object; unknown keys → 409 PRECONDITION). For each open
pending-permission deferred owned by the session, the supervisor
calls `pendingPermissions.cancel(sessionId, requestId, "checkpoint")`
— the same wire-level outcome shape the operator-cancel path produces,
plus a supervisor-side `reason` marker that propagates onto the
`session.exited` event. The supervisor then `markIntentionalShutdown`s
the session with `reason="checkpoint"`, SIGTERMs the child, and waits
for graceful exit up to `MAISTER_KILL_GRACE_MS`. If the grace expires
the supervisor SIGKILLs and returns `503 EXECUTOR_UNAVAILABLE` — the
web sweeper treats this as retryable and re-attempts on the next tick.

Status codes:

- `200 { alreadyCheckpointed: boolean, sessionId, monotonicId }` —
  graceful exit completed (or idempotent ack if the session was
  already in `exited`/`crashed`).
- `404 { code: "PRECONDITION" }` — unknown sessionId.
- `409 { code: "PRECONDITION" }` — body contained unknown keys.
- `503 { code: "EXECUTOR_UNAVAILABLE" }` — SIGTERM grace expired,
  SIGKILL was issued; sweeper retries.

#### Checkpoint + Resume lifecycle

When a `NeedsInput` run's `keepalive_until` expires the web sweeper
calls this endpoint, which:

1. Cancels every pending permission with `reason="checkpoint"`. The
   agent observes `{outcome:"cancelled"}` at the ACP layer and records
   the cancellation in its own session JSONL store so a future
   `session/resume <acpSessionId>` can replay the request. See
   [`spikes/2026-05-29-m8-spike-findings.md`](spikes/2026-05-29-m8-spike-findings.md)
   for the verified-via-mock-adapter contract.
2. Marks the session intentional with reason `"checkpoint"`. Heartbeat
   reads this on the child exit and emits
   `session.exited { reason: "checkpoint" }` (optional field —
   see AsyncAPI spec).
3. SIGTERMs the child with `MAISTER_KILL_GRACE_MS` grace.
4. On 200 the web sweeper runs `markCheckpointed(runId)` →
   `NeedsInputIdle` and `releaseSlotOnIdle` → `promoteNextPending`.
5. **Web-runner obligation (checkpoint/resume Codex review fix #1).** The web
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
`POST /sessions` with `resumeSessionId: <acpSessionId>`. The supervisor
spawns a fresh adapter process and restores the prior conversation via the
ACP `session/resume` call on `<acpSessionId>` (restores context without
replaying history; both bundled adapters advertise
`sessionCapabilities.resume`; see `acp-client.ts:createAcpConnection`).
Resume is NOT a CLI flag — both adapters ignore `--resume` on argv. The
resumed session keeps the SAME
`acpSessionId` (never minted anew), and on the next prompt the agent
re-issues `session.permission_request` for the cancelled tool call. The
runner-agent's permission handler auto-delivers the stored intent
against the new requestId; the original `hitl_requests` row's
`respondedAt` is set with audit
`{originalRequestId, reissuedRequestId, deliveredViaResume: true}`.

Each respawn costs ~$0.28 of `cache_creation_input_tokens` per the ACP
spike findings — keep-alive is the cost lever, not just UX. Resumed sessions'
canonical `usage.recorded` events carry resume attribution for ops.

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

### `POST /model-catalog/resolve` _(Implemented — ADR-076)_

Model-discovery resolver. The body is a runner **draft**
(`{ adapter, provider, force? }`). The supervisor fans the
draft out across the registered `ModelSource`s whose `supports(draft)` is true —
the ACP active probe (primary), the provider listing API, the curated GLM list
(`anthropic_compatible`) — then **merges + dedupes by model `id`** and
caches the result in memory keyed by `(adapter, provider.kind, base_url, sorted
env-ref NAMES)`. The TTL and the probe timeout (~15 s) are code
constants, not env vars. `force: true` bypasses the cache and repopulates it.

Response: `{ models, sources, resolvedAt, ttlSeconds }`, where `models[]` carries
each id's accumulated `origins` and `sources[]` carries a per-source `status`
(`ok | skipped | error`). **Secret handling:** env-ref fields inside `provider`
are **bare** names; the supervisor resolves their values from `process.env` and
never returns or logs a secret. The plain `anthropic` / `openai` kinds carry no
env-ref field — the provider source reads the conventional host keys
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, see
[configuration.md](configuration.md)) and reports `status: "skipped"` when unset.

Status mapping (consistent with _a per-source failure never fails the resolve_):

- `200` — resolved. A single source's failure (missing env-ref, unreachable
  provider, probe reject/timeout, malformed decode) is reported in that
  source's `status`, not raised. The codex probe without non-interactive auth
  reports `status: "skipped"`.
- `409 { code: "PRECONDITION" }` — malformed draft (unknown adapter, an
  `env:`-prefixed or raw-secret value in an env-ref field, a malformed provider
  union).

The probe spawns the already-trusted adapter binary in an isolated tmp cwd,
handshakes promptless (`initialize` → `session/new`, **zero tokens**), reads
`NewSessionResponse.models`, and **tears the child down on every exit path**
(success, reject, parse error, timeout — `SIGTERM`, then `SIGKILL` after a
bounded grace if it has not exited). A **passive harvest** of the same `models`
from real `session/new` / `session/resume` responses merges into the same cache
entry for free (union by model id — it never replaces a resolved catalog and
never extends its TTL window). The web tier proxies this route through the admin-gated
`POST /api/admin/acp-runners/model-suggestions`. Full contract:
[`api/supervisor.openapi.yaml`](api/supervisor.openapi.yaml);
domain: [`system-analytics/model-catalog.md`](system-analytics/model-catalog.md).

### Durable event outbox (Implemented — ADR-167)

The supervisor writes externally observable events to its private SQLite
outbox before live publication. `GET /runtime-events` replays host-global
events after an exclusive decimal cursor and `POST /runtime-events/ack`
advances a stream-bound contiguous watermark. The in-memory per-session SSE
ring remains a local diagnostic surface only; it is neither browser replay nor
run-state authority. The supervisor no longer writes `run.events.jsonl`.

### Execution-host state store _(Implemented — ADR-166)_

The supervisor keeps a private `node:sqlite` database at
`<MAISTER_EXECUTION_HOST_STATE_DIR>/state.sqlite` (default
`<MAISTER_RUNTIME_ROOT>/.maister/execution-host/`; WAL,
`synchronous=FULL`) with durable tables including `host_identity` (the minted or
pinned `hostKey`), `run_fences` (`run_id, assignment_id, epoch`), `workspaces`
(adopted handles: `id, run_id, project_slug, kind, path, real_path, repo_path?,
run_dir, context_mounts?, adopted_at, released_at?`, one ACTIVE row per
`(run_id, real_path)` through the partial unique index `workspaces_active_uq`),
`command_receipts`, the durable host-global `runtime_event_streams` /
`runtime_event_outbox`, and a private `runtime_objects` registry. Runtime
object bytes live beside this store under `runtime-objects/`; only opaque IDs
and checksummed metadata cross its API. The file carries a `PRAGMA user_version` (currently 6)
that gates in-place migrations at open: a version-0 store (inline
`UNIQUE (run_id, real_path)`, which blocked re-adoption after a release) is
rebuilt under the partial index with every row kept; a fresh store starts at
the current version. It is opened in `main.ts` BEFORE routes register — there
is no in-memory fallback. Two fatal boot errors:
`execution-host-key-conflict` (a `MAISTER_EXECUTION_HOST_KEY` pin that
differs from the stored key — remediation: unset the pin, or deliberately
wipe the state dir) and `execution-host-state-unwritable`. The web tier
never reads this directory. What survives a restart: the key, fences,
receipts, event replay/ACK watermark, object metadata, and handles. What does not: live sessions (unchanged). If the directory
is lost, the host mints a new key (unless pinned) — the web registrar then
retires the idle old row or refuses registration while the old row still owns
non-terminal runs; fences restart at the first command; handles are
re-adopted lazily. Cross-host ACP resume is out of scope.

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
│   ├── cost.ts                    # lenient JSON-parse → usage.recorded event
│   ├── registry.ts                # in-memory Map + per-session event ring buffer
│   ├── host-state.ts              # (Implemented — ADR-166) node:sqlite state store: identity, fences, handles, receipts
│   ├── execution-fence.ts         # (Implemented — ADR-166) envelope fence rules + lower-epoch eviction
│   ├── command-receipts.ts        # (Implemented — ADR-166) receipt lookup / replay / in-flight join
│   ├── workspace-registry.ts      # (Implemented — ADR-166) POST /workspaces/adopt validation + handle resolution
│   ├── workspace-roots.ts         # (Implemented — ADR-166) MAISTER_WORKSPACE_ROOTS parsing
│   └── types.ts                   # Zod schemas + SessionEvent union + SupervisorError
└── test/
    └── fixtures/
        └── fake-acp.mjs           # stand-in for the real adapter binary in tests
```

## Errors

`SupervisorError` is internal to the supervisor (it does not extend
`MaisterError`, which is server-only inside web). It is translated to
JSON at the HTTP boundary.

| Code                   | HTTP                             | When                                                                                                                                                                                                                                                              |
| ---------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRECONDITION`         | 409 (or 404 for unknown session) | Validation failure, duplicate sessionId.                                                                                                                                                                                                                          |
| `SPAWN`                | 500                              | `child_process.spawn` failed (ENOENT, EACCES…).                                                                                                                                                                                                                   |
| `EXECUTOR_UNAVAILABLE` | 503                              | Adapter, required environment reference, or provider launch configuration is unavailable. Also reserved for future resource-cap rejections. Implemented.                                                                                                          |
| `ACP_PROTOCOL`         | 500                              | Wire-level failure while opening a session, sending a prompt, or delivering permission input.                                                                                                                                                                     |
| `CHECKPOINT`           | 500                              | Checkpoint or resume contract failure.                                                                                                                                                                                                                            |
| `CRASH`                | 500                              | Reserved for heartbeat-promoted crash conditions.                                                                                                                                                                                                                 |
| `FENCED`               | 409                              | **(Implemented — ADR-166)** `fence.assignmentEpoch` is below the host's persisted high-water for the run, or a session evicted by a higher epoch answered its pending prompt. Web maps it to `CONFLICT {details.reason: "assignment_fenced"}`; the driver yields. |

`SupervisorErrorBody` **(Implemented — ADR-166)** carries an optional typed
`details` object (`reason`, `rule`, `field`, `mount`, `runId`, `commandEpoch`,
`hostEpoch`);
the reason tokens are listed in
[Error Taxonomy §Execution-host contract](error-taxonomy.md#execution-host-contract-implemented--adr-166).

The web client `web/lib/supervisor-client.ts` (the local-direct transport
behind `web/lib/execution-host/`) parses `{ code, message, details }`
from the body and re-throws as `MaisterError({ code, details })`. The
taxonomy of `MaisterError` lives in [Error Taxonomy](error-taxonomy.md).

## Cost accounting (canonical `usage.recorded`)

`cost.ts` observes the same stdout-line stream the SSE bridge uses,
JSON-parses each line **leniently** (silently skips non-JSON), and looks
for a `usage` object anywhere in the structure (top-level or nested,
bounded depth 8). When found, it publishes a redacted `usage.recorded` fact
to the durable host outbox:

```jsonc
{
  "ts": "2026-05-26T12:34:56.789Z",
  "sessionId": "uuid",
  "model": "claude-sonnet-4-6", // optional, scraped from same object tree
  "input_tokens": 100,
  "output_tokens": 200,
  "cache_creation_input_tokens": 5000,
  "cache_read_input_tokens": 0,
}
```

`usage.recorded` in the durable host outbox is the manager projection source
for UI and cost totals. The supervisor does not write a cost JSONL file.

`cache_creation_input_tokens` is the load-bearing field for ops:
the ACP spike findings (summary in root `CLAUDE.md` §ACP Spike Findings) measured
~$0.28 of cache-creation tokens per cross-process respawn. The 30-min
keep-alive window is the lever that controls this.

Records with no token fields are dropped (no `service_tier`-only rows).
JSON parse failures are silently skipped — the supervisor never crashes
on malformed adapter output.

## Configuration

All knobs are environment variables. Defaults assume a single-host
docker compose; production overrides go in `.env`.

| Var                                | Default                                                                 | Purpose                                                                                                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAISTER_SUPERVISOR_PORT`          | `7777`                                                                  | Bind port on `0.0.0.0`.                                                                                                                                                                              |
| `MAISTER_SUPERVISOR_URL`           | `http://localhost:7777`                                                 | Read by `web/lib/supervisor-client.ts`.                                                                                                                                                              |
| `MAISTER_RUNTIME_ROOT`             | `process.cwd()`                                                         | Root under which `.maister/<slug>/runs/...` is written.                                                                                                                                              |
| `MAISTER_EXECUTION_HOST_STATE_DIR` | `<MAISTER_RUNTIME_ROOT>/.maister/execution-host/`                       | **(Implemented — ADR-166)** Supervisor-private `node:sqlite` state dir (identity, fences, handles, receipts). Unwritable → fatal boot error.                                                         |
| `MAISTER_EXECUTION_HOST_KEY`       | unset                                                                   | **(Implemented — ADR-166)** Optional identity pin (`^[A-Za-z0-9_-]{8,64}$`). Applied when no key is stored or equal to the stored key; a CONFLICTING pin refuses boot (exit 1).                      |
| `MAISTER_WORKSPACE_ROOTS`          | `~/.maister/worktrees:~/.maister/local:<MAISTER_RUNTIME_ROOT>/.maister` | **(Implemented — ADR-166)** Colon-separated absolute dirs a `git_worktree` / `directory` adoption must live under. MUST mirror a moved web `MAISTER_WORKTREES_ROOT` / `MAISTER_LOCAL_PACKAGES_ROOT`. |
| `MAISTER_HEARTBEAT_INTERVAL_MS`    | `5000`                                                                  | Orphan-child detection interval.                                                                                                                                                                     |
| `MAISTER_KILL_GRACE_MS`            | `5000`                                                                  | SIGTERM → SIGKILL grace per child on DELETE and graceful shutdown.                                                                                                                                   |
| `MAISTER_SHUTDOWN_GRACE_MS`        | `15000`                                                                 | Total wall-clock budget for graceful supervisor shutdown.                                                                                                                                            |
| `MAISTER_KEEPALIVE_MINUTES`        | `30`                                                                    | NeedsInput keep-alive window (minutes). Bounds the pending-permission deferred timeout AND the web-side sweeper-driven NeedsInput → NeedsInputIdle transition. Bumped by every web activity ping.    |
| `ANTHROPIC_BASE_URL`               | `https://api.anthropic.com`                                             | Process-wide default for Claude-compatible adapters. Platform runners should prefer typed provider config plus env refs.                                                                             |
| `ANTHROPIC_AUTH_TOKEN`             | unset                                                                   | Required when `ANTHROPIC_BASE_URL` points at a third-party (z.ai GLM, OpenRouter, …).                                                                                                                |
| `MAISTER_ADAPTER_BINARY_CLAUDE`    | unset                                                                   | Optional supervisor-side executable override for `claude`. When unset, PATH resolution uses `claude-agent-acp`.                                                                                      |
| `MAISTER_ADAPTER_BINARY_CODEX`     | unset                                                                   | Optional supervisor-side executable override for `codex`. When unset, PATH resolution uses `codex-acp`.                                                                                              |
| `MAISTER_ADAPTER_BINARY_GEMINI`    | unset                                                                   | Optional supervisor-side executable override for `gemini`. When unset, PATH resolution uses `gemini` plus the registry argv `--acp`.                                                                 |
| `MAISTER_ADAPTER_BINARY_OPENCODE`  | unset                                                                   | Optional supervisor-side executable override for `opencode`. When unset, PATH resolution uses `opencode` plus the registry argv `acp`.                                                               |
| `MAISTER_ADAPTER_BINARY_MIMO`      | unset                                                                   | Optional supervisor-side executable override for `mimo`. When unset, PATH resolution uses `mimo` plus the registry argv `acp`.                                                                       |
| `LOG_LEVEL`                        | `debug`                                                                 | pino level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent`.                                                                                                                         |

Secrets MUST NEVER appear in:

- SSE events visible to the browser
- canonical event payloads (verified in the integration test with a sentinel token)
- the step `.log` file (sentinel-test enforced)
- the supervisor's own logs (env values are summarized as `hasEnv: true|false`, never echoed)

**Env merge semantics for the spawned child:** platform runner launch uses typed
runner env overrides. Raw values pass through literally; `env:NAME` values are
resolved by the supervisor. During migration, the legacy `executor.env` path
still exists.

The implemented path in `supervisor/src/spawn.ts` builds the child's env as
`{ ...process.env, ...executor.env, ...requestDerivedEnv,
...adapterLaunch.env }`. Before spawn, `provisionRunnerLaunch()` resolves typed
provider settings and `env:NAME` runner references into `executor.env`.

1. `process.env` — the supervisor's own env at startup (base).
2. `executor.env` — typed provider and runner env values resolved by the
   supervisor; this layer wins over ambient process values.
3. request-derived env — `MAISTER_CAPABILITY_PROFILE_PATH` when present and
   `MAISTER_CONTEXT_REPOS` derived from the first-class `contextMounts[]`
   request field. **(Implemented — ADR-157)** Neither field is overloaded onto
   runner configuration.
4. `adapterLaunch.env` — run-scoped capability materializer output.
   It wins on collision so a run-scoped MCP/settings profile can point the
   adapter at the materialized files for that one session.

This means:

- `executor.env.ANTHROPIC_AUTH_TOKEN` wins over the supervisor's own
  `ANTHROPIC_AUTH_TOKEN`, which is what you want when pinning one particular
  executor through z.ai GLM, OpenRouter, etc. Designed
  `adapterLaunch.env` wins only for materializer-produced session-scoped
  values.
- Any provider env already present in the supervisor process is inherited by
  spawned adapter children unless overridden. The default platform-runner model
  treats ACP tools as configured in their own CLIs; MAIster only resolves env
  refs when an operator explicitly configures a compatible-provider, gateway,
  or gateway override. If you want to **deny** a supervisor process env value
  from reaching an executor, unset it in the supervisor's process env at
  startup; do not rely on `executor.env` to "shadow" values it doesn't list.
  Phase 2 may add an explicit allow-list mode.

## Running locally

```bash
# From repo root — the workspace is monorepo-wide.
pnpm install --frozen-lockfile

# Standalone (handy for tests / smoke):
pnpm --filter @maister/supervisor dev          # tsx watch src/main.ts
pnpm --filter @maister/supervisor start        # tsx src/main.ts (no watch)

# Database dependency (compose is Postgres-only in the local host-run path):
docker compose up -d postgres

# Hardened Postgres compose; use the deployment guide for systemd/nginx
# process wiring.
docker compose -f compose.yml -f compose.production.yml up -d postgres
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

## ACP Wire Lifecycle

The supervisor speaks JSON-RPC via
`@agentclientprotocol/sdk@0.22.1`'s `ClientSideConnection` for every
session. `POST /sessions` creates the adapter process and ACP session;
`POST /sessions/:id/prompts` admits user or flow prompts; structured ACP
notifications are bridged over SSE; permission requests are held open
until the web tier calls `POST /sessions/:id/input`.

`POST /sessions` does not accept a `prompt` field. The envelope payload is:

```json
{
  "executionWorkspaceId": "ws_5f3a8a2b7e344f6d9d2c1d4e5f6a7b8c",
  "stepId": "plan",
  "runner": {
    "version": 1,
    "runnerId": "claude-code-default",
    "adapter": "claude",
    "capabilityAgent": "claude",
    "model": "claude-sonnet-4-6",
    "env": { "ANTHROPIC_MODEL": "env:CLAUDE_CODE_MODEL" },
    "provider": { "kind": "anthropic" },
    "permissionPolicy": "default"
  },
  "executor": { "agent": "claude", "model": "claude-sonnet-4-6" },
  "resumeSessionId": "uuid-abc" // optional
}
```

During migration `executor` remains required for backward compatibility. When
`runner` is present, the supervisor uses the versioned runner intent as the
launch source of truth and derives the effective executor/env/argv from it.
`runner.env` values keep their stored form; the supervisor resolves only values
with the `env:` prefix and passes all other values literally.

The response includes the negotiated ACP session id:

```json
{ "sessionId": "...", "pid": 1234, "acpSessionId": "..." }
```

**Prompt admission endpoint:** `POST /sessions/:id/prompts`

```json
{ "stepId": "plan", "prompt": "..." }
```

Body validated by `SendPromptRequestSchema` (`stepId` must match
`^[A-Za-z0-9._-]+$`, `prompt ≤ 1 MB`). **(Designed — capability composer, FR-D5)**
the body MAY also carry an optional `contentBlocks` array (ACP `text` +
`resource_link`/`resource` blocks). A `runtime_object` block instead carries an
opaque object ID: the supervisor verifies its run and assignment epoch, resolves
the host-private file internally, and forwards only the resulting confined ACP
resource link. The manager never receives that path. Other ACP blocks are
forwarded unchanged after session-bound URI confinement. `prompt` stays the
plain-text equivalent. Response:

```json
{ "stopReason": "end_turn", "meta": null }
```

`stopReason` ∈ `end_turn | max_tokens | max_turn_requests | refusal`.
`cancelled` is not a successful supervisor prompt response. If an adapter
returns ACP prompt `stopReason: "cancelled"` for a direct prompt, the supervisor
maps it to `500 ACP_PROTOCOL`. User-initiated stop uses `DELETE /sessions/:id`;
checkpoint uses `POST /sessions/:id/checkpoint`; permission-deferred cancel uses
`POST /sessions/:id/input` with `action: "cancel"` and resolves only that
permission deferred.

**Permission input endpoint:** `POST /sessions/:id/input`
accepts `{ "action": "select", "requestId": "...", "optionId": "..." }`
or `{ "action": "cancel", "requestId": "..." }`. It is permission-only;
structured human/form HITL remains a web-side artifact workflow.

**Structured SSE event types** (in addition to `session.line`,
`session.exited`, `session.crashed`):

- `session.update` — carries the structured `acp.SessionNotification.update`
  payload (`agent_message_chunk`, `tool_call`, `plan`, etc.). The web tier
  decomposes these into run or scratch dialog artifacts.
- `session.permission_request` — emitted when the adapter asks for tool
  permission. The supervisor blocks the ACP request until web sends
  permission input or the keep-alive timeout expires.

The legacy `session.line` event type stays — `cost.ts` and any other
raw-line consumer keep working unchanged. The supervisor tees stdout
through a `PassThrough` so both consumers see every chunk.

## Stage B durable data plane (Implemented — ADR-167)

`GET /capabilities` is additive and keeps `/health` protocol v1 unchanged.
It advertises `eventStream`, `asyncPrompt`, and `runtimeObjects`; admission
requires the complete canonical set. `GET /runtime-events` replays host-global SQLite outbox events strictly after
the decimal `Last-Event-ID`, and `POST /runtime-events/ack` confirms an
absolute contiguous stream watermark. A socket is never lifecycle authority:
the host writes its outbox before publishing and the manager ACKs only after a
Postgres transaction commits.

`POST /sessions/{id}/prompts` is the durable asynchronous prompt-admission
route: its `202` confirms only the receipt and accepted event. The authoritative
terminal outcome is the canonical event stream plus `GET /commands/{id}`. The
singular long-lived prompt route was removed in B4.

Runtime objects use opaque `ro_<id>` values through reserve/upload/metadata/
single-range/read/delete contracts. Metadata may become canonical in Postgres;
host-local content never crosses the boundary as a filesystem path. A future
remote adapter preserves this contract but remote enrollment and a relay remain
out of scope. See [`api/supervisor.openapi.yaml`](api/supervisor.openapi.yaml),
[`api/async/execution-host-events.asyncapi.yaml`](api/async/execution-host-events.asyncapi.yaml),
and the ADR-167 analytics documents.

## Limitations on POC

- **Single host, unauthenticated loopback.** Exactly one non-retired local
  execution host; the web tier no longer mounts or reads host runtime data.
  Worktree/diff/promotion are still web-side Git and remain Stage C. The HTTP wire carries no host
  auth (`0.0.0.0:7777` — keep it loopback-only); remote transport, relay,
  enrollment, multiple simultaneous hosts, placement, and cross-host ACP
  resume are later stages.
- **Per-session diagnostic SSE replay is bounded** (1000 entries). Canonical
  browser/run replay instead comes from retained manager Postgres events.
- **No Cursor / Aider executors** — the supervisor supports the code-owned ACP
  adapter families `claude`, `codex`, `gemini`, `opencode`, and `mimo`.
  Gemini, OpenCode, and MiMo remain gated by binary diagnostics and
  smoke-proven readiness before they can be treated as production launch
  targets.
- **No plugin sandboxing or trust UI** — POC trusts internal Flow
  sources; sandboxing is Phase 2.

## See Also

- [Configuration](configuration.md) — `maister.yaml` v2 + env vars
- [Error Taxonomy](error-taxonomy.md) — `MaisterError` codes the web tier raises after translation
- ACP Pivot Revision (2026-05-25, historical doc removed) — the multi-runner design that motivated the supervisor split
- ACP Spike Findings — adapter package versions and cross-process resume cost; summary in root `CLAUDE.md` §ACP Spike Findings
- [Architecture](../.ai-factory/ARCHITECTURE.md) — dependency rules; the supervisor↔web wire contract
