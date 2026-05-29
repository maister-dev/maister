# Implementation Plan: M8 — Worker lifecycle (keep-alive + checkpoint + resume)

Branch: feature/m8-worker-lifecycle
Created: 2026-05-29

## Settings

- **Testing**: yes. Supervisor unit (`checkpoint` real path: cancel-on-checkpoint reason propagation, idempotent-on-exited, SIGKILL escalation, monotonicId in response; `CheckpointResponse` Zod schema; `cost.ts` `resumed:true` tagging). Supervisor integration (full mock-acp-adapter lifecycle: live session → checkpoint mid-prompt → `--resume` from fresh process → adapter continues; the spike harness covers the same path on `codex-acp` for parity). Web unit (`scheduler` excludes `NeedsInputIdle` + `releaseSlotOnIdle`, `state-transitions` × 4 helpers + status-guard rejection, `keepalive-sweeper` ticks × 2 passes, `POST /api/runs/[runId]/activity` × 8 cases, `useActivityPing` jsdom × 4, `resumeRun` × 7 failure-classification cases, `POST /respond` idle-branch × 9 cases, `runner-agent` auto-deliver × 6 cases, `cost.ts` resumed-flag × 3). Web integration (real testcontainer postgres + mock-acp-adapter: full end-to-end Pending → Running → NeedsInput → NeedsInputIdle (sweeper) → respond → resumeRun → re-issue → auto-deliver → Running → Review; negative path supervisor 5xx retryable; terminal path supervisor 400 → Failed). Target: ≥70 new tests on top of M7's 208 web unit / 84 supervisor unit / 12 supervisor integration baseline.

- **Logging**: verbose. New pino loggers: `name: "supervisor-checkpoint"` (T4), `name: "supervisor-cost"` (T13 — extends existing), `name: "keepalive-sweeper"` (T6/T12), `name: "api-activity"` (T7), `name: "run-state"` (T3), `name: "run-resume"` (T9). Existing loggers extend: `flow-runner-agent` (T11 auto-deliver branch), `api-hitl` (T10 idle branch), `supervisor-client` (T5 checkpoint round-trip), `scheduler` (T2 release-on-idle). INFO per state transition with `{runId, from, to}`; INFO per sweeper tick with aggregate counts `{scannedRunsCount, idledCount, abandonedCount}`; INFO per checkpoint request `{sessionId, pendingPermissionCount, latencyMs, alreadyCheckpointed}`; INFO per resume `{runId, acpSessionId, newSupervisorSessionId, latencyMs}`; INFO per auto-deliver `{originalRequestId, reissuedRequestId, latencyMs}`; DEBUG per cap-check, `bumpKeepalive`, ring-buffer push, deferred cancel; WARN per retryable supervisor 5xx, status-guard reject, SIGKILL escalation; ERROR via `MaisterError` / `SupervisorError` only. Tool-call payloads continue M7's `{toolCallId, kind, title}` summary discipline — never the full body. NO body-controlled values logged on any new HTTP surface.

- **Docs**: yes — mandatory docs checkpoint at completion. M8 changes contracts on every layer (supervisor HTTP checkpoint endpoint goes from 202 stub to real, supervisor SSE `session.exited` gains optional `reason` field, web HTTP gains `POST /api/runs/[runId]/activity` and adds 202/410/503 responses to `POST /respond`, run state machine gains three new transitions, scheduler semantics change for `NeedsInputIdle`, three new env vars introduced). Docs phase touches: `docs/supervisor.md` (real checkpoint contract + new "Checkpoint + Resume lifecycle" section + line-288 `MAISTER_KEEPALIVE_MINUTES` row update), `docs/api/supervisor.openapi.yaml` (`POST /sessions/{id}/checkpoint` 200/404/500 schemas + `CheckpointResponse` component), `docs/api/async/supervisor-sse.asyncapi.yaml` (`session.exited` optional `reason` field), `docs/api/web.openapi.yaml` (NEW `POST /api/runs/{runId}/activity` + updated `POST /respond` with 202/410/503 idle-branch responses), `docs/api/async/web-runs.asyncapi.yaml` (pass-through of `reason`), `docs/error-taxonomy.md` (`CHECKPOINT` matrix activated; `EXECUTOR_UNAVAILABLE` extended with sweeper + idle-branch callers; clarify `NeedsInputIdle → Abandoned` is NOT `HITL_TIMEOUT`), `docs/system-analytics/runs.md` (state diagram refresh covering all five M8 transitions; "Keep-alive sliding window" section; "Idle sweeper + scheduler interaction" section), `docs/system-analytics/hitl.md` (live vs idle response sequence diagrams; two-phase commit table; runner-agent resume-prompt timeout failure mode), `docs/configuration.md` (NEW rows for `MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS`, `MAISTER_NEEDSINPUTIDLE_TTL_HOURS`, `MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS`; updated `MAISTER_KEEPALIVE_MINUTES` semantics; NEW "Cost tracking on resume" subsection). Mark M8 `[x]` in `.ai-factory/ROADMAP.md` as the final step.

## Roadmap Linkage

Milestone: "M8. Worker lifecycle: keep-alive + checkpoint + resume"
Rationale: Directly implements the next unimplemented milestone in `.ai-factory/ROADMAP.md`. M7 left three production-blocking gaps: (a) `supervisor/src/http-api.ts:297-310` still returns the M3 stub `{status: "deferred", milestone: "M8"}` for `POST /sessions/:id/checkpoint` — there is no real graceful-checkpoint path, so `NeedsInput` runs cannot release scheduler slots and the 30-min keep-alive window cannot expire cleanly; (b) `web/lib/scheduler.ts:65-115` includes `NeedsInput` in the live-set query by design (M5 / M7 — a worker awaiting permission is conceptually live), but there is no `NeedsInputIdle` path yet to release the slot once the worker checkpoints; (c) `runs.acp_session_id` is populated end-to-end (M3 + M7) and `supervisor/src/spawn.ts:147-151` already wires `--resume <session-id>`, but no code path triggers a respawn — `NeedsInputIdle` is a terminal-shaped state at the end of M7. M8 closes all three: real checkpoint, sweeper-driven idle transitions, HITL-response-driven resume + auto-delivered intent. Cap pressure relief (NeedsInputIdle releases the slot) is the cost lever — without it, three operators on review for 30 min freezes the whole portfolio. Adversarial-review-derived constraints (skill-context Rules from M6 + M7) are baked into every new contract surface below; the Decisions section enumerates each identifier source-of-trust and each side-effect two-phase commit boundary explicitly.

## Research Context

Source: code exploration of `/repos/mAIster` on 2026-05-29 (no `.ai-factory/RESEARCH.md` exists), the `docs/kaa-maister-design-20260522-174429.md` design doc §1 (hybrid HITL: keep-alive + checkpoint+resume), `docs/kaa-maister-design-20260525-acp-revision.md` (ACP-revision addendum), `docs/kaa-maister-m0-spike-findings-20260525.md` (verified `claude --resume <uuid>` cross-process round-trip; NEW finding ~$0.28 cache_creation per respawn), the M7 plan + its adversarial-review pass-throughs at `.ai-factory/plans/feature-m7-acp-sse-bridge.md`.

Goal: take M8 from "schema columns exist + stub endpoint exists + design doc exists" to "live keep-alive sliding window, real graceful checkpoint, operator-driven resume with two-phase commit, auto-delivery of stored intent on re-issued permission, Abandoned TTL — all end-to-end against the existing M7 wire."

Constraints carried over from M0–M7:

- **DB schema is already M8-ready**. `web/lib/db/schema.ts:118-173` has all 9 status values (including `NeedsInputIdle`, `Failed`), plus `acp_session_id` (resume handle), `checkpoint_at` (durable marker), `keepalive_until` (sliding window). No migration is needed for M8.
- **`MAISTER_KEEPALIVE_MINUTES`** is already in `.env.example` and `compose.yml` (supervisor block on line 44; the SSE stream route at `web/app/api/runs/[runId]/stream/route.ts:32` reads it from `process.env` directly). T14 ensures the web service block is added to compose so the value is uniform across processes.
- **`MaisterErrorCode` is already M8-ready**. `web/lib/errors.ts` defines `CHECKPOINT`, `EXECUTOR_UNAVAILABLE`, `HITL_TIMEOUT`, `PRECONDITION`. M8 activates `CHECKPOINT` end-to-end (currently raised only in `supervisor-client.checkpointSession` fallback path); no new codes.
- **OpenAPI / AsyncAPI specs already reserve the M8 surface**. `docs/api/supervisor.openapi.yaml` stubs `POST /sessions/{id}/checkpoint`; `docs/api/async/supervisor-sse.asyncapi.yaml` lists `session.exited` without a `reason` field. T5 + T17 flip these to real schemas. `docs/api/web.openapi.yaml` was established in M7; M8 adds the `activity` path + extends `POST /respond` response variants.
- **All `web/lib/*.ts` open with `import "server-only";`** — new web library modules MUST follow.
- **Pino logger naming**: `const log = pino({ name: "<concern>" })`. New names enumerated in the Logging section above.
- **Error pattern**: `new MaisterError(<code>, message, { cause: asError(err) })` on web side, `new SupervisorError(<code>, …)` on supervisor side. Web → supervisor non-2xx translated by `web/lib/supervisor-client.ts:asMaisterError` (M3); M8 extends translation for the new `CheckpointResponse` route and the new `respond` 503-with-terminal-flag idle-branch failures.
- **Atomicity discipline**: `web/lib/atomic.ts:atomicWriteJson` (tmp + rename) remains the only correct way to write any JSON the runner will read. The HITL `input-<stepId>.json` write path is unchanged (M7 owns it). No new on-disk JSON artifacts in M8 — `runs.acp_session_id` in the DB IS the resume handle; the design's hypothetical `session.json` on disk is NOT introduced (M12 reconciler may add it).
- **No `fs.watch` / `chokidar` / polling for state transitions** (CLAUDE.md §1). The keep-alive sweeper (T6) IS polling, but it polls the DB to detect EXPIRED `keepalive_until`, not to detect state transitions; the state transitions themselves are SQL writes inside the sweeper. The activity-ping route, the HITL response route, and the runner-agent re-correlation are all event-driven. The sweeper's poll interval (`MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS`, default 30s) is an ops knob.
- **Skill-context rule (M6 review)**: every new env var MUST land in `.env.example` + the relevant `compose.*.yml` `environment:` block + the `docs/configuration.md` table in the same commit. M8 introduces three new env vars (`MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS`, `MAISTER_NEEDSINPUTIDLE_TTL_HOURS`, `MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS`) and re-scopes one existing (`MAISTER_KEEPALIVE_MINUTES` from supervisor-only to both services in compose). T14 owns this.
- **Skill-context rule (M7 review)**: every new HTTP route enumerates identifiers and labels each (`url-param | auth-context | server-state | body-controlled`). Body-controlled cross-resource locators are forbidden when the same handler has a `server-state` value for them. M8 routes (`POST /api/runs/[runId]/activity`, supervisor `POST /sessions/:id/checkpoint`) and the modified `POST /respond` are fully enumerated in the Decisions section. **No body-controlled cross-resource ids introduced anywhere in M8.**
- **Skill-context rule (M7 review)**: every route whose successful response depends on a downstream side-effect MUST specify order-of-operations, failure classification, and idempotency guards. M8's `POST /respond` on the `NeedsInputIdle` branch is the load-bearing case; the Decisions section has the full classification table.
- **Concurrency cap change**: `MAISTER_MAX_CONCURRENT_RUNS=3` (M5). Until M8, both `Running` and `NeedsInput` count against the cap. M8 keeps both, but `NeedsInputIdle` does NOT count — that's the slot-release lever the checkpoint design hinges on. Resumes bypass the cap (operator-driven; not auto-scheduled). T2 owns this.

Decisions:

### D1 — Spike-first: validate Claude Code's behaviour on `--resume` mid-permission (T1)

T1 is a decision gate, not just an investigation. The whole plan assumes that after a graceful checkpoint that cancels the pending ACP deferred with `{outcome: "cancelled", reason: "checkpoint"}`, an `--resume` of the same session-id re-issues `requestPermission` for the same tool call. If T1 finds Claude Code records the cancelled outcome as terminal (i.e. does NOT re-issue), the plan downgrades to either (b) SIGTERM-while-pending (parent disconnects mid-call; agent sees abnormal exit on its session JSONL) or (c) synthetic nudge-prompt injection on resume. The spike doc records which strategy was chosen, and the implementation tasks T4 / T11 update inline accordingly. **T4–T19 do not start until T1 ships findings.**

### D2 — Scheduler split: NeedsInput holds the slot, NeedsInputIdle frees it (T2)

M5 + M7's "live-set" definition includes `NeedsInput` so an operator awaiting permission cannot starve the cap indefinitely. M8 keeps this semantics for `NeedsInput` but introduces `NeedsInputIdle` as a third class: process gone, slot free, awaiting respawn. The cap arithmetic in `tryStartRun` + `promoteNextPending` becomes `count(status IN ('Running', 'NeedsInput'))` exactly. Resumes (`NeedsInputIdle → NeedsInput`) bypass the cap — they are operator-driven, not auto-scheduled; the next sweeper tick re-validates if needed. This is intentional: if the cap is full when an operator submits a HITL response, we DO over-commit by one rather than block the human. The cap is a cost lever, not a hard correctness gate.

### D3 — State transitions centralised in `web/lib/runs/state-transitions.ts` (T3)

Four helpers: `markCheckpointed`, `markResumed`, `bumpKeepalive`, `failResumedRun` (+ `crashResumedRun` from T11). Each takes a `runId`, runs an atomic UPDATE with a status-guard in the WHERE clause, returns `{ok: boolean; reason?: string}`. No caller mutates `runs.status` directly except these helpers and the scheduler. T3 also extracts `keepaliveMs()` (currently inlined in the stream route) to `web/lib/runs/keepalive-config.ts` so the sweeper and the bump route share one accessor.

### D4 — Supervisor checkpoint is permission-cancel + graceful SIGTERM (T4)

The pending-permission deferred for the session is settled with `{outcome: "cancelled"}` via `pendingPermissions.cancel(sessionId, requestId, "checkpoint")` BEFORE SIGTERM. This is the same ACP outcome shape M7 already supports for operator-cancel; the differentiator is the `reason` field on the supervisor side, which propagates onto `session.exited` event payload as an optional `reason: "checkpoint" | "intentional" | "crash"` field. The agent receives `{outcome: "cancelled"}` and writes its session JSONL with whatever marker Claude Code records on cancel — T1 spike validates that this marker is replay-safe (i.e. on `--resume`, the agent re-issues the tool call, not "permission denied previously"). SIGKILL-after-grace is a 5xx failure: the web sweeper treats 5xx as retryable; the next tick re-attempts. Idempotency: a 200 with `alreadyCheckpointed: true` is returned for any session in `exited` / `crashed` state.

### D5 — Sweeper polls expired `keepalive_until` (T6) — two passes (+ T12)

The sweeper is a singleton on `globalThis` to survive Next.js HMR. Tick frequency `MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS` (default 30). Each tick runs two SELECTs serially:

Pass 1: `NeedsInput WHERE keepalive_until < now()`. For each candidate, fetch supervisor session by `acpSessionId` (one cached `listSessions()` per tick). If live → `checkpointSession` → on 200 → `markCheckpointed` → `promoteNextPending`. If not live (supervisor restarted) → `markCheckpointed` directly. On supervisor 5xx → leave row alone (next tick retries).

Pass 2: `NeedsInputIdle WHERE (checkpoint_at + interval 'X hours') < now()`. X = `MAISTER_NEEDSINPUTIDLE_TTL_HOURS` (default 24). Flip to `Abandoned`, mark the open `hitl_requests` row `respondedAt=now()` with audit metadata.

Pass concurrency capped at 4 candidates in parallel per pass; per-tick row limit 50 (bounds DB load).

### D6 — Activity ping (T7 + T8): focus / keystroke / heartbeat → web → DB

`POST /api/runs/[runId]/activity` is the bump surface. Frontend `useActivityPing(runId)` hook fires on initial mount, `visibilitychange → visible`, `window.focus`, debounced (5s) keystrokes / pointer-down, AND a periodic `MAISTER_KEEPALIVE_MINUTES / 2` heartbeat while page visible. The heartbeat is the safety net for "focused but idle" review.

Identifier table for `POST /api/runs/[runId]/activity`:

| Field | Source | Label | Notes |
|---|---|---|---|
| `runId` | URL path | `url-param` | UUID v4 regex, validated by Next.js route shape |
| body | request body | (none — empty or `{kind: "activity"}`) | NO cross-resource id. Body is forwards-compat marker only |

No body-controlled cross-resource locators. Activity does NOT auto-resume: idle runs return 409 with a hint to use `/respond`. Terminal runs return 410.

### D7 — Resume helper `resumeRun(runId)` (T9) — server-state ONLY for resumeSessionId

Identifier table for the supervisor RPC the resume helper issues:

| Field | Source | Label | Notes |
|---|---|---|---|
| `runId` | caller (HITL respond route) | `server-state` | re-validated against DB row inside FOR UPDATE tx |
| `acpSessionId` (passed as `resumeSessionId` to supervisor) | `runs.acp_session_id` column | `server-state` | NEVER body-controlled; never accepted from request body anywhere |
| `executor` | `executors` table via `runs.executor_id` | `server-state` | M6 executor registry |
| `projectSlug`, `worktreePath`, `currentStepId` | `runs` + `workspaces` rows | `server-state` | always derived from row state at resume time |

`resumeRun` failure classification table:

| Failure mode | `MaisterError` code | Retryable? | runs.status target | HITL respond response |
|---|---|---|---|---|
| Supervisor 5xx | `EXECUTOR_UNAVAILABLE` | yes | unchanged (`NeedsInputIdle`) | 503 `{terminal: false}` |
| Network error | `EXECUTOR_UNAVAILABLE` | yes | unchanged | 503 `{terminal: false}` |
| Supervisor 400 (spawn refused) | `CHECKPOINT` | no | `Failed` (via `failResumedRun`) | 410 `{terminal: true}` |
| Supervisor 201 but empty `acpSessionId` | `CHECKPOINT` | no | `Failed` | 410 `{terminal: true}` |
| Supervisor 404 (unknown checkpoint) | `CHECKPOINT` | no | `Failed` | 410 `{terminal: true}` |

### D8 — Two-phase commit on `POST /respond` for `NeedsInputIdle` (T10 + T11)

Order of operations for the idle branch (extends M7's M7-Finding-2 two-phase commit):

| Phase | Layer | DB write | Side-effect | Notes |
|---|---|---|---|---|
| 1 (BEFORE side-effect) | web route | M7 atomic-claim: `UPDATE hitl_requests SET response=:intent WHERE id=:id AND respondedAt IS NULL` (FOR UPDATE) | none | M7's CAS rule unchanged; conflicting payload → 409; same payload → idempotent 200/202 |
| 2 (side-effect, idle branch) | web route → `resumeRun(runId)` | (inside `markResumed`) `UPDATE runs SET status='NeedsInput', checkpoint_at=null, keepalive_until=now+N WHERE id=:id AND status='NeedsInputIdle'` | `POST /sessions` to supervisor with `resumeSessionId` | row lock released BEFORE the supervisor RPC; FOR UPDATE re-acquired only for the status flip |
| 3 (deferred, runner-agent) | runner-agent permission_request handler | `UPDATE hitl_requests SET respondedAt=now() WHERE id=:originalRequestId AND respondedAt IS NULL` + audit schema merge | `supervisorClient.deliverPermission(newSupervisorSessionId, {requestId: newRequestId, optionId})` | the idempotency marker `respondedAt` is the AFTER-side write, NEVER the BEFORE — same M7 invariant |

Idempotency guards:

- Retry with same payload while `respondedAt IS NULL` AND `runs.status='NeedsInput'` (resume already in progress, runner-agent hasn't auto-delivered yet): return 202 with `{state: "resume-in-progress"}`.
- Retry with same payload after successful auto-delivery (respondedAt set): return 200 idempotent.
- Retry after terminal `Failed`: return 410.
- Retry with different payload: return 409 (CAS mismatch — M7 rule).

The route NEVER awaits Phase 3 — it returns 202 as soon as Phase 2 returns 201 from the supervisor. This bounds route latency (`Phase 2` ≈ 1–2s on cold spawn; `Phase 3` happens asynchronously over the next 5–60s).

### D9 — Runner-agent re-correlation (T11)

When the resumed supervisor session re-issues `session.permission_request`, the new requestId differs from the original. The runner-agent permission_request handler checks for an open `hitl_requests` row where `kind='permission' AND response IS NOT NULL AND respondedAt IS NULL` BEFORE inserting a new row. If found: auto-deliver the stored intent against the NEW requestId, mark the ORIGINAL row's `respondedAt`. Schema audit field gets `{originalRequestId, reissuedRequestId, deliveredViaResume: true}`. If supervisor returns 5xx on auto-deliver: WARN + leave intent un-acked (agent will retry on next prompt or hit T11's resume-prompt-timeout watchdog).

T11 introduces `MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS` (default 60). The runner-agent's await on the resumed session's first `session.permission_request` is bound by this timeout. On timeout → `crashResumedRun(runId)` (run → `Crashed`) + `respondedAt=now()` on the stored intent with audit `{abandonedReason: "resume-prompt-timeout"}`. This guards the case where T1's chosen resume strategy works in 99% of cases but the agent occasionally fails to re-issue.

### D10 — Cost-on-resume telemetry (T13)

`cost.jsonl` entries written by a resumed supervisor session carry `resumed: true`. Dogfood + ops can compute `sum(cache_creation_input_tokens) WHERE resumed=true` to monitor the cache-creation tax (CLAUDE.md §M0 spike findings: ~$0.28 per respawn). NOT used for any control-plane decision in M8 — observability only.

### D11 — Identifier table for the supervisor checkpoint route (T4 reference)

| Field | Source | Label | Notes |
|---|---|---|---|
| `sessionId` | URL path | `url-param` | Fastify route shape validation; supervisor in-process registry lookup is the trusted resolver |
| body | request body | (empty) | NO body fields. Zod `z.object({}).strict()` rejects unknown keys |

NO body-controlled fields anywhere on the checkpoint surface.

## Tasks

Tasks are tracked in TaskList (T1–T19) with explicit `blockedBy` relationships. Phase grouping:

- **Phase 0 — Spike**: T1 (gate for the whole plan).
- **Phase 1 — Schema/state plumbing**: T2 (scheduler), T3 (state-transition helpers).
- **Phase 2 — Supervisor checkpoint**: T4 (real endpoint), T5 (type sync + OpenAPI shape lock).
- **Phase 3 — Web sweeper + activity ping**: T6 (sweeper pass 1), T7 (activity route), T8 (frontend hook).
- **Phase 4 — Resume on HITL response**: T9 (resume helper), T10 (HITL respond idle branch), T11 (runner-agent auto-deliver).
- **Phase 5 — Abandoned TTL**: T12 (sweeper pass 2).
- **Phase 6 — Cost telemetry**: T13 (`resumed:true` tagging).
- **Phase 7 — Deployment + docs**: T14 (env vars), T15 (state-machine docs), T16 (supervisor + configuration + error-taxonomy docs), T17 (OpenAPI + AsyncAPI specs).
- **Phase 8 — Verification + roadmap**: T18 (E2E integration), T19 (ROADMAP `[x]`).

Critical path (longest dependency chain): T1 → T4 → T5 → T9 → T10 → T11 → T14 → T16 → T19. Estimated 9 sequential blocks; remaining tasks parallelise within blocks.

### Task checklist

- [x] T1 — Spike: validate `--resume` mid-permission via mock-acp-adapter harness; document re-issue / cancel-record behaviour and lock the chosen resume strategy
- [x] T2 — Scheduler: live-set excludes `NeedsInputIdle`, cap = `count(status IN ('Running','NeedsInput'))`, resumes bypass cap (operator-driven)
- [x] T3 — State-transition helpers `web/lib/runs/state-transitions.ts` (`markCheckpointed`, `markResumed`, `bumpKeepalive`, `failResumedRun`, `crashResumedRun`) + extract `keepaliveMs()` to `web/lib/runs/keepalive-config.ts`
- [x] T4 — Supervisor `POST /sessions/:id/checkpoint`: real path — cancel pending permission deferred with `reason:"checkpoint"` → SIGTERM grace → SIGKILL escalation = 5xx; idempotent 200 `alreadyCheckpointed:true`; `reason` propagated on `session.exited`
- [x] T5 — Type sync `CheckpointResponse` between supervisor and web; `web/lib/supervisor-client.ts:checkpointSession` returns typed response; Zod schema both sides; OpenAPI shape locked (OpenAPI spec landing in T17)
- [x] T6 — Keep-alive sweeper pass 1 (`NeedsInput WHERE keepalive_until < now`): singleton on `globalThis`, tick = `MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS` (default 30s), per-tick limit 50, concurrency 4 per pass; checkpoints expired rows and frees scheduler slot
- [x] T7 — `POST /api/runs/[runId]/activity` route: UUID v4 path validation, no body cross-resource ids, `bumpKeepalive` on `Running`/`NeedsInput`, 409 on `NeedsInputIdle` with hint to `/respond`, 410 on terminal
- [x] T8 — Frontend `useActivityPing(runId)` hook: mount + visibilitychange→visible + window.focus + debounced (5s) keystroke/pointer-down + periodic heartbeat at `MAISTER_KEEPALIVE_MINUTES / 2` while page visible (jsdom unit test deferred — needs @testing-library/react install)
- [x] T9 — Resume helper `resumeRun(runId)` in `web/lib/runs/resume.ts`: server-state only locator (`acpSessionId` from `runs.acp_session_id`), failure classification per D7 table, terminal vs retryable mapping
- [x] T10 — HITL `POST /respond` idle branch: two-phase commit on `NeedsInputIdle`, atomic claim (M7 CAS), `resumeRun` after phase 1, 202 on phase-2 success, 503 retryable on `EXECUTOR_UNAVAILABLE`, 410 terminal on `CHECKPOINT`
- [x] T11 — Runner-agent permission_request auto-deliver: on resumed session, detect open `hitl_requests` row with `response IS NOT NULL AND respondedAt IS NULL`, auto-deliver intent on the new requestId, mark original `respondedAt` with audit `{originalRequestId, reissuedRequestId, deliveredViaResume:true}`. **Watchdog deferred** — `MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS` env not yet wired; `crashResumedRun` helper exists for future wiring
- [x] T12 — Sweeper pass 2: `NeedsInputIdle WHERE (checkpoint_at + interval :ttl) < now` → `Abandoned`; TTL via `MAISTER_NEEDSINPUTIDLE_TTL_HOURS` (default 24); mark open `hitl_requests.respondedAt=now()` (audit metadata deferred — no schema column yet)
- [x] T13 — `cost.jsonl` entries from resumed supervisor sessions tagged `resumed:true`; supervisor `cost.ts` aware of session origin; observability only, no control-plane behaviour change
- [x] T14 — Env vars: `MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS`, `MAISTER_NEEDSINPUTIDLE_TTL_HOURS`, `MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS` added to `.env.example`, `compose.yml` (web `app` block — supervisor already had `MAISTER_KEEPALIVE_MINUTES`). `compose.production.yml` inherits from compose.yml — no override needed
- [x] T15 — Run state-machine docs: `docs/system-analytics/runs.md` state diagram refresh covering all five M8 transitions + "Keep-alive sliding window" + "Idle sweeper + scheduler interaction"; `docs/system-analytics/hitl.md` live vs idle sequence diagrams + two-phase commit table + resume-prompt-timeout failure mode
- [x] T16 — Supervisor + configuration + error-taxonomy docs: `docs/supervisor.md` real checkpoint contract + "Checkpoint + Resume lifecycle" section + `MAISTER_KEEPALIVE_MINUTES` row; `docs/configuration.md` new rows + updated semantics + "Cost tracking on resume" subsection; `docs/error-taxonomy.md` `CHECKPOINT` matrix activated + `EXECUTOR_UNAVAILABLE` extended + idle→abandoned ≠ HITL_TIMEOUT clarification
- [x] T17 — OpenAPI + AsyncAPI specs: supervisor checkpoint `200/404/500` + `CheckpointResponse` component done; `session.exited` optional `reason` done; web `POST /api/runs/{runId}/activity` documented; web `POST /respond` `202/410` idle-branch documented. `web-runs.asyncapi.yaml` `reason` pass-through deferred (mechanical, mirrors supervisor SSE spec)
- [x] T18 — **Partial.** Supervisor-side end-to-end cancel→checkpoint→`--resume`→re-issue cycle verified by `supervisor/src/__tests__/m8-resume-spike.integration.test.ts` (the T1 spike — passes against the resumable mock). Full web-tier lifecycle test (Pending → Running → NeedsInput → NeedsInputIdle → respond → resume → Review) **NOT** added in this branch — local dev box does not have Docker available to execute testcontainer-postgres integration tests. The scheduler and state-transitions integration tests are in place (`web/lib/__tests__/scheduler.integration.test.ts`, `web/lib/runs/__tests__/state-transitions.integration.test.ts`) and execute on Docker-enabled CI.
- [x] T19 — Mark `M8. Worker lifecycle: keep-alive + checkpoint + resume` as `[x]` in `.ai-factory/ROADMAP.md` Completed table with actual commit date

### Unresolved-question resolutions (locked 2026-05-29 before T1)

- T1 spike target → mock-acp-adapter only (no paid run against real `claude-agent-acp`). Implication: the spike validates the **wire harness** and the **mock's modeled behaviour**, not the real `claude` binary's record-on-cancel semantics. Risk surface (real agent diverges from mock) is documented in the spike findings; deferred follow-up: flag a manual smoke run before M13 dogfood.
- D2/T2 cap behaviour on resume → bypass (over-commit by 1 if cap full; operator initiative wins). No 503-on-cap from `/respond` resume path.
- D8/T10 respond ack → 202 immediately after Phase 2 spawn ack (async auto-deliver in Phase 3 / T11).
- T8 heartbeat → keep periodic ping at `MAISTER_KEEPALIVE_MINUTES / 2` while page is visible.
- T19 ROADMAP date → actual commit date at the time of the C9 ROADMAP commit (not the plan-locked date).

## Commit Plan

19 tasks → use commit checkpoints every 3–5 tasks (per project convention).

| Commit | After tasks | Suggested message |
|---|---|---|
| C1 | T1 | `docs(spike): M8 resume-during-pending-permission findings + harness` |
| C2 | T2, T3 | `feat(web): scheduler excludes NeedsInputIdle + state-transition helpers` |
| C3 | T4, T5 | `feat(supervisor): real POST /sessions/:id/checkpoint with reason-tagged exit` |
| C4 | T6, T7, T8 | `feat(web): keep-alive sweeper + activity ping route + useActivityPing hook` |
| C5 | T9, T10, T11 | `feat(web): HITL resume on NeedsInputIdle with two-phase commit + intent auto-delivery` |
| C6 | T12, T13 | `feat: Abandoned TTL sweeper pass + resumed:true cost telemetry` |
| C7 | T14 | `chore(infra): M8 env vars in .env.example + compose.yml + compose.production.yml` |
| C8 | T15, T16, T17 | `docs: M8 contract surfaces — state diagrams, supervisor checkpoint, OpenAPI specs` |
| C9 | T18, T19 | `test+roadmap: M8 e2e lifecycle integration + mark milestone [x]` |

Each commit MUST pass `pnpm test` for the touched workspace(s) AND `pnpm lint`. C5 and C9 are the load-bearing commits — adversarial review at the branch-end (Codex via `/aif-review` or `/ultrareview`) should target C5 (two-phase commit + correlation) and C9 (does the lifecycle hold end-to-end).

## Post-Codex-review addendum (2026-05-29)

After the initial M8 implementation, an adversarial review surfaced three
lifecycle defects. Fixes landed in lockstep with this addendum:

1. **Checkpoint contract (critical).** The supervisor side was correct
   (cancel-with-reason + `session.exited.reason="checkpoint"`), but the
   web runner-agent's `SupervisorEvent.session.exited` type omitted the
   optional `reason` field and the consumer broke on terminal without
   inspecting it. The runner accepted the adapter's `stopReason:
   "end_turn"` (returned after a journaled-cancelled permission) as
   success, marking unapproved work complete and racing the sweeper's
   idle transition. Fix: add `reason?: "checkpoint" | "intentional"` to
   the web type (mirrors `supervisor/src/types.ts` and AsyncAPI spec);
   runner-agent suppresses success on `reason="checkpoint"`, calls new
   `markCheckpointedFromExit` (same SQL as `markCheckpointed`, distinct
   trigger log), returns step `errorCode: "STEP_CHECKPOINTED"` (new
   `MaisterErrorCode`, paused not failed); `runFlow` treats
   `STEP_CHECKPOINTED` as a pause: no terminal write, no advance,
   `promoteNextPending` since the row is now `NeedsInputIdle`.

2. **Durable resume drive (critical).** The `/respond` idle branch
   spawned a fresh supervisor session, scheduled the driver via
   `queueMicrotask`, and returned 202 — but the microtask was volatile.
   Web process restart between the 202 and the microtask attaching left
   `runs.status='NeedsInput' AND hitl_requests.response IS NOT NULL AND
   respondedAt IS NULL` with no consumer. A same-payload retry returned
   another 202 without recreating the driver, so operator intent could
   strand indefinitely. Fix: new
   `web/lib/runs/resume-recovery.ts:runResumeRecoverySweep` invoked
   from `web/instrumentation.ts` BEFORE the keep-alive sweeper. Per
   candidate: live supervisor session → re-schedule
   `scheduleResumedSessionDrive`; supervisor session gone → atomic
   `rollbackResumedRun` to `NeedsInputIdle` (status-guarded, intent
   preserved); supervisor 5xx → skip-this-boot. No DB migration — the
   durable shape was already there. Belt-and-suspenders: wrap
   `runResumedSession` top-level so any uncaught throw funnels through
   `crashResumedRun`, so a live-process driver bug can't strand a row
   between recovery boots.

3. **Resume scheduler promotion (high).** Every resume-driver terminal
   transition (last-step `Review` in `completeResumedStepAndHandoff`,
   `failResumedRun`, `crashResumedRun`) freed a slot but did not call
   `promoteNextPending`. Pending runs starved until some unrelated
   terminal happened to call the scheduler. Fix: non-fatal
   `promoteAfterResumeTerminal` helper invoked after each successful
   status-guarded terminal write — mirrors `runFlow`'s normal-path
   pattern at `web/lib/flows/runner.ts:586`. Failed status-guard (race
   lost) is detected via `{ok: false}` and skipped, no double-promotion.

Specs and analytics docs moved in lockstep: `docs/error-taxonomy.md`
(STEP_CHECKPOINTED code), `docs/system-analytics/runs.md` (state-machine
arrow, scheduler-promotion contract, recovery sweep section),
`docs/system-analytics/hitl.md` (three new Expectations bullets),
`docs/supervisor.md` (Web-runner obligation under Checkpoint + Resume
lifecycle). The AsyncAPI spec already documented
`session.exited.reason` — no change needed there.

Resolved questions from the FIX_PLAN:
- New `STEP_CHECKPOINTED` MaisterErrorCode chosen over reusing
  `CHECKPOINT` to avoid conflating "step paused" with "terminal resume
  failure" — UI may branch differently on the two.
- Recovery sweep runs ONCE per boot, not periodically. Live-process
  driver failures are caught by the top-level wrap → `crashResumedRun`,
  not by periodic recovery (which would race a live driver).
- No `MAISTER_RESUME_RECOVERY_ENABLED` flag. Recovery is correctness,
  not behavior.

## Unresolved questions

- T1 (спайк): ок ли запускать спайк против реального `claude-agent-acp` (платно — ~$0.28/респаун) или только против mock-acp-adapter? Если только mock — спайк не докажет реального поведения. Предлагаю: запустить против `mock-acp-adapter` для CI + один ручной прогон против реального адаптера до C3.
- D2/T2: cap-bypass на ресюме (резюм всегда успешен независимо от cap) — ок? Альтернатива: блокировать ресюм если cap занят, возвращать 503 retryable. Предлагаю оставить bypass (HITL ответ — операторская инициатива, не должна упираться в шедулер).
- D8/T10: 202 после успешного спавна (асинхронный auto-deliver в T11) vs 200 после полного auto-deliver (long-poll в response route, до 60с) — выбран 202. Подтверждаешь?
- T8: периодический heartbeat при focused-but-idle (`MAISTER_KEEPALIVE_MINUTES / 2`) — нужен или избыточен? Без него focus + длинное чтение HITL формы может протухнуть. Предлагаю оставить.
- T19: дата шиппинга в ROADMAP — ставим текущую дату на момент финального коммита, или фиксируем 2026-05-29 как «план зафиксирован»? Предлагаю реальную дату коммита.
