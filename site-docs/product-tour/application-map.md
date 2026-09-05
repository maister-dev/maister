---
title: "Application map"
description: "Find the MAIster screens for projects, attention, Runs, Studio, administration, and personal access."
---

Use this page as the map of the product before following a task-specific guide.
MAIster separates daily project work from installation-wide configuration, while
keeping every Run and human decision in one ledger.

## Prerequisites

- An active MAIster account.
- Membership in at least one project, unless you are a global administrator.

![MAIster application shell with the primary navigation and a project open](/assets/screens/en/application-shell.png)

The sample data in screenshots is illustrative. The available navigation items
depend on your global role and project permissions.

## Primary navigation

| Area | Use it for |
| --- | --- |
| Projects | Open the portfolio, register repositories, and enter a project workspace. |
| Inbox | Handle only the permissions, forms, reviews, escalations, and assignments that need a person. Fully automated transitions stay outside the Inbox. |
| Runs | Inspect Flow, scratch, and platform-agent executions across the projects you can access. |
| Studio | Browse package sources, inspect installed packages, fork them, and edit local packages. |
| Agents | Inspect the platform-agent catalog and synchronize package-defined agents. |
| MCPs | Manage the installation-wide MCP server catalog and its trust state. |
| Observatory | Analyze delivery, intervention, evidence, duration, and token-use signals across projects. |
| Settings | Configure execution hosts, ACP runners, provider routes, webhooks, and Project Brain providers. |
| Users and Scheduler | Administer accounts and the background clock. These areas are visible only to global administrators. |
| Account | Change your profile and password, and issue personal API tokens. |

## The main working surfaces

![Project portfolio with active projects and work in progress](/assets/screens/en/project-portfolio.png)

The portfolio answers **where is work happening?** A project workspace answers
**what should happen next in this repository?** The Inbox answers **what needs
my decision?** A Run answers **what exactly happened during this attempt?**

Start from the object you already have:

- A repository: [register a project](/guides/register-a-project), then open its
  [project workspace](/product-tour/project-workspace).
- A feature request or bug report: create a task from the
  [board](/product-tour/tasks-and-runs).
- A process to change: open [Flow Studio](/studio/flow-studio-and-packages).
- Several competing implementations: create a
  [comparison Study](/evaluation/run-comparison).
- An alert or request from an agent: open the Inbox, then follow the link to the
  task or Run that owns it.

## Roles at a glance

Global roles control installation-wide surfaces. Project roles control work in
one repository.

| Role boundary | Typical permissions |
| --- | --- |
| Global viewer | Read installation-wide surfaces available to the account. |
| Global member | Use normal project and Run workflows where project membership permits. |
| Global admin | Manage users, scheduler jobs, runners, MCPs, and platform settings. |
| Project viewer | Read the board, tasks, Runs, evidence, Studies, and project configuration. |
| Project member | Create and edit tasks, launch work, answer human-in-the-loop requests, and conclude Studies. |
| Project admin or owner | Manage project members, packages, agents, integrations, and project settings. |

A global administrator has owner-equivalent access to every project. Hidden
navigation is only a convenience; every server operation checks permissions
again.

## Success and failure signals

You are in the right surface when the page identifies the project, task, Run,
or package you intend to change. Stop and verify context when:

- a project or admin tab is absent, which usually means the current account lacks
  the required role;
- a mutation is disabled with a readiness, trust, or compatibility reason;
- an object is visible but cannot be launched, which preserves history without
  treating old configuration as executable.

## Next steps

- Learn the [project workspace](/product-tour/project-workspace).
- Follow a task through the [board and Run workbench](/product-tour/tasks-and-runs).
- Configure the installation from the [runner](/administration/runners-and-models),
  [access](/administration/users-tokens-and-access), and
  [MCP](/administration/mcp-and-secrets) guides.
