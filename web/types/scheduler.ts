import type {
  RunScheduleFireOutcome,
  RunScheduleOverlapPolicy,
  RunStatus,
} from "@/lib/db/schema";

export type SchedulerRunScheduleOverviewShape<TDate> = {
  scheduleId: string;
  scheduleName: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  taskId: string;
  taskNumber: number;
  taskTitle: string;
  taskStatus: "Backlog" | "InFlight" | "Done" | "Abandoned";
  cronExpr: string;
  timezone: string;
  overlapPolicy: RunScheduleOverlapPolicy;
  runnerId: string | null;
  enabled: boolean;
  nextFireAt: TDate;
  queueOnePending: boolean;
  queuedFireAt: TDate | null;
  lastFiredAt: TDate | null;
  lastFireOutcome: RunScheduleFireOutcome | null;
  lastFireError: string | null;
  lastRunId: string | null;
  lastRunStatus: RunStatus | null;
};

export type SchedulerRunScheduleOverviewDataRow =
  SchedulerRunScheduleOverviewShape<Date>;

export type SchedulerRunScheduleOverviewViewRow =
  SchedulerRunScheduleOverviewShape<string>;
