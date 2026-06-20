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
| `PRECONDITION` | A precondition for an action is not met (dirty repo, base branch missing, prompt empty, branch taken, worktree path occupied, global concurrency cap hit; or repo onboarding (ADR-025): `git clone` failed, target directory missing, or the clone `target` path already exists). Also (M11c, ADR-032): a `Running` node exceeded its declared `limits.maxDurationMinutes` and was terminated by the web-side time-limit watchdog — a declared-limit-exceeded policy kill, NOT a `HITL_TIMEOUT`. Also (M12, declared-artifact contract): a node's required INPUT artifact (`input.requires`) is missing or stale → the node is set `Failed` **BEFORE** its action runs; a node's required OUTPUT artifact (`output.produces`) is missing → the node is set `Failed` **BEFORE** it finishes. M12 **reuses** this existing code — it adds NO new `MaisterError` code. Also (M18, Implemented — promote-time gates, ADR-058/049): a PR-mode preflight fails (provider CLI `gh`/`glab` missing on the web-host PATH, or `GITEA_TOKEN`/`GITVERSE_TOKEN` unset for the gitea-family REST adapter, or the git remote is not configured, or push was rejected for a config reason); the run's `generic` provider does not support PR mode; the target branch is invalid or missing; the target branch advanced since the ReviewPanel rendered (target-drift, no `allowTargetDrift` override — Codex F6); readiness is not ready or stale at promote time (the second `assertEvidenceReady(runId,"review")` re-gate); or a pre-M18 legacy run lacks the branch metadata needed to promote and no fallback can be derived (Codex F4). All map to **HTTP 409**. M18 **reuses** this existing code — it adds NO new `MaisterError` code. | `POST /api/runs` validation before spawn; scratch launch/message/diff gates; `POST /api/projects` source resolution (clone / existing-local — `resolveProjectSource`); `keepalive-sweeper` time-limit pass (`runTimeLimitPass`); M12 runner-graph per-node artifact precheck (input gate before action, output gate before finish); the shared `promoteRun` service (M18) — claim-tx readiness/target-drift/target-validity guards and PR-mode preflight before any side-effect. Also (M19, Designed) the reconcile classifier (ADR-033) records the crash reason on a `Running → Crashed` transition (`worktree-gone`, `agent-session-gone`, `cli-not-retry-safe`); the reason is observability, not a thrown 4xx from a route. Also (ADR-062): `DELETE /api/admin/users/{userId}` hard-delete of a referenced or non-pending user; `POST /api/projects/{slug}/members` adding a user id that does not exist; `DELETE /api/projects/{slug}/members/{memberId}` self-delete attempt. All map to **HTTP 409**. | Show the specific blocker, link to fix. For an M11c duration-cap kill: the run is `Failed` with the node attempt recording `errorCode = PRECONDITION`. For an M12 required-artifact miss: the run is `Failed` with the node attempt recording `errorCode = PRECONDITION` and naming the missing/stale artifact id. For an M18 promote refusal the run stays `Review` (no claim taken) — surface the specific blocker (PR-mode prereq, invalid target, target-drift "re-review or override", readiness-not-ready, or "relaunch to promote" for a legacy run) and keep Promote retryable. |
| `SPAWN` | Subprocess could not be launched (binary not on PATH, exec perm denied, OOM). | `supervisor/` when spawning `claude-agent-acp` or `codex-acp`. | "Executor failed to start" with stderr tail. |
| `NEEDS_INPUT` | The run paused for human input (ACP `session/request_permission`, scratch dialog permission card, or `needs-input.json` artifact). | Supervisor on ACP notification or artifact appearance; scratch event projection persists the permission card and sets `scratch_runs.dialog_status = NeedsInput`. | Render HITL form / approve-deny prompt. |
| `HITL_TIMEOUT` | Supervisor's pending-permission deferred expired (M7) — typically `MAISTER_KEEPALIVE_MINUTES` elapsed without a `/respond` ack. **NOT** raised for the `NeedsInputIdle → Abandoned` transition (M8) — that is a sweeper-driven state flip with no error surface, NOT a `HITL_TIMEOUT`. | Supervisor `POST /sessions/:id/input`, web `/respond` HITL_TIMEOUT branch, including scratch permission responses that reuse the same endpoint. | Flow run → `Failed`; scratch run → `Crashed` with `scratch_runs.error_code = HITL_TIMEOUT`; respond returns 410 terminal. |
| `CRASH` | Worker died mid-`Running` without a graceful checkpoint, or scratch dialog event projection could not persist a permission safely. | Supervisor heartbeat watcher; startup reconcile; scratch recovery/reconciliation. | "Recover or discard" panel; the server reuses the stored ACP resume handle without exposing it to the browser. |
| `CONFLICT` | Local promotion could not auto-merge the run branch into the selected target branch, a scratch branch/worktree already exists, a scratch prompt is already running, or scratch launch capacity is full. Also (M19, Designed): a `POST /api/runs/{runId}/recover` whose Phase-1 CAS `WHERE status='Crashed'` lost — the run is not `Crashed` or a concurrent Recover already flipped it `Running`/`Pending` (409); a `POST /api/runs/{runId}/discard` against a conflicting non-terminal state that is not discardable (409). Also (M18, Implemented — flow-run promotion): a concurrent promote lost the durable-claim CAS (a fresh `claiming` is already present), or a slow promote's finalize was superseded by a same-user stale-claim reclaim that re-minted `promotion_attempt_id` (the superseded attempt writes nothing — Codex F5). Both map to **HTTP 409**. | `POST /api/runs/[id]/promote` when `promotion.mode = local_merge`; scratch launch/message/discard state gates; `POST /api/runs/{runId}/recover` and `POST /api/runs/{runId}/discard` state gates (M19); the shared `promoteRun` service durable-claim CAS + finalize attempt-token guard for flow **and** scratch runs (M18, §3.2 of the M18 plan). Also (ADR-062): `POST /api/admin/users` duplicate email; `POST /api/projects/{slug}/members` duplicate member; `PATCH /api/projects/{slug}/members/{memberId}` and `DELETE /api/projects/{slug}/members/{memberId}` raced CAS on member role/remove. All map to **HTTP 409**. | "Resolve manually" with parent repo path, run branch, target branch, and failing command; for scratch capacity or prompt conflicts, keep the dialog/launcher retryable. For recover/discard 409, refresh the run row — another action already moved its state. For an M18 concurrent/superseded promote 409, the in-flight (or reclaiming) attempt owns finalization — refresh and wait, do not re-fire. |
| `CONFIG` | A config file, env var, route body, or capability selection is missing or malformed (`maister.yaml`, `flow.yaml`, `form_schema`, `DB_URL`, unknown scratch MCP/skill/rule id, cross-project executor/task id). Also (M11c, ADR-032): an `ai_coding`/`judge` node declares `enforcement: strict` on a capability class the build cannot strictly enforce for ANY agent (with the M11c all-`instructed` `ENFORCEABILITY_BY_AGENT` table, every `strict` class today) — internal over-declaration. Also (M12, declared-artifact contract): manifest artifact violations rejected at load/validate time — duplicate `output.produces[].id` within a manifest, an `input.requires` ref to an unknown artifact id, an `input.requires` object whose declared `kind` mismatches the produced artifact's `kind`, an unsupported artifact `kind`, an invalid `path`/`ref`, or an `artifact_required` gate whose `inputArtifacts` reference unknown artifact ids. M12 **reuses** this existing code — it adds NO new `MaisterError` code. | `lib/config.ts` validators; `lib/db/client.ts`; scratch route body and capability validators; `web/app/api/runs/route.ts` launch precondition + `web/lib/flows/graph/runner-graph.ts` per-node runtime gate (thrown by `assertNodeLaunchable` in `web/lib/flows/enforcement.ts`, before any ACP session / permission deferred is created); M12 manifest artifact validation in `loadFlowManifest` / `validateGraphManifest`. Also (ADR-062): Zod body-validation failure on `POST /api/admin/users`, `PATCH /api/admin/users/{userId}`, `POST /api/projects/{slug}/members`, and `PATCH /api/projects/{slug}/members/{memberId}` (body incl. `expectedRole`), plus a missing/invalid `expectedRole` query parameter on `DELETE /api/projects/{slug}/members/{memberId}`. Maps to **HTTP 422**. | Show the offending field path; refuse to start. For an M11c strict-enforcement refusal (HTTP 400, the existing `CONFIG` status mapping), name the node id + class + resolved agent; no worktree/run is created. For an M12 manifest artifact violation, name the offending artifact id / ref / kind / path; the Flow does not enable. |
| `EXECUTOR_UNAVAILABLE` | The executor named in run launcher / project override / Flow recommendation / scratch launcher is not registered for this project, or the supervisor readiness check failed before launch side effects. Also: supervisor 5xx during M8 keep-alive sweeper checkpoint, supervisor 5xx / network failure during M8 resume from the HITL respond idle branch, or scratch prompt delivery failure after the message is durably stored. Both M8 callers treat the code as retryable — sweeper re-attempts on next tick, respond returns 503 `{terminal:false}` to the operator. Scratch message send keeps the dialog retryable. Also (M11c, ADR-032): an `ai_coding`/`judge` node declares `enforcement: strict` on a capability class that IS `enforced` for some agent but `unsupported`/`instructed` for the resolved executor's agent (unreachable with the M11c all-`instructed` table; reachable once M14 flips cells). Also (M19, Designed): a transient supervisor failure (5xx / network / timeout) during the `POST /api/runs/{runId}/recover` Phase-2 `createSession({resumeSessionId})` — the run is LEFT `Running` (no rollback; an ack may have been lost), 503 returned, the reconciler re-attaches or re-crashes past grace; retryable. Also (M18, Implemented — PR-mode transient failure, ADR-049, Codex F7): a `pull_request` promote whose `git push` is transiently rejected or whose provider PR API returns a 5xx — a **retryable** side-effect failure (distinct from the config-class PR preconditions, which are `PRECONDITION`/409). The run stays `Review` with **no `pr_url`** stored; the promote is idempotent on retry. Maps to **HTTP 503**. M18 **reuses** this existing closed-union member — it adds NO new `MaisterError` code; the promote route's `httpStatusForCode` carries the `EXECUTOR_UNAVAILABLE → 503` case (the mapping is code-only, so `PRECONDITION` can map ONLY to 409 — a retryable status needs this distinct retryable code, which is already a union member). | `POST /api/runs` executor resolution and `GET /health` preflight; `POST /api/scratch-runs` readiness/executor gates and `POST /api/scratch-runs/{runId}/messages`; `keepalive-sweeper` Pass 1; `resumeRun` from `/respond` idle branch; `POST /api/runs/{runId}/recover` supervisor `createSession` side-effect (M19); the shared `promoteRun` PR side-effect (`pushBranch` / `PrAdapter.createOrUpdatePr`) for transient push/PR-API 5xx failures (M18); `web/app/api/runs/route.ts` launch precondition + `web/lib/flows/graph/runner-graph.ts` per-node runtime gate (thrown by `assertNodeLaunchable` in `web/lib/flows/enforcement.ts`, before any ACP session / permission deferred is created). | Disable launch while supervisor is unavailable; show "start/recover supervisor" guidance. "Pick a different executor" when the project executor is missing; silently retry next tick (sweeper); 503 `{terminal:false}` to operator (respond); keep scratch dialog input retryable when prompt delivery failed. For an M11c wrong-agent strict-enforcement refusal (HTTP 503), name the node id + class + resolved agent and suggest an executor whose agent enforces the class. For an M19 recover 503, keep the Recover action retryable — the run is still `Running`. For an M18 PR-mode 503, keep the Promote action retryable — the run is still `Review`, no PR was recorded, and a retry resumes idempotently. |
| `FLOW_INSTALL` | A Flow package install/upgrade failed at any stage: clone, resolve-revision, validate-manifest, or finalize. M10 (ADR-021) carries structured detail in the message — `{source, version, stage, command, exitStatus, output}` — and the two-phase install marks the `flow_revisions` row `Failed` (never left `Installing`). | Project registration (`POST /api/projects`); Flow loader; `flow-packages` install/upgrade routes (HTTP 502). | Show the failing source URL + tag + stage, link to the manifest/command error. |
| `ACP_PROTOCOL` | Supervisor received an ACP message it cannot decode, or saw an unexpected state transition. | Supervisor ACP client. | "Executor sent an unexpected message" with the raw payload. |
| `CHECKPOINT` | Terminal resume failure (M8). Supervisor 400 (spawn refused), 201 with empty `acpSessionId`, or 404 (unknown checkpoint) during `resumeRun` from the `/respond` idle branch. Also raised when `checkpointSession()` receives a malformed 200 response body. Also (M19, Designed): `POST /api/runs/{runId}/recover` against an unresumable acp session — the supervisor refuses the `session/resume` — returns 410; the run stays `Crashed` and the UI offers discard-only. | Web `resumeRun`; web `supervisor-client.checkpointSession`; `POST /api/runs/{runId}/recover` resume side-effect (M19). | Run → `Failed` via `failResumedRun`; respond returns 410 `{terminal:true}`; UI surfaces "this run can't be resumed". For an M19 recover 410, surface discard-only (the run remains `Crashed`). |
| `STEP_CHECKPOINTED` | Step paused mid-permission by a supervisor checkpoint (M8 Codex review fix #1). The runner-agent observed `session.exited.reason === "checkpoint"` on the SSE stream and called `markCheckpointedFromExit`, transitioning the run to `NeedsInputIdle`. This is NOT a failure — the cancelled permission is journaled for replay on the next `session/resume`. Distinct from `CHECKPOINT` (terminal resume failure). | Web `runner-agent` in both `new-session` and `slash-in-existing` modes. | Run is in `NeedsInputIdle`; UI surfaces the same Inbox panel as keepalive-driven idle. Step is replayed by the resume-driver on operator response. |
| `UNAUTHENTICATED` | No valid session — request arrived without a cookie or with an expired/invalid session token. Maps to **HTTP 401**. | `lib/authz.ts:requireSession()`. Also thrown by `requireGlobalRole()` and `requireProjectRole()` when no session exists. | Redirect to sign-in page. Never show partial data. |
| `UNAUTHORIZED` | Session is valid but the caller's role (global or project) is below the required minimum. Maps to **HTTP 403**. | `lib/authz.ts:requireGlobalRole()`, `requireProjectRole()`, `requireProjectAction()`. Also (ADR-062): role gate on `POST /api/admin/users`, `PATCH /api/admin/users/{userId}`, `DELETE /api/admin/users/{userId}`, `GET /api/projects/{slug}/members`, `GET /api/projects/{slug}/members/candidates`, `POST /api/projects/{slug}/members`, `PATCH /api/projects/{slug}/members/{memberId}`, `DELETE /api/projects/{slug}/members/{memberId}`. | Show "Access denied" with the required role; do not expose the project/resource name to the caller. |
| `PASSWORD_CHANGE_REQUIRED` | Session is valid but the account still has `users.must_change_password = true` (seeded admin / admin-forced reset). Maps to **HTTP 403**. Fails closed on every role-gated API. | `lib/authz.ts:requireActiveSession()` (called by `requireGlobalRole()` / `requireProjectRole()`). `requireSession()` / `getSessionUser()` stay permissive so the change-password flow itself works. | Route the user to `/change-password`; block all other actions until cleared. |
| `ACCOUNT_INACTIVE` | Session is valid but `users.account_status != 'active'` (pending approval or disabled after an old session was issued). Maps to **HTTP 403**. Credentials sign-in also rejects pending/disabled accounts before session creation. | `lib/authz.ts:requireActiveSession()`; credentials preflight in `web/app/(auth)/actions.ts` and provider verification in `web/auth.ts`. | Show pending-approval or disabled-account guidance; block protected app/API actions until an admin activates or re-enables the account. |

> **M12 adds NO new `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union). Beyond the `CONFIG` / `PRECONDITION` reuses above, two M12 outcomes have **no thrown code at all**: an unsatisfied `artifact_required` gate records `gate_results.status = "failed"` (the gate-result lifecycle, not an exception); a `human_review` refusal driven by a failed blocking gate is a blocking gate failure (no HTTP code). Neither maps to an HTTP status.

> **ADR-093 (project onboarding) adds NO new `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror)
> closed union). A failed `git clone` keeps `code = "PRECONDITION"` (HTTP 409,
> the existing repo-onboarding row above); the new **clone-failure reason** is
> purely **advisory context**, never a code:
>
> - **`reason` is advisory on the unchanged `PRECONDITION` code (Implemented).**
>   `classifyGitError(stderr)` derives one of `SSH_AUTH | SSH_HOSTKEY |
>   HTTPS_AUTH | NOT_FOUND | NETWORK | UNKNOWN`. The classification logic +
>   marker strings live in [`system-analytics/git-integration.md`](system-analytics/git-integration.md)
>   (R7) — not restated here.
> - **`{ reason, detail }` shape (Implemented).** `detail` is the **redacted** git
>   stderr (`redactUrl` applied), **truncated to ~4 KB**. Both ride a new
>   additive optional `MaisterError.details?: Record<string, unknown>`; the
>   `POST /api/projects` `errorResponse` serializes the body as
>   `{ code, message, reason?, detail? }`.
> - **`MaisterError` gains an additive optional `details?` (Implemented).** Backward
>   compatible — existing throws (which pass no `details`) and every other code
>   are unaffected. The field carries structured advisory context only; it never
>   replaces `code`.
> - **UI branches on `code`, NEVER string-matches (Implemented).** The form maps
>   `reason` → a specific i18n remediation (e.g. `SSH_AUTH` → `ssh-add`;
>   `github.com` + `HTTPS_AUTH` → the `gh auth login` / token / SSH fork) and
>   shows `detail` in a collapsible "git output" block. The one-off HTTPS token
>   (`MAISTER_GIT_TOKEN`) is NEVER in any `detail`, error, or log.

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
> closed union; ADR-058/049). Flow-run promotion and `pull_request` mode reuse three
> existing codes at new `promoteRun` call sites (all Implemented, M18):
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
>   The promote route's `httpStatusForCode` carries the `EXECUTOR_UNAVAILABLE → 503`
>   case.

> **M22 adds NO new `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror)
> closed union; ADR-064/052/053). The workbench reuses one existing code (`CONFIG`)
> at new call sites (all Implemented, M22), plus a bare HTTP 404 status and RSC
> blob page states that are NOT `MaisterError`s:
>
> - **`CONFIG` → HTTP 400** new call sites: every `…/files?path=` tree route (run +
>   project) when `?path=` fails `repoRelPathSchema` (`..` segment, absolute,
>   leading `/` or `-`, NUL). Thrown by `web/lib/worktree.ts` (`repoRelPathSchema`).
>   Names the offending path. (The flow-graph layout `PUT` was removed with the
>   layout store — ADR-064 moves authored layout into `flow.yaml`.)
> - **HTTP 404 (bare, NOT a thrown `MaisterError`)**: `GET …/graph` /
>   `…/graph-status` for a genuinely unknown run, a run with no flow, or no pinned
>   manifest; the file routes when a validated `?path=` is not in the git-tracked
>   tree (`.git/` / gitignored / untracked / unknown). The route returns a bare
>   `404` with a `{message}` body — it does NOT throw `PRECONDITION` (whose
>   canonical mapping is **409**, code-only). Access denied (non-member or
>   below-`member` role) is **403** via `requireProjectAction`, the app-wide
>   convention — NOT 404.
> - **RSC blob page states, no HTTP status / no `MaisterError`:** on the `?file=`
>   render path a tracked blob over `MAISTER_WORKBENCH_MAX_FILE_BYTES` renders the
>   `file-too-large` page state (`readBlob` → `{kind:"too-large",size}`) and a
>   binary blob the `file-binary` page state (`{kind:"binary"}`). The retired
>   `…/files/content` route's HTTP **413**/**415** no longer exist (ADR-066); these
>   are `readBlob` markers the server component branches on, not thrown domain
>   errors.

> **M27 adds NO new `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror)
> closed union). Workbench lifecycle actions reuse existing codes at the
> stop/archive/drop/export/snapshot/handoff routes:
>
> - **`CONFIG` → HTTP 400** — strict route-body validation failure, including
>   spoofed body fields such as project id, worktree path, current branch, or
>   session handles. The service only sees validated user intent fields.
> - **`PRECONDITION` → HTTP 409** — live state refused for archive/drop/export/
>   snapshot/handoff; clean worktree refused for snapshot commit; dirty worktree
>   refused for handoff; dirty export without explicit snapshot consent; missing
>   selected remote; unsafe worktree path outside `MAISTER_WORKTREES_ROOT`.
> - **`CONFLICT` → HTTP 409** — preserve failure, different-head local/remote
>   branch collision, stale drop run-status CAS, local git conflict, lifecycle
>   operation claim race on
>   `workspaces.lifecycle_operation_*`, or export push rejected as
>   non-fast-forward. The non-fast-forward payload includes
>   `pushRejected=non_fast_forward`, `canForce=true`, and a retry hint; a user
>   retry with force uses `git push --force-with-lease`.
> - **`EXECUTOR_UNAVAILABLE` → HTTP 503** — transient supervisor stop failure,
>   transient export push failure, handoff remote-existence check failure, or
>   handoff push failure. Retry leaves the run/workspace in the current state;
>   transient handoff push failures keep the lifecycle claim retryable and reuse
>   same-head local/remote handoff refs idempotently.

> **M27 adds NO new `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union). M27 reuses four existing codes at new call sites (all Designed, M27):
>
> **`CONFIG` new call sites (M27, Designed):**
> - **Invalid manifest on draft save / publish** — `validateGraphManifest` + `compileManifest` hard-gate in the flow editor draft PATCH and publish-local routes; invalid manifest → `CONFIG` (422), draft row unchanged.
> - **Unknown MCP/skill ref in manifest** — resolved by the M14 carve-b validation extended to flow-package `mcps?` top-level declarations; unknown ref → `CONFIG` (422).
> - **Required MCP unresolved at launch** — `launchRun` after the M14 unknown-cap-ref check; a REQUIRED MCP that cannot resolve+materialize → `CONFIG` (409).
> - **version-binding bad enum** — `PATCH /api/projects/{slug}/flows/{flowId}/version-binding` with a value outside `{pinned, latest}` → `CONFIG` (422).
> - **Bridge of invalid package** — `installAuthoredFlowPackageBridge` on an invalid authored package → `CONFIG` (422).
>
> **`CONFLICT` new call sites (M27, Designed):**
> - **Stale `expectedDraftVersion`** on the flow editor draft PATCH → `CONFLICT` (409), row unchanged.
> - **Platform MCP delete while referenced** — `DELETE /api/admin/mcp-servers/{id}` when usage references exist → `CONFLICT` (409) (mirrors the `assertCanDisable` runner-CRUD guard).
>
> **`PRECONDITION` new call site (M27, Designed):**
> - **Platform MCP delete of unknown id** — `DELETE` or `PATCH` against an unknown `mcp-servers/{id}` → `PRECONDITION` (409) (mirrors the runner-CRUD unknown-id guard).
>
> **`EXECUTOR_UNAVAILABLE` new call site (M27, Designed):**
> - **Required MCP agent-unsupported (strict)** — a REQUIRED MCP cannot materialize because the resolved agent does not support it → `EXECUTOR_UNAVAILABLE` (503). Non-REQUIRED (additional) MCP absence is non-fatal.

> **The platform-user + project-member admin surface (ADR-062) reuses existing codes and adds none** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union). New call sites for `CONFIG` (invalid body/Zod — HTTP 422), `CONFLICT` (duplicate email, duplicate member, raced CAS — HTTP 409), `PRECONDITION` (hard-delete of referenced/non-pending user, add nonexistent user, self-delete — HTTP 409), and `UNAUTHORIZED` (role gate — HTTP 403) are noted in the relevant rows above.

> **M29 / model discovery + application adds NO new `MaisterError` or `SupervisorErrorCode`**
> ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union;
> [ADR-076](decisions.md#adr-075)). The model-catalog resolver and the configured-model
> application reuse existing codes at new call sites (all Implemented, M29). The governing
> rule is *a per-source discovery failure NEVER fails the whole resolve* — so source-level
> problems are reported as a per-source `status` inside an HTTP **200**, not thrown.
>
> **`CONFIG` → HTTP 422 (web proxy, new call site):** `POST /api/admin/acp-runners/model-suggestions`
> — invalid body, a raw (non-`env:`) secret in a provider field, or an unknown `sidecarId`. A
> *missing / unset* env-ref name is NOT a 422 — it degrades gracefully to that provider source's
> `status:"error"` inside a 200 (ADR-076 §2: a per-source failure never fails the resolve). The bare
> env-ref name never leaves the supervisor host; secret values are never returned or logged.
>
> **`EXECUTOR_UNAVAILABLE` → HTTP 503 (web proxy, new call site):** the same route when the
> supervisor is unreachable or returns 5xx during `POST /model-catalog/resolve`. The runner modal
> keeps the offline `presets.ts` layer and a retry affordance. Reuses the existing retryable
> closed-union member.
>
> **`PRECONDITION` → HTTP 409 (supervisor, new call site):** the supervisor `POST /model-catalog/resolve`
> Zod boundary rejects a malformed draft (unknown adapter, an `env:`-prefixed or raw-secret value in
> an env-ref field, a malformed provider union, or `router` without `sidecarId`). This is the ONLY
> request-level status the resolve route throws.
>
> **`ACP_PROTOCOL` (supervisor, classification only — NOT thrown by resolve):** a malformed
> adapter / CCR / provider source response is the `ACP_PROTOCOL` *class* of failure, but inside the
> resolve it is captured as that source's `status: "error"` within a 200 response, never raised as a
> 500. The existing live-session `ACP_PROTOCOL` (500) call site is unchanged.

> **The M34 platform-agent substrate (ADR-089/090) reuses existing codes and adds none**
> ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union). New call
> sites (all Implemented):
> - **`CONFIG` → HTTP 422** — invalid agent definition at registration (bad/unknown
>   frontmatter keys — the removed `scope`/`project` fields now fail loudly — or a
>   `workspace_ref` without `workspace: repo_read`); a flow
>   node's `settings.agent` referencing an unknown catalog agent or an agent whose
>   `triggers` lacks `flow`; `settings.agent` declared without
>   `compat.engine_min >= 1.5.0`; invalid cron expression / timezone / event kinds on an
>   agent trigger binding.
> - **`EXECUTOR_UNAVAILABLE` → HTTP 503** — the standalone agent runner chain resolves to a
>   missing/disabled/not-ready runner at any tier (no fallback); `mode=subagent` resolved to
>   a non-`claude` capability runner; `workspace ∈ {none, repo_read}` resolved to a runner
>   with `permission_policy=dangerously_skip_permissions`.
> - **`PRECONDITION` → HTTP 409** — launch refusals at every agent entry point: agent
>   disabled or quarantined (`agents.quarantined_at` set), `risk_tier=destructive` while the
>   ADR-041 enforcement flip is blocked, the requested trigger absent from the agent's
>   `triggers`, the project's pinned package revision lacking the agent or the requested
>   trigger (pin divergence), an unresolvable `workspace_ref` (no trigger-derived ref and no
>   literal branch), a dirty `repo_read` baseline (`statusPorcelain` non-empty), attaching an
>   agent whose providing package is not enabled in the project, or launching an
>   `unconfigured` (flowless) task.
> - **`CONFLICT` → HTTP 409** — attaching an already-attached agent
>   (`agent_project_links` uniqueness).

> **The M36 orchestrator engine (ADR-095) reuses existing codes and adds none**
> ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union).
> The orchestrator / delegation paths (`run_delegate` / `run_plan` / `run_collect`
> / `run_cancel` / `run_message` / `run_promote` / `run_rework` over the MCP
> facade, the governed run-tree, and the idle-checkpoint wait/resume) map onto the
> existing closed union. **(M36 — Implemented, ADR-095/096/097.)** New call sites:
> - **`PRECONDITION` → HTTP 409** — a `run_delegate` / `run_plan` naming an agent
>   not resolvable through the project's enabled + trusted catalog (unresolvable /
>   untrusted delegation target — "resolve+trust" is physically separate from
>   "launch", and **no child run is created** on refusal); a cross-batch
>   `dependsOn` / `requires` reference outside the plan being written.
> - **`CONFIG` → HTTP 422** — a flow declaring an `orchestrator` node with
>   `compat.engine_min < 1.6.0` (engine floor); an over-`max_fanout` /
>   over-`max_depth` request (bounds, enforced pre-tx); a cyclic task DAG in
>   `run_plan`; a `strict` path-scope enforcement declaration (the Phase-2 policy
>   gap — refused until [ADR-096](decisions.md#adr-096-persistent-swarm-layer-2--addressable-sessions-star-routed-messaging-worktree-modes-per-agent-read-only) lands).
> - **`CONFLICT` → HTTP 409** — a concurrent orchestrator resume (two child-settle
>   events racing the same `WaitingOnChildren → Running` wake); a merge conflict
>   promoting a reviewed child (`run_promote` or as-plan auto-promote, ADR-097) —
>   the child stays in `Review`, never auto-resolved.
> - **`CHECKPOINT`** — an orchestrator `session/resume` failure when waking from
>   `WaitingOnChildren` (terminal resume failure, same class as the M8 idle path).
> - **`EXECUTOR_UNAVAILABLE` → HTTP 503** — a child-run spawn or concurrency-cap
>   failure during delegation (retryable).

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
| **403** | Insufficient token scope on `/api/v1/ext/*` — the token must hold the route/tool scope (for example `tasks:create`, `runs:launch`, `hitl:read`, `hitl:respond`) or `*`; the response does not reveal which scopes the token holds. Also **(D7, ADR-055)** actor-kind gate — a token (`api_token`) or internal-agent actor answering a `human`-kind HITL request (`hitlRow.kind === "human"`) is refused 403; token/agent actors may answer only `permission`/`form`-kind requests. A `*`-scoped token passes the scope check but is still subject to D7. |
| **404** | Token's project ≠ addressed resource (existence-hide). Also: unknown or non-`external_check` gate; unknown task or run id. **(M17, Implemented)** on HITL ext routes: `run.projectId ≠ token.projectId`, or unknown `runId`/`hitlRequestId`, or `hitlRow.runId ≠ runId` — all return 404 without distinguishing which check failed (existence-hide). |
| **409** | Domain conflict — a gate report on a terminal run (`Done`/`Abandoned`/`Crashed`/`Failed`), or a launch/create precondition conflict (`CONFLICT`/`PRECONDITION` from the shared service). **(M17, Implemented)** on the HITL respond ext route: idempotency conflict when the HITL request already has a `respondedAt` timestamp (the shared `respondToHitl` service returns 409, same as the session route). |
| **422** | Request body failed schema validation, or a `CONFIG` `MaisterError` from the shared service (unknown flow/executor, invalid config). Mapped by the shared `httpStatusForExtCode`. **(M17, Implemented — `NEEDS_INPUT`)** on the HITL respond ext route: bad response payload — `response` body fails the `respondToHitl` service validation (unknown `optionId`, out-of-range `confidence`, schema mismatch) — mapped from `MaisterError("NEEDS_INPUT")` to 422. |

**Scope labels (Implemented):** `hitl:read` and `hitl:respond` join the
project-token scope vocabulary alongside task/run/readiness/gate scopes.
`handleExt` enforces scopes by default on `/api/v1/ext/*`; `requireScope:
false` is reserved for explicit compatibility carves. A `["*"]`-scoped token
passes the scope check on all routes; it is still subject to the actor-kind
gate (D7). See [ADR-055](decisions.md#adr-055-hitl-response-service--hitl-over-mcp--token-actor--actor-kindscope-auth-gates) and
[`api/external/operations.openapi.yaml`](api/external/operations.openapi.yaml).

## See Also

- [Database Schema](database-schema.md) — `runs.status` enum the UI
  surfaces alongside error codes
- [Configuration](configuration.md) — `CONFIG` is thrown on every
  malformed `maister.yaml` / `flow.yaml` / `form_schema`
