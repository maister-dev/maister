# Human-ask review remediation: lifecycle and successor atomicity

**Date:** 2026-07-14
**Severity:** high

## Problem

The standalone Human-ask lifecycle could permanently fail a durable
`pending_termination` intent when its already-listed supervisor session exited
before DELETE. A supervisor 5xx was likewise reduced to a permanent protocol
failure. A live session with the same run but a different ACP identity could be
mistaken for absence.

Separately, a new task-bound agent run was committed before it superseded an
active Human-ask. A process failure in that interval could let a scheduler
promote the successor while an actionable stale clarification remained. Generic
agent finalization could also win the terminalization race and turn a
worktree-backed source into `Review`, leaving its ask pending forever.

## Root cause

- The generic supervisor client discarded HTTP status semantics needed only by
  the bound Human-ask delete operation.
- Supersession opened its own transaction after the successor persistence
  transaction had committed.
- Source finalization had no durable-intent check, so ACP exit processing could
  publish a competing terminal outcome.

## Solution

- Added a scoped `deleteSessionIfPresent` operation: a bound-session 404 is
  `gone`, while 5xx/network are `EXECUTOR_UNAVAILABLE`; other 4xx remain
  permanent failures. `listSessions` now classifies 5xx as unavailable too.
- Reject a live same-run session whose ACP id differs from the stored binding.
- Normalize eligible source terminal states to `Done` and revoke agent tokens
  in Human-ask activation and answer/replay recovery.
- Moved successor supersession into the successful `launchAgentRun`
  transaction through an explicit transaction-scoped helper.
- Deferred generic `finalizeAgentRun` while a durable pending Human-ask owns
  the source terminal transition.
- Corrected the database and analytics contracts and made the SDD failure
  matrix explicit.

## Prevention

- Treat list-then-delete as a two-step external-effect protocol: classify a
  scoped absence separately from transport availability and identity misuse.
- When one durable intent owns a terminal state, guard the shared finalization
  choke point rather than only its current caller.
- Any successor-created supersession must live in the same transaction as the
  successor's durable insert; prove rollback with a real database failure.
- Test task-level answer and successor races as mutually exclusive terminal
  outcomes, not merely final happy-path rows.

## Verification

- RED: supervisor transport tests failed before the scoped deletion API and
  5xx classification existed.
- Focused real-Postgres regression suite: 99 tests, then 21 tests covering the
  added concurrency and rollback cases.
- `pnpm --dir web test:unit`
- `pnpm --dir web test:integration`
- `pnpm --dir web typecheck`
- scoped ESLint with zero warnings
- `CI=true pnpm validate:docs:all`
- `CI=true pnpm validate:contracts`
- `git diff --check`

## Tags

`#human-ask` `#hitl` `#acp` `#transactions` `#concurrency` `#tdd`
