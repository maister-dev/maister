# Scheduler domain ERD

Tables for the unified scheduler clock introduced by M24. See
[`../system-analytics/scheduler.md`](../system-analytics/scheduler.md) for the
job lifecycle, tick route, and catch-up policy.

> **Status: Implemented (M24).** Migration `0027_m24_scheduler_service` adds these
> tables and indexes.
>
> **`run_schedules`: Implemented (M28).** Migration `0038_run_schedules` adds the
> user-facing cron schedule table fired by the seeded `run_schedule.dispatcher`
> job — see [`../system-analytics/run-schedules.md`](../system-analytics/run-schedules.md)
> and [ADR-071](../decisions.md#adr-071-user-facing-run-schedules-on-the-m24-clock).
> Cron expressions live ONLY here; `scheduler_jobs` stays fixed-interval.

```mermaid
erDiagram
    PROJECTS ||--o{ SCHEDULER_JOBS : "optional project scope"
    SCHEDULER_JOBS ||--o{ SCHEDULER_JOB_RUNS : "attempts"
    PROJECTS ||--o{ AGENT_SCHEDULES : "project agent schedules"
    SCHEDULER_JOBS ||--o| AGENT_SCHEDULES : "agent tick bridge"
    PROJECTS ||--o{ RUN_SCHEDULES : "project schedules (M28)"
    TASKS ||--o{ RUN_SCHEDULES : "target task"
    RUNS ||--o{ RUN_SCHEDULES : "last launched run (nullable)"
    PLATFORM_ACP_RUNNERS ||--o{ RUN_SCHEDULES : "optional runner override"
    USERS ||--o{ RUN_SCHEDULES : "created by (nullable)"

    SCHEDULER_JOBS {
        text id PK
        text project_id FK "nullable projects(id) ON DELETE CASCADE"
        text job_kind "system_sweep|command|agent_tick|flow_run|run_schedule"
        jsonb target "validated per job_kind"
        integer cadence_interval_seconds
        timestamp next_run_at
        timestamp last_fired_at
        timestamp lease_expires_at
        timestamp disabled_at
        integer consecutive_failures
        integer max_failures
        timestamp created_at
        timestamp updated_at
    }

    SCHEDULER_JOB_RUNS {
        text id PK
        text job_id FK "scheduler_jobs(id) ON DELETE CASCADE"
        text job_kind
        text status "Claimed|Running|Succeeded|Failed|Skipped"
        timestamp claimed_at
        timestamp started_at
        timestamp lease_expires_at
        timestamp finished_at
        jsonb summary
        text error_code
        text error_message
        timestamp created_at
        timestamp updated_at
    }

    AGENT_SCHEDULES {
        text id PK
        text project_id FK "projects(id) ON DELETE CASCADE"
        text agent_ref "typed text; no M25 FK"
        text scheduler_job_id FK "scheduler_jobs(id) ON DELETE CASCADE"
        text trigger_type "cron|manual|event|continuous"
        text desired_state "running|stopped"
        jsonb event_match
        boolean enabled
        timestamp created_at
        timestamp updated_at
    }

    RUN_SCHEDULES {
        text id PK
        text project_id FK "projects(id) ON DELETE CASCADE"
        text task_id FK "tasks(id) ON DELETE CASCADE"
        text name
        text cron_expr "5-field, croner-validated"
        text timezone "IANA, validated"
        text overlap_policy "skip|queue_one|start_anyway"
        text runner_id FK "platform_acp_runners(id) ON DELETE SET NULL"
        boolean enabled
        timestamp next_fire_at "precomputed by the cron wrapper"
        boolean queue_one_pending "non-stacking catch-up flag"
        timestamp queued_fire_at
        timestamp last_fired_at
        text last_fire_outcome "launched|queued_pending|catchup_queued|skipped_task_busy|skipped_cap|skipped_target_terminal|skipped_crashed|launch_failed|dispatching"
        text last_fire_error "CODE: message, max 500 chars"
        text last_run_id FK "runs(id) ON DELETE SET NULL"
        text created_by_user_id FK "users(id) ON DELETE SET NULL"
        timestamp created_at
        timestamp updated_at
    }
```

## Indexes

| Constraint / Index                  | Columns                      | Purpose                                |
| ----------------------------------- | ---------------------------- | -------------------------------------- |
| `scheduler_jobs_due_idx`            | `(disabled_at, next_run_at)` | Due-job scan                           |
| `scheduler_jobs_kind_due_idx`       | `(job_kind, next_run_at)`    | `jobKind` filtered ticks               |
| `scheduler_jobs_project_kind_idx`   | `(project_id, job_kind)`     | Project-scoped job read model          |
| `scheduler_job_runs_job_idx`        | `(job_id)`                   | Job attempt history                    |
| `scheduler_job_runs_lease_idx`      | `(status, lease_expires_at)` | Stuck-attempt reaper                   |
| `agent_schedules_project_agent_idx` | `(project_id, agent_ref)`    | Project agent schedule lookup          |
| `agent_schedules_scheduler_job_idx` | `(scheduler_job_id)`         | Agent schedule to scheduler job bridge |
| `run_schedules_project_idx` (M28)   | `(project_id)`               | Project schedules list                 |
| `run_schedules_task_idx` (M28)      | `(task_id)`                  | Per-task schedule lookup               |
| `run_schedules_due_idx` (M28)       | `(enabled, next_fire_at)`    | Dispatcher due-scan                    |
| `run_schedules_last_run_idx` (M28)  | `(last_run_id)`              | FK SET NULL + last-run status join     |

## Linked artifacts

- Process flows: [`../system-analytics/scheduler.md`](../system-analytics/scheduler.md).
- Global ERD: [`erd.md`](erd.md).
- Narrative: [`../database-schema.md`](../database-schema.md).
- ADR: [ADR-060](../decisions.md#adr-060-unified-scheduler-clock-and-polymorphic-job-budgets).
