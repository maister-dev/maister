# Agents as environment actors — vision / concept

> **Status:** Vision / Phase 2 concept — **not scheduled**, no committed timeline.
> Captures a validated brainstorm (2026-06-03). Changes no ADR and supersedes
> nothing. Proposes future ADRs only when/if this is pulled into delivery.
> Lives outside `docs/plans/` on purpose: this is backlog/vision, not a near-term plan.

## Why this exists

Triggered by research into Anthropic's current agent offerings. Three distinct
things are easy to conflate; only one is new to us:

| Offering | What it is | Where the loop runs | Multi-vendor | We already use it? |
|---|---|---|---|---|
| **`ant` CLI** | Thin Go wrapper over the Anthropic API; also the client for Managed Agents | n/a | Anthropic API only | No |
| **Claude Agent SDK** | Library running the agent loop **in your process** | Your host (we wrap it via `claude-agent-acp`) | **Yes** (ACP seam: claude + codex + GLM/CCR) | **Yes** |
| **Managed Agents** (beta) | **Hosted** agent loop + sandbox + session store (`Agent`/`Environment`/`Session`/`Events`) | **Anthropic control plane** (even self-hosted sandbox runs only *tool execution* on your infra; tool I/O still flows to Anthropic) | **No — Anthropic-only orchestration** | No |

**Conclusion that shapes this concept:** the vendor-neutral seam for "adapters
to other ecosystems" is **ACP, which we already have** — not Managed Agents
(whose whole value is that the loop is Anthropic's, so codex/GLM can't sit
behind it). Managed Agents stays a **future Option C** runtime for
long-running asynchronous Anthropic-only flows, *not* the unifying layer and
*not* a quiet walk-back of ADR #5 (multi-executor). This concept therefore
builds on the existing ACP + capability-materialization (M14) foundation.

## The concept

An **Agent** is a first-class, `.md`-defined actor in the environment, sitting
beside `flows / tasks / executors`. It can interact with runs/workbenches **or**
just live in a project's context (monitor logs, admin servers, collect stats).

Definition = `.md` (frontmatter + body-prompt). Frontmatter is a superset of the
Claude-subagent format plus MAIster extensions:
`name, description, recommended_runner, capability_profile, risk_tier, mode, trigger`.

### Four orthogonal axes (nothing hard-wired to anything else)

- **scope** — `platform` (shared catalog `~/.maister/agents/<id>/`, like the flow
  cache) or `project` (`.maister/<slug>/agents/`). "Platform agent used inside a
  project when needed" = reference + on-demand materialization, same pattern as
  flow symlinks.
- **runner** — what executes it (CC harness today; codex/hosted are seams for
  later). Resolved **at launch** via the existing 5-level override chain
  (ADR #5). The agent carries only `recommended_runner` + capability
  requirements. **No FK to an executor.**
- **trigger** — `flow-step | cron | event | manual | continuous`.
- **mode / realization** — two mechanics for turning one `.md` into execution:
  - **agent-as-session** (MAIster-orchestrated): `.md` → config of a fresh ACP
    session (system prompt + tools + MCP + resolved executor). Used for
    standalone agents and for flow steps MAIster drives.
  - **agent-as-subagent** (Claude-orchestrated): `.md` → materialized into a
    run's worktree `.claude/agents/`, Claude self-delegates mid-run. Used for
    flow-bound "interact with the workbench" behavior.

### On executor independence (honest boundary)

Decoupling agent identity from executor is correct and cheap in the data model.
But "fully runner-independent" is partly aspirational: `.claude/agents/*.md` is a
*Claude Agent SDK* artifact — codex can't consume it. Runner coverage is gated by
**which materializers we write**. So: neutral MAIster definition + one CC
materializer now, leave seams for codex/hosted. The over-engineering trap is
writing all materializers up front — don't (YAGNI). This mirrors the existing
`BINARY_BY_AGENT` dispatch and flow-materialization patterns.

## Locked brainstorm decisions

1. **One `Agent` entity, both modes in the schema.** Delivery is **staged**
   (flow-bound → standalone), even though the model covers both from day one.
2. Agent **decoupled from executor**; executor resolved at launch via the ADR #5
   override chain; agent carries `recommended_runner` + capability needs.
3. Standalone lifecycle = **hybrid**: `triggered one-shot` (cron/event/manual) by
   default; `continuous` daemon as explicit per-agent opt-in.
4. Permissions = **M14 capability-profile + enforced materialization +
   HITL-escalation**; secrets **by reference**, injected server-side.
5. **Reuse `runs`** with a `kind: flow | agent` discriminator — do not fork the
   execution substrate.
6. **Scheduler logic in Next.js** (stateless tick-route), driven by an **external
   clock**; the supervisor stays the executor.

## Architecture

### Execution & lifecycle (scheduler)

Extend the existing GC/cron route into **one "scheduler tick" = one clock, three
sweeps**:

1. **Triggered one-shot** (`cron | event | manual`) — tick reads due schedules and
   **enqueues an agent-run through the same run-creation path as flows**
   (preconditions + concurrency budget → supervisor spawns **agent-as-session**).
   `event` = inbound webhook route (not cron). `manual` = UI button.
2. **Continuous reconcile** (opt-in daemons) — **not** state-transition polling
   (forbidden by ADR #1). Daemon liveness = **supervisor heartbeat** (already
   exists). The tick runs only the ADR #1-sanctioned *recovery sweep*: daemon
   with no live session but a valid checkpoint → respawn + `session/resume`; otherwise
   `Crashed` + "Recover/discard".
3. **GC** — current 7-day worktree/checkpoint logic, unchanged.

Placement rationale: domain state (`runs`, `tasks`, `agent_schedules`), Drizzle,
precondition logic, and the concurrency budget already live in the web tier; the
supervisor is effectively DB-free. Putting the scheduler in the supervisor would
force DB access and duplicate ADR #4/#7 logic. "Scheduler in Next.js" means a
**stateless tick-route** (claim → enqueue → spawn-request), *not* a resident
`setInterval` loop (which would violate "no long-running processes in Next.js"
and can't run reliably on serverless anyway). Clock source: **external cron**
preferred (reuses the current GC clock); **supervisor timer** as a fallback for
single-box deployments — logic stays in Next.js either way.

Guards:
- **ADR #1** — tick = clock + recovery sweep, never a state-transition poller; no
  `fs.watch`/`chokidar`. Live path stays ACP notifications.
- **Concurrency** — separate `MAISTER_MAX_CONCURRENT_AGENTS` budget; **do not**
  touch the flow cap=3 (ADR #4). Ops agents must not evict delivery runs.
- **Idempotency** — atomic claim (`UPDATE … WHERE next_run_at <= now()
  RETURNING`) so overlapping ticks can't double-spawn.
- **Workspace by mode** (light ADR #7 bifurcation) — monitoring/stats agents
  usually need **no git worktree** → lightweight workdir
  `.maister/<slug>/agents/<id>/runs/<run-id>/`; flow-bound agents reuse the
  worktree.

### Capabilities, secrets, HITL

- **`capability_profile`** in frontmatter: `allowed_tools`, `mcp_servers` (refs),
  `fs_paths`, `network`, `secret_refs`, `risk_tier`.
- **Materialization (M14):** on spawn, scoped `settings.local.json` + ACP
  `mcpServers` (reuse ADR-043). Runner-specific: CC → `.claude/agents/<name>.md`
  + `settings.local.json`; codex/hosted are later seams.
- **Enforced-flip dependency (ADR-041 currently blocked):** start in
  **materialize-only** (best-effort least-privilege). Read-only/monitoring agents
  ship immediately (materialize-only suffices for read scope). **Destructive /
  server-admin agents are gated on enforcement** — i.e. they wait for ADR-041 to
  unblock. The "enforce" choice does not depend on a phantom: dangerous actions
  simply don't turn on until enforcement is live.
- **Secrets by reference:** no secrets in `.md`; `secret_refs` resolved
  server-side and injected into the session env at spawn (like `executor.env`),
  never to the client and never in `session/update` (server-only-secrets ADR).
- **HITL escalation by `risk_tier`:** read-only tools auto-approved (pre-approve
  in `allowed_tools`); destructive tools (mutating Bash, network writes,
  write-MCP) → ACP `requestPermission` → HITL inbox (reuse deferreds).
- **Hard guard:** `continuous` + destructive + interactive HITL are
  **incompatible** (no human watching). A continuous daemon must be read-only
  **or** hold a narrow pre-authorized tool set, else it's refused at registration.

### Data & contracts

- **Reuse `runs`** + `kind: flow | agent`, nullable `agent_id`, `trigger_source`;
  `task_id`/worktree/promotion become optional by `kind`. One execution substrate
  → one SSE pipeline, one reconciliation, one concurrency accounting (agent
  budget counted by `kind=agent`).
- **New tables** (mirror the flow registry over plugins):
  - `agents` — index over the `.md` source: `id, scope, project_id?, slug,
    recommended_runner, capability_profile jsonb, risk_tier, mode, version`.
    Canonical source is the `.md`; frontmatter parsed into columns for
    validation/queries.
  - `agent_schedules` — `agent_id, trigger_type, cron_expr?, event_match?,
    next_run_at?, desired_state?, enabled`.
- **Flow-bound is nearly free:** the DSL already has `type: agent` steps. Bind
  one to the catalog via `agent: <id>` (instead of/over inline `prompt`); the
  flow engine already runs `agent` steps as ACP sessions. Only profile
  substitution is new.
- **API (Next.js Route Handlers):** `GET/POST /api/agents`,
  `GET/PATCH/DELETE /api/agents/[id]` (catalog CRUD — view-table + edit-popup per
  admin UI conventions; likely also via the M16 external API + tokens);
  `POST /api/agents/[id]/launch` (manual), `.../start|stop` (continuous),
  `.../schedule`; `POST /api/agents/tick` (clock target, auth'd);
  `POST /api/agents/[id]/event` (webhook ingress).
- **Reuse:** SSE (`run.events.jsonl` + `/api/runs/[id]/stream`); a
  `materializeAgent` step in run-prep; Mustache context + an `agent` namespace
  for traces.

### Failure modes & reconciliation

No new error codes — map onto `lib/errors.ts`:

- Invalid agent definition (bad frontmatter / unknown runner/MCP/secret ref) →
  `CONFIG`, refused **at registration**.
- Runner incompatible with agent (needs `.claude/agents` subagent feature but
  resolved to codex) → `EXECUTOR_UNAVAILABLE`, refused **at resolution, before
  spawn** — the partial-runner-independence boundary, surfaced explicitly.
- Unresolvable `secret_ref` → `CONFIG`, fail at spawn-prep; session never starts
  without the secret; secret never logged.
- Destructive agent while enforcement blocked (ADR-041) → `PRECONDITION`.
- Spawn / protocol → `SPAWN` / `ACP_PROTOCOL`. HITL timeout on an agent-run →
  `HITL_TIMEOUT` + the idle-checkpoint path (`NeedsInput → NeedsInputIdle →
  session/resume`); N/A for continuous (guard above).

Scheduler:
- Budget full → run goes `Pending` with queue position (ADR #4).
- Clock outage → next tick does **one catch-up fire**, not backfill (no
  thundering herd); `next_run_at` advances one period.

Continuous daemons (the one genuinely new guard):
- Crash → supervisor heartbeat + reconcile-sweep respawns + `session/resume` (valid
  checkpoint) or `CRASH` + "Recover/discard".
- **Crash-loop → exponential backoff; after N attempts → `Crashed` + stop.** No
  infinite respawn (protects tokens/slots).
- Reconcile (startup + tick), beyond current logic: `desired_state=running` with
  no live session → respawn/CRASH; `desired_state=stopped` with a live session →
  kill.

### Testing (existing conventions: vitest `.test.ts`, testcontainers, stub-supervisor, mock ACP adapter)

- **Unit:** frontmatter parser/validator; `capability_profile → settings.local.json`
  materializer; `next_run_at` + single catch-up; atomic claim; runner resolution
  (override chain + incompatibility detection); `risk_tier → HITL`.
- **Integration (testcontainers PG):** registration refusals (`CONFIG`); tick
  claim atomicity under concurrent calls (no double-spawn); `runs.kind` +
  separate agent budget; `schedule → run`.
- **E2E (playwright + seeded stub-supervisor):** flow `agent` step with
  `agent:<id>` → session; manual launch standalone → stream; continuous
  start/stop + crash → reconcile respawn via the mock ACP adapter (same one that
  exercises the resume round-trip); HITL escalation on a destructive tool (binary
  approve via stub).

## Staging

- **Mα — Catalog + flow-bound (agent-as-session):** tables, `.md` parser/validator,
  CRUD + UI, bind `agent:<id>` to the `agent` step, `materializeAgent` (CC,
  M14 **materialize-only**), runner resolution + incompatibility guard.
  Read-only/standard agents. **Ships without ADR-041.**
- **Mβ — agent-as-subagent + standalone triggered:** subagent inside runs;
  tick-route + external clock + manual/cron; `runs.kind=agent` + budget;
  lightweight workdir; webhook ingress.
- **Mγ — continuous + enforce:** continuous opt-in (heartbeat reconcile,
  crash-loop backoff); destructive/server-admin **gated on ADR-041 unblock**;
  secret-by-reference vault.

## Open risks

- **Wedge dilution** — standalone ops/monitoring agents drift toward an
  SRE-copilot, away from the current flow→PR wedge and success criteria. Staging
  (flow-bound first) is the mitigation; don't pull Mβ/Mγ forward before external
  validation.
- **ADR-041 dependency** — destructive/admin capability is blocked on the live
  enforcement spike. Read-only agents are designed to ship without it.
- **Partial runner independence** — the `.md` is a Claude-SDK artifact; non-CC
  coverage costs a materializer each. Accepted as a seam, not built up front.
- **Managed Agents as future Option C** — re-evaluate only as an additive,
  opt-in runtime for long-running async Anthropic-only flows; never as a
  replacement for the ACP multi-executor core while it's beta + Anthropic-locked
  and ineligible for ZDR/HIPAA.

## Relationship to existing docs

- Extends `PRODUCT_VIEW.md` Phase 2 — esp. item 7 (background project agents),
  item 4 (automation as product surface), item 3 (narrow tools / permissioned
  hands), item 1 (specialist checks).
- Builds on ADR #1 (ACP-driven, no polling), #4 (concurrency), #5 (multi-executor
  + override chain), #6 (plugin packaging / materialization), #7 (workspace
  lifecycle), and M14 capability materialization (ADR-043) + its blocked
  enforced-flip (ADR-041).
