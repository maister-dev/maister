[← Database Schema](database-schema.md) · [Back to README](../README.md) · [Configuration →](configuration.md)

# Error Taxonomy

`MaisterError extends Error` with a discriminated `code` field. UI branches
on `code`, never on string matching. Source: `web/lib/errors.ts`.

```ts
import { MaisterError, isMaisterError } from "@/lib/errors";

throw new MaisterError("CONFIG", "DB_URL env is required");
```

## Why a typed taxonomy

- **UI rendering.** Components switch on `code` to pick the right action
  ("Recover" for `CRASH`, "Resolve manually" for a local promotion
  `CONFLICT`, "Reset config" for `CONFIG`).
- **Observability.** Codes are stable identifiers that survive message
  rewrites; logs and metrics can group by them.
- **Discipline.** No string-matching on `err.message` anywhere. If a new
  failure mode emerges, extend the union — do not invent a new ad-hoc
  `Error` class.

## Codes

Sixteen codes (M8 added `STEP_CHECKPOINTED`; M9 added `UNAUTHENTICATED`,
`UNAUTHORIZED`, `PASSWORD_CHANGE_REQUIRED`, and `ACCOUNT_INACTIVE`), all
defined as a string union in `web/lib/errors.ts`.

| Code | Meaning | Where thrown | UI action |
| ---- | ------- | ------------ | --------- |
| `PRECONDITION` | A precondition for an action is not met (dirty repo, base branch missing, prompt empty, branch taken, worktree path occupied, global concurrency cap hit; or repo onboarding (ADR-025): `git clone` failed, target directory missing, or the clone `target` path already exists). Also (M11c, ADR-032): a `Running` node exceeded its declared `limits.maxDurationMinutes` and was terminated by the web-side time-limit watchdog — a declared-limit-exceeded policy kill, NOT a `HITL_TIMEOUT`. | `POST /api/runs` validation before spawn; scratch launch/message/diff gates; `POST /api/projects` source resolution (clone / existing-local — `resolveProjectSource`); `keepalive-sweeper` time-limit pass (`runTimeLimitPass`). Also (M19, Designed) the reconcile classifier (ADR-033) records the crash reason on a `Running → Crashed` transition (`worktree-gone`, `agent-session-gone`, `cli-not-retry-safe`); the reason is observability, not a thrown 4xx from a route. | Show the specific blocker, link to fix. For an M11c duration-cap kill: the run is `Failed` with the node attempt recording `errorCode = PRECONDITION`. |
| `SPAWN` | Subprocess could not be launched (binary not on PATH, exec perm denied, OOM). | `supervisor/` when spawning `claude-agent-acp` or `codex-acp`. | "Executor failed to start" with stderr tail. |
| `NEEDS_INPUT` | The run paused for human input (ACP `session/request_permission`, scratch dialog permission card, or `needs-input.json` artifact). | Supervisor on ACP notification or artifact appearance; scratch event projection persists the permission card and sets `scratch_runs.dialog_status = NeedsInput`. | Render HITL form / approve-deny prompt. |
| `HITL_TIMEOUT` | Supervisor's pending-permission deferred expired (M7) — typically `MAISTER_KEEPALIVE_MINUTES` elapsed without a `/respond` ack. **NOT** raised for the `NeedsInputIdle → Abandoned` transition (M8) — that is a sweeper-driven state flip with no error surface, NOT a `HITL_TIMEOUT`. | Supervisor `POST /sessions/:id/input`, web `/respond` HITL_TIMEOUT branch, including scratch permission responses that reuse the same endpoint. | Flow run → `Failed`; scratch run → `Crashed` with `scratch_runs.error_code = HITL_TIMEOUT`; respond returns 410 terminal. |
| `CRASH` | Worker died mid-`Running` without a graceful checkpoint, or scratch dialog event projection could not persist a permission safely. | Supervisor heartbeat watcher; startup reconcile; scratch recovery/reconciliation. | "Recover or discard" panel; the server reuses the stored ACP resume handle without exposing it to the browser. |
| `CONFLICT` | Local promotion could not auto-merge the run branch into the selected target branch, a scratch branch/worktree already exists, a scratch prompt is already running, or scratch launch capacity is full. Also (M19, Designed): a `POST /api/runs/{runId}/recover` whose Phase-1 CAS `WHERE status='Crashed'` lost — the run is not `Crashed` or a concurrent Recover already flipped it `Running`/`Pending` (409); a `POST /api/runs/{runId}/discard` against a conflicting non-terminal state that is not discardable (409). | `POST /api/runs/[id]/promote` when `promotion.mode = local_merge`; scratch launch/message/discard state gates; `POST /api/runs/{runId}/recover` and `POST /api/runs/{runId}/discard` state gates (M19). | "Resolve manually" with parent repo path, run branch, target branch, and failing command; for scratch capacity or prompt conflicts, keep the dialog/launcher retryable. For recover/discard 409, refresh the run row — another action already moved its state. |
| `CONFIG` | A config file, env var, route body, or capability selection is missing or malformed (`maister.yaml`, `flow.yaml`, `form_schema`, `DB_URL`, unknown scratch MCP/skill/rule id, cross-project executor/task id). Also (M11c, ADR-032): an `ai_coding`/`judge` node declares `enforcement: strict` on a capability class the build cannot strictly enforce for ANY agent (with the M11c all-`instructed` `ENFORCEABILITY_BY_AGENT` table, every `strict` class today) — internal over-declaration. | `lib/config.ts` validators; `lib/db/client.ts`; scratch route body and capability validators; `web/app/api/runs/route.ts` launch precondition + `web/lib/flows/graph/runner-graph.ts` per-node runtime gate (thrown by `assertNodeLaunchable` in `web/lib/flows/enforcement.ts`, before any ACP session / permission deferred is created). | Show the offending field path; refuse to start. For an M11c strict-enforcement refusal (HTTP 400, the existing `CONFIG` status mapping), name the node id + class + resolved agent; no worktree/run is created. |
| `EXECUTOR_UNAVAILABLE` | The executor named in run launcher / project override / Flow recommendation / scratch launcher is not registered for this project, or the supervisor readiness check failed before launch side effects. Also: supervisor 5xx during M8 keep-alive sweeper checkpoint, supervisor 5xx / network failure during M8 resume from the HITL respond idle branch, or scratch prompt delivery failure after the message is durably stored. Both M8 callers treat the code as retryable — sweeper re-attempts on next tick, respond returns 503 `{terminal:false}` to the operator. Scratch message send keeps the dialog retryable. Also (M11c, ADR-032): an `ai_coding`/`judge` node declares `enforcement: strict` on a capability class that IS `enforced` for some agent but `unsupported`/`instructed` for the resolved executor's agent (unreachable with the M11c all-`instructed` table; reachable once M14 flips cells). Also (M19, Designed): a transient supervisor failure (5xx / network / timeout) during the `POST /api/runs/{runId}/recover` Phase-2 `createSession({resumeSessionId})` — the run is LEFT `Running` (no rollback; an ack may have been lost), 503 returned, the reconciler re-attaches or re-crashes past grace; retryable. | `POST /api/runs` executor resolution and `GET /health` preflight; `POST /api/scratch-runs` readiness/executor gates and `POST /api/scratch-runs/{runId}/messages`; `keepalive-sweeper` Pass 1; `resumeRun` from `/respond` idle branch; `POST /api/runs/{runId}/recover` supervisor `createSession` side-effect (M19); `web/app/api/runs/route.ts` launch precondition + `web/lib/flows/graph/runner-graph.ts` per-node runtime gate (thrown by `assertNodeLaunchable` in `web/lib/flows/enforcement.ts`, before any ACP session / permission deferred is created). | Disable launch while supervisor is unavailable; show "start/recover supervisor" guidance. "Pick a different executor" when the project executor is missing; silently retry next tick (sweeper); 503 `{terminal:false}` to operator (respond); keep scratch dialog input retryable when prompt delivery failed. For an M11c wrong-agent strict-enforcement refusal (HTTP 503), name the node id + class + resolved agent and suggest an executor whose agent enforces the class. For an M19 recover 503, keep the Recover action retryable — the run is still `Running`. |
| `FLOW_INSTALL` | A Flow package install/upgrade failed at any stage: clone, resolve-revision, validate-manifest, or finalize. M10 (ADR-021) carries structured detail in the message — `{source, version, stage, command, exitStatus, output}` — and the two-phase install marks the `flow_revisions` row `Failed` (never left `Installing`). | Project registration (`POST /api/projects`); Flow loader; `flow-packages` install/upgrade routes (HTTP 502). | Show the failing source URL + tag + stage, link to the manifest/command error. |
| `ACP_PROTOCOL` | Supervisor received an ACP message it cannot decode, or saw an unexpected state transition. | Supervisor ACP client. | "Executor sent an unexpected message" with the raw payload. |
| `CHECKPOINT` | Terminal resume failure (M8). Supervisor 400 (spawn refused), 201 with empty `acpSessionId`, or 404 (unknown checkpoint) during `resumeRun` from the `/respond` idle branch. Also raised when `checkpointSession()` receives a malformed 200 response body. Also (M19, Designed): `POST /api/runs/{runId}/recover` against an unresumable acp session — the supervisor refuses the `--resume` — returns 410; the run stays `Crashed` and the UI offers discard-only. | Web `resumeRun`; web `supervisor-client.checkpointSession`; `POST /api/runs/{runId}/recover` resume side-effect (M19). | Run → `Failed` via `failResumedRun`; respond returns 410 `{terminal:true}`; UI surfaces "this run can't be resumed". For an M19 recover 410, surface discard-only (the run remains `Crashed`). |
| `STEP_CHECKPOINTED` | Step paused mid-permission by a supervisor checkpoint (M8 Codex review fix #1). The runner-agent observed `session.exited.reason === "checkpoint"` on the SSE stream and called `markCheckpointedFromExit`, transitioning the run to `NeedsInputIdle`. This is NOT a failure — the cancelled permission is journaled for replay on the next `--resume`. Distinct from `CHECKPOINT` (terminal resume failure). | Web `runner-agent` in both `new-session` and `slash-in-existing` modes. | Run is in `NeedsInputIdle`; UI surfaces the same Inbox panel as keepalive-driven idle. Step is replayed by the resume-driver on operator response. |
| `UNAUTHENTICATED` | No valid session — request arrived without a cookie or with an expired/invalid session token. Maps to **HTTP 401**. | `lib/authz.ts:requireSession()`. Also thrown by `requireGlobalRole()` and `requireProjectRole()` when no session exists. | Redirect to sign-in page. Never show partial data. |
| `UNAUTHORIZED` | Session is valid but the caller's role (global or project) is below the required minimum. Maps to **HTTP 403**. | `lib/authz.ts:requireGlobalRole()`, `requireProjectRole()`, `requireProjectAction()`. | Show "Access denied" with the required role; do not expose the project/resource name to the caller. |
| `PASSWORD_CHANGE_REQUIRED` | Session is valid but the account still has `users.must_change_password = true` (seeded admin / admin-forced reset). Maps to **HTTP 403**. Fails closed on every role-gated API. | `lib/authz.ts:requireActiveSession()` (called by `requireGlobalRole()` / `requireProjectRole()`). `requireSession()` / `getSessionUser()` stay permissive so the change-password flow itself works. | Route the user to `/change-password`; block all other actions until cleared. |
| `ACCOUNT_INACTIVE` | Session is valid but `users.account_status != 'active'` (pending approval or disabled after an old session was issued). Maps to **HTTP 403**. Credentials sign-in also rejects pending/disabled accounts before session creation. | `lib/authz.ts:requireActiveSession()`; credentials preflight in `web/app/(auth)/actions.ts` and provider verification in `web/auth.ts`. | Show pending-approval or disabled-account guidance; block protected app/API actions until an admin activates or re-enables the account. |

## Construction

```ts
new MaisterError(code, message)
new MaisterError(code, message, { cause: originalError })
```

`cause` is the standard `ErrorOptions` shape; it survives JSON
serialization across the SSE bridge so the UI can show the underlying
error too. `name` is always `"MaisterError"` and `stack` is preserved.

## Detection

Use the `isMaisterError` type guard everywhere:

```ts
try {
  await loadProjectConfig(path);
} catch (err) {
  if (isMaisterError(err) && err.code === "CONFIG") {
    return res.status(400).json({ error: "BAD_CONFIG", detail: err.message });
  }
  throw err;
}
```

Plain `err instanceof MaisterError` works too, but the type guard makes
the discriminated `code` field available on the narrowed branch.

## What NOT to do

- ❌ `throw new Error("DB_URL is required")` — use `MaisterError("CONFIG", …)`.
- ❌ `if (err.message.includes("conflict")) { … }` — switch on `err.code === "CONFLICT"` instead.
- ❌ Wrapping a third-party error to "look typed" without picking a real code. If a new failure mode is real, extend the union; if it isn't, let the underlying error propagate.
- ❌ Throwing a `MaisterError` for an _impossible_ scenario. Validate at system boundaries (user input, external APIs, subprocess exits, file reads). Trust internal invariants.

## Adding a new code

1. Add the string to the `MaisterErrorCode` union in `web/lib/errors.ts`.
2. Update this page with the new row + UI action.
3. Update `web/lib/errors.test.ts` exhaustiveness assertion (the
   `satisfies readonly MaisterErrorCode[]` const array must include it).
4. Update every `switch` / `if/else` that branches on `code`.

The `satisfies` assertion in the test prevents the test from silently
ignoring a newly added code.

## See Also

- [Database Schema](database-schema.md) — `runs.status` enum the UI
  surfaces alongside error codes
- [Configuration](configuration.md) — `CONFIG` is thrown on every
  malformed `maister.yaml` / `flow.yaml` / `form_schema`
