# Product View

## Target User

MAIster serves a solo technical owner who runs several software projects and
already uses coding agents. The user wants one control plane for project state,
Flow launches, manual scratch workspaces, HITL, reviews, and promotions instead
of many terminals.

The current target includes credentials auth, admin-approved account
activation, global roles, and project membership checks. Phase 2 can add
small-team collaboration workflows. Enterprise governance and large
organization rollout stay outside the current target.

## Product Model

```text
Project -> Flow package -> Task / Scratch run -> External operation -> Run -> Branch target -> Workspace -> Flow node / Dialog turn -> Capability profile -> Artifact graph -> Gate readiness -> Assignment -> HITL / Manual takeover -> Review -> Promote
```

- **Project** — a registered repo with `maister.yaml` v2.
- **Flow package** — a managed plugin bundle with source, version label,
  resolved immutable revision, manifest digest, compatibility, trust, setup,
  enablement, upgrade, rollback, and deprecation state.
- **Flow** — the enabled package revision a project uses for a task. It ships
  `flow.yaml` v1 steps today; planned graph Flows model typed nodes with
  lifecycle sections and transitions.
- **Flow node** — one executable unit such as AI coding, CLI, check, judge,
  human review, human edit, or merge.
- **Node settings** — typed per-node capability and policy controls: allowed
  executors, MCP servers, tools, skills, restrictions, roles, decisions, and
  rework routes.
- **Capability profile** — resolved set of MCP servers, skills, tools, agent
  settings, environment profiles, and restrictions that the runner materializes
  for one AI session scope. A one-node session can have a one-node profile; a
  long-living session uses one profile for every AI node inside it.
- **Executor** — configured ACP runner profile `{agent, model, env?, router?}`;
  claude and codex adapters are current, and multiple profiles may share the
  same adapter with different model/router/env settings.
- **Task** — backlog intent. One task may spawn many Flow runs.
- **Scratch run** — manual coding-agent workspace started from a project,
  base branch, optional scratch branch/name, executor profile, work mode,
  reasoning effort, prompt, optional issue/files, and capability profile. It is
  an active workspace outside the task board unless explicitly linked to a task.
- **External operation** — audited project-scoped API or MCP action, such as
  creating a task, launching a run, attaching artifact metadata, reporting an
  external gate, or reading readiness.
- **API token** — project-scoped service credential managed in the UI. Tokens
  are stored hashed, shown once, scoped by permissions, and attributed in audit.
- **MCP facade** — thin agent-facing tools over the same operations API. MCP
  improves agent ergonomics but does not bypass token scopes, audit, readiness,
  or run ledger rules.
- **Run** — one execution attempt or manual scratch session with status,
  workspace, step/dialog records, and HITL rows.
- **Branch target** — selected base branch, MAIster run branch, and target
  branch for PR/local merge promotion. Target defaults to base.
- **Node attempt** — immutable record of one node execution, its inputs,
  outputs, checkpoints, gate results, and rerun/staleness status.
- **Artifact** — typed Flow input/output evidence such as a diff, log, test
  report, AI judgment, human note, commit set, checkpoint, or preview.
- **Artifact graph** — run-detail explorer that connects task inputs, node
  attempts, artifacts, gates, human decisions, returned commits, and
  current/stale readiness state.
- **Gate** — Flow-declared decision over evidence, such as command check,
  internal skill/command check, AI judgment, external CI/system check, required
  artifact, or human review.
- **Readiness** — summarized gate state: ready, blocked, stale, failed,
  waiting, or overridden.
- **Role** — project/Flow routing label such as owner, reviewer, maintainer,
  qa, or release-owner. Roles are visible ownership signals before they are
  permission boundaries; any project teammate can act for now.
- **Assignment** — claimable human work item for a permission, form, review,
  manual takeover, conflict resolution, or later external wait.
- **Workspace** — one git worktree per run.
- **HITL request** — permission, structured form, or human-review input.
- **Manual takeover** — human claim of an in-flight task, checkout of an
  editable branch, local rework, commit/push, and return to Flow execution.
- **Promotion** — manual final action that applies a ready run branch to a
  target branch through local merge or pull request. Deploy/release management
  is out of scope.

## Jobs To Be Done

| JTBD | User outcome |
| ---- | ------------ |
| See portfolio state | Know which projects have running, blocked, crashed, and review-ready work. |
| Manage delivery packages | Install, trust, enable, upgrade, rollback, disable, and inspect Flow packages without guessing which version a run used. |
| Launch a controlled run | Turn a backlog task into an isolated worktree and Flow execution. |
| Start a scratch workspace | Open a conversation-like coding-agent session for exploratory work without creating a task board card. |
| Pick the right branch | Choose the base branch and target branch so work can happen on `main`, `develop`, release branches, or any engineer-selected branch. |
| Constrain node capabilities | See and edit what each AI or human node is allowed to use: agents, MCP servers, tools, skills, roles, restrictions, and rework paths. |
| Trust what an AI session can touch | Know which skills, MCPs, tools, settings, env profiles, and restrictions were materialized, enforced, instructed, refused, and cleaned up for a node or long-living session. |
| Inspect readiness evidence | See which artifacts prove the run is ready, which are stale, and which node or human decision produced them. |
| Understand why work is blocked | See which Flow-distributed gate failed, went stale, is waiting, or was overridden before review/promotion. |
| Let CI and agents update MAIster safely | Create tasks, launch runs, report gate results, attach artifacts, and read readiness through scoped API tokens or the thin MCP facade. |
| See who owns the next action | Know which role or person owns a waiting task, how long it has waited, and what action will unblock it. |
| Answer only needed questions | See all pending HITL requests in the UI and respond through the web tier. |
| Steer rework without losing control | Reject through a Flow-declared decision, add instructions, choose keep/rewind/fresh workspace policy, and force stale gates to rerun. |
| Take over work locally | Claim a task, checkout its branch, edit/test/commit on the developer machine, return it through MAIster, and continue with full audit. |
| Review the result | Inspect logs, artifacts, diff, and status before promotion. |
| Retry without recreating work | Send a failed or abandoned task back to Backlog and launch attempt N+1. |

## Current Scope

- Multi-project registry using `maister.yaml` v2.
- Project-scoped executors and Flow plugin installs.
- Flow package lifecycle is required before richer graph distribution: package
  revisions must be visible, immutable, trust-reviewed, compatible with the
  MAIster engine, enabled per project, safely upgradeable/rollbackable, and
  preserved for in-flight runs.
- Portfolio home and left rail with project-grouped active workspaces, HITL
  count, status labels, launched-by display, and a per-project scratch `+`.
- Per-project board with `Backlog | In Flight`.
- Task creation with Flow and optional executor override.
- `POST /api/runs` launch path with scheduler, worktree creation, and
  background Flow runner.
- Scratch run intake is a compact manual workspace surface outside the task
  board: choose project, base branch, optional scratch branch/name, executor
  profile, work mode, reasoning effort, optional issue/files, and run-scoped
  platform/project/Flow-package MCP/skill/rule/agent-pack profile; show it in
  project-grouped active workspace lists and open it as a coding-agent dialog.
- ACP supervisor process with claude/codex adapter binaries.
- Durable run SSE via `run.events.jsonl`.
- HITL response route with row-level claim, atomic artifacts, permission
  delivery, and runner-owned resume.
- Flow graph maturity is the next required product foundation before richer
  HITL: node lifecycle, typed settings, review-driven rework, manual takeover,
  run ledger, and stale-gate reruns.
- Typed Flow artifacts and an evidence graph are required for review: payloads
  stay in the run directory/worktree/git, while MAIster stores queryable
  artifact metadata, validity, and dependency edges.
- Role-owned assignments are required for the board and inbox: human work must
  show role, assignee/unclaimed state, elapsed time, action kind, branch/ref,
  and stale-evidence summary. Roles never block actions in the current target;
  they explain ownership and audit, not authorization.
- Scoped capability materialization is required for AI-node safety: node/session
  settings reference named MCPs, tools, skills, agent settings, env profiles,
  and restrictions; the runner materializes only those capabilities for the
  one-node session or long-living session, snapshots what was
  enforced/instructed/unsupported/refused, then removes or restores them after
  the scope ends.
- Flow-distributed gates are required for readiness: checks, internal
  skill/command gates, AI judgments, external checks, artifact requirements,
  and human reviews produce typed gate results over artifacts. Review/promotion
  refuse when required blocking gates are missing, failed, stale, skipped, or
  still running.
- External operations are required for CI and agent interoperability:
  project-scoped API tokens let scripts and CI create tasks, launch runs, read
  readiness, attach artifact metadata, and report Flow-declared
  `external_check` gates. A thin MCP facade exposes the same operations to
  running agents without becoming a separate orchestration path.
- Branch-targeted promotion is required: runs start from a selected base branch,
  work on a MAIster run branch, and promote to a selected target branch by PR or
  local merge after readiness passes. Deploy/release management stays manual and
  outside MAIster.

## Phase 2

Phase 2 matures the operating harness after the current package/graph/gate
foundation exists. The goal is not "more integrations" first. The goal is to
let one owner or a small team run more parallel agent work without babysitting
terminals, leaking secrets, drowning in logs, or paying for tool noise.

1. **Visual validation layer**
   - Workspace preview URLs and port mapping.
   - Browser-backed checks as Flow nodes or gates.
   - Screenshots, DOM snapshots, console/network traces, and user-flow traces
     attached to the artifact graph.
   - Clear boundary: agents can detect broken states; humans still judge taste,
     product fit, and acceptance.

2. **Curated project knowledge**
   - Managed local references for dependency APIs, architecture decisions,
     project conventions, and Flow docs.
   - Proposed lesson -> accepted rule workflow with a source trace to the run,
     review, incident, bug, or manual decision that produced it.
   - Rule freshness and cleanup so project memory does not become stale noise.

3. **Narrow tools and permissioned hands**
   - Tool-count budgets and capability labels on top of scoped capability
     materialization.
   - Preference for small task-shaped MCP servers, scripts, checks, and skills
     over broad bundles.
   - Sandbox profiles for tools that touch files, terminals, network, secrets,
     browsers, or external systems.
   - Warn-first policy for risky operations before any stricter enforcement.

4. **Automation as product surface**
   - Reusable hooks, skills, slash commands, Flow snippets, and recurring
     routines visible in Project Settings.
   - Standard automation for formatting, linting, review checks, status pings,
     dependency watches, and rule freshness checks.
   - Lightweight specialist checks for search, routine QA, architecture review,
     and docs review without polluting the main run context.

5. **Observability and attention routing**
   - Run summaries that answer: what changed, what passed, what failed, what
     is stale, and what needs a human.
   - Recovery events, checkpoint/resume history, gate rerun history, and
     package/capability profile changes visible in the run ledger.
   - Web UI notifications first; Telegram or other channels later.
   - Project/team inbox expansion after assignment semantics are proven.

6. **Cost and resource economics**
   - Token and context cost by run, node, executor, gate, and tool surface.
   - Noisy-command compaction for tests, git output, linters, builds, and logs.
   - Cache-resume cost tracking for checkpointed sessions.
   - Browser/process memory visibility for parallel runs on small hosts.
   - Budget thresholds that warn first and enforce only when the product signal
     is clear.

7. **Flow and intake expansion**
   - More Flow templates: bugfix, feature, review, requirements clarification,
     system analysis, incident/log analysis, docs update, dependency update,
     and release-note preparation.
   - Flow designer UI on top of the graph/runtime foundation, without turning
     MAIster into a generic workflow builder.
   - Additional ACP executors after the claude/codex contract proves stable.
   - CI/log intake, external board sync, and background project agents only
     after draft/publish, dedup, severity, cooldown, and human-feedback controls
     exist.

Phase 2 succeeds when a real project can run several concurrent agent tasks
with visual checks, curated references, narrow tools, useful summaries,
visible resource cost, and at least one accepted project lesson, while the user
spends attention on decisions rather than terminal babysitting.

## Deferred For Now

- Content-addressed artifact blob store.
- Artifact marketplace or reusable artifact catalog.
- Benchmark dataset management.
- Rich preview hosting or sandboxing.
- Cross-run artifact reuse.
- Full payload-schema validation for every artifact kind.
- RBAC, permission-bound project membership, role-based action blocking,
  escalation calendars, external board sync, notifications, and
  organization/team administration.
- Public marketplace, remote reputation/rating, automated malicious-code
  scanning, signed packages, automatic update rollout, package dependency
  solving, container sandboxing, organization-wide capability policies, and
  cross-project capability promotion workflows.
- Complex gate policy language, org-wide gate templates, deploy-environment
  gates, flaky-test intelligence, judge calibration lab, provider-specific CI
  apps, and CI ingestion beyond the generic external gate report contract.
- OAuth apps, user impersonation, generic outbound webhooks, provider-specific
  GitHub/GitLab/Jenkins apps, external board sync, and public-internet webhook
  hardening beyond token/HMAC.
- Deploy management, release trains, rollback automation, semantic version
  inference, approval chains, and production environment control.

## Success Criteria

The current target succeeds when MAIster can register at least two real
projects, install their Flows, launch queued runs through claude or codex,
stream durable events, manage at least one Flow package upgrade and rollback
without mutating an in-flight run, handle at least one permission HITL and one
structured form HITL, recover cleanly from ordinary failures, complete one
review-driven rework loop with stale checks/judges/user-review rerun, accept
one manual takeover return with visible diff and audit trail, inspect the
artifact graph that explains current vs stale readiness evidence, see every
human-owned pause as an assignment with owner/elapsed/action context, inspect
the resolved capability profile used by AI nodes, see a readiness summary that
explains every blocking/stale/overridden gate, create at least one backlog task
and report at least one external check through token-authenticated operations,
use the thin MCP facade for the same task/readiness surface from an agent, and
promote a clean run branch to the selected target branch. It should also start
at least one scratch workspace outside the task board, show it in the active
workspace list, preserve its dialog/capability snapshot, and discard or promote
its branch through the same workspace review path.
