---
title: "Handle human-in-the-loop requests"
description: "Respond to permissions, forms, reviews, and manual takeover requests, watch a live Run, and interrupt a node without losing Run context."
---

MAIster pauses at human decisions declared by the Flow or requested by the live
agent session. The Needs-you inbox collects actionable requests across projects.

## Permission request

Inspect the requested action, affected resource, and current Run context. Allow
or deny it in the UI. The decision is returned to the same live ACP session.
Denial is an explicit result; the agent or Flow must respond to it.

## Saved answer and pending delivery

An answer can be saved before the agent receives it. **Answer saved — delivery
pending** keeps the recorded choice visible and locks new choices. Use
**Retry delivery** when offered: it resends the same saved answer. Refresh after
a conflict to see the authoritative choice if another tab or person answered.

A pending resume is not a failed decision. A delivery-unavailable error can be
retried with the saved answer; an ended-session error instead directs you to
Relaunch for a Flow, or Recover/relaunch for scratch. Keep the error code and
diagnostic when requesting help.

During a long pause MAIster may checkpoint the session and restore it for your
answer. `MAISTER_PERMISSION_MAX_HOURS` is the host's absolute permission wait
cap (default 24 hours); reaching it gracefully parks the session. It does not
automatically approve or deny the requested action.

## Form request

Complete the fields defined by the Flow and submit once the values are correct.
MAIster stores the structured response as a Run artifact. Required fields and
schema errors are shown before submission.

## Human review

Review the patch and current evidence. Accept the result or request rework with
specific comments. Rework comments become input to the next attempt and remain
visible in the history.

## Consensus decision

A consensus request distinguishes complete drafts, partial drafts with retained
text, and unavailable drafts. Inspect the cause before selecting a partial
draft; unavailable choices are disabled. Technical verifier failures are shown
separately from substantive disagreements. Bounded excerpts link to available
full draft or debate artifacts, subject to your access permissions.

## Manual takeover

Use takeover when a person must finish work directly in the isolated worktree.
MAIster preserves Run ownership and workspace identity. After editing, return to
the Run, refresh the review context, and satisfy the required checks before
promotion.

## Watch a live Run and interrupt a node

The Run page streams the agent transcript of the active node as it works, next
to the timeline and the evidence; the liveness pill shows whether the stream is
`live` or `reconnecting`. When something goes wrong, you do not have to wait for
the node to finish.

**Interrupt node** pauses a live agent node mid-turn (agent, judge, and
orchestrator nodes; command and check nodes run to completion) and turns the Run
into a human-in-the-loop request with four options:

- **Resume as-is** — the interrupted turn continues.
- **Restart this node** — the node starts again. An optional correction for the
  agent is appended to the restarted node's prompt, and the workspace policy
  decides whether to keep the working tree as it is, rewind it to the node's
  checkpoint, or start the node from a fresh tree.
- **Restart from an earlier node** — the same restart from a node that has
  already run in this Run; everything after it becomes stale and runs again.
- **Stop run** — the Run ends at this node. The worktree is kept for review, the
  agent session is closed, and the Run cannot continue from here.

Rewinding or resetting the workspace deletes uncommitted work in the worktree
and stopping is final, so MAIster asks for confirmation before those options.
Operator restarts do not count against the Flow's own rework limit; the instance
setting `MAISTER_MAX_OPERATOR_RESTARTS` bounds them per Run.

The Run's **Stop** action ends a live Run without interrupting a node first: the
session is closed and the worktree stays available for review.

For a correction that should reach a running scratch dialog without stopping
it, see [Message a running agent](/guides/message-a-running-agent). Node
interrupt remains the control for pausing or restarting a Flow node.

## Safety

Do not edit the parent repository while a Run owns its worktree. Do not approve
an action only to clear the inbox. Resolve the underlying decision and verify
that later evidence corresponds to the resulting code state.
