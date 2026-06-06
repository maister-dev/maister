# Scheduler domain ERD

Tables for the unified scheduler clock introduced by M24. See
[`../system-analytics/scheduler.md`](../system-analytics/scheduler.md) for the
job lifecycle, tick route, and catch-up policy.

> **Status: Implemented (M24).** Migration `0027_m24_scheduler_service` adds these
> tables and indexes.

```mermaid
erDiagram
    PROJECTS ||--o{ SCHEDULER_JOBS : "optional project scope"
    SCHEDULER_JOBS ||--o{ SCHEDULER_JOB_RUNS : "attempts"
    PROJECTS ||--o{ AGENT_SCHEDULES : "project agent schedules"
    SCHEDULER_JOBS ||--o| AGENT_SCHEDULES : "agent tick bridge"

    SCHEDULER_JOBS {
        text id PK
        text project_id FK "nullable projects(id) ON DELETE CASCADE"
        text job_kind "system_sweep|command|agent_tick|flow_run"
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

## Linked artifacts

- Process flows: [`../system-analytics/scheduler.md`](../system-analytics/scheduler.md).
- Global ERD: [`erd.md`](erd.md).
- Narrative: [`../database-schema.md`](../database-schema.md).
- ADR: [ADR-060](../decisions.md#adr-060-unified-scheduler-clock-and-polymorphic-job-budgets).
