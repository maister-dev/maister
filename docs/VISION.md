# MAIster — Vision

## One-liner

**MAIster is the control plane for AI-powered software delivery.**

It turns backlog tasks into supervised delivery Flows: workspace creation,
headless agent execution, HITL, diff review, and merge.

## Why

AI coding agents are useful, but managing several of them manually becomes operational noise: many terminals, lost context, unclear progress, scattered artifacts, weak review and repeated project-specific mistakes.

MAIster should remove the need to babysit coding-agent consoles. The human should manage work at the level of projects, tasks, Flows, reviews and decisions.

## Core product spine

```text
Backlog -> Flow -> Workspace -> Headless Agents -> HITL -> Diff Review -> Merge
```

## Product principles

1. **Flow over prompt**
   Work should be launched through reusable Flows, not ad-hoc agent prompts.

2. **Workspace as first-class object**
   A Flow launch creates an isolated workspace: branch/worktree/config/progress/cleanup/merge.

3. **Web UI first**
   Review, intervention, dialogue and validation require a rich surface. Telegram is useful later for notifications and quick decisions.

4. **Human participates where Flow says**
   HITL is not global. Each Flow step defines whether human input is must/can/autonomous.

5. **Artifacts over chat sludge**
   Specs, plans, diffs, tests, reviews and HITL responses must be stored as structured artifacts.

6. **Start personal, not enterprise**
   Optimize for one owner and small teams first: low ops, fast iteration, single host. Enterprise governance later if needed.

## MVP goal

Prove the spine on **several real projects in parallel**:

1. Register multiple projects via per-project `maister.yaml` (each with its own
   list of Flows).
2. See all active workspaces across projects on one **Portfolio home**
   (superset.sh-style grid).
3. For each project, manage a **task board** with two columns:
   `Backlog | In Flight`.
4. Create backlog tasks (title + prompt + Flow from project's `flows[]`).
5. Click **Launch** on a Backlog task → workspace auto-created via git
   worktree → Flow launched. Task moves to In Flight. Retry-friendly: a task
   may spawn many runs over its lifetime (1:N) — if a run fails or is
   abandoned, the task returns to Backlog with the Launch button re-enabled.
6. Run Claude Code or Codex headlessly inside the worktree through ACP.
7. Show run progress, logs, and HITL in the Web UI through durable SSE.
8. Let the user answer permission and structured-form HITL requests.
9. Show diff and merge-to-main on clean-merge case.
10. Run up to 3 sessions concurrently across projects (global cap, queue the rest).

## Not MVP

- autonomous task pulling;
- background project agents;
- A/B experiments;
- Telegram approvals;
- heavy analytics;
- platform-level cross-project skills;
- enterprise RBAC/compliance;
- Temporal-class durable orchestration;
- AI-Judge review artifact;
- project lesson capture;
- full Kanban (Done as drag-target / WIP limits / swim-lanes);
- cross-project task moves;
- GitHub issue / Linear / YouGile sync.
