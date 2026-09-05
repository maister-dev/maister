---
title: "Scheduler and platform agents"
description: "Enable the scheduler clock, inspect jobs, attach package-defined agents, and configure manual, cron, event, webhook, Flow, or mention triggers."
---

The scheduler is MAIster's shared background clock. Platform agents are named,
package-defined actors whose launches use the normal Run ledger, runner catalog,
budgets, permissions, and attention surfaces.

## Prerequisites

- Global `admin` access for the scheduler screen.
- A trusted package that ships `maister-agents/*.md` definitions.
- Project `admin` or `owner` access to attach and configure an agent.

## Enable scheduler ticks

Production deployments should call the authenticated scheduler endpoint from an
external cron service. Set a server-only secret on the web process:

```dotenv
MAISTER_CRON_TOKEN=<store this outside version control>
```

Then call `GET` or `POST /api/cron/tick` with either
`X-Maister-Cron-Token: <token>` or `Authorization: Bearer <token>`. An empty
`MAISTER_CRON_TOKEN` disables the endpoint with `503`.

For a single-host installation, MAIster can run an in-process fallback timer:

```dotenv
MAISTER_CRON_TOKEN=<store this outside version control>
MAISTER_SCHEDULER_TIMER_ENABLED=true
MAISTER_SCHEDULER_TICK_INTERVAL_SECONDS=60
```

Use one clock strategy per deployment. The timer starts in the web process and
is intended for a single-box setup; external cron is easier to supervise in
production.

## Inspect the scheduler

Open **Scheduler** as a global administrator. The page shows job kind, target,
cadence, next run, enabled state, failure count, last attempt, one-time launch
diagnostics, task schedules, and workspace-reconciliation findings.

The shared clock drives system sweeps, task schedules, webhook delivery, domain
events, auto-launch, auto-promotion, repository and pull-request scans,
Evaluation Lab dispatch, and platform-agent schedules. System-managed jobs can
be inspected and paused where the UI permits; project schedule edits remain in
**Project → Automations**.

## Attach a platform agent

![Platform-agent catalog and project attachments](/assets/screens/en/platform-agents.png)

1. Attach and trust the package that contains the agent.
2. Open **Project → Agents**.
3. Attach the agent and review its package, risk tier, workspace mode, and
   recommended configuration.
4. Select a runner override when the package default is not appropriate.
5. Grant Brain read or write access only when the agent needs it.
6. Configure triggers and execution policy.
7. Enable the attachment, then launch it manually once before enabling recurring
   or event-driven work.

An attachment is the project grant. Disabling it also disables its schedules
and revokes live agent tokens. Re-enabling schedules does not revive old tokens.

## Trigger types

| Trigger | Typical use |
| --- | --- |
| Manual | Test or run an agent on demand. |
| Cron | Periodic monitoring, maintenance, or knowledge improvement. |
| Domain event | React to task, Run, gate, or other recorded MAIster events. |
| Webhook | Let an authenticated external system request an agent launch. |
| Flow binding | Use a package-defined agent as a node persona inside a delivery Flow. |
| Mention | Allow `@agent-id` in a task comment to summon the agent. |

All trigger paths converge on the same launch gate: the package must be attached
and trusted, the catalog and project attachment must be enabled, the definition
must be valid, the runner must be ready, and budgets must admit the work.

## Built-in agent examples

| Agent | Responsibility |
| --- | --- |
| `core:triager` | Classifies a task, proposes Flow, runner, branches, priority, relations, and clarification or enqueue intent. |
| `core:improver` | Finds recurring Project Brain evidence and drafts small improvements for human review. |
| `core:experiment-judge` | Scores blinded Study participants with a versioned rubric; it cannot decide or promote the winner. |

Repository and pull-request monitoring is scheduler-owned. When a pull request
has a merge conflict, the scheduler starts a separate ACP resolver session. It
is not a permanently running hidden agent; its work appears as a bounded,
auditable execution.

## Project Automations

**Project → Automations** combines three read models without hiding their
different owners:

- one-time task launch intents;
- recurring task schedules;
- effective platform-agent trigger bindings.

Start here when a scheduled task did not launch. Move to the global Scheduler
screen when the project configuration is correct but the clock or dispatcher is
failing.

## Failure signals

- No ticks: confirm `MAISTER_CRON_TOKEN`, timer or external cron, and the last
  Scheduler attempt.
- Repeated failures: inspect the typed job target and safe error code; the job
  may disable after its configured threshold.
- Agent unavailable: verify attached + trusted + enabled package state, runner
  readiness, workspace compatibility, and trigger declaration.
- Event loop suppressed: MAIster skips self-triggering events and applies agent
  chain-depth limits to prevent ping-pong automation.

## Related guides

- [Project platform agents](/administration/project-platform-agents)
- [Scheduler and project automations](/administration/scheduler-and-automations)
- [Project workspace](/product-tour/project-workspace)
- [Project Brain and platform agents](/concepts/project-brain-and-agents)
- [Costs and execution budgets](/operations/costs-and-budgets)
