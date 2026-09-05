---
title: "Review, rework, and human takeover"
description: "Inspect production artifacts, leave anchored comments, return work to an agent, edit locally, and re-enter Flow validation."
---

MAIster keeps review inside the Run that produced the work. The reviewer can
inspect evidence, comment on the diff, request agent rework, or claim the
worktree for local changes before sending it back through validation.

## Prerequisites

- Project `member` access with permission to answer human-in-the-loop requests.
- A Flow whose review node declares the decisions you intend to use.
- For manual takeover, local access to the execution host and the Run worktree.

## 1. Open the review request

![Human-in-the-loop request on a Run](/assets/screens/en/hitl-request.png)

Open the Inbox item or the Run directly. Confirm the task, current node,
requested decision, criticality, and latest attempt. The built-in Inbox is the
normal MAIster surface. A personal assistant with explicit token scopes may
relay the same request to chat and return the person's decision through the API.

## 2. Inspect current evidence

![Review diff with file-level changes](/assets/screens/en/review-diff.png)

Review the current diff together with test, lint, check, judgment, and other
declared artifacts. The evidence graph records which node and attempt produced
each item. Required evidence must be `current`; stale or superseded history does
not satisfy review or merge gates.

Production artifacts and structured results serve different purposes. Open an
artifact to inspect its body. Read a structured result for small typed decisions
that later nodes or evaluators consume.

## 3. Ask the agent before deciding

![Answer-only chat with the agent parked at review](/assets/screens/en/review-agent-chat.png)

Use **Ask the agent** when the diff or evidence needs an explanation. The chat
is available at an open human or form gate while MAIster can reach the parked
ACP session. A permission request does not offer chat because the agent is
still inside the tool call that owns that prompt turn.

The question starts an answer-only turn. It does not approve the gate, resume
Flow execution, or grant permission to change code. MAIster instructs the
session to stay read-only, rejects clear write-tool requests, and compares the
workspace with a checkpoint after the answer. If the session changes files,
MAIster restores the checkpoint and marks the reply.

An idle session may need to be restored for the first question; the UI shows
the expected cache-creation cost before you send it. If you later choose
**Rework**, MAIster includes the completed question-and-answer history with the
review summary and open line comments.

## 4. Leave review threads

Add a root comment to a concrete diff line, then use replies for discussion.
MAIster stores the original line anchor and classifies it as inline or outdated
against the current diff. Resolve a thread when the concern is addressed.

Open threads are composed with the review summary and injected into the Flow's
declared rework variable. Resolved threads are not sent back to the agent.
Approval can warn about open threads, but the review decision remains explicit.

## 5A. Send work back to an agent

Choose **Rework**, add a concise summary, and select an allowed re-entry target
when the Flow offers one. The Flow applies its configured workspace policy:

- keep the current worktree;
- rewind to the target node's checkpoint;
- start a fresh attempt.

The target and downstream node attempts, gates, results, and artifacts become
stale. The next agent attempt receives the summary and open review threads
through the configured `commentsVar`. The Run cannot return to acceptance until
the required checks and evidence are produced again.

## 5B. Take over the worktree

Choose **Take over** when a local edit is safer or faster than another agent
turn.

1. Claim the Run. MAIster records you as the owner and changes it to **Human
   working**.
2. Open the existing worktree and branch returned by the claim. No new branch or
   pull request is created.
3. Make the changes locally.
4. Commit every intended change. The return action refuses a dirty worktree or
   an empty commit range.
5. Return the work to MAIster.

MAIster records the returned commits and diff, marks the configured validation
re-entry path stale, and resumes the Flow at that validation node. Checks run
against the human's commits before a fresh review request appears. It never
returns to the implementation node unless the Flow explicitly designed that
path, which prevents an agent from overwriting the human edit.

A top-level Flow Run already in **Review** can also be claimed for local rework
when its workspace is eligible. This path can fast-forward changes pushed from
another machine before validating the clean worktree and returning to the Flow.

## 6. Approve and promote

![Promotion dialog after review](/assets/screens/en/promotion.png)

Approval completes the review decision; promotion is a separate action. Before
promotion, MAIster rechecks required evidence and repository state. Depending on
project policy, promotion creates a pull request or performs a local merge and
records the resulting commit set as evidence.

## Failure signals

| Signal | Resolution |
| --- | --- |
| Review action unavailable | Confirm the Run is at an open review request and your project role can answer it. |
| Rework loop exhausted | Escalate through the Flow's declared human path or make a new explicit plan; do not bypass the bound. |
| Takeover already claimed | Another person won the ownership claim. Coordinate through the Run. |
| Dirty worktree on return | Commit intended work or discard it before retrying return. |
| Empty return | Make and commit a change, or release the takeover without changes. |
| Evidence stale or missing | Rerun the producing node or gate; an old passing artifact cannot approve new code. |
| Pull request conflict | Use the project sync/reopen path. The scheduler may start a separate bounded ACP resolver session. |

## Related guides

- [Human-in-the-loop requests](/guides/human-in-the-loop)
- [Review and promote](/guides/review-and-promote)
- [Structured results and Run context](/studio/structured-results-and-context)
