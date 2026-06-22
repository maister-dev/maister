# /aif-plan request — Plan 2: Vendor-neutral guardrail/hook engine at the supervisor ACP seam (G4)

> **Sequencing:** run this AFTER Plan 1 (`decide` routing + P7) lands — it can
> reference the routing/`on_stuck` plumbing. Run `/aif-plan` (full mode) with this
> file as the brief, in its own branch/worktree.
> **Workflow mandate:** SDD-first (ADR + domain doc + UI design), then strict TDD.

## Goal (one line)

Give MAIster a **deterministic, vendor-neutral guardrail layer at the
supervisor ↔ ACP seam** — the one loop-engineering safety primitive maister
lacks. It inspects the agent's tool-call / file-edit stream live and enforces
declarative rules that gates (post-node) and the token/time budget (ADR-101,
too coarse) cannot. This is what makes unattended overnight loops safe (it
prevents the "$47k in 11 days" / "$1.3M/month swarm" failure modes that limiters
on token-spend alone do not catch).

## Why this is a genuine missing MECHANISM (not assembleable)

- There is **no `hook` capability class** today. `restrictions` is
  **instructed-only** (the model can ignore it). cost/time/regex guards are
  **metric-only** (they do not block). `permissionMode` is coarse and
  claude-native. Gates run **between nodes** (too late). The token/wall-clock
  **budget (ADR-101)** is blunt (it kills on totals, not on bad behavior).
- A rule like "halt if the agent repeats the same tool call 3× in a row" or
  "block any edit outside `src/` before it is written" requires inspecting the
  **in-session ACP tool-call stream** — only the supervisor sees it. It cannot be
  composed from flows/gates/agents.
- **Precedent already exists to generalize:** the supervisor already does
  inline, hardcoded enforcement for ONE case — L1 `readOnlySession` arbitration +
  L3 dirty-watchdog quarantine for read-only agent runs (see
  `docs/system-analytics/agents.md`, ADR-090, `supervisor/src/acp-client.ts`).
  This plan turns that single hardcoded policy into a **declarative engine**.

## Scope — generalize L1/L3 into a declarative lifecycle-hook engine. MVP = 3 rules

(The three rules come straight from the loop-engineering articles' required
safeguards; they are the highest-value first set.)

1. **Repetition circuit-breaker** — halt / escalate when N identical tool calls
   (same tool + same args) fire consecutively (anti-spin; the common form of
   "silent death" where the agent is alive but stuck).
2. **Path-scoped write-guard (pre-hoc)** — block file edits outside the declared
   writable path set, **before** the write (blast-radius). This is the pre-hoc
   counterpart to today's post-hoc `must_not_touch` mutation sensor (ADR-074).
3. **No-progress watchdog** — no new diff / artifact produced in N turns →
   halt / escalate (productive-liveness, not just the process-liveness that the
   supervisor heartbeat + crash reconcile already cover).

### Engine shape
- New declarative **`hooks` capability class** (declared on a node/agent, resolved
  + materialized like the other capability classes, M14/M35), with lifecycle
  points: `pre_tool_call`, `post_file_edit`, `pre_commit` (extensible).
- **Backends:** native (claude settings hooks) where the adapter supports them,
  + **supervisor-side ACP-stream interception** as the universal fallback for
  adapters without native hooks (codex/gemini/opencode). The supervisor backend
  is the load-bearing one.
- On a rule trip: deterministic action (halt / escalate), funnel through
  `logExecPolicyAction`, honor the execution-policy `onStuck` axis (escalate →
  assigned HITL; notify_only → HITL without assignment), emit `run.escalated`.

## Relationship to existing mechanisms (compose, don't duplicate)
- **ADR-101 budget** = token / consecutive-failure / wall-clock ceilings (totals).
  Hooks = per-tool-call behavior. Complementary; do not re-implement budget.
- **Execution-policy axes (ADR-095)** — reuse `onStuck` + the `logExecPolicyAction`
  audit boundary for hook trips.
- **ADR-041 strict-capability enforcement flip is FROZEN/deferred — this plan is
  SEPARATE.** Hooks are deterministic supervisor-side enforcement, not the
  strict-vs-instruct capability debate. Do NOT reopen ADR-041.

## SDD requirements
- New ADR for the guardrail/hook engine (next free number — confirm at plan time).
- New (or extended) `docs/system-analytics/*` domain doc for the hook engine
  (lifecycle points, backends, rule schema, trip actions).
- `hooks` capability-class addition to the capability/materialization model + the
  Studio/settings UI to declare hooks (per `web/CLAUDE.md` conventions).
- Config/env (caps: N-for-repetition, N-turns-for-no-progress, writable-path set).

## TDD requirements
RED → GREEN → refactor per rule. Minimum coverage:
- Repetition breaker trips at exactly N identical tool calls; resets on a different call.
- Path-guard blocks an edit outside the writable set **before** write; allows inside.
- No-progress watchdog trips after N no-diff turns; resets on real progress.
- Trip → `logExecPolicyAction` + `onStuck` routing + `run.escalated` emitted.
- Cross-adapter: supervisor-side backend enforces for an adapter without native hooks.

## Out of scope
- ADR-041 strict-capability enforcement flip (stays frozen).
- USD / cost economics (token-only per ADR-101).
- Hook rules beyond the 3 MVP (e.g. secret-scan pre-commit) — fast-follow once the engine exists.

## Dogfood validation target (per the loop-engineering articles' own advice)
Assemble a **capped nightly ralph-loop** on a boring task (CI-triage / weekly
dependency-bump) using existing pieces — `crashRetry: ralph_loop` (preset
`unattended`) + a `run_schedule` cron + ADR-101 budget + blocking gates — and
confirm the hook engine catches the tool-call-level failure modes that
token/time budget alone misses.
