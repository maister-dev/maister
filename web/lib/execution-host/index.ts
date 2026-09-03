// ADR-164 (Designed): the execution-host module — the ONLY way domain code
// addresses the supervisor. `web/lib/supervisor-client.ts` is the local-direct
// transport and is fenced to `web/lib/execution-host/**` by ESLint.

export type {
  AdoptWorkspaceResult,
  AdoptWorkspaceWire,
  BoundAssignment,
  CheckpointResult,
  CommandReceipt,
  CreateSessionPayload,
  DeleteSessionOutcome,
  ExecutionHostTransport,
  HostHealth,
  InputDeliveryResult,
  InputPayload,
  WorkspaceRecord,
} from "./contracts";
export { UNKNOWN_OUTCOME_DETAIL } from "./contracts";
export type {
  AcpSessionId,
  AssignmentId,
  AssignmentState,
  CommandEnvelope,
  CommandFence,
  CommandId,
  CommandKind,
  CommandState,
  ExecutionHostId,
  ExecutionHostKind,
  ExecutionHostReadiness,
  ExecutionWorkspaceId,
  HostSessionId,
  PlacementReason,
  ReasonToken,
  WorkspaceKind,
  WorkspaceRule,
} from "./types";
export {
  asAcpSessionId,
  asAssignmentId,
  asCommandId,
  asExecutionWorkspaceId,
  asHostSessionId,
  COMMAND_KINDS,
  COMMAND_STATES,
  EXECUTION_WORKSPACE_ID_PATTERN,
  HOST_IDENTITY_MISMATCH_REASON,
  HOST_KEY_PATTERN,
  PLACEMENT_REASONS,
  REASON_TOKENS,
} from "./types";
export type {
  BoundClient,
  CreateSessionOptions,
  ExecutionHosts,
  ExecutionHostsDeps,
  HostAdminClient,
  PreparedInput,
} from "./client";
export { createExecutionHosts, executionHosts } from "./client";
export { getPlatformDiagnostics, getPlatformStatus } from "./platform-status";
export type { PromptHandle } from "./deliverer";
export { COMMAND_POLICY, isFencedError, isUnknownOutcome } from "./deliverer";
export { buildEnvelope, fencedLocallyError } from "./ledger";
export {
  getActiveAssignment,
  getAssignmentById,
  getLatestAssignment,
  isAdmissible,
  mintAssignment,
  releaseAssignmentForRun,
} from "./assignments";
export { ensureAssignment, mintPlacement } from "./placement";
export type { LegacyBackfillOptions, LegacyBackfillSummary } from "./legacy";
export {
  adoptLegacyActiveRuns,
  resetLegacyBackfillStateForTests,
} from "./legacy";
export {
  decideRegistration,
  ensureLocalExecutionHost,
  REGISTRATION_POLICY,
} from "./registrar";
export type {
  RegistrationAction,
  RegistrationObservation,
  RegistrationResult,
} from "./registrar";
export { hostForAssignment, localHost } from "./resolver";
export {
  defaultTransport,
  setDefaultTransportForTests,
} from "./default-transport";
export {
  ensureWorkspaceAdopted,
  isUnknownWorkspaceError,
  loadWorkspaceSpecInput,
  workspaceSpecFor,
} from "./adoption";
export type { WorkspaceSpecInput } from "./adoption";
export {
  executionCommandReconcilePass,
  pruneExecutionCommands,
  recoverExecutionCommands,
  releaseStaleAssignments,
} from "./recovery";
export type {
  ExecutionCommandRecoverySummary,
  ExecutionHostSweepSummary,
} from "./recovery";
export { commandSignals } from "./signals";
export { listCommandsForRun } from "./commands";
export { findActiveLocalHost, LIVE_DRIVER_RUN_STATUSES } from "./hosts";

// Wire DTO types domain code may name (the transport module itself stays
// fenced to this package).
export type {
  CreateSessionInput,
  CreateSessionResult,
  ExecutionHostIdentity,
  PromptContentBlock,
  PromptResult,
  PromptStopReason,
  SendPromptInput,
  SidecarInstanceConfig,
  SidecarState,
  SidecarStateResponse,
  SupervisorAdapterLaunchInput,
  SupervisorDiagnostics,
  SupervisorDiagnosticsStatus,
  SupervisorEvent,
  SupervisorExecutorInput,
  SupervisorMcpProbeRequest,
  SupervisorMcpProbeResult,
  SupervisorModelCatalog,
  SupervisorModelCatalogDraft,
  SupervisorPermissionOption,
  SupervisorRunnerInput,
  SupervisorSessionRecord,
} from "@/lib/supervisor-client";
export type { PlatformStatus } from "@/types/platform-status";
