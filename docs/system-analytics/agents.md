# Platform agents domain

## Purpose

Platform agents (**Implemented**, ADR-089/ADR-090, M34; Stage 3 of the
platform-agents staged design) are first-class `.md`-defined actors — a
triager, reviewers, monitors — shipped as `agents/<stem>.md` files INSIDE
flow packages (same trust contour, versioning, and Studio authoring path),
projected into a platform catalog under package-qualified ids
(`<flowRefId>:<stem>`), attached to projects, executed as ACP sessions on
the existing `runs` substrate under a separate concurrency budget, and
triggered from five sources (manual, cron, domain event, webhook, flow
binding). Boundary: this domain owns the agent catalog (`agents`,
`agent_project_links`), trigger bindings (`agent_schedules` rework), the
agent-run launch path (per-project effective-definition resolution,
workspace axis, runner chain, read-only enforcement, quarantine), agent
tokens, and the triage verdict surface on tasks. It does NOT own the run state machine
([runs.md](runs.md)), the outbox mechanics ([domain-events.md](domain-events.md)),
the social substrate it writes through ([social-board.md](social-board.md)),
the clock ([scheduler.md](scheduler.md)), or capability enforcement
(materialize-only per ADR-041/ADR-043 — [flow-settings.md](flow-settings.md)).

**Package-viewer agents are a separate surface, NOT this catalog.** The Flow
Studio package viewer ([package-viewer.md](../screens/studio/package-viewer.md))
splits a package's `.md` agents into package-root `maister-agents/<stem>.md`
(platform-agent definitions — rich view + structural editor) and
`capability/**/agents/*.md` (Claude subagents materialized into the run's
`.claude/agents/` at launch — NOT platform-agents). That split is
package-viewer-only: it does NOT feed this `/agents` catalog or its
`<flowRefId>:<stem>` projection (which still reads the flow's `agents/<stem>.md`).
Wiring `maister-agents/` into the catalog/registry is a non-goal of the current
change (**Phase 2**).

## Domain entities

- **`agents`** (Implemented) — catalog projection over `agents/<stem>.md`
  inside the providing package's NEWEST Installed revision: `{ id (PK,
  package-qualified `<flowRefId>:<stem>`), flow_ref_id, version_label,
  origin (git|authored), name, description, runner_id?, workspace
  (none|repo_read|worktree), workspace_ref?, mode (session|subagent),
  triggers jsonb, capability_profile jsonb?, risk_tier
  (read_only|standard|destructive), recommended jsonb?, source_path,
  enabled, quarantined_at?, quarantine_reason? }`. The package file is the
  source of truth; registration after install finalize (and `resync`)
  re-syncs every column (SET/CLEAR symmetric); rows whose providing package
  vanished are disabled, never deleted. The EFFECTIVE definition for a
  launch in project P resolves through P's pinned revision (see flow (b)).
  See [db/agents-domain.md](../db/agents-domain.md).
- **`agent_project_links`** (Implemented) — attachment + per-project overrides:
  `{ agent_id, project_id, enabled, runner_override_id? }`,
  `UNIQUE(agent_id, project_id)`. Attach requires the providing package
  configured+enabled in the project; the attach panel pre-fills from the
  definition's `recommended` block.
- **`agent_schedules`** (Implemented rework of the dead M24 table) — trigger
  bindings per (agent, project): `trigger_type='cron'` rows carry
  `cron_expr + timezone + next_fire_at + last_fired_at`;
  `trigger_type='event'` rows carry `event_match.kinds` (subset of the
  ADR-086 taxonomy). `agent_ref` (text), `scheduler_job_id`, and
  `desired_state` are dropped (`continuous` is the future Mγ stage).
- **Agent runs** (Implemented) — `runs` rows with `run_kind='agent'`, nullable
  `agent_id`, `trigger_source (manual|cron|domain_event|webhook|flow)`,
  `trigger_event_id?` (claim key), `trigger_payload?` (≤ 32 KB). Budgeted by
  `MAISTER_MAX_CONCURRENT_AGENTS` (default 3), separate from the
  flow/scratch pool. Task-bound agent runs never flip `tasks.status` and
  never bump `attempt_number`.
- **Agent tokens** (Implemented) — `project_tokens` rows with
  `token_kind='agent'` + `agent_id`, issued per launch with the fixed scope
  set `tasks:read, tasks:triage, comments:read, comments:create,
  relations:read, relations:create, relations:delete`, revoked at the run's
  terminal transition / link detach / GC. Token actor =
  `{ type: 'agent', id: agent_id }` (the ADR-083 pair's first writer).
- **Triage verdict surface** (Implemented) — `tasks.flow_id` nullable
  (simple-intent creation) + verdict columns `runner_id`, `target_branch`,
  `promotion_mode`, `triage_status` (`'triaged'` | NULL); the
  `unconfigured` launchability value; the `task.triage_requeued` emitter.
  See [tasks.md](tasks.md).

## State machine

Agent catalog lifecycle (`agents` row; the agent-run lifecycle is the
standard run FSM in [runs.md](runs.md) — no new run statuses). All
transitions Implemented.

```mermaid
stateDiagram-v2
    [*] --> Registered: .md parsed OK — row upserted
    Registered --> Disabled: enabled = false (UI toggle)
    Disabled --> Registered: enabled = true
    Registered --> Quarantined: dirty-watchdog hit<br/>quarantined_at + reason set
    Quarantined --> Registered: explicit un-quarantine action
    Registered --> Disabled: providing package/file missing on resync
```

## Process flows

### (a) Registration / re-sync (Implemented)

Definitions ship inside flow packages; the install finalize hook (git
install, upgrade, and the authored Studio bridge share it) scans the
revision's `agents/` dir and projects the catalog. Parsing never executes
content; invalid files are reported, never written.

```mermaid
flowchart TD
    I[flow revision reaches packageStatus=Installed] --> S[scan installed_path/agents/*.md]
    S --> P{frontmatter valid?<br/>strict schema, scope/project keys refused}
    P -- no --> R[reported in the registration summary — row NOT written]
    P -- yes --> U[upsert agents row under flowRefId:stem<br/>provenance + SET/CLEAR symmetric]
    RS[resync] --> N[newest Installed revision per flow_ref wins]
    N --> S
    RS --> D[rows whose providing package vanished → enabled=false]
```

### (b) Standalone launch (manual / cron / domain_event / webhook share this path) (Implemented)

All four standalone triggers converge on one launch service; only the entry
and the trigger metadata differ.

```mermaid
sequenceDiagram
    participant E as trigger entry
    participant L as launchAgentRun
    participant R as runner resolver
    participant S as supervisor
    E->>L: agent_id, project_id, task_id?, trigger meta
    L->>L: link enabled for project, then kill-switches — enabled, not quarantined
    L->>L: resolve EFFECTIVE definition — project's pinned revision<br/>behind enablement+trust gates (pin divergence refuses)
    L->>L: guards on the effective parse — risk_tier != destructive,<br/>mode=session, trigger declared
    L->>R: launch override → link override → effective runner →<br/>project default → platform default
    R-->>L: snapshot or EXECUTOR_UNAVAILABLE<br/>(subagent×non-claude / repo_read×skip-permissions)
    L->>L: workspace axis — none: mkdir workdir<br/>repo_read: clean baseline (or workspace_ref resolves)<br/>worktree: addWorktree + workspaces row
    L->>L: INSERT runs (kind=agent, trigger_*) + budget check
    L->>S: spawn — re-resolve effective, ephemeral -ro checkout if<br/>workspace_ref, L2 materialize, profile MCPs (exec-trust gated),<br/>POST /sessions (readOnlySession, facade + token env)
```

### (c) Cron + event dispatch (Implemented)

The seeded singleton `agent_tick.dispatcher` job (60 s) claims due cron rows
atomically; the `agent_triggers` outbox consumer claims event matches by
run-row insert. Both recover stranded `Pending` agent runs via
`promoteNextPending(kind='agent')` on the tick.

```mermaid
flowchart TD
    T([agent_tick.dispatcher tick / 60s]) --> Q[scan agent_schedules cron rows<br/>enabled AND next_fire_at <= now]
    Q --> CL{atomic claim — UPDATE SET next_fire_at = next<br/>WHERE id = ? AND next_fire_at <= now RETURNING}
    CL -- zero rows --> SKIP[another tick won — skip]
    CL -- claimed --> LA[launchAgentRun trigger_source=cron]
    T --> PR[promoteNextPending kind=agent — recovery sweep]
    D([agent_triggers consumer batch]) --> M[match kind+project to event rows × links<br/>skip self-actored events]
    M --> INS{INSERT Pending run with agent_id + trigger_event_id<br/>ON CONFLICT DO NOTHING}
    INS -- conflict --> DUP[duplicate redelivery — exactly-one converges]
    INS -- inserted --> LB[tryStartRun trigger_source=domain_event]
```

### (d) Triage Q&A loop (Implemented)

The triager converges over several turns by asking questions as ordinary
task comments; structural loop-termination is the self-exclusion guard.

```mermaid
sequenceDiagram
    participant H as human
    participant B as outbox bus
    participant A as triager agent run
    participant T as task
    H->>T: create task (title + prompt, no flow)
    T->>B: task.created
    B->>A: trigger (event subscription)
    alt verdict ready
        A->>T: POST triage — flow/runner/branch/policy,<br/>stamps triage_status='triaged'
    else needs input
        A->>T: comment_create (agent actor) — question
        Note over B: agent-actored comment event —<br/>self-exclusion guard: NOT re-triggered
        H->>T: reply comment
        T->>B: task.comment_added (user actor)
        B->>A: re-trigger — context carries comment + thread tail
    end
    H->>T: optional "Send to triage" — triage_status=NULL +<br/>task.triage_requeued emit (one tx)
```

### (e) Flow binding (Implemented)

`agent: <id>` on an `ai_coding` node (engine ≥ 1.5.0) resolves the catalog
profile at compile/launch; execution stays inside the flow run's session —
no separate agent-run row in this stage.

```mermaid
flowchart TD
    N[node settings agent: id] --> V{compile validation<br/>agent exists AND triggers includes flow?}
    V -- no --> C[CONFIG at save/launch]
    V -- yes --> M{mode}
    M -- session --> S[substitute profile — agent body = system prompt,<br/>node prompt = task block, settings merged, node wins]
    M -- subagent --> K{runner capability_agent = claude?}
    K -- no --> EU[EXECUTOR_UNAVAILABLE before spawn]
    K -- yes --> W[materialize .claude/agents/name.md into worktree]
```

### (f) Dirty-watchdog + quarantine (Implemented)

For `none`/`repo_read` runs the no-write invariant is verified at the
terminal transition, inside the terminal choke point.

```mermaid
flowchart TD
    P[pre-spawn: statusPorcelain snapshot — MUST be clean] --> RUN[agent run executes]
    RUN --> TT([terminal transition — inside the choke point])
    TT --> RST[restore manifest-tracked L2 files]
    RST --> CHK{statusPorcelain dirty<br/>beyond manifest?}
    CHK -- no --> OK[revoke agent token — terminal flip commits]
    CHK -- yes --> QT[ONE tx: agents.quarantined_at + reason,<br/>system comment if task-bound,<br/>agent_quarantined activity]
    QT --> REF[every later launch refused PRECONDITION<br/>until explicit un-quarantine]
```

### (g) Subagent materialization for scratch (Designed — FR-C4)

Today subagent `.md` materialization happens **only** for flow-bound
`subagent` nodes: flow (e) calls `resolveFlowBoundAgent`
([flow-binding.ts](../../web/lib/agents/flow-binding.ts)) which writes the
single bound `.claude/agents/<stem>.md` into the worktree at launch. The
Unified Capability Composer (Designed, FR-C4) **extracts** that
`.claude/agents/<stem>.md` writing out of flow-binding into the shared
materialize step ([materialize.ts](../../web/lib/capabilities/materialize.ts))
and invokes it for **scratch** runs too — so a claude scratch session
surfaces the project's coder subagents as `@<name>` references in the
composer alongside skills.

```mermaid
flowchart TD
    SUB[scratch launch — final pinned runner] --> T{adapter materialization-target<br/>supports.subagents?}
    T -- claude only --> MAT[materialize step writes<br/>.claude/agents/&lt;stem&gt;.md for every<br/>enabled+trusted subagent — getProjectAgentsView]
    T -- codex / others --> OMIT[no subagent files written<br/>references stay advisory-only on this runner]
    MAT --> BROAD[broad scratch policy:<br/>subagents alongside skills — see capabilities.md]
```

Designed contract:

- **Claude-only by descriptor.** Subagents materialize only where the
  adapter's materialization-target `supports.subagents` is true — currently
  **only `claude`**. codex and the other adapters omit subagent files, so a
  subagent reference is **advisory-only** on those runners: the composer shows
  a non-universality badge and the run-time path emits a WARN and proceeds
  (FR-E5). NO hard `CONFIG`.
- **Source set.** The materialized claude subagents are the project's
  enabled+trusted `agents` rows with `mode='subagent'`, enumerated via
  `getProjectAgentsView` ([project-links.ts](../../web/lib/agents/project-links.ts)),
  written as `.claude/agents/<stem>.md` files (lazy-loaded by the agent — files,
  not prompt-dumped).
- **Broad scratch policy.** Scratch materialization includes all
  enabled+trusted subagents (claude) **alongside** skills; the skill side and
  the per-runner surface-form split are owned by
  [capabilities.md](capabilities.md) and [acp-runners.md](acp-runners.md) — not
  restated here.
- **Crash window.** Materialization is part of the staged launch; if a launch
  is cancelled or fails after the materialize step but before
  `session_ready`, the written subagent (and skill) files are cleaned up with
  the worktree/session so no orphaned `.claude/agents/*.md` survives a failed
  scratch launch.

## Expectations

- Registration MUST never write an invalid definition's row (invalid files
  are reported in the registration summary) and MUST never execute
  definition content; ids MUST be package-qualified `<flowRefId>:<stem>`.
- Re-registration MUST sync every parsed frontmatter field with SET/CLEAR
  symmetry; `resync` MUST project the newest Installed revision per
  flow_ref and disable (never delete) rows whose providing package
  vanished.
- A launch in project P MUST run the definition from P's PINNED revision of
  the providing package behind the flow-launch gates (configured pin,
  enabled pointer, enablement allow-list, trust, revision Installed) —
  resolved at launch for the guards and again at spawn for the prompt; pin
  divergence (a trigger the pinned version lacks) MUST refuse
  `PRECONDITION`. Attach MUST refuse when the package is not
  configured+enabled in P.
- A standalone launch MUST resolve the runner through exactly
  `launchOverride → link override → effective definition runner → project
  default → platform default`, and MUST refuse `mode=subagent` on a
  non-`claude` capability runner and `workspace ∈ {none, repo_read}` on
  `permission_policy=dangerously_skip_permissions` with
  `EXECUTOR_UNAVAILABLE` before spawn.
- `run_kind='agent'` runs MUST be admitted only by the
  `MAISTER_MAX_CONCURRENT_AGENTS` budget (default 3) and MUST NOT consume
  `flow`/`scratch` slots; each pool promotes its own `Pending` FIFO.
- An event-triggered spawn MUST claim by inserting the `Pending` run with
  `(agent_id, trigger_event_id)` under the partial UNIQUE index; duplicate
  redelivery MUST converge to exactly one run.
- The `agent_triggers` consumer MUST skip an event whose
  `(actor_type, actor_id)` equals `('agent', <matched agent id>)` —
  the triager's own comments never re-trigger it.
- A cron fire MUST be claimed by the atomic
  `UPDATE … SET next_fire_at = <next> WHERE id = ? AND next_fire_at <=
  now() RETURNING` with exactly one winner; a missed window fires once and
  never backfills.
- A `repo_read` launch MUST require an empty `statusPorcelain(repo_path)`
  baseline (`PRECONDITION` otherwise) UNLESS `workspace_ref` is set — then
  the ref MUST resolve at launch (no auto-fetch), the run gets an ephemeral
  detached checkout at `worktreesRoot()/<slug>/<runId>-ro`, L3 targets that
  dir, and it is removed after the terminal flip commits;
  `none`/`repo_read` runs MUST create no `workspaces` row.
- A `readOnlySession` session MUST auto-deny write-class permission
  requests, auto-approve only the read-safe allow-list, and MUST create no
  `hitl_requests` rows.
- The dirty-watchdog and the agent-token revoke MUST run inside the terminal
  choke point with no `runs` writes after the terminal flip; a
  beyond-manifest dirty result MUST quarantine in ONE transaction
  (`agents.quarantined_at` + system comment when task-bound +
  `agent_quarantined` activity).
- Disabled, quarantined, or `risk_tier='destructive'` (while ADR-041 stays
  blocked) agents MUST be refused with `PRECONDITION` at every launch entry
  point: manual, cron, domain_event, webhook, flow binding.
- Agent tokens MUST be per-launch ephemeral with exactly the fixed scope
  set, revoked at terminal/detach/GC; the token value MUST never be logged,
  streamed, or client-visible, and token-derived writes MUST carry the
  `{ type: 'agent', id }` actor with `token_audit_log.actor_label =
  'agent:<id>'`.

## Edge cases

- **Invalid frontmatter (incl. the dead `scope`/`project` keys)** → reported
  in the registration summary; the catalog row is untouched. Id collisions
  are impossible by construction (package-qualified ids).
- **Providing package not configured/enabled in the project, or pinned
  version missing the agent file / the trigger** →
  `MaisterError("PRECONDITION")` at attach/launch (RD4 gates).
- **`workspace_ref` unresolvable (unknown branch, payload without
  `branch`/`ref`, non-run.* event, cron/manual trigger)** →
  `MaisterError("PRECONDITION")` at launch — no auto-fetch in v1.
- **Runner tier resolves to missing/disabled/not-ready runner, or an
  incompatibility rule fires** → `MaisterError("EXECUTOR_UNAVAILABLE")`
  before spawn; no run row.
- **Agent budget full** → run enters `Pending` with a per-kind queue
  position; the flow pool is unaffected (ADR-089).
- **Crash between claim and spawn** (cron claim committed or event run row
  inserted, process dies) → the run row is `Pending`;
  `promoteNextPending(kind='agent')` on the next `agent_tick.dispatcher`
  tick recovers it. A cron claim that died before the run INSERT is a lost
  fire (claim + insert share one transaction, so the window is the post-commit
  spawn only).
- **Human edits the parent checkout during a `repo_read` run** → possible
  false-positive quarantine (`MaisterError("PRECONDITION")` on later
  launches); accepted per ADR-090 — reason recorded, un-quarantine is one
  click, and the clean-baseline precondition keeps the window small.
- **Agent crash with L2 files materialized in the parent checkout** → the
  manifest makes the terminal-sweep restore idempotent; files are deny-rule
  content, never user data.
- **Webhook body over 32 KB or invalid JSON** → rejected at the boundary
  (413 for size, 422 for malformed JSON); no run row.
- **Launch attempt on an `unconfigured` (flowless) task** →
  `MaisterError("PRECONDITION")`; the run-schedules dispatcher records
  `skipped_unconfigured`; the board popover collects the missing fields.
- **Providing package removed from the cache** → `resync` disables the
  catalog rows (attachments and run history keep their FK anchor); there is
  no agent delete endpoint — definitions leave through their package.

## Linked artifacts

- **Decisions:** [ADR-089](../decisions.md#adr-089-platform-agent-catalog-with-per-agent-runner-and-a-five-source-trigger-model),
  [ADR-090](../decisions.md#adr-090-agent-workspace-axis-with-three-layer-read-only-enforcement-and-quarantine);
  boundary kept from ADR-041/ADR-043 (materialize-only).
- **Vision record:** [`../pv/agents-as-environment-actors.md`](../pv/agents-as-environment-actors.md)
  (Stage-0 brainstorm; superseded by ADR-089/090 with three amendments).
- **DB:** [`db/agents-domain.md`](../db/agents-domain.md),
  [`db/runs-domain.md`](../db/runs-domain.md),
  [`database-schema.md`](../database-schema.md) (migrations `0049`/`0050`).
- **Triggers:** [`scheduler.md`](scheduler.md) (`agent_tick.dispatcher`),
  [`domain-events.md`](domain-events.md) (`agent_triggers` consumer,
  `task.triage_requeued` emitter), [`run-schedules.md`](run-schedules.md)
  (`skipped_unconfigured`).
- **Tasks surface:** [`tasks.md`](tasks.md) (simple-intent creation, verdict
  columns, `unconfigured`, card pre-launch editing).
- **External surface:** [`external-operations.md`](external-operations.md)
  (triage + relations ops, agent tokens, MCP tools) and
  [`../api/external/operations.openapi.yaml`](../api/external/operations.openapi.yaml).
- **HTTP:** [`../api/web.openapi.yaml`](../api/web.openapi.yaml) (admin
  catalog list/read/toggle/un-quarantine/resync, launch, webhook event route,
  run DTO fields);
  [`../api/supervisor.openapi.yaml`](../api/supervisor.openapi.yaml)
  (`readOnlySession`).
- **Flow binding:** [`flow-graph.md`](flow-graph.md) +
  [`../flow-dsl.md`](../flow-dsl.md) (`agent:` node field, engine `1.5.0`).
- **Source (Implemented):** `web/lib/agents/*` (`definition.ts`, `registry.ts`,
  `launch.ts`, `dirty-watchdog.ts`, `triggers.ts`),
  `web/lib/scheduler/handlers/agent-tick.ts`,
  `web/lib/domain-events/consumers.ts` (`agent_triggers`),
  `supervisor/src/*` (`readOnlySession`).
