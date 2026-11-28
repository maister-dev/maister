---
title: "The delivery spine"
description: "Understand the stable sequence MAIster uses from repository intake to reviewed promotion."
---

MAIster keeps a small deterministic spine around work that remains
non-deterministic. Agents can reason and produce open-ended results, while the
platform records ownership, state, evidence, budgets, decisions, and promotion.

## Sequence

1. A **Project** identifies a repository and its delivery policy.
2. A **Flow package** supplies a pinned, versioned process.
3. A **Task** or scratch session supplies the intent.
4. A **Run** records one immutable attempt.
5. A **Workspace** isolates repository changes.
6. **ACP sessions** execute agent nodes with scoped capabilities.
7. **Human-in-the-loop requests** pause at declared decisions.
8. **Evidence** reports whether required outputs are present and current.
9. **Review** applies human judgment to the result.
10. **Promotion** opens a pull request, publishes a branch or performs a local merge.

## What is deterministic

- Flow and runner revisions
- Node state transitions
- Workspace and branch ownership
- Attempt and event history
- Budget and rework limits
- Required evidence status
- Human decisions
- Promotion target and result

## What remains open

Agent prompts, reasoning, patches, reports, and structured result payloads may
vary between runs. A Flow should constrain the contract that matters without
pretending the creative work is deterministic.

## Trust boundary

Web records Run state, decisions and evidence references in Postgres. The
assigned supervisor owns the worktree and agent sessions. In a project
configured for host selection, review, publication and recovery use the
worktree on that supervisor. See [Execution hosts](/operations/execution-hosts).
