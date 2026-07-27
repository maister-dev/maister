import type { HitlRequest, RunStatus } from "@/lib/db/schema";
import type { DomainEventKind } from "@/lib/domain-events/taxonomy";

export type ActivitySalience = "high" | "normal" | "low";

export type ActivityAction = {
  verb: string;
  object: string;
  outcome: string;
  detail?: string | null;
};

export type PulseEventKind = DomainEventKind;

export type ActivityLivenessState =
  | "working"
  | "silent"
  | "waiting_on_tool"
  | "waiting_on_human"
  | "stalled"
  | "inactive";

export type ActivityLiveness = {
  state: ActivityLivenessState;
  summary: string;
  since: Date | null;
  ageMinutes: number | null;
};

export type ActivityThresholds = {
  waitingToolAfterSeconds: number;
  silentAfterSeconds: number;
  stalledAfterSeconds: number;
};

export type ActiveActivityRunStatus = Extract<
  RunStatus,
  "Running" | "NeedsInput" | "NeedsInputIdle" | "HumanWorking"
>;

export type ActivityRunStatus = RunStatus;

export type ActivityPulseItem = {
  id: string;
  ts: Date;
  kind: PulseEventKind;
  salience: ActivitySalience;
  summary: string;
  action: ActivityAction;
  runId: string | null;
  taskId: string | null;
  taskKey: string | null;
  hitlRequestId: string | null;
  gateId: string | null;
};

export type RunActivityKind =
  | "message"
  | "reasoning"
  | "tool_call"
  | "file_change"
  | "command"
  | "test"
  | "hitl"
  | "lifecycle"
  | "generic";

export type RunActivitySourceMessage = {
  id: string;
  runId: string;
  nodeId: string | null;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  lastMutationId: bigint;
  ts: Date | null;
};

export type RunActivityItem = {
  id: string;
  lastMutationId: bigint;
  ts: Date | null;
  runId: string;
  nodeId: string | null;
  kind: RunActivityKind;
  salience: ActivitySalience;
  summary: string;
  action: ActivityAction;
};

export type NeedsYouItem = {
  runId: string;
  taskId: string | null;
  taskKey: string | null;
  taskTitle: string | null;
  hitlRequestId: string;
  kind: HitlRequest["kind"];
  title: string;
  summary: string;
  requestedAt: Date;
  criticality: "low" | "medium" | "high" | "critical" | null;
};

export type ActivityLastAction = {
  summary: string;
  at: Date | null;
  salience: ActivitySalience;
  nodeId: string | null;
  lastMutationId: bigint | null;
};

export type ActivityRunSnapshot = {
  runId: string;
  taskId: string | null;
  taskKey: string | null;
  taskTitle: string | null;
  runKind: "flow" | "scratch" | "agent";
  status: ActivityRunStatus;
  currentStepId: string | null;
  currentAttemptNumber: number | null;
  startedAt: Date | null;
  lastAction: ActivityLastAction | null;
  liveness: ActivityLiveness;
};

export type ActivityPulseResponse = {
  happened: {
    items: ActivityPulseItem[];
    nextCursor: bigint;
    hasMore: boolean;
  };
  now: {
    generatedAt: Date;
    runs: ActivityRunSnapshot[];
  };
  needsYou: {
    generatedAt: Date;
    items: NeedsYouItem[];
  };
};
