# Personal librarian

The librarian is one private, durable conversation per signed-in user. Open it
from the top navigation on any authenticated page. It can find work across
projects you can currently access, help agree a task statement, create or
update tasks, ask an addressed teammate for clarification, route tasks to
triage or a Flow, and bring later outcomes back to the same conversation.
It uses a configured Claude ACP runner through the MAIster MCP
facade. A reply is a conversation result; the task, run, clarification,
operation receipt and review screen remain the records of work.

## Work with it

1. Describe the need without choosing a project or runner. Ask it to search
   for related work before creating a task. Results are limited to projects
   you can see now; a partial result is labelled.
2. Review the proposed statement, owner project and duplicate candidates.
   Say which tasks to create. Creation alone leaves launch intent at `none`.
3. Choose the next step for each task: leave it in Backlog, send it to triage
   with `triage_only`, or explicitly request a launch. `triage_then_launch`
   authorizes later automatic execution only after the triage verdict and
   ordinary launch checks. A launch receipt names the actual Run and whether
   it is Pending or Running.
4. For missing technical detail, ask a named project member through a task
   clarification. A blocking question holds launch. The teammate answers on
   the task; the answer is attributed and an update returns to the librarian.
   The answer does not silently change the accepted statement or launch work.
5. Open task and run links for live status, review, evidence and delivery.
   The librarian may explain a merge, but a merge does not establish
   deployment or business acceptance.

The panel survives navigation and can be closed while a turn or task runs.
An unread indicator appears when a reply or update arrives. A pending owner
card requires your decision: inspect its exact target and revision before
accepting. Human-only approvals run from your click, under your current
permissions. If access or the target changes, the action is refused and the
card must be reviewed again.

## Context and privacy controls

| Control | Effect |
| --- | --- |
| Stop response | Stops the current librarian turn; it does not stop a task Run. |
| Reset context | Starts a fresh segment in the same conversation after outstanding effects settle. Older messages leave automatic context; history, explicit memory, tasks and open clarifications remain. Pending cards from the old segment are cleared. |
| Memory | Shows personal facts, goals, commitments and preferences. Explicit entries may be edited or forgotten. Forget excludes an item from future context and prevents an older summary from silently recreating it. |
| Clear history | Shows a scope preview, then removes private messages, summaries, snapshots and pending cards. Task statements, published excerpts, operations and audit records remain. Links to deleted source messages say the source is unavailable. This is separate from reset. |

Personal memory is distinct from Project Brain. Project-scoped entries are
shown only while you can still access their project. A new turn checks your
current permissions; a lost browser response can be retried with the same
operation key without creating the same task twice.

## Enable and operate

A global admin enables the Librarian card in **Settings → ACP runners** and
selects a ready, enabled Claude runner with an eligible permission
policy. A missing or unready runner makes new turns unavailable; disabling
admission preserves queued messages and existing work. The panel shows the
reason when it cannot accept a turn.
Codex is currently ineligible because its built-in host reads lack a verified
deny mechanism for librarian sessions.

The web tier reads the finite turn, concurrency, context, daily-use,
confirmation, operation-reconciliation and retention limits at boot. Set them
in the host environment and see [Configuration](configuration.md#personal-librarian--platform_runtime_settings-implemented--adr-183)
for names, defaults and validation. The supervisor and MCP facade must be
reachable on the same supported execution host. If a turn fails, inspect its
visible error and the librarian Run/operation receipt before retrying; do not
assume an effect failed merely because a browser response was lost.

The contract and detailed state machines are in
[Librarian conversation](system-analytics/librarian-conversation.md),
[authority](system-analytics/librarian-authority.md),
[operations](system-analytics/librarian-operations.md) and
[memory](system-analytics/librarian-memory.md).
