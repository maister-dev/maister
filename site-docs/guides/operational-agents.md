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


## Find activity and retry a failed runner

The rail shows each active agent execution, including queued and parked runs,
in its own section. Completion removes that row. Project **Agents** shows retained
run counts and the latest status; open an agent for paginated run and trigger-attempt
history, its pinned definition, memory and attachment settings. History remains
read-only after detaching the agent. Retained history counts are not lifetime totals.
Definition and memory require repository-read permission; memory edits use version
checks. Edit a prompt through its package and explicitly upgrade the attachment pin.

Inbox groups problems by project and agent. A repeated cause increases its occurrence
count without creating another card or notifying you again after acknowledgement.
A new cause can require attention. Human decisions remain separate requests.

**Run again…** previews a new attempt with a runner selected for that attempt.
It is available only when durable evidence proves the previous execution did no work.
Review changes in current inputs, choose a ready runner and accept the attempt.
A lost response can be recovered with the same request; it never authorizes a second
successor. The original run, delivery runner and future defaults remain unchanged.
Unknown effects require reconciliation. Cleanup retry disposes resources only.

## Qualify incoming requests

The updated core intake/triager package requires engine **3.10.0 or later** and
project qualification policy **Required**, configured in project Settings before
activating the package. New projects use Required; existing projects keep their
creation baseline until explicitly changed. Clearing an override restores that
baseline. Turning the policy off does not waive already-governed task holds.

Both GitHub transports preserve original issue content and capture a task in
**Incoming requests**, without accepting it for implementation. The project triager
uses one shared assessment procedure against a read-only checkout of the task's
server-resolved target SHA. It checks scope, acceptance criteria, consistency,
constraints/dependencies, duplicates, current relevance and bug evidence.
Read-only inspection is not a reproduced bug; missing runtime evidence needs review.

An accepted **Ready** assessment moves the task to accepted backlog. **Needs
information**, **Needs review** and **Not actionable** remain in Incoming with
specific next actions. These can be successful operational outcomes. Runner/API
failure is an execution problem and does not establish that a request is invalid.
Human questions resume the same agent run; explicit requeue is a separate action.

Open a task to inspect assessment evidence or record a reviewed human assessment.
Every check requires a rationale; Ready also requires repository evidence for
relevance. Input edits and confirmed clarifications invalidate old acceptance.
The platform rechecks revisions and the checked SHA at delivery admission, including
manual and forced launches. An agent candidate remains held until its clean validated
terminal result publishes it. Failed, partial, cancelled or dirty runs cannot publish.
