# Implementation Plan: M7 — ACP integration + SSE bridge + structured HITL response

Branch: feature/m7-acp-sse-bridge
Created: 2026-05-28
Adversarial review: 2026-05-28 — Codex returned `needs-attention` with three findings (HIGH × 2, MEDIUM × 1). All three are addressed in this revision:

- **Finding 1 (HIGH, trust-boundary)**: supervisor input route accepted body-controlled `runId`/`projectSlug`/`stepId`, opening a path-injection vector across runs. **Fix**: drop `kind: "form"` from the supervisor input route entirely. The supervisor handles `kind: "permission"` only; durable form / human responses are written directly by the web tier (which already owns the trust boundary because it resolves IDs from authenticated route params).
- **Finding 2 (HIGH, retry semantics)**: the response route committed `respondedAt` BEFORE supervisor delivery, making any failure non-retryable and silently stranding `NeedsInput` runs. **Fix**: split the DB commit into two phases — phase 1 records the user's choice (`response` jsonb) and releases the row lock; phase 2 marks `respondedAt` only after the supervisor acknowledges. Permission delivery failures distinguish terminal (404 from supervisor — deferred expired) from retryable (5xx / network). Terminal failures transition the run to `Failed` in M7, not deferred to M12.
- **Finding 3 (MEDIUM, hidden-deferred)**: `runner-agent.ts` was specced to swallow DB-insert failures, leaving an invisible pending permission. **Fix**: insert failure becomes a hard fail — runner-agent cancels the supervisor deferred via a new `cancel` action on the input route (resolves with ACP `{outcome: "cancelled"}`), transitions the run to `Crashed`, and emits a visible error. New regression test asserts no `pendingPermissions` entry remains after a simulated insert failure.

## Settings

- Testing: yes — supervisor unit (PendingPermissionRegistry register/resolve/cancel/reject lifecycle including the `{outcome:"cancelled"}` round-trip, `requestPermission` deferred + timeout + cancel paths, `POST /sessions/:id/input` Zod discriminator + dispatcher, structured event log JSONL writer, ring-buffer interaction with `session.permission_request`, `session.permission_auto` removal). Supervisor integration (mock ACP adapter emits `session/request_permission` → SSE event surfaces → input route delivers `optionId` → `requestPermission` resolves with `selected` → adapter continues; cancel branch resolves with `cancelled` → adapter sees cancelled → adapter prints "cancelled" → session.exited; events.jsonl on disk matches SSE stream byte-for-byte after monotonicId fan-out). Web unit (`POST /api/runs/[runId]/hitl/[hitlRequestId]/respond` Zod + Ajv + two-phase commit + retryable-vs-terminal failure paths; `runner-agent.ts` permission_request handler insert + insert-failure cancel propagation; `runner-human.ts` resume-on-existing-input idempotence; `runFlow` re-entry from `NeedsInput`). Web integration (full HITL form round-trip against testcontainer postgres + mock-acp-adapter with `request_permission`; full SSE-bridge round-trip — Route Handler tails events.jsonl, `lastEventId` reconnect skips already-sent events; permission retry-after-network-error keeps row retryable; permission terminal-on-404 transitions run to Failed; insert-failure leaves no hidden deferred). At least one round-trip test per HITL kind (`permission`, `form`, `human`).

- Logging: verbose — pino loggers `name: "supervisor-acp"` (deferred lifecycle, `requestId → optionId / cancelled` correlation, timeout + cancel firings), `name: "supervisor-events-log"` (events.jsonl writer; per-event monotonicId + size), `name: "api-hitl"` (web response route; per-response Zod outcome + dispatch outcome + run-state transition + retry vs terminal classification), `name: "api-runs-stream"` (web SSE bridge route; per-client connect with `lastEventId`, per-batch flush size, per-disconnect reason), `name: "flow-runner"` (existing — extend with permission_request handling + cancel propagation on insert failure). INFO per HITL request created (`runId, stepId, hitlRequestId, kind`), INFO per HITL response delivered (`runId, hitlRequestId, kind, latencyMs, supervisorAck: boolean`), INFO per SSE bridge connect / disconnect, DEBUG per ring-buffer push, DEBUG per deferred resolve / cancel, WARN on `lastEventId` ahead of buffer (replay miss — covered by file-tail fallback), WARN on schema validation failure (response shape), WARN on supervisor-delivery transient failure (retryable), ERROR via `MaisterError` / `SupervisorError` only — including the new "permission deferred cancel on DB insert failure" path. Tool-call payloads in `session.permission_request` MAY include arbitrary text — log only `{toolCallId, kind, title}` summaries, never the full body (consistent with M3–M6 sentinel-token discipline).

- Docs: yes — mandatory docs checkpoint at completion. M7 changes a public contract on every layer (supervisor HTTP + supervisor SSE + web HTTP + web SSE bridge + run-state lifecycle + Flow DSL `human` step). Docs phase touches: `docs/supervisor.md` (POST /sessions/:id/input now real, permission-only with select/cancel actions + new `session.permission_request` event), `docs/api/supervisor.openapi.yaml` (full schemas for input route + remove 501 example), `docs/api/async/supervisor-sse.asyncapi.yaml` (+`session.permission_request`, −`session.permission_auto`), NEW `docs/api/web.openapi.yaml` (HITL response route + SSE bridge route — establishes the web tier's own OpenAPI doc; was previously implicit), NEW `docs/api/async/web-runs.asyncapi.yaml` (bridge mirrors supervisor SSE one-to-one), `docs/error-taxonomy.md` (NEEDS_INPUT, HITL_TIMEOUT, CRASH now actively raised end-to-end — document the trigger condition matrix INCLUDING the retryable-vs-terminal classification on the response route and the cancel-on-insert-failure path), `docs/system-analytics/hitl.md` (state diagram + sequence diagrams move from "designed" to "implemented" — including the new failure / retry sequences), `docs/system-analytics/runs.md` (Running ↔ NeedsInput transitions are now driven by HITL events; add the NeedsInput → Failed and NeedsInput → Crashed terminal transitions M7 introduces), `docs/flow-dsl.md` (`human` step resume contract activated — `on_reject.goto_step` still deferred to M8 follow-up), `docs/database-schema.md` (note `hitl_requests` rows of `kind: "permission"` are now created at runtime AND the two-phase semantics: `response` non-null + `respondedAt` null = in-flight or retryable failure), `docs/configuration.md` (clarify that `MAISTER_KEEPALIVE_MINUTES` is now load-bearing for live HITL timeouts in M7, not just M8's NeedsInputIdle). Mark M7 `[x]` in `.ai-factory/ROADMAP.md`.

## Roadmap Linkage

Milestone: "M7. ACP integration + SSE bridge"
Rationale: Directly implements the next unimplemented milestone in `.ai-factory/ROADMAP.md`. M3–M6 left three closely-coupled gaps: (a) `supervisor/src/acp-client.ts:103-125` auto-allows every `session/request_permission` with a WARN log and a placeholder `session.permission_auto` event — the comment explicitly marks this as M7 work; (b) `supervisor/src/http-api.ts:296-301` returns 501 for `POST /sessions/:id/input` with the literal string "Not implemented in M3 — see M7"; (c) `web/lib/flows/runner-human.ts` writes `needs-input.json` + inserts `hitl_requests` of kind `form`, transitions the run to `NeedsInput`, and returns — there is no path from `NeedsInput` back to `Running` because no web route accepts a response. M7 closes all three together (they are one round-trip; splitting them would leave half a contract in the repo). Keep-alive timeouts + cross-process resume (the durable / `NeedsInputIdle` path) remain M8 — M7 ships the live-session HITL handoff and the SSE wire to the browser; M8 then adds the timeout-to-checkpoint-to-respawn dance on top of it.

## Research Context

Source: code exploration of `/repos/mAIster` on 2026-05-28 (no `.ai-factory/RESEARCH.md` Active Summary present), plus the `docs/kaa-maister-design-20260522-174429.md` design doc, `docs/kaa-maister-design-20260525-acp-revision.md` ACP-revision addendum, and the Codex adversarial-review findings from 2026-05-28 (incorporated above).

Goal: take M7 from "schema + types + 501 stubs exist" to "live HITL round-trip works end-to-end for binary permission AND structured form, SSE bridges supervisor events to the browser via a tail-file Route Handler, and the run state machine moves Running ↔ NeedsInput on real signals WITH retry-safe failure semantics and no hidden deferreds."

Constraints carried over from existing M0–M6 work:

- **DB schema is already M7-ready**. `web/lib/db/schema.ts:235-258` defines `hitl_requests` with `kind: 'permission' | 'form' | 'human'`, `schema: jsonb`, `response: jsonb`, `respondedAt: timestamp`. `runs.status` already has all 9 enum values including `NeedsInput`, `Failed`, `Crashed`. No migration is needed for M7 — the schema was built to absorb this milestone. The two-phase commit semantics (`response` set + `respondedAt` null = in-flight / retryable; both set = delivered terminal-success; both null = no response yet) sit on top of the existing columns without schema changes.
- **MaisterErrorCode is already M7-ready**. `web/lib/errors.ts:3-14` already has `NEEDS_INPUT`, `HITL_TIMEOUT`, `CRASH`, `ACP_PROTOCOL`. No new codes — M7 activates them at the right call sites with explicit retry-vs-terminal classification.
- **OpenAPI / AsyncAPI specs already reserve the M7 surface**. `docs/api/supervisor.openapi.yaml` lines 282–317 stub `POST /sessions/:id/input` with a 501 example. `docs/api/async/supervisor-sse.asyncapi.yaml` already lists `session.permission_auto` as "M5 placeholder, M7 replaces". The docs phase flips these from "stub" to "real".
- All `web/lib/*.ts` open with `import "server-only";` — new web library modules MUST follow.
- Pino logger naming: `const log = pino({ name: "<concern>" })`. New names: `supervisor-acp`, `supervisor-events-log`, `api-hitl`, `api-runs-stream`. Existing `flow-runner` extends, does not get renamed.
- Error pattern: wrap every domain failure as `new MaisterError(<code>, message, { cause: asError(err) })` on web side, `new SupervisorError(<code>, …)` on supervisor side. Web → supervisor non-2xx is already translated by `web/lib/supervisor-client.ts:asMaisterError` (M3); the new web routes reuse it with the retry-vs-terminal classification baked in (see `deliverPermission` decisions).
- **Atomicity discipline**: `web/lib/atomic.ts:atomicWriteJson` (tmp + rename) is the only correct way to write any JSON the runner will read. `input-<stepId>.json` MUST go through it. Reading the artifact uses plain `readFile` — if a write is in flight, the read either sees the prior file or `ENOENT`; never a partial JSON. **The supervisor no longer writes input artifacts** (Finding 1 fix), so `supervisor/src/atomic.ts` is NOT introduced in M7; the web tier owns the artifact write path end-to-end.
- **No `fs.watch` / `chokidar` / polling for state transitions** (CLAUDE.md §1). The live path for HITL response is ACP-driven inside the supervisor (deferred promise resolved/cancelled by the input route). The SSE bridge file-tail is a streaming-output concern, NOT a state-transition concern — it is allowed.
- **No new env vars unless documented end-to-end** (skill-context Rule 1). M7 plans to introduce zero new env vars; the permission deferred timeout reuses `MAISTER_KEEPALIVE_MINUTES` (already documented, default 30 min). If the implementation discovers a hard need for one, the docs phase MUST land it in `.env.example` + the relevant `compose.*.yml` `environment:` block + the `docs/configuration.md` table in the same commit.
- **Concurrency cap stays `MAISTER_MAX_CONCURRENT_RUNS=3`** (M5). A run in `NeedsInput` STILL counts against the cap (`web/lib/scheduler.ts:65-115` includes `NeedsInput` in the live-set query) — the design intent is that a worker awaiting permission is conceptually live; otherwise the user can starve a slot indefinitely. M7 does NOT change scheduler behavior.
- **Slash-in-existing reuse**: in M5, `runner-agent.ts` reuses one supervisor session across consecutive `agent` steps via `AcpSessionState`. The session is alive through human steps too — `runFlow` does not call `deleteSession` between steps in slash-in-existing mode. M7's resume contract for human steps therefore assumes the supervisor session MAY still be alive — but it doesn't NEED to be, because human-step responses are delivered via the web-side artifact write, not via a supervisor wake-up.
- **Supervisor and web tier may live on different hosts** (CLAUDE.md). The web Route Handler must NOT assume colocated disk for the SSE bridge — events.jsonl lives under `MAISTER_RUNTIME_ROOT`, which the web tier reaches through the same shared volume the supervisor writes to. The compose files already mount `maister_runtime:/app/.maister` on BOTH services, so the contract holds in the default deployment.

Decisions:

- **Supervisor: PendingPermissionRegistry as a session-scoped Map of deferreds with three terminal outcomes**.
  - New module `supervisor/src/pending-permissions.ts`. Singleton-shaped:
    - `register(sessionId, requestId, deferred, opts?): void` — adds the entry, starts a `setTimeout` keyed to `MAISTER_KEEPALIVE_MINUTES`.
    - `resolve(sessionId, requestId, optionId): boolean` — settles the deferred with ACP `{outcome: "selected", optionId}`. Used by the `select` action of the input route.
    - `cancel(sessionId, requestId, reason): boolean` — settles the deferred with ACP `{outcome: "cancelled"}` and logs the reason. Used by the `cancel` action of the input route (web side calls this when the runner-agent insert fails, see Finding 3 fix).
    - `reject(sessionId, requestId, error): boolean` — settles the deferred with a thrown `SupervisorError`. Used INTERNALLY for timeout (`HITL_TIMEOUT`) and supervisor SIGTERM cleanup (`CRASH`). NOT exposed via the input route — external callers go through `resolve` (selected) or `cancel` (graceful).
    - `size(sessionId): number` — for telemetry / shutdown logging.
    - `purgeSession(sessionId): void` — called on `session.exited` / `session.crashed`. Rejects all pending for that session with `SupervisorError("CRASH", "session terminated")`.
  - Internal: `Map<sessionId, Map<requestId, { resolve, reject, timer, createdAt }>>`. `requestId` is a v4 UUID generated on each `requestPermission` call (the registry, NOT ACP).
  - Timeout: `setTimeout(reject, MAISTER_KEEPALIVE_MINUTES * 60_000)` that rejects the deferred with `SupervisorError("HITL_TIMEOUT", "permission request <id> timed out after <n> minutes")`. The timer is cleared on `resolve` / `cancel` / `reject` / `purgeSession`.
  - All three of `resolve` / `cancel` / `reject` return `boolean` (true if the entry existed, false if already evicted) so the input route can return a precise 404 vs 200.
  - The registry is NOT persisted to disk — pending deferreds are in-memory state. If the supervisor restarts mid-permission, the worker dies (`session.crashed`); the run reconciler (M12) catches it. M7 does not need to survive supervisor restart mid-permission.

- **Supervisor: `requestPermission` rewrites the auto-allow placeholder**.
  - `supervisor/src/acp-client.ts:requestPermission` becomes: mint `requestId` → register deferred in `pending-permissions.ts` (the deferred's `resolve` callback accepts an ACP outcome object so both `selected` and `cancelled` map cleanly) → bump `record.monotonicId` → emit `session.permission_request` SSE event with `{requestId, options, toolCall}` → await the deferred → return the resolved outcome to ACP (either `{outcome:"selected", optionId}` or `{outcome:"cancelled"}`).
  - `pickAutoAllowOption()` is **deleted** from the supervisor — no auto-allow path remains. The implementation is straightforward enough that a feature-flag fallback would only obscure misbehavior.
  - The `session.permission_auto` SSE event type is also removed from `supervisor/src/types.ts` and `docs/api/async/supervisor-sse.asyncapi.yaml`. There are no production consumers; runner-agent.ts in `web/lib/flows/runner-agent.ts:72-107` does not handle it today (silently ignored). Removing it now is cleaner than carrying a deprecated event for a future cleanup commit.

- **Supervisor: `POST /sessions/:id/input` is permission-only with discriminated action** (Finding 1 fix).
  - `supervisor/src/http-api.ts`: replace the 501 stub with a Zod-validated handler:
    ```
    InputBody = z.object({
      kind: z.literal("permission"),
      action: z.enum(["select", "cancel"]),
      requestId: z.string().uuid(),
      optionId: z.string().min(1).optional(),  // required iff action === "select"
      reason: z.string().min(1).max(256).optional(),  // optional for action === "cancel"
    }).refine(
      (b) => b.action === "select" ? !!b.optionId : true,
      { message: "optionId is required when action='select'" }
    );
    ```
  - **No `kind: "form"` branch.** The supervisor never writes input artifacts — they are written exclusively by the web tier's response route via `web/lib/atomic.ts:atomicWriteJson`. This eliminates the Finding 1 trust-boundary gap entirely: the supervisor accepts no body-controlled filesystem paths.
  - Branch on `action`:
    - `select`: `pendingPermissions.resolve(sessionId, body.requestId, body.optionId!)` → `200 { ok: true }` if ok, else `404 { code: "NEEDS_INPUT", message: "no pending permission with that requestId" }` if the deferred was already evicted (timeout or terminated session).
    - `cancel`: `pendingPermissions.cancel(sessionId, requestId, body.reason ?? "client-cancelled")` → same 200/404 contract.
  - Session resolution: 404 `NEEDS_INPUT` ("unknown session") if `registry.get(sessionId)` returns undefined. Both branches require a live session in the registry; there is no path-derivation step that could escape it.
  - Body validation failure → 409 `PRECONDITION` (matches the existing M5 convention for Zod failures on `POST /sessions`).
  - Logging: INFO `{sessionId, action, requestId, latencyMs, outcome: "ok" | "missing"}` on every request. WARN on 404 with the reason. `optionId` IS logged (it is the user's deliberate selection from a known small set, not arbitrary text); `reason` is logged when set on cancel.

- **Supervisor: structured event log to `<stepId>.events.jsonl`**.
  - New module `supervisor/src/events-log.ts` exporting `openEventsLog(path)` returning an object with `append(event: SessionEvent)` and `close()`.
  - The writer uses `fs.createWriteStream(path, { flags: "a" })` and `stream.write(JSON.stringify(event) + "\n")`. Per-event flush is enough on POC; the file is opened once per spawn (alongside the existing `<stepId>.log` raw-stdout sink in `spawn.ts:55-65`).
  - `spawn.ts` constructs the events log path next to the existing `.log` (same dir, same base, different suffix). `spawn.ts` passes the writer to `acp-client.ts` and the per-session emitter so EVERY `SessionEvent` is written to disk in lockstep with the SSE emit. Lifecycle parity: written events include `session.line`, `session.update`, `session.permission_request`, `session.exited`, `session.crashed`. The writer closes on `session.exited` / `session.crashed`.
  - The existing raw-stdout `.log` stays — it is operator-facing for adapter triage. The events.jsonl is wire-shape, for replay.
  - The supervisor's in-process ring buffer (1000 events, `supervisor/src/registry.ts:32,66-71`) is unchanged; it is the *online* replay path. The events.jsonl is the *durable* replay path. Both exist; consumers choose based on whether a live SSE connection to supervisor exists. M7's web Route Handler chooses events.jsonl (durable, survives supervisor restart, can grow past 1000).

- **Web: `POST /api/runs/[runId]/hitl/[hitlRequestId]/respond` is the single user-facing HITL endpoint with two-phase commit semantics** (Finding 2 fix).
  - New file `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts`.
  - Body shape resolves IDs from URL params: `{ optionId: string }` for `kind=permission`, `{ response: unknown }` for `kind=form` / `kind=human`. The route reads the `hitl_requests` row by `id`, dispatches by `row.kind`.
  - Validation:
    - `permission`: assert `body.optionId` is in `(row.schema as any).options.map(o => o.optionId)`.
    - `form` / `human`: Ajv validates `body.response` against `row.schema` (omitting the M5 `schemaVersion` wrapper if present). On failure, 422 with the Ajv errors path.
  - **Retry-safe two-phase commit** — the contract is that `respondedAt` is the durable success ack and is NEVER set before delivery is confirmed:

    **For `kind = "permission"`:**

    1. `BEGIN`. `SELECT … FOR UPDATE` the `hitl_requests` row and the matching `runs` row by id.
    2. Run terminal check: if `runs.status IN ('Failed','Crashed','Done','Abandoned')` → return `409 CONFLICT` (terminal — no point retrying).
    3. Idempotency check: if `respondedAt IS NOT NULL` → return `409 CONFLICT` (already delivered).
    4. `UPDATE hitl_requests SET response = jsonb_build_object('optionId', :optionId) WHERE id = :id` (records the user's choice; this column is overwriteable by retries with the same OR a different optionId — the latest intent wins, and step 5 will still see a populated `response` even on a retry).
    5. `COMMIT` (releases the row lock so a retry doesn't deadlock against itself).
    6. **Outside the transaction**, call `supervisorClient.deliverPermission(supervisorSessionId, schema.requestId, body.optionId)`.
       - On 200 from supervisor: `UPDATE hitl_requests SET respondedAt = now() WHERE id = :id AND respondedAt IS NULL`. Return `200 { ok: true, runStatus: "Running" }`. The agent's `sendPrompt` unblocks; `runner-agent.ts` keeps consuming events; on the next `session.update` arrival it transitions the row back to `Running` (see runner-agent change). For the response semantics: 200 means "delivered, the run continues".
       - On 404 from supervisor (deferred expired — supervisor `pendingPermissions` has no entry): **terminal failure in M7**. In one transaction: `UPDATE runs SET status='Failed', endedAt=now() WHERE id=:runId AND status='NeedsInput'`; `UPDATE hitl_requests SET respondedAt = now() WHERE id = :id AND respondedAt IS NULL` (records that the response left the web tier, but only the run-state row tells the story of why it failed). Return `410 { code: "HITL_TIMEOUT", message: "permission window expired before response was delivered" }`. The terminal transition happens HERE in M7 — Finding 2 explicitly rejected deferring this to M12.
       - On 503 / 5xx / network error: **retryable failure**. Do NOT update `respondedAt`. Do NOT change `runs.status`. Return `503 { code: "EXECUTOR_UNAVAILABLE", message: "supervisor unreachable; retry the response" }`. The row stays in the "response stored, not yet acked" state. A retry by the user re-runs the route: step 3 still sees `respondedAt IS NULL`, step 4 overwrites `response` with the latest optionId (a user who changes mind on retry wins), step 6 dispatches again.

    **For `kind = "form" / kind = "human"`:**

    1. `BEGIN`. `SELECT … FOR UPDATE` the `hitl_requests` row and matching `runs` row.
    2. Terminal check: `runs.status` terminal → 409.
    3. Idempotency: `respondedAt IS NOT NULL` → 409.
    4. `atomicWriteJson(<runtime>/.maister/<projectSlug>/runs/<runId>/input-<stepId>.json, body.response)`. On `EACCES` / `ENOSPC` / other I/O failures: do NOT commit; return 503 retryable. (The web tier is the sole writer of this artifact, eliminating Finding 1's cross-write risk.)
    5. `UPDATE hitl_requests SET response = :response, respondedAt = now() WHERE id = :id AND respondedAt IS NULL`. (Single phase for form/human because the artifact write IS the delivery — no separate ack is needed.)
    6. `UPDATE runs SET status='Running' WHERE id = :runId AND status='NeedsInput'`.
    7. `COMMIT`. After commit, `queueMicrotask(() => runFlow(runId))` to resume the runner. (The wake signal is in-process; the supervisor session, if alive, was idle through the human step anyway.)
    8. Return `200 { ok: true, runStatus: "Running" }`.

  - 404 response if `hitlRequest` not found. 404 if `run` not found via FK lookup (shouldn't happen given cascade, but defensive).
  - Logging: INFO with `{runId, hitlRequestId, kind, latencyMs, phase: "stored" | "delivered" | "terminal-410" | "retry-503", supervisorAck: boolean}` on the terminal log line. WARN on Zod / Ajv failure with the offending field path. ERROR only via `MaisterError`.
  - The supervisor session id needed for `deliverPermission` is persisted in `hitl_requests.schema.supervisorSessionId` at row-insert time by `runner-agent.ts` (see below). The web side never needs to round-trip to the supervisor to discover it.

- **Web: `runner-human.ts` becomes idempotent on resume**.
  - At step start, before writing `needs-input.json`, check whether `input-<stepId>.json` already exists under the same dir. If present and parseable, read it, return `{ ok: true, vars: parsedResponse, durationMs, needsInput: false }` immediately. The Flow runner already binds the step's outputs into `FlowContext.vars`, so the response value becomes available to later `{{ steps.<id>.output }}` references.
  - If the artifact is absent, proceed with the current path (write `needs-input.json`, insert `hitl_requests` row of `kind: "form"` — `kind: "human"` for steps that have an `on_reject` clause — return `needsInput: true`).
  - `kind` resolution: today the step inserter writes `kind: "form"` unconditionally. The schema enum already supports `"human"`. Decision: rows for steps that declare `on_reject` go in as `kind: "human"` (the on_reject metadata is semantically a review-step concern). Steps without `on_reject` stay as `kind: "form"`.

- **Web: `runner-agent.ts` handles `session.permission_request` mid-stream with hard-fail on insert failure** (Finding 3 fix).
  - In `startEventConsumer`, add a branch for `ev.type === "session.permission_request"`. The branch runs in an `async` IIFE inside the loop so it can await DB work without blocking subsequent events arriving from the supervisor SSE pipe (which are batched server-side and replayable via ring buffer if we briefly fall behind).
  - **Happy path**:
    1. Within a DB transaction: `INSERT INTO hitl_requests (id, runId, stepId, kind, schema, prompt) VALUES (randomUUID(), ctx.runId, ctx.stepId, 'permission', :schema, :prompt)`. The `schema` jsonb carries `{ requestId: ev.requestId, options: ev.options, toolCall: ev.toolCall, supervisorSessionId: ctx.sessionState.currentSessionId }`. `supervisorSessionId` is the supervisor's UUID (the one needed to call `POST /sessions/:id/input`); ctx already has it as the active SSE source. `prompt` is a synthesized human-readable summary via a 3-line local helper (`ev.toolCall?.title ? \`Approve ${ev.toolCall.title}?\` : "Approve tool call?"`).
    2. `UPDATE runs SET status='NeedsInput', currentStepId=ctx.stepId WHERE id=ctx.runId AND status='Running'`. The conditional WHERE prevents racing a concurrent transition.
    3. Do NOT break the consumer loop — `sendPrompt` is still in flight server-side; further events MAY arrive after the user responds (response API resolves the supervisor deferred, the adapter continues, more `session.update` events flow). The consumer breaks only on `session.exited` / `session.crashed`.
  - **Insert-failure path** (NEW — Finding 3 fix):
    1. Catch any error from the INSERT / UPDATE. Log `ERROR { runId, stepId, requestId: ev.requestId, err: serializeError(err) } "permission persistence failed — cancelling deferred"`.
    2. `await supervisorClient.cancelPermission(ctx.sessionState.currentSessionId, ev.requestId, "DB_PERSIST_FAILED")`. The supervisor calls `pendingPermissions.cancel(…)`, which settles the deferred with `{outcome: "cancelled"}`. The adapter sees the cancelled outcome and aborts the tool call gracefully (per ACP spec); the agent typically emits a "permission denied" assistant message and continues, then sendPrompt returns with whichever stopReason the adapter chose.
    3. `UPDATE runs SET status='Crashed', endedAt=now() WHERE id=ctx.runId AND status='Running'`. Use `Crashed` (not `Failed`) because the failure source is infrastructure, not the step's logic; M12's reconciler treats `Crashed` runs with a "Recover or discard" UX.
    4. KEEP consuming the stream (the agent will keep emitting until sendPrompt returns). The buf accumulates the tail; runAgentStep's epilogue logs it and returns `ok:false, errorCode:'CRASH'`.
  - When `sendPrompt` returns (normally or after cancel), the existing `runAgentStep` epilogue applies. If the run is still in `NeedsInput` at that point (timeout fired on the supervisor side and `requestPermission` was rejected with `HITL_TIMEOUT`), `sendPrompt` rejects → step fails → run.status transitions to `Failed` via the existing step-error path. M8 will replace this fail-fast with checkpoint+resume.
  - Transition back to `Running` happens when the response API delivers the optionId, supervisor resolves the deferred, runner-agent observes the next `session.update`, and applies a final `UPDATE runs SET status='Running' WHERE id=ctx.runId AND status='NeedsInput'`. This update is in the SSE consumer's `session.update` branch (no behavioral change vs. M6 except for the new conditional WHERE).

- **Web: `runFlow` re-entry from `NeedsInput`**.
  - `web/lib/flows/runner.ts` already loops through `flow.steps`. M7 makes the loop re-entrant on a per-run basis: when `runFlow(runId)` is invoked on a run whose status is currently `NeedsInput` and whose `currentStepId` points at a step, the runner starts the loop from that step. On entry, fetch all `step_runs` for the current `runId`, group by `stepId`, keep the latest `attempt`'s `vars`, rehydrate `FlowContext.vars`.
  - The `tryStartRun` / `promoteNextPending` scheduler is NOT involved on resume — the run is already counted in the live set (`NeedsInput` is in the live-set query). The response API directly invokes `queueMicrotask(() => runFlow(runId))` to kick the runner.
  - Wrapping note: `runFlow` is currently called once per `POST /api/runs`. Extract the boot path so both call sites converge. Keep the wrapper thin — re-entry must NOT re-create the run row or re-run earlier steps.

- **Web: `GET /api/runs/[runId]/stream` tails events.jsonl**.
  - New file `web/app/api/runs/[runId]/stream/route.ts`. Returns `Response` with `text/event-stream` body produced by a `ReadableStream`.
  - Resolve the events.jsonl path from the run row: `<MAISTER_RUNTIME_ROOT>/.maister/<projectSlug>/runs/<runId>/<currentStepId>.events.jsonl`. M7 streams only the CURRENT step (the live one). On step boundaries the stream closes via `session.exited` / step terminal event and the client reconnects; M8 will extend this to a multi-step tail.
  - `Last-Event-ID` header (or `?lastEventId=` query param fallback) controls the starting offset. The Route Handler reads the JSONL file, skips events with `monotonicId <= lastEventId`, emits the remainder as `id: <monotonicId>\nevent: <type>\ndata: <json>\n\n`.
  - Tailing strategy: read with a small persistent file handle (`fs.promises.open` + `read` loop), maintain a byte cursor. On EOF, check the run row status (cached lookup; refreshed every 500ms via a debounced query). If the run is in a terminal state (`Done | Abandoned | Failed | Crashed`), close the stream. Otherwise sleep 100ms and re-read from the cursor. This is the only allowed "polling" pattern in the codebase and it is a streaming-output concern, NOT a state-transition concern (CLAUDE.md exemption).
  - Backpressure: if the client buffer fills (Response stream `controller.enqueue` returns false), drop to a 250ms backoff before resuming. Cap the unsent backlog at the supervisor's existing 1000-event ring buffer size; beyond that, emit a `data: {"type":"session.gap","reason":"client-slow"}\n\n` synthetic event so the browser can prompt a reload.
  - Logging: INFO `{runId, lastEventId, stepId}` on connect, INFO `{runId, reason, eventsSent}` on disconnect.

- **Web: browser SSE consumer is a thin hook, no UI page in M7**.
  - New file `web/lib/use-run-stream.ts` exporting `useRunStream(runId: string): { events: SupervisorEvent[]; status: "connecting" | "open" | "closed"; lastEventId: number | null; reconnect: () => void }`.
  - Pure React hook, uses `EventSource(`/api/runs/${runId}/stream`)`, accumulates events in state, exposes a reconnect that disposes the EventSource and starts a new one with the current `lastEventId`. No i18n strings in the hook (it returns wire data; M9 wraps the data in a translated UI).
  - The hook is testable headlessly with `vitest` + `@testing-library/react` + a stubbed `EventSource`. M7 ships ONE storybook-style fixture page at `web/app/dev/run-stream/[runId]/page.tsx` that consumes the hook and renders raw JSON — purpose is wire-shape verification during dogfood, not a user-facing surface. The fixture page is EN-only and marked with a `/* dev-only — replaced in M9 */` banner.
  - i18n: `web/CLAUDE.md` mandates EN+RU from day one. The hook is content-free (returns wire data, not labels); compliance lands in M9 along with the real run page. M7 does NOT introduce next-intl / i18next; doing so here would balloon the PR and is genuinely M9 scope.

- **Contract surface enumeration (skill-context rule 2 — MANDATORY)**:
  | Surface | Change | Spec file the docs phase MUST touch |
  |---------|--------|-------------------------------------|
  | `POST /sessions/:id/input` (supervisor) | 501 stub → Zod-validated permission-only body with `action: "select" \| "cancel"`; **no form branch** | `docs/api/supervisor.openapi.yaml` + `docs/supervisor.md` |
  | `session.permission_request` SSE event (supervisor) | New event type with `{requestId, options, toolCall}` | `docs/api/async/supervisor-sse.asyncapi.yaml` + `docs/supervisor.md` + `docs/system-analytics/hitl.md` |
  | `session.permission_auto` SSE event (supervisor) | Removed | `docs/api/async/supervisor-sse.asyncapi.yaml` + `docs/supervisor.md` + `docs/system-analytics/hitl.md` |
  | `POST /api/runs/[runId]/hitl/[hitlRequestId]/respond` (web) | NEW route with two-phase commit + retry-vs-terminal classification | NEW `docs/api/web.openapi.yaml` |
  | `GET /api/runs/[runId]/stream` (web) | NEW route, SSE bridge | `docs/api/web.openapi.yaml` + NEW `docs/api/async/web-runs.asyncapi.yaml` |
  | `MaisterError.NEEDS_INPUT` | Now actively raised end-to-end | `docs/error-taxonomy.md` (clarify trigger conditions) |
  | `MaisterError.HITL_TIMEOUT` | Now raised on permission deferred timeout AND on response-route terminal 410 path | `docs/error-taxonomy.md` |
  | `MaisterError.CRASH` | Now raised on runner-agent insert-failure cancel path | `docs/error-taxonomy.md` |
  | `MaisterError.EXECUTOR_UNAVAILABLE` | Now raised on response-route retryable 503 path (supervisor reachability) | `docs/error-taxonomy.md` |
  | `hitl_requests` rows of `kind = "permission"` | Now created at runtime; `schema` jsonb adds `supervisorSessionId` | `docs/database-schema.md` |
  | `hitl_requests` two-phase semantics | `response` set + `respondedAt` null = in-flight or retryable; both set = delivered terminal-success | `docs/database-schema.md` |
  | `hitl_requests` rows of `kind = "human"` | Now distinguished from `kind = "form"` via `on_reject` presence | same |
  | Flow DSL `human` step | Resume contract activated (`on_reject.goto_step` still M8) | `docs/flow-dsl.md` |
  | Run state transitions Running ↔ NeedsInput → Failed/Crashed | Now driven by HITL events with explicit terminal paths in M7 | `docs/system-analytics/runs.md` + `docs/system-analytics/hitl.md` |
  | `<stepId>.events.jsonl` (new on-disk artifact) | NEW: durable replay log for SSE | `docs/supervisor.md` + `docs/system-analytics/runs.md` |

- **Deployment touchpoints (skill-context rule 1 — MANDATORY check)**:
  - M7 does NOT introduce any new env var, port, sidecar, or host-mounted file. The permission deferred timeout reuses `MAISTER_KEEPALIVE_MINUTES` (already in `.env.example`, `compose.yml`, `docs/configuration.md`).
  - The new on-disk artifact `<stepId>.events.jsonl` lives under `.maister/<slug>/runs/<runId>/` — already covered by the existing `maister_runtime` volume mount on both `app` and `supervisor` services in `compose.yml`.
  - The new web routes bind to the existing `app` service's port 3000 — no new port mapping needed.
  - A dedicated **deployment verification task** (last task of phase 5) confirms the above with `grep` on `Dockerfile`, `compose.yml`, `compose.override.yml`, `compose.production.yml`, `.env.example`, `docs/configuration.md` — if any new env var or path slipped in during implementation, it lands in those files in the same commit.

- **Out of scope for M7 (deferred to M8 / M9 / M12)**:
  - Keep-alive activity-extension on `NeedsInput` (each web-console activity extends the window by 30 min) — M8.
  - Idle timeout → graceful checkpoint → `NeedsInputIdle` → respawn via `--resume` — M8.
  - `on_reject.goto_step` execution in `runner-human.ts` — M8 (resume-rerouting).
  - Actual run detail page / Inbox UI / Needs-you badge — M9 / M10.
  - Reconciler that catches `Crashed` runs from runner-agent insert-failure path — M12 (the M7 row already records the cause via `runs.status='Crashed'` + the ERROR log).
  - File-tail across step boundaries on the web bridge — M8 follow-up; M7 tails the current step only.
  - Multi-step SSE event stream (one stream per run) — M8.
  - Browser-side persistence of `lastEventId` across page reloads (localStorage) — M9 with the real UI.

## Commit Plan

22 tasks across 5 phases — 5 commit checkpoints:

- **Commit 1** (after tasks 1–5): `feat(supervisor): structured events.jsonl writer + PendingPermissionRegistry (select/cancel/reject/timeout)`
- **Commit 2** (after tasks 6–9): `feat(supervisor): real POST /sessions/:id/input (permission-only with select/cancel) + session.permission_request SSE + remove auto-allow`
- **Commit 3** (after tasks 10–14): `feat(web): HITL response route with two-phase commit + runner permission/form handling (incl. cancel-on-insert-failure) + runner re-entry`
- **Commit 4** (after tasks 15–17): `feat(web): GET /api/runs/[id]/stream SSE bridge + useRunStream hook + dev fixture page`
- **Commit 5** (after tasks 18–22): `docs(supervisor,web,hitl,runs,flow-dsl,error-taxonomy,database-schema): M7 contract surface — promote stubs, document permission HITL wire + two-phase response semantics; mark M7 done`

## Tasks

### Phase 1: Supervisor — structured events log + pending-permission registry

- [x] **Task 1: New `supervisor/src/events-log.ts` — JSONL writer for SessionEvent**
  - Files: `supervisor/src/events-log.ts` (NEW)
  - Export `openEventsLog(path: string, opts?: { logger?: Logger }): EventsLogWriter` with methods `append(event: SessionEvent): void` and `close(): Promise<void>`.
  - Internal: open `fs.createWriteStream(path, { flags: "a" })` once; on `append`, `stream.write(JSON.stringify(event) + "\n")`. Track per-instance byte counter for telemetry. On `close`, end the stream and `await` the `finish` event.
  - Pino logger `name: "supervisor-events-log"`. DEBUG per append with `{path, monotonicId, type, bytes}`. WARN on backpressure (`stream.write` returns false). ERROR on stream `error` event.
  - Acceptance: writing 1000 events of mixed types produces a 1000-line file; each line is a valid `JSON.parse` round-trip into the original `SessionEvent`. Covered by Task 5 tests.

- [x] **Task 2: `spawn.ts` opens events.jsonl alongside the existing raw .log**
  - Files: `supervisor/src/spawn.ts` (extend the existing log-path computation at lines 55–65)
  - Compute `eventsLogPath = resolve(runtimeRoot, ".maister", request.projectSlug, "runs", request.runId, `${request.stepId}.events.jsonl`)`.
  - `const eventsLog = openEventsLog(eventsLogPath, { logger });` next to the existing `logStream`.
  - Pass `eventsLog` into the per-session emitter wiring so EVERY `SessionEvent` published on `SESSION_EVENT_CHANNEL` is `eventsLog.append(event)`-ed in lockstep with the ring buffer + SSE side-channel. Implementation: hook into the same `emitter.on(SESSION_EVENT_CHANNEL, ...)` block that populates the ring buffer in `registry.ts:66-71` — append to events.jsonl from there too.
  - On `session.exited` / `session.crashed` / supervisor SIGTERM cleanup, `await eventsLog.close()` before declaring the session done. Existing shutdown grace timing (15s default) is plenty.
  - Logging: extend the existing spawn INFO line with `{eventsLogPath}`.
  - Acceptance: spawning a session that emits N events leaves an N-line `.events.jsonl` on disk; the file ends with a newline; the file is closed (no `lsof` handle leak) after `session.exited`. Covered by Task 5 tests.

- [x] **Task 3: New `supervisor/src/pending-permissions.ts` — deferred registry with select/cancel/reject**
  - Files: `supervisor/src/pending-permissions.ts` (NEW)
  - Export `createPendingPermissions(opts?: { logger?: Logger; timeoutMs?: number }): PendingPermissionRegistry` and the singleton `pendingPermissions = createPendingPermissions({ timeoutMs: keepaliveMinutesEnv() * 60_000 })`.
  - Type `PendingPermissionRegistry { register(sessionId, requestId, deferred): void; resolve(sessionId, requestId, optionId): boolean; cancel(sessionId, requestId, reason): boolean; reject(sessionId, requestId, error): boolean; size(sessionId): number; purgeSession(sessionId): void }`.
  - The `deferred` parameter is the resolver pair `{ resolve: (outcome: AcpPermissionOutcome) => void; reject: (err: Error) => void }`. Internal `resolve(…, optionId)` calls `deferred.resolve({ outcome: "selected", optionId })`. Internal `cancel(…, reason)` calls `deferred.resolve({ outcome: "cancelled" })` AND logs the reason at INFO. Internal `reject(…, err)` calls `deferred.reject(err)`. ACP receives the cancelled outcome as a graceful answer (per `@agentclientprotocol/sdk@0.22.1`); reject is the supervisor-internal escape hatch for timeout / shutdown — external callers (HTTP) only reach `resolve` and `cancel`.
  - Internal: `Map<string, Map<string, { deferred, timer, createdAt }>>`. `register` starts the timeout; `resolve` / `cancel` / `reject` clear it. `purgeSession` rejects all pending for that session with `SupervisorError("CRASH")` and removes the inner Map.
  - `keepaliveMinutesEnv()` is a one-line `parseInt(process.env.MAISTER_KEEPALIVE_MINUTES ?? "30", 10)` helper, exported for the test harness to override.
  - Pino logger `name: "supervisor-acp"`. DEBUG per `register`. INFO per `resolve` / `cancel` with `{sessionId, requestId, ageMs, optionId?, reason?}`. WARN per `reject` (timeout or purge). WARN on `register` collision (duplicate requestId for same sessionId — defensive).
  - Acceptance: covered by Task 5 tests.

- [x] **Task 4: Wire `purgeSession` into supervisor lifecycle**
  - Files: `supervisor/src/registry.ts` (extend the existing exit / crash branches), `supervisor/src/main.ts` (extend SIGTERM cleanup)
  - On every `session.exited` / `session.crashed` event emit in `registry.ts:60-71`, call `pendingPermissions.purgeSession(sessionId)` AFTER pushing the terminal event to the ring buffer.
  - On supervisor shutdown (in `main.ts:63-118`), iterate `registry.forEach` and call `pendingPermissions.purgeSession(entry.record.sessionId)` for each live session BEFORE sending SIGTERM to the child. This ensures awaiting `requestPermission` calls inside the adapter get a clean `CRASH` rejection rather than dangling.
  - Logging: existing supervisor INFO `"shutdown-start"` already names `liveSessions`; extend with `pendingPermissionsCount: sum-of-registry-sizes`.
  - Acceptance: covered by Task 5 tests.

- [x] **Task 5: Unit tests for events-log + pending-permissions + spawn wiring**
  - Files: `supervisor/src/__tests__/events-log.test.ts` (NEW), `supervisor/src/__tests__/pending-permissions.test.ts` (NEW), `supervisor/src/__tests__/spawn.test.ts` (extend existing)
  - events-log unit cases (4):
    - `openEventsLog` + 3 `append` calls + `close` → file has 3 lines, each round-trips through `JSON.parse`.
    - Concurrent `append` calls preserve order (write to a `Writable` that records buffer order).
    - `close` is idempotent (calling twice is safe).
    - Empty `append` queue + `close` → file is created (0 bytes) but exists.
  - pending-permissions unit cases (8, mock setTimeout/clearTimeout via `vi.useFakeTimers`):
    - `register` then `resolve(optionId)` → deferred settled with `{outcome:"selected", optionId}`, timer cleared, return `true`. Second `resolve` returns `false`.
    - `register` then `cancel(reason)` → deferred settled with `{outcome:"cancelled"}`, reason logged at INFO, timer cleared, return `true`. Second `cancel` returns `false`. Subsequent `resolve` also returns `false` (entry already evicted).
    - `register` then `reject(error)` → deferred rejected with the error, timer cleared, return `true`. Subsequent `resolve` / `cancel` return `false`.
    - `register` then advance time past `timeoutMs` → deferred rejected with `SupervisorError("HITL_TIMEOUT")` exactly once.
    - `resolve` / `cancel` / `reject` on unknown `(sessionId, requestId)` → returns `false`, no throw.
    - `purgeSession` rejects all pending for that session with `SupervisorError("CRASH")` and removes the inner Map. Subsequent `resolve` returns `false`.
    - Concurrent `register` for the same `(sessionId, requestId)` → second call logs WARN and overwrites (defensive).
    - Cross-session isolation: `resolve(sessionA, reqX)` does not settle `sessionB`'s `reqX`.
  - spawn wiring extension (2 cases):
    - Spawning a fixture adapter that prints N JSONL lines → `<stepId>.events.jsonl` has N lines AFTER `session.exited`.
    - Events log is closed (verifiable via `fs.stat` succeeding and no handle in `lsof`) after `session.exited`.
  - Logging assertions: no token-like strings appear in captured log records (defense-in-depth, matches M6 sentinel pattern).
  - Acceptance: 14+ test cases, all green.

### Phase 2: Supervisor — real POST /sessions/:id/input + session.permission_request

- [ ] **Task 6: Remove `session.permission_auto` from `SessionEvent` and add `session.permission_request`**
  - Files: `supervisor/src/types.ts` (replace the `permission_auto` variant), `supervisor/src/registry.ts` (no change — ring buffer is type-agnostic, but verify TypeScript still compiles), the supervisor's emit sites, `web/lib/supervisor-client.ts` (mirror the union)
  - New variant:
    ```
    | {
        type: "session.permission_request";
        sessionId: string;
        monotonicId: number;
        requestId: string;
        options: ReadonlyArray<{ optionId: string; kind?: string; name?: string }>;
        toolCall: unknown;
      }
    ```
  - Delete the `session.permission_auto` variant entirely. Run `tsc` and chase down every reference that no longer compiles (there should be exactly one in `acp-client.ts` — replaced in Task 7 — plus the AsyncAPI fixtures, replaced in Phase 5).
  - Mirror the same change in `web/lib/supervisor-client.ts:68-100` so the web tier sees the new wire shape.
  - Logging: n/a.
  - Acceptance: `pnpm --filter @maister/supervisor build` and `pnpm --filter @maister/web build` both pass with no `any` shims.

- [ ] **Task 7: Rewrite `acp-client.ts:requestPermission` — emit event + register deferred + await + accept cancelled outcome**
  - Files: `supervisor/src/acp-client.ts:103-136`
  - Mint `requestId = randomUUID()`.
  - Bump `record.monotonicId`, emit `session.permission_request` event with `{requestId, options: params.options, toolCall: params.toolCall}`.
  - Return `new Promise<AcpPermissionOutcome>((resolve, reject) => pendingPermissions.register(sessionId, requestId, { resolve, reject }))`. The resolver matches ACP's outcome shape (`{outcome:"selected", optionId}` or `{outcome:"cancelled"}`) so the supervisor returns whichever shape pendingPermissions hands back without re-wrapping.
  - Delete `pickAutoAllowOption()` (move the import out, delete the helper). The auto-allow branch is gone.
  - Logging: INFO `{sessionId, requestId, optionsCount, toolCallSummary: { id, kind, title }}` on emit (never the full `params.toolCall` body — same secret-hygiene rule as M3).
  - Acceptance: covered by Task 9 integration tests.

- [ ] **Task 8: Real `POST /sessions/:id/input` handler — permission-only with select/cancel**
  - Files: `supervisor/src/http-api.ts:296-301` (replace stub)
  - Define `InputBody` Zod schema per the decisions section: `{ kind: "permission", action: "select" | "cancel", requestId, optionId?, reason? }` with `.refine` enforcing `optionId` present iff `action === "select"`. **No `form` branch** — the supervisor never writes input artifacts (Finding 1 fix).
  - Handler:
    1. Validate body with `safeParse`; failure → 409 `PRECONDITION` with the Zod path.
    2. Look up `entry = registry.get(sessionId)`; missing → 404 `NEEDS_INPUT` ("unknown session").
    3. Switch on `body.action`:
       - `select`: `const ok = pendingPermissions.resolve(sessionId, body.requestId, body.optionId!)`. `ok ? 200 { ok: true } : 404 { code: "NEEDS_INPUT", message: "no pending permission with that requestId" }`.
       - `cancel`: `const ok = pendingPermissions.cancel(sessionId, body.requestId, body.reason ?? "client-cancelled")`. Same 200/404 contract.
  - The route accepts NO body-controlled paths and never performs filesystem writes. The trust-boundary surface is bounded to the in-memory pendingPermissions Map.
  - Logging: INFO `{sessionId, action, requestId, latencyMs, outcome: "ok" | "missing"}` on every request; WARN on 404 with reason; never log raw body.
  - Acceptance: covered by Task 9 integration tests.

- [ ] **Task 9: Integration tests for the supervisor M7 surface — permission round-trip + cancel + ownership + replay**
  - Files: `supervisor/src/__tests__/permission-roundtrip.integration.test.ts` (NEW)
  - Extend `web/lib/__tests__/_fixtures/mock-acp-adapter.mjs` (or supervisor-side fixture, wherever it lives) to support an env-flagged "emit permission request" mode with options `["allow", "deny"]` and a stdout marker `permission outcome: <selected|cancelled> <optionId?>` so the test can assert what the adapter saw.
  - select round-trip cases:
    - Spawn → adapter emits request_permission → SSE stream surfaces `session.permission_request` with a known `requestId` → POST `/sessions/:id/input` with `{kind:"permission", action:"select", requestId, optionId:"allow"}` → adapter prints `permission outcome: selected allow` → `session.exited` → events.jsonl on disk contains the full sequence in order.
    - Same but POST with `action:"select"` and unknown `requestId` → 404 `NEEDS_INPUT`. Adapter still pending.
    - Same but POST missing `optionId` when action is `select` → 409 `PRECONDITION` (Zod refine failure).
  - cancel round-trip cases:
    - Adapter emits request_permission → POST with `{kind:"permission", action:"cancel", requestId, reason:"DB_PERSIST_FAILED"}` → adapter prints `permission outcome: cancelled` → adapter continues (or exits depending on its scripted behavior) → `session.exited` clean.
    - POST `action:"cancel"` with unknown `requestId` → 404.
  - timeout case:
    - DON'T POST. Wait `timeoutMs` (overridden via env to 200ms for the test) → `requestPermission` inside acp-client rejects with `HITL_TIMEOUT` → adapter sees the error → adapter exits non-zero → `session.crashed`.
  - ownership / cross-session safety:
    - Two sessions in pending-permission state with different requestIds → POST to session A with session B's requestId → 404 (session A does not own that requestId).
    - Two sessions with the SAME requestId (cryptographically unlikely but possible if the test forces it) → POST to session A resolves session A only; session B's deferred remains pending.
  - SIGTERM:
    - Supervisor SIGTERM mid-pending → `purgeSession` fires → adapter sees `CRASH` rejection → adapter exits.
  - lastEventId replay:
    - SSE stream A → receive `session.permission_request` with `monotonicId=N` → close stream A → open stream B with `Last-Event-ID: <N-1>` → stream B replays the permission_request event from the ring buffer.
  - Acceptance: 11+ integration cases, all green; `pnpm --filter @maister/supervisor test` is clean.

### Phase 3: Web — HITL response route + runner permission/form handling + runner re-entry

- [ ] **Task 10: Extend `web/lib/supervisor-client.ts` — `deliverPermission` + `cancelPermission`**
  - Files: `web/lib/supervisor-client.ts`
  - Add `deliverPermission(sessionId: string, requestId: string, optionId: string): Promise<{ ok: true }>` wrapping `POST /sessions/:id/input` with `{kind:"permission", action:"select", requestId, optionId}`.
  - Add `cancelPermission(sessionId: string, requestId: string, reason: string): Promise<{ ok: true }>` wrapping the same route with `{kind:"permission", action:"cancel", requestId, reason}`.
  - **No `deliverFormInput`** — form/human responses are handled entirely on the web side via `atomicWriteJson` (see Task 13).
  - Error translation (load-bearing for Finding 2 fix):
    - Supervisor 404 → `MaisterError("HITL_TIMEOUT", "permission deferred expired or unknown session")` — **terminal** from the response route's perspective.
    - Supervisor 5xx → `MaisterError("EXECUTOR_UNAVAILABLE", "supervisor returned 5xx")` — **retryable** from the response route's perspective.
    - Network / fetch error (ECONNREFUSED, DNS) → `MaisterError("EXECUTOR_UNAVAILABLE")` via `networkErrorToMaister` — **retryable**.
    - Supervisor 409 (Zod validation) → `MaisterError("ACP_PROTOCOL")` — **bug**, should not happen if client + server stay in sync; surfaces as 500 in the response route.
  - Also mirror the `session.permission_request` variant in the `SupervisorEvent` union exported from this file (referenced in Task 6).
  - Logging: existing `logger.debug` pattern; do NOT log `reason` body content beyond its first 64 chars (operator may pass diagnostic strings that include cause stacks).
  - Acceptance: 8+ unit cases in Task 14 covering each error class for both helpers.

- [ ] **Task 11: `runner-agent.ts` handles `session.permission_request` with hard-fail-on-insert** (Finding 3 fix)
  - Files: `web/lib/flows/runner-agent.ts:72-107` (extend `startEventConsumer`)
  - Add a branch for `ev.type === "session.permission_request"`. Wrap the work in an async IIFE so the surrounding `for await` loop keeps consuming subsequent events while this branch awaits DB calls.
  - Happy path inside try:
    1. Within a DB transaction: `INSERT INTO hitl_requests (id, runId, stepId, kind, schema, prompt) VALUES (randomUUID(), ctx.runId, ctx.stepId, 'permission', :schema, :prompt)`. The `schema` jsonb is `{requestId: ev.requestId, options: ev.options, toolCall: ev.toolCall, supervisorSessionId: <currentSessionId>}`. `prompt` from the synthesize helper.
    2. `UPDATE runs SET status='NeedsInput', currentStepId=ctx.stepId WHERE id=ctx.runId AND status='Running'` — conditional WHERE prevents racing a concurrent transition.
    3. INFO log `{runId, stepId, hitlRequestId, requestId, supervisorSessionId}`.
  - Catch path (NEW — Finding 3 fix):
    1. Log ERROR with `{runId, stepId, requestId, err}` and the message "permission persistence failed — cancelling supervisor deferred".
    2. `await supervisorClient.cancelPermission(currentSessionId, ev.requestId, \`DB_PERSIST_FAILED:${err.message.slice(0,128)}\`)`. If THIS also throws (supervisor unreachable), log WARN and continue — the supervisor's own timeout will eventually fire; we tried our best to fail loudly.
    3. `UPDATE runs SET status='Crashed', endedAt=now() WHERE id=ctx.runId AND status='Running'`. The Crashed status is the user-visible signal that something went wrong; the ERROR log line is the operator-visible diagnostic.
    4. Continue consuming the stream — sendPrompt is still pending and the adapter will emit a final session.update + session.exited; we want them in the buf for the run record.
  - The `ctx.runId`, `ctx.stepId`, `ctx.sessionState.currentSessionId` are already in scope. Inject a `db` reference via the existing `RunAgentStepCtx` (extend with `db?: DbClient` defaulting to `getDb()`).
  - Logging: INFO `{runId, stepId, hitlRequestId, requestId}` on row insert; INFO on run-state transition with the same fields; ERROR on the insert-failure-cancel path with full cause.
  - Acceptance: covered by Task 14 + Task 16 integration tests.

- [ ] **Task 12: `runner-human.ts` resume-on-existing-input idempotence + kind distinction**
  - Files: `web/lib/flows/runner-human.ts` (extend the step handler)
  - Before computing the schema / writing `needs-input.json`, check whether `<MAISTER_RUNTIME_ROOT>/.maister/<projectSlug>/runs/<runId>/input-<stepId>.json` exists. If present:
    1. `const raw = await readFile(inputPath, "utf8")`; `const response = JSON.parse(raw)`.
    2. Return `{ ok: true, stdout: "", vars: response as Record<string, unknown>, durationMs, needsInput: false }`.
    3. Skip the `needs-input.json` write and the `hitl_requests` insert (they already happened on the first pass).
  - If the file is absent, proceed with the current path. Differentiate `kind`: if `step.on_reject` is set → `kind: "human"`; else → `kind: "form"`.
  - Reading is plain `fs.readFile` — no retry, no watch. If the response API just wrote the file atomically, the rename is visible on the next syscall.
  - Logging: INFO `{runId, stepId, resumeFromArtifact: boolean}` on entry; existing INFO line stays for the first-pass path.
  - Acceptance: covered by Task 14 + Task 16 integration tests.

- [ ] **Task 13: `runner.ts` re-entry from `NeedsInput` + new `POST /api/runs/[runId]/hitl/[hitlRequestId]/respond` with two-phase commit** (Finding 2 fix)
  - Files: `web/lib/flows/runner.ts` (extend the flow loop entry), `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts` (NEW)
  - `runner.ts` re-entry: when invoked on a run whose status is `NeedsInput` and whose `currentStepId` is set, START the loop at the index of `currentStepId` in `flow.steps`. On entry, fetch all `step_runs` for the current `runId`, group by `stepId`, keep the latest `attempt`'s `vars`, rehydrate `FlowContext.vars`. The existing init likely needs the rehydrate to be additive (move the `vars: {}` init behind an `if (existingStepRuns.length === 0)` guard).
  - The new response route handler (`route.ts`) implements the two-phase commit from the Decisions section. Algorithm pseudocode:
    ```
    Load hitlRequest by id (404 if missing).
    Load run by hitlRequest.runId (404 if missing — defensive; cascade should make this impossible).
    Validate body per row.kind (Zod for shape, Ajv for form_schema for form/human, optionId-in-options for permission). On failure: 422 with field path.
    
    if (kind === "permission") {
      BEGIN; SELECT FOR UPDATE row + run.
      if (run.status is terminal) → 409 (rollback).
      if (row.respondedAt IS NOT NULL) → 409 (rollback).
      UPDATE hitl_requests SET response = jsonb_build_object('optionId', :optionId) WHERE id = :id;
      COMMIT.
    
      try {
        await deliverPermission(row.schema.supervisorSessionId, row.schema.requestId, body.optionId);
        // success: phase 2 commit
        BEGIN;
        UPDATE hitl_requests SET respondedAt = now() WHERE id = :id AND respondedAt IS NULL;
        COMMIT;
        return 200 { ok: true, runStatus: "Running" };
      } catch (err) {
        if (err.code === "HITL_TIMEOUT") {
          // terminal — supervisor lost the deferred. Transition the run.
          BEGIN;
          UPDATE runs SET status = 'Failed', endedAt = now() WHERE id = :runId AND status = 'NeedsInput';
          UPDATE hitl_requests SET respondedAt = now() WHERE id = :id AND respondedAt IS NULL;
          COMMIT;
          return 410 { code: "HITL_TIMEOUT", message: "permission window expired" };
        }
        if (err.code === "EXECUTOR_UNAVAILABLE") {
          // retryable. Do NOT update respondedAt or run.status.
          return 503 { code: "EXECUTOR_UNAVAILABLE", message: "supervisor unreachable; retry" };
        }
        throw err;  // unknown — bubble as 500
      }
    } else {  // form / human
      BEGIN; SELECT FOR UPDATE row + run.
      if (run.status is terminal) → 409 (rollback).
      if (row.respondedAt IS NOT NULL) → 409 (rollback).
      
      try {
        await atomicWriteJson(<runtime>/.maister/<projectSlug>/runs/<runId>/input-<stepId>.json, body.response);
      } catch (err) {
        ROLLBACK;
        return 503 { code: "EXECUTOR_UNAVAILABLE", message: "could not persist input artifact; retry" };
      }
      
      UPDATE hitl_requests SET response = :response, respondedAt = now() WHERE id = :id;
      UPDATE runs SET status = 'Running' WHERE id = :runId AND status = 'NeedsInput';
      COMMIT.
      
      queueMicrotask(() => runFlow(runId));
      return 200 { ok: true, runStatus: "Running" };
    }
    ```
  - `supervisorSessionId` for the permission deliver call comes from `row.schema.supervisorSessionId` (persisted by runner-agent at insert — Task 11).
  - Logging: per Decisions section — INFO with `{runId, hitlRequestId, kind, phase, supervisorAck}` on every terminal log line; WARN on validation failure.
  - Acceptance: covered by Task 14 unit tests + Task 16 integration tests.

- [ ] **Task 14: Unit tests for supervisor-client helpers, runner-agent permission handler (incl. cancel-on-insert-failure), runner-human resume, runFlow re-entry, HITL response route (two-phase)**
  - Files: `web/lib/__tests__/supervisor-client.test.ts` (extend), `web/lib/flows/__tests__/runner-agent.test.ts` (NEW or extend), `web/lib/flows/__tests__/runner-human.test.ts` (NEW or extend), `web/lib/flows/__tests__/runner.test.ts` (extend re-entry), `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/__tests__/route.test.ts` (NEW)
  - supervisor-client cases (8):
    - `deliverPermission` happy path → POST body shape matches `{kind:"permission", action:"select", requestId, optionId}`.
    - `deliverPermission` on supervisor 404 → throws `MaisterError("HITL_TIMEOUT")` (terminal).
    - `deliverPermission` on supervisor 5xx → throws `MaisterError("EXECUTOR_UNAVAILABLE")` (retryable).
    - `deliverPermission` on network error → throws `MaisterError("EXECUTOR_UNAVAILABLE")` (retryable).
    - `cancelPermission` happy path → POST body shape `{kind:"permission", action:"cancel", requestId, reason}`.
    - `cancelPermission` on supervisor 404 → throws `MaisterError("HITL_TIMEOUT")` (informational; runner-agent treats as best-effort).
    - `cancelPermission` on network error → throws `MaisterError("EXECUTOR_UNAVAILABLE")`.
    - Body shape regression: ensure no `kind:"form"` request body is ever produced by either helper.
  - runner-agent cases (6, mock supervisor-client returning a scripted event stream):
    - Stream emits `session.permission_request` → `hitl_requests` row inserted with `kind="permission"`, `schema` contains `requestId` + `options` + `toolCall` + `supervisorSessionId`, `runs.status='NeedsInput'`.
    - Stream emits permission_request twice for the same step → two rows inserted (each independent HITL handoff).
    - Stream emits permission_request + later session.update (after the user responded) → consumer keeps going; later updates append to `buf`.
    - DB insert throws (mocked) → `cancelPermission` called with the matching `(sessionId, requestId)`; `runs.status='Crashed'`; ERROR logged; consumer KEEPS consuming (regression: stream is NOT torn down).
    - DB insert throws AND `cancelPermission` ALSO throws (supervisor unreachable) → WARN logged; `runs.status='Crashed'` is still set; consumer keeps going. The pendingPermissions deferred on the supervisor side will time out — confirm by inspecting that `cancelPermission` was attempted.
    - **No-hidden-deferred regression**: after a simulated insert-throw, a follow-up assertion confirms `cancelPermission` was invoked exactly once with the correct args (using a spy on supervisor-client). This is the explicit Finding 3 test.
  - runner-human cases (3):
    - First pass: no artifact → writes `needs-input.json`, inserts `hitl_requests` with `kind="form"` (no `on_reject`) or `kind="human"` (with `on_reject`), returns `needsInput: true`.
    - Resume pass: artifact exists → returns `{ ok: true, vars: parsedResponse, needsInput: false }`, no writes.
    - Artifact present but malformed JSON → throws `MaisterError("CONFIG")` (matches existing schema-load error pattern).
  - runFlow re-entry cases (2):
    - Boot on a run in `NeedsInput` with `currentStepId="review"` → loop starts at `review`, skips earlier steps, rehydrates their vars from `step_runs`.
    - Boot on a fresh run in `Pending` → loop starts at step 0 (regression check).
  - HITL response route cases (15, handler-level with mocked db + supervisor-client):
    - `kind=permission` happy two-phase: phase 1 commits response → phase 2 dispatches → phase 3 commits respondedAt → 200.
    - `kind=permission` with optionId not in options → 422.
    - `kind=permission` with supervisor 404 (HITL_TIMEOUT) → in the SAME response: runs.status='Failed', hitl_requests.respondedAt set, return 410. Assert the run row IS updated (regression for Finding 2 — terminal in M7, not deferred).
    - `kind=permission` with supervisor 5xx → row stays in retryable state (response present, respondedAt null), runs.status unchanged, return 503. Retry from the same client succeeds (mock supervisor returns 200 on second call); final state shows respondedAt set, run.status='Running'.
    - `kind=permission` with network error → same as 5xx (retryable).
    - `kind=permission` retry with a DIFFERENT optionId (user changed mind) → second call's response column reflects the new optionId; delivery uses the new optionId.
    - `kind=permission` already-delivered (respondedAt set) → 409.
    - `kind=permission` with run.status='Failed' (terminal from a previous attempt) → 409 (terminal-run guard fires).
    - `kind=form` happy path → atomicWriteJson + DB update + queueMicrotask + 200.
    - `kind=form` with response failing Ajv → 422.
    - `kind=form` with atomicWriteJson throwing EACCES → 503 retryable; row unchanged. Retry from the same client succeeds; final state shows respondedAt set + artifact on disk.
    - `kind=form` already-delivered (respondedAt set) → 409.
    - Idempotent double-click on phase-1-committed permission row (response set, respondedAt null) → second concurrent caller waits on row lock; serialized; first commits, second sees respondedAt set in step 3 → 409. (Verifies SELECT FOR UPDATE serializes correctly.)
    - Run not in `NeedsInput` AND not terminal (e.g. somehow `Running` already) → 409.
    - `kind=human` (on_reject step) round-trip identical to `kind=form` except the row carries on_reject in schema.
  - Logging assertions: no `response` payload appears in any log record (user data hygiene); no `optionId` for non-permission kinds (it shouldn't exist there).
  - Acceptance: 34+ test cases, all green.

### Phase 4: Web — SSE bridge + browser hook + dev fixture

- [ ] **Task 15: New `GET /api/runs/[runId]/stream` Route Handler tailing events.jsonl**
  - Files: `web/app/api/runs/[runId]/stream/route.ts` (NEW)
  - Resolve `run` by `runId` from DB; 404 if missing. Compute `eventsLogPath` from `(projectSlug, runId, currentStepId)`. If `currentStepId` is null (run hasn't started its first step yet), return an empty stream that closes after a short keepalive ping.
  - Build a `ReadableStream` controller that opens `fs.promises.open(eventsLogPath, "r")`, tracks a byte offset, and reads chunks. Parse JSONL: each complete line is an SSE event with `id: <monotonicId>\nevent: <type>\ndata: <full JSON>\n\n`.
  - `lastEventId` is read from the `Last-Event-ID` header (case-insensitive; Next.js `request.headers.get`); fall back to `?lastEventId=` query for browsers that strip headers. Skip lines with `monotonicId <= lastEventId`.
  - Tail loop: after reading what's on disk, query the run row again (`status, currentStepId`); if terminal (`Done`, `Abandoned`, `Failed`, `Crashed`), close the stream. Otherwise `setTimeout(100ms)` and re-read from the cursor. Cap consecutive empty reads at `MAISTER_KEEPALIVE_MINUTES` (default 30 min) — beyond that, close the stream with a `session.stream_timeout` synthetic event.
  - Client disconnect: `request.signal.aborted` → close the file handle and stop the loop. Log INFO `{runId, eventsSent, reason: "client-disconnect"}`.
  - Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no` (matches the supervisor's existing SSE headers).
  - Logging: INFO `{runId, lastEventId, eventsLogPath}` on connect; INFO `{runId, eventsSent, durationMs, reason}` on disconnect.
  - Acceptance: covered by Task 16 integration tests.

- [ ] **Task 16: Integration test for the SSE bridge — file tail + lastEventId reconnect + terminal-on-Crashed**
  - Files: `web/app/api/runs/[runId]/stream/__tests__/route.integration.test.ts` (NEW)
  - Setup: testcontainer postgres + a fake `<runId>/<stepId>.events.jsonl` file pre-seeded with 5 events (`monotonicId: 1..5`).
  - Cases:
    - Connect with no `lastEventId` → receive events 1..5 in order, each as SSE with proper `id:`, `event:`, `data:` framing.
    - Connect with `Last-Event-ID: 2` → receive events 3..5 only.
    - Append events 6..10 to the file mid-stream → client receives them in order.
    - Run status flips to `Done` → stream closes within 200ms after the status change.
    - Run status flips to `Crashed` (from runner-agent insert-failure path) → stream closes within 200ms. Also covered: the events.jsonl tail captures the trailing `session.update` chunks the adapter emits after cancel.
    - Client disconnects → file handle is released (check via second connect succeeding).
    - 404 on unknown runId.
    - Empty file → stream stays open, ping keepalive eventually closes per `MAISTER_KEEPALIVE_MINUTES` (override to 1s in the test).
  - Cross-test with the supervisor-side integration: spawn a mock-acp-adapter via the supervisor → web Route Handler tails events.jsonl as the supervisor writes it → events received in real time. Proves the contract across the process boundary.
  - Logging assertions: no payload content from `session.update.update.content.text` is in the route handler logs (we log connect / disconnect only).
  - Acceptance: 8+ test cases, all green.

- [ ] **Task 17: Browser SSE hook + dev fixture page**
  - Files: `web/lib/use-run-stream.ts` (NEW), `web/app/dev/run-stream/[runId]/page.tsx` (NEW)
  - `useRunStream(runId)`: returns `{ events, status: "connecting" | "open" | "closed", lastEventId, error, reconnect }`. Internal: `useEffect` opens `new EventSource(`/api/runs/${runId}/stream`)`, attaches `onmessage` / `onopen` / `onerror`, accumulates parsed events in state, tracks the highest `event.lastEventId` on each message. `reconnect()` closes the current EventSource and starts a new one with the same `lastEventId` (passed via query param since EventSource constructor doesn't accept custom headers in browsers).
  - Reconnect on transient `error`: `EventSource` auto-reconnects by default — the browser includes the `Last-Event-ID` header automatically on reconnect. The hook surfaces `error` to the caller but does NOT manually close on transient errors.
  - Cleanup in the `useEffect` return — close the EventSource on unmount.
  - Dev fixture page: `web/app/dev/run-stream/[runId]/page.tsx`. Pure RSC + a small `'use client'` wrapper that renders the hook output as a scrolling `<pre>` of `JSON.stringify(event, null, 2)`. Header: "DEV FIXTURE — replaced by Run Detail page in M9. Do NOT link from production UI." EN-only.
  - Unit tests: `web/lib/__tests__/use-run-stream.test.tsx` (NEW) using a stubbed `EventSource` (vitest + happy-dom). Cases: connects on mount, accumulates events, updates `lastEventId`, closes on unmount, `reconnect()` re-opens with the latest `lastEventId`.
  - Logging: client-side `console.warn` on `EventSource.error` only.
  - Acceptance: 4+ hook unit cases; dev fixture renders the hook output in a real browser (manual smoke during implementation).

### Phase 5: Documentation + roadmap + deployment verification

- [ ] **Task 18: Update `docs/supervisor.md` + `docs/api/supervisor.openapi.yaml`**
  - Files: `docs/supervisor.md`, `docs/api/supervisor.openapi.yaml`
  - `docs/supervisor.md`:
    - HTTP API table: update the `/sessions/{id}/input` row from "Stub: Returns 501 …" to "Implemented (M7). **Permission-only**; discriminated body with `action: 'select' | 'cancel'`. Returns 200 / 404 / 409."
    - New subsection "HITL response routing" with example bodies for `select` and `cancel` and the 404 / 409 conditions. Explicit note: "The supervisor does NOT accept body-supplied filesystem paths. Durable form responses are written by the web tier; the supervisor's role for HITL is limited to live-permission deferred coordination."
    - SSE events list: remove `session.permission_auto`. Add `session.permission_request` with the `{requestId, options, toolCall}` shape.
    - New subsection "Structured events log (`<stepId>.events.jsonl`)" — what it is, where it lives, why it exists alongside the raw `.log`.
  - `docs/api/supervisor.openapi.yaml`:
    - Replace the `/sessions/{id}/input` 501 response with the full real spec: `requestBody` ($ref new `InputBody` schema), `200 { ok: true }`, 404 `NEEDS_INPUT`, 409 `PRECONDITION`.
    - Add `InputBody` schema to `components.schemas` (one variant with action discriminator).
    - Bump version to `0.7.0` and add a `# Changelog` comment for M7.
  - Logging: n/a.
  - Acceptance: OpenAPI lint clean; manual review confirms the prose matches the YAML.

- [ ] **Task 19: Update `docs/api/async/supervisor-sse.asyncapi.yaml`**
  - Files: `docs/api/async/supervisor-sse.asyncapi.yaml`
  - Remove the `session.permission_auto` channel / message entirely. Add `session.permission_request` with the new schema. Update the "M5 placeholder, M7 replaces" notes.
  - Bump version to `0.7.0`.
  - Acceptance: AsyncAPI lint clean; examples align with the SessionEvent union in `supervisor/src/types.ts` after Task 6.

- [ ] **Task 20: Create `docs/api/web.openapi.yaml` + `docs/api/async/web-runs.asyncapi.yaml`**
  - Files: `docs/api/web.openapi.yaml` (NEW), `docs/api/async/web-runs.asyncapi.yaml` (NEW)
  - `web.openapi.yaml` — first version of the web tier's own OpenAPI doc. Routes for M7:
    - `POST /api/runs` (port the schema from `web/app/api/runs/route.ts:postBodySchema`).
    - `POST /api/runs/{runId}/hitl/{hitlRequestId}/respond` — body discriminated by kind (Zod schema dump); responses 200 / 410 / 422 / 503 / 409 with explicit retry-vs-terminal classification table.
    - `GET /api/runs/{runId}/stream` — references the SSE AsyncAPI doc.
  - `web-runs.asyncapi.yaml` — mirrors the supervisor SSE doc for the web-side bridge. Events are the same union; document that the contract is identical and that the only difference is the durable file-tail backing store.
  - Both docs link back to `supervisor.openapi.yaml` and `supervisor-sse.asyncapi.yaml` via `externalDocs`.
  - Acceptance: linter clean; the routes table in `docs/api/external/README.md` is updated to include the web docs.

- [ ] **Task 21: Update prose docs — error-taxonomy, system-analytics, flow-dsl, database-schema, configuration**
  - Files: `docs/error-taxonomy.md`, `docs/system-analytics/hitl.md`, `docs/system-analytics/runs.md`, `docs/flow-dsl.md`, `docs/database-schema.md`, `docs/configuration.md`
  - `error-taxonomy.md`:
    - `NEEDS_INPUT`: clarify the live `session.permission_request` trigger AND the durable `needs-input.json` trigger.
    - `HITL_TIMEOUT`: add the M7 supervisor-side deferred-timeout case AND the response-route 410 terminal case (supervisor lost the deferred while web held the user's choice).
    - `CRASH`: add the runner-agent insert-failure cancel-propagation case.
    - `EXECUTOR_UNAVAILABLE`: clarify M7 retryable-503 case from the response route (vs M6's executor-resolution failure).
    - Mention the GC 24h timeout is M12; the per-permission `MAISTER_KEEPALIVE_MINUTES` timeout is M7.
  - `system-analytics/hitl.md`: state machine and sequence diagrams go from "designed" to "implemented (M7)". Include three new sequences: (a) happy permission round-trip with two-phase commit, (b) terminal-on-supervisor-404 with run-to-Failed transition, (c) cancel-on-insert-failure with run-to-Crashed transition.
  - `system-analytics/runs.md`: `Running ↔ NeedsInput` transitions now have THREE sources (human step, agent permission request, future M8 checkpoint). Add `NeedsInput → Failed` (HITL_TIMEOUT terminal) and `Running → Crashed` (DB insert failure cancel) transitions.
  - `flow-dsl.md`: under `human` step, change "Resuming via the form response is M7 + M8" to "Resuming via the form response: implemented in M7 (web-tier artifact write). `on_reject.goto_step` execution remains M8."
  - `database-schema.md`: under `hitl_requests`, document the two-phase semantics (`response` set + `respondedAt` null = in-flight or retryable; both set = delivered terminal-success; both null = no response yet). Note that `kind = "permission"` rows carry `supervisorSessionId` in `schema` jsonb.
  - `configuration.md`: clarify in the `MAISTER_KEEPALIVE_MINUTES` row that as of M7 this controls the supervisor's pending-permission deferred timeout AND (in M8) the NeedsInputIdle keep-alive window.
  - Acceptance: prose review checklist passes; cross-references compile (no broken anchors).

- [ ] **Task 22: Deployment verification + ROADMAP mark + final sanity sweep**
  - Files: `.env.example`, `compose.yml`, `compose.override.yml`, `compose.production.yml`, `docs/configuration.md`, `.ai-factory/ROADMAP.md`, ad-hoc shell commands
  - **Deployment verification (skill-context rule 1)**: `grep -rn "MAISTER_" .env.example compose*.yml docs/configuration.md` — confirm no NEW env var slipped into the implementation. If any was added, ensure it lands in `.env.example` + all relevant `compose.*.yml` `environment:` blocks + the canonical table in `docs/configuration.md` in the same commit. Expected for M7: no diff.
  - **Contract surface sweep (skill-context rule 2)**: walk the contract-surface table from the Decisions section and confirm each spec file was touched in the docs commit. `git diff main..HEAD --name-only -- docs/` is the cross-check.
  - **Build + test sweep**: `pnpm install` clean; `pnpm --filter @maister/supervisor build && pnpm --filter @maister/web build` both pass; `pnpm --filter @maister/supervisor test && pnpm --filter @maister/web test` both pass.
  - **Smoke test**: manual end-to-end using the aif Flow plugin from M5. Cover three scenarios: (a) happy permission round-trip (curl select on the SSE-surfaced requestId), (b) permission terminal-on-404 (let the supervisor's timeout fire BEFORE the curl, verify the route returns 410 and runs.status='Failed'), (c) form HITL round-trip on the `review` step.
  - **ROADMAP**: mark M7 `[x]` with the M5/M6-style summary (key file paths, test counts, doc files touched, the three findings + their fixes, any deferred items pointing at M8/M12).
  - Logging: n/a (verification task).
  - Acceptance: zero new env vars, zero contract surfaces missed in docs, all builds + tests green, all three smoke-test scenarios pass, ROADMAP shows M7 done.

## Unresolved questions

Все вопросы из первой версии плана разрешены:

- `session.permission_auto` мягкое или жёсткое удаление — **жёсткое** (одна повторная попытка ввести фолбэк = тихий регресс).
- `kind:"human"` vs `kind:"form"` различать по `on_reject` — **да** (M8's resume-rerouting нужен сигнал для on_reject; даром).
- `web.openapi.yaml` создавать сейчас или после M9 — **сейчас** (контракт двух новых routes + retry-vs-terminal классификация требует спецификации).
- Browser `useRunStream` через `EventSource` или fetch+ReadableStream — **EventSource** (нативный, авто-reconnect с Last-Event-ID, не надо вручную реализовывать).
- `MAISTER_HITL_PERMISSION_TIMEOUT_MS` отдельной переменной или reuse `MAISTER_KEEPALIVE_MINUTES` — **reuse** (один временной бюджет для всех "ожидаю человека" сценариев упрощает ops).

Резолюции по Codex review:

- Finding 1: form-ветка supervisor-роута удалена; supervisor больше не пишет input-артефакты. Web-тier — единственный writer.
- Finding 2: двухфазный commit. Phase 1 пишет `response` (выбор пользователя сохранён, но не подтверждён). Phase 2 пишет `respondedAt` ТОЛЬКО после supervisor ACK. Терминальная 410-ветка явно переводит run в `Failed` в M7 (не откладывая на M12). Retryable 503-ветка оставляет ряд в восстанавливаемом состоянии.
- Finding 3: cancel-action на supervisor-роуте; runner-agent при insert-failure вызывает `cancelPermission`, переводит run в `Crashed`. Регрессионный тест в Task 14 явно проверяет, что после симулированной DB-ошибки нет висящего deferred.
