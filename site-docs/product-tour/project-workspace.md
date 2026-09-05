---
title: "Project workspace"
description: "Understand every project tab and where repository, package, automation, knowledge, and access settings live."
---

A project connects one repository to its tasks, delivery processes, execution
history, integrations, and governance. Open a project from the portfolio to
enter this workspace.

## Prerequisites

- The repository is [registered as a project](/guides/register-a-project).
- You have at least the project `viewer` role.

![Project workspace opened on the Kanban board](/assets/screens/en/project-board.png)

## Project tabs

The tab row scrolls horizontally on narrow screens. Some tabs open dedicated
URLs so their filters and selected objects can be linked directly.

| Tab | What it contains |
| --- | --- |
| Board | Kanban view of tasks, current work, blockers, latest Runs, and launch actions. The badge is the number of visible work items. |
| Activity | Project events and changes in chronological order. |
| Observatory | Project-scoped delivery, intervention, evidence, duration, and token-use metrics. |
| Brain | Indexed project sources, retained lessons, recall history, and improvement proposals. Hidden until Project Brain is enabled. |
| Evaluations | Studies that compare several Runs of one task under recorded methods. |
| Repository | [Tracked files, branches, and source-control information](/product-tour/project-repository-and-packages). |
| Packages | [Attached packages, pinned versions, trust, upgrades, and local cuts](/product-tour/project-repository-and-packages). |
| Integrations | Project-bound API tokens and other external access points. |
| MCPs | The project's MCP requirements, bindings, local servers, overlays, trust, and connection tests. |
| Automations | One-time launches, recurring task schedules, and effective platform-agent bindings. |
| Agents | Platform agents available from attached packages, with project-specific runner, trigger, Brain, branch, and policy settings. |
| Members | Project roster and the `owner`, `admin`, `member`, and `viewer` roles. |
| Webhooks | Outbound event subscriptions and delivery diagnostics. |
| Settings | Project defaults, Brain enablement, agent behavior, and git/promotion configuration. |

## A practical setup order

For a new project, configure the tabs in this order:

1. Confirm the repository and default branch in **Repository** and **Settings**.
2. Attach a trusted package in **Packages**.
3. Resolve package MCP requirements in **MCPs**.
4. Set project defaults and attach required agents in **Agents**.
5. Add people in **Members** and external callers in **Integrations**.
6. Create work on **Board** and add recurring behavior in **Automations** only
   after a manual Run has succeeded.

This order makes launch refusals actionable: each dependency is configured
before a task asks for it.

## Packages inside a project

An attached package remains versioned. The project records which installed
revision it uses and whether executable content is trusted. Open a package name
to inspect its contents; open a Flow to view its graph. Use **Open in Studio**
when you need to edit a fork rather than the immutable installed revision.

A local package cut can be attached like another installation. If its package
name collides with the upstream package, rename the local package in Studio,
commit it, and create a new cut before attaching both.

## Project roles

| Role | Operational meaning |
| --- | --- |
| Viewer | Can inspect the project, Runs, evidence, and Studies. |
| Member | Can edit and launch normal work and answer human-in-the-loop requests. |
| Admin | Can also manage members, agents, packages, integrations, and project settings. |
| Owner | Currently has the same project capabilities as an admin and expresses ownership intent. |

Global administrators act as implicit owners. Adding someone to a project never
creates their platform account; create or activate that account first.

## Success and failure signals

A project is ready for a governed task when it has a valid repository, at least
one launchable Flow, and Ready runners for every Flow session slot. A launch
remains unavailable when a package is untrusted, an MCP requirement is
unresolved, a runner is unavailable, the Flow is incompatible, or a task
relation blocks admission. The UI keeps the object visible and shows the reason
instead of silently selecting a fallback.

## Next steps

- Create and follow work in [Tasks and Runs](/product-tour/tasks-and-runs).
- Find completed work in [Run history and the Run workspace](/product-tour/run-history-and-workbench).
- Learn how [Flow packages move through Studio](/studio/flow-studio-and-packages).
- Configure [project MCP bindings](/administration/mcp-and-secrets).
- Attach [platform agents and schedules](/administration/scheduler-and-platform-agents).
