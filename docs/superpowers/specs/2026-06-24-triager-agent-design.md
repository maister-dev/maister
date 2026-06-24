# Design — Triager Agent + Generic Agent-Config Framework

- **Date:** 2026-06-24
- **Status:** Draft (pre-implementation design spec)
- **Author:** brainstorming session (owner + Claude)
- **Graduates to:** two ADRs (agent-config framework; triager agent) + a new
  `docs/system-analytics/triage.md` domain doc, at implementation time.

## 1. Problem

We want a **triager agent** that, given a task's request, sets its `flow`,
`runner`, and `base branch`, detects duplicates, forms dependencies on other
tasks, evaluates clarity, and (optionally) places the task into the execution
queue.

The surprise from research: **~80% of the substrate already exists** (M34,
ADR-089/090). The work is (a) one model extension the owner asked for —
per-instance agent configuration — and (b) a small number of concrete gaps.
The triager agent definition itself does not exist yet; the M34 substrate was
clearly built in anticipation of it.

## 2. Goals / Non-goals

**Goals**

1. A single triager **platform agent** (not two), running on the M34
   substrate, configurable **per project instance**.
2. A **generic agent-config framework**: an agent declares typed config
   params in its `.md`; each project instance sets values; runtime resolves
   and injects the effective config. The triager is its first consumer.
3. Close three substrate gaps: flow/runner **discovery** for agents,
   **duplicate** modelling, and an **auto-launch** path for triaged flow
   tasks.

**Non-goals (explicitly out of scope)**

- **PRD authoring is NOT the triager's job.** Flow selection does not depend
  on a PRD (the project's flows self-describe applicability via
  `metadata.route_when`; bugfix vs new-feature is obvious from the task).
  A PRD, "in the limit", is a **node inside an execution flow** that produces
  a typed artifact (M12) — authored as a separate flow, not by the triager.
  Therefore: no `tasks.prd` column, no `prd` intake mode in this build.
- Semantic/embedding-based duplicate search. The triager reasons over the
  backlog it reads (`task_list`). Embeddings are a later upgrade for large
  backlogs (§9).
- Cross-project triage. Same-project only (Stage-1 relation constraint).

## 3. What already exists (reused, not rebuilt)

| Capability | Existing substrate | Reference |
| --- | --- | --- |
| Read the task / its request | `task_get`, `task_list`; domain-event payload | `mcp/src/tools.ts` |
| Set flow | `triage_set` → `flowId` (allow-list validated) | `web/lib/services/triage.ts:61` |
| Set runner | `triage_set` → `runnerId` (enabled-catalog validated) | `web/lib/services/triage.ts:82` |
| Set **base branch** | `triage_set` → `baseBranch` (already accepted) | `web/app/api/v1/ext/projects/[slug]/tasks/[taskId]/triage/route.ts:30`, `web/lib/services/triage.ts:101` |
| Dependencies between tasks | `relation_add` → `blocks` / `depends_on` / `parent_of`; `blocked` gates launch everywhere | `web/lib/runs/launchability.ts:84` |
| Trigger on create / re-triage / reply | domain events `task.created`, `task.triage_requeued`, `task.comment_added`; agent event-trigger with self-exclusion | `web/lib/domain-events/taxonomy.ts:6` |
| Q&A with a human | `comment_create` (agent actor) → human reply → re-trigger | `docs/system-analytics/agents.md` §e |
| Per-instance overrides plumbing | `agent_project_links` already holds `runnerOverrideId`, `branchBase`, `executionPolicyOverride` | `web/lib/db/schema.ts:840` |
| Flow applicability metadata | `flow.yaml` `metadata.{title, summary, route_when, labels}` **already in the schema** | `web/lib/config.schema.ts:1079` |
| Queue / concurrency | `Pending` → `promoteNextPending`; global cap 6 | `web/lib/scheduler.ts` |

**The three real gaps:** (1) no MCP tool lets an agent enumerate the
project's flows/runners; (2) no duplicate modelling (no `duplicate_of`
relation kind, no "flagged" task state); (3) the existing auto-launcher
(`auto_launch_run_plan`) is orchestrator-specific (requires
`parent_of`-under-orchestrator + `delegation_spec.agentId`, launches *agent*
runs) — it does not launch ordinary triaged **flow** tasks
(`web/lib/domain-events/auto-launch.ts:267`).

## 4. Architecture overview

Two deliverables + three substrate additions:

1. **Generic agent-config framework** (model extension).
2. **Triager agent** `maister-agents/triager.md`, shipped in a new **core
   package inside the `maister-plugins` repo**.
3. Substrate: `flow_list` + `runner_list` MCP tools; `duplicate_of` relation
   kind + `flagged` task state; `auto_launch_triaged` scheduler tick.

The triager **never calls `run_launch` itself**. It only sets the enqueue
*intent* (`launchMode='auto'`); a system-authority tick performs the launch
through the standard precondition choke point. This keeps the agent's blast
radius minimal.

## 5. Component 1 — Generic agent-config framework

### 5.1 Declaration (agent `.md` frontmatter)

New optional `config:` key — an array of typed parameter declarations:

```yaml
config:
  - key: auto_enqueue
    type: enum
    values: [off, when_confident, always]
    default: off
    label: "Auto-enqueue after triage"
    description: "..."
  - key: detect_duplicates
    type: boolean
    default: true
  - key: intake_mode
    type: enum
    values: [triage_only, clarify]
    default: clarify
```

Supported types (minimal): `boolean | enum | string | number`. Parsed and
strictly validated in `web/lib/agents/definition.ts` (bad schema →
`MaisterError("CONFIG")`, the catalog row is not written — matches existing
behaviour for invalid frontmatter).

### 5.2 Storage

- `agents.config_schema` (jsonb) — the declared schema, projected from the
  package file at install/resync so the UI renders a form without re-reading
  the package.
- `agent_project_links.config` (jsonb) — per-instance values; `null` ⇒ all
  defaults. Written through one aggregating PATCH (admin-page convention).

### 5.3 Resolution + injection

- `resolveAgentConfig(link, definition)` merges instance value → declared
  default (two levels; no project/platform tier — YAGNI).
- The resolved config is **snapshotted** at spawn into `runs.agent_config`
  (jsonb, immutable, exactly like `runs.execution_policy`).
- The agent reads it via **injection into the system prompt** at spawn (a
  small "Effective configuration" context block). No new MCP tool.

### 5.4 UI

The existing per-instance panel (M39 `agents-attach-panel.tsx` +
`agents-attach-edit-modal.tsx`) gains a **Configuration** section that
renders each declared param (toggle / select / input) seeded from the
effective values and saves via the existing aggregating PATCH. EN + RU.

## 6. Component 2 — Triager agent

### 6.1 Definition (`maister-agents/triager.md`)

Frontmatter:

```yaml
name: Triager
description: "Routes simple-intent tasks: flow, runner, base branch, dedup, deps, enqueue."
workspace: none
mode: session
triggers: [domain_event, manual]
risk_tier: read_only
recommended:
  events: [task.created, task.triage_requeued, task.comment_added]
config:
  - { key: auto_enqueue, type: enum, values: [off, when_confident, always], default: off }
  - { key: detect_duplicates, type: boolean, default: true }
  - { key: intake_mode, type: enum, values: [triage_only, clarify], default: clarify }
```

No `flow:` field ⇒ it runs as a standalone `run_kind='agent'` session on the
agent concurrency budget. `workspace: none` ⇒ no repo access; all reads and
writes are control-plane through the MCP facade.

### 6.2 Behaviour (system prompt logic)

1. **Load context** — `task_get`, the backlog (`task_list` → title / prompt /
   status), and the catalog (`flow_list`, `runner_list`).
2. **Dedup** (if `detect_duplicates`) — a strong match ⇒ `relation_add(kind=
   duplicate_of, toNumber=N)` + `comment_create("possible duplicate of
   KEY-N …")` + set status `flagged`. **Stop** — no verdict, no enqueue.
3. **Routing (tier-1 clarity floor — unconditional).** Match the task to a
   flow via `route_when` / `summary`. If it cannot pick a flow confidently:
   - `intake_mode = triage_only` → set `flagged` (hand to a human; reason in
     comment/activity). No questions.
   - `intake_mode = clarify` → `comment_create(question)` + @mention the
     creator (drives "Needs you"). **Stop.** The task stays **untriaged /
     `unconfigured` ⇒ not launchable** (safe). A human reply emits
     `task.comment_added` → re-trigger → refine the statement
     (`task_update` prompt) → retry from step 1. A **max-rounds guard**
     (e.g. 3) falls back to `flagged`.
4. **Execution clarity (tier-2 — mode-dependent).** `clarify` may ask
   additional questions and refine the statement before triaging;
   `triage_only` defers detail questions to the **flow's own HITL during the
   run**.
5. **Dependencies** — related-but-distinct tasks ⇒ `relation_add(kind=
   depends_on | blocks, …)`.
6. **Verdict** — `triage_set(flowId, runnerId, baseBranch, targetBranch?,
   promotionMode?)` ⇒ stamps `triaged`. The task is now launchable.
7. **Enqueue** (per `auto_enqueue`):
   - `off` → stop (a human / scheduler launches).
   - `when_confident` → if confident and no open questions/blockers, set
     `launchMode='auto'`; else stop at launchable.
   - `always` → set `launchMode='auto'`.

### 6.3 Clarity model — the two thresholds

The owner's question "ask before or during work?" resolves to **two distinct
thresholds**:

- **Routing clarity** is a *hard floor*: you cannot triage a black box. If
  the triager cannot pick a flow, it asks **before** (`clarify`) or flags
  (`triage_only`). Enforced in both modes.
- **Execution clarity** is *configurable*: `triage_only` triages on the best
  obvious route and lets the flow agent ask **during** work; `clarify`
  refines **before**.

So it is not "before *or* during" — it is "routing always before; details by
mode".

### 6.4 Task triage-state model

`tasks.triageStatus`: `null | 'triaged' | 'flagged'`.

- `null` — untriaged. Either fresh, or a `clarify` task waiting for an
  answer (the open question lives in the comment thread + inbox; no separate
  state needed). `unconfigured` ⇒ not launchable.
- `'triaged'` — verdict set; launchable.
- `'flagged'` — the triager bailed and a human must look (duplicate, or
  unroutable in `triage_only`). **Held — not launchable.** The reason is
  carried in the comment + `task_activity` payload; the board shows a
  "needs review" chip. Clearing it (human removes `duplicate_of` / re-sends
  to triage) returns the task to the normal path.

The triager re-enters statelessly: each run reconstructs context from the
task + its comment thread (`comment_list`), so a `clarify` resume just reads
its prior question and the human's reply.

## 7. Component 3 — substrate additions

### 7.1 Discovery MCP tools

`flow_list` and `runner_list` (read-only), added to `TOOL_SPECS`
(`mcp/src/tools.ts`) backed by new ext routes
`GET /api/v1/ext/projects/{slug}/flows` and `…/runners`, gated by new token
scopes `flows:read` and `runners:read` (added to the agent token scope set).

- `flow_list` returns, per project flow: `id`, `metadata.title`,
  `metadata.summary`, `metadata.route_when`, `metadata.labels` — the
  "when/what to apply" the triager matches against. All flows of all packages
  attached to the project are available (no curation knob).
- `runner_list` returns enabled runners: `id`, `adapter`, `model`, `provider`
  so the triager can choose intelligently.

### 7.2 `duplicate_of` relation kind + `flagged` status

Migration:

- `task_relations.kind` enum + the `task_relations_kind_check` DB constraint
  gain `duplicate_of`. It is **informational** — it does not gate launch (the
  `flagged` status holds the task).
- `tasks.triageStatus` enum widens to `['triaged', 'flagged']`.

`relation_add` MCP tool + ext route accept `duplicate_of`. The triage op (or
a small dedicated op) can set `flagged`.

### 7.3 Auto-launch tick for triaged flow tasks

A new sweep job (`auto_launch_triaged`) on the M24 polymorphic scheduler
clock. Each tick, find and launch candidates:

```
triageStatus = 'triaged'
AND launchMode = 'auto'
AND flowId IS NOT NULL
AND classifyTaskLaunchability(task, latestRun, relationGate) = 'launchable'
AND no live run
AND not an orchestrator as-plan task
→ standard flow-launch (global cap → Pending if full)
```

Reusing `classifyTaskLaunchability` + `getOpenRelationBlockers`
(`web/lib/domain-events/auto-launch.ts:303`) means a task blocked by a
dependency stays `triaged + blocked` and **launches itself once the blocker
clears** — the owner's "wait in queue for predecessors, then fly" scenario,
handled by one sweep with no extra wiring. The predicate is **disjoint** from
`auto_launch_run_plan` (which requires `parent_of`-under-orchestrator +
`delegation_spec.agentId`), so there is no collision.

A tick was chosen over an event consumer because it naturally re-evaluates
dependency-release without subscribing to every run-terminal event (the owner
accepted a timer). Event-driven responsiveness is a later optional upgrade.

## 8. Data model — one migration

- `agents.config_schema` jsonb null
- `agent_project_links.config` jsonb null
- `runs.agent_config` jsonb null
- `tasks.triage_status` enum → `['triaged', 'flagged']` (+ check if present)
- `task_relations.kind` enum + `task_relations_kind_check` → add
  `duplicate_of`

No `tasks.prd` (PRD is out of scope, §2). Migration number and ADR numbers
are assigned at implementation and **renumber-checked at merge** per the
project's migration/ADR discipline.

## 9. Safety & trust

- Triager `risk_tier: read_only`, `workspace: none` ⇒ nothing in the repo to
  protect; the 3-layer read-only enforcement and dirty-watchdog are trivially
  satisfied.
- Agent token scopes extend only with read-only `flows:read` / `runners:read`
  on top of the existing `tasks:triage` / `relations:*` / `comments:*`. The
  triager has **no** `runs:launch` scope.
- Enqueue is the `launchMode='auto'` *intent* only; the actual launch runs
  under system authority through the **same precondition choke point** (clean
  repo, branch free, worktree free, concurrency cap). The triager cannot
  bypass any launch safety.
- Auto-launch is gated by per-instance `auto_enqueue` (default `off`).

## 10. Build sequence (each phase independently testable)

1. **Generic config framework** — declaration + storage + resolver +
   injection + `runs.agent_config` snapshot + instance-panel UI.
2. **Discovery MCP** — `flow_list` / `runner_list` (+ scopes, ext routes).
3. **Dedup substrate** — `duplicate_of` + `flagged` migration + op
   extensions.
4. **Auto-launch tick** — `auto_launch_triaged` sweep.
5. **Triager agent** — `maister-agents/triager.md` (`triage_only` + `clarify`)
   + the core package in `maister-plugins` + register / enable / trust path.

## 11. Future / open

- **PRD-as-flow-node** — author a flow whose first node drafts and validates a
  PRD as a typed artifact (M12); the triager routes to it. Separate work.
- **Embedding-based dedup** — when backlogs outgrow what `task_list` reasoning
  handles, add a similarity search behind the same dedup step. Log the
  truncation if the triager only inspects a capped slice.
- **Event-driven auto-launch** — emit `task.triaged` and consume it for
  lower-latency enqueue, keeping the tick as the dependency-release backstop.

## 12. Resolved decisions (this brainstorm)

1. **Autonomy** — make launchable by default; auto-enqueue is a per-instance
   config knob; one agent, not two; the triager sets intent, a tick launches.
2. **Duplicates** — new `duplicate_of` relation + `flagged` status; on a dup
   the triager links + comments + flags, fills no verdict, does not enqueue.
3. **Trigger** — auto on `task.created` + explicit send-to-triage (+
   `task.comment_added` for the clarify loop).
4. **Config model** — generic, agent-declared config framework (not a
   triager-specific hack).
5. **Host package** — a new core package in the `maister-plugins` repo.
6. **Config read** — inject into the system prompt; persist `runs.agent_config`.
7. **Auto-launch** — M24 tick reusing launchability (handles dependency
   release).
8. **Flow discovery** — all attached-package flows; match on
   `metadata.route_when` / `summary`.
9. **PRD** — out of the triager; it is a flow-execution concern.
10. **Clarity** — two thresholds: routing (hard floor, ask/flag before) vs
    execution (mode-dependent, before vs during).
