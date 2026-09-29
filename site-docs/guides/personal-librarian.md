---
title: "Work with your personal librarian"
description: "Find work, create and launch tasks, request teammate clarifications, follow results, and control your personal conversation and memory."
---

The librarian is your personal assistant across the MAIster projects you can
access. Use one persistent conversation to find work, turn an idea into a task,
request execution, and follow the outcome. It works with MAIster records and
tools; coding happens in the Runs it helps you launch.

## Prerequisites

- An active MAIster account.
- An administrator has [enabled the librarian and selected an eligible runner](/administration/runners-and-models#configure-the-personal-librarian).
- Access to the projects you ask about. Project viewers can read; creating or
  changing work requires the corresponding project permissions.

The librarian has its own conversation and runner configuration. It does not
need a project-agent attachment, and its history is separate from scratch and
Flow Studio assistant dialogs.

## Open the conversation and choose context

Click **Librarian** in the top navigation. The panel stays open as you navigate;
on narrower screens it opens over the page. **Expand for reading** gives long
answers more room. Cmd/Ctrl+K still opens the scratch launcher.

Start with a question such as “Which tasks need my decision?” or name the
project and task key. Use **Attach this page** on a supported project, task, or
Run page to set the subject explicitly. Check the subject chip before sending:
navigating elsewhere does not retarget an already queued message or card.

Messages sent during a response wait in a server-side queue. **Withdraw** removes
a message while it is still queued. Closing the panel does not stop the response
or launched work. **Stop response** stops the librarian's current response;
stopping a launched Run is a separate action on that Run.

## Turn a request into work

State the intended outcome and whether execution should start:

| Request | Expected behavior |
| --- | --- |
| “Create a task to add CSV export in the billing project. Do not launch it.” | A Backlog task; no launch intent. |
| “Send that task to triage, but do not execute it.” | A triage request without automatic launch. A configured project triager is needed for a verdict. |
| “Triage this task and launch it when ready.” | Triage with launch intent; readiness and admission checks still apply. |
| “Launch BILL-12 with the export Flow.” | A launch attempt using the selected Flow; inspect the receipt for the Run and queue or refusal state. |

Before creation, the librarian searches for likely duplicates. It can structure
the task into context, goal, acceptance criteria, constraints, out-of-scope work,
links, and open questions. A revised statement applies only to a **Backlog**
task. Review a proposed statement's diff before accepting it; a task changed
elsewhere needs a fresh proposal.

For active scratch or persistent agent Runs, ask it to send your correction to
the agent. Flow corrections use the Run's interrupt or rework controls. See
[message delivery](/guides/message-a-running-agent).

**Recent operations** shows the result of each action. **In progress** or
**Outcome uncertain** is not proof that an action failed: inspect the linked
task or Run before asking for another copy. A batch can succeed for some items
and refuse others.

## Ask a teammate before execution

For a Backlog task, name the teammate, exact question, and whether an answer is
required before launch. For example: “Ask Maria on BILL-12 whether CSV should
include archived invoices. Make this a blocking yes/no question.” The recipient
must be an active project member with permission to answer.

The question appears in the recipient's Inbox and decisions queue and on the
task. An open blocking clarification holds launch. Only the addressed person
answers it; the librarian cannot answer for them. The answer is visible on the
task and returns to your conversation while you retain access. It does not
itself launch work or accept a new task statement. See
[task clarifications](/product-tour/tasks-and-runs#clarify-before-launch).

## Review decisions and follow results

Human-only actions, including permission or review answers, promotion, and
workbench discard, require your action in the UI. When a confirmation card is
offered, inspect its target, proposed response or promotion details, and expiry
before accepting. Expired cards or cards whose target changed require a new
proposal. Normal access and readiness checks still apply.

**Related work** links to tasks and Runs with their current status. Work linked
through the conversation can send update cards when it reaches review, needs
input, finishes, fails, or receives a clarification answer. **Explain** requests
a read-only explanation; an update itself does not start another action.
A finished or merged Run does not prove that anything was deployed.

## Control memory and history

Ask explicitly to remember a preference, goal, commitment, or fact. Inferred
memories appear as suggestions for you to accept. Open **Memory** to add, edit,
or forget items, choose general or project scope, and control whether memory is
used in the next conversation segment. Replies identify the saved memories they
used. Personal memory is separate from Project Brain and project-agent memory.

| Control | Effect |
| --- | --- |
| Reset context | Starts a new segment after in-flight librarian operations settle; withdraws queued messages and clears pending cards. Saved memory and task work remain. |
| Forget a memory | Removes that item from future context. A response already running may still use its earlier snapshot. |
| Clear history | Shows a deletion preview, then removes personal messages, summaries, snapshots, and cards. Tasks, saved memory, and operation records remain. Sending waits until cleanup finishes. |

Earlier segments are not automatically included after reset. Ask explicitly to
search earlier conversation history when you need it. To remove saved memories
as well as history, forget those items separately.

## Privacy and failure signals

The conversation and personal memory belong to your account. Other users,
including administrators, cannot browse them through the librarian interface.
Task statements, comments, and clarification answers are project records visible
to people with project access. Ask explicitly to publish an excerpt when you
want to share conversation content on a task.

Project permissions are checked at use time. Losing access can make earlier
librarian replies or linked items unavailable; your own messages remain visible.
The librarian's supported tool surface excludes shell, filesystem, and web
access. It cannot bypass a refused project action.

If sending is disabled, read the displayed reason: administrator disablement,
missing or unready runner, context reset, or a daily limit. History stays readable
when the librarian is disabled. A failed response does not undo task operations
already completed; check **Recent operations** before retrying.

## Related guides

- [Configure runners and librarian limits](/administration/runners-and-models#configure-the-personal-librarian)
- [Tasks, statements, and clarifications](/product-tour/tasks-and-runs)
- [Human-in-the-loop decisions](/guides/human-in-the-loop)
