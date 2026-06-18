# Execution-control policy (unattended handoff) — design

- **Date:** 2026-06-18
- **Status:** Draft (brainstorm), pending `/aif-plan`
- **Scope:** web + supervisor + one migration. Touches the launch path and the
  graph engine. No new adapter binaries.
- **ADR:** next-free (≥ ADR-093) — assign at implementation; do not hard-pin
  here (ADR-093 is tentatively claimed by Flow Studio Phase C in another
  worktree).
- **Umbrella:** this is **Group B (human escalation)** of the broader axis map in
  [`2026-06-18-flow-execution-control-policy-plan.md`](2026-06-18-flow-execution-control-policy-plan.md).
  Per the umbrella's v2 reframe, the machine **self-correction** loop (Group A:
  crash-retry, rework, check-strictness) sequences **first** (Phase 1) and this
  HITL handoff **second** (Phase 2) — and the human-gate auto-pass below fires
  **only after machine review has passed**. Read the umbrella for the
  self-correct-then-escalate model.

## Problem

A flow run can only run **supervised**: it stops at every agent tool-permission
prompt and every `human` / `human_review` gate, waiting for a person. There is
no way to launch a run that **hands off to the end unattended** — useful for
batch delivery, overnight runs, low-risk flows, and (later) agent-triggered
launches.

The launch popover already exposes runner, flow, branches, and delivery policy.
The owner asked for one more launch-time field: an **execution-control policy**
("something like skip-human-gates for a handoff to the end") and flagged the
real hard part — **"how to adapt skip-permissions for the other runners."**

## Goals

1. A launch-time **execution-control policy** selectable in the launch popover
   and persisted on the run (snapshot, like `runner_snapshot`).
2. A **full unattended** mode: the run reaches a terminal state (promote / fail)
   without any HITL stop — auto-approving agent tool permissions **and**
   auto-passing human gates.
3. The permission-autonomy half works for **every runner adapter**
   (`claude | codex | gemini | opencode | mimo`), not just `claude`.
4. Honest visibility: the task page and run surfaces show the effective policy;
   an unattended run is clearly badged.
5. Safe by construction: unattended is **opt-in per launch**, authz-gated,
   audited, and never overrides the read-only enforcement contour (ADR-090/041).

## Non-goals

- Auto-launching agents on a schedule/trigger (M34 substrate exists; that is a
  separate consumer of this policy, not part of it).
- Skipping **automated** gates (`command_check`, `skill_check`, `ai_judgment`,
  `artifact_required`, `external_check`). Unattended skips **human** bottlenecks
  only; automated gates still run and still block — that is the safety floor.
- Changing ADR-041 (capability enforcement stays advisory) or the read-only
  enforcement layers (ADR-090).
- A cost/time budget ceiling (deferred per owner, 2026-06-16).

## Background — what exists today (grounded in code)

The "stop and wait" behaviour has **three independent sources**. Only by
addressing all three does a run actually go end-to-end.

### A. Agent tool permissions (ACP `requestPermission`) — supervisor-side

- A coding-agent node runs as an ACP session. When the agent wants a
  mutating/asking tool, the adapter calls ACP `requestPermission`, handled in
  `supervisor/src/acp-client.ts:289`. The handler already has an **inline
  arbitration** seam used by other features **before** any HITL row is created:
  - L1 read-only **session** decision — `resolveReadOnlySessionDecision`
    (`acp-client.ts:303`, ADR-090).
  - L2 read-only **turn** auto-reject — `resolveReadOnlyAutoReject`
    (`acp-client.ts:337`, ADR-078).
  - Otherwise the request becomes a `hitl_requests` row and the run goes
    `NeedsInput` (`lib/flows/runner-agent.ts:290` →
    `createHitlAssignmentForRun`).
- Existing bypass is **adapter-native and claude-only**:
  - `runner.permission_policy: dangerously_skip_permissions`
    (`lib/config.schema.ts:615`) → supervisor adds the Claude CLI flag
    `--dangerously-skip-permissions` (`supervisor/src/runner-provisioner.ts:97`).
    For **any other adapter the supervisor throws `EXECUTOR_UNAVAILABLE`**
    ("permission policy is unsupported by `<adapter>`",
    `runner-provisioner.ts:89-95`).
  - Capability `permissionMode: allow` → `bypassPermissions` in
    `.claude/settings.local.json` (`lib/capabilities/agent-map.ts:63,118`) — also
    gated on `isClaude`.
- An adapter launched with its native bypass **never calls `requestPermission`**
  (`acp-client.ts:336`), so supervisor-side arbitration is moot for it.

### B. Human nodes & `human_review` gates — web/engine-side

- A `human` node creates a HITL assignment and waits
  (`lib/flows/runner-human.ts:216`).
- A `human_review` **gate** blocks at node finish
  (`lib/flows/graph/gates-exec.ts:559-573`); blocking gates are filtered/enforced
  at `gates-exec.ts:267-277,527`.
- Promotion **readiness** gates over all live blocking gates
  (`lib/flows/graph/readiness-core.ts` — `blockingGateContribution`,
  `liveBlockingGates`).
- All of this is runner-agnostic (it lives in the web engine, above the
  adapter), so the human-gate axis needs **no per-runner work**.

### C. Promotion trigger — already configurable

- `deliveryPolicy.trigger: auto_on_ready` already auto-promotes once readiness is
  green (`app/api/runs/launch-options/route.ts`, `lib/runs/delivery-policy.ts`).
  "Full unattended" should default this to `auto_on_ready`.

**Takeaway:** the policy is a small orchestrator over three existing seams.
The only genuinely new mechanism is a **runner-agnostic permission bypass**.

## Design

### Policy model

One leveled enum, snapshotted at launch (`runs.execution_policy`), with
project/task defaults resolvable like delivery policy:

| Level | Permissions (axis A) | Human gates (axis B) | Promote (axis C) |
|---|---|---|---|
| `supervised` (default) | HITL on every request | `human`/`human_review` stop | per delivery policy |
| `auto_permissions` | auto-approve tool permissions | human gates still stop | per delivery policy |
| `unattended` | auto-approve tool permissions | auto-pass human gates | default `auto_on_ready` |

Automated gates always run at every level. `unattended` is the owner's
"handoff to the end."

> Modelled as a level (not free axis toggles) for a comprehensible UI and audit
> trail. If product later needs the off-diagonal combos, promote to two booleans
> behind the same snapshot column.

### Axis A — runner-agnostic permission bypass (the hard part)

**Recommended: supervisor-side inline auto-approve**, mirroring the existing L1/L2
arbitration in `acp-client.ts:requestPermission`. Thread an
`autoApprovePermissions: boolean` onto the session record (from the launch
snapshot, alongside `readOnlySession`). In `requestPermission`, **after** the
read-only L1/L2 layers (so read-only always wins), if `autoApprovePermissions`,
select the "allow/proceed" option and return `selected` instead of registering a
HITL row.

Why this over per-adapter native flags:

- **Universal.** Every ACP adapter routes mutating tools through
  `requestPermission` unless it has its own bypass. One seam covers
  `claude | codex | gemini | opencode | mimo`.
- **Reuses a proven pattern.** L1/L2 already arbitrate inline here; this is a
  third, lowest-priority arbitration.
- **Respects enforcement.** Read-only sessions/turns (ADR-090/078) and
  materialized deny rules (L2/L3) keep precedence — auto-approve cannot
  re-enable a denied mutation.

**Option selection.** `requestPermission` receives `params.options`
(`{optionId, kind, name}`). Pick the option whose `kind` is the
allow/proceed-once variant (the same selection the read-only L1 path already
reasons about). Encode a small helper `resolveAutoApproveOption(options)` next to
`resolveReadOnlySessionDecision`; if no allow-kind option exists, fall back to
HITL (never invent an option).

**Adapter-native flags (secondary, optional).** Where an adapter has a cheaper
native bypass we MAY also pass it (it short-circuits the round-trip), but it is
**not required** because the supervisor path is universal. To verify per adapter
at implementation — do **not** assume:

| Adapter | Native bypass to investigate | Fallback |
|---|---|---|
| `claude` | `--dangerously-skip-permissions` (already wired, `runner-provisioner.ts:97`) | n/a |
| `codex` | a "full-auto"/no-approval/sandbox-bypass mode on `codex-acp` (confirm flag + that it still emits ACP `session/update`) | supervisor auto-approve |
| `gemini` | a `--yolo`/auto-accept mode on `gemini --acp` | supervisor auto-approve |
| `opencode` | `opencode acp` permission config | supervisor auto-approve |
| `mimo` | `mimo acp` permission config | supervisor auto-approve |

Because the supervisor-side path is the floor, **the feature ships for all
adapters on day one** even if no native flag is wired beyond claude. That
directly answers "how to adapt for the other runners": don't — arbitrate above
them.

**Remove the claude-only throw.** `runner-provisioner.ts:89-95` should no longer
hard-fail non-claude runners for permission bypass once axis A is policy-driven;
the throw moves to "native flag requested for an adapter that lacks one," which
the supervisor path makes unnecessary anyway.

### Axis B — auto-pass human gates (web/engine, runner-agnostic)

When the run's `execution_policy === "unattended"`:

- `human` node (`runner-human.ts`): instead of `createHitlAssignmentForRun`,
  auto-resolve with a recorded **system decision** (the node's default/approve
  transition) and a `task_activity`/event marker. If a `human` node has no
  non-interactive default (e.g. free-text required with no default), it must
  **fail closed** (block + surface), not silently approve — flag per node.
- `human_review` gate (`gates-exec.ts:559-573`): resolve as auto-passed with a
  recorded system verdict; readiness (`readiness-core.ts`) treats an
  auto-passed human gate as satisfied.
- Automated gates are untouched and still block — a failing `command_check` or
  `ai_judgment` still stops an unattended run (the safety floor).

### Axis C — promotion

`unattended` seeds `deliveryPolicy.trigger = auto_on_ready` unless the user
overrides it in the same launch dialog.

### Launch surface & persistence

- **Launch popover** (`components/board/launch-popover.tsx`): one
  `LaunchSelect` "Execution control" with the three levels; default from
  resolution; an `Override` chip like the others. Thread the choice into the
  `POST /api/runs` body (`executionPolicy`).
- **Run record:** `runs.execution_policy` (text enum) — **snapshot at launch**,
  read by resume/recover (never a mutable catalog row), same discipline as
  `runner_snapshot`.
- **Resolution precedence** (mirror delivery policy): launch override → task
  default → project default → platform default → `supervised`.
- **Supervisor session create** (`POST /sessions`): carry
  `autoApprovePermissions` derived from the snapshot.
- **Task page (#3 of this work):** show the resolved level read-only with the
  other launch config.

### Data model

```
runs.execution_policy            text  NOT NULL DEFAULT 'supervised'
projects.execution_policy_default text NULL      -- optional project default
tasks.execution_policy           text  NULL      -- optional per-task default
```

One migration. (If project/task defaults are deemed YAGNI at implementation,
ship only `runs.execution_policy` + launch override and add defaults later.)

## Safety, authz, audit

- **Opt-in per launch.** Default stays `supervised`. Nothing changes for
  existing launches.
- **Authz.** Gate `unattended` (and maybe `auto_permissions`) behind a project
  action, e.g. `launchUnattended` ≥ `member`/`owner` (`lib/authz.ts`
  `PROJECT_ACTION_MIN`). A viewer can never launch unattended.
- **Read-only contour untouched.** Auto-approve sits **below** ADR-090/078 in
  `requestPermission`; materialized deny rules (L2) and the dirty watchdog (L3)
  still apply. Unattended ≠ read-only-bypass.
- **Audit + visibility.** Record the policy on the run, emit a domain event,
  badge the run/card/task "Unattended", and log every auto-approved permission
  and auto-passed gate to `run.events.jsonl` so the handoff is fully
  reconstructable.
- **Fail closed.** Any human node/gate without a safe non-interactive default
  blocks instead of silently approving.

## Implementation sketch (files)

- `supervisor/src/acp-client.ts` — `resolveAutoApproveOption` + third arbitration
  branch in `requestPermission`; thread `autoApprovePermissions` onto the record.
- `supervisor/src/runner-provisioner.ts` — drop the non-claude hard-fail for
  bypass; keep native claude flag as an optimization.
- `supervisor/src/types.ts` / `http-api.ts` — `autoApprovePermissions` on the
  session-create contract.
- `lib/runs/execution-policy.ts` (new) — enum, resolution precedence, snapshot.
- `lib/flows/runner-human.ts`, `lib/flows/graph/gates-exec.ts`,
  `lib/flows/graph/readiness-core.ts` — auto-pass human node/gate under
  `unattended`, with recorded system decisions.
- `app/api/runs/route.ts` + `lib/services/runs.ts` — accept `executionPolicy`,
  snapshot to `runs.execution_policy`, pass to supervisor.
- `app/api/runs/launch-options/route.ts` — return the resolved default.
- `components/board/launch-popover.tsx` — the "Execution control" select.
- `lib/authz.ts` — `launchUnattended` action.
- migration — `runs.execution_policy` (+ optional defaults).
- i18n EN+RU; `docs/system-analytics/` doc + `docs/decisions.md` ADR.

## Open questions (для владельца)

1. Уровни: `supervised | auto_permissions | unattended` — норм, или нужен ещё
   «auto-permissions + auto-human, но **без** auto-promote»?
2. Кто может запускать `unattended` — `member` и выше, или только `owner`?
3. `human`-нода без безопасного дефолта в `unattended`: **fail-closed**
   (стоп+бейдж) — согласен? (альтернатива — выбрать первую approve-ветку).
4. Native-флаги для codex/gemini сейчас заводить, или достаточно
   supervisor-side auto-approve на старте (claude native уже есть)?
5. Дефолты на уровне project/task в этой итерации, или только launch-override +
   `runs.execution_policy`?
