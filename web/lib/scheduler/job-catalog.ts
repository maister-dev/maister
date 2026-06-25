import type { SchedulerJobKind } from "@/lib/db/schema";

export const ALL_SCHEDULER_JOB_KINDS = [
  "system_sweep",
  "command",
  "agent_tick",
  "flow_run",
  "run_schedule",
  "webhook_delivery",
  "domain_event_dispatch",
  "auto_launch_triaged",
] as const satisfies readonly SchedulerJobKind[];

export const CREATABLE_SCHEDULER_JOB_KINDS = [
  "system_sweep",
  "command",
  "flow_run",
  "webhook_delivery",
] as const satisfies readonly SchedulerJobKind[];

export const FILTERABLE_SCHEDULER_JOB_KINDS = ALL_SCHEDULER_JOB_KINDS;

export type SchedulerJobKindCatalogEntry = {
  creatable: boolean;
  filterable: boolean;
  systemManaged: boolean;
};

export const SCHEDULER_JOB_KIND_CATALOG: Record<
  SchedulerJobKind,
  SchedulerJobKindCatalogEntry
> = {
  system_sweep: {
    creatable: true,
    filterable: true,
    systemManaged: false,
  },
  command: {
    creatable: true,
    filterable: true,
    systemManaged: false,
  },
  agent_tick: {
    creatable: false,
    filterable: true,
    systemManaged: true,
  },
  flow_run: {
    creatable: true,
    filterable: true,
    systemManaged: false,
  },
  run_schedule: {
    creatable: false,
    filterable: true,
    systemManaged: true,
  },
  webhook_delivery: {
    creatable: true,
    filterable: true,
    systemManaged: false,
  },
  domain_event_dispatch: {
    creatable: false,
    filterable: true,
    systemManaged: true,
  },
  auto_launch_triaged: {
    creatable: false,
    filterable: true,
    systemManaged: true,
  },
};

const SEEDED_SINGLETON_IDS: Partial<Record<SchedulerJobKind, string>> = {
  agent_tick: "agent_tick.dispatcher",
  auto_launch_triaged: "auto_launch_triaged.default",
  domain_event_dispatch: "domain_event_dispatch.default",
  run_schedule: "run_schedule.dispatcher",
  system_sweep: "system_sweep.default",
  webhook_delivery: "webhook_delivery.default",
};

export function isCreatableSchedulerJobKind(
  jobKind: SchedulerJobKind,
): boolean {
  return SCHEDULER_JOB_KIND_CATALOG[jobKind].creatable;
}

export function isSystemManagedSchedulerJobKind(
  jobKind: SchedulerJobKind,
): boolean {
  return SCHEDULER_JOB_KIND_CATALOG[jobKind].systemManaged;
}

export function isSeededSingletonSchedulerJob(job: {
  id: string;
  jobKind: SchedulerJobKind;
}): boolean {
  return SEEDED_SINGLETON_IDS[job.jobKind] === job.id;
}
