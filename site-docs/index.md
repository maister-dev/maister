---
title: "MAIster documentation"
description: "Understand, configure, and operate MAIster for governed AI software delivery over private repositories."
---

MAIster is a self-hosted control plane where people and AI agents deliver
software through shared, repeatable processes. It connects tasks, isolated
workspaces, coding-agent sessions, human decisions, evidence, costs, review,
and promotion without making team members babysit terminals.

## Start with the product

If MAIster is new to you, follow the visual tour before changing configuration:

- [Application map](/product-tour/application-map) explains the portfolio,
  Inbox, global administration, and the path into a project.
- [Personal librarian](/guides/personal-librarian) helps you find, create,
  clarify, and launch tasks in one private conversation, then follow results.
- [Project workspace](/product-tour/project-workspace) covers every project tab,
  from the board and activity to packages, integrations, Brain, and settings.
- [Repository and project packages](/product-tour/project-repository-and-packages)
  shows how to browse source and attach upstream or locally cut packages.
- [Kanban board, tasks, and Runs](/product-tour/tasks-and-runs) follows work from
  the queue into one or more execution attempts.
- [Run history and the Run workspace](/product-tour/run-history-and-workbench)
  covers the ledger, graph, node attempts, files, evidence, and timeline.

Then [install a local instance](/quickstart) and register a repository.

## Configure the platform

| Task | Guide |
| --- | --- |
| Add coding agents, provider routes, and model profiles | [Runners and models](/administration/runners-and-models) |
| Invite people and issue scoped API tokens | [Users, tokens, and access](/administration/users-tokens-and-access) |
| Add MCP servers without storing secrets in manifests | [MCP and secrets](/administration/mcp-and-secrets) |
| Attach package-defined agents and configure project triggers | [Project platform agents](/administration/project-platform-agents) |
| Schedule tasks, Flows, checks, and agent work | [Scheduler and project automations](/administration/scheduler-and-automations) |

## Build delivery processes

[Flow Studio](/studio/flow-studio-and-packages) edits installed processes as a
graph, forks package content, and can use an AI assistant to propose bounded
changes. Learn [how to open and use the assistant](/studio/ai-assistant), then
continue with the [node catalog](/studio/node-types) and
[structured results and Run context](/studio/structured-results-and-context) to
pass typed data between graph steps.

Import [skills and MCP servers into a package](/studio/flow-studio-and-packages#import-skills-and-mcp-servers)
and [attach a reviewed version to your project](/guides/package-sources-and-versions).
To deliver through a pull request, configure the Flow to
[wait for CI on the published commit](/guides/flow-waits-and-ci).

## Inspect quality and economics

- [Compare Runs](/evaluation/run-comparison) across Flows, coding agents,
  models, capabilities, objective tools, AI judges, and human verdicts.
- Use [Observatory](/operations/costs-and-budgets) to attribute tokens and time
  to tasks, stages, runners, and models.
- Follow [review, rework, and human takeover](/guides/review-rework-and-takeover)
  from production artifacts to agent correction or local editing and back into
  Flow validation.
- Configure [Project Brain, embeddings, and platform agents](/concepts/project-brain-and-agents)
  for indexed sources and governed memory.
- Review [company and project knowledge](/guides/company-brain) with its
  original evidence, proposals, and separate factual confirmation.
- Assign governed work to company specialists, starting with the
  [stand-maintenance pilot](/guides/stand-maintenance) or an
  [inbound webhook](/guides/company-specialist-webhooks).

## For AI agents

Every page has a unique title, explicit prerequisites, success or failure
signals, and stable links. The self-hosted build exposes source Markdown under
`/markdown`, plus `/llms.txt` and `/llms-full.txt`. A Mint-hosted deployment can
also expose a documentation MCP endpoint at `/mcp`.

Prefer the page closest to the requested operation. Do not skip declared human
approval, access, evidence, or promotion boundaries.

## Current operating boundary

The default installation runs Web and its supervisor on one host. When launching
a Flow from the board, a project member can choose an eligible supervisor. The selected host keeps the Run’s worktree, agent sessions and Git
operations. To resume interrupted work, restore that host with its original
state. See [Execution hosts](/operations/execution-hosts).
