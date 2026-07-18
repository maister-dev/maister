# Product View

**MAIster is the self-hosted execution and governance layer for reproducible
AI-powered SDLC processes over private code.**

## Target User

MAIster serves a technical owner or small engineering team that runs several
software projects, keeps source private, and already uses coding agents. They
want one control plane for repeatable process packages, project state, Flow
launches, manual scratch workspaces, HITL, reviews, and promotions instead of
many terminals.

The current target includes credentials auth, admin-approved account
activation, global roles, project membership, action-level authorization,
assignments, comments, subscriptions, and a shared inbox. Enterprise identity
(OIDC/SSO/MFA), organization administration, strong workload isolation, and
large-organization rollout stay outside the current target.

## Product Model

This expands the canonical [product spine](VISION.md#core-product-spine) with
the runtime objects a single delivery passes through.

```text
Project -> Flow package -> Task / Experiment / Scratch run -> External operation -> Run -> Branch target -> Workspace -> Flow node / Dialog turn -> Capability profile -> Artifact graph -> Gate readiness -> Assignment -> HITL / Manual takeover -> Review -> Compare -> Promote
```

- **Project** — a registered repo with `maister.yaml` v2.
- **Flow package** — a managed plugin bundle with source, version label,
  resolved immutable revision, manifest digest, compatibility, trust, setup,
  enablement, upgrade, rollback, and deprecation state.
- **Flow** — the enabled package revision a project uses for a task. Engine
  `3.2.0` executes only graph manifests with typed `nodes[]`, lifecycle
  sections, named transitions, gates, bounded rework, and typed settings;
  legacy top-level `steps[]` manifests are refused.
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
  claude and codex are ready defaults; gemini, opencode, and mimo are
  code-owned adapter families whose launch readiness is diagnostics- and
  smoke-gated. Multiple profiles may share an adapter with different
  model/router/env settings.
- **Task** — backlog intent. One task may spawn many Flow runs.
- **Experiment** — task-bound comparison container that pins a base commit,
  launches several ordinary runs as variants/replicates, compares their diff,
  files, gates, and token rollups, and records a human rubric verdict.
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
- **Role** — global/project authorization and Flow ownership label such as
  owner, reviewer, maintainer, qa, or release-owner. Project actions are
  permission-gated; Flow roles and assignments additionally explain who owns
  the next human action.
- **Assignment** — claimable human work item for a permission, form, review,
  manual takeover, conflict resolution, or later external wait.
- **Workspace** — one git worktree per run.
- **HITL request** — permission, structured form, or human-review input.
- **Manual takeover** — human claim of an in-flight task, checkout of an
  editable branch, local rework, commit/push, and return to Flow execution.
- **Promotion** — applying a ready run branch to a target branch through local
  merge or pull request. Manual by default; lane-bounded diff classes
  (docs/tests/deps/config) may auto-promote through the same choke point when
  readiness is green ([ADR-126](decisions.md#adr-126-auto-promotion-lanes),
  Implemented). Deploy/release management is out of scope.

## Jobs To Be Done

| JTBD | User outcome |
| ---- | ------------ |
| See portfolio state | Know which projects have running, blocked, crashed, and review-ready work. |
| Manage delivery packages | Install, trust, enable, upgrade, rollback, disable, and inspect Flow packages without guessing which version a run used. |
| Launch a controlled run | Turn a backlog task into an isolated worktree and Flow execution. |
| Compare implementation variants | Run the same task several ways from one pinned base commit, inspect evidence side by side, and record a human rubric verdict without losing ordinary run history. |
| Start a scratch workspace | Open a conversation-like coding-agent session for exploratory work without creating a task board card. |
| Pick the right branch | Choose the base branch and target branch so work can happen on `main`, `develop`, release branches, or any engineer-selected branch. |
| Constrain node capabilities | See and edit what each AI or human node is allowed to use: agents, MCP servers, tools, skills, roles, restrictions, and rework paths. |
| Reach agreement on risky plans | Run several read-only draft agents through an engine-owned consensus node, see why they agree or disagree, and resolve unresolved disagreements through HITL. |
| Trust what an AI session can touch | Know which skills, MCPs, tools, settings, env profiles, and restrictions were materialized, enforced, instructed, refused, and cleaned up for a node or long-living session. |
| Inspect readiness evidence | See which artifacts prove the run is ready, which are stale, and which node or human decision produced them. |
| Understand why work is blocked | See which Flow-distributed gate failed, went stale, is waiting, or was overridden before review/promotion. |
| Let CI and agents update MAIster safely | Create tasks, launch runs, report gate results, attach artifacts, and read readiness through scoped API tokens or the thin MCP facade. |
| See who owns the next action | Know which role or person owns a waiting task, how long it has waited, and what action will unblock it. |
| Answer only needed questions | See all pending HITL requests in the UI and respond through the web tier. |
| Steer rework without losing control | Reject through a Flow-declared decision, add instructions, choose keep/rewind/fresh workspace policy, and force stale gates to rerun. |
| Take over work locally | Claim a task, checkout its branch, edit/test/commit on the developer machine, return it through MAIster, and continue with full audit. |
| Review the result | Inspect logs, artifacts, diff, and status before promotion. |
| Ship low-risk changes hands-free | Let readiness-green, lane-bounded diffs (docs/tests/deps/config) promote automatically through the same choke point, and hold or opt any run out. |
| Retry without recreating work | Send a failed or abandoned task back to Backlog and launch attempt N+1. |

## Current Scope

- Multi-project registry using `maister.yaml` v2.
- Project-scoped executors and Flow plugin installs.
- Flow package lifecycle is implemented: package revisions are visible,
  immutable, trust-reviewed, engine-compatible, enabled per project, safely
  upgradeable/rollbackable, and preserved for in-flight runs. Current
  validation qualifies the processes shipped by core packages across
  internal/private projects.
- Portfolio home and left rail with project-grouped active workspaces, HITL
  count, status labels, launched-by display, and a per-project scratch `+`.
- Per-project board with `Backlog | In Flight`.
- Task creation with Flow and optional executor override.
- `POST /api/runs` launch path with scheduler, worktree creation, and
  background Flow runner.
- Scratch run intake is a compact manual workspace surface outside the task
  board: a prompt-first command box for project, base branch, optional scratch
  branch/name, and launch, with executor profile, work mode, reasoning effort,
  optional issue/files, and run-scoped platform/project/Flow-package
  MCP/skill/rule/agent-pack profile tucked into expandable controls; show it in
  project-grouped active workspace lists and open it as a coding-agent dialog.
- ACP supervisor process with code-owned Claude, Codex, Gemini CLI, and
  OpenCode/MiMo adapter families; Gemini/OpenCode/MiMo stay gated by diagnostics and
  smoke-proven readiness before production launch.
- Durable run SSE via `run.events.jsonl`.
- HITL response route with row-level claim, atomic artifacts, permission
  delivery, and runner-owned resume.
- The graph-only engine implements node lifecycle, typed settings,
  review-driven rework, manual takeover, the append-only run ledger,
  stale-gate reruns, orchestrator delegation, and the first-class M41 consensus
  node for unanimous read-only plan verification.
- Typed Flow artifacts and an evidence graph are required for review: payloads
  stay in the run directory/worktree/git, while MAIster stores queryable
  artifact metadata, validity, and dependency edges.
- Role-owned assignments show role, assignee/unclaimed state, elapsed time,
  action kind, branch/ref, and stale-evidence summary. Global/project RBAC
  blocks unauthorized actions; assignment roles additionally explain ownership
  and audit.
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
- Experiment Comparison Studio (ADR-124) is required for Phase 1 benchmarking:
  a project member can create a task-bound experiment, pin the base commit at
  creation, launch variants through the normal run pipeline, compare diff/files/
  gates/tokens, ask an advisory judge, and record a human verdict. It adds no
  new execution runtime, no new SSE/domain event family, and no auto-approval or
  auto-promotion.

## Phase 2

> **Sequencing:** [`.ai-factory/ROADMAP.md`](../.ai-factory/ROADMAP.md) owns the
> current milestone order. [`pv/improvement-roadmap.md`](pv/improvement-roadmap.md)
> is retained as the historical backlog/wave rationale from before dogfood.

Phase 2 matures the operating harness after the current package/graph/gate
foundation. It lets one owner or a small team run more parallel agent work
without babysitting terminals, leaking secrets, drowning in logs, or paying for
tool noise.

The knowledge, automation, observability, economics, experiments, consensus,
and guardrail foundations below now exist. The open productization gaps are
core-process qualification, end-to-end preflight/Run Doctor, visual evidence,
strong workload isolation, attention routing, and enterprise identity.

1. **Visual validation layer**
   - Workspace preview URLs and port mapping.
   - Browser-backed checks as Flow nodes or gates.
   - Screenshots, DOM snapshots, console/network traces, and user-flow traces
     attached to the artifact graph.
   - Clear boundary: agents can detect broken states; humans still judge taste,
     product fit, and acceptance.

2. **Curated project knowledge**
   - Build on Project Brain managed sources, owned lessons, proposals, and
     recall for dependency APIs, architecture decisions, project conventions,
     and Flow docs.
   - Proposed lesson -> accepted rule workflow with a source trace to the run,
     review, incident, bug, or manual decision that produced it.
   - Rule freshness and cleanup so project memory does not become stale noise.

3. **Narrow tools and permissioned hands**
   - Build on scoped capability materialization, execution budgets, MCP trust,
     and ACP-seam guardrails.
   - Preference for small task-shaped MCP servers, scripts, checks, and skills
     over broad bundles.
   - Add strong sandbox/isolation and egress/secret profiles for tools that
     touch files, terminals, network, secrets, browsers, or external systems.

4. **Automation as product surface**
   - Build on implemented hooks, skills, packages, platform agents, schedules,
     domain events, and webhook routines visible in the control plane.
   - Standard automation for formatting, linting, review checks, status pings,
     dependency watches, and rule freshness checks.
   - Lightweight specialist checks for search, routine QA, architecture review,
     and docs review without polluting the main run context.

5. **Observability and attention routing**
   - Turn existing Observatory/run evidence into one summary that answers: what
     changed, what passed, what failed, what is stale, and what needs a human.
   - Recovery events, checkpoint/resume history, gate rerun history, and
     package/capability profile changes visible in the run ledger.
   - Web UI notifications first; Telegram or other channels later.
   - Project/team inbox expansion after assignment semantics are proven.

6. **Cost and resource economics**
   - Build on token/cost rollups and execution budgets by run, node, runner,
     gate, and tool surface.
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
   - Writable competing-code consensus drafts only after the implemented
     read-only M41 consensus proves demand in qualified core processes.
   - Deeper Gemini/OpenCode/MiMo ACP proof for permissions, MCP, model switching,
     and resume semantics beyond the first adapter-family support.
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
- OIDC/SSO/MFA, session revocation, escalation calendars, external board sync,
  notification channels, and organization/team administration.
- Public marketplace, remote reputation/rating, automated malicious-code
  scanning, signed packages, automatic update rollout, package dependency
  solving, container sandboxing, organization-wide capability policies, and
  cross-project capability promotion workflows.
- Complex gate policy language, org-wide gate templates, deploy-environment
  gates, flaky-test intelligence, judge calibration lab, provider-specific CI
  apps, and CI ingestion beyond the generic external gate report contract.
- OAuth apps, user impersonation, provider-specific GitHub/GitLab/Jenkins apps,
  external board sync, and public-internet webhook hardening beyond the
  implemented generic token/HMAC outbound-webhook contract.
- Deploy management, release trains, rollback automation, semantic version
  inference, approval chains, and production environment control.

## Success Criteria

The current target succeeds when representative processes from core packages
complete repeated runs on several internal/private projects with pinned
package/engine/runner provenance and expected artifacts/gates. Before launch,
preflight must identify missing runner credentials, package incompatibility,
MCP/env requirements, repository/worktree problems, and unavailable commands
with an actionable remediation. Every run must classify platform, package,
environment, model/runner, project-specific, and human-decision failures.

Pilot telemetry must measure time-to-first-success, review reach,
human-attention time, rework/retry pressure, promotion outcome, cost per
accepted change, and second/third-run retention. It must not retain private
source, prompts, diffs, secrets, or artifact bodies.

## Typed Plan review (Implemented — ADR-137)

Plan approval is an explicit trust boundary: it displays immutable plan evidence
and assumption defaults, refuses approval while any declared blocker is open,
and turns the last selected option into a Flow-declared rework. This keeps a
human in control without asking them to translate prose into machine state or
creating a separate Inbox product. External tokens have no decision authority.
