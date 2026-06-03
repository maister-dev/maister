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
| `PRECONDITION` | A precondition for an action is not met (dirty repo, base branch missing, prompt empty, branch taken, worktree path occupied, global concurrency cap hit; or repo onboarding (ADR-025): `git clone` failed, target directory missing, or the clone `target` path already exists). Also (M11c, ADR-032): a `Running` node exceeded its declared `limits.maxDurationMinutes` and was terminated by the web-side time-limit watchdog — a declared-limit-exceeded policy kill, NOT a `HITL_TIMEOUT`. Also (M12, declared-artifact contract): a node's required INPUT artifact (`input.requires`) is missing or stale → the node is set `Failed` **BEFORE** its action runs; a node's required OUTPUT artifact (`output.produces`) is missing → the node is set `Failed` **BEFORE** it finishes. M12 **reuses** this existing code — it adds NO new `MaisterError` code. Also (M18, Designed — promote-time gates, ADR-048/049): a PR-mode preflight fails (provider CLI `gh`/`glab` missing on the web-host PATH, or `GITEA_TOKEN`/`GITVERSE_TOKEN` unset for the gitea-family REST adapter, or the git remote is not configured, or push was rejected for a config reason); the run's `generic` provider does not support PR mode; the target branch is invalid or missing; the target branch advanced since the ReviewPanel rendered (target-drift, no `allowTargetDrift` override — Codex F6); readiness is not ready or stale at promote time (the second `assertEvidenceReady(runId,"review")` re-gate); or a pre-M18 legacy run lacks the branch metadata needed to promote and no fallback can be derived (Codex F4). All map to **HTTP 409**. M18 **reuses** this existing code — it adds NO new `MaisterError` code. | `POST /api/runs` validation before spawn; scratch launch/message/diff gates; `POST /api/projects` source resolution (clone / existing-local — `resolveProjectSource`); `keepalive-sweeper` time-limit pass (`runTimeLimitPass`); M12 runner-graph per-node artifact precheck (input gate before action, output gate before finish); the shared `promoteRun` service (M18) — claim-tx readiness/target-drift/target-validity guards and PR-mode preflight before any side-effect. Also (M19, Designed) the reconcile classifier (ADR-033) records the crash reason on a `Running → Crashed` transition (`worktree-gone`, `agent-session-gone`, `cli-not-retry-safe`); the reason is observability, not a thrown 4xx from a route. | Show the specific blocker, link to fix. For an M11c duration-cap kill: the run is `Failed` with the node attempt recording `errorCode = PRECONDITION`. For an M12 required-artifact miss: the run is `Failed` with the node attempt recording `errorCode = PRECONDITION` and naming the missing/stale artifact id. For an M18 promote refusal the run stays `Review` (no claim taken) — surface the specific blocker (PR-mode prereq, invalid target, target-drift "re-review or override", readiness-not-ready, or "relaunch to promote" for a legacy run) and keep Promote retryable. |
| `SPAWN` | Subprocess could not be launched (binary not on PATH, exec perm denied, OOM). | `supervisor/` when spawning `claude-agent-acp` or `codex-acp`. | "Executor failed to start" with stderr tail. |
| `NEEDS_INPUT` | The run paused for human input (ACP `session/request_permission`, scratch dialog permission card, or `needs-input.json` artifact). | Supervisor on ACP notification or artifact appearance; scratch event projection persists the permission card and sets `scratch_runs.dialog_status = NeedsInput`. | Render HITL form / approve-deny prompt. |
| `HITL_TIMEOUT` | Supervisor's pending-permission deferred expired (M7) — typically `MAISTER_KEEPALIVE_MINUTES` elapsed without a `/respond` ack. **NOT** raised for the `NeedsInputIdle → Abandoned` transition (M8) — that is a sweeper-driven state flip with no error surface, NOT a `HITL_TIMEOUT`. | Supervisor `POST /sessions/:id/input`, web `/respond` HITL_TIMEOUT branch, including scratch permission responses that reuse the same endpoint. | Flow run → `Failed`; scratch run → `Crashed` with `scratch_runs.error_code = HITL_TIMEOUT`; respond returns 410 terminal. |
| `CRASH` | Worker died mid-`Running` without a graceful checkpoint, or scratch dialog event projection could not persist a permission safely. | Supervisor heartbeat watcher; startup reconcile; scratch recovery/reconciliation. | "Recover or discard" panel; the server reuses the stored ACP resume handle without exposing it to the browser. |
| `CONFLICT` | Local promotion could not auto-merge the run branch into the selected target branch, a scratch branch/worktree already exists, a scratch prompt is already running, or scratch launch capacity is full. Also (M19, Designed): a `POST /api/runs/{runId}/recover` whose Phase-1 CAS `WHERE status='Crashed'` lost — the run is not `Crashed` or a concurrent Recover already flipped it `Running`/`Pending` (409); a `POST /api/runs/{runId}/discard` against a conflicting non-terminal state that is not discardable (409). Also (M18, Designed — flow-run promotion): a concurrent promote lost the durable-claim CAS (a fresh `claiming` is already present), or a slow promote's finalize was superseded by a same-user stale-claim reclaim that re-minted `promotion_attempt_id` (the superseded attempt writes nothing — Codex F5). Both map to **HTTP 409**. | `POST /api/runs/[id]/promote` when `promotion.mode = local_merge`; scratch launch/message/discard state gates; `POST /api/runs/{runId}/recover` and `POST /api/runs/{runId}/discard` state gates (M19); the shared `promoteRun` service durable-claim CAS + finalize attempt-token guard for flow **and** scratch runs (M18, §3.2 of the M18 plan). | "Resolve manually" with parent repo path, run branch, target branch, and failing command; for scratch capacity or prompt conflicts, keep the dialog/launcher retryable. For recover/discard 409, refresh the run row — another action already moved its state. For an M18 concurrent/superseded promote 409, the in-flight (or reclaiming) attempt owns finalization — refresh and wait, do not re-fire. |
| `CONFIG` | A config file, env var, route body, or capability selection is missing or malformed (`maister.yaml`, `flow.yaml`, `form_schema`, `DB_URL`, unknown scratch MCP/skill/rule id, cross-project executor/task id). Also (M11c, ADR-032): an `ai_coding`/`judge` node declares `enforcement: strict` on a capability class the build cannot strictly enforce for ANY agent (with the M11c all-`instructed` `ENFORCEABILITY_BY_AGENT` table, every `strict` class today) — internal over-declaration. Also (M12, declared-artifact contract): manifest artifact violations rejected at load/validate time — duplicate `output.produces[].id` within a manifest, an `input.requires` ref to an unknown artifact id, an `input.requires` object whose declared `kind` mismatches the produced artifact's `kind`, an unsupported artifact `kind`, an invalid `path`/`ref`, or an `artifact_required` gate whose `inputArtifacts` reference unknown artifact ids. M12 **reuses** this existing code — it adds NO new `MaisterError` code. | `lib/config.ts` validators; `lib/db/client.ts`; scratch route body and capability validators; `web/app/api/runs/route.ts` launch precondition + `web/lib/flows/graph/runner-graph.ts` per-node runtime gate (thrown by `assertNodeLaunchable` in `web/lib/flows/enforcement.ts`, before any ACP session / permission deferred is created); M12 manifest artifact validation in `loadFlowManifest` / `validateGraphManifest`. | Show the offending field path; refuse to start. For an M11c strict-enforcement refusal (HTTP 400, the existing `CONFIG` status mapping), name the node id + class + resolved agent; no worktree/run is created. For an M12 manifest artifact violation, name the offending artifact id / ref / kind / path; the Flow does not enable. |
| `EXECUTOR_UNAVAILABLE` | The executor named in run launcher / project override / Flow recommendation / scratch launcher is not registered for this project, or the supervisor readiness check failed before launch side effects. Also: supervisor 5xx during M8 keep-alive sweeper checkpoint, supervisor 5xx / network failure during M8 resume from the HITL respond idle branch, or scratch prompt delivery failure after the message is durably stored. Both M8 callers treat the code as retryable — sweeper re-attempts on next tick, respond returns 503 `{terminal:false}` to the operator. Scratch message send keeps the dialog retryable. Also (M11c, ADR-032): an `ai_coding`/`judge` node declares `enforcement: strict` on a capability class that IS `enforced` for some agent but `unsupported`/`instructed` for the resolved executor's agent (unreachable with the M11c all-`instructed` table; reachable once M14 flips cells). Also (M19, Designed): a transient supervisor failure (5xx / network / timeout) during the `POST /api/runs/{runId}/recover` Phase-2 `createSession({resumeSessionId})` — the run is LEFT `Running` (no rollback; an ack may have been lost), 503 returned, the reconciler re-attaches or re-crashes past grace; retryable. Also (M18, Designed — PR-mode transient failure, ADR-049, Codex F7): a `pull_request` promote whose `git push` is transiently rejected or whose provider PR API returns a 5xx — a **retryable** side-effect failure (distinct from the config-class PR preconditions, which are `PRECONDITION`/409). The run stays `Review` with **no `pr_url`** stored; the promote is idempotent on retry. Maps to **HTTP 503**. M18 **reuses** this existing closed-union member — it adds NO new `MaisterError` code; Phase 3 adds the `EXECUTOR_UNAVAILABLE → 503` case to the promote route's `httpStatusForCode` (the mapping is code-only, so `PRECONDITION` can map ONLY to 409 — a retryable status needs this distinct retryable code, which is already a union member). | `POST /api/runs` executor resolution and `GET /health` preflight; `POST /api/scratch-runs` readiness/executor gates and `POST /api/scratch-runs/{runId}/messages`; `keepalive-sweeper` Pass 1; `resumeRun` from `/respond` idle branch; `POST /api/runs/{runId}/recover` supervisor `createSession` side-effect (M19); the shared `promoteRun` PR side-effect (`pushBranch` / `PrAdapter.createOrUpdatePr`) for transient push/PR-API 5xx failures (M18); `web/app/api/runs/route.ts` launch precondition + `web/lib/flows/graph/runner-graph.ts` per-node runtime gate (thrown by `assertNodeLaunchable` in `web/lib/flows/enforcement.ts`, before any ACP session / permission deferred is created). | Disable launch while supervisor is unavailable; show "start/recover supervisor" guidance. "Pick a different executor" when the project executor is missing; silently retry next tick (sweeper); 503 `{terminal:false}` to operator (respond); keep scratch dialog input retryable when prompt delivery failed. For an M11c wrong-agent strict-enforcement refusal (HTTP 503), name the node id + class + resolved agent and suggest an executor whose agent enforces the class. For an M19 recover 503, keep the Recover action retryable — the run is still `Running`. For an M18 PR-mode 503, keep the Promote action retryable — the run is still `Review`, no PR was recorded, and a retry resumes idempotently. |
| `FLOW_INSTALL` | A Flow package install/upgrade failed at any stage: clone, resolve-revision, validate-manifest, or finalize. M10 (ADR-021) carries structured detail in the message — `{source, version, stage, command, exitStatus, output}` — and the two-phase install marks the `flow_revisions` row `Failed` (never left `Installing`). | Project registration (`POST /api/projects`); Flow loader; `flow-packages` install/upgrade routes (HTTP 502). | Show the failing source URL + tag + stage, link to the manifest/command error. |
| `ACP_PROTOCOL` | Supervisor received an ACP message it cannot decode, or saw an unexpected state transition. | Supervisor ACP client. | "Executor sent an unexpected message" with the raw payload. |
| `CHECKPOINT` | Terminal resume failure (M8). Supervisor 400 (spawn refused), 201 with empty `acpSessionId`, or 404 (unknown checkpoint) during `resumeRun` from the `/respond` idle branch. Also raised when `checkpointSession()` receives a malformed 200 response body. Also (M19, Designed): `POST /api/runs/{runId}/recover` against an unresumable acp session — the supervisor refuses the `--resume` — returns 410; the run stays `Crashed` and the UI offers discard-only. | Web `resumeRun`; web `supervisor-client.checkpointSession`; `POST /api/runs/{runId}/recover` resume side-effect (M19). | Run → `Failed` via `failResumedRun`; respond returns 410 `{terminal:true}`; UI surfaces "this run can't be resumed". For an M19 recover 410, surface discard-only (the run remains `Crashed`). |
| `STEP_CHECKPOINTED` | Step paused mid-permission by a supervisor checkpoint (M8 Codex review fix #1). The runner-agent observed `session.exited.reason === "checkpoint"` on the SSE stream and called `markCheckpointedFromExit`, transitioning the run to `NeedsInputIdle`. This is NOT a failure — the cancelled permission is journaled for replay on the next `--resume`. Distinct from `CHECKPOINT` (terminal resume failure). | Web `runner-agent` in both `new-session` and `slash-in-existing` modes. | Run is in `NeedsInputIdle`; UI surfaces the same Inbox panel as keepalive-driven idle. Step is replayed by the resume-driver on operator response. |
| `UNAUTHENTICATED` | No valid session — request arrived without a cookie or with an expired/invalid session token. Maps to **HTTP 401**. | `lib/authz.ts:requireSession()`. Also thrown by `requireGlobalRole()` and `requireProjectRole()` when no session exists. | Redirect to sign-in page. Never show partial data. |
| `UNAUTHORIZED` | Session is valid but the caller's role (global or project) is below the required minimum. Maps to **HTTP 403**. | `lib/authz.ts:requireGlobalRole()`, `requireProjectRole()`, `requireProjectAction()`. | Show "Access denied" with the required role; do not expose the project/resource name to the caller. |
| `PASSWORD_CHANGE_REQUIRED` | Session is valid but the account still has `users.must_change_password = true` (seeded admin / admin-forced reset). Maps to **HTTP 403**. Fails closed on every role-gated API. | `lib/authz.ts:requireActiveSession()` (called by `requireGlobalRole()` / `requireProjectRole()`). `requireSession()` / `getSessionUser()` stay permissive so the change-password flow itself works. | Route the user to `/change-password`; block all other actions until cleared. |
| `ACCOUNT_INACTIVE` | Session is valid but `users.account_status != 'active'` (pending approval or disabled after an old session was issued). Maps to **HTTP 403**. Credentials sign-in also rejects pending/disabled accounts before session creation. | `lib/authz.ts:requireActiveSession()`; credentials preflight in `web/app/(auth)/actions.ts` and provider verification in `web/auth.ts`. | Show pending-approval or disabled-account guidance; block protected app/API actions until an admin activates or re-enables the account. |

> **M12 adds NO new `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union). Beyond the `CONFIG` / `PRECONDITION` reuses above, two M12 outcomes have **no thrown code at all**: an unsatisfied `artifact_required` gate records `gate_results.status = "failed"` (the gate-result lifecycle, not an exception); a `human_review` refusal driven by a failed blocking gate is a blocking gate failure (no HTTP code). Neither maps to an HTTP status.

> **M14 adds NO new `MaisterError` code** (ADR-008 closed union). M14 reuses
> three existing codes at new call sites (all Designed, M14, Phase 0 spec):
>
> **`CONFIG` new call sites (M14, Designed):**
> - **Unknown/unsupported capability ref at validate or launch** — `loadProjectConfig()`
>   (carve-b: `validateNodeSettings` rejects any `settings.mcps[]`, `skills[]`,
>   `restrictions[]`, `settingsProfile`, or `tools` ref not present in the project
>   `capability_records`, or present but with `agents` not including the selected
>   executor agent). HTTP 400 from both the project-register and run-launch paths.
>   Names the offending node id + ref + capability kind in the message.
> - **Long-living session profile-digest mismatch** — runner rejects reuse of an
>   existing ACP session when `materialization_plan.profileDigest` of the new node
>   differs from the session's recorded digest and no session boundary is declared.
>   HTTP 400 from the graph runner before `spawnSession`. Names both digests.
>
> **`EXECUTOR_UNAVAILABLE` new call site (M14, Designed):**
> - **Newly reachable once a `claude` cell flips to `enforced`** — when a node
>   declares `enforcement: strict` on a capability class that IS `enforced` for
>   `claude` but the resolved executor uses `codex` (which stays `instructed`), the
>   launch gate throws `MaisterError("EXECUTOR_UNAVAILABLE")` (HTTP 503) per the
>   existing `assertNodeLaunchable` code path. This path was unreachable with the
>   M11c all-`instructed` table; it becomes reachable as Phase 5 flips cells. Names
>   the node id + class + resolved agent + suggests an executor whose agent enforces
>   the class.
>
> **`FLOW_INSTALL` new call sites (M14, Designed):**
> - **Capability import path-safety failure** — `installCapabilityRevision` calls
>   `assertFieldSafe` (the same guard used by `web/lib/flow-paths.ts:77`) on the
>   import `id` and `version` inside the path builder. A traversal value (`../evil`,
>   `..`, `a/b`) throws `MaisterError("FLOW_INSTALL")` and writes nothing to disk or
>   the DB. Surfaces as HTTP 502 from the registration route.
> - **Capability import clone failure** — `git clone --branch <version>` fails (not
>   found, network error, auth). Throws `MaisterError("FLOW_INSTALL")` with the
>   structured detail `{source, version, stage:'clone', exitStatus, output}`.
>   Surfaces as HTTP 502; registration compensates (removes the project row) as with
>   Flow plugin install failures.
> - **Trust-route setup-execution failure** — `runCapabilityRevisionSetup` executes
>   `setup.sh` after trust is granted; the script exits non-zero. Throws
>   `MaisterError("FLOW_INSTALL")` with structured detail
>   `{source, version, stage:'setup', exitStatus, output}`. Surfaces as **HTTP 502**
>   from `POST /api/projects/{slug}/capabilities/{capabilityRefId}/trust`. Sets
>   `setupStatus = 'failed'`; `trustStatus` remains `'trusted'` so a re-POST retries
>   setup without a spurious 409. NOT `EXECUTOR_UNAVAILABLE` — capability setup is a
>   package install operation, not a supervisor/executor availability failure.

> **M18 adds NO new `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror)
> closed union; ADR-048/049). Flow-run promotion and `pull_request` mode reuse three
> existing codes at new `promoteRun` call sites (all Designed, M18, Phase 0 spec —
> finalized to Implemented when the code lands):
>
> - **`PRECONDITION` → HTTP 409** — promote-time config/precondition refusals: PR-mode
>   preflight (provider CLI `gh`/`glab` missing on PATH; `GITEA_TOKEN`/`GITVERSE_TOKEN`
>   unset for the gitea-family REST adapter; remote not configured; push rejected for a
>   config reason; `generic` provider unsupported); target branch invalid/missing;
>   target-drift (target advanced since the ReviewPanel rendered, no `allowTargetDrift`
>   override — Codex F6); readiness not-ready/stale (the second `assertEvidenceReady`
>   re-gate); a pre-M18 legacy run lacking derivable branch metadata (Codex F4). The run
>   stays `Review`; no durable claim is taken.
> - **`CONFLICT` → HTTP 409** — `local_merge` merge conflict (`createMergeConflictAssignment`,
>   run stays `Review`); a concurrent promote that lost the durable-claim CAS (a fresh
>   `claiming` is already present); a slow promote whose finalize is superseded by a
>   same-user stale-claim reclaim that re-minted `promotion_attempt_id` (the superseded
>   attempt writes nothing — Codex F5).
> - **`EXECUTOR_UNAVAILABLE` → HTTP 503 (retryable)** — a transient `git push` rejection or
>   provider PR-API 5xx during a `pull_request` promote (Codex F7). The run stays `Review`
>   with no `pr_url`; retry is idempotent. The route's `httpStatusForCode` is code-only, so
>   `PRECONDITION` can map ONLY to 409 — a retryable status needs this distinct retryable
>   code, and `EXECUTOR_UNAVAILABLE` is already a closed-union member (not an addition).
>   Phase 3 adds the `EXECUTOR_UNAVAILABLE → 503` case to the promote route's
>   `httpStatusForCode`.

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

## Token / external-API auth (M16 — Implemented)

> These are **HTTP-level status codes**, NOT `MaisterError` codes. They mirror
> `httpStatusForAuthz` and are implemented by `TokenAuthError(kind)` +
> `httpStatusForTokenAuth(kind)` in the `/api/v1/ext/*` surface (ADR-046).
> Body validation and config errors on those routes reuse the existing `CONFIG`
> `MaisterError`, mapped to **422** (Unprocessable Entity) across the whole ext
> surface by the shared `httpStatusForExtCode` — one canonical mapping, no
> 422-vs-400 divergence between sibling routes.

| HTTP status | When returned |
| ----------- | ------------- |
| **401** | Invalid, expired, or revoked project token. Also: missing or invalid inbound bearer on the Streamable-HTTP MCP transport. |
| **403** | Reserved — scope enforcement, unused in v1 full-project-API model (ADR-041). |
| **404** | Token's project ≠ addressed resource (existence-hide). Also: unknown or non-`external_check` gate; unknown task or run id. |
| **409** | Domain conflict — a gate report on a terminal run (`Done`/`Abandoned`/`Crashed`/`Failed`), or a launch/create precondition conflict (`CONFLICT`/`PRECONDITION` from the shared service). |
| **422** | Request body failed schema validation, or a `CONFIG` `MaisterError` from the shared service (unknown flow/executor, invalid config). Mapped by the shared `httpStatusForExtCode`. |

## See Also

- [Database Schema](database-schema.md) — `runs.status` enum the UI
  surfaces alongside error codes
- [Configuration](configuration.md) — `CONFIG` is thrown on every
  malformed `maister.yaml` / `flow.yaml` / `form_schema`
