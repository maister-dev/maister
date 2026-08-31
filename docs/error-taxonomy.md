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

### UI completion rendering contract (Implemented)

The **UI action** column describes the operator recovery intent, not literal
error text. Action surfaces resolve known codes through their EN/RU message
namespace and use a generic localized fallback for malformed or unknown code
values. They never render a raw API message, HTTP status, or code as a button
label or toast. A route error boundary may show a recognized code only in an
explicitly labeled localized diagnostic field; it still must not show server
detail.

## Codes

Eighteen codes (the checkpoint/resume layer added `STEP_CHECKPOINTED`; the
auth layer added `UNAUTHENTICATED`, `UNAUTHORIZED`, `PASSWORD_CHANGE_REQUIRED`,
and `ACCOUNT_INACTIVE`; ADR-101 added `BUDGET_EXCEEDED`; ADR-122 added
`EMBEDDING_UNAVAILABLE`), all defined as a string union in
`web/lib/errors-core.ts` (re-exported by `web/lib/errors.ts`).

| Code | Meaning | Where thrown | UI action |
| ---- | ------- | ------------ | --------- |
| `PRECONDITION` | A precondition for an action is not met (dirty repo, base branch missing, prompt empty, branch taken, worktree path occupied, global concurrency cap hit; or repo onboarding (ADR-025): `git clone` failed, target directory missing, or the clone `target` path already exists). Also (ADR-032): a `Running` node exceeded its declared `limits.maxDurationMinutes` and was terminated by the web-side time-limit watchdog — a declared-limit-exceeded policy kill, NOT a `HITL_TIMEOUT`. Also (declared-artifact contract): a node's required INPUT artifact (`input.requires`) is missing or stale → the node is set `Failed` **BEFORE** its action runs; a node's required OUTPUT artifact (`output.produces`) is missing → the node is set `Failed` **BEFORE** it finishes. The declared-artifact contract **reuses** this existing code — it adds NO new `MaisterError` code. Also (Implemented — promote-time gates, ADR-058/049): a PR-mode preflight fails (provider CLI `gh`/`glab` missing on the web-host PATH, or `GITEA_TOKEN`/`GITVERSE_TOKEN` unset for the gitea-family REST adapter, or the git remote is not configured, or push was rejected for a config reason); the run's `generic` provider does not support PR mode; the target branch is invalid or missing; the target branch advanced since the ReviewPanel rendered (target-drift, no `allowTargetDrift` override — Codex F6); readiness is not ready or stale at promote time (the second `assertEvidenceReady(runId,"review")` re-gate); or a legacy run predating the promotion gates lacks the branch metadata needed to promote and no fallback can be derived (Codex F4). All map to **HTTP 409**. The promotion surface **reuses** this existing code — it adds NO new `MaisterError` code. | `POST /api/runs` validation before spawn; scratch launch/message/diff gates; `POST /api/projects` source resolution (clone / existing-local — `resolveProjectSource`); `keepalive-sweeper` time-limit pass (`runTimeLimitPass`); the runner-graph per-node artifact precheck (input gate before action, output gate before finish); the shared `promoteRun` service — claim-tx readiness/target-drift/target-validity guards and PR-mode preflight before any side-effect. Also (ADR-126, Designed): the `auto_promote` sweep (`web/lib/scheduler/handlers/auto-promote.ts`) is a SYSTEM caller of that same `promoteRun` — a terminal `PRECONDITION` (stale/not-green readiness at promote time after an eligible evaluation) is its give-up signal: the sweep sets `runs.promotion_hold={source:'system'}` and posts exactly ONE system comment, never retrying; it reuses this code and adds none. Also (Designed) the reconcile classifier (ADR-033) records the crash reason on a `Running → Crashed` transition (`worktree-gone`, `agent-session-gone`, `cli-not-retry-safe`); the reason is observability, not a thrown 4xx from a route. Also (ADR-119, Implemented): a launch refused by the launchability classifier on `POST /api/runs` — the manual gate (`busy`/`blocked`/`flagged`) OR, with `allowConcurrent:true`, the force gate (`flagged`/`blocked` only; run status never refuses) — throws this same code; force-relaunch adds NO new `MaisterError` code. Also (ADR-062): `DELETE /api/admin/users/{userId}` hard-delete of a referenced or non-pending user; `POST /api/projects/{slug}/members` adding a user id that does not exist; `DELETE /api/projects/{slug}/members/{memberId}` self-delete attempt. All map to **HTTP 409**. Also (ADR-141, Implemented): the branch-sync service (`POST /api/runs/{runId}/sync` — `web/lib/runs/sync-target.ts`) eligibility / non-FF local-target divergence / dirty-worktree guards, and `POST /api/runs/{runId}/reopen` eligibility guards; both reuse this code (HTTP 409). | Show the specific blocker, link to fix. For a duration-cap kill: the run is `Failed` with the node attempt recording `errorCode = PRECONDITION`. For a required-artifact miss: the run is `Failed` with the node attempt recording `errorCode = PRECONDITION` and naming the missing/stale artifact id. For a promote refusal the run stays `Review` (no claim taken) — surface the specific blocker (PR-mode prereq, invalid target, target-drift "re-review or override", readiness-not-ready, or "relaunch to promote" for a legacy run) and keep Promote retryable. |
| `SPAWN` | Subprocess could not be launched (binary not on PATH, exec perm denied, OOM). | `supervisor/` when spawning `claude-agent-acp` or `codex-acp`. | "Executor failed to start" with stderr tail. |
| `NEEDS_INPUT` | The run paused for human input (ACP `session/request_permission`, scratch dialog permission card, or `needs-input.json` artifact). | Supervisor on ACP notification or artifact appearance; scratch event projection persists the permission card and sets `scratch_runs.dialog_status = NeedsInput`. | Render HITL form / approve-deny prompt. |
| `HITL_TIMEOUT` | Supervisor's pending-permission deferred expired — typically `MAISTER_KEEPALIVE_MINUTES` elapsed without a `/respond` ack. **NOT** raised for the `NeedsInputIdle → Abandoned` transition — that is a sweeper-driven state flip with no error surface, NOT a `HITL_TIMEOUT`. | Supervisor `POST /sessions/:id/input`, web `/respond` HITL_TIMEOUT branch, including scratch permission responses that reuse the same endpoint. | Flow run → `Failed`; scratch run → `Crashed` with `scratch_runs.error_code = HITL_TIMEOUT`; respond returns 410 terminal. |
| `CRASH` | Worker died mid-`Running` without a graceful checkpoint, or scratch dialog event projection could not persist a permission safely. | Supervisor heartbeat watcher; startup reconcile; scratch recovery/reconciliation. Also (ADR-141, Implemented): a branch-sync resolver session crashes or stops non-`end_turn` — the attempt aborts (pre-sync SHA restored), the session is deleted, and the run is CAS'd `Running → Review`. The same code covers two deliberate fail-closed throws in `lib/runs/sync-resolver.ts` AFTER a session exists (both tear it down first, per the deferred-release contract): its ACP handle could not be persisted (recovery could then never find or kill the process), and a permission HITL row could not be persisted (the run would park in `NeedsInput` with nothing to answer). | "Recover or discard" panel; the server reuses the stored ACP resume handle without exposing it to the browser. |
| `CONFLICT` | Local promotion could not auto-merge the run branch into the selected target branch, a scratch branch/worktree already exists, a scratch prompt is already running, or scratch launch capacity is full. Also (Designed): a `POST /api/runs/{runId}/recover` whose Phase-1 CAS `WHERE status='Crashed'` lost — the run is not `Crashed` or a concurrent Recover already flipped it `Running`/`Pending` (409); a `POST /api/runs/{runId}/discard` against a conflicting non-terminal state that is not discardable (409). Also (Implemented — flow-run promotion): a concurrent promote lost the durable-claim CAS (a fresh `claiming` is already present), or a slow promote's finalize was superseded by a same-user stale-claim reclaim that re-minted `promotion_attempt_id` (the superseded attempt writes nothing — Codex F5). Both map to **HTTP 409**. | `POST /api/runs/[id]/promote` when `promotion.mode = local_merge`; scratch launch/message/discard state gates; `POST /api/runs/{runId}/recover` and `POST /api/runs/{runId}/discard` state gates; the shared `promoteRun` service durable-claim CAS + finalize attempt-token guard for flow **and** scratch runs (§3.2 of the merge-enforcement plan). Also (ADR-126, Designed): when the `auto_promote` sweep calls `promoteRun` and hits a `local_merge` conflict, the `CONFLICT` is its terminal give-up — the run stays `Review`, the sweep CAS-sets `runs.promotion_hold={source:'system'}` and posts exactly ONE system comment (naming the failing target branch), and never retries; it reuses this code and adds none. Also (ADR-062): `POST /api/admin/users` duplicate email; `POST /api/projects/{slug}/members` duplicate member; `PATCH /api/projects/{slug}/members/{memberId}` and `DELETE /api/projects/{slug}/members/{memberId}` raced CAS on member role/remove. All map to **HTTP 409**. Also (ADR-141, Implemented): a branch-sync claim lost to a competing sync/promotion claim, the run-kind concurrency cap reached at `Review→Running` launch, or a force-with-lease push rejected because the branch moved remotely (the local rebase result is kept); all HTTP 409. | "Resolve manually" with parent repo path, run branch, target branch, and failing command; for scratch capacity or prompt conflicts, keep the dialog/launcher retryable. For recover/discard 409, refresh the run row — another action already moved its state. For a concurrent/superseded promote 409, the in-flight (or reclaiming) attempt owns finalization — refresh and wait, do not re-fire. |
| `CONFIG` | A config file, env var, route body, or capability selection is missing or malformed (`maister.yaml`, `flow.yaml`, `form_schema`, `DB_URL`, unknown scratch MCP/skill/rule id, cross-project executor/task id). Also (ADR-032): an `ai_coding`/`judge` node declares `enforcement: strict` on a capability class the build cannot strictly enforce for ANY agent (with the all-`instructed` `ENFORCEABILITY_BY_AGENT` table, every `strict` class today) — internal over-declaration. Also (declared-artifact contract): manifest artifact violations rejected at load/validate time — duplicate `output.produces[].id` within a manifest, an `input.requires` ref to an unknown artifact id, an `input.requires` object whose declared `kind` mismatches the produced artifact's `kind`, an unsupported artifact `kind`, an invalid `path`/`ref`, or an `artifact_required` gate whose `inputArtifacts` reference unknown artifact ids. The declared-artifact contract **reuses** this existing code — it adds NO new `MaisterError` code. | `lib/config.ts` validators; `lib/db/client.ts`; scratch route body and capability validators; `web/app/api/runs/route.ts` launch precondition + `web/lib/flows/graph/runner-graph.ts` per-node runtime gate (thrown by `assertNodeLaunchable` in `web/lib/flows/enforcement.ts`, before any ACP session / permission deferred is created); manifest artifact validation in `loadFlowManifest` / `validateGraphManifest`. Also (ADR-141, Implemented): Zod body-validation failure or an unknown `runnerId` on `POST /api/runs/{runId}/sync` and `POST /api/v1/ext/runs/sync` (HTTP **422**, distinct from the 409 domain PRECONDITION/CONFLICT surface). Also (ADR-062): Zod body-validation failure on `POST /api/admin/users`, `PATCH /api/admin/users/{userId}`, `POST /api/projects/{slug}/members`, and `PATCH /api/projects/{slug}/members/{memberId}` (body incl. `expectedRole`), plus a missing/invalid `expectedRole` query parameter on `DELETE /api/projects/{slug}/members/{memberId}`. Maps to **HTTP 422**. | Show the offending field path; refuse to start. For a strict-enforcement refusal (HTTP 400, the existing `CONFIG` status mapping), name the node id + class + resolved agent; no worktree/run is created. For a manifest artifact violation, name the offending artifact id / ref / kind / path; the Flow does not enable. |
| `EXECUTOR_UNAVAILABLE` | The executor named in run launcher / project override / Flow recommendation / scratch launcher is not registered for this project, or the supervisor readiness check failed before launch side effects. Also: supervisor 5xx during the keep-alive sweeper checkpoint, supervisor 5xx / network failure during resume from the HITL respond idle branch, or scratch prompt delivery failure after the message is durably stored. Both callers treat the code as retryable — sweeper re-attempts on next tick, respond returns 503 `{terminal:false}` to the operator. Scratch message send keeps the dialog retryable. Also (ADR-032): an `ai_coding`/`judge` node declares `enforcement: strict` on a capability class that IS `enforced` for some agent but `unsupported`/`instructed` for the resolved executor's agent (unreachable with the all-`instructed` table; reachable once capability materialization flips cells). Also (Designed): a transient supervisor failure (5xx / network / timeout) during the `POST /api/runs/{runId}/recover` Phase-2 `createSession({resumeSessionId})` — the run is LEFT `Running` (no rollback; an ack may have been lost), 503 returned, the reconciler re-attaches or re-crashes past grace; retryable. Also (Implemented — PR-mode transient failure, ADR-049, Codex F7): a `pull_request` promote whose `git push` is transiently rejected or whose provider PR API returns a 5xx — a **retryable** side-effect failure (distinct from the config-class PR preconditions, which are `PRECONDITION`/409). The run stays `Review` with **no `pr_url`** stored; the promote is idempotent on retry. Maps to **HTTP 503**. The promote path **reuses** this existing closed-union member — it adds NO new `MaisterError` code; the promote route's `httpStatusForCode` carries the `EXECUTOR_UNAVAILABLE → 503` case (the mapping is code-only, so `PRECONDITION` can map ONLY to 409 — a retryable status needs this distinct retryable code, which is already a union member). | `POST /api/runs` executor resolution and `GET /health` preflight; `POST /api/scratch-runs` readiness/executor gates and `POST /api/scratch-runs/{runId}/messages`; `keepalive-sweeper` Pass 1; `resumeRun` from `/respond` idle branch; `POST /api/runs/{runId}/recover` supervisor `createSession` side-effect; the shared `promoteRun` PR side-effect (`pushBranch` / `PrAdapter.createOrUpdatePr`) for transient push/PR-API 5xx failures; `web/app/api/runs/route.ts` launch precondition + `web/lib/flows/graph/runner-graph.ts` per-node runtime gate (thrown by `assertNodeLaunchable` in `web/lib/flows/enforcement.ts`, before any ACP session / permission deferred is created). Also (ADR-141, Implemented): a branch-sync resolver spawn failure / supervisor 5xx (`web/lib/runs/sync-target.ts` `createSession`) — the conflicted state is aborted first, the run stays `Review`, retryable (HTTP 503). | Disable launch while supervisor is unavailable; show "start/recover supervisor" guidance. "Pick a different executor" when the project executor is missing; silently retry next tick (sweeper); 503 `{terminal:false}` to operator (respond); keep scratch dialog input retryable when prompt delivery failed. For a wrong-agent strict-enforcement refusal (HTTP 503), name the node id + class + resolved agent and suggest an executor whose agent enforces the class. For a recover 503, keep the Recover action retryable — the run is still `Running`. For a PR-mode 503, keep the Promote action retryable — the run is still `Review`, no PR was recorded, and a retry resumes idempotently. |
| `FLOW_INSTALL` | A Flow package install/upgrade failed at any stage: clone, resolve-revision, validate-manifest, or finalize. The install pipeline (ADR-021) carries structured detail in the message — `{source, version, stage, command, exitStatus, output}` — and the two-phase install marks the `flow_revisions` row `Failed` (never left `Installing`). | Project registration (`POST /api/projects`); Flow loader; `flow-packages` install/upgrade routes (HTTP 502). | Show the failing source URL + tag + stage, link to the manifest/command error. |
| `ACP_PROTOCOL` | Supervisor received an ACP message it cannot decode, or saw an unexpected state transition. | Supervisor ACP client. | "Executor sent an unexpected message" with the raw payload. |
| `CHECKPOINT` | Terminal resume failure. Supervisor 400 (spawn refused), 201 with empty `acpSessionId`, or 404 (unknown checkpoint) during `resumeRun` from the `/respond` idle branch. Also raised when `checkpointSession()` receives a malformed 200 response body. Also (Designed): `POST /api/runs/{runId}/recover` against an unresumable acp session — the supervisor refuses the `session/resume` — returns 410; the run stays `Crashed` and the UI offers discard-only. | Web `resumeRun`; web `supervisor-client.checkpointSession`; `POST /api/runs/{runId}/recover` resume side-effect. | Run → `Failed` via `failResumedRun`; respond returns 410 `{terminal:true}`; UI surfaces "this run can't be resumed". For a recover 410, surface discard-only (the run remains `Crashed`). |
| `STEP_CHECKPOINTED` | Step paused mid-permission by a supervisor checkpoint (Codex review fix #1). The runner-agent observed `session.exited.reason === "checkpoint"` on the SSE stream and called `markCheckpointedFromExit`, transitioning the run to `NeedsInputIdle`. This is NOT a failure — the cancelled permission is journaled for replay on the next `session/resume`. Distinct from `CHECKPOINT` (terminal resume failure). | Web `runner-agent` in both `new-session` and `slash-in-existing` modes. | Run is in `NeedsInputIdle`; UI surfaces the same Inbox panel as keepalive-driven idle. Step is replayed by the resume-driver on operator response. |
| `UNAUTHENTICATED` | No valid session — request arrived without a cookie or with an expired/invalid session token. Maps to **HTTP 401**. | `lib/authz.ts:requireSession()`. Also thrown by `requireGlobalRole()` and `requireProjectRole()` when no session exists. | Redirect to sign-in page. Never show partial data. |
| `UNAUTHORIZED` | Session is valid but the caller's role (global or project) is below the required minimum. Maps to **HTTP 403**. | `lib/authz.ts:requireGlobalRole()`, `requireProjectRole()`, `requireProjectAction()`. Also (ADR-062): role gate on `POST /api/admin/users`, `PATCH /api/admin/users/{userId}`, `DELETE /api/admin/users/{userId}`, `GET /api/projects/{slug}/members`, `GET /api/projects/{slug}/members/candidates`, `POST /api/projects/{slug}/members`, `PATCH /api/projects/{slug}/members/{memberId}`, `DELETE /api/projects/{slug}/members/{memberId}`. | Show "Access denied" with the required role; do not expose the project/resource name to the caller. |
| `PASSWORD_CHANGE_REQUIRED` | Session is valid but the account still has `users.must_change_password = true` (seeded admin / admin-forced reset). Maps to **HTTP 403**. Fails closed on every role-gated API. | `lib/authz.ts:requireActiveSession()` (called by `requireGlobalRole()` / `requireProjectRole()`). `requireSession()` / `getSessionUser()` stay permissive so the change-password flow itself works. | Route the user to `/change-password`; block all other actions until cleared. |
| `ACCOUNT_INACTIVE` | Session is valid but `users.account_status != 'active'` (pending approval or disabled after an old session was issued). Maps to **HTTP 403**. Credentials sign-in also rejects pending/disabled accounts before session creation. | `lib/authz.ts:requireActiveSession()`; credentials preflight in `web/app/(auth)/actions.ts` and provider verification in `web/auth.ts`. | Show pending-approval or disabled-account guidance; block protected app/API actions until an admin activates or re-enables the account. |
| `EMBEDDING_UNAVAILABLE` | **(ADR-122 — Implemented.)** A transient embedding-provider outage after bounded retry (timeout / 429 / 5xx / network / malformed response); a deterministic provider 4xx (400/401/403/404/422 — everything except 408/429) maps to `CONFIG` instead. The ONLY new code for the Project Brain; all Brain validation reuses `CONFIG` (bad settings / dimension mismatch / brain-not-enabled / deterministic provider 4xx), `PRECONDITION` (Brain migration lineage not provisioned), and `CONFLICT` (exact-dup race). Maps to **HTTP 503** (retryable). On the harvest path it is treated as **transient** — the consumer throws so the `domain_events` cursor holds and the window redelivers; no event is lost. Secrets are NEVER in the message or logs. | `web/lib/brain/openai-compatible.ts` (`embed`/`complete` after retries exhausted); surfaced by the recall/retain ext routes + `memory_recall`/`memory_retain` MCP tools via the new `httpStatusForExtCode` `EMBEDDING_UNAVAILABLE → 503` arm; the `memory_harvest` consumer (throw-and-hold). | "Embedding provider unavailable — retry, or check the platform embedding-provider configuration." Recall/retain stay retryable; the harvest cursor holds and retries next tick. |
| `BUDGET_EXCEEDED` | **(ADR-101 — Implemented.)** The execution-policy `budget` axis hard-cap was breached: a run's token spend reached `hardMaxTokens` (= `maxTokens × MAISTER_BUDGET_HARD_MULTIPLIER` when unset) at `run`/`task` scope, or a `tree`-scope token/wall-clock breach cascade-terminated the run-tree. The budget watchdog calls `deleteSession`, then marks the run terminal `Failed` with this code — NEVER before the session is confirmed stopped/absent (a kill that returns `EXECUTOR_UNAVAILABLE` leaves the run live to retry next tick; a `404` proceeds). Not a thrown 4xx from a route — it is recorded as the run's terminal `errorCode`. | The budget watchdog pass in `web/lib/runs/keepalive-sweeper.ts` (per `runs.run_kind`: flow `markNodeFailed` → `Failed`, agent `finalizeAgentRun` → `Failed`, scratch `markScratchCrashed(terminal:"failed")` → run `Failed` (+ `scratch_runs.dialog_status=Crashed`, the scratch dialog FSM has no `Failed` state)); a `tree` breach goes through `cascadeAbandonRunTree` first. | Run is terminal `Failed` (NON-recoverable — Recover gates on `Crashed`) with `errorCode = BUDGET_EXCEEDED` — same Failed-run remediation surface. The task auto-returns to `Backlog` and the Launch button reappears; the operator may Raise the ceiling at the `budget_breach` escalate HITL (before hard-cap) or relaunch. |

> **ADR-139 Project Automations adds NO new `MaisterError` code** (Implemented).
> It reuses the existing closed union with these exact route and dispatcher
> meanings:
>
> - **`CONFIG` → HTTP 400:** malformed one-time body or `If-Match`, invalid
>   IANA timezone/local time, nonexistent spring-forward wall time,
>   ambiguous fall-back wall time without `earlier`/`later`, invalid opaque
>   cursor, or a stored launch request which can no longer be normalized.
> - **`PRECONDITION` → HTTP 409:** archived project, deleted/terminal/busy/
>   flagged/blocked/unconfigured task, package/Flow/runner incompatibility,
>   or repository/branch/worktree preflight refusal at due dispatch. These are
>   terminal intent outcomes; the dispatch may return its safe DTO instead of
>   treating the completed decision as a transport failure.
> - **`CONFLICT` → HTTP 409:** same idempotency key with a different canonical
>   request, stale/missing/malformed ETag revision, cancel/edit after claim,
>   tick-versus-Run-now winner loss, or stale agent-schedules revision. UI
>   refreshes the safe DTO; it never string-matches the stored message.
> - **`EXECUTOR_UNAVAILABLE` → HTTP 503 when unhandled:** a temporary runner,
>   supervisor, or network failure after a scheduled claim is instead persisted
>   as `RetryWaiting` after one minute, then five minutes (three total claims
>   per `armed_at`). The create and Run-now routes return the resulting safe
>   intent DTO with HTTP 200; the generic error mapping remains HTTP 503 when
>   this error escapes another route. Raw upstream text, paths, and credentials
>   are never stored or returned.
>
> A scheduler item refusal records code-level outcome on its own durable intent
> while the shared dispatcher attempt can still succeed. No new code, status,
> or raw error serialization is introduced.

> **The declared-artifact contract (ADR-037/038) adds NO new `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union). Beyond the `CONFIG` / `PRECONDITION` reuses above, two artifact-contract outcomes have **no thrown code at all**: an unsatisfied `artifact_required` gate records `gate_results.status = "failed"` (the gate-result lifecycle, not an exception); a `human_review` refusal driven by a failed blocking gate is a blocking gate failure (no HTTP code). Neither maps to an HTTP status.

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

> **Capability materialization (ADR-041/044) adds NO new `MaisterError`
> code** (ADR-008 closed union). It reuses three existing codes at new call
> sites (all Designed, Phase 0 spec):
>
> **`CONFIG` new call sites (Designed):**
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
> **`EXECUTOR_UNAVAILABLE` new call site (Designed):**
> - **Newly reachable once a `claude` cell flips to `enforced`** — when a node
>   declares `enforcement: strict` on a capability class that IS `enforced` for
>   `claude` but the resolved executor uses `codex` (which stays `instructed`), the
>   launch gate throws `MaisterError("EXECUTOR_UNAVAILABLE")` (HTTP 503) per the
>   existing `assertNodeLaunchable` code path. This path was unreachable with the
>   all-`instructed` table; it becomes reachable as Phase 5 flips cells. Names
>   the node id + class + resolved agent + suggests an executor whose agent enforces
>   the class.
>
> **`FLOW_INSTALL` new call sites (Designed):**
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

> **Merge enforcement adds NO new `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror)
> closed union; ADR-058/049). Flow-run promotion and `pull_request` mode reuse three
> existing codes at new `promoteRun` call sites (all Implemented):
>
> - **`PRECONDITION` → HTTP 409** — promote-time config/precondition refusals: PR-mode
>   preflight (provider CLI `gh`/`glab` missing on PATH; `GITEA_TOKEN`/`GITVERSE_TOKEN`
>   unset for the gitea-family REST adapter; remote not configured; push rejected for a
>   config reason; `generic` provider unsupported); target branch invalid/missing;
>   target-drift (target advanced since the ReviewPanel rendered, no `allowTargetDrift`
>   override — Codex F6); readiness not-ready/stale (the second `assertEvidenceReady`
>   re-gate); a legacy run predating the promotion gates lacking derivable branch
>   metadata (Codex F4). The run stays `Review`; no durable claim is taken.
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

> **The workbench adds NO new `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror)
> closed union; ADR-064/052/053). The workbench reuses one existing code (`CONFIG`)
> at new call sites (all Implemented), plus a bare HTTP 404 status and RSC
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

> **The workbench lifecycle adds NO new `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror)
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

> **Flow Studio + the MCP/runner catalogs (ADR-065/070) add NO new `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union). They reuse four existing codes at new call sites (all Designed):
>
> **`CONFIG` new call sites (Designed):**
> - **Invalid manifest on draft save / publish** — `validateGraphManifest` + `compileManifest` hard-gate in the flow editor draft PATCH and publish-local routes; invalid manifest → `CONFIG` (422), draft row unchanged.
> - **Unknown MCP/skill ref in manifest** — resolved by the carve-b validation extended to flow-package `mcps?` top-level declarations; unknown ref → `CONFIG` (422).
> - **Required MCP unresolved at launch** — `launchRun` after the unknown-cap-ref check; a REQUIRED MCP that cannot resolve+materialize → `CONFIG` (409).
> - **version-binding bad enum** — `PATCH /api/projects/{slug}/flows/{flowId}/version-binding` with a value outside `{pinned, latest}` → `CONFIG` (422).
> - **Bridge of invalid package** — `installAuthoredFlowPackageBridge` on an invalid authored package → `CONFIG` (422).
>
> **`CONFLICT` new call sites (Designed):**
> - **Stale `expectedDraftVersion`** on the flow editor draft PATCH → `CONFLICT` (409), row unchanged.
> - **Platform MCP delete while referenced** — `DELETE /api/admin/mcp-servers/{id}` when usage references exist → `CONFLICT` (409) (mirrors the `assertCanDisable` runner-CRUD guard).
>
> **`PRECONDITION` new call site (Designed):**
> - **Platform MCP delete of unknown id** — `DELETE` or `PATCH` against an unknown `mcp-servers/{id}` → `PRECONDITION` (409) (mirrors the runner-CRUD unknown-id guard).
>
> **`EXECUTOR_UNAVAILABLE` new call site (Designed):**
> - **Required MCP agent-unsupported (strict)** — a REQUIRED MCP cannot materialize because the resolved agent does not support it → `EXECUTOR_UNAVAILABLE` (503). Non-REQUIRED (additional) MCP absence is non-fatal.

> **The platform-user + project-member admin surface (ADR-062) reuses existing codes and adds none** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union). New call sites for `CONFIG` (invalid body/Zod — HTTP 422), `CONFLICT` (duplicate email, duplicate member, raced CAS — HTTP 409), `PRECONDITION` (hard-delete of referenced/non-pending user, add nonexistent user, self-delete — HTTP 409), and `UNAUTHORIZED` (role gate — HTTP 403) are noted in the relevant rows above.

> **Model discovery + application adds NO new `MaisterError` or `SupervisorErrorCode`**
> ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union;
> [ADR-076](decisions.md#adr-075)). The model-catalog resolver and the configured-model
> application reuse existing codes at new call sites (all Implemented). The governing
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

> **The platform-agent substrate (ADR-089/090) reuses existing codes and adds none**
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

> **Flow Studio Phase C (ADR-096) adds NO new `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union). It reuses three existing codes at new call sites (Designed — editable local packages):
>
> - **`PRECONDITION` → HTTP 409** — a local-package file op (`GET/PUT/DELETE/move` under `/api/studio/local-packages/{id}/files/...`) whose artifact `path` escapes the row's `working_dir` (realpath containment rejecting `..`, absolute paths, symlink escape, or any `.git/` path). The `resolveWithinWorkingDir` guard throws before any write.
> - **`CONFIG` → HTTP 422** — a local package whose `working_dir` is missing or malformed (manual deletion, bad scaffold).
> - **`CONFLICT` → HTTP 409** — a working-dir write attempted without a live session edit-lock (the lock is held by another session, or the caller's lock expired / was taken over). The session-scoped lock mirrors `runs.keepalive_until`.
>
> Thrown by `web/lib/local-packages/*` (the `resolveWithinWorkingDir` confinement helper + the lock service's `assertHoldsLock`) and the `/api/studio/local-packages/*` routes. The cut-version path reuses the installer's existing `FLOW_INSTALL` on clone/install failure.

> **The ADR-121 task queue reuses existing codes and adds none**
> ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union).
> New call sites:
> - **`CONFLICT` → HTTP 409** — a gating-kind (`blocks`/`depends_on`/`requires`)
>   relation create that would close a dependency cycle, evaluated INSIDE the
>   insert transaction under a per-project advisory lock (no TOCTOU). Thrown by
>   `addTaskRelation` (`web/lib/social/relations.ts`); surfaces at BOTH the web
>   relations route and the ext relations route (`relations:create`). UI action:
>   surface "would create a dependency cycle" and leave the edge unsaved.
> - **`CONFIG` → HTTP 422** — out-of-set `priority` or out-of-range
>   `triage_confidence`/`confidence` on the human task PATCH or the ext triage op
>   (the DB CHECK is the final backstop). `taskQueueSettings` with an unknown key
>   or `maxInFlightAuto < 1` on the project settings PATCH.

> **The orchestrator engine (ADR-098) reuses existing codes and adds none**
> ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union).
> The orchestrator / delegation paths (`run_delegate` / `run_plan` / `run_collect`
> / `run_cancel` / `run_message` / `run_promote` / `run_rework` over the MCP
> facade, the governed run-tree, and the idle-checkpoint wait/resume) map onto the
> existing closed union. **(Implemented, ADR-098/099/100.)** New call sites:
> - **`PRECONDITION` → HTTP 409** — a `run_delegate` / `run_plan` naming an agent
>   not resolvable through the project's enabled + trusted catalog (unresolvable /
>   untrusted delegation target — "resolve+trust" is physically separate from
>   "launch", and **no child run is created** on refusal); a cross-batch
>   `dependsOn` / `requires` reference outside the plan being written; **a run-bound
>   ext token whose orchestrator has TERMINALIZED** (`Done`/`Failed`/`Crashed`/
>   `Abandoned`) on any of delegate/plan/collect/cancel/promote/rework/message
>   (`resolveActiveBoundRun` fail-closed — a stale token cannot mutate a terminal
>   tree; Codex adversarial review). **(Implemented — ADR-102)** Three shared-tree
>   `run_promote` refusals: the promote-time **settled-gate** is not met (a shared
>   sibling, same `root_run_id`, is still in a writable status — the complement of
>   `SETTLED_RUN_STATUSES`); the promote target is **not a shared child / has no
>   resolvable tree workspace** (no `(root_run_id, workspace_mode='shared')` row);
>   or **nothing is in `Review`** (the tree was already promoted — an idempotent
>   no-op). All map to HTTP 409; no merge runs and no sibling is flipped.
> - **`CONFIG` → HTTP 422** — a flow declaring an `orchestrator` node with
>   `compat.engine_min < 1.6.0` (engine floor); an over-`max_fanout` /
>   over-`max_depth` request (bounds, enforced pre-tx); a cyclic task DAG in
>   `run_plan`; a `strict` path-scope enforcement declaration (the Phase-2 policy
>   gap — refused until [ADR-099](decisions.md#adr-099-persistent-swarm-layer-2--addressable-sessions-star-routed-messaging-worktree-modes-per-agent-read-only) lands). A `workspace_mode: shared`
>   delegation with a writable worktree is NO LONGER a `CONFIG` launch gate — the
>   shared-tree review/promote model is specified in
>   [ADR-102](decisions.md#adr-102-shared-worktree-tree-level-reviewpromote-ownership)
>   (Designed); see the shared-tree promote refusals under `PRECONDITION`/`CONFLICT`
>   below.
> - **`CONFLICT` → HTTP 409** — a concurrent orchestrator resume (two child-settle
>   events racing the same `WaitingOnChildren → Running` wake); a merge conflict
>   promoting a reviewed child (`run_promote` or as-plan auto-promote, ADR-100) —
>   the child stays in `Review`, never auto-resolved. **(Implemented — ADR-102)** A
>   shared-tree `local_merge` conflict on the single tree-promote: ALL shared
>   children of the tree STAY `Review`, no sibling is flipped (the conflict path
>   runs BEFORE the cross-tree settle flip), never auto-resolved. A concurrent
>   shared tree-promote that loses the promotion durable-claim CAS on the shared
>   `workspaces` row also resolves `CONFLICT` (one winner merges; the losers are
>   no-ops). A `run_rework` on a shared child is refused `CONFLICT` while the tree
>   promote is in progress / done (the rework fences on the allocator-`workspaces`
>   row's `promotion_state ∈ {'claiming','done'}` under FOR UPDATE — `reworkChildRun`
>   serializes with the promote claim/finalize so the git target is never mutated
>   before the settle).
> - **`CHECKPOINT`** — an orchestrator `session/resume` failure when waking from
>   `WaitingOnChildren` (terminal resume failure, same class as the idle-checkpoint path).
> - **`EXECUTOR_UNAVAILABLE` → HTTP 503** — a child-run spawn or concurrency-cap
>   failure during delegation (retryable).

> **The shared-worktree tree-level review/promote model (ADR-102) adds NO new
> `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror)
> closed union; **Implemented — ADR-102**, supersedes ADR-099 §4's launch gate). The
> single tree-level `run_promote` for a `workspace_mode='shared'` writable tree
> reuses two existing codes at new call sites (folded into the orchestrator block above):
> **`PRECONDITION` → 409** for the promote-time settled-gate, a target that is not a
> shared child / has no resolvable tree workspace, or nothing in `Review` (already
> promoted); **`CONFLICT` → 409** for the `local_merge` tree conflict (all shared
> children stay `Review`) and the lost promotion durable-claim CAS. There is NO
> `CONFIG` launch gate for shared writable worktrees any more.

> **ADR-108 (guardrail/hook engine) adds NO new `MaisterError` code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror)
> closed union; **Designed**). A guardrail trip is a recoverable escalation
> (`Running → NeedsInput` + a `hook_trip` HITL), never a terminal `Failed` — so no
> new discriminant. An invalid `hooks` block (negative caps, empty `allowedPaths`,
> unknown lifecycle) reuses **`CONFIG`** at compile/load; a `strict`
> `enforcement.hooks` declaration reuses the existing ADR-032 strict-refusal branch
> (`CONFIG` / `EXECUTOR_UNAVAILABLE`). The deterministic supervisor enforcement is
> not modeled as a thrown code (the ADR-041 static table stays frozen).

> **ADR-107 (version-adopt launch) + ADR-113 (PR-to-source) add NO new `MaisterError`
> code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union;
> **Implemented**). Version-adopt launch reuses **`CONFLICT`** (an
> `adopt`/`cut_and_adopt` option not in the launch-detected available set, or a
> `cut_and_adopt` on a package locked by another session) and **`PRECONDITION`** (a
> `cut_and_adopt` whose cut gate fails artifact validation — the launcher can still
> `keep`). PR-to-source reuses **`CONFLICT`** (`targetSourceId` not in the
> `package_sources` allow-list; a non-fast-forward push — retryable), **`PRECONDITION`**
> (an invalid branch name at the git sink; auth / no reachable remote), and **`CONFIG`**
> (no source url / unsupported provider for the PR). Two-phase publish leaves the
> `last_pushed_branch`/`last_pr_url` markers unset on any failure.

> **The unified runner & session model (ADR-114) adds NO new `MaisterError`
> code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror)
> closed union; Designed). An undefined `session:` reference, a `consensus` node
> placed inside `sessions:`, an unbound runner slot at load, or any other
> invalid/unbound session graph reuses **`CONFIG`**; a runner slot that resolves
> to no concrete host runner (no binding + no auto-match) reuses
> **`EXECUTOR_UNAVAILABLE`**. A session switch whose adapter does not advertise
> `sessionCapabilities.resume` reuses the existing supervisor **`CHECKPOINT`**
> terminal-resume failure. New call sites: `web/lib/config.ts`
> (`loadFlowManifest` session validation), `web/lib/acp-runners/resolve.ts`
> (per-session resolution), and the `POST /api/runs` launch precondition.

> **Run continuation controls (ADR-159 / ADR-160) add NO new `MaisterError`
> code** ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror)
> closed union). Both features reuse existing codes at new call sites:
>
> - **`PRECONDITION` → HTTP 409 (ADR-159, Implemented):** a rework claim refused by
>   any eligibility term — `runs.status` not `Review`, `run_kind` not `flow`
>   (the message names branch sync / relaunch, because an agent run has no
>   `node_attempts` to anchor on), `parent_run_id` set, `workspace_mode`
>   `shared`, a launched evaluation lineage, an absent or `removed_at`
>   workspace, or an unresolved re-entry node (the message names the relaunch
>   escape hatch). Also on return: the run is not `HumanWorking`, the claim is
>   an ADR-030 takeover rather than a `review_rework_claim`, the requested
>   `remote` is not in the `listRemotes()` allow-list, or the fetch left the
>   branch non-fast-forwardable — the last carries `{command, localSha,
>   remoteSha, aheadBy, behindBy, instructions[]}` as advisory detail so the UI
>   can render a copyable block. **`PRECONDITION` → HTTP 409 (ADR-160,
>   Designed):** an interrupt refused by any admission term — the run is not
>   `Running`, not a flow run, has no `Running` node attempt, or the node is
>   `cli`/`check` (the message names the deferral explicitly; interrupting a
>   detached process group is out of v1 scope).
> - **`CONFLICT` → HTTP 409 (ADR-159, Implemented):** the `Review → HumanWorking`
>   CAS lost to a concurrent claimer; the global concurrency cap was full at
>   claim time (**never** queued as `Pending` — the scheduler cannot start a
>   human); a return against a dirty worktree or with a zero-commit range.
>   **(ADR-160, Designed):** the `Running → NeedsInput` CAS lost to the node's
>   own completion, or a restart refused because the run already holds
>   `MAISTER_MAX_OPERATOR_RESTARTS` attempts carrying
>   `decision='operator_interrupt'`.
> - **`UNAUTHORIZED` → HTTP 403 (ADR-159, Implemented):** a return or release
>   attempted by an actor other than the claim's `owner_user_id`. **(ADR-160,
>   Designed):** a machine/agent token answering a `node_interrupt` HITL —
>   refused at the `respondToHitl` chokepoint before any mutation, the same
>   human-actor-only posture as `hook_trip`.
> - **`CONFIG` → HTTP 400 (ADR-159, Implemented):** a flow manifest declaring the
>   flow-level `reentry` field below engine floor `3.5.0`, or naming a node id
>   absent from the compiled graph (the message names the id).
> - **`EXECUTOR_UNAVAILABLE` → HTTP 503 (ADR-159, Implemented):** the return's
>   single ledger transaction failed — the run stays `HumanWorking` with the
>   claim open and the operation is fully retryable. **(ADR-160, Designed):**
>   the pre-transaction `checkpointSession` was undeliverable; it **re-throws
>   with no mutation**, so the run stays `Running` and there is no split-brain.
>
> Two outcomes have **no thrown code at all**: gates staled by a rework return
> move through the ordinary `gate_results` lifecycle, and a `checkpoint_ref`
> missing at restart time **degrades to workspace policy `keep` with a WARN**
> rather than throwing — it is never guessed.

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

## Token / external-API auth (Implemented)

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
| **404** | Token's project ≠ addressed resource (existence-hide). Also: unknown or non-`external_check` gate; unknown task or run id. **(Implemented)** on HITL ext routes: `run.projectId ≠ token.projectId`, or unknown `runId`/`hitlRequestId`, or `hitlRow.runId ≠ runId` — all return 404 without distinguishing which check failed (existence-hide). |
| **409** | Domain conflict — a gate report on a terminal run (`Done`/`Abandoned`/`Crashed`/`Failed`), or a launch/create precondition conflict (`CONFLICT`/`PRECONDITION` from the shared service). **(Implemented)** on the HITL respond ext route: idempotency conflict when the HITL request already has a `respondedAt` timestamp (the shared `respondToHitl` service returns 409, same as the session route). |
| **422** | Request body failed schema validation, or a `CONFIG` `MaisterError` from the shared service (unknown flow/executor, invalid config). Mapped by the shared `httpStatusForExtCode`. **(Implemented — `NEEDS_INPUT`)** on the HITL respond ext route: bad response payload — `response` body fails the `respondToHitl` service validation (unknown `optionId`, out-of-range `confidence`, schema mismatch) — mapped from `MaisterError("NEEDS_INPUT")` to 422. |
| **503** | **(ADR-122, Implemented — `EMBEDDING_UNAVAILABLE`)** on the memory ext routes (`GET/POST /api/v1/ext/projects/{slug}/memory`) + `memory_recall`/`memory_retain` MCP tools: the embedding provider is unreachable after bounded retry. Requires the new `httpStatusForExtCode` `EMBEDDING_UNAVAILABLE → 503` arm — without it the code would fall to the `default: 500` and the OpenAPI contract would lie. Retryable. |

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

## Typed Plan-review refusal (Implemented — ADR-137)

Malformed or missing `plan-review.json`, a missing immutable output, or an
invalid Plan-review capability fails before a review card with existing
`CONFIG` or `PRECONDITION` semantics. Exhausting `max_decision_reworks` is a
`PRECONDITION` refusal before child creation. A stale, terminal, malformed, or
conflicting decision response uses the existing `CONFLICT`/`PRECONDITION`
classification; no new error code is introduced.
