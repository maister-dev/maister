# Flow execution-control policy — implementation plan

- **Branch (to create at implement time):** `feature/execution-control-policy`
  (planned from the `claude/vibrant-ardinghelli-fcce3d` worktree; no branch
  created during planning — `git checkout main` is impossible while main is
  checked out in another worktree).
- **Date:** 2026-06-18
- **Design (source of truth):**
  - `docs/plans/2026-06-18-flow-execution-control-policy-plan.md` (umbrella axis map, v2)
  - `docs/plans/2026-06-18-execution-control-policy-design.md` (Group B detail)
- **Scope:** web + supervisor + flow engine + one migration. `supervised`
  default = today's behaviour; nothing changes for existing launches.

## Settings

- **Testing:** yes — unit + integration for policy resolution, the no-blind-ship
  guard, check-strictness, ralph-loop bounding, and the squash tree-preserving
  guard. (Mission-critical: this gates what ships to repos.)
- **Logging:** verbose — every policy-driven autonomy action (auto-approve,
  auto-passed gate, downgraded check, retry/ralph attempt, escalation, history
  rewrite) logs to `run.events.jsonl` + a structured pino line.
- **Docs:** yes — mandatory `/aif-docs` checkpoint; update the design docs
  as-built, add an ADR (≥ ADR-093), and a `docs/system-analytics/` doc.

## Roadmap Linkage

- **Milestone:** "none" — **Rationale:** skipped by user (this lands as its own
  feature track; `/aif-verify --strict` should WARN, not fail, on missing linkage).

## Invariants (hold across every task)

- **Never ship with zero validation.** Forbid `skip`/`advisory`-all checks (A3)
  combined with **either** auto-pass human gates (B2) **or** auto-promote (C1).
  Enforced both client-side (the one combined UI) and server-side (policy
  validator) — a launch that violates it is rejected with a typed `MaisterError`.
- **`ai_judgment` / `human_review` are never relaxed by the check axis.** Rework
  is review-node-driven (`lib/flows/graph/ledger.ts:390`); A3 only touches the
  non-review check gates and only their promotion-block.
- **Snapshot, never a mutable row.** Resolve the policy at launch into
  `runs.execution_policy`; resume/recover/finalize read the snapshot (same
  discipline as `runner_snapshot` / `deliveryPolicySnapshot`).
- **Fail closed.** Any axis with no safe automatic value blocks instead of guessing.
- **Authz.** `unattended`, any A3 relaxation, and B3 non-escalate require the
  `launchUnattended` project action (≥ member); a viewer never launches it.

---

## Phase 0 — Policy substrate (foundation; every phase depends on it)

### T0.1 — Data model + migration
- **Files:** `web/lib/db/schema.ts` (~1242, beside `deliveryPolicySnapshot`),
  new migration `web/lib/db/migrations/0055_*.sql`.
- **Do:** add `runs.execution_policy jsonb NOT NULL DEFAULT '{"preset":"supervised"}'`;
  optional `projects.execution_policy_default jsonb NULL`, `tasks.execution_policy jsonb NULL`.
  Generate via `pnpm --filter maister-web db:generate` (do NOT hand-write SQL —
  see the snapshot-drift gotcha in repo memory).
- **Log:** none (schema).
- **Test:** migration applies on a fresh testcontainer DB.

### T0.2 — Policy types + resolution + the guard
- **Files:** new `web/lib/runs/execution-policy.ts` (mirror
  `web/lib/runs/delivery-policy.ts`).
- **Do:** the `ExecutionPolicy` type (`preset: supervised|assisted|unattended` +
  `overrides?` per axis), the preset→axes expansion table, `resolveExecutionPolicy`
  (precedence: launch override → task → project → platform → `supervised`), and
  `assertNoBlindShip(policy)` — the invariant validator throwing `MaisterError`
  (`code: "PRECONDITION"`) when checks are non-strict AND (human-gate auto-pass OR
  auto-promote). zod schema for the launch body field.
- **Log:** `DEBUG [exec-policy] resolved { runId?, preset, tier }`.
- **Test:** resolution precedence; preset expansion; `assertNoBlindShip` accepts
  safe combos and rejects every blind-ship combo.

### T0.3 — Launch plumbing (resolve + snapshot + options)
- **Files:** `web/app/api/runs/route.ts` (accept `executionPolicy`),
  `web/lib/services/runs.ts` (~150 input type, ~689 resolve, ~836 snapshot
  alongside `deliveryPolicySnapshot`), `web/app/api/runs/launch-options/route.ts`
  (return resolved default + axis option metadata).
- **Do:** thread `executionPolicy` through the launch path; call
  `assertNoBlindShip` server-side before run creation; snapshot to
  `runs.execution_policy`; require the `launchUnattended` action when the resolved
  policy is non-`supervised`.
- **Log:** `INFO [runs.launch] execution policy { runId, preset, overrides }`.
- **Test:** launch with each preset snapshots correctly; blind-ship combo →
  `PRECONDITION`; non-supervised without `launchUnattended` → `UNAUTHORIZED`.

### T0.4 — Authz action
- **Files:** `web/lib/authz.ts` (`PROJECT_ACTION_MIN` ~46).
- **Do:** add `launchUnattended: "member"`.
- **Test:** viewer rejected; member allowed.

### T0.5 — Launch UI: the one combined interface
- **Files:** `web/components/board/launch-popover.tsx`, `messages/en.json` +
  `messages/ru.json`.
- **Do:** an "Execution control" preset select + an advanced disclosure that
  **co-locates A3 (checks) · B2 (human gate) · C1 (promotion)** so the
  no-blind-ship mutual exclusion is visible and enforced client-side (the
  conflicting option is disabled + explained); server still re-validates (T0.2).
  Follow the shipped popup conventions (✕ close, full-viewport blur, min-info).
- **Log:** none (client).
- **Test:** renderToStaticMarkup contract (closed-state); the guard disables the
  conflicting control.

### T0.6 — Audit + visibility substrate
- **Files:** `web/lib/runs/*` (events helper), board/task surfaces (badge),
  `domain_events` emit.
- **Do:** a `logExecPolicyAction(runId, kind, detail)` helper writing
  `run.events.jsonl`; an "Unattended"/policy badge on the flight card, task page
  (reuse the launch-config block), and run header; emit a `domain_events` row when
  a non-supervised run launches.
- **Log:** the helper IS the log boundary.
- **Test:** badge renders for non-supervised; event emitted in the launch tx.

---

## Phase A — Self-correction core (BUILD FIRST)

### A.1 ✅ — Check strictness (axis A3)
- **Files:** `web/lib/flows/graph/gates-exec.ts` (blocking filter ~267, `gate.mode`),
  `web/lib/flows/graph/readiness-core.ts` (`blockingGateContribution`,
  `liveBlockingGates`).
- **Do:** read `runs.execution_policy` A3; for the **non-review** check gates
  (`command_check | skill_check | artifact_required | external_check`) apply
  `strict | advisory | skip` to their **promotion-block only**. `advisory` = run,
  record verdict, surface, but do not block readiness; `skip` = don't evaluate.
  **Never** touch `ai_judgment` / `human_review` (rework loop). Per-gate opt-in +
  the global all-advisory setting (still subject to the T0.2 guard).
- **Log:** `INFO [gate.downgrade] { runId, gateId, kind, from:blocking, to }`.
- **Test:** advisory check does not block promotion but the judge→rework loop
  still drives rework; skip omits the gate; review gates unaffected.

### A.2 ✅ — Rework on-exhaustion (axis A1)
- **Files:** the rework-cap enforcement path (`web/lib/flows/graph/ledger.ts`
  `markNodeReworked`, the transition/advance that counts rework against the
  flow's declared cap).
- **Do:** on rework-cap exhaustion, apply the policy action: `escalate` (→ human,
  default) · `ship_with_warning` (advisory-promote, subject to the guard) ·
  `fail`. Policy may lower the cap, never raise the author's ceiling.
- **Log:** `INFO [rework.exhausted] { runId, nodeId, attempts, action }`.
- **Test:** each action path; author cap not raised.
- **Resolved (2026-06-19, owner):** (1) **cap-lowering DEFERRED** — `ExecutionPolicy`
  carries no rework-cap number, only the action; implement only the on-exhaustion
  ACTION and respect the author's `rework.maxLoops` as-is (a `reworkMaxLoops` field
  would reopen Phase 0). The "cap-lowering honored" test is dropped (unmodeled).
  (2) **`escalate` reuses the existing** human-review / `NeedsInput` HITL substrate —
  no new escalation primitive. (3) **`ship_with_warning` = ship FORWARD past the
  loops:** on exhaustion take the node's SUCCESS transition onward (imperfect-but-ship)
  + record the warning, rather than jump-back or stop.
- **Implementation map (mapped 2026-06-19, ready to build):**
  - **Inject at the rework-decision site** `web/lib/flows/graph/runner-graph.ts:2296`
    (`if (isRework) {`), NOT the cap backstop (~1440). In scope there: `outcome`,
    `target`, `isRework`, `nodeAttemptNumber` (1-based review-node visit),
    `node.rework.maxLoops`, `loaded.run.executionPolicy`, `node`, `db`, `runId`.
  - **Exhaustion condition:** `isRework && node.rework && nodeAttemptNumber >
    node.rework.maxLoops` — verify the off-by-one against the existing test
    `runner-graph.integration.test.ts` (maxLoops=1: 1st rework allowed, 2nd
    rework exhausts → today CONFIG/Failed via backstop). Resolve action via
    `expandExecutionPolicy(loaded.run.executionPolicy).reworkExhaustion`
    (add the import; runner-graph.ts has none yet).
  - **`fail`:** throw the existing `CONFIG` (or fall through to the ~1440 backstop)
    → run Failed. **`escalate` (DEFAULT for all presets):** reuse `runReviewHuman`'s
    HITL creation (`hitl_requests` insert L315–324 + `createHitlAssignmentForRun`
    L329–337 + needs-input artifact L271–279) → run `NeedsInput`. **`ship_with_warning`:**
    skip the rework block, `markNodeSucceeded` + `resolveTransition` onto the node's
    forward (success) path; record a warning artifact/event.
  - **Audit/log:** `logExecPolicyAction({runId, kind:"rework_exhausted", detail:{nodeId,
    action, maxLoops, attempt:nodeAttemptNumber}})` (+ `kind:"escalated"` on escalate);
    `INFO [rework.exhausted]` per plan.
  - **★ BEHAVIOR-CHANGE + TEST MIGRATION:** default `reworkExhaustion="escalate"`,
    so the existing `runner-graph.integration.test.ts` "maxLoops exhaustion → Failed"
    case now escalates → `NeedsInput`. Migrate that assertion (or seed it with
    `overrides:{reworkExhaustion:"fail"}`) IN THIS task. Add 3 new cases (escalate /
    ship_with_warning / fail) via `seedGraphRun(manifest, {executionPolicy})` +
    `writeDecision` + `runFlow` (harness in `runner-graph.integration.test.ts`).
  - **Status fan-out reminder (skill-context):** escalate adds a `NeedsInput`
    transition from a new path — confirm HITL/inbox/board read models surface it.

### A.3 ✅ — Ralph-loop (axis A2) — build now, don't defer
- **Files:** `web/lib/services/runs.ts` (run finalization / Failed→Backlog ~750),
  `web/lib/db/schema.ts` (`tasks.attemptNumber` ~1010 already exists).
- **Do:** on a run reaching `Failed`, if A2 == `ralph_loop` and
  `attemptNumber < maxAttempts`, **auto-relaunch** a fresh run against the same
  task (reuse the existing task→Backlog→relaunch + `attempt_number` increment),
  with a hard max-attempts cap and backoff; on cap → hold in `Backlog` for a
  human. Never auto-relaunch a non-`retry_safe` terminal where the worktree is
  needed for forensics — keep the failed worktree (the hold+resume substrate).
  Optional finer-grained `auto_retry` (in-run re-dispatch of `retry_safe` nodes)
  is a follow-up, off by default.
- **Log:** `INFO [ralph] { taskId, fromRunId, attempt, max, action }`.
- **Test:** bounded relaunch count; stops at cap → Backlog hold; supervised → no
  relaunch (manual); concurrency cap respected.
- **Resolved (2026-06-20, owner):** `maxAttempts` = **5** TOTAL attempts (original
  launch + relaunches), env-overridable `MAISTER_RALPH_MAX_ATTEMPTS`; **backoff =
  immediate** (smallest scope, no new scheduler job kind); only `unattended` gets
  `ralph_loop` (already encoded in the preset table — `assisted`/`supervised` =
  `fail`).
- **As-built (deviates from the file pointer above):** implemented as a NEW
  `run.failed` **domain-event consumer** (`web/lib/runs/ralph-loop.ts`, registered
  in `DOMAIN_EVENT_CONSUMERS`) rather than inline finalization in `runs.ts` — the
  owner-chosen mechanism. The consumer reads the FAILED run's snapshotted policy
  (`crashRetryFromSnapshot`, fail-closed → `fail`), relaunches via the sanctioned
  system entry `launchRun` (`{ actorUserId: null, authorize: async () => {} }`,
  same as scheduler/run-schedule fires) carrying the run's `executionPolicy`
  forward, and respects the global cap for free (launch always creates `Pending`).
  **Idempotency without a migration:** `runs` has NO `attempt_number` and there is
  NO `tasks.latest_run_id`, so the dedup/staleness key is **"the failed run is the
  task's current latest flow run"** (max `started_at`, board.ts's rule). A relaunch
  inserts a newer `Pending` run, so at-least-once redelivery (and any newer
  in-flight attempt) is a no-op. The cap bounds on `tasks.attempt_number` (the
  high-water mark = the latest attempt). `handle` never throws (a throw redelivers
  the window forever — mirrors `agent_triggers`). Triggers on `run.failed` only,
  flow runs only (`run_kind='flow'`, `taskId` present); `Crashed` keeps its own
  Recover/discard UX. Worktree forensics preserved automatically (relaunch forks a
  fresh worktree; the failed worktree persists until the 7d GC).

---

## Phase B — Human escalation (build after A is trustworthy)

> **Design mapped 2026-06-20** (3-agent code survey, injection points verified
> against the current tree). B.1 is fully specified (no open decisions). B.2 and
> B.3 carry the **owner-decision callouts** below — resolve those before building.

### B.1 ✅ — Permission auto-approve (axis B1), runner-agnostic
- **Files:** `supervisor/src/acp-client.ts` (`requestPermission` — add a 3rd
  inline arbitration **below** the ADR-090 L1 / ADR-078 L2 layers),
  `supervisor/src/types.ts` (+`autoApprovePermissions` on the session-create
  contract ~202 and the record type ~397), `supervisor/src/http-api.ts`,
  `web/lib/supervisor-client.ts` (thread from the snapshot),
  `supervisor/src/runner-provisioner.ts` (drop the claude-only
  `EXECUTOR_UNAVAILABLE` throw ~89-95 — the supervisor path is universal).
- **Do:** when `autoApprovePermissions`, select the allow/proceed option inline
  (helper `resolveAutoApproveOption(options)`) — read-only layers keep priority.
- **Log:** `INFO [perm.auto] { sessionId, toolKind, optionId }`.
- **Test:** mock-adapter `requestPermission` auto-approves; read-only session/turn
  still wins; non-claude adapters no longer throw.
- **★ Implementation map (verified 2026-06-20):**
  - **Inject L3 at `supervisor/src/acp-client.ts`** inside `requestPermission`,
    AFTER the L1 `resolveReadOnlySessionDecision` (read-only session) and L2
    `resolveReadOnlyAutoReject` (read-only gate-chat turn) early-returns, and
    BEFORE the `session.permission_request` SSE emit + `pendingPermissions.register`
    deferred (~line 357). If `record.autoApprovePermissions`, call the new exported
    `resolveAutoApproveOption(options)` and, on a hit, `return { outcome: {
    outcome: "selected", optionId } }` — short-circuiting the HITL deferred. On NO
    allow option, **fall through to HITL** (never blind-cancel).
  - **`resolveAutoApproveOption(options)`** mirrors L1's allow-kind match (~line
    139): pick the option whose `kind` starts with `allow` (e.g. `allow_once` /
    `allow` / `allow_always`); never a `reject*` kind. `PermissionOptionDescriptor`
    = `{ optionId, kind?, name? }`.
  - **Contract field:** add `autoApprovePermissions?: boolean` to
    `StartSessionRequestSchema` (after `readOnlySession`, ~202) + `SessionRecord`
    (~397); assign onto the record in `supervisor/src/spawn.ts` where
    `readOnlySession` is set. `http-api.ts` already threads the parsed body into
    `spawnSession`.
  - **Web side:** add the field to `CreateSessionInput` (`web/lib/supervisor-client.ts`
    ~97; `createSession` already `JSON.stringify`s the input). Resolve
    `expandExecutionPolicy(run.executionPolicy).permissions === "auto_approve"` and
    set it on the `createInput` in `web/lib/flows/runner-agent.ts` (~700). **★ Thread
    `executionPolicy`** from the `LoadedRun` in the runner down to `runAgentStep`'s
    ctx (it is not carried today — extend `RunFlowOptions`/the agent step ctx; small
    surgical change). Orthogonal to read-only: L1/L2 always win.
  - **runner-provisioner throw:** the ~89-95 throw gates the claude-only
    `--dangerously-skip-permissions` CLI flag — a DIFFERENT mechanism from
    supervisor-layer auto-approve (which works for every adapter at the ACP handler
    regardless of the flag). Dropping it is **optional for B.1** (auto-approve does
    not depend on it); treat as a separate, low-priority cleanup unless a non-claude
    `dangerously_skip` runner is actually configured.

### B.2 ✅ — Human-gate auto-pass (axis B2), gated on machine review
- **Files:** `web/lib/flows/runner-human.ts` (~216), `gates-exec.ts` (`human_review` ~559).
- **Do:** under `unattended`, auto-resolve `human` nodes / `human_review` gates
  with a recorded system decision — **only after Group-A machine review passed**;
  if the machine is stuck (A exhausted) or a node has no safe default, **escalate
  / fail closed**, never silently pass.
- **Test:** auto-pass only post-machine-pass; fail-closed on no-default; stuck → escalate.
- **★ Implementation map (verified 2026-06-20):**
  - **Inject at the human-NODE pause** in `web/lib/flows/graph/runner-graph.ts`
    `runReviewHuman` — the first-visit `needsInput: true` return (~386, the branch
    AFTER the `existing` input-artifact resume check ~216). Under `humanGate ===
    "auto_pass"` AND the machine-review precondition holds, SKIP the HITL creation
    entirely (no `hitl_requests` row, no assignment, no `needs-input.json`) and
    return a synthetic resolved result: `{ ok: true, needsInput: false, decision:
    <safe-default> }`. The existing post-node path then `markNodeSucceeded({
    decision, vars })` + transitions forward. (Skipping the HITL avoids a spurious
    inbox entry; the audit is the `logExecPolicyAction({ kind:
    "human_gate_auto_passed" })` line — that kind already exists in the audit
    taxonomy — plus a `task_activity`/domain-event system-actor record.)
  - **`human_review` GATES** (`gates-exec.ts` ~615) are already recorded `skipped`
    (deferred to the node finish) and contribute `"blocked"` to readiness — they are
    NOT a second auto-pass site; the human NODE is the only target.
  - **Safe-default decision** = reuse A.2's forward-outcome rule: the decision in
    `node.finishHuman.decisions` whose `node.transitions[decision]` is NOT in
    `node.rework.allowedTargets` (the approve/forward branch). **No safe default**
    (empty decisions, or every declared decision targets a rework node) ⇒ do NOT
    auto-pass → route per B.3 onStuck (default escalate).
  - **System actor:** `actorForUserId(null)` → `{ type: "system", id: null }`; the
    decision persists via `markNodeSucceeded({ decision })` on the attempt.
  - **✅ Resolved (2026-06-20, owner) — precondition = `assertEvidenceReady(runId,
    "review", db).ready`.** The single established "machine evidence is ready"
    contract (all live blocking gates passed + required artifacts current),
    fail-closed. A mid-flow human node auto-passes only once the whole
    review-evidence set is green (conservative = safe). Not ready ⇒ do NOT auto-pass
    → route per B.3 `onStuck`.

### B.3 ✅ — Escalation threshold (axis B3)
- **Files:** domain-events/webhooks (ADR-077), inbox / "Needs you".
- **Do:** on-stuck routing `escalate | ship_with_warning | notify_only` (the last
  two subject to the guard).
- **Test:** each route emits the right signal.
- **★ Survey finding (2026-06-20):** `onStuck` is type-defined + preset-configured
  (all presets `escalate`) + privilege-gated (`requiresLaunchUnattended` trips on
  `onStuck !== "escalate"`), but has **no engine hook site today**. The only
  concrete "stuck" the engine detects is **rework-cap exhaustion**, and A.2 already
  routes that via its OWN `reworkExhaustion` axis (escalate/ship_with_warning/fail),
  NOT `onStuck`. The other candidate stuck sites are either prevented by the
  no-blind-ship guard or are exactly **B.2's "cannot auto-pass" branch**.
- **✅ Resolved (2026-06-20, owner) — B.3 = the routing policy for B.2's
  can't-auto-pass branch.** When `humanGate=auto_pass` but `assertEvidenceReady`
  is NOT ready OR the node has no safe default, the engine routes per `onStuck`
  instead of hard-coding escalate:
  - `escalate` (default) → reuse `runReviewHuman` → `NeedsInput` (same substrate as
    A.2's escalate); a human resolves.
  - `ship_with_warning` → take the forward (non-rework) transition + record the
    warning on the attempt (the no-blind-ship guard already forbids the dangerous
    relaxed-checks + auto-ship combo, so this stays behind strict checks).
  - `notify_only` → emit the escalation signal and leave the run in the
    terminal/needs-input state it would otherwise reach, **without** creating a HITL
    assignment ("don't block on a human, just tell someone").
  - **Add a `run.escalated` event kind** to BOTH the webhook taxonomy
    (`web/lib/webhooks/taxonomy.ts`) and the domain-event taxonomy
    (`web/lib/domain-events/taxonomy.ts`) so `escalate` AND `notify_only` emit an
    auditable signal (today escalate only emits `run.needs_input`). `notify_only`
    fires `run.escalated` only; `escalate` fires both `run.escalated` +
    `run.needs_input`.
  - **NOT unified with A.2's `reworkExhaustion`** — A.2 shipped + tested with its own
    axis; the two stay separate (rework-cap exhaustion = `reworkExhaustion`;
    human-gate-can't-auto-pass = `onStuck`). Reassess only if a single axis is wanted
    later.

---

## Phase C — Output shaping (build)

> **Design mapped 2026-06-20** (3-agent survey). Two plan premises were wrong and
> the owner re-scoped: C.2 (no per-attempt commits exist) and C.3 (narrow — the
> unattended human gate already auto-passes). Resolutions below.

### C.1 ✅ — Auto-promote (axis C1)
- **Files:** `web/lib/runs/promote.ts`, `web/lib/runs/delivery-policy.ts`
  (`auto_on_ready` already exists).
- **Do:** wire `execution_policy` → the existing auto-promote trigger; enforce the
  guard interaction (non-strict checks force `manual`).
- **✅ Resolved (2026-06-20, owner) — OR-combine.** `deliverRunIfAutoReady`
  (`web/lib/runs/auto-delivery.ts`) already auto-promotes when
  `deliveryPolicySnapshot.trigger === "auto_on_ready"` (called at run→Review,
  `runner-graph.ts` + `runner.ts`). Add `executionPolicy` to its select and
  auto-promote when EITHER the delivery trigger OR
  `promotionFromSnapshot(executionPolicy) === "auto_on_ready"` (new fail-closed →
  `manual` helper). Delivery policy still defines HOW (strategy/target); execution
  policy adds WHETHER. The guard is launch-time (`isBlindShip`); promote already
  re-gates on `assertEvidenceReady("review")` — no extra runtime check.

### C.2 ✅ — Commit policy (axis C2) — squash-on-promote, deterministic, guarded
- **Files:** `web/lib/runs/promote.ts` (pre-promote rewrite),
  new `web/lib/runs/commit-squash.ts`.
- **✅ Resolved (2026-06-20, owner) — squash-on-promote (premise corrected).** There
  are NO per-node-attempt commits (the runner never commits per attempt), so the
  original "collapse rework-attempt commits by `[node:attempt]` prefix" is moot.
  Instead: `squash_rework` AND `squash_on_promote` both collapse WHATEVER commits
  exist on `base..run-branch` into ONE commit pre-promote; `keep_all`/`defer` =
  no-op. Deterministic engine op via `git reset --soft <base> && git commit` (tree
  unchanged by construction). **★ Tree-preserving guard:** verify the post-rewrite
  HEAD tree SHA == pre-rewrite tree SHA (`git rev-parse HEAD^{tree}`); any drift →
  `git reset --hard <oldHead>` + fall back to `keep_all`, surface. ≤1 commit on the
  range = no-op. New fail-closed `commitsFromSnapshot` → `keep_all`.
- **Test:** squash collapses N→1 with identical tree; injected drift → abort+keep_all;
  ≤1-commit + keep_all/defer = no-op (real git in a tmpdir, no testcontainer).

### C.3 ✅ — Dirty-worktree auto-resolution (axis C3)
- **Files:** `web/lib/flows/graph/runner-graph.ts` (`runReviewHuman` HITL creation),
  `web/lib/runs/execution-policy.ts` (`dirtyResolveFromSnapshot`).
- **Do:** policy-driven `ask | commit | proceed`; `discard` never automatic.
- **✅ Resolved (2026-06-20, owner) — build it (auto-apply at review-HITL creation).**
  When a review HITL is created (the pause path in `runReviewHuman`) and
  `dirtyResolveFromSnapshot(executionPolicy) !== "ask"` and the worktree is dirty
  (`statusPorcelain`): `commit` → `snapshotDirtyWorktree` then record
  `hitl.dirty_resolution = "commit"`; `proceed` → record `"proceed"` (no git op).
  `ask` (supervised default) keeps the interactive banner untouched. Narrow but real
  for `assisted` (pauses at review) + the unattended-escalate edge. New fail-closed
  `dirtyResolveFromSnapshot` → `ask`.

---

## Cross-cutting (every phase)

- **i18n EN+RU** for all new labels (`messages/en.json` + `ru.json`, parity).
- **Docs:** reconcile the two design docs as-built; ADR (≥ ADR-093);
  `docs/system-analytics/` execution-policy doc; update `docs/screens/` launch
  dialog for the new policy control.
- **Audit:** every autonomy action through the T0.6 helper.

## Open numbers (resolve during implementation)

- ✅ **Resolved (2026-06-20, A.3):** Ralph-loop `maxAttempts` = **5** total
  (`MAISTER_RALPH_MAX_ATTEMPTS`); **backoff = immediate** (run.failed consumer, no
  scheduler delay); only `unattended` gets `ralph_loop` (preset table). See A.3
  as-built note above.

## Commit Plan (checkpoints every 3–5 tasks)

1. **Phase 0 substrate** — after T0.1–T0.4: `feat(runs): execution-policy data
   model, resolution, no-blind-ship guard, authz`.
2. **Phase 0 UI** — after T0.5–T0.6: `feat(runs): execution-control launch UI +
   audit/badge`.
3. **Phase A** — after A.1–A.3: `feat(flows): self-correction policy —
   check-strictness, rework on-exhaustion, ralph-loop`.
4. **Phase B** — after B.1–B.3: `feat(supervisor): runner-agnostic permission
   auto-approve + human-gate auto-pass + escalation`.
5. **Phase C** — after C.1–C.3: `feat(runs): auto-promote, squash_rework
   history rewrite, dirty auto-resolution`.
6. **Docs** — `docs: execution-control policy as-built + ADR`.
