---
title: "Scheduler and project automations"
description: "Run the shared clock, schedule task and Flow launches, monitor jobs, and choose the correct trigger surface."
---

MAIster uses one scheduler clock for task schedules, agent triggers, webhook
delivery, repository checks, Evaluation Lab work, and maintenance jobs. A
global administrator operates the clock; project members configure their work
through **Project → Automations** and **Project → Agents**.

## Start the clock

Set `MAISTER_CRON_TOKEN` on the web process. In production, call `GET` or `POST
/api/cron/tick` from an external cron service with
`X-Maister-Cron-Token: <token>` or `Authorization: Bearer <token>`.

A single-host installation can use the in-process timer:

```dotenv
MAISTER_CRON_TOKEN=<server-only secret>
MAISTER_SCHEDULER_TIMER_ENABLED=true
MAISTER_SCHEDULER_TICK_INTERVAL_SECONDS=60
```

Use one clock source. An empty cron token disables the endpoint with `503`.

## Inspect global jobs

![Global scheduler diagnostics](/assets/screens/en/scheduler.png)

Open **Scheduler** as a global administrator. The table shows the job kind,
target summary, cadence, next run, enabled state, consecutive failures, and the
last attempt. The page also links task schedules and one-time launch intents
back to their projects.

You can create two operator job types from this screen:

- **Flow run** targets a task and starts it with the selected branches and
  runner choices.
- **Command** performs an HTTP health request or a host ping.

Command jobs do not run arbitrary shell text. Put a script behind an
authenticated HTTP endpoint when it belongs outside MAIster. Use a Flow or a
platform agent when the work needs repository context, agent tools, budgets,
evidence, or human decisions.

## Schedule project work

**Project → Automations** combines three kinds of future work:

1. A one-time task launch. Open the task launch form, choose **Schedule**, set
   local date, time, timezone, and DST handling. MAIster stores an intent and
   creates the Run only after a scheduler tick claims it.
2. A recurring task schedule with cron expression, timezone, catch-up behavior,
   branches, Flow, and runner selection.
3. Platform-agent cron or event bindings. The page shows them and links to
   **Project → Agents**, which owns their settings.

Use **Run now** on an eligible pending one-time intent when the work should
start before its due time. Claimed and terminal intents remain in history
without editable controls.

## Diagnose a missed launch

1. Open **Project → Automations** and check the intent or binding state, next
   time, timezone, and latest safe outcome.
2. Confirm that the task has no blocking relation and that its Flow, runners,
   package trust, and MCP bindings are ready.
3. For an agent trigger, edit the attachment in **Project → Agents** and check
   that both the agent and binding are enabled.
4. Open the global Scheduler. Check the dispatcher job, tick recency, failure
   count, and last error code.

The scheduler claims due work with leases and idempotency keys. Repeating a tick
does not create a second Run for the same claimed intent.

## Related pages

- [Project platform agents](/administration/project-platform-agents)
- [Run history and Run workspace](/product-tour/run-history-and-workbench)
- [Deployment](/operations/deployment)
