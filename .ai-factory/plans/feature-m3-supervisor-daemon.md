# M3 — Supervisor daemon (`supervisor/`)

> **Historical plan:** CCR/router-specific tasks and contracts below are
> obsolete and superseded by [ADR-164](../../docs/decisions/adr-164.md). Do not
> implement them; use current code and canonical docs.

- **Branch:** `feature/m3-supervisor-daemon`
- **Created:** 2026-05-26
- **Base branch:** `main` (at commit `6a7b632`)
- **Plan kind:** full mode

## Settings

| Setting | Value |
|---|---|
| Testing | Yes — unit + integration (vitest) |
| Logging | Verbose — pino at `LOG_LEVEL=debug` in supervisor; `console.debug` in `web/lib/supervisor-client.ts` (server-only) |
| Docs | Yes — mandatory `/aif-docs` checkpoint at completion |
| Roadmap linkage | Linked — see below |

## Roadmap Linkage

- **Milestone:** `M3. Supervisor daemon (supervisor/)` in `.ai-factory/ROADMAP.md`
- **Rationale:** This branch implements exactly the M3 scope: separate Node daemon, HTTP+SSE API (`POST /sessions`, `DELETE /sessions/:id`, `GET /sessions/:id/stream` and the three companion routes documented in the design doc), process-per-session spawn (claude + codex via the `@agentclientprotocol/*` adapter binaries), heartbeat-driven crash detection, and `cost.jsonl` token accounting. ACP-level structured event parsing is intentionally deferred to M7; keep-alive + graceful checkpoint + `--resume` is deferred to M8.

## Goal

Stand up `supervisor/` as a second long-running Node process that owns the lifecycle of agent processes (`claude-agent-acp`, `codex-acp`), exposes the contract documented in `ARCHITECTURE.md` over HTTP+SSE, and persists per-run cost metrics. The web tier reaches it through one boundary module — `web/lib/supervisor-client.ts`. After M3, the contract is verifiable end-to-end with a stub binary; M7 will wire the real ACP event grammar on top, M8 will wire keep-alive and checkpoint+resume.

## Non-goals (out of M3, do not slip in)

- **Structured ACP event parsing.** M3 treats stdout lines as opaque JSONL; `cost.ts` parses only the `usage` field shape. Decomposing `session/update` into the typed event union is M7.
- **HITL input delivery.** `POST /sessions/:id/input` returns 501. Implementation is M7 (binary `session/request_permission`) + M10 (structured form).
- **Keep-alive + checkpoint + resume.** `POST /sessions/:id/checkpoint` returns 202 no-op. The 30-min keep-alive window, graceful pause, and `--resume <session-id>` respawn are M8.
- **Run-state reconciliation in the web tier.** `lib/reconcile.ts` consumes `GET /sessions` later; M3 just ships the route.
- **Per-step executor override resolution UI.** M3 accepts whatever executor the caller passes.
- **Custom ACP extensions.** Zed-standard only. Stage 1 / Phase 2 is out.
- **Plugin sandboxing.** POC trusts everything.

## Architecture summary

```
                     ┌────────────────────┐
  Next.js (web/)     │  web/lib/          │   HTTP + SSE          ┌────────────────────────┐
   - app/api/runs    │  supervisor-client │ ────────────────────► │  supervisor/ (Fastify)  │
   - lib/reconcile   │  (server-only)     │ ◄──────────── SSE ─── │   POST /sessions        │
                     └────────────────────┘                       │   DELETE /sessions/:id  │
                                                                  │   GET /sessions/:id/stream
                                                                  │   GET /sessions         │
                                                                  │   POST .../input  (501) │
                                                                  │   POST .../checkpoint   │
                                                                  └──────────┬─────────────┘
                                                                             │ child_process.spawn
                                                                             ▼
                                                          ┌──────────────────────────────┐
                                                          │ claude-agent-acp  /  codex-acp│
                                                          │  cwd = worktreePath          │
                                                          │  stdio: pipe/pipe/inherit    │
                                                          └──────────────────────────────┘
                                                                             │ stdout (JSONL lines)
                                                                             ▼
                                       .maister/<slug>/runs/<runId>/<stepId>.log   (append-only)
                                       .maister/<slug>/runs/<runId>/cost.jsonl     (append-only)
```

Module layout inside `supervisor/src/`:

```
main.ts          # Fastify boot + graceful shutdown
http-api.ts      # routes (POST/DELETE /sessions, SSE stream, GET /sessions, checkpoint/input stubs)
spawn.ts         # child_process dispatcher (claude-agent-acp / codex-acp), line-buffered stdout
heartbeat.ts     # exit + error + periodic-orphan-check → emit session.exited / session.crashed
cost.ts         # parse `usage` from lines → append cost.jsonl
registry.ts      # in-memory SessionRecord map + per-session EventEmitter
types.ts         # DTOs + Zod schemas (StartSessionRequest, SessionRecord, SupervisorErrorBody)
```

## Pinned dependencies (from M0 spike)

| Package | Version | License |
|---|---|---|
| `@agentclientprotocol/sdk` | `0.22.1` | Apache-2.0 |
| `@agentclientprotocol/claude-agent-acp` | `0.37.0` | Apache-2.0 |
| `@agentclientprotocol/codex-acp` | `0.0.44` | Apache-2.0 |
| `fastify` | `^5` | MIT |
| `@fastify/sse-v2` | `^4` | MIT |
| `pino` / `pino-pretty` | `^9` / `^11` | MIT |
| `zod` | `^3` | MIT |

## Wire contract (canonical for M3)

`POST /sessions`

```jsonc
// Request
{
  "runId": "run_abc",
  "projectSlug": "maister",
  "worktreePath": "/repos/maister",
  "stepId": "plan",
  "prompt": "/aif-plan ...",
  "executor": {
    "agent": "claude" | "codex",
    "model": "claude-sonnet-4-6",
    "env": { "ANTHROPIC_BASE_URL": "...", "ANTHROPIC_AUTH_TOKEN": "..." },
    "router": "ccr"                     // optional
  },
  "resumeSessionId": "..."              // optional; reserved for M8
}
// Response 201
{ "sessionId": "uuid", "pid": 12345 }
// Error 4xx/5xx
{ "code": "PRECONDITION" | "SPAWN" | "EXECUTOR_UNAVAILABLE" | "ACP_PROTOCOL" | "CHECKPOINT", "message": "..." }
```

`GET /sessions/:id/stream` — SSE, one event per stdout line, `id:` is per-session monotonic integer, `data:` is `{ type, sessionId, line?, code?, signal? }`. Terminal events: `session.exited`, `session.crashed`. Reconnect respects `lastEventId` header by tailing the per-step log file.

`DELETE /sessions/:id` — SIGTERM → 5s grace → SIGKILL → 204.

`GET /sessions` — returns `SessionRecord[]` for reconcile.

`POST /sessions/:id/checkpoint` — 202 no-op stub (full impl in M8).

`POST /sessions/:id/input` — 501 stub (full impl in M7).

## Tasks

### Phase 0 — Workspace + scaffold (2 tasks)

- **[x] [T1] Promote `pnpm-workspace.yaml` to repo root.** Move the stub from `web/` up; declare `packages: [web, supervisor]`. Verify `pnpm install` from root.
- **[x] [T2] Scaffold `supervisor/` package.** `package.json` (pinned deps above), `tsconfig.json` (strict, ES2022, NodeNext), `vitest.config.ts` (unit/integration split), `eslint.config.mjs`, `.gitignore`. Blocked by T1. **Note:** `@fastify/sse-v2` removed — package doesn't exist on npm; falling back to native Fastify `reply.raw` SSE (plan risk §1 confirmed).

### Phase 1 — Domain primitives (2 tasks)

- **[x] [T3] DTOs + Zod schemas** in `supervisor/src/types.ts`. Blocked by T2.
- **[x] [T4] `SessionRegistry`** in `supervisor/src/registry.ts` — Map + per-session emitter, CRUD, `forEach` for shutdown. Blocked by T2.

### Phase 2 — Process spawn + cost (3 tasks)

- **[x] [T5] `spawn.ts`** — dispatch on `executor.agent`, `cwd: worktreePath`, stdio `pipe/pipe/inherit`, line-buffered stdout, parallel `createWriteStream` to `.maister/<slug>/runs/<runId>/<stepId>.log`, monotonic id, `--resume` arg only if present, redact env in logs. Blocked by T3, T4.
- **[x] [T6] `heartbeat.ts`** — `exit` / `error` handlers translate to `session.exited` / `session.crashed`; periodic `process.kill(pid, 0)` orphan check (interval `MAISTER_HEARTBEAT_INTERVAL_MS`). Blocked by T5.
- **[x] [T7] `cost.ts`** — observe stdout lines, lenient JSON-parse, extract `usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), append to `cost.jsonl`. Blocked by T5.

### Phase 3 — HTTP+SSE API (2 tasks)

- **[x] [T8] `http-api.ts`** — six routes (full list in wire-contract section). M3 SSE: live subscribe via emitter; lastEventId replay deferred to M7+M9 where the web tier tails the log file. Error bodies match `SupervisorErrorBody`. Blocked by T6, T7.
- **[x] [T9] `main.ts`** — Fastify boot on `MAISTER_SUPERVISOR_PORT` (`0.0.0.0`), pino logger, graceful SIGTERM/SIGINT shutdown bounded by `MAISTER_SHUTDOWN_GRACE_MS`. Smoke-tested: 4xx/501/200 paths work; SIGTERM triggers handler. Blocked by T8.

### Phase 4 — web/ boundary (1 task)

- **[x] [T10] `web/lib/supervisor-client.ts`** — `import 'server-only'`, fetch wrappers, `MaisterError` translation, SSE async generator. Default `MAISTER_SUPERVISOR_URL=http://localhost:7777`. Blocked by T8.

### Phase 5 — Tests (3 tasks)

- **[x] [T11] Supervisor unit tests** — `registry.test.ts` (8), `spawn.test.ts` (4, with fake-acp.mjs fixture via `binaryOverride: "node"`), `cost.test.ts` (7 incl. secret-redact assertion), `types.test.ts` (11). 30 tests, all green. Blocked by T7.
- **[x] [T12] Supervisor integration test** — `lifecycle.integration.test.ts`: boots Fastify on ephemeral port + stub binary; 9 scenarios incl. spawn/SSE/crash/secret-redact. Drove a registry per-session ring buffer + snapshot-after-subscribe SSE pattern to fix early-event race. Blocked by T9, T11.
- **[x] [T13] Supervisor-client unit tests** — 14 tests via `vi.spyOn(globalThis, "fetch")`: happy path, PRECONDITION/EXECUTOR_UNAVAILABLE/SPAWN/CHECKPOINT translation, unknown-code → ACP_PROTOCOL fallback, network failure → EXECUTOR_UNAVAILABLE, SSE generator with Last-Event-ID header. Blocked by T10.

### Phase 6 — Ops + CI + Docs (4 tasks)

- **[x] [T14] `.env.example`** — added supervisor section: URL, PORT, runtime root, heartbeat, kill/shutdown grace, keepalive (placeholder for M8), ANTHROPIC_BASE_URL/AUTH_TOKEN, LOG_LEVEL.
- **[x] [T15] Compose + Dockerfile** — single image `target: production` runs either web or supervisor via `command:` override. compose.yml: `supervisor` service with healthcheck on `GET /sessions`. compose.override.yml: hot-reload mount + port 7777. compose.production.yml: read-only + cap-drop hardening. **Dockerfile rewritten** for root pnpm workspace (was broken after T1). Both compose configs lint clean. Blocked by T9.
- **[x] [T16] CI** — supervisor lint + typecheck + unit + **integration** added to base CI (every push). Web's testcontainers-backed integration stays behind the `integration` label. Cache path moved to root `pnpm-lock.yaml`. Blocked by T12, T13.
- **[x] [T17] Docs** — wrote `docs/supervisor.md` (HTTP API, module layout, errors, cost.jsonl, env vars, run-locally, testing, POC limitations); updated README Quick Start to monorepo+supervisor + Documentation table row; refreshed `docs/getting-started.md` (root install, two-tier dev, separated web/supervisor scripts); added supervisor env vars + cross-link in `docs/configuration.md`. Blocked by T8, T14.

### Phase 7 — Verification (1 task)

- **[x] [T18] Verify + mark M3 done in `ROADMAP.md`.** Full sweep: web lint/typecheck/unit + supervisor lint/typecheck/unit+integration — 105 tests green. ROADMAP M3 entry expanded with the shipped surface and added to Completed table. Blocked by T15, T16, T17.

## Commit plan

8 commits, grouped by phase boundary:

| # | After tasks | Suggested message |
|---|---|---|
| 1 | T1–T2 | `chore(monorepo): promote pnpm workspace; scaffold supervisor/ package` |
| 2 | T3–T4 | `feat(supervisor): wire-format DTOs and in-memory session registry` |
| 3 | T5–T7 | `feat(supervisor): spawn dispatcher, heartbeat, cost.jsonl` |
| 4 | T8–T9 | `feat(supervisor): HTTP+SSE routes and graceful shutdown` |
| 5 | T10 | `feat(web): supervisor-client HTTP+SSE boundary` |
| 6 | T11–T13 | `test(supervisor,web): unit + integration coverage` |
| 7 | T14–T17 | `chore(ops,docs): supervisor compose service, CI, env, docs` |
| 8 | T18 | `docs(roadmap): mark M3 done` |

## Verification gates

- `pnpm install --frozen-lockfile` from root succeeds (T1).
- `pnpm --filter @maister/supervisor typecheck && lint && test:unit && test:integration` all green (T11, T12, T16).
- `pnpm --filter web typecheck && lint && test:unit` still green; `supervisor-client.test.ts` included (T13).
- `docker compose up -d supervisor` → healthy; `curl http://localhost:7777/sessions` → `[]` (T15).
- `/aif-verify --strict` clean on M3 milestone (T18).
- Secret audit: assert no `ANTHROPIC_AUTH_TOKEN` substring in any log file under `.maister/` or in supervisor pino output (T12).

## Risks / open knowns

1. **`@fastify/sse-v2` v4 fits Fastify 5?** Both are current as of M0 spike date but pinning is on faith — verify in T2; if incompatible, fall back to native `reply.raw.write('event:…\ndata:…\n\n')` (no real cost).
2. **`undici.MockAgent` interaction with native `fetch` in Node 24** — used in T13. If it doesn't intercept cleanly, swap to `msw/node` (already common in Next.js stacks; would need to add as devDep).
3. **`tx` watch mode HMR on supervisor** — `tsx watch` should work; if it eats SIGINT cleanup, swap to plain `tsx` + nodemon. Discoverable at T2/T9.
4. **Stale rules file** — `.ai-factory/rules/backend.md` still describes the pre-ACP single-block, single-executor world. T17 docs work will surface this; fix is `/aif-rules` territory, NOT this branch.

## Open questions (короткие, RU)

1. **Fastify или Express?** Я выбрал Fastify (pino встроенный + лучше SSE через @fastify/sse-v2). OK?
2. **Один Docker-образ для web и supervisor (`command:` override) или второй stage в Dockerfile?** План: один образ, override command — экономит CI time. OK?
3. **`MAISTER_SUPERVISOR_PORT` vs `MAISTER_SUPERVISOR_URL` — оба нужны?** Сейчас оба в .env.example: PORT для самого supervisor, URL для web. Не избыточно?
4. **`lifecycle.integration.test.ts` запускать в обычном CI или только под лейблом `integration`?** Спавнит реальный child_process на stub-бинарь — должен работать на ubuntu-latest. Предложение: в обычный CI.
5. **Endpoint `GET /health` отдельно или сойдёт `GET /sessions` для healthcheck?** Сейчас план — `GET /sessions`. OK или добавить `/health`?
6. **`rules/backend.md` устарел (single-executor, pre-ACP) — править сейчас или дождаться отдельного `/aif-rules`?** Я бы не трогал в этой ветке.
7. **`cost.jsonl` rotation** — не предусмотрел. Для POC файл будет расти; нужен ли лимит/ротация сейчас, или Phase 2?
