import type { TaskLaunchFlowAssetsSnapshot } from "./launch-flow-assets";
import type { TaskAgentLaunchSnapshot } from "./launch-agent-resolution";
import type { TaskLaunchServerSourceSnapshot } from "./launch-server-source";
import type { TaskLaunchRelaunchSource } from "./launch-continuation";
import type { ResolvedCapabilitySet } from "@/lib/db/schema";
import type { JsonValue } from "@/lib/hitl-response-contract";
import type {
  RunnerResolutionTier,
  RunnerSnapshot,
} from "@/lib/acp-runners/resolve";
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
export type TaskLaunchTokenOrigin = Readonly<{
  version: 1;
  kind: "token";
  tokenId: string;
  tokenKind: "project" | "user" | "agent" | "librarian";
  projectId: string | null;
  ownerUserId: string | null;
  agentId: string | null;
  boundRunId: string | null;
  librarianTurnId: string | null;
}>;
export type TaskLaunchBasis =
  | Readonly<{ kind: "manual"; userId: string }>
  | Readonly<{
      kind: "automatic";
      qualificationId: string;
      qualificationRevision: number;
      qualificationInputDigest: string;
      evidenceTarget: string;
      evidenceSha: string;
      origin?: TaskLaunchTokenOrigin;
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

/** Allocated before Git; the same accepted request always recovers this identity. */
export type TaskLaunchFlowPreparationIdentity = Readonly<{
  version: 1;
  runId: string;
  taskAttemptNumber: number;
  branch: string;
  parentRepoPath: string;
  worktreePath: string;
  resourceId: string;
  incarnationId: string;
  baseCommit: string;
  inputDigest: string;
  settingsDigest: string;
}>;

export type TaskLaunchAgentPreparationIdentity = Readonly<{
  version: 2;
  kind: "agent";
  workspace: "none" | "repo_read" | "worktree";
  runId: string;
  taskAttemptNumber: number;
  parentRepoPath: string | null;
  worktreePath: string;
  runtimePath: string;
  branch: string | null;
  baseCommit: string | null;
  resourceId: string;
  incarnationId: string;
  inputDigest: string;
  settingsDigest: string;
}>;
export type TaskLaunchPreparationIdentity =
  TaskLaunchFlowPreparationIdentity | TaskLaunchAgentPreparationIdentity;

export type TaskLaunchDispatchReceipt = Readonly<{
  version: 1;
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
  inputDigest: string;
  settingsDigest: string;
  committedAt: string;
  preparation?: Readonly<{
    id: string;
    resourceId: string;
    incarnation: string;
    generation: number;
    baselineDigest: string;
    materializationDigest: string;
  }>;
}>;

export const TASK_LAUNCH_PREPARATION_PHASES = [
  "reserved",
  "checkout_ready",
  "materializing",
  "materialized",
  "run_bound",
] as const;
export type TaskLaunchPreparationPhase =
  (typeof TASK_LAUNCH_PREPARATION_PHASES)[number];

type TaskLaunchSettingsBase = Readonly<{
  version: 1;
  packageInstallId: string | null;
  sessions: ReadonlyArray<
    Readonly<{
      sessionName: string;
      runnerId: string;
      runnerSnapshot: Omit<RunnerSnapshot, "env" | "provider">;
      runnerConfigDigest: string;
      runnerResolutionTier?: RunnerResolutionTier;
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
    acceptedTaskStatus?: "Backlog" | "InFlight" | "Done" | "Abandoned";
    relaunchSource?: TaskLaunchRelaunchSource | null;
    serverExecution?: TaskLaunchServerSourceSnapshot;
    agentSnapshot?: TaskAgentLaunchSnapshot;
    flowAssets?: TaskLaunchFlowAssetsSnapshot;
    resolvedCapabilitySet: ResolvedCapabilitySet | null;
    capabilityResolutionDigest: string;
    brainContext?: boolean | null;
    packageVersions?: Readonly<Record<string, "keep" | "try_once">>;
    capabilityBundles?: ReadonlyArray<
      Readonly<{
        id: string;
        revision: string;
        manifestDigest: string;
        contentDigest: string;
      }>
    >;
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
  supersedesIntentId?: string;
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
    sessions?: ReadonlyArray<
      Readonly<{
        sessionName: string;
        runnerId: string;
        capabilityAgent: string;
        model: string;
      }>
    >;
    flowRefId?: string | null;
    deliveryPolicy?: StoredDeliveryPolicy;
    baseCommit: string | null;
    targetBranch: string;
    promotionMode: TaskLaunchSettingsSnapshot["promotionMode"];
    autoPromote: boolean;
  }>;
  terminalOutcome?: "Done" | "Failed" | "Crashed" | "Abandoned";
}>;
