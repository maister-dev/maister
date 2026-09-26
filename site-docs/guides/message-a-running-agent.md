---
title: "Message a running agent"
description: "Send corrections to a project scratch dialog, understand steering and queue states, and address persistent agent children."
---

In a project scratch dialog, send a correction while the agent is working.
MAIster saves the message immediately and either steers the active turn or
queues it for a later turn. Reloading the page does not discard queued messages.

## Send a correction in a scratch dialog

1. Open the project's scratch Run and confirm that it is **Running**.
2. Send the instruction through its message composer.
3. Read the delivery label in the transcript and inspect the agent's response.

| Label | Meaning |
| --- | --- |
| Steered | The instruction uses the active turn's steering path. If delivery is still being reconciled, it may later change to Queued. |
| Queued | The server saved the instruction for a subsequent turn. Queued messages are dispatched oldest first. |
| Not sent | The dialog ended before its queued instruction could be sent. |

Steering depends on the capability advertised by this specific adapter session.
An unsupported session or a refused steering attempt uses the queue. **Steered**
does not promise immediate compliance or cancellation of a tool call already
in progress; check the transcript and resulting work.

The scratch composer refuses a message during initial setup, while waiting for
a permission answer, or after the dialog ends. Answer the permission through
the [HITL controls](/guides/human-in-the-loop). Studio and evaluator assistant
dialogs accept their next message only after their current turn finishes.

## Recover queued work

If the scratch dialog crashes, **Recover** preserves earlier queued messages
and places the recovery message after them. If a web restart leaves messages
queued while the dialog is ready for input, the next send or an available
Recover action starts dispatch again. Stopping or completing a dialog leaves
undelivered queued rows visible as **Not sent**.

After a host or session failure, recovery can deliver an instruction again.
Inspect the transcript before resending instructions with external side effects.

## Message a persistent child agent

A coordinator using the external API or MCP `run_message` can address its own
persistent agent child with exactly one of `addressableKey` or `childRunId`.
`childRunId` must be a UUID. Set `mode: "steer"` to attempt delivery to its
running turn; `mode: "queue"` is the default. The response's `delivery` field
reports `steered` or `queued`. Reuse `requestKey` for retries of the same message.

This requires the coordinator's run-bound token with `runs:delegate` authority.
Flow children do not expose an addressable agent session for this operation.
For result collection, `run_collect` accepts exactly one of `childRunId` or
`all: true`; collection itself does not send a message.

## Related guides

- [Human-in-the-loop requests](/guides/human-in-the-loop)
- [Recursive Agent Harness](/concepts/recursive-agent-harness)
- [Configure runners and models](/administration/runners-and-models)
