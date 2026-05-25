# MAIster — Vision

## One-liner

**MAIster is the control plane for AI-powered software delivery.**

It turns backlog tasks into supervised agentic delivery Flows: workspace creation, headless agent execution, HITL, AI-Judge, diff review, merge and project learning.

## Why

AI coding agents are useful, but managing several of them manually becomes operational noise: many terminals, lost context, unclear progress, scattered artifacts, weak review and repeated project-specific mistakes.

MAIster should remove the need to babysit coding-agent consoles. The human should manage work at the level of projects, tasks, Flows, reviews and decisions.

## Core product spine

```text
Backlog → Flow → Workspace → Headless Agents → HITL → AI-Judge → Diff Review → Merge → Lessons
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
   Specs, plans, diffs, tests, Judge reports, reviews and lessons must be stored as structured artifacts.

6. **Project learns from work**  
   Bugs, incidents and reviews should produce lessons and evolve project rules/playbooks - this is the basic platform ability requirement.

7. **Start personal, not enterprise**  
   Optimize for one owner and small teams first: low ops, fast iteration, single host. Enterprise governance later if needed.

## MVP goal

Prove the spine on one real project:

1. Create backlog task manually.
2. Launch it through one Flow: bugfix or small feature.
3. Automatically create git worktree workspace.
4. Run Claude Code/Codex/Pi/OpenCode headlessly.
5. Show run progress/logs/artifacts in Web UI.
6. Let human answer questions/approve.
7. Produce AI-Judge review artifact.
8. Show diff and tests.
9. Allow manual PR/merge path.
10. Capture one useful project lesson.

## Not MVP

- multiple executor pool;
- autonomous task pulling;
- background project agents;
- A/B experiments;
- Telegram approvals;
- heavy analytics;
- platform-level cross-project skills;
- enterprise RBAC/compliance;
- Temporal-class durable orchestration.
