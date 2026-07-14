# Patch: Plan-review handoff recovery

- Date: 2026-07-14
- Severity: high
- Area: Plan-review decision requests, HITL handoff, run detail

## Problem

If the process stopped after persisting a Plan-review decision answer but before
the response marker and graph wake-up were durable, the parent request could
remain stranded. The review also found that the decision API accepted extra
properties, rework counting crossed graph-node boundaries, and the run page
exposed only one unresolved decision.

## Root cause

The original response path owned both durable intent and its side effects, but
the reconciliation sweep did not claim incomplete decision handoffs. Zod parsed
unknown JSON properties away before the service validated the decision payload.
The runner counted all prior Plan-review parents in a run rather than only the
current graph node.

## Solution

Startup and periodic reconciliation now claims valid incomplete decision
handoffs, rewrites the answer input when needed, completes the durable marker,
and asks the cap-aware graph scheduler to resume. Parent-level advisory locking
serializes child decisions and parent rework. The route preserves raw object
keys so decision children accept exactly `{ optionId }`. Run detail now exposes
all unresolved requests, and the UI shows their count and restores focus after
an answer.

## Prevention

Regression coverage includes recovery before and after the response marker,
idle-cap recovery, parent-versus-child races, external authorization denial, a
real PostgreSQL migration check, exact-payload route validation, node-scoped
rework bounds, and the authenticated browser journey. ADR, API, database,
analytics, and screen contracts describe the implemented behavior.

## Tags

`plan-review`, `hitl`, `reconciliation`, `api-contract`, `accessibility`
