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

export type SchedulerClockDriver =
  | "fallback_timer"
  | "external_tick"
  | "missing_tick";

export type SchedulerClockStatus = {
  cronTokenConfigured: boolean;
  driver: SchedulerClockDriver;
  fallbackTimerEnabled: boolean;
  tickIntervalSeconds: number;
  tickPath: "/api/cron/tick";
};

export type BrainIndexJobReason =
  | "model_switch"
  | "manual"
  | "event"
  | "chunker_upgrade";

export type BrainIndexJobStatus = "queued" | "running" | "completed" | "failed";

export type BrainIndexQueueSummary = {
  completed: number;
  failed: number;
  queued: number;
  running: number;
  total: number;
};

export type BrainIndexQueueShape<TDate> = {
  createdAt: TDate;
  id: string;
  progress: number;
  projectId: string;
  projectName: string;
  projectSlug: string;
  reason: BrainIndexJobReason;
  resumableCursor: Record<string, unknown> | null;
  sourceId: string | null;
  sourceLastError: Record<string, unknown> | null;
  sourceLastIndexedAt: TDate | null;
  sourcePath: string | null;
  status: BrainIndexJobStatus;
};

export type BrainIndexQueueDataRow = BrainIndexQueueShape<Date>;

export type BrainIndexQueueViewRow = BrainIndexQueueShape<string>;

export type BrainIndexQueueData = {
  rows: BrainIndexQueueDataRow[];
  schemaApplied: boolean;
  summary: BrainIndexQueueSummary;
};

export type BrainIndexQueueViewData = {
  rows: BrainIndexQueueViewRow[];
  schemaApplied: boolean;
  summary: BrainIndexQueueSummary;
};
