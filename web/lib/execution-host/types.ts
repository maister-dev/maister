// Execution-host contract vocabulary (ADR-166). Pure constants + branded ids:
// no node:* imports, no DB, no env — `lib/db/schema.ts` aliases these arrays
// for its CHECK constraints, so the wire, the ledger, and the schema can never
// drift apart by hand-mirroring.

export const EXECUTION_HOST_KINDS = ["local_direct"] as const;
export type ExecutionHostKind = (typeof EXECUTION_HOST_KINDS)[number];

export const EXECUTION_HOST_READINESS = [
  "unknown",
  "ready",
  "unavailable",
] as const;
export type ExecutionHostReadiness = (typeof EXECUTION_HOST_READINESS)[number];

export const ASSIGNMENT_STATES = ["active", "superseded", "released"] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

export const PLACEMENT_REASONS = [
  "launch",
  "resume",
  "recover",
  "wait_resume",
  "rework_return",
  "gate_chat",
  "sync_resolver",
  "scratch_recover",
  "node_interrupt",
  "legacy_backfill",
] as const;
export type PlacementReason = (typeof PLACEMENT_REASONS)[number];

export const COMMAND_KINDS = [
  "workspace.adopt",
  "workspace.release",
  "session.create",
  "session.prompt",
  "session.input",
  "session.cancel",
  "session.checkpoint",
  "session.delete",
  "runtime_object.reserve",
  "runtime_object.upload",
  "runtime_object.delete",
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export const RUNTIME_OBJECT_KINDS = [
  "session_log",
  "raw_transcript",
  "cost_diagnostic",
  "checkpoint",
  "attachment",
  "capability_profile",
  "agent_memory_snapshot",
  "node_result",
  "evidence",
  "generated_artifact",
  "plan_review",
  "diagnostic",
] as const;
export type RuntimeObjectKind = (typeof RUNTIME_OBJECT_KINDS)[number];

export const RUNTIME_OBJECT_RETENTION_CLASSES = [
  "run",
  "delivery",
  "ephemeral",
] as const;
export type RuntimeObjectRetentionClass =
  (typeof RUNTIME_OBJECT_RETENTION_CLASSES)[number];

export const RUNTIME_OBJECT_STATES = [
  "pending",
  "available",
  "deleting",
  "missing",
  "deleted",
  "expired",
  "corrupt",
] as const;
export type RuntimeObjectState = (typeof RUNTIME_OBJECT_STATES)[number];

export type RuntimeObjectLocator = {
  kind: "execution-object";
  objectId: string;
};

export const COMMAND_STATES = [
  "queued",
  "delivering",
  "accepted",
  "succeeded",
  "failed",
  "fenced",
] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

export const TERMINAL_COMMAND_STATES = [
  "succeeded",
  "failed",
  "fenced",
] as const satisfies readonly CommandState[];

export const OPEN_COMMAND_STATES = [
  "queued",
  "delivering",
  "accepted",
] as const satisfies readonly CommandState[];

export const WORKSPACE_KINDS = [
  "git_worktree",
  "repo_checkout",
  "directory",
] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const REASON_TOKENS = [
  "host_mismatch",
  "assignment_mismatch",
  "run_mismatch",
  "assignment_fenced",
  "turn_lost",
  "unknown_workspace",
  "workspace_released",
  "workspace_rejected",
  "legacy_field",
  "missing_envelope",
] as const;
export type ReasonToken = (typeof REASON_TOKENS)[number];

export const WORKSPACE_RULES = [
  "relative_path",
  "parent_segment",
  "not_found",
  "outside_roots",
  "symlink_escape",
  "gitdir_mismatch",
  "not_a_repo",
  "repo_path_mismatch",
  "inside_state_dir",
  "outside_workspace",
] as const;
export type WorkspaceRule = (typeof WORKSPACE_RULES)[number];

// Web-minted reason (never on the wire): the registrar refused a host whose
// identity changed while the old row still owns non-terminal runs.
export const HOST_IDENTITY_MISMATCH_REASON = "host_identity_mismatch" as const;

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

// The supervisor's own session id (URL key of every /sessions/:id route) —
// distinct from the adapter's ACP session id, which is the resume handle.
// Branding them apart is what closes the hitl.ts:3545 class of bug.
export type HostSessionId = Brand<string, "HostSessionId">;
export type AcpSessionId = Brand<string, "AcpSessionId">;
export type ExecutionWorkspaceId = Brand<string, "ExecutionWorkspaceId">;
export type AssignmentId = Brand<string, "AssignmentId">;
export type CommandId = Brand<string, "CommandId">;
export type ExecutionHostId = Brand<string, "ExecutionHostId">;

export const EXECUTION_WORKSPACE_ID_PATTERN = /^ws_[0-9a-f]{32}$/;
export const HOST_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function asHostSessionId(value: string): HostSessionId {
  return value as HostSessionId;
}

export function asAcpSessionId(value: string): AcpSessionId {
  return value as AcpSessionId;
}

export function asExecutionWorkspaceId(value: string): ExecutionWorkspaceId {
  return value as ExecutionWorkspaceId;
}

export function asAssignmentId(value: string): AssignmentId {
  return value as AssignmentId;
}

export function asCommandId(value: string): CommandId {
  return value as CommandId;
}

export type CommandFence = {
  hostKey: string;
  assignmentId: AssignmentId;
  assignmentEpoch: number;
  runId: string;
};

export type CommandEnvelope<TPayload = Record<string, unknown>> = {
  command: { id: CommandId; kind: CommandKind; issuedAt: string };
  fence: CommandFence;
  payload: TPayload;
};

// Retention for terminal `execution_commands` rows and host receipts (D5/D6).
export const EXECUTION_COMMAND_RETENTION_DAYS = 7;

// A `delivering` row younger than this is treated as in-flight by recovery.
export const DELIVERING_IN_FLIGHT_GRACE_MS = 60_000;
