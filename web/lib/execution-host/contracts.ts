import type {
  CreateSessionInput,
  CreateSessionResult,
  ExecutionHostIdentity,
  PromptResult,
  PromptAccepted,
  SendPromptInput,
  SupervisorDiagnosticsStatus,
  SupervisorEvent,
  SupervisorMcpProbeRequest,
  SupervisorMcpProbeResult,
  SupervisorModelCatalog,
  SupervisorModelCatalogDraft,
  SupervisorSessionRecord,
} from "@/lib/supervisor-client";
import type { PlatformStatus } from "@/types/platform-status";
import type { ContextMountSnapshot } from "@/lib/context-mounts/types";
import type {
  CommandEnvelope,
  CommandKind,
  ExecutionWorkspaceId,
  WorkspaceKind,
} from "./types";
import type { RuntimeEventEnvelope } from "./runtime-events";

// ADR-166 D10: the typed boundary domain code addresses execution through.
// `ExecutionHostTransport` is the replaceable wire (local-direct today); the
// deliverer depends on this interface and the ledger only — neither knows the
// other (DIP).

export type HostHealth =
  | {
      kind: "ready";
      identity: ExecutionHostIdentity | null;
      version: string;
      sessions: { live: number; exited: number; crashed: number };
    }
  | { kind: "unavailable"; reason: string; message: string };

export type ExecutionHostDataPlaneCapabilities = {
  dataPlaneVersion: "execution-host-data-plane.v1";
  eventStream: boolean;
  asyncPrompt: boolean;
  runtimeObjects: boolean;
  limits: {
    maxEventBytes: 1_048_576;
    maxObjectBytes: 536_870_912;
    maxReplayBatch: 500;
  };
};

export type AdoptWorkspaceWire = {
  runId: string;
  projectSlug: string;
  kind: WorkspaceKind;
  path: string;
  repoPath?: string;
  contextMounts?: ContextMountSnapshot[];
};

export type AdoptWorkspaceResult = {
  executionWorkspaceId: ExecutionWorkspaceId;
  kind: WorkspaceKind;
  replayed: boolean;
};

export type WorkspaceRecord = {
  executionWorkspaceId: ExecutionWorkspaceId;
  runId: string;
  projectSlug: string;
  kind: WorkspaceKind;
  adoptedAt: string;
  releasedAt: string | null;
};

export type CommandReceipt = {
  commandId: string;
  runId: string;
  kind: CommandKind;
  assignmentEpoch: number;
  phase: "accepted" | "completed" | "rejected";
  httpStatus: number;
  body: Record<string, unknown>;
  receivedAt: string;
  completedAt: string | null;
  eventId: string | null;
  // `accepted` + `inflight:false` = the host restarted mid-turn (turn_lost).
  inflight: boolean;
};

export type DeleteSessionOutcome = "terminated" | "gone";

// The `POST /sessions` payload: every path the host needs is derived from the
// adopted handle (server state), never carried on the wire.
export type CreateSessionPayload = CreateSessionInput & {
  executionWorkspaceId: ExecutionWorkspaceId;
};

export type InputPayload = {
  kind: "permission";
  action: "select" | "cancel";
  requestId: string;
  optionId?: string;
  reason?: string;
};

// `replayed` = the host answered from its receipt (the same command id was
// re-sent after an unknown outcome): the delivery happened on an earlier
// attempt.
export type InputDeliveryResult = { ok: true; replayed: boolean };

export type CheckpointResult = {
  alreadyCheckpointed: boolean;
  sessionId: string;
  monotonicId: number;
};

export type RuntimeEventAckResult = {
  streamId: string;
  acknowledgedThrough: string;
};

export type EmptyPayload = Record<string, never>;

// Per-call transport timeout, chosen by the caller from the per-kind policy
// table (ADR-166 D5); `null` = no timeout (the long-lived prompt).
export type CommandCallOptions = { timeoutMs?: number | null };

export interface ExecutionHostTransport {
  health(opts?: { timeoutMs?: number }): Promise<HostHealth>;
  // Null means an older supervisor returned the sole bounded compatibility
  // signal (404); malformed documents are a typed wire failure, never legacy.
  capabilities(
    opts?: { timeoutMs?: number },
  ): Promise<ExecutionHostDataPlaneCapabilities | null>;
  // The host's adapter diagnostics (smoke evidence) — a read-only admin
  // surface like `health`, never fenced.
  diagnostics(opts?: {
    timeoutMs?: number;
  }): Promise<SupervisorDiagnosticsStatus>;
  // The chrome's platform status (the `/health` body in its UI shape).
  platformStatus(opts?: { timeoutMs?: number }): Promise<PlatformStatus>;
  // Host-scoped admin operations (ADR-166 T4.6): the model catalog and MCP
  // probes — read/act on the host, never fenced.
  resolveModelSuggestions(
    draft: SupervisorModelCatalogDraft,
    opts?: { force?: boolean },
  ): Promise<SupervisorModelCatalog>;
  probeMcp(req: SupervisorMcpProbeRequest): Promise<SupervisorMcpProbeResult>;
  listSessions(): Promise<SupervisorSessionRecord[]>;
  streamSession(
    sessionId: string,
    opts?: { lastEventId?: number; signal?: AbortSignal },
  ): AsyncGenerator<SupervisorEvent, void, void>;
  streamRuntimeEvents(
    opts?: { afterSequence?: string; signal?: AbortSignal },
  ): AsyncGenerator<RuntimeEventEnvelope, void, void>;
  acknowledgeRuntimeEvents(input: {
    streamId: string;
    throughSequence: string;
  }): Promise<RuntimeEventAckResult>;
  getCommandReceipt(commandId: string): Promise<CommandReceipt | null>;
  getWorkspace(executionWorkspaceId: string): Promise<WorkspaceRecord | null>;
  adoptWorkspace(
    envelope: CommandEnvelope<AdoptWorkspaceWire>,
    opts?: CommandCallOptions,
  ): Promise<AdoptWorkspaceResult>;
  releaseWorkspace(
    executionWorkspaceId: string,
    envelope: CommandEnvelope<EmptyPayload>,
    opts?: CommandCallOptions,
  ): Promise<{ released: boolean }>;
  createSession(
    envelope: CommandEnvelope<CreateSessionPayload>,
    opts?: CommandCallOptions,
  ): Promise<CreateSessionResult>;
  sendPrompt(
    sessionId: string,
    envelope: CommandEnvelope<SendPromptInput>,
    opts?: CommandCallOptions & { signal?: AbortSignal },
  ): Promise<PromptResult>;
  startPrompt(
    sessionId: string,
    envelope: CommandEnvelope<SendPromptInput>,
    opts?: CommandCallOptions,
  ): Promise<PromptAccepted>;
  deliverInput(
    sessionId: string,
    envelope: CommandEnvelope<InputPayload>,
    opts?: CommandCallOptions,
  ): Promise<InputDeliveryResult>;
  cancelPrompt(
    sessionId: string,
    envelope: CommandEnvelope<EmptyPayload>,
    opts?: CommandCallOptions,
  ): Promise<{ cancelled: boolean }>;
  checkpointSession(
    sessionId: string,
    envelope: CommandEnvelope<EmptyPayload>,
    opts?: CommandCallOptions,
  ): Promise<CheckpointResult>;
  deleteSession(
    sessionId: string,
    envelope: CommandEnvelope<EmptyPayload>,
    opts?: CommandCallOptions,
  ): Promise<{ outcome: DeleteSessionOutcome }>;
}

// A transport failure whose outcome on the host is UNKNOWN (network error,
// timeout, non-JSON 5xx). The deliverer retries the SAME command id up to the
// kind's budget; every other failure is definitive.
export const UNKNOWN_OUTCOME_DETAIL = "unknown_outcome" as const;
