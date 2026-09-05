import type { StoredDeliveryPolicy } from "@/lib/runs/delivery-policy";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

export const SCHEDULED_LAUNCH_STATES = [
  "Scheduled",
  "Dispatching",
  "RetryWaiting",
  "Launched",
  "Failed",
  "Cancelled",
] as const;

export type ScheduledLaunchState = (typeof SCHEDULED_LAUNCH_STATES)[number];

export const SCHEDULED_LAUNCH_OUTCOMES = [
  "created",
  "rearmed",
  "claimed",
  "retry_scheduled",
  "cancelled",
  "launched",
  "failed",
] as const;

export type ScheduledLaunchOutcome = (typeof SCHEDULED_LAUNCH_OUTCOMES)[number];

export type ScheduledLaunchDisambiguation = "earlier" | "later";

export type ScheduledLaunchRequest = {
  flowId?: string;
  runnerId?: string;
  baseBranch?: string;
  baseCommit?: string;
  targetBranch?: string;
  deliveryPolicy?: StoredDeliveryPolicy;
  executionPolicy?: ExecutionPolicy;
  packageVersions?: Record<
    string,
    "keep" | "adopt" | "cut_and_adopt" | "try_once"
  >;
  brainContext?: boolean | null;
  autoPromote?: boolean;
};

export type ScheduledLaunchAttemptState =
  | "Reserved"
  | "Materialized"
  | "RunLinked"
  | "Cleaned"
  | "Failed";

export type ScheduledLaunchEventKind =
  | "created"
  | "edited_rearmed"
  | "claimed"
  | "retry_scheduled"
  | "cancelled"
  | "launched"
  | "failed";

export type ScheduledLaunchEventActorType = "user" | "system";

export type ScheduledLaunchReservation = {
  id: string;
  scheduledLaunchId: string;
  runId: string;
  taskId: string;
  taskAttemptNumber: number;
  branch: string;
  worktreePath: string;
  requestHash: string;
  claimFence: number;
};
