---
title: "Handle human-in-the-loop requests"
description: "Respond to permissions, forms, reviews, and manual takeover requests without losing Run context."
---

MAIster pauses at human decisions declared by the Flow or requested by the live
agent session. The Needs-you inbox collects actionable requests across projects.

## Permission request

Inspect the requested action, affected resource, and current Run context. Allow
or deny it in the UI. The decision is returned to the same live ACP session.
Denial is an explicit result; the agent or Flow must respond to it.

## Form request

Complete the fields defined by the Flow and submit once the values are correct.
MAIster stores the structured response as a Run artifact. Required fields and
schema errors are shown before submission.

## Human review

Review the patch and current evidence. Accept the result or request rework with
specific comments. Rework comments become input to the next attempt and remain
visible in the history.

## Manual takeover

Use takeover when a person must finish work directly in the isolated worktree.
MAIster preserves Run ownership and workspace identity. After editing, return to
the Run, refresh the review context, and satisfy the required checks before
promotion.

## Safety

Do not edit the parent repository while a Run owns its worktree. Do not approve
an action only to clear the inbox. Resolve the underlying decision and verify
that later evidence corresponds to the resulting code state.
