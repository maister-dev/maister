---
title: "Project platform agents"
description: "Author an agent in a package, attach it to a project, and configure its runner, workspace, memory, permissions, and triggers."
---

A platform agent starts as a versioned package artifact. A project does not
create a private copy of that definition. The project attaches an agent from a
trusted package and stores its local runner, trigger, workspace, memory, and
execution settings.

## 1. Author the agent in a package

Create or fork a local package in Flow Studio. Add
`maister-agents/<agent-id>.md` from the package file tree and fill the structured
agent form. The file body is the agent's system instruction. Its frontmatter
declares:

- name, description, workspace mode, session mode, and risk tier;
- supported trigger sources and optional same-package Flow;
- optional runner, MCP requirements, guardrails, configuration fields, private
  memory recommendation, and project-setting recommendations.

Studio validates the definition before commit or cut. Platform agents live at
the package root. Files under `capability/**/agents/` are runtime subagents and
do not enter the platform-agent catalog.

Create a commit and cut after review. Install the cut or upstream release, then
attach and trust that package in the target project.

## 2. Attach the agent to a project

![Project agent attachments and settings](/assets/screens/en/project-agents.png)

Open **Project → Agents**. The lower list contains agents supplied by attached,
trusted packages. Choose **Attach** beside the required agent. MAIster fills the
form from the package's recommendations; the project admin decides the stored
values.

Set these fields before enabling the attachment:

| Setting | Project decision |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| Runner override | Keep the package or project default, or select another Ready compatible runner. |
| Workspace | Use no repository, a read-only checkout, or an isolated writable worktree as declared by the definition. |
| Branch base | Choose the branch used for taskless or maintenance work. |
| Execution policy | Decide which permissions may pass without a person and how a budget breach pauses or ends work. |
| Project Brain | Grant read and write separately. |
| Agent memory | Keep private Markdown notes across Runs. Enable **Review agent changes before applying them** to send proposed edits to the Inbox. |
| Context projects | Grant cross-project reach and read-only repository mounts where the installation supports them. |

The attachment is the grant. Disabling or detaching it stops future triggers
and revokes live agent tokens.

### Read and edit an agent’s memory

Once the operator has [activated the memory vault](/operations/deployment#activate-the-agent-memory-vault),
open **Project → Agents**, select the agent and open its **Memory** tab. Browse Markdown notes
under `/memories`, search by text or tag, and open a note to inspect its
revision history and backlinks. Reading requires repository-read access.
With project settings access you can edit a note. If someone saves first,
reload their revision and reapply your changes.

An eligible agent starts with the accessible index (`/memories/index.md` when
present) and a list of paths. It can read additional notes as needed. A Flow
node can use the vault of its assigned agent when that identity is verified
and its attachment has memory enabled. Private notes stay with the agent
across package upgrades. Edits from webhook-triggered Runs and externally
sourced tasks go to review even under the automatic write policy. Sharing
a note with Project Brain requires a proposal.

## 3. Configure triggers

The same edit dialog owns the effective trigger bindings:

| Trigger | Configuration |
| ------------ | ---------------------------------------------------------------------------------------- |
| Manual | Launch from the agent row or a task. Use this for the first test. |
| Cron | Add a cron expression and IANA timezone. The shared scheduler clock dispatches it. |
| Domain event | Select MAIster event kinds such as task or Run changes. |
| Mention | Grant `@package:agent` in task comments. |
| Webhook | Use the authenticated external launch endpoint and project token. |
| Flow | Reference the agent as a Flow participant or bind the definition to a same-package Flow. |

The **Project → Automations** tab shows timing and the latest safe outcome for
cron and event bindings. Return to **Project → Agents** to edit them.

### Add a recurring request

Each cron schedule has its own optional **Request at launch** field. For example:

```text
Check the project's open blockers and summarize changes since yesterday.
```

The request accompanies the agent's standing instructions; it does not change the reusable definition, permissions, human approvals or completion rules. Text is literal: placeholders are not expanded. Multiline and Unicode input are supported, up to 8000 characters after outer whitespace is trimmed and line endings are normalized.

Save and reload to check the value. Clear the field and save to return to the usual instructions. Requests on other schedules stay independent. Editing or deleting a schedule affects future invocations; queued/running work, resume and eligible retry keep their original input.

Inspect **History**, **Attempts** or the Run inspector to see the effective request. Repository-content access is required to read its text. Viewers see only its recorded state; older executions may say the request was not recorded.

A direct cron launch of a subagent is unsupported. For an agent driving a Flow, every successful path must include an `ai_coding`, `judge` or `orchestrator` action. A Flow that can finish without one refuses a nonempty request; optional AI gates and consensus-only paths do not satisfy that rule. Empty requests preserve the existing behavior.

## 4. Test and inspect

Launch the enabled attachment by hand. A standalone agent creates a normal Run
with `run_kind=agent`. An agent that drives a same-package Flow creates a Flow
Run and injects its persona into the coding nodes.

For code-delivery against an existing task, review the task revision, actual
agent/workspace and runner/model in its launch preview, then press the separate
Launch action. The accepted request can wait before a Run exists; follow its
receipt and eventual Run link. A Flow-driving agent uses its declared Flow.
Missing or failed triage does not require a manual assessment form for an
authorized manual launch. [Task launch](/product-tour/tasks-and-runs#launch-deliberately)
explains the independent automatic and manual decisions.

Open the Run to inspect its session, prompt, tool activity, requests for human
input, token use, cost, and terminal result. MAIster quarantines a writable
agent when the dirty-workspace guard detects changes outside its declared
contract; the project admin must inspect and release it.

## Related pages

- [Scheduler and project automations](/administration/scheduler-and-automations)
- [Repository and project packages](/product-tour/project-repository-and-packages)
- [Project Brain and platform agents](/concepts/project-brain-and-agents)
- [Run history and Run workspace](/product-tour/run-history-and-workbench)

## Deliverable kind

The package declares `kind: code_delivery` (the default) or `kind: operational` with a versioned completion contract. The project attachment retains the declared kind and completion. Operational sessions retain normal tool approval and isolation. Their validated result determines Done or failure, independently of workspace access. See [operational agents](/guides/operational-agents).
