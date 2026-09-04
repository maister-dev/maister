---
title: "MAIster documentation"
description: "Install, configure, and operate MAIster for governed AI software delivery over private repositories."
---

MAIster is a self-hosted execution and governance layer for repeatable
AI-powered software delivery over private code.

Use MAIster when coding agents already help your team, but the work needs a
shared process: isolated workspaces, explicit human decisions, observable
evidence, bounded rework, and a controlled path to a pull request or merge.

## What MAIster manages

| Object | Purpose |
| --- | --- |
| Project | Connects MAIster to a git repository and its delivery policy. |
| Flow package | Pins a versioned delivery process and its capabilities. |
| Task | Captures an outcome that should move through a Flow. |
| Run | Records one execution attempt, its nodes, events, costs, and decisions. |
| Workspace | Isolates code changes in a git worktree. |
| Evidence | Shows whether required checks, artifacts, and reviews are current. |
| Promotion | Lands accepted work through a pull request or local merge. |

## Choose a path

- [Install a local instance](quickstart.md) and run the first project.
- Learn the [delivery spine](concepts/delivery-spine.md) before designing a Flow.
- [Register an existing repository](guides/register-a-project.md).
- Configure [`maister.yaml`](reference/project-manifest.md) and
  [`flow.yaml`](reference/flow-manifest.md).
- Prepare a [single-host production deployment](operations/deployment.md).

## For AI agents

Every page has a unique title, a short description, explicit prerequisites,
and stable product terms. The self-hosted build exposes source Markdown under
`/markdown`, plus `/llms.txt` and `/llms-full.txt`. A Mint-hosted deployment can
also expose a documentation MCP endpoint at `/mcp`. Prefer the task page closest
to the requested operation and preserve the stated human approval and promotion
boundaries.

## Current operating boundary

MAIster runs the web control plane and execution supervisor on one trusted host
with access to the same repositories and worktrees. Postgres stores the durable
ledger. Claude, Codex, Gemini, OpenCode, and MiMo live in one ACP runner
catalog, with Anthropic, OpenAI, OpenRouter, and compatible provider routes.
Each concrete runner must pass its readiness diagnostics before use.
