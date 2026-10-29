---
title: "Run an operational agent"
description: "Run external or MAIster operations with structured results, normal human decisions, and automatic execution-workspace cleanup."
---

Operational agents deliver an operation and its evidence. Code-delivery agents
deliver source changes for review and promotion. Choose the kind in the package
definition; workspace access and tool approvals are separate settings.

## Configure the definition

Use MAIster engine 3.9.0 or later and a trusted, project-attached package whose
manifest declares `compat.engine_min: "3.9.0"`. In the agent definition:

```yaml
kind: operational
completion:
  contract: operational_v1
mode: session
workspace: worktree
```

Studio exposes the kind and its completion contract. An omitted kind preserves
code-delivery behavior. Operational agents currently require finite standalone
sessions; persistent sessions, subagent execution, Flow bindings, conflicting
result profiles and shared writable workspaces are refused before execution.

The GitHub Issue Intake variants use this contract. Select **gh** when the
execution host provides the GitHub CLI, or **MCP** when the project binds the
required GitHub connection. Configure repository and batch settings per project
attachment. This choice does not grant automatic tool approval. Normal
permissions, isolation, budgets and human-in-the-loop decisions still apply.

## Read the result

The completing turn must publish one `json maister:output` object using the
platform's frozen instructions. The platform validates counts, coverage,
references, actionable diagnostics and source integrity.

- **Success** finishes **Done**. A complete scan with zero new tasks succeeds.
- **Partial**, **blocked** and **failed** outcomes finish **Failed**. Confirmed
  work and unresolved effects remain visible with remediation.
- Missing or malformed output cannot establish success. Cancellation remains
  **Abandoned**; lost execution remains **Crashed**.

A GitHub 403 is an authorization failure, never an empty successful scan.
Unknown task or comment writes require reconciliation before retrying. Do not
repeat an operation merely because a response was lost.

The Run shows its operation result, diagnostics, references, integrity and
cleanup state. Operational Runs have no review, promotion, merge or publication
action. Unexpected source changes fail validation and are preserved for diagnosis.
Changes in a shared source repository cannot be silently attributed to the agent
or removed as its disposable workspace.

## Handle failures and cleanup

Automation history shows dispatch separately from the resulting Run's actual
status. Failed operations and exhausted cleanup appear in attention. Open the
Run, follow its remediation, and acknowledge the exact failure revision when
reviewed. Acknowledgement affects your attention queue only.

Completed operations leave active working copies immediately. The platform
preserves execution evidence before disposing owned resources. Crashed execution
workspaces remain for the configured diagnostic window (14 days by default).
Evidence retention is independent of immediate workspace removal; stronger
existing evidence/session holds still apply. Evidence downloads require project
repository-read authority.

Cleanup retries are bounded. After correcting an exhausted cleanup failure, use
**Retry workspace cleanup**; this re-arms disposal and does not repeat the external
operation. Starting an operation again is a separate attempt. A package update
changes future launches; existing Runs keep their original kind, contract and
instructions. Historical code-delivery Runs retain their original review rules.
