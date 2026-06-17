# Phase 6 sub-plan — Launch progress streaming (FR-F1/F2)

> Parent plan: `.ai-factory/plans/feature-unified-capability-composer.md` (Phase 6).
> Spec: `docs/plans/2026-06-16-unified-capability-composer-design.md` §F (FR-F1/F2).
> Status: **RATIFIED 2026-06-17 — Option 2 (streaming POST), flow launch T6.3 IN-PHASE, SSE framing. Implementing.**

## 1. Goal (from the spec)

- **FR-F1** `launchScratchRun` (and flow launch) emit staged progress:
  `precondition → worktree_created → materializing(<adapter>) → spawning → session_ready`.
- **FR-F2** The composer renders a loader from the stream; no UI freeze; failure surfaces a
  typed `MaisterError` code; **cancel mid-launch GCs the worktree/session** (no orphan).

## 2. The two load-bearing facts (verified in code)

1. **The run SSE stream cannot carry launch progress as designed.**
   `GET /api/runs/[runId]/stream` ([route](../../web/app/api/runs/%5BrunId%5D/stream/route.ts)):
   - Returns **404 until the `runs` row exists** (`loadRunLite` → null → 404).
   - **Tails a file** (`run.events.jsonl`), polling every 100 ms. It has **no cross-request
     in-memory bus**.
   - "Synthetic" non-persisted events (`session.stream_timeout`) are generated **by the stream's
     own loop**, from its own state. Nothing lets one HTTP request inject a synthetic event into
     another request's stream.
2. **Launch is synchronous and self-cleaning.**
   `launchScratchRun` ([service.ts:661](../../web/lib/scratch-runs/service.ts)):
   preconditions → `addWorktree` (`worktreeCreated=true`) → materialize → **DB insert (`runs` row
   created mid-sequence, `status:"Running"`)** → `createSession` (supervisor spawn) → return JSON.
   A `try/catch` already compensates (`removeWorktree`+`removeBranch`+upload cleanup) when the
   materialize/DB block fails after the worktree was created. The client `fetch`es the JSON and
   `router.push`es ([scratch-launcher.tsx:558](../../web/components/scratch/scratch-launcher.tsx)).

   Flow launch (`POST /api/runs` → `launchRun` in `lib/services/runs.ts`) is the same shape:
   synchronous, returns `{runId, status:"Running"}` JSON.

## 3. The architecture fork

The Phase-0 `web-runs.asyncapi.yaml` drafted `ScratchLaunchProgress` (`scratch.launch_progress`)
and **bound it to the existing `/api/runs/{runId}/stream` channel** as synthetic, non-persisted
events ("same route, no 2nd endpoint"). Fact (1) makes that binding **unbuildable without new
infrastructure**, because the run SSE stream has no way to receive events from the launch request.

### Option 1 — async-launch (keep progress on the run SSE; spec-aligned)

`POST` returns `runId` **early**; a background task continues worktree→materialize→spawn and emits
progress that the run SSE surfaces. To make fact (1) work, **all** of these must be built:

| New surface | Why it's required | Blast radius |
|---|---|---|
| Insert the `runs` row **before** worktree/materialize/spawn | the stream 404s until the row exists | run-status FSM |
| A new `Launching` run status (or overload `Running`) | the row exists before a session/worktree does; `Running` would lie | `runStatusForDialogStatus`, `lib/board.ts` derivation, `TERMINAL_RUN_STATUS`, keepalive sweeper, `lib/runs/launchability.ts`, reconciliation |
| Cross-request progress propagation (in-memory pub/sub keyed by `runId`, **or** write to `run.events.jsonl`, **or** a 2nd tailed file) | the stream only tails a file / self-generates synthetics | new infra; or pollutes the durable transcript |
| Background execution after the response (`after()` / detached promise) | worktree/materialize/spawn must outlive the early response | not naturally cancellable cross-request |
| Cross-request cancel registry (AbortController keyed by `runId`) | a separate cancel request must reach the background task | new infra; today's in-handler `worktreeCreated` cleanup is unreachable from another request |
| Reconciliation branch for a half-launched `Launching`/`Running` row + partial worktree | the row now precedes its side-effects | new GC/reconcile path |

Pros: matches the Phase-0 asyncapi (no doc churn); progress survives navigate-away; uniform with
the run SSE for both scratch and flow launch.

### Option 2 — streaming POST (progress on the launch request itself) — **RECOMMENDED**

`POST /api/scratch-runs` (and `/api/runs`) returns a **`text/event-stream` response**; the **same
handler** that runs worktree→materialize→spawn emits stage frames as it progresses; the final
`session_ready` frame carries the full launch payload (`runId`, `dialogUrl`, …). Failure → a final
`{type:"error", code:<MaisterError.code>, message}` frame.

| Dimension | Outcome |
|---|---|
| Run-status FSM | **untouched** — the `runs` row stays created where it is today |
| Progress propagation | **trivial** — it's the response body of the same request (no file, no bus, no early row) |
| Cancel-mid-launch (FR-F2) | **free** — client aborts the POST → `req.signal` fires **in the same handler** → reuse the existing `worktreeCreated`/`removeWorktree`/`removeBranch` compensation + supervisor `deleteSession` |
| Crash-window/reconciliation | **identical to today** — server dies mid-launch → existing orphan-worktree / Running-without-session reconciliation |
| Spec | move `ScratchLaunchProgress` **out** of `web-runs.asyncapi.yaml` and into `web.openapi.yaml` as the streamed response of `POST /api/scratch-runs` (+ `/api/runs`). Contained amendment. |

Pros: satisfies FR-F1/F2 with the **least** new surface; cancel-GC is the existing pattern; no
run-status/board/reconciliation ripple. Cons: a small spec move; progress does **not** survive
navigate-away (the loader lives on the launcher, where the user already is).

### Recommendation: **Option 2.**

1. FR-F2's hard requirement — *"cancellation leaves no orphan worktree/session"* — is satisfied for
   free by same-request abort + the existing compensation. Option 1 must **build a cross-request
   launch registry just to make cancel reachable**.
2. Option 1's `Launching` status mutates the run-status FSM, which the root `CLAUDE.md` lists as
   load-bearing across board/reconciliation/keepalive/launchability — a large regression surface
   for a progress indicator.
3. The "survives navigate-away" benefit is marginal for a launch that completes in seconds; the
   loader renders on the launcher itself.
4. The spec divergence is small and arguably **corrects** an aspirational Phase-0 binding — the data
   genuinely flows on the POST, not the run SSE.

**This is the one decision that needs owner sign-off**, because the owner drafted the asyncapi
"same-route" binding (Option 1) in Phase 0. Ratifying Option 2 means amending that.

## 4. Chosen design (Option 2)

### 4.1 Route streaming boundary (preserves the HTTP-status contract)

Split the launch into **cheap, side-effect-free preconditions** vs the **side-effecting stages**:

- **Before the stream starts** (run synchronously, return a normal JSON error on throw → keeps the
  existing 401/403/409/503 contract): auth, request parse, `assertScratchCapacityAvailable`,
  `checkSupervisorHealth` (→ `EXECUTOR_UNAVAILABLE`), `branchExists` (→ `PRECONDITION`).
- **Inside the stream** (errors become in-stream `{code}` frames per FR-F2): `addWorktree` →
  `worktree_created`; materialize(+adapter home) → `materializing(<adapter>)`; `createSession` →
  `spawning`; post-spawn DB update + first prompt → `session_ready` + final result frame.

Seam: refactor `launchScratchRun(args)` → `launchScratchRun(args, opts?: { onProgress?(ev: LaunchProgressEvent): void; signal?: AbortSignal })`. The non-streaming return value is unchanged
(any other caller keeps working — surgical). The cheap checks move into an exported
`assertScratchLaunchable(args)` the route calls first. The route wraps the call in a
`ReadableStream`, framing each `onProgress` event as an SSE `data:` line (no `id:` — these are not
durable run events), then the final result/error frame.

`req.signal` is forwarded as `opts.signal`; the launch checks it at each stage boundary and, on
abort, runs the existing compensation (`removeWorktree`+`removeBranch`) **plus** `deleteSession` if
the supervisor session was already created.

### 4.2 Event shape

Reuse the Phase-0 `ScratchLaunchProgressEvent` JSON (`type:"scratch.launch_progress"`, `stage`,
optional `adapter`, optional MaisterError `code` on failure). Add a terminal `launch_result` frame
(or fold the launch response onto the `session_ready` frame). Keep the schema in `web.openapi.yaml`
under the POST response (§4.4).

### 4.3 Client loader

`scratch-launcher.tsx`: replace `await response.json()` with a stream reader over `response.body`;
render a staged loader (EN+RU labels per stage + the FR-E5 advisory WARN); on the `session_ready`
frame, `router.push(dialogUrl)`; on an `error` frame, surface the typed code; a Cancel button calls
`AbortController.abort()` on the in-flight fetch (drives §4.1's GC).

### 4.4 Spec changes

- `web-runs.asyncapi.yaml`: **remove** the `ScratchLaunchProgress` message + its binding to the run
  channel (it was `Designed`, never built) — replace with a one-line note pointing to the POST.
- `web.openapi.yaml`: `POST /api/scratch-runs` (+ `POST /api/runs`) gains a `text/event-stream`
  response documenting the stage frames + terminal result/error frame.
- `docs/system-analytics/scratch-runs.md` + `runs.md`: describe the streamed launch + cancel-GC.
- `pnpm validate:docs:all` + redocly green.

### 4.5 Flow launch (FR-F1 "and flow launch") — scope decision

The composer/loader (FR-F2) is a **scratch** surface; the task-board Launch button is a different,
simpler surface. **RATIFIED (O2): T6.3 is in-phase** — apply the identical seam to `launchRun`
(`lib/services/runs.ts`) with a minimal inline board loader, after scratch (T6.1/T6.2) is green.

## 5. Reconciliation / crash-window (Option 2)

No change from today. The `runs` row is still created mid-sequence; a server crash mid-launch leaves
either (a) no row yet (worktree orphan only → existing worktree reconciliation/GC) or (b) a
`Running` row with no live session (→ existing `Crashed` reconciliation). The **only** new path is
client-initiated cancel, handled in-handler via `req.signal` + the existing compensation. We will add
a test that a mid-stage abort leaves no worktree, no branch, and no supervisor session.

## 6. Tasks (TDD: red → green)

- **T6.1 (RED)** Failing tests:
  1. Service: `launchScratchRun(args, {onProgress, signal})` emits stages in order
     `precondition*→worktree_created→materializing(<adapter>)→spawning→session_ready` and returns the
     existing payload. (*`precondition` is emitted by the route pre-stream; assert at the route.)
  2. Service: an `AbortSignal` aborted after `worktree_created` triggers `removeWorktree`+`removeBranch`
     (+`deleteSession` if spawned) and throws/*no* orphan — spies on the worktree/supervisor seams.
  3. Route: streamed `text/event-stream` framing; a pre-stream precondition failure still returns the
     JSON error with the correct HTTP status (capacity→409, health→503).
  4. Failure after stream start surfaces an in-stream `{type:"error", code}` frame (typed MaisterError).
  - **Runner-lane discipline (skill-context rule):** name each test's lane; if a route test lands under
    `app/**`, confirm `vitest list` shows it and **extend the integration `include` glob in this same
    task** if `app/**` is not globbed (the M10 trap). Candidate files:
    `web/lib/scratch-runs/__tests__/launch-progress.test.ts` (unit, `lib/**`),
    `web/app/api/scratch-runs/__tests__/route.streaming.test.ts` (confirm glob).
- **T6.2 (GREEN)** Implement: the `assertScratchLaunchable` split + `onProgress`/`signal` seam in
  `launchScratchRun`; the route `ReadableStream` framing; client stream-reader loader + Cancel
  (EN+RU i18n); typed-error frames. DEBUG logs at each stage boundary. Spec changes §4.4.
- **T6.3 (GREEN, scope per O2)** Apply the same seam to flow launch (`launchRun`) + a board inline
  loader, **or** defer to a follow-on. 
- **e2e** `scratch-launch-progress.spec.ts` (stub-supervisor seeded; add to the AUTHED_SPEC regex).
  Runs on host only — Next's single-dev-server lock blocks e2e in the sandbox.
- **Phase exit:** full unit+integration green (or explicit quarantine w/ reason), supervisor tests
  unaffected, `eslint .` clean, docs validators + redocly green.

## 7. Resolved decisions (owner, 2026-06-17)

- **O1 (the fork).** **RATIFIED: Option 2 (streaming POST).** Amends the Phase-0 asyncapi
  "same-route" binding (§4.4 moves the schema to `web.openapi.yaml`).
- **O2 (flow-launch scope).** **RATIFIED: flow launch (T6.3) is IN-PHASE** — apply the same seam to
  `launchRun` (`lib/services/runs.ts`) + a board inline loader within Phase 6.
- **O3 (framing).** **SSE** (`text/event-stream`) for the POST response.
