# Crashed-run recovery over the external API

**Date:** 2026-09-11
**Status:** Shipped (2026-09-11) — `runs:recover` scope, both ext routes,
`run_recover`/`run_discard` MCP tools; recorded as the ADR-034 amendment of the
same date. Current truth lives in
[`../system-analytics/external-operations.md`](../system-analytics/external-operations.md).
**Touches:** ADR-034 (amendment), ADR-040/041/042 (external surface)

## Problem

A run driven entirely through `/api/v1/ext/*` with a project token loses its
adapter and the startup reconciler flips it to `Crashed`. Every other lifecycle
verb is externally reachable — launch, promote, sync, reopen, rework, cancel,
collect, delegate, message, plan, HITL respond — but `recover` and `discard`
exist only as internal routes behind `requireActiveSession` + `recoverRun`. The
automation stalls on a human with a browser.

Found while driving `academic-lesson` (project `aidev-mipt-course`) end-to-end
over the external API: `claude-agent-acp` hung with no TCP sockets and no CPU,
reconciliation crashed the run, and nothing token-driven could continue it.

## Verdict: gap, not a deliberate limitation

1. **ADR-034 constrains the permission, not the caller.** Its only statement
   about who may recover is RBAC: a new project action `recoverRun`, min role
   `member`, "distinct from `launchRun`, so recovery permission is granted
   independently of launch." `PROJECT_ACTION_BY_SCOPE` exists precisely to
   project those actions onto tokens.

2. **"Explicit human Recover" is an anti-*implicit* rule.** The phrase appears
   in the reconciler classification table
   (`reconciliation-gc.md`, the `agent-session-gone` and `cli-not-retry-safe`
   rows). Its invariant is that the reconciler must not silently auto-resume a
   mid-turn agent or re-run a half-executed `cli`. A caller issuing
   `POST …/recover` has made that explicit decision; it is carried by a token
   rather than a cookie.

3. **The risk ordering is currently inverted.** `runs:promote` merges a branch
   into the target branch and `runs:sync` rebases/merges with an AI conflict
   resolver — both mutate the operator's repository, both are externally
   reachable. Recover resumes an already-authorized session in an existing
   worktree under the same concurrency cap. No risk model ranks the first as
   safe to automate and the second as not.

4. **ADR-034 already built the properties an automated caller needs.** Phase-1
   CAS on `status='Crashed'` makes a concurrent second call a 409 with no
   double-spawn; cap re-admission means recover cannot bypass
   `MAISTER_MAX_CONCURRENT_RUNS`; the durable marker commits before any
   supervisor side-effect; and `discard-only` / `unresumable` are *terminal*
   classifications (409/410), not retryable ones. A bot in a retry loop
   collects refusals, not damage.

5. **`resumeCrashedRun` is already session-free** — no actor, no
   `requireActiveSession`, no `projectId`. The entire coupling to a browser
   lives in the route file.

## Why discard ships with recover

Recover's own refusals instruct the caller to discard — *"run has no resumable
session — discard it instead"*, *"the stored acp session is unresumable —
discard the run"*. Shipping recover alone means the API tells automation exactly
what to do next and then refuses to let it do it.

Discard is also how an automated caller *ends* an attempt it cannot recover. It
flips the run `Abandoned`, archives the branch, releases the worktree, and emits
`run.abandoned` to the webhook and domain-event planes. Without it, a
token-driven run that recover refuses stays `Crashed` with a live worktree in the
Crashed lane until the 7-day GC sweep, and every consumer waiting on a
run-terminal event waits that long too.

It is **not** a precondition for relaunching — `RUN_STATUS_LAUNCHABILITY.Crashed`
is already `launchable`, so the task can be launched again with the crashed run
left in place. Discard closes out the failed attempt; it does not unblock the
next one.

`discardWorkbench` is worktree-destructive, but preserve-then-prune (ADR-035)
archives the branch first, and `drop` is already enabled for `Crashed` in
`deriveWorkbenchLifecycleActions`. The `human-owned` wall still stands: the
token path pins `viewerUserId = null`, so the ADR-160 owner carve-out can never
open for a token — the same fail-closed treatment `stopWorkbenchRunForToken`
already applies.

## Design

### Scope

One new token scope, `runs:recover`, mapped to the existing `recoverRun`
project action in `PROJECT_ACTION_BY_SCOPE`. Both operations share it because
ADR-034 designed them as one RBAC pair under one action — a second scope would
be two mappings onto one action, free to drift.

It is **not** added to `AGENT_TOKEN_SCOPES` and **not** to
`CROSS_PROJECT_AGENT_SCOPES`: no `runs:*` scope is, and an agent must not spend
another project's execution budget or terminate its runs.

### Routes

`POST /api/v1/ext/runs/{runId}/recover` and
`POST /api/v1/ext/runs/{runId}/discard` — path-param, empty body, matching both
the internal route shape and the existing `[runId]` ext routes
(`/activity`, `/readiness`, `/hitl`). The project comes from the token; the run
is existence-hidden against it with a `404` inside `work`, the load-bearing
check that `resumeCrashedRun` (which takes no `projectId`) cannot make itself.

### Shared outcome mapping

`RecoverResult` → HTTP status + typed body moves out of the internal route into
a pure `web/lib/runs/recover-http.ts`, imported by both surfaces. A copy would
drift, and the divergence is already latent: the internal route answers
`unresumable` as `410 CHECKPOINT`, while `httpStatusForExtCode` has no
`CHECKPOINT` case and would default it to `500`. One module, one answer.

`discard` reuses `httpStatusForExtCode` — it throws `MaisterError` like every
other lifecycle op.

### MCP facade

`run_recover` and `run_discard` tools over the same two routes. The facade
already carries `run_launch`/`promote`/`sync`/`reopen`/`rework`/`cancel`;
without these an agent hits the identical wall.

## Verification

1. Scope + mapping → a test asserts `runs:recover` maps to `recoverRun`, and
   that it is absent from the agent and cross-project sets.
2. Token-path discard → refuses a foreign project, pins `viewerUserId = null`.
3. Routes → missing scope `403`, foreign run `404`, each `RecoverResult` state
   maps to the same status the internal route returns, audit row written.
4. MCP tools → build the expected request.
5. `pnpm --filter maister-web lint` and the touched suites green.
