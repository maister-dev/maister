import type { ResolvedCapabilitySet } from "@/lib/db/schema";
import type { JsonValue } from "@/lib/hitl-response-contract";
import type { RunnerSnapshot } from "@/lib/acp-runners/resolve";
import type { StoredDeliveryPolicy } from "@/lib/runs/delivery-policy";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";
import type { TaskExecutionChildProof } from "./qualification-types";

export const TASK_LAUNCH_STATES = [
  "queued",
  "preparing",
  "run_bound",
  "held",
  "cancelled",
  "failed",
  "settled",
] as const;
export type TaskLaunchState = (typeof TASK_LAUNCH_STATES)[number];
export type TaskLaunchBasis =
  | Readonly<{ kind: "manual"; userId: string }>
  | Readonly<{
      kind: "automatic";
      qualificationId: string;
      qualificationRevision: number;
      qualificationInputDigest: string;
      evidenceTarget: string;
      evidenceSha: string;
    }>
  | Readonly<{ kind: "execution_child"; parent: TaskExecutionChildProof }>;

export type TaskLaunchCancellationReceipt = Readonly<{
  version: 1;
  principalKind: "session_user" | "project_token" | "agent" | "system";
  principalId: string;
  actorUserId: string | null;
  requestKey: string;
  payloadDigest: string;
  expectedStateVersion: number;
  cancelledAt: string;
}>;

export type TaskLaunchInputV1Snapshot = Readonly<{
  version: 1;
  projectId: string;
  taskId: string;
  number: number;
  title: string;
  prompt: string;
  statementRevision: number | null;
  sourceVersion: string | null;
  target: string;
  deliveryTarget: string;
  clarifications: ReadonlyArray<
    Readonly<{
      id: string;
      question: string;
      status: string;
      answer: JsonValue;
      answeredAt: string | null;
      supersededAt: string | null;
    }>
  >;
}>;

export type TaskLaunchInputV2Snapshot = Omit<
  TaskLaunchInputV1Snapshot,
  "version" | "clarifications"
> &
  Readonly<{
    version: 2;
    clarifications: ReadonlyArray<
      TaskLaunchInputV1Snapshot["clarifications"][number] &
        Readonly<{ seq: number }>
    >;
  }>;
export type TaskLaunchInputSnapshot =
  TaskLaunchInputV1Snapshot | TaskLaunchInputV2Snapshot;

type TaskLaunchSettingsBase = Readonly<{
  version: 1;
  packageInstallId: string | null;
  sessions: ReadonlyArray<
    Readonly<{
      sessionName: string;
      runnerId: string;
      runnerSnapshot: Omit<RunnerSnapshot, "env" | "provider">;
      runnerConfigDigest: string;
    }>
  >;
  baseBranch: string;
  baseCommit: string | null;
  targetBranch: string;
  promotionMode: "local_merge" | "rebase_merge" | "pull_request";
  autoPromote: boolean;
  deliveryPolicy: StoredDeliveryPolicy;
  executionPolicy: ExecutionPolicy;
  taskSettingsDigest: string;
  resolutionToken: string;
}>;

type TaskLaunchTargetSettings =
  | Readonly<{
      kind: "flow";
      workspace: "worktree";
      baseCommit: string;
      flowId: string;
      flowRefId: string;
      flowRevisionId: string;
      agentId: null;
      definitionSha256: null;
    }>
  | Readonly<{
      kind: "agent";
      workspace: "none" | "repo_read" | "worktree";
      flowId: null;
      flowRefId: null;
      flowRevisionId: null;
      agentId: string;
      definitionSha256: string;
    }>;

export type TaskLaunchSettingsV1Snapshot = TaskLaunchSettingsBase &
  TaskLaunchTargetSettings;
export type TaskLaunchSettingsV2Snapshot = Omit<
  TaskLaunchSettingsBase,
  "version"
> &
  TaskLaunchTargetSettings &
  Readonly<{
    version: 2;
    resolvedCapabilitySet: ResolvedCapabilitySet | null;
    capabilityResolutionDigest: string;
  }>;
export type TaskLaunchSettingsSnapshot =
  TaskLaunchSettingsV1Snapshot | TaskLaunchSettingsV2Snapshot;

export type TaskLaunchReceipt = Readonly<{
  schemaVersion: 1;
  intentId: string;
  taskId: string;
  state: TaskLaunchState;
  stateVersion: number;
  basis: TaskLaunchBasis["kind"];
  acceptedAt: string;
  taskRevision: number;
  inputRevision: number;
  settingsDigest: string;
  runId: string | null;
  reason: string | null;
  runStatus?: string;
  queuePosition?: number;
  queueReason?: string;
  snapshot: Readonly<{
    kind: "flow" | "agent";
    workspace: "none" | "repo_read" | "worktree";
    flowId: string | null;
    flowRevisionId: string | null;
    agentId: string | null;
    runnerIds: readonly string[];
    baseCommit: string | null;
    targetBranch: string;
    promotionMode: TaskLaunchSettingsSnapshot["promotionMode"];
    autoPromote: boolean;
  }>;
  terminalOutcome?: "Done" | "Failed" | "Crashed" | "Abandoned";
}>;
