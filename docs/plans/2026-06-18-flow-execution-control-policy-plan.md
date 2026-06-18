# Flow execution-control policy — axis map & phased plan

- **Date:** 2026-06-18
- **Status:** Draft (brainstorm) — maps the full space; pending owner triage of
  which axes to build and in what order.
- **Scope:** web + supervisor + flow engine + one migration. No new adapters.
- **Relation:** the permission / human-gate / promotion axes already have a
  detailed design in
  [`2026-06-18-execution-control-policy-design.md`](2026-06-18-execution-control-policy-design.md)
  (the "unattended handoff" slice). This plan is the **umbrella**: it frames a
  single composable policy, brainstorms every other axis the owner raised
  (skip commits, relax checks, retries, "what else"), and proposes a phasing.
- **ADR:** next-free (≥ ADR-093) — assign per phase at implementation.

## Problem

"How autonomously does a run execute?" is today answered in a dozen scattered,
mostly-hardcoded places: every tool permission stops, every `human` gate stops,
every blocking check stops, a failed node goes `Crashed` and waits, commits are
ad-hoc, promotion is manual. There is **no single knob** to trade oversight for
autonomy — to say "this run should drive to the end with light supervision" or
"be maximally careful." The owner wants one **execution-control policy**, picked
at launch, that dials this trade-off across **all** the axes — starting with
skipping HITL gates, and extending to commits, checks, and retries.

## The model

An **execution policy** = a small set of **independent axes**, each a metric of
oversight↔autonomy. Two ways to set them, both snapshotted onto the run
(`runs.execution_policy`, like `runner_snapshot` — resume/recover reads the
snapshot, never a mutable row):

1. A **preset level** (`supervised` | `assisted` | `unattended`) that sets all
   axes at once — the common case, one dropdown in the launch popover.
2. Optional **per-axis overrides** for power users (advanced disclosure).

`supervised` is today's behaviour and the default; nothing changes for existing
launches. The **automated gates remain the floor at every level** — a failing
`command_check` / `ai_judgment` always stops, unless its axis is *explicitly*
relaxed. Autonomy never silently disables correctness checks.

## The axes

Each axis: what it controls · where it hooks (grounded) · default · options ·
safety note.

### 1. Permission autonomy — ACP tool permissions
- **Hook:** `supervisor/src/acp-client.ts:requestPermission` (inline arbitration
  seam, ADR-090 L1/L2); `runner-provisioner.ts` (claude-only
  `--dangerously-skip-permissions` today).
- **Default:** `ask` (HITL per request).
- **Options:** `ask` → `auto_approve` (runner-agnostic supervisor-side
  auto-approve, below the read-only layers).
- **Safety:** never overrides read-only enforcement (ADR-090/041).
- → detailed in the unattended-handoff design.

### 2. Human-gate autonomy — `human` nodes & `human_review` gates
- **Hook:** `lib/flows/runner-human.ts` (human node → `createHitlAssignmentForRun`);
  `lib/flows/graph/gates-exec.ts:559` (`human_review` gate); readiness in
  `lib/flows/graph/readiness-core.ts`.
- **Default:** `stop` (HITL).
- **Options:** `stop` → `auto_pass` (record a system decision; fail **closed**
  if a node has no safe non-interactive default).
- **Safety:** bypasses human review — privileged, audited, badged.
- → detailed in the unattended-handoff design.

### 3. Promotion trigger
- **Hook:** `lib/runs/delivery-policy.ts` (`trigger: manual | auto_on_ready`),
  `lib/runs/promote.ts`. Already exists.
- **Default:** `manual`.
- **Options:** `manual` → `auto_on_ready` (promote once readiness is green).
- **Safety:** gated by readiness; conflict on merge still aborts → `Review`.

### 4. Check strictness — automated gates
- **Hook:** `lib/flows/graph/gates-exec.ts` (6 kinds:
  `command_check | skill_check | ai_judgment | artifact_required |
  external_check | human_review`, each `blocking | advisory`;
  `gate.mode === "blocking"` filter at `:267`).
- **Default:** `strict` (declared blocking gates block).
- **Options:** `strict` → `advisory_only` (downgrade **non-human** blocking gates
  to advisory: run records the verdict, surfaces it, but does not stop) →
  `skip_selected` (skip named gate ids / kinds).
- **Safety:** this is the axis most likely to ship a broken branch. Recommend it
  be **per-gate opt-in**, never a blanket "ignore all checks"; always log what
  was downgraded/skipped. `human_review` is governed by axis 2, not here.

### 5. Retry-on-failure — node crash / hard failure
- **Hook:** `node_attempts` ledger; `lib/flows/graph/current-node-kind.ts:95`
  (`retry_safe` per node, ADR-034 crash-recover — re-dispatch vs discard-only);
  today a dead node → `Crashed` and waits for "Recover or discard".
- **Default:** `hold` (→ `Crashed`, HITL recover).
- **Options:** `hold` → `auto_retry` (bounded N attempts on **`retry_safe`**
  nodes only, with backoff; after N → `hold`/`Failed`). The "ralph-loop on
  failure."
- **Safety:** bound attempts hard (crash-loop backoff — cf. the Mγ continuous
  backstop); never retry a non-`retry_safe` node automatically; count cost.

### 6. Rework-loop bounds — gate-reject rework
- **Hook:** graph `transitions` with bounded `rework`; a rejected gate sends the
  node back for rework up to a declared cap.
- **Default:** the flow's declared cap; on exhaustion → `stop`.
- **Options:** policy may **lower** the cap (fail faster) or, under
  `unattended`, auto-stop vs auto-escalate on exhaustion. Policy may not *raise*
  a flow's declared cap (the flow author owns the ceiling).
- **Safety:** distinct from axis 5 (failure) — this is *quality* rework, not
  crash. Keep the author's cap authoritative.

### 7. Commit policy — how the run commits work
- **Hook:** `lib/worktree.ts:1702` (`git commit --no-verify`);
  `lib/runs/inspector-actions.ts` `snapshotCommit`; agent-authored commits.
- **Default:** `agent_managed` (today — the agent commits as it sees fit;
  MAIster snapshots on demand).
- **Options:** `agent_managed` → `auto_snapshot_per_node` (MAIster commits a
  snapshot at each node boundary for a clean per-step history / easy rollback) →
  `squash_on_promote` (collapse to one commit at promotion) →
  `defer` (no intermediate commits; commit once at the end). "Skip commits" =
  `defer` / `squash_on_promote`.
- **Safety:** low blast radius (history shape only). Note `--no-verify` already
  skips pre-commit hooks; do not silently re-enable.

### 8. Dirty-worktree resolution
- **Hook:** `lib/runs/dirty-resolution.ts` (`DIRTY_CHOICES = commit | discard |
  proceed`) — today a HITL choice when the tree is dirty at a boundary.
- **Default:** `ask`.
- **Options:** `ask` → a fixed auto choice (`commit` | `proceed`) under
  autonomy. Ties to axis 7.
- **Safety:** `discard` must never be an automatic default (data loss).

### 9. Failure handling — terminal failure
- **Hook:** run terminal states (`Crashed | Failed | Abandoned`); task
  auto-returns to `Backlog` on `Failed | Abandoned`.
- **Default:** `hold` (Crashed → recover/discard; stays for review).
- **Options:** `hold` → `auto_abandon` (free the worktree on terminal failure) —
  for fire-and-forget batch runs. Composes with axis 5.
- **Safety:** `auto_abandon` loses the failed worktree for forensics — opt-in,
  and only after retries (axis 5) are exhausted.

### 10. Escalation / notification
- **Hook:** outbound webhooks (ADR-077), the inbox / "Needs you" sum,
  `domain_events`.
- **Default:** standard inbox/subscription behaviour.
- **Options:** for an unattended run, **when** to pull a human back in:
  `on_terminal_failure_only` | `on_first_blocker` | `never (silent)`.
- **Safety:** "never" can hide a stuck run — pair with a max-wall-clock guard.

### 11. Cost / time budget — DEFERRED
- A hard ceiling (tokens / wall-clock) that caps an unattended run. **Deferred**
  per owner (2026-06-16); listed for completeness so the policy shape leaves
  room for it (a `budget` axis added later without reshaping the others).

## Preset levels

| Axis | `supervised` (default) | `assisted` | `unattended` |
| --- | --- | --- | --- |
| 1 Permissions | ask | auto_approve | auto_approve |
| 2 Human gates | stop | stop | auto_pass (fail-closed) |
| 3 Promotion | manual | manual | auto_on_ready |
| 4 Checks | strict | strict | strict (floor) |
| 5 Retry-on-fail | hold | auto_retry (N) | auto_retry (N) |
| 6 Rework bounds | author cap | author cap | author cap |
| 7 Commits | agent_managed | agent_managed | squash_on_promote |
| 8 Dirty resolve | ask | proceed | proceed |
| 9 Failure | hold | hold | hold |
| 10 Escalation | inbox | inbox | on_terminal_failure_only |

`assisted` = "don't pester me for permissions or dirty-tree, but a human still
reviews and promotes." `unattended` = the owner's "handoff to the end." Note
checks stay **strict** even at `unattended` — relaxing them (axis 4) and
`auto_abandon` (axis 9) are **never** part of a preset; they are explicit,
per-gate / per-run opt-ins.

## Safety, authz, audit (cross-cutting)

- **Opt-in, privileged.** `unattended` (and axis-4 relaxation, axis-9
  auto_abandon) gated by a project action (`launchUnattended` ≥ member/owner);
  a viewer never launches unattended.
- **Automated gates are the floor.** Autonomy skips *human* bottlenecks; it does
  not disable correctness gates unless axis 4 is explicitly, per-gate relaxed.
- **Everything audited.** Snapshot the policy on the run; emit a domain event;
  badge the run/card/task; log every auto-approval, auto-passed gate, retry, and
  skipped check to `run.events.jsonl` so an unattended run is fully
  reconstructable.
- **Fail closed.** Any axis with no safe automatic value (human node without a
  default, dirty-tree `discard`) blocks instead of guessing.

## Phasing

1. **Phase 1 — HITL handoff** (axes 1–3): the unattended-handoff design.
   Highest value, smallest surface; ships the `supervised|assisted|unattended`
   preset + the policy column + launch UI.
2. **Phase 2 — resilience** (axes 5 + 6): retry-on-failure + rework-bound tuning.
   Turns `unattended` from "runs to the first crash" into "drives through
   transient failures."
3. **Phase 3 — history & exit** (axes 7 + 8 + 9): commit policy, dirty
   auto-resolution, failure handling — the fire-and-forget batch ergonomics.
4. **Phase 4 — check relaxation** (axis 4): per-gate, last and most cautious;
   needs the strongest audit + authz story.
5. **Axis 10 (escalation)** rides whichever phase first ships `unattended`.
6. **Axis 11 (budget)** deferred.

## Data model

```
runs.execution_policy  jsonb NOT NULL DEFAULT '{"preset":"supervised"}'
  -- { preset, overrides?: { permissions, humanGates, promotion, checks,
  --   retry, reworkBounds, commits, dirtyResolve, failure, escalation } }
projects.execution_policy_default jsonb NULL   -- optional project default
tasks.execution_policy            jsonb NULL   -- optional per-task default
```

One additive migration per the column it introduces; Phase 1 may ship only
`runs.execution_policy` + launch override and add project/task defaults later.
Resolution precedence mirrors delivery policy: launch override → task → project
→ platform → `supervised`.

## Open questions (для владельца)

1. Пресеты `supervised | assisted | unattended` — годятся, или нужен ещё
   уровень (напр. «assisted + auto-promote»)?
2. Axis 4 (ослабление чеков): только **per-gate opt-in**, или нужен и режим
   «все блокирующие → advisory» (рискованно)?
3. Axis 5 (retry-on-fail): дефолтное N попыток и backoff — какие? Только
   `retry_safe`-ноды (ADR-034), согласен?
4. Axis 7 (commits): дефолт для `unattended` — `squash_on_promote` или
   `auto_snapshot_per_node` (чище история, но много коммитов)?
5. Axis 9 (`auto_abandon`) и axis 10 («never»/silent) — вообще нужны сейчас, или
   за пределами первой волны?
6. Порядок фаз — ок (HITL → resilience → history → checks), или checks/retries
   важнее раньше?
7. Модель: composable JSON с пресетом+оверрайдами — или хватит плоского enum
   `supervised|assisted|unattended` без per-axis (проще, но негибко)?
