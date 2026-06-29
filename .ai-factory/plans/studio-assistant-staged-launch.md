# Plan — Flow Studio assistant: staged-stream launch (surface `runId` before the first turn)

Branch: `claude/cranky-bartik-847c74` (existing worktree — no new branch created)
Created: 2026-06-29
Mode: full / SDD-driven spec → TDD implementation

## Settings

- **Testing:** Yes — TDD, RED → GREEN → refactor. Cover all required behavior + edge cases, minimal overlap, no trivial tests.
- **Logging:** Standard (preserve existing INFO launch log fields; add WARN on stream failure mirroring the scratch route).
- **Docs:** Mandatory — SDD. Accurate API-contract (OpenAPI), DB-migration assessment, and system-analytics updates are part of the deliverable; route doc changes through `/aif-docs` at completion.

## Roadmap Linkage

Milestone: "none" — Rationale: targeted UX/correctness fix on the M36/ADR-110 Flow Studio assistant; not a roadmap milestone.

---

## 1. Problem (root cause — confirmed)

On the **first** request to the docked Flow Studio AI assistant, the panel sits on "Запускается…" and the entire first turn is invisible; the full answer appears only when the turn finishes. Second and later turns behave correctly (incremental output + working badge).

Root cause is an **asymmetry in when the client receives `runId`**, not the agent:

- First turn: [`StudioAiTab.launch()`](web/components/studio/studio-ai-tab.tsx:240) does a plain `await fetch(...) + res.json()` and only sets `runId` after the response ([studio-ai-tab.tsx:281](web/components/studio/studio-ai-tab.tsx:281)). The service [`launchLocalPackageAssistant`](web/lib/scratch-runs/service.ts:1418) **does not return until the whole turn completes** — it `await`s `sendScratchPromptAndProjectEvents` → `completeScratchPromptTurn` → `postProcessFlowAssistantTurn` ([service.ts:1664-1676](web/lib/scratch-runs/service.ts:1664)). Until the JSON returns: `runId === null` ⇒ `useRunStream` inactive ([studio-ai-tab.tsx:101](web/components/studio/studio-ai-tab.tsx:101)), `ScratchConversation` unmounted ([studio-ai-tab.tsx:348](web/components/studio/studio-ai-tab.tsx:348)), `onHeaderInfo` null ⇒ **no working badge** ([studio-ai-tab.tsx:236](web/components/studio/studio-ai-tab.tsx:236)); only `launching` is true ⇒ button shows `labels.launching` ("Запускается…", [studio-ai-tab.tsx:460](web/components/studio/studio-ai-tab.tsx:460)).
- Later turns: `runId` already set ⇒ SSE live, transcript + badge work. The `messages` route also blocks for the turn, but that no longer hurts UX because the stream is already attached.

## 2. Goal & approach (Variant 1, owner-approved)

Surface `runId` to the client **before** the first turn runs, by converting the assistant launch to the already-proven **staged-stream** pattern used by scratch runs: [`launchScratchRunStaged`](web/lib/scratch-runs/service.ts:737) yields a `session_ready` progress event carrying `runId` ([service.ts:1086](web/lib/scratch-runs/service.ts:1086)) **before** `sendScratchPromptAndProjectEvents`; the route streams it as `text/event-stream` ([app/api/scratch-runs/route.ts](web/app/api/scratch-runs/route.ts)); the client reads frames with [`readLaunchStream`](web/lib/runs/launch-progress.ts:65) and acts on `session_ready` ([scratch-launcher.tsx:617](web/components/scratch/scratch-launcher.tsx:617)).

Reuse, do not fork: `lib/runs/launch-progress.ts` (`launchProgress`, `format*Frame`, `readLaunchStream`, `LaunchStage`) is generic and already used by scratch. The assistant uses the subset `precondition → materializing → spawning → session_ready` (no `worktree_created` — there is no managed worktree). No new stage enum value is required (DRY/KISS).

## 3. Specification

### 3.1 Functional requirements

- **FR1** — `launchLocalPackageAssistantStaged` (new async generator) yields `session_ready` with a non-empty `runId` (+ `dialogUrl` `/scratch-runs/<runId>`) **after** the supervisor session is created and the run row is persisted with `dialogStatus="Running"` and `run_sessions.acpSessionId` set, but **before** `sendScratchPromptAndProjectEvents` is invoked.
- **FR2** — Yield order at the existing logical boundaries: `precondition` (after runner-resolution + supervisor-health + capacity, before any FS/DB side effect) → `materializing` (after capability-profile + flow-authoring-skill materialization) → `spawning` (before `createSession`) → `session_ready` (after the status-update transaction).
- **FR3** — The promptless path (`hasInitialPrompt === false`) yields `session_ready` then returns the `WaitingForUser` result with **no** turn and **no** error frame (service-parity; the Studio UI always sends a prompt).
- **FR4** — `launchLocalPackageAssistant` remains a thin **drain wrapper** that runs the generator to completion and returns the same terminal `ScratchRunResponse` (mirrors how `launchScratchRun` wraps `launchScratchRunStaged`). Existing direct callers/tests keep working unchanged.
- **FR5** — `POST /api/studio/local-packages/{id}/assistant` responds `200 text/event-stream`: ordered `scratch.launch_progress` frames, then a terminal `scratch.launch_result` frame wrapping the existing **narrow** `StudioAssistantLaunchResponse` (`{ runId, dialogStatus, actionResult }`). The route **maps** the generator's `ScratchRunResponse` return down to that shape before framing it — `{ runId: r.runId, dialogStatus: r.status.dialogStatus, actionResult: r.actionResult ?? null }`, exactly as the current non-streaming route does ([route.ts:88](web/app/api/studio/local-packages/[id]/assistant/route.ts:88)) — so the `StudioAssistantLaunchResponse` schema is **unchanged**; only the transport changes (202-JSON → 200-stream). A failure **after** the stream opens emits `data: {"type":"error","code":<MaisterError>,"message"}`. Pre-stream gate failures stay **JSON** `MaisterErrorBody` with their current HTTP status (401/403/404/409/422/503).
- **FR6** — The route drives ONE generator `.next()` (head) so a throw before the first `precondition` yield is a JSON error with HTTP status; only after the head yields does it commit to `text/event-stream` (mirror [scratch route](web/app/api/scratch-runs/route.ts:108-140)).
- **FR7** — `StudioAiTab.launch()` consumes the stream with `readLaunchStream<StudioAssistantLaunchResponse>`, surfaces each stage label while launching by reusing the **already-imported** scratch namespace — `tScratch(\`launchStage.${stage}\`)` ([studio-ai-tab.tsx:89](web/components/studio/studio-ai-tab.tsx:89); keys exist in en+ru) — calls `setRunId(event.runId)` on `session_ready` (switching to the conversation view → ScratchConversation mounts → live SSE + transcript + working badge), then reconciles the terminal `result`/`error`. A non-`text/event-stream` response is parsed as a JSON gate error (mirror [scratch-launcher.tsx:592](web/components/scratch/scratch-launcher.tsx:592)). Note: the `session_ready.dialogUrl` is **unused** by the studio client — the assistant stays docked in the editor (no `router.push`); only `runId` is consumed. Optional robustness (not a task): an `AbortController` on the launch `fetch` (parity with `scratch-launcher`) would let a true editor unmount cancel the launch → server compensation; low priority since the drawer toggles via `hidden` (stays mounted).
- **FR8** — The follow-up `messages` route and service are unchanged.

### 3.2 Pre-stream gate boundary (must stay JSON errors)

These run before the first `precondition` yield and surface as JSON with status:
`requireGlobalRole("member")` (401/403) · body parse (422 CONFIG) · `getLocalPackage` (404) · `assertHoldsLock` (409 CONFLICT) · runner resolution (CONFIG 422 / EXECUTOR_UNAVAILABLE 503) · `checkSupervisorHealth` (503) · `assertAssistantCapacityAvailable` (409 PRECONDITION). The route keeps the cheap `requireGlobalRole`/`getLocalPackage`/`assertHoldsLock` as synchronous gates (current behavior); the generator head re-runs its service-level gates (`requireActiveSession`, `loadActiveLocalPackage`, `assertHoldsLock`, runner, health, capacity) for direct callers — the existing double `assertHoldsLock` is preserved.

### 3.3 API contract (OpenAPI)

`docs/api/web.openapi.yaml` → `POST /api/studio/local-packages/{id}/assistant`:
- Replace the `202 application/json StudioAssistantLaunchResponse` success with `200 text/event-stream` carrying the staged frame union; document that the terminal `scratch.launch_result` frame wraps the **narrow** `StudioAssistantLaunchResponse` (`{ runId, dialogStatus, actionResult }`), which the route maps from the service's `ScratchRunResponse` (§3.1 FR5). Reuse the description shape from the scratch-runs POST ([web.openapi.yaml:3245-3277](docs/api/web.openapi.yaml:3245)), adjusting the stage order to `precondition → materializing(<adapter>) → spawning → session_ready` (no `worktree_created`).
- Keep `401/403/404/409/422/503` JSON gate responses (`MaisterErrorBody`). Update the operation summary to cite the ADR-110 staged-stream addendum.
- `StudioAssistantLaunchResponse` schema is **unchanged** — it is the `result` payload of the terminal frame (only the transport changes).

### 3.4 DB / migrations

**No migration.** The `runs` + `scratch_runs` rows are inserted before `createSession`/the turn ([service.ts:1518-1560](web/lib/scratch-runs/service.ts:1518)); `session_ready` is emitted after the existing status-update transaction. No schema change; `pnpm db:check`/journal untouched. This preserves the studio-ai-assistant.md "adds no migrations" invariant.

### 3.5 System-analytics docs

`docs/system-analytics/studio-ai-assistant.md` (surgical, R9):
- **Launch sequence diagram** ([lines 84-110](docs/system-analytics/studio-ai-assistant.md:84)): after `createSession` + status persist and **before** "send grounded prompt", add `Web-->>Editor: session_ready { runId }` and `Editor->>Web: subscribe run SSE (live transcript + working badge)`; the prompt turn then streams over that already-open SSE.
- Add a short **"Streaming launch contract"** subsection: `text/event-stream` staged frames, the pre-stream JSON gate boundary, and that `session_ready` is what unblocks the editor's live view + working badge on the first turn. Note the follow-up `messages` route is unchanged.
- Keep the "Deployment and persistence" no-migration note.
- `decisions.md`: **amend ADR-110** (no new ADR — owner: "незачем плодить") with a dated addendum: the assistant launch now streams staged progress (`session_ready` before the first turn) over `text/event-stream`, reusing the scratch FR-F1/F2 pattern; success contract is `200` event-stream, gate failures stay JSON; still no migration. Bump ADR-110's behavior without rewriting its original decision text.

### 3.6 Acceptance criteria (testable)

- **AC1** — `launchLocalPackageAssistantStaged` yields `session_ready` with non-empty `runId` **before** `sendPrompt`/`sendScratchPromptAndProjectEvents` is called (assert by recorded call/yield order).
- **AC2** — At `session_ready`, the `runs` row exists with `status="Running"`, `scratch_runs.dialogStatus="Running"`, and `run_sessions.acpSessionId` persisted (real-PG integration).
- **AC3** — Drain wrapper `launchLocalPackageAssistant` returns the same terminal `ScratchRunResponse` (runId, dialogStatus, actionResult); existing integration tests pass unchanged.
- **AC4** — Route success: `Content-Type: text/event-stream`; ordered `precondition → materializing → spawning → session_ready` frames then a `scratch.launch_result` frame wrapping the launch response.
- **AC5** — Pre-stream gate failures (lock CONFLICT 409, supervisor 503, capacity 409, 404) return JSON `MaisterErrorBody` with correct status and **not** an event-stream.
- **AC6** — Post-open turn failure emits `data:{"type":"error",...}` and the session is torn down + run marked `Crashed` (existing compensation).
- **AC7** — `StudioAiTab` sets `runId` and switches to the conversation view (ScratchConversation mounts ⇒ working badge available) on `session_ready`, before the terminal frame.
- **AC8** — No DB migration added; migrations dir + journal unchanged.
- **AC9** — `npx @redocly/cli lint docs/api/web.openapi.yaml` → zero errors; the assistant POST documents the event-stream success + JSON gate errors.
- **AC10** — `pnpm validate:docs` passes; the updated sequence diagram renders; ADR-110 carries the dated staged-stream addendum.
- **AC11** — the launching UI shows the current stage by reusing the existing scratch `launchStage.*` labels (no new i18n keys; en/ru parity already present); no `StudioAiTabLabels`/editor wiring added for stages.

### 3.7 Edge cases (each → test or explicit note)

- **Promptless launch** → `session_ready` then `WaitingForUser` result, no turn, no error frame. (FR3)
- **Client abort after `session_ready`** → server compensation (`deleteScratchSupervisorSessionIfLive` + `markScratchCrashed`) runs via the existing `catch`; no orphaned supervisor session. Mirror scratch `req.signal` propagation. (Assert via forced-throw path; true socket-abort is covered by the shared scratch mechanism.)
- **`session_ready` fires exactly once** — generator yields it once; `readLaunchStream`/client act only on the first. (Inherent.)
- **Materialization failure** (capability profile / authoring skill) occurs **after** the `precondition` yield and **before** the run insert ⇒ surfaces as an in-stream `error` frame with no run row and no session (no teardown needed, `createdSessionId` null). Confirm yield placement keeps this post-`precondition`.
- **Capacity TOCTOU** — the in-transaction `assertAssistantCapacityAvailableInTransaction` re-check ([service.ts:1519](web/lib/scratch-runs/service.ts:1519)) runs after the `precondition` yield; if it throws it becomes an `error` frame (acceptable; matches scratch). The pre-yield `assertAssistantCapacityAvailable` is the one that returns a JSON 409.

---

## 4. Implementation tasks (TDD)

> Each implementation task: write failing tests first (RED), implement minimally (GREEN), then refactor for SOLID/KISS/DRY and project conventions. Logging: preserve existing INFO launch fields (`localPackageId`, `runId`, `intent`, `runnerId`, `readOnlySession:true`); add a WARN `"studio assistant launch stream failed"` on post-open failure (mirror the scratch route).

### Phase 1 — Service: staged generator

- **T1 (RED)** ✅ — Add failing integration tests in `web/lib/scratch-runs/__tests__/local-package-assistant.integration.test.ts` (or a sibling `*-staged.integration.test.ts` reusing its harness/mocks): (a) `session_ready` carries `runId` and is yielded before `supervisorMock.sendPrompt` is called (record order); (b) at `session_ready` the run row is `Running` + `acpSessionId` persisted (real PG); (c) promptless → `session_ready` then `WaitingForUser`, `sendPrompt` never called; (d) drain wrapper returns the same terminal result as today.
- **T2 (GREEN)** ✅ — Refactor the body of `launchLocalPackageAssistant` into `export async function* launchLocalPackageAssistantStaged(...)` yielding `launchProgress(...)` at the four boundaries (§3.1 FR2); keep `launchLocalPackageAssistant` as a thin drain wrapper (loop `gen.next()`, return final value) exactly like `launchScratchRun`. No logic/order change other than inserted yields. Blocked by T1.

### Phase 2 — Route: streaming response

- **T3 (RED)** ✅ — Add `web/app/api/studio/local-packages/[id]/assistant/__tests__/route.test.ts`: success → `text/event-stream` with ordered frames + `scratch.launch_result`; gate failures (lock conflict 409, supervisor 503, 404) → JSON `MaisterErrorBody` with status, not a stream; post-open turn failure → `error` frame. Mock the service generator.
- **T4 (GREEN)** ✅ — Rewrite `POST` in `web/app/api/studio/local-packages/[id]/assistant/route.ts`: keep sync gates (`requireGlobalRole`, body parse, `getLocalPackage`, `assertHoldsLock`) → drive the generator head (`gen.next()`, JSON error on throw) → stream via `formatLaunchProgressFrame`/`formatLaunchResultFrame`/`formatLaunchErrorFrame` inside a `ReadableStream` with the scratch headers (`text/event-stream`, `no-cache`, `X-Accel-Buffering:no`). **Map the generator's final `ScratchRunResponse` → the narrow `StudioAssistantLaunchResponse` (`{ runId, dialogStatus: r.status.dialogStatus, actionResult: r.actionResult ?? null }`) before `formatLaunchResultFrame`** so the response shape and OpenAPI schema stay unchanged. Preserve the existing INFO log on result; WARN on stream failure. Blocked by T2, T3.

### Phase 3 — Client: stream consumption

- **T5 (RED)** ✅ — DOM gate test `web/components/studio/__tests__/studio-ai-tab.test.tsx`: with a mocked streaming `fetch`, `launch()` shows the stage label while launching, sets `runId` on `session_ready`, and renders the conversation view (`data-testid="studio-ai-tab"` conversation branch / ScratchConversation) before the terminal frame; a non-stream JSON error response sets the error banner without setting `runId`. **Also write** (do not run locally — single-`next dev` lock) a Playwright e2e case extending `web/e2e/studio-ai-assistant.spec.ts` asserting the first prompt streams (stage/badge visible before the final answer) — added to the authed spec set for CI.
- **T6 (GREEN)** ✅ — Update `StudioAiTab.launch()`: `fetch` → content-type check (non-stream ⇒ `readApiError` JSON path) → `readLaunchStream<StudioAssistantLaunchResponse>` → `setLaunchStage(stage)` per frame, rendering the label via the already-imported `tScratch(\`launchStage.${stage}\`)` (no new i18n keys, no `StudioAiTabLabels`/editor wiring) → `setRunId` on `session_ready` → reconcile terminal `result`/`error`. Blocked by T4, T5.

### Phase 4 — Contracts & docs (SDD)

- **T7** ✅ — Update `docs/api/web.openapi.yaml` assistant POST per §3.3 (summary cites the ADR-110 staged-stream addendum); run `npx @redocly/cli lint docs/api/web.openapi.yaml` (zero errors).
- **T8** ✅ — Update `docs/system-analytics/studio-ai-assistant.md` per §3.5 (sequence diagram + "Streaming launch contract" subsection); run `pnpm validate:docs`.
- **T9** ✅ — **Amend ADR-110** in `docs/decisions.md` with a dated `Amendment (2026-06-29)` addendum (assistant launch staged-stream: `session_ready` before first turn, `200` event-stream success, JSON gate errors, no migration; cite scratch FR-F1/F2). Do not rewrite the original decision text and do not create a new ADR.

### Phase 5 — Verify

- **T10** ✅ — Full gate sweep: `pnpm --filter maister-web typecheck` (tsc 0), `pnpm --filter maister-web lint` (eslint 0), vitest unit + the assistant integration suite (real PG), `npx @redocly/cli lint`, `pnpm validate:docs`, i18n en/ru parity. Manual smoke on `:3000` if the dev port is free: first prompt now streams incrementally and the working badge appears right after session start (single-`next dev` lock caveat).

## 5. Commit plan

- **Checkpoint 1** (after Phase 1): `refactor(studio): stage local-package assistant launch into a generator`
- **Checkpoint 2** (after Phase 2): `feat(studio): stream staged progress from the assistant launch route`
- **Checkpoint 3** (after Phase 3): `feat(studio): consume the assistant launch stream (runId on session_ready)`
- **Checkpoint 4** (after Phase 4): `docs(studio): ADR-110 addendum + OpenAPI + system-analytics for streamed assistant launch`
- Final (after Phase 5): fold verification fixes into the nearest checkpoint; no separate report commit.

## 6. Out of scope

- Making `sendScratchPromptAndProjectEvents` itself non-blocking, or background-detaching the turn (the stream-while-blocking pattern is sufficient and matches scratch).
- Any change to the follow-up `messages` route/service.
- New launch stages or a forked progress protocol.
- Migrating the assistant off scratch-run substrate.
