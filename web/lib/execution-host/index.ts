// ADR-166 (Implemented): the execution-host module — the ONLY way domain code
// addresses the supervisor. `web/lib/supervisor-client.ts` is the local-direct
// transport and is fenced to `web/lib/execution-host/**` by ESLint.

export type {
  AdoptWorkspaceResult,
  AdoptWorkspaceWire,
  CheckpointResult,
  CommandCallOptions,
  CommandReceipt,
  CreateSessionPayload,
  DeleteSessionOutcome,
  ExecutionHostTransport,
  HostHealth,
  InputDeliveryResult,
  RuntimeObjectMetadata,
  RuntimeObjectOutputBinding,
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
  BindRunOptions,
  BoundClient,
  CreateSessionOptions,
  ExecutionBinding,
  ExecutionHosts,
  ExecutionHostsDeps,
  HostAdminClient,
  PreparedInput,
} from "./client";
export { createExecutionHosts, executionHosts } from "./client";
export { getPlatformDiagnostics, getPlatformStatus } from "./platform-status";
export type { PromptHandle, PromptQueryResult } from "./deliverer";
export {
  COMMAND_POLICY,
  isFencedError,
  isUnknownOutcome,
  queryPrompt,
} from "./deliverer";
export { rearmPromptAdmission } from "./commands";
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
export {
  executionDataPlaneModeForHost,
  selectExecutionDataPlaneMode,
} from "./data-plane-capabilities";
export type { ExecutionDataPlaneMode } from "./data-plane-capabilities";
export type { LegacyRunsOptions, LegacyRunsSummary } from "./legacy";
export {
  reportLegacyActiveRuns,
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
export { ensureLocalExecutionDataPlane } from "./event-plane";
export { hostForAssignment, localHost } from "./resolver";
export {
  defaultTransport,
  setDefaultTransportForTests,
} from "./default-transport";
export {
  ensureWorkspaceAdopted,
  isReadoptableWorkspaceError,
  isUnknownWorkspaceError,
  loadWorkspaceSpecInput,
  workspaceSpecFor,
} from "./adoption";
export type { WorkspaceSpecInput } from "./adoption";
export {
  executionCommandReconcilePass,
  recoverExecutionCommands,
  releaseStaleAssignments,
} from "./recovery";
export type {
  CommandProtectedReason,
  CommandRetirementSummary,
} from "./retirement";
export {
  classifyCommandRetirement,
  reportUnreconciledCommands,
  retireEligibleCommands,
} from "./retirement";
export type {
  ExecutionCommandRecoverySummary,
  ExecutionHostSweepSummary,
} from "./recovery";
export { commandSignals } from "./signals";
export {
  createPromptOwnerRegistry,
  definePromptOwnerAdapter,
  PromptOwnerInvariantError,
} from "./prompt-owners";
export type {
  PreparedPromptOwner,
  PromptOwnerAdapter,
  PromptOwnerDisposition,
  PromptOwnerOutcome,
  PromptOwnerRegistry,
} from "./prompt-owners";
export { startPromptOwnerWorker } from "./prompt-owner-recovery";
export type { PromptOwnerWorker } from "./prompt-owner-recovery";
export {
  claimRuntimeEventStream,
  consumeRuntimeEventStreamOnce,
  recordConfirmedRuntimeEventAck,
  resetRuntimeEventConsumersForTests,
  startRuntimeEventConsumer,
} from "./events/consumer";
export type {
  RuntimeEventConsumerSummary,
  RuntimeEventStreamClaim,
} from "./events/consumer";
export { ingestRuntimeEvent } from "./events/ingest";
export type {
  RuntimeEventIngestDisposition,
  RuntimeEventIngestResult,
} from "./events/ingest";
export {
  ExecutionEventProjectionError,
  projectExecutionEvents,
} from "./events/projector";
export type {
  ExecutionEventProjector,
  ExecutionEventProjectorSummary,
} from "./events/projector";
export {
  projectCanonicalPromptCommands,
  projectPendingCanonicalPromptCommands,
} from "./events/prompt-projector";
export {
  projectCanonicalSessionLifecycle,
  projectPendingCanonicalSessionLifecycle,
} from "./events/lifecycle-projector";
export {
  projectCanonicalRuntimeObjects,
  projectPendingCanonicalRuntimeObjects,
} from "./events/runtime-object-projector";
export {
  RUNTIME_OBJECT_RETENTION_INTERVAL_MS,
  startRuntimeObjectRetentionTimer,
  stopRuntimeObjectRetentionTimer,
  sweepExpiredRuntimeObjects,
} from "./runtime-object-retention";
export type { RuntimeObjectRetentionSummary } from "./runtime-object-retention";
export {
  deterministicRuntimeObjectId,
  deterministicRuntimeOutputObjectId,
  openRuntimeObjectContent,
  publishRuntimeObject,
  readRuntimeObjectContent,
} from "./runtime-objects";
export { publishCapabilityBundle } from "./capability-profile";
export type { PublishedCapabilityBundle } from "./capability-profile";
export {
  DRIVER_OWNED_RUN_STATUSES,
  findActiveLocalHost,
  LIVE_DRIVER_RUN_STATUSES,
  STALE_ASSIGNMENT_RUN_STATUSES,
} from "./hosts";

// Wire DTO types domain code may name (the transport module itself stays
// fenced to this package).
export type {
  CreateSessionInput,
  CreateSessionResult,
  ExecutionHostIdentity,
  PromptContentBlock,
  PromptResult,
  PromptAccepted,
  PromptStopReason,
  SendPromptInput,
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
