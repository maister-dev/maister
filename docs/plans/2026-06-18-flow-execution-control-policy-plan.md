# Flow execution-control policy — axis map & phased plan

- **Date:** 2026-06-18
- **Status:** Draft (brainstorm) — **v2**, reframed per owner feedback
  (2026-06-18): composable axes confirmed; model reorganised around
  *self-correct → escalate*; `auto-abandon` dropped (persistent sessions);
  check-relaxation reconciled with the rework loop. Axis defaults triaged
  round 2: A2 → `fail`, A3 all-advisory-as-setting + footgun guard, C2
  `squash_rework`. Round 3: A2 **ralph-loop in scope**, A3 hard **no-blind-ship**
  guard co-configured with B2/C1 in one UI, C2 squash = a deterministic
  tree-preserving engine op. **Ready for `/aif-plan`.**
- **Scope:** web + supervisor + flow engine + one migration. No new adapters.
- **Relation:** the permission / human-gate / promotion axes have a detailed
  design in
  [`2026-06-18-execution-control-policy-design.md`](2026-06-18-execution-control-policy-design.md)
  (Group B below). This plan is the umbrella over **all** axes.
- **ADR:** next-free (≥ ADR-093) — assign per phase at implementation.

## Problem

"How autonomously does a run execute?" is answered today in a dozen scattered,
mostly-hardcoded places: every tool permission stops, every `human` gate stops,
every blocking check stops, a crashed node waits for a human, commits are ad-hoc,
promotion is manual. There is **no single knob** to trade oversight for autonomy.
The owner wants one **execution-control policy**, picked at launch, that dials
this trade-off across all the axes.

## The model — self-correct, then escalate

The reframe (owner): **checks and retries come *before* a human — never after.**
"Why ask a person to review something the process hasn't even validated as
ready?" So the policy is not primarily "skip the human"; it tunes a
**self-correction loop**, with the human as the **escape valve** for when the
machine is stuck. The spine of every run:

1. `ai_coding` produces work.
2. **Machine review** — automated check gates **and** the `judge` (`ai_judgment`)
   node evaluate the result.
3. **Auto-rework** — a judge `rework` verdict sends the node back to fix, bounded
   by the flow's rework cap, re-judged each cycle. **No human.** (This loop
   already exists: rework is review-node-driven, `lib/flows/graph/ledger.ts:390`.)
4. **Crash-retry** — a node that *crashes* (not a quality reject) auto-retries,
   bounded, on `retry_safe` nodes only (`current-node-kind.ts:95`, ADR-034).
5. **Escalate to a human** only when the machine is **stuck** — rework/retries
   exhausted — or a `human_review` node is genuinely reached.
6. **Human review** (`human_review`): `supervised` stops; `unattended`
   auto-passes — **but only after machine review has passed** (never hand a human,
   or ship, un-vetted work).
7. **Promote** — `manual` or `auto_on_ready`.

So `unattended` ≠ "skip the checks and ship." It = "let the machine self-correct
as far as it can; pull a human in only when it's stuck." Checks/retries are the
**first** line; the human is the **last**.

**Composable.** A run carries a **preset** (`supervised | assisted | unattended`)
that sets every axis, plus optional **per-axis overrides** (advanced disclosure).
Snapshotted onto `runs.execution_policy` (resume/recover reads the snapshot, like
`runner_snapshot`).

## The axes

Grouped by where they sit on the spine. Each: control · hook (grounded) ·
default · options · safety.

### Group A — Machine self-correction (runs *before* any human)

**A1. Rework depth (the judge loop).**
- **Hook:** review-node verdict → bounded `rework` transition
  (`ledger.ts:390`, `markNodeReworked`); cap declared by the flow author.
- **Default:** the flow's declared cap; on exhaustion → escalate.
- **Options:** policy may **lower** the cap (fail faster) and choose the
  on-exhaustion action — `escalate` (→ human), `ship_with_warning` (advisory),
  or `fail`. Policy may **not** raise the author's cap, and **never** auto-skips
  the `judge` (`ai_judgment`) node — that node *is* the machine's quality engine.

**A2. Crash / hard-failure handling.**
- **Hook:** `node_attempts`; `retry_safe` per node (`current-node-kind.ts:95`,
  ADR-034). (A *checkpointed* idle / `NeedsInput` run is a separate,
  always-recoverable case — `session/resume`, never lost. This axis is hard
  failure, not idle-wait.)
- **Default (owner):** `fail` — a node that cannot proceed → `Failed`
  (terminal). The task auto-returns to `Backlog`, where **relaunch is the retry
  path** (a fresh attempt). Keep it simple — no in-run backoff machinery.
- **Options (owner: build the ralph-loop now, don't defer):**
  - `ralph_loop` — on `Failed`, **auto-relaunch** a fresh run against the same
    task (attempt N+1; reuses the existing task→`Backlog`→relaunch +
    `attempt_number`), **hard-bounded** by a max-attempts cap, then hold in
    `Backlog` for a human. The "ralph-loop."
  - `auto_retry` — a finer-grained, in-run re-dispatch of `retry_safe` nodes
    before `Failed` (optional, composes with the above).
- **Safety:** never auto-retry a non-`retry_safe` node; **hard-cap** total
  attempts (crash-loop backoff); `Failed` keeps the worktree for forensics (the
  hold+resume substrate).

**A3. Check strictness — the *non-review* check gates.**
- **Hook:** `lib/flows/graph/gates-exec.ts` — `command_check | skill_check |
  artifact_required | external_check` (each `blocking | advisory`). These gate
  **promotion-readiness**; they do **not** drive rework.
- **Default:** `strict` (declared blocking gates block promotion).
- **Options:** `strict` → `advisory` (run, record the verdict, surface it, but
  do **not** block the final promotion) → `skip` (don't evaluate).
- **★ The careful bit (owner #2).** Because these check gates do **not** drive
  the rework loop (only `judge`/`human_review` verdicts do), `advisory`/`skip`
  here change **only** the final promotion decision — the judge→rework
  self-correction loop (A1) is **untouched**. So "all blocking → advisory" is
  coherent: the machine still self-corrects via the judge; advisory just means
  "after self-correction, promote with a recorded warning instead of stopping."
  `advisory`/`skip` are **per-gate opt-in** by default (logged downgrade);
  `ai_judgment` is governed by A1, never relaxed here.
- **Global "all → advisory" + the no-blind-ship guard (owner).** Per-gate
  clicking is tedious, so a single **all-advisory** switch is allowed — as a
  deliberate **setting**, not a casual per-launch toggle. **★ Guard — never ship
  with zero validation.** At least one validation layer must gate an automatic
  ship: the policy **forbids** combining `skip`/`advisory`-all checks (A3) with
  **either** auto-pass of the human gates (B2) **or** auto-promote (C1). Relax
  the checks and a human review *or* a manual promote must remain. This is
  **enforced, not warned** — and because A3, B2 and C1 constrain each other, they
  are **co-configured in one interface** (owner) so the mutual exclusion is
  visible and validated at config time, not discovered at ship time.

### Group B — Human escalation (the escape valve)

**B1. Permission autonomy** — ACP tool permissions.
- **Hook:** `acp-client.ts:requestPermission` (runner-agnostic inline
  auto-approve, below ADR-090 L1/L2). Default `ask` → `auto_approve`.

**B2. Human-gate autonomy** — `human_review` nodes.
- **Hook:** `runner-human.ts`, `gates-exec.ts:559`. Default `stop` → `auto_pass`
  — and `auto_pass` fires **only after Group A passed**. If the machine is stuck
  (A exhausted), the run **escalates** to a human regardless of B2 (you don't
  silently ship un-vetted work). Fail **closed** if a human node has no safe
  non-interactive default.

**B3. Escalation threshold** — when the machine is stuck, what happens.
- `escalate` (→ human, the safe default) · `ship_with_warning` (advisory, A3) ·
  `notify_only` (webhook/inbox, keep going). **Hook:** outbound webhooks
  (ADR-077), inbox / "Needs you", `domain_events`.

### Group C — Output shaping

**C1. Promotion trigger** — `manual | auto_on_ready` (`delivery-policy.ts`,
`promote.ts`). Conflict on merge still aborts → `Review`.

**C2. Commit policy (owner #4)** — a toggle over how much history survives:
- `keep_all` — every node attempt, rework cycles included (full audit trail).
- `squash_rework` (owner's idea) — MAIster commits each attempt with a
  **structured prefix** (e.g. `[node:<id> attempt:<n>]`), then at promotion
  **rewrites history** to collapse each node's rework attempts into one clean
  commit: full trace *during* the run, tidy history *at the end*.
- `squash_on_promote` — collapse everything to a single commit.
- `defer` — no intermediate commits; one commit at the end.
- **Hook:** `worktree.ts:1702` (`git commit --no-verify`),
  `inspector-actions.ts` `snapshotCommit`; the prefixes drive the end-of-run
  rewrite on the run branch, pre-promote. **Default:** `keep_all`; `unattended`
  → `squash_rework`.
- **Policy, not an agent node (owner's question — "policy or a node?").** The
  rewrite is a **deterministic engine operation** driven by the policy + the
  commit prefixes, **not** an agent / `judge` node. An agent running `git rebase`
  is exactly how "грязь улетает в репу"; a mechanical, tested squash is reliable.
- **★ Tree-preserving guard (owner's risk).** The rewrite must leave the final
  tree **byte-for-byte identical** — it only collapses history. Verified
  (`git diff` empty between the pre- and post-rewrite HEAD trees) **before**
  promotion; any failure or tree drift → **abort, fall back to `keep_all`,
  surface it.** A botched history never reaches the target repo.

**C3. Dirty-worktree resolution** — `ask` (today, `dirty-resolution.ts`:
`commit | discard | proceed`) → a fixed auto choice (`commit | proceed`) under
autonomy. `discard` is **never** an automatic default (data loss).

### Dropped / deferred

- **~~Auto-abandon vs hold~~ (owner #4).** Removed. Persistent sessions
  (checkpoint + `session/resume`) mean a stopped/stuck run is **never lost** —
  "hold + resume" is the universal recovery, and stale cleanup is already the
  7-day cron GC. So there is no "abandon vs keep" policy choice; the only failure
  knob is machine-retry (A2) → then hold-for-resume.
- **Cost / time budget** — deferred (owner, 2026-06-16). The composable shape
  leaves room to add a `budget` axis later without reshaping the rest.

## Preset levels

| Axis | `supervised` (default) | `assisted` | `unattended` |
| --- | --- | --- | --- |
| A1 Rework | author cap → escalate | author cap → escalate | author cap → escalate |
| A2 Crash/fail | fail (→ Backlog) | fail (→ Backlog) | ralph_loop (N) |
| A3 Checks | strict | strict | strict |
| B1 Permissions | ask | auto_approve | auto_approve |
| B2 Human gate | stop | stop | auto_pass (post-A, fail-closed) |
| B3 On stuck | escalate | escalate | escalate |
| C1 Promotion | manual | manual | auto_on_ready |
| C2 Commits | keep_all | keep_all | squash_rework |
| C3 Dirty | ask | proceed | proceed |

`assisted` = "don't pester me for permissions or a dirty tree, but a human still
reviews and promotes." `unattended` = the owner's "handoff to the end" — yet
**checks stay strict and on-stuck still escalates**: autonomy means *more machine
self-correction before* the human, not shipping past red checks. Relaxing A3 to
`advisory`/`skip` and setting B3 to `ship_with_warning`/`notify_only` are
**explicit, per-gate / per-run opt-ins**, never baked into a preset.

## Safety, authz, audit (cross-cutting)

- **Opt-in, privileged.** `unattended` (and any A3 relaxation, B3 non-escalate)
  gated by a project action (`launchUnattended` ≥ member/owner); a viewer never
  launches unattended.
- **Checks are the floor.** Autonomy skips *human* bottlenecks and tunes the
  *machine* loop; it never disables correctness gates unless A3 is explicitly,
  per-gate relaxed — and even then the judge→rework loop still runs.
- **Audited.** Snapshot the policy on the run; emit a domain event; badge
  run/card/task; log every auto-approval, auto-passed gate, retry, downgraded
  check, and escalation to `run.events.jsonl`.
- **Fail closed.** Any axis with no safe automatic value (human node without a
  default, dirty `discard`) blocks instead of guessing.

## Phasing (self-correction first, per owner #3)

1. **Phase 1 — self-correction core (Group A).** The A2 **ralph-loop**
   (auto-relaunch on `Failed`, bounded — owner: build it now) + optional in-run
   retry, rework-cap + on-exhaustion policy (A1), check-strictness toggle (A3).
   This is what lets the run drive *further before* a human — the foundation the
   owner put first. (The judge→rework loop already exists; this tunes it and adds
   the ralph-loop.)
2. **Phase 2 — escalation control (Group B).** Permission auto-approve (B1),
   human-gate auto-pass *gated on Group A* (B2), escalation threshold (B3). The
   "handoff," now safe because Group A vets readiness first.
3. **Phase 3 — output shaping (Group C).** Commit policy (C2), dirty
   auto-resolve (C3), auto-promote (C1).
4. Budget deferred.

The `supervised | assisted | unattended` preset + the `runs.execution_policy`
column + launch UI land with Phase 1 (presets reference later-phase axes at
their defaults until those phases ship).

## Data model

```
runs.execution_policy  jsonb NOT NULL DEFAULT '{"preset":"supervised"}'
  -- { preset, overrides?: { reworkExhaustion, crashRetry, checks,
  --   permissions, humanGate, onStuck, promotion, commits, dirtyResolve } }
projects.execution_policy_default jsonb NULL
tasks.execution_policy            jsonb NULL
```

One additive migration. Resolution precedence mirrors delivery policy: launch
override → task → project → platform → `supervised`.

## Open questions (для владельца)

Все ключевые развилки закрыты (раунды 1–3): self-correct → escalate; A1
`escalate`; A2 ралф-loop в скоупе; A3 all-advisory как настройка + жёсткий
**no-blind-ship** guard в одном интерфейсе с B2/C1; C2 `squash_rework` как
детерминированная tree-preserving операция движка. **Готово к `/aif-plan`.**

Остаются только числа/мелочи на этапе плана:

1. max-attempts ралф-лупа (A2) и backoff.
2. Дать ли `assisted` тоже ралф-loop, или только `unattended`.
