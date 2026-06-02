# MAIster — Vision

## One-liner

**MAIster is the control plane for AI-powered software delivery.**

It turns backlog tasks into supervised delivery Flows and supports manual
scratch workspaces when the operator needs a direct coding-agent dialog:
package-managed processes, isolated workspaces, headless agent execution, HITL,
evidence gates, diff review, and branch-targeted promotion.

## Why

AI coding agents are useful, but managing several of them manually becomes operational noise: many terminals, lost context, unclear progress, scattered artifacts, weak review and repeated project-specific mistakes.

MAIster should remove the need to babysit coding-agent consoles. The human
should manage work at the level of projects, tasks, Flows, scratch workspaces,
reviews and decisions.

## Core product spine

```text
Project -> Flow package -> Task / Scratch run -> Run -> Workspace -> Headless Agents -> HITL -> Evidence Gates -> Review -> Promote
```

## Product principles

1. **Flow over prompt**
   Task-board delivery work should be launched through reusable Flows, not
   ad-hoc agent prompts. Scratch runs are the explicit manual workspace path:
   visible, auditable, outside the board unless linked to a task, and still
   backed by a run/workspace/supervisor contract.

2. **Flow packages as delivery products**
   Flows should be installed, trusted, versioned, upgraded, rolled back, and
   inspected as managed packages. A run must always know the exact Flow
   revision it used.

3. **Workspace as first-class object**
   A Flow launch or scratch launch creates an isolated workspace:
   branch/worktree/config/progress/cleanup/promotion.

4. **Web UI first**
   Review, intervention, dialogue and validation require a rich surface. Telegram is useful later for notifications and quick decisions.

5. **Human participates where Flow says**
   HITL is not global. Each Flow step defines whether human input is must/can/autonomous.

6. **Evidence over chat sludge**
   Specs, plans, diffs, tests, gate results, reviews and HITL responses must be
   stored as typed artifacts with current/stale readiness state.

7. **Start personal, not enterprise**
   Optimize for one owner and small teams first: low ops, fast iteration, single host. Enterprise governance later if needed.

## MVP goal

Prove the spine on **several real projects in parallel**:

1. Register multiple projects via per-project `maister.yaml` (each with its own
   list of Flows).
2. See active workspaces across projects in a project-grouped Portfolio/left-rail
   surface with status labels, launched-by display, and a per-project scratch
   `+` action.
3. For each project, manage a **task board** with two columns:
   `Backlog | In Flight`.
4. Create backlog tasks (title + prompt + Flow from project's `flows[]`).
5. Click **Launch** on a Backlog task → workspace auto-created via git
   worktree → Flow launched. Task moves to In Flight. Retry-friendly: a task
   may spawn many runs over its lifetime (1:N) — if a run fails or is
   abandoned, the task returns to Backlog with the Launch button re-enabled.
6. Start a scratch workspace outside the task board from a compact command box:
   write the prompt first, keep project/base branch/optional branch/name in the
   composer, and adjust executor profile, work mode, reasoning effort,
   optional issue/files, and run-scoped MCP/skill/rule/agent-pack profile
   through expandable controls.
7. Run Claude Code or Codex headlessly inside the worktree through ACP.
8. Show run progress, logs, dialog turns, and HITL in the Web UI through
   durable SSE.
9. Let the user answer permission and structured-form HITL requests.
10. Show diff and promote a ready run branch to the selected target branch.
11. Run up to 3 Flow sessions concurrently across projects; scratch v1 shares
    the same live-session cap and rejects when full rather than queueing.

## Current product target

The immediate product target is no longer just "launch a Flow and show logs".
It must make AI delivery controlled enough for daily work:

- Flow package lifecycle: install, trust, enable, upgrade, rollback, disable and
  keep active runs pinned to their original package revision.
- Flow graph maturity: typed node lifecycle, node settings, rework routes,
  manual takeover, and an append-only run ledger.
- Typed artifacts and evidence graph: every important output, decision, gate,
  returned commit set and stale/current state is inspectable in the UI.
- Scoped capability materialization: each AI session gets only the declared
  skills, MCP servers, tools, settings and restrictions for that session scope.
- Manual scratch intake: a scratch run is a conversation-like active workspace
  outside the task board unless explicitly linked to a task, with the same
  supervisor, worktree, HITL, capability snapshot, diff, promote, and discard
  accountability as Flow runs. Scratch `WaitingForUser` is shown as its own
  active workspace status even though the shared run lifecycle remains
  `Running`.
- Gate readiness: command checks, skill checks, AI judgments, external checks,
  required artifacts and human reviews all feed one readiness summary.
- External operations: API tokens and a thin MCP facade let CI/scripts/agents
  create tasks, launch runs, report gate evidence and read readiness without
  bypassing audit.
- Branch-targeted promotion: the operator selects base and target branches; no
  deploy or release management is implied.

## Phase 2: mature the harness

Phase 2 should not be "more integrations" first. After the current target can
run a controlled Flow end to end, Phase 2 should make the operating harness
dependable under daily parallel use.

The harness has six layers:

1. **Eyes**
   Agents need runtime and visual feedback, especially for Web UI work. Add
   preview URLs, port mapping, browser automation, screenshots, DOM inspection,
   user-flow traces and visible app/test service state as run evidence.

2. **Knowledge**
   Project context must be curated, short and fresh. Promote local references,
   dependency notes, project rules, Flow docs and accepted lessons as managed
   artifacts with review and staleness signals.

3. **Hands**
   Tools should be narrow and task-shaped. Build on scoped capability
   materialization with tool-count budgets, sandbox profiles and explicit
   permission policies for tools that touch files, terminals, network or
   secrets.

4. **Automation**
   Formatting, linting, status pings, review checks, slash commands, skills and
   recurring routines should be visible project automation. They should not be
   hidden local magic.

5. **Observability**
   The user should know what finished, what is blocked, what changed and what
   needs review without watching logs. Add run summaries, health signals,
   recovery events and notification routing.

6. **Economics**
   Tokens, context, browser/process memory and noisy commands are product
   constraints. Track cost per run, node, executor, gate and tool surface; warn
   first, enforce later.

Phase 2 should expand Flow templates, previews, knowledge, automation,
notifications, economics and intake only after the current package/graph/gate
foundation exists. Background agents and external board sync stay behind noise
controls: draft/publish, dedup, severity, cooldowns and human feedback.

## Not MVP

- autonomous task pulling;
- background project agents;
- A/B experiments;
- Telegram approvals;
- heavy analytics;
- platform-level cross-project skills;
- enterprise RBAC/compliance;
- Temporal-class durable orchestration;
- judge calibration lab;
- automatic project lesson promotion;
- full Kanban (Done as drag-target / WIP limits / swim-lanes);
- cross-project task moves;
- GitHub issue / Linear / YouGile sync.
