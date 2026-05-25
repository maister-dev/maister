# Agentic Delivery Platform — Product View Synthesis

> Date: 2026-05-22  
> Source: RUBRIC.md + independent Opus/GPT-5.5 product review  
> Scope: personal/internal platform, not bank enterprise.

## 1. Product framing

This is not “another coding agent” and not “a Web UI over Claude Code”.

The product is a **portfolio OS / delivery control plane for AI-assisted software work**.

Core product spine:

```text
Backlog → Flow → Workspace → Headless Agents → HITL → AI-Judge → Diff Review → Merge → Lessons
```

The user should not supervise many coding-agent consoles manually. The platform should move execution into server-side autonomous Flows, while keeping human validation and intervention visible through Web UI.

## 2. Lean Canvas

### 2.1 Customer segments

#### Primary / MVP

**Tech lead / solo-architect / owner** who:

- runs several projects/repos in parallel;
- already uses Claude Code / Aider / opencode / OpenHands-like tools;
- currently manages agents manually through terminals;
- wants portfolio-level control, not one-off coding sessions.

This maps directly to the current personal/internal use case.

#### Secondary / Phase 2

**Small internal team, 2–5 people**:

- team members receive tasks/review requests via board/Web UI;
- human responsibilities are defined by Flows;
- agents and people share the same backlog and artifacts.

#### Later / not now

- AI-first product studio / agency;
- larger enterprise teams;
- bank-grade regulated environments.

Explicitly out of MVP scope: bank enterprise governance, SOX-style audit, heavy RBAC, large org rollout.

## 3. Problems

1. **Manual supervision overload**
    - Many coding-agent consoles become a babysitting problem.
    - Human has to remember what each agent is doing and what it needs.

2. **Backlog is disconnected from execution**
    - Task board, agent session, workspace, diff and PR are separate places.
    - Launching work requires copy-paste and manual context transfer.

3. **Workspace setup is friction**
    - Branch/worktree/config/env/ports are recreated manually.
    - Cleanup and merge are also manual.

4. **HITL is not process-native**
    - Agents ask questions in logs/chats.
    - Humans do not have a clear queue of “where I am needed”.
    - Analytical/specification work needs dialogue, not just approve/reject buttons.

5. **Review/acceptance is weak**
    - Agent output is hard to trust.
    - Human must inspect diff, tests, requirement fit and risks manually.
    - AI-Judge output must be part of Flow artifacts, not another chat.

6. **Project learning is not systematic**
    - Bugs/incidents/reviews do not reliably become project rules.
    - Agents repeat the same mistakes.

7. **No portfolio visibility**
    - No single view of active projects, workspaces, blocked runs, pending human inputs and ready-to-review results.

## 4. Value proposition

> Manage a portfolio of software projects and AI agents from one Web UI: collect tasks in a backlog, launch them through reusable Flows into isolated workspaces, let headless agents execute, and review/merge results through visible HITL, AI-Judge and diff artifacts.

Short version:

> One board, many projects, Flow-driven agents, human control only where the Flow asks for it.

## 5. Alternatives today

Current alternative stack:

- Claude Code / Cursor / Aider / opencode / OpenHands;
- GitHub/GitLab issues;
- YouGile/Jira/Linear;
- GitHub Actions / GitLab CI;
- tmux/terminals;
- Obsidian/Markdown memory;
- Telegram/Slack approvals;
- custom scripts.

Problem: these tools solve pieces, but do not provide one product model:

```text
Task → Flow → Workspace → Run → Artifacts → Review → Merge → Lessons
```

## 6. Key capabilities

1. **Portfolio control**
    - Projects, active workspaces, runs, blocked states, pending human inputs.

2. **Common backlog**
    - Human/agent/CI/log-created tasks.
    - Target Flow, priority, assignee/team inbox, child tasks.

3. **Flow-based execution**
    - Flow as product object: stages, agents, humans, tools, gates, artifacts, merge policy.

4. **Workspace lifecycle**
    - Superset.sh-style creation: repo/base branch/worktree/config/progress/cancel/cleanup/merge.

5. **Headless agent harness**
    - Spawn, monitor, cancel, retry, route to executors, collect artifacts.

6. **HITL dialogue and approvals**
    - Human questions and intervention are part of Flow, especially for requirements/system-analysis work.

7. **Review and acceptance**
    - Diff viewer, AI-Judge, tests/CI signals, human approve/request changes, merge policy.

8. **Project learning/evolution**
    - Bugs and reviews produce causes/lessons.
    - Lessons update project rules/playbooks.

9. **Background project agents**
    - Reviewer, log analyst, dependency watcher, backlog groomer, doc keeper.

## 7. Unfair advantage / differentiation

The differentiator is the **delivery control plane** angle:

- not an IDE;
- not a coding CLI;
- not a generic agent workflow builder;
- not a task tracker;
- not just AI code review.

The unique combination is:

```text
Backlog + Flow + Workspace + Agent Harness + HITL + AI-Judge + Diff Review + Lessons
```

The first product should optimize for personal/internal speed and low ops, not enterprise completeness.

## 8. Product risks and assumptions

### Assumptions

1. The main pain is not model coding quality itself, but operational management of agentic delivery.
2. Flow-centric execution can cover most real coding/project scenarios without becoming too heavy.
3. Web UI provides better control than CLI/Telegram-first interaction.
4. AI-Judge improves trust and reduces review burden rather than creating noise.
5. Workspace lifecycle is a product anchor, not a minor engineering detail.
6. Project-level memory/evolution will reduce repeated agent mistakes.

### Risks

1. **Over-modeling**
    - Too many concepts: Project, Task, Flow, Workspace, Run, Agent, Gate, Artifact, Judge, Skill.
    - Risk: product becomes heavy before useful.

2. **Flow configuration tax**
    - If configuring a Flow is harder than launching Claude Code manually, MVP loses.

3. **Weak first-run experience**
    - User must connect repo and run first useful task in ~10–15 minutes.

4. **Trust gap**
    - AI-Judge and artifacts may still not make results trustworthy enough for merge.

5. **UI wrapper trap**
    - Without a real headless harness, product becomes a pretty wrapper around one CLI.

6. **Noise from background agents**
    - Log analysts/backlog groomers can spam low-value tickets.

7. **Project memory bloat**
    - Lessons/rules may accumulate noise if not curated.

## 9. JTBD

### JTBD-1. See portfolio state

When I manage multiple projects, I want one dashboard showing active work, blocked runs, ready reviews and pending decisions, so I can know where my attention is needed without opening many terminals/tools.

### JTBD-2. Launch a task into a controlled delivery process

When a backlog item appears, I want to choose/run a target Flow that creates a workspace and orchestrates agents, humans, tools and gates, so the task moves through a repeatable process instead of ad-hoc prompting.

### JTBD-3. Delegate coding work without babysitting

When I assign work to an agent, I want it to run headlessly in an isolated workspace with visible progress, artifacts and cancellation, so I can run multiple tasks in parallel safely.

### JTBD-4. Participate in requirements/system-analysis dialogue

When a task is ambiguous, I want the Flow to let the agent ask questions and let me answer in Web UI, so requirements and system analysis are clarified without losing context.

### JTBD-5. Review and accept results quickly

When agent work finishes, I want a clean diff, tests/CI status and AI-Judge review artifact, so I can approve, request changes or merge without full manual reconstruction.

### JTBD-6. Let projects learn from failures

When a bug/review/incident reveals a repeated issue, I want the project rules/playbooks to evolve, so future agents avoid the same mistake.

### JTBD-7. Run background project watchers

When a project is active, I want reviewer/log/dependency/doc agents to monitor signals and create useful tasks, so issues surface without manual checking.

### JTBD-8. Compare agent/flow approaches

When a task is important or uncertain, I want to run two approaches in parallel and compare outputs, so I can pick the better result.

### JTBD-9. Involve team members only where needed

When a Flow needs human input, I want it to create a specific review/input item for a person, role or team inbox, so people are not forced to monitor all agent activity.

## 10. Product gaps in current requirements

### Gap 1. First-run / onboarding experience

Missing explicit requirement: after installation, user should connect a repo and run the first useful Flow quickly.

Needed:

- connect repo;
- detect stack/project profile;
- propose default Flows;
- create initial project rules/config;
- run first simple task.

### Gap 2. Flow template library

Flows are central, but users should not create them from scratch.

Need built-in templates:

- bugfix;
- feature;
- review;
- requirements clarification;
- system analysis;
- incident/log analysis;
- docs update;
- dependency update.

### Gap 3. Task intake sources

Backlog exists, but input channels are not fully productized.

Need to define sources:

- manual task;
- generated by Flow;
- generated by background agent;
- CI/log/Sentry signal;
- imported from external board/GitHub issue.

### Gap 4. Human input queue

HITL exists, but product should have a first-class “needs my attention” inbox.

Needs:

- questions;
- approvals;
- review requests;
- blocked decisions;
- merge decisions;
- assignment to person/role/team inbox.

### Gap 5. Acceptance model

AI-Judge and diff exist, but “accepted result” should be product-defined.

Need:

- done criteria per Flow;
- manual approve/request changes;
- AI-Judge verdict;
- tests/CI status;
- merge policy;
- override reason.

### Gap 6. Noise control for autonomous agents

Background agents and later auto-triage can create trash.

Need:

- draft vs published tasks;
- dedup/grouping;
- confidence/severity;
- rate limits/cooldowns;
- human feedback useful/not useful.

### Gap 7. Project memory governance

Project evolution is right, but needs product controls.

Need:

- proposed lesson vs accepted rule;
- who approves project rule updates;
- rule expiry/deprecation;
- trace lesson back to bug/review/incident.

### Gap 8. Workspace preview / validation experience

Workspace infra is listed as TBD, but product value depends on validation.

Need:

- preview URL/port mapping;
- show app/test service state;
- run/check commands visible in UI;
- cleanup.

### Gap 9. Minimal success definition

Analytics can wait, but MVP needs a simple success bar.

Suggested MVP success:

- connect one real repo;
- launch one backlog task through Flow;
- create workspace automatically;
- run Claude Code headlessly;
- get diff + AI-Judge/review artifact;
- human approves/request changes from Web UI;
- merge/PR path exists;
- project memory gets at least one useful lesson.

## 11. MVP / Phase 2 / Later

### MVP — prove the spine

Goal: make one real project task go through the full product loop.

Include:

1. Project onboarding for one repo.
2. Common backlog with manual task creation.
3. Flow template: bugfix or small feature.
4. Workspace lifecycle via git worktree.
5. Headless harness with Claude Code as first executor.
6. Web UI run monitor: progress/logs/status.
7. Human input queue for questions/approval.
8. Basic AI-Judge review artifact.
9. Basic diff viewer or embedded Git diff fallback.
10. Manual merge/PR path.
11. Project lesson capture.

Do not include in MVP:

- multiple executor adapters;
- autonomous task pulling;
- background agents;
- full A/B;
- Telegram;
- heavy analytics;
- platform-level memory sharing;
- advanced durable orchestration.

### Phase 2 — scale within personal/team usage

Include:

- more Flow templates;
- richer Flow customization;
- agent self-selection / Flow initiation;
- background project agents;
- richer diff review;
- workspace preview/ports;
- CI/log intake;
- YouGile/GitHub issue sync;
- basic noise control;
- Telegram notifications/approvals.

### Later

Include:

- multiple executors: opencode, Aider, OpenHands;
- A/B parallel experiments;
- model/provider routing;
- durable orchestration if needed;
- platform-level skill/rule promotion;
- cost/budget analytics;
- team governance/RBAC;
- marketplace/library of Flows/agents.

## 12. Recommended next actions

### Step 1. Finalize Product View

Create a product doc from this synthesis:

- Lean Canvas;
- JTBD;
- product spine;
- MVP scope;
- explicit out-of-scope.

### Step 2. Convert JTBD into user journeys

For each core JTBD, write a short journey:

1. user intent;
2. entry point;
3. UI screens/actions;
4. system behavior;
5. expected artifacts;
6. completion state.

Priority journeys:

- connect project;
- create backlog task;
- launch task via Flow;
- answer human question;
- review diff/Judge artifact;
- merge/request changes;
- capture lesson.

### Step 3. Define product domain model

Not architecture yet — just nouns and relationships:

- Project;
- Team;
- User;
- Task;
- Flow;
- Flow Step;
- Workspace;
- Run;
- Agent;
- Human Input;
- Artifact;
- Review;
- Lesson/Rule;
- Tool/MCP.

### Step 4. Define component map and responsibilities

Move one layer down:

- Web Control Plane;
- Backlog/Board;
- Flow Engine;
- Workspace Manager;
- Agent Harness;
- Artifact Store;
- Review/Judge subsystem;
- Project Memory;
- Integration layer.

For each component: responsibilities, inputs/outputs, key requirements.

### Step 5. Draft MVP architecture

Only after product journeys and component map.

Focus on:

- single host;
- one repo;
- git worktree;
- Claude Code executor;
- simple Flow definition;
- Web UI;
- artifact persistence.

### Step 6. Build the platform as its own first project

Dogfood:

- create this platform as Project 0;
- manage its backlog inside itself as soon as minimal board/workspace exists;
- use bugfix/feature Flow to evolve the platform.

## 13. Immediate recommendation

Next document should be:

**`JTBD_AND_USER_JOURNEYS.md`**

Structure:

1. product spine;
2. actors;
3. JTBD list;
4. user journeys;
5. MVP acceptance criteria;
6. out-of-scope;
7. transition to component architecture.

After that:

**`COMPONENT_REQUIREMENTS.md`** — component-by-component requirements.

Then:

**`MVP_ARCHITECTURE.md`** — concrete architecture and implementation plan.
