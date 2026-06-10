# MAIster improvement roadmap — priorities & delivery waves

> **Status:** Product backlog / vision. Not a committed plan, changes no ADR,
> supersedes nothing. Captures prioritized improvement work and a parallelizable
> delivery shape. Proposes future ADRs only when an item is pulled into delivery.
> Lives in `docs/pv/` (product vision/backlog), beside
> [`agents-as-environment-actors.md`](agents-as-environment-actors.md).

## Guiding principle

**Deepen the wedge before widening the surface.** For a single-operator product
that has not yet dogfooded (M20 open), the leverage order is:

1. **Make the tool usable enough to generate run volume** — workbench
   visibility (graph, files, diff). This is the real gate to dogfooding.
2. **Read the signals you already capture** — a learning/quality story is only
   credible once `correction_rate` and autonomy are measured on real runs.
3. **Close the knowledge loop** — author → publish → measure → improve. This is
   the moat, but it needs run volume and the signal layer first.
4. **Then widen** — orchestration (scheduled/background actors), multi-user,
   external integrations. These add surface; do them when going team/external.

Moat work (learning loop, benchmarking, project memory) **deepens** flow→PR.
Background actors / integrations / multi-user **widen** it. Deepen first.

**North star — one place to run people *and* agents.** Solo-operator is the
*first approximation*, not the destination: the concept moves toward **teams and
a single control plane where humans and agents are managed, assigned, and
observed together.** That promotes the *widen* layer (E4 agents-as-actors, E5
multi-user / governance, the external surface) from "later, if we go team" to the
**target shape**. Deepen-first still governs near-term sequencing — the M20
dogfood gate is real and cheap signal beats speculative surface — but select
widen bets are pulled forward on owner direction (see *Owner-directed next bets*).

The two priority blocks below — **feature epics** and **foundational
primitives** — are interleaved into delivery **waves** so independent work runs
in parallel.

---

## Delivery waves

Each wave lists **parallel tracks** that share no hard dependency and can be
staffed concurrently. A later wave consumes an earlier wave's output.

### Wave 1 — Unblock dogfood + lay foundations (max parallelism)

All four tracks are independent; start concurrently. **Exit goal: the tool is
pleasant enough to run the M20 dogfood, and every run emits structured signal.**

| Track | Scope | Notes / current state |
|---|---|---|
| **UX — workbench visibility** *(shipped M22)* | Flow-graph **view** (live node-status), repo **file-tree** browser in project + workbench, **diff** in the workbench | **Shipped M22** (read-only over evidence graph / worktree / artifacts; diff extends M18). The flow-graph **editor** is the remaining slice — see *Owner-directed next bets §6*. |
| **Signals — observatory** | `correction_rate` heatmap, **Autonomy Score**, read-only signal harvesting | Pure read over `node_attempts`, gate verdicts, HITL timings. No schema change. Proves/disproves the moat hypothesis cheaply. |
| **Foundations — flow-engine primitives** | **Structured node output channel** (P1, schema-validated, keystone) + **run-context file** (P7), activate `hash`/`size_bytes`, tighten `input.requires` contract | Reuses `node_attempts.vars` + `reduceLedger`; today only human nodes populate `vars`. P1+P7 are the keystone pair (authoritative vars + agent-readable projection). |
| **Long-lead — catalog & clock** | **Authoring→publication** groundwork (cap catalog model), **scheduler service** (polymorphic cron) | Independent, heavy; start early so it lands by Wave 2/3. Scheduler generalizes the existing GC cron route. |

### Wave 2 — Close the loops (consumes Wave 1)

| Track | Scope | Depends on |
|---|---|---|
| **Flow-engine increments** | **Dynamic routing** via decision table (P4), **prompt content injection** (P2), opt-in **session continuity + clear** (P6), **diff-path assertions** in `artifact_required` (P3, if pursued) | Structured output channel + run-context file (P1/P7); `hash`/`size` for diff change-detection |
| **Authoring→publication** | Complete: in-app create/version of rules/skills/flows, PR-based publish to a catalog repo, two-way sync | Wave 1 catalog model |
| **Orchestration (flow-bound)** | Agents-as-actors **flow-bound** stage (bind a catalog actor to an `agent` step) | Scheduler service, structured output, capabilities (M14) |

### Wave 3 — The moat (consumes Waves 1–2 + run volume)

| Track | Scope | Depends on |
|---|---|---|
| **Self-improvement (write half)** | Harvester → **Improver** meta-agent → **proposal inbox** (human edits & publishes; nothing auto-applies) | Observatory signals + authoring→publication + structured output |
| **Project memory** | Durable lessons/knowledge store (lesson→rule), surfaced into flow context | Catalog (where lessons live) + signals |
| **Benchmarking** | A/B comparison of runs (with/without a cap, version A vs B), diff-of-diffs, judge-assisted + human verdict; feeds catalog lifecycle | Run substrate (exists) + run volume |
| **Flow-graph editor** | Visual graph authoring | Graph view (Wave 1) + authoring |
| **Visual validation ("Eyes")** | Preview URLs + port mapping, browser-backed checks as nodes/gates, screenshots/DOM/console/network/user-flow traces → artifact graph (`PRODUCT_VIEW.md` §Phase 2.1) | Workbench (E1) + artifact graph |
| **Attention routing** | Run summaries (changed/passed/failed/stale/needs-human), ledger history (recovery/checkpoint/gate-rerun/profile changes), web notifications → Telegram later (`PRODUCT_VIEW.md` §Phase 2.5) | Observatory (E2) + assignments |
| **Cost & economics** | Cost by run/node/executor/gate/tool, noisy-command compaction, cache-resume cost, host memory visibility, warn-first budgets (`PRODUCT_VIEW.md` §Phase 2.6) | Extends `cost.jsonl` capture |

### Wave 4 — Widen the surface (team / external validation)

| Track | Scope |
|---|---|
| **Multi-user / governance** | RBAC with real action-blocking, role-scoped inboxes, team boundaries |
| **External surface** | Inbound gate-unblock webhooks + the existing `external_check` contract (generic outbound / provider-specific apps stay deferred) |
| **Orchestration (standalone)** | Agents-as-actors standalone/continuous stages (see sibling doc); guard wedge dilution |
| **Narrow tools & hands** | Tool-count budgets, capability labels, sandbox profiles, warn-first policy on risky ops, on top of M14 caps (`PRODUCT_VIEW.md` §Phase 2.3) |
| **Automation surface** | Reusable hooks/skills/snippets/recurring routines visible in Project Settings; standard automations; specialist checks off the main run context (`PRODUCT_VIEW.md` §Phase 2.4) |
| **Flow & intake expansion** | More Flow templates; additional ACP executors after the claude/codex contract proves stable; CI/log intake + external board sync (gated on draft/publish/dedup/severity/cooldown) (`PRODUCT_VIEW.md` §Phase 2.7) |

---

## Owner-directed next bets

A curated short-list the owner has flagged as the next priorities (June 2026).
This is a **priority lens over the waves above**, not a sequence and not a second
parallelization plan; per-item timing tags carry the sequencing, and detail stays
in the epic/primitive each one extends (docs R7). The theme is to keep new surface
**flow-native and HITL-first** rather than bolt on a generic agent board.

### 1. Scheduled triggers — task, flow, and agent calls *(task slice shipped M28)*
The **task-target slice shipped as M28** (`run_schedules` + the seeded
`run_schedule.dispatcher` on the M24 tick, overlap policy × cap, trigger-now,
board Schedules tab — see `docs/system-analytics/run-schedules.md`, ADR-071).
Flow-target (mint a task per fire) and `agent_tick` targets remain open below.
Builds on **P5 scheduler** (the M24 slice shipped the clock, atomic claim, and
handler seams for all four `job_kind`s). Targets to schedule: a **task**, a
**flow**, and **agent calls** — likely through **one polymorphic mechanism**
(P5 already models `flow_run` / `agent_tick` / `command` as job kinds), possibly
two, possibly one — **to be settled by trying it**, not decided up front. Net-new:
- wire the `flow_run` (and, gated on E4, `agent_tick`) handlers from the existing
  seams,
- UI to create/edit a cron schedule on a task / flow / agent call,
- concurrency mapped to the **global cap (ADR #4)** per job kind — an over-cap
  tick queues or skips per the schedule's policy; never a second clock.

Kept inside the Flow/run spine: a schedule fires a real run with the same
gates / HITL / promotion, not a freeform side-channel.

### 2. Cost & observability — confirmed, after dogfood *(owner: after the M20 dogfood)*
Builds on **E2 Observatory** (read-only over ledgers; M23 slice shipped) and the
**Cost & economics** track (Wave 3, extends `cost.jsonl`). Owner direction: a
**confirmed** item, but sequenced **after the M20 dogfood** — roughly its
existing Wave-3 home, now a definite rather than a maybe (not pulled earlier).
Land the cost slice in the same read-only Observatory surface as the E2
correction-rate / Autonomy metrics. Net-new: spend by run / node / executor /
flow, the cache-resume (~$0.28/respawn) cost, and host memory for parallel runs.
No schema change beyond the existing `cost.jsonl` capture.

### 3. Mention-to-spawn — @actor triggers a run *(gated on E4)*
Builds on **E4 agents-as-actors** and the **M17 actor union** (`user |
api_token`, extended by an `internal_agent` actor). Net-new: @mention an
agent-actor on a task/run thread to spawn run N+1 against that task — the 1:N
task→run model already allows N+1; the mention is the new trigger.
**Explicitly deferred until agents-as-actors lands** (per owner).

### 4. External-agent surface — API + MCP for a separate conversational agent *(hypothesis — think first)*
Reframes a bespoke Telegram bridge. Builds on the **external-operations API + MCP
facade** (current scope), **M17 HITL-over-MCP** (`hitl_list` / `hitl_respond`),
and **E5 external surface**. Hypothesis to evaluate: instead of a custom IM
integration, expose enough operations through the API/MCP that a *separate
conversational agent* (its own ACP session / bot, its own context) drives MAIster
over that surface — create tasks, launch/track runs, answer permission/form HITL,
read readiness. A Telegram bot becomes one **client** of this agent-over-API
pattern, not a special case. Open questions:
- which operations the conversational agent needs beyond today's facade,
- whether the bot's agent runs as an `internal_agent` actor (ties to E4),
- auth/scoping for a long-lived conversational token,
- whether `human`-typed HITL stays human-only (M17 rule) when a person answers
  *through* the bot.

Status: **hypothesis, no commitment** — decide after thinking it through.

### 5. chat-with-agent — deferred to post-dogfood
A lightweight ad-hoc conversation with an agent, lighter than a **Scratch run**
(which already spins a worktree). Owner direction: revisit after the **M20
dogfood** — real usage will show whether scratch runs already cover this or a
lighter chat surface is wanted. Status: **deferred, decide post-dogfood**.

### 6. Flow design — pull the editor earlier *(candidate: before dogfood)*
Owner direction: move the **Flow-graph editor** earlier, possibly even **before
the M20 dogfood** (E1 editor / the Wave-3 "Flow-graph editor" track): bring
visual flow authoring forward so the flows we dogfood with are built and tuned on
the canvas, not hand-edited in `flow.yaml`.
The **view already shipped (M22)** — flow-graph view with live node-status, but
**read-only** (layout authored in the `flow.yaml` presentation section, ADR-064;
no write action). This bet adds the **edit** slice. **Write-target decision
(owner): lay in the authoring/override layer from the start** — edits land as
authored catalog revisions (M25 `authored_capabilities`, draft→publish), not by
mutating pinned plugin `flow.yaml`, so the editor works for installed (immutable,
tag-pinned) flows too. Pairs with an **agent-assisted Flow authoring** surface (a
coding agent that edits flows from a description, published via proposal→approve)
— see [`flow-authoring-assistant.md`](flow-authoring-assistant.md).

---

## Phase-2 coverage map

The waves lead with the work we scoped directly (knowledge loop, workbench,
context primitives). This table guarantees **every `PRODUCT_VIEW.md` §Phase 2
pillar is placed in a wave** so nothing falls out of sequencing. Detail stays in
PRODUCT_VIEW (cross-referenced, per docs R7 — not restated here).

| `PRODUCT_VIEW` §Phase 2 | Wave | Home in this roadmap |
|---|---|---|
| 1. Visual validation | 3 | "Eyes" track |
| 2. Curated project knowledge | 3 | E3 (project memory + references/freshness) |
| 3. Narrow tools & permissioned hands | 4 | "Narrow tools & hands" track (on M14 caps) |
| 4. Automation as product surface | 3–4 | E4 (routines/pings/actors) + "Automation surface" track |
| 5. Observability & attention routing | 3–4 | E2 (metrics) + "Attention routing" (Wave 3: summaries/notifications) + team-inbox expansion in E5 (Wave 4). The single-operator HITL inbox is in-flight M17. |
| 6. Cost & resource economics | 3 | "Cost & economics" track |
| 7. Flow & intake expansion | 3–4 | designer = E3 editor; templates/executors/intake/board-sync = Wave 4 |

Scope reconciliations against `PRODUCT_VIEW.md` "Deferred For Now":
- **Webhooks** — keep to inbound gate-unblock + the existing `external_check`
  contract; **generic outbound webhooks and provider-specific apps stay deferred**.
- **Benchmarking** — the A/B core is in scope (Wave 3); **benchmark dataset
  management and the judge-calibration lab stay deferred**.
- Everything else in PRODUCT_VIEW "Deferred For Now" remains deferred and is not
  pulled into any wave here.

## Builds on in-flight M17 (current scope — not a roadmap item)

The HITL hybrid surface ships on `feature/m17-hitl-hybrid-surface` (its own
committed plan), so it is **not** a roadmap improvement. It is a **foundation
this roadmap builds on**, and it lands primitives the items below must **reuse,
not reinvent**:

- **Durable cross-step var injection.** M17 adds an `injectedVars` param to
  `buildContext`/`executeStep`, backed by a durable `rework-comments-<step>.json`
  side-channel (explicitly never a completion sentinel). **P1/P7 must converge on
  this mechanism**, not add a parallel var/projection channel.
- **Service extraction + actor union.** M17 extracts `respondToHitl` and adds an
  `actor` union (`user | api_token`, `ensureApiTokenActor`) with the rule that a
  machine actor may answer `permission`/`form` HITL but **never** `human`. This is
  the actor model **agents-as-actors (E4)** extends (an `internal_agent` actor),
  and it fixes the boundary on what a background actor can resolve.
- **Granular scope-enforcement beachhead.** M17 adds opt-in
  `handleExt({requireScope})` on its two HITL ext routes — the first real
  per-route scope gate, without reopening the global binary model. So **E5
  governance is incremental** (per-route scope opt-in), not a monolithic Wave-4
  RBAC switch.
- **HITL-over-MCP.** M17 ships `hitl_list`/`hitl_respond` MCP tools — the external
  surface already grows here; **E5 external-surface** accounts for it, not
  re-proposes it.
- **New assessment signals.** `criticality` (flow-declared) + `human_confidence`
  (responder self-report) are added as **annotations, deliberately not re-gating**
  readiness. Treat them as **harvestable signals for E2/self-improvement**
  (criticality × rework = priority; low `human_confidence` = uncertainty) — **not**
  as routing inputs in P4, which would contradict the annotate-not-re-gate rule.

The M17 plan is internally consistent with the locked architecture (no engine
bump, additive migrations, no new run status, respects ADR-024/041/046) — no
roadmap-driven correction to the plan itself is warranted.

## Feature epics (reference detail)

### E1 — Workbench usability *(view/file-tree/diff shipped M22; editor → §6)*
**Shipped (M22):** flow-graph **view** with live node-status coloring; a repo
**file-tree** browser in the project and per-run workbench; base→run **diff** in
the workbench (extending the M18 review surface) — read-only over data that
already exists (evidence graph, artifacts, worktree). This unblocked the M20
dogfood as intended. **Remaining bet:** the flow-graph **editor** (write path),
pulled earlier per *Owner-directed next bets §6*.

**Graph rendering & layout.** The flow-graph view (shipped M22, ADR-064) and the editor (§6)
reuse the stack already in the codebase — **`@xyflow/react` (React Flow) +
dagre**, the same xyflow family the evidence graph uses (ADR-039) — so no new
dependency. **Display options live in a separate section of `flow.yaml`, apart
from node logic:** a dedicated presentation section holds per-node display
options (position x/y, size, color, …), each entry **referencing a node by
`id`** — co-located in the same manifest (one file, versioned with the flow) but
kept out of the node's logic so display never mixes into flow semantics. The
node definitions stay logic-only; the presentation section is **additive and
runner-ignored** (no engine bump). Dagre auto-layout seeds positions; manual
placement/size/color overrides persist in that section. Per-node selection
side-forms (edit a node's settings on the canvas) are an editor concern that can
be **deferred to the implementation period** — start with view + the
presentation section, add the side-forms incrementally.

The consolidated HITL surface (cross-project inbox / "Needs you (N)" badge /
in-card form) is **in-flight M17**, current scope with its own committed plan —
not a roadmap item. See *Builds on in-flight M17*.

### E2 — Observatory & Autonomy *(Wave 1)*
A read-only metrics surface over existing ledgers:
- **`correction_rate` = (rework + retries) / runs**, per artifact/flow/node — the
  north-star for whether the learning loop is working ("loss going down").
- **Autonomy Score = 1 − Σ(gate_wait_time) / total_run_time** — quantifies how
  rare and valuable human participation is. Targets 70–80%, not 100%.
- Signal harvesting: cluster rework instructions, gate verdicts, repeated
  retries by which artifact/instruction they implicate. **Repeatability =
  priority** (single corrections are noise).
Cheap, no schema change, and it tells us if the moat is real before we invest in
its write half. Its action-facing extension — **run summaries, ledger history,
and web→Telegram notifications** — is the "attention routing" track sequenced in
Wave 3 (`PRODUCT_VIEW.md` §Phase 2.5).

### E3 — Knowledge lifecycle / moat *(Waves 2–3)*
Close the loop that today only consumes git plugins read-only:
- **Authoring → publication**: create and version rules/skills/flows in-app and
  publish them as PRs to a catalog repo, with two-way sync back into the
  instance. This is the *write* side that makes improvement proposals
  actionable.
  - **Implemented Wave-1 slice (M25):** local authored cap model, draft/version
    lifecycle, local publish/archive, REST groundwork, and authored
    rule/skill projection into `capability_records`. PR publication and
    two-way catalog-repo sync remain Wave 2/3.
- **Self-improvement** (Improver → proposal inbox): harvested signals become
  drafted edits with rationale + evidence, dropped into an inbox. Human always
  edits and publishes — **nothing auto-applies** (the operator stays in control).
- **Project memory**: a durable lessons store (lesson → rule), the home for what
  the loop learns; surfaced into flow context.
- **Curated references & freshness**: managed local references (dependency APIs,
  architecture decisions, conventions, Flow docs) beside the lessons store, with
  rule freshness/cleanup so memory does not rot (`PRODUCT_VIEW.md` §Phase 2.2).
- **Benchmarking**: A/B harness to score caps/agents, feeding the catalog
  lifecycle (win-rate leaderboards, auto-deprecate consistently-harmful caps).

### E4 — Orchestration / agents-as-actors *(Waves 2–4)*
See [`agents-as-environment-actors.md`](agents-as-environment-actors.md). Built
on a single **scheduler service** (one clock, polymorphic jobs) and staged
flow-bound → standalone → continuous. **Dynamic routing** is a flow-engine
increment that fits here. Standalone/continuous actors widen the surface — gate
them behind the wedge-dilution risk noted in the sibling doc. **Mention-to-spawn**
(@actor triggers run N+1) is an owner-directed bet riding on this actor model —
see *Owner-directed next bets §3*.

### E5 — Multi-user / governance / external surface *(Wave 4)*
RBAC with real action-blocking (today roles are routing/audit labels),
team boundaries, role-scoped inboxes; bidirectional webhooks. Pull forward only
when going from single-operator toward team use and the 3 external installs.
The **external-agent surface** (API + MCP driving a separate conversational
agent, a Telegram client as the first consumer) is an owner-directed hypothesis
under this epic — see *Owner-directed next bets §4*.

---

## Foundational primitives (reference detail)

These are small, cross-cutting mechanics that unlock multiple epics. Several
already have dormant or partial machinery in the codebase.

### P1 — Structured node output channel *(keystone, Wave 1)*
Today agent/cli nodes emit only `stdout` text + files-on-disk; only **human**
nodes can set a structured named var (`steps.<id>.vars`). Give every node a way
to emit a **schema-validated** structured result (a conventional `output.json` /
node summary the runner parses into `node_attempts.vars`). The node declares an
output schema; the result is validated against it, `CONFIG` on mismatch — not a
free-form JSON blob. Reuses existing persistence (`node_attempts.vars` jsonb) and
`reduceLedger`. **This single primitive unlocks three things:**
- structured forward handoff (one node's summary → a later node's prompt),
- **agent-driven dynamic routing** (a node emits its chosen outcome — see P4),
- first-class judge/verdict signals for the observatory.

Pairs with **P7** (the run-context file is the on-disk projection of these vars).

### P2 — Prompt content injection *(Wave 2)*
Templates expose only artifact **metadata** (`kind`/`uri`/`validity`/`nodeId`),
never content. Add the ability to inject a prior artifact/file **body** into a
downstream prompt. Support **both** surfaces (they serve different ergonomics):
- a declarative flag — `input.requires: [{ artifact: plan, inline: true }]`,
- a template helper — `{{ artifacts.plan.content }}`.
Both share one resolver with a size cap, graceful fallback to a reference when
too large, and the existing secret-blocklist applied.

### P3 — Artifact post-conditions: diff-path assertions *(Wave 2 — still in discussion, not yet ADR-bound)*
The artifact layer validates only **presence + current validity**; there is no
notion of "this node was expected to change these repo paths." **Extend the
existing `artifact_required` gate** (rather than adding a new gate kind) with
optional diff-path assertions evaluated against the node's `diff` artifact
(already recorded, git-range locator): `must_touch` (glob set) and
`must_not_touch`. Emit the verdict as a first-class **`mutation_report`**
artifact. Reuses `blocking|advisory`, readiness integration, evidence-graph.
- `must_touch` — positive post-condition; the primary use; ships now.
- `must_not_touch` — **detect-after, not prevent-before.** It does NOT compete
  with M14 prevention; it complements it. To avoid two sources of truth, it
  **reads the M14 restriction set** rather than declaring its own path list.
  Today (M14 strict enforcement blocked on ADR-041) a blocking `must_not_touch`
  is a working post-hoc guardrail; after M14 lands it remains useful as audit
  evidence that the node stayed in bounds.
- Keep it narrow (path-set intersection over a git diff), not a content-policy
  engine. This is the first gate that inspects a payload; do not let it sprawl.

### P4 — Dynamic routing via a verifiable decision table *(Wave 2)*
Output-driven, **not** template-driven. **Branching is resolved by graph edges +
a declared decision table — never by conditional logic inside prompts/skills**
(deliberately not built; it keeps nodes simple and the flow inspectable). The
existing rework-comment injection is a variable, not a conditional, and stays.

A node carries a small, closed **`decide`** table that subsumes today's
confidence mechanism natively:

```yaml
decide:
  from: verdict          # verdict | output  — the signal source
  cases:
    - { outcome: approve, when: "confidence >= 0.8" }
    - { outcome: review,  when: "confidence >= 0.5" }
    - { outcome: rework,  default: true }
transitions: { approve: promote, review: human-review, rework: implement }
```

- `from: verdict` — uses the judge/gate verdict + confidence. Today's
  `confidence_min` is just sugar for a 2-case verdict table, so the existing
  mechanism fits with no break.
- `from: output` — the node emits its `outcome` directly via P1, validated to be
  in the declared set.
- **Verifiable:** closed `cases`; compile-time check that every `outcome` has a
  `transition`; runtime check that the chosen outcome is in the set; exactly one
  `default`. `when` is a tiny closed predicate grammar (verdict field · operator
  · number) — not template logic, never touches secrets.

Judge-driven routing needs nothing new; agent-driven routing depends on P1. The
deterministic single-outcome path stays the default.

**Flexibility headroom (deliberately kept, not stripped):** the table should be
expressive enough for real flows — compound predicates (AND/OR over the closed
grammar), more than one signal source per node (e.g. verdict *and* an emitted
output field), and an arbitrary number of named outcomes. The only hard
boundary is that it stays a **closed, verifiable, secret-safe grammar** — a
table the engine can fully validate at compile time, never a code/rules engine.
Exact predicate expressiveness is a design-time call within that boundary.

### P5 — Scheduler service (one clock, polymorphic jobs) *(Wave 1 long-lead)*
One unified clock — a stateless authorized **tick-route** driven by an external
cron (supervisor-timer fallback for single-box), extending the existing GC cron
route. Scheduling **logic stays in the web tier** (DB/preconditions/budgets
live there; the supervisor stays DB-free). The job model is **polymorphic**, not
agent-only:

| `job_kind` | Purpose | Budget |
|---|---|---|
| `system_sweep` | GC / keep-alive / reconcile (exists) | outside the cap |
| `command` | a "ping" — run a console command / hit a URL | light, outside the flow cap |
| `agent_tick` | launch an actor (agents-as-actors) | `MAISTER_MAX_CONCURRENT_AGENTS` |
| `flow_run` | scheduled flow launch | flow cap (ADR #4) |

Atomic claim (`UPDATE … WHERE next_run_at <= now() RETURNING`) so overlapping
ticks can't double-fire; one catch-up fire on clock outage, no backfill.

**Implemented Wave-1 slice (M24):** `scheduler_jobs`,
`scheduler_job_runs`, `agent_schedules`, `/api/cron/tick`, `/api/cron/gc`
compatibility over `system_sweep`, fixed-interval catch-up, stuck-attempt
reaping, handler seams for all four job kinds, and the disabled-by-default
single-box fallback timer.

### P6 — Cross-node session continuity, with explicit clear *(opt-in, Wave 2)*
Agent sessions are one-per-node and disposable; node N+1 does not inherit node
N's reasoning. Session-reuse machinery (`slash-in-existing`) and its
capability-consistency guard are already coded but **dormant** for the graph
engine — re-enabling is a config-surface change (un-hardcode the session mode),
not a green-field build. Expose it as a per-node setting:

```yaml
session: keep            # keep | new   (default: new — full isolation)
clear_on_enter: false    # when keep: reset the conversation at node entry
```

`keep` preserves reasoning and saves cold-start cost (~$0.28/respawn);
`clear_on_enter` gives a fresh reasoning context on the same warm session when
wanted. **This is an optimization layered on top of P1+P7, not the correctness
mechanism** — correctness must not depend on session memory (see P7). Trade-off:
reuse reintroduces session-bleed risk and complicates reconciliation, so it is
opt-in and the consistency guard (capability `profileDigest`) stays enforced.

### P7 — Run-context file (session-independent blackboard) *(Wave 1, pairs with P1)*
A **gitignored JSON file under a structured `.maister/` path** (not the worktree
root) that the runner maintains as the on-disk projection of run-level state: the
**intent** (task prompt), each node's **structured summary** (from P1), and the
**promoted variables**. Layout keyed by worktree, e.g.
`.maister/runs/<worktree-hash>.run.json` (exact path/shape finalized at
implementation). It sits in the already-excluded `.maister/` subtree, so it never
enters the diff or a commit. **What gets projected is config-driven** (default:
all node vars + summaries + intent); the selection config is refined at
implementation time.

Access (the one nuance of not living at the worktree root): the runner **injects
the file path into each node's prompt as a one-line pointer**; the agent reads it
on demand. This stays session-independent — the path is stable across a fresh,
cleared, or resumed session, so a brand-new session reconstructs the run from
this file + the worktree without us re-templating everything into the prompt.

It is the durable counterpart to P1 — P1 is the authoritative,
template-accessible record (`{{steps.X.vars}}`); P7 is the agent-readable
JSON projection.

---

## What already exists (honesty)

- **Diff review** (base→run→target) — M18; extend into the workbench (E1).
- **Judge-driven branching** (`ai_judgment` + confidence calibration) — the
  deterministic half of dynamic routing (P4).
- **Capability materialization** (per-session `settings.local.json` + MCP) —
  M14; delivery shipped, strict enforcement deferred (ADR-041).
- **Session-reuse + consistency guard** — coded but dormant in graph mode (P6).
- **`node_attempts.vars` + reduction** — exists; only human nodes populate it (P1).
- **`hash`/`size_bytes` columns** — present but never written (activate in P3).
- **GC cron route + concurrency scheduler** — exist; generalize for P5.

## Deliberately deferred

- Strict capability enforcement (blocked on the live-adapter spike, ADR-041).
- Cross-run artifact reuse, content-addressed blob store, full payload-schema
  validation (PRODUCT_VIEW Phase 2).
- Standalone/continuous actors before external validation (wedge-dilution risk).
- Hosted/managed agent runtime as anything other than a future additive option.
- **chat-with-agent** (ad-hoc non-flow conversation) — revisit after the M20
  dogfood (see *Owner-directed next bets §5*).

## Relationship to existing docs

- Extends `PRODUCT_VIEW.md` Phase 2 and `VISION.md` harness layers (Eyes,
  Knowledge, Hands, Automation, Observability, Economics).
- Builds on ADR #1 (ACP, no polling), #4 (concurrency), #5 (multi-executor +
  override chain), #6 (packaging/materialization), #7 (workspace lifecycle), and
  M12 typed artifacts / M14 capabilities.
- Orchestration detail lives in
  [`agents-as-environment-actors.md`](agents-as-environment-actors.md).
