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
| --- | --- |
| Runner override | Keep the package or project default, or select another Ready compatible runner. |
| Workspace | Use no repository, a read-only checkout, or an isolated writable worktree as declared by the definition. |
| Branch base | Choose the branch used for taskless or maintenance work. |
| Execution policy | Decide which permissions may pass without a person and how a budget breach pauses or ends work. |
| Project Brain | Grant read and write separately. |
| Agent memory | Enable the agent's private `memory.md`; this is separate from Project Brain. |
| Context projects | Grant cross-project reach and read-only repository mounts where the installation supports them. |

The attachment is the grant. Disabling or detaching it stops future triggers
and revokes live agent tokens. A flow-bound agent cannot use private agent
memory because its work runs through Flow sessions.

## 3. Configure triggers

The same edit dialog owns the effective trigger bindings:

| Trigger | Configuration |
| --- | --- |
| Manual | Launch from the agent row or a task. Use this for the first test. |
| Cron | Add a cron expression and IANA timezone. The shared scheduler clock dispatches it. |
| Domain event | Select MAIster event kinds such as task or Run changes. |
| Mention | Grant `@package:agent` in task comments. |
| Webhook | Use the authenticated external launch endpoint and project token. |
| Flow | Reference the agent as a Flow participant or bind the definition to a same-package Flow. |

The **Project → Automations** tab shows timing and the latest safe outcome for
cron and event bindings. Return to **Project → Agents** to edit them.

## 4. Test and inspect

Launch the enabled attachment by hand. A standalone agent creates a normal Run
with `run_kind=agent`. An agent that drives a same-package Flow creates a Flow
Run and injects its persona into the coding nodes.

Open the Run to inspect its session, prompt, tool activity, requests for human
input, token use, cost, and terminal result. MAIster quarantines a writable
agent when the dirty-workspace guard detects changes outside its declared
contract; the project admin must inspect and release it.

## Related pages

- [Scheduler and project automations](/administration/scheduler-and-automations)
- [Repository and project packages](/product-tour/project-repository-and-packages)
- [Project Brain and platform agents](/concepts/project-brain-and-agents)
- [Run history and Run workspace](/product-tour/run-history-and-workbench)
