import { createHash } from "node:crypto";

import { canonicalCommandJson } from "./command-json";
import { EXECUTION_HOST_KEY_PATTERN } from "./execution-host-address";
import { branchNameViolation } from "./git-branch";

export type WorkspacePrepareInput =
  | Readonly<{
      mode: "ownWorktree" | "readOnlyCheckout";
      repositoryId: string;
      commit: string;
      inputDigest: string;
    }>
  | Readonly<{
      mode: "sharedWorktree";
      parentHandle: string;
      parentGeneration: number;
      inputDigest: string;
    }>
  | Readonly<{
      mode: "directory";
      directoryProfileId: string;
      inputDigest: string;
    }>
  | Readonly<{ mode: "emptyDirectory"; inputDigest: string }>;

export type WorkspaceAssignmentOwner = Readonly<{
  kind: "assignment";
  hostKey: string;
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
}>;

export type WorkspacePrepareRequest = Readonly<{
  workspaceProtocol: 1;
  command: Readonly<{
    id: string;
    kind: "workspace.prepare";
    issuedAt: string;
  }>;
  owner: WorkspaceAssignmentOwner;
  payload: WorkspacePrepareInput;
}>;

export type WorkspaceInputObject = Readonly<{
  objectId: string;
  sha256: string;
}>;
export type WorkspaceDiffQuery = Readonly<{
  generation: number;
  base?: string;
  head?: string;
  checkpointId?: string;
  format?: "review";
}>;
export type WorkspaceGitReviewFile = Readonly<{
  path: string;
  oldPath?: string;
  status: "A" | "C" | "D" | "M" | "R" | "T";
  additions: number;
  deletions: number;
  binary: boolean;
}>;
export type WorkspaceGitReview = Readonly<{
  baseCommit: string;
  worktreeTree: string;
  patch: string;
  files: WorkspaceGitReviewFile[];
}>;
export type WorkspaceReviewFingerprint = Readonly<{
  generation: number;
  baseCommit: string;
  sha256: string;
}>;
export const WORKSPACE_REVIEW_OBJECT_NAME = "workspace-review.json";
export const WORKSPACE_REVIEW_MAX_BYTES = 64 * 1024;
export type WorkspaceLogQuery = Readonly<{
  generation: number;
  cursor?: string;
  limit?: number;
  base?: string;
  head?: string;
}>;
export type WorkspaceLogPage = Readonly<{
  head: string;
  commits: readonly Readonly<{ commit: string; committedAt: string; subject: string }>[];
  nextCursor: string | null;
}>;
export const WORKSPACE_LOG_OBJECT_NAME = "workspace-log.json";
export const WORKSPACE_COMMIT_SET_OBJECT_NAME = "workspace-commit-set.txt";
export const WORKSPACE_LOG_MAX_BYTES = 64 * 1024;
export const WORKSPACE_LOG_MAX_PAGE_SIZE = 100;
export const WORKSPACE_TEMPLATE_CONTEXT_NAME = "workload-template-context.json";
export const WORKSPACE_TEMPLATE_CONTEXT_MAX_BYTES = 128 * 1024;
export type WorkspaceEvidenceObject = Readonly<{
  generation: number;
  object: WorkspaceInputObject;
  baseCommit?: string;
  headCommit?: string;
}>;
export const WORKSPACE_GIT_CHECKPOINT_PREFIX = "host-checkpoint:";
export type WorkspaceMaterializeRequest = Readonly<{
  workspaceProtocol: 1;
  command: Readonly<{
    id: string;
    kind: "workspace.materialize";
    issuedAt: string;
  }>;
  owner: WorkspaceAssignmentOwner;
  payload: Readonly<{
    generation: number;
    manifestDigest: string;
    objects: readonly WorkspaceInputObject[];
  }>;
}>;

export type MaterializedWorkspaceInputs = Readonly<{
  generation: number;
  inputGeneration: number;
  manifestDigest: string;
}>;

export const WORKSPACE_WORKLOAD_FILE = "workload-declarations.json";
export const WORKSPACE_WORKLOAD_FILE_MAX_BYTES = 262_144;
export const WORKSPACE_WORKLOAD_MAX_DECLARATIONS = 128;
export const WORKSPACE_WORKLOAD_MAX_COMMAND_LENGTH = 32_768;
export const WORKSPACE_WORKLOAD_DEFAULT_TIMEOUT_MS = 300_000;
export const WORKSPACE_WORKLOAD_MAX_TIMEOUT_MS = 3_600_000;
export const WORKSPACE_FLOW_SETUP_ID = "flow:setup";
export const WORKSPACE_FLOW_SETUP_COMMAND = "bash ./setup.sh";
export const WORKSPACE_FLOW_SETUP_TIMEOUT_MS = 60_000;
export const WORKSPACE_WORKLOAD_KINDS = [
  "setup",
  "cli",
  "check",
  "requirementProbe",
] as const;
export type WorkspaceWorkloadKind = (typeof WORKSPACE_WORKLOAD_KINDS)[number];
export type WorkspaceWorkloadDeclaration = Readonly<{
  id: string;
  workload: WorkspaceWorkloadKind;
  command: string;
  timeoutMs: number;
  structuredOutput?: "json" | "jsonFile";
  flowAssets?: true;
  flowSetup?: string;
}>;
export type WorkspaceWorkloadRequest = Readonly<{
  workspaceProtocol: 1;
  command: Readonly<{ id: string; kind: "workspace.run"; issuedAt: string }>;
  owner: WorkspaceAssignmentOwner;
  payload: Readonly<{
    generation: number;
    workload: WorkspaceWorkloadKind;
    declarationId: string;
    inputGeneration: number;
    inputDigest: string;
    templateContext?: WorkspaceInputObject;
  }>;
}>;
export type WorkspaceWorkloadResult = Readonly<{
  generation: number;
  processOutcome:
    "exited" | "signalled" | "timedOut" | "cancelled" | "interrupted";
  exitCode: number | null;
  signal: string | null;
  checkValidity: "notRequested" | "valid" | "invalid" | "unavailable";
  outputState: "sealed" | "truncated" | "unavailable";
  objects: readonly WorkspaceInputObject[];
  quiescence: "proved" | "uncertain";
  setupReused?: true;
}>;
export type WorkspaceCancelWorkloadRequest = Readonly<{
  workspaceProtocol: 1;
  command: Readonly<{ id: string; kind: "workspace.cancel"; issuedAt: string }>;
  owner: WorkspaceAssignmentOwner;
  payload: Readonly<{ generation: number }>;
}>;
export type WorkspaceCancelWorkloadResult = Readonly<{
  targetCommandId: string;
  quiescence: "proved" | "uncertain";
  objects: readonly WorkspaceInputObject[];
}>;

export type WorkspaceCheckpointRequest = Readonly<{
  workspaceProtocol: 1;
  command: Readonly<{ id: string; kind: "workspace.checkpoint"; issuedAt: string }>;
  owner: WorkspaceAssignmentOwner;
  payload: Readonly<{ generation: number }>;
}>;
export type WorkspaceRestoreRequest = Readonly<{
  workspaceProtocol: 1;
  command: Readonly<{ id: string; kind: "workspace.restore"; issuedAt: string }>;
  owner: WorkspaceAssignmentOwner;
  payload: Readonly<{ generation: number; checkpointId: string; policy?: "fresh-attempt" }>;
}>;
export type WorkspaceGitCheckpointResult = Readonly<{
  generation: number;
  checkpointId: string;
  tree: string;
  baseTree?: string;
  resultingTree?: string;
}>;

export type WorkspaceOperationOwner = Readonly<{
  kind: "workspaceOperation";
  hostKey: string;
  workspaceHandle: string;
  workspaceGeneration: number;
  claimId: string;
  fence: number;
}>;

export type CheckoutExpectation = Readonly<{
  head: string;
  remoteId: string;
  targetRef: string;
  priorTarget: string | null;
}>;

export type WorkspaceSyncRequest = Readonly<{
  workspaceProtocol: 1;
  command: Readonly<{ id: string; kind: "workspace.sync"; issuedAt: string }>;
  owner: WorkspaceOperationOwner;
  payload: Readonly<{
    generation: number;
    expected: CheckoutExpectation;
    strategy: "fastForward" | "merge" | "rebase";
    publish?: Readonly<{ targetRef: string; priorTarget: string | null }>;
  }>;
}>;

export type WorkspaceSyncResult = Readonly<{
  generation: number;
  head: string;
  priorTarget: string;
  observedTarget: string;
  behind: number;
  publication?: Readonly<{
    targetRef: string;
    priorTarget: string | null;
    observedTarget: string;
  }>;
}>;

export type WorkspacePublishRequest = Readonly<{
  workspaceProtocol: 1;
  command: Readonly<{ id: string; kind: "workspace.publish"; issuedAt: string }>;
  owner: WorkspaceOperationOwner;
  payload: Readonly<{
    generation: number;
    expected: CheckoutExpectation;
    publication: "push" | "promote" | "openPullRequest";
    integration?: "merge" | "rebase";
    pullRequest?: Readonly<{
      baseRef: string;
      baseCommit: string;
      title: string;
      body: string;
      draft: boolean;
    }>;
  }>;
}>;

export type WorkspacePublishResult = Readonly<{
  publication: WorkspacePublishRequest["payload"]["publication"];
  git: Readonly<{
    generation: number;
    head: string;
    priorTarget: string | null;
    observedTarget: string;
  }>;
  pullRequest?: Readonly<{ url: string; number: number; reused: boolean }>;
}>;
export type WorkspacePublicationTarget = Readonly<{
  generation: number;
  remoteId: string;
  targetRef: string;
  priorTarget: string | null;
}>;
export type WorkspacePreserveRequest = Readonly<{
  workspaceProtocol: 1;
  command: Readonly<{ id: string; kind: "workspace.preserve"; issuedAt: string }>;
  owner: WorkspaceOperationOwner;
  payload: Readonly<{ generation: number; disposition: "archive"; quiescenceId: string }>;
}>;
export type WorkspaceReleaseRequest = Readonly<{
  workspaceProtocol: 1;
  command: Readonly<{ id: string; kind: "workspace.release"; issuedAt: string }>;
  owner: WorkspaceOperationOwner;
  payload: Readonly<{ generation: number; dispositionId: string; quiescenceId: string }>;
}>;
export type WorkspacePreserveResult = Readonly<{
  generation: number;
  dispositionId: string;
  retainedCommit: string;
}>;
export type WorkspaceReleaseResult = Readonly<{
  handle: string;
  generation: number;
  dispositionId: string;
}>;

export type WorkspaceRecord = Readonly<{
  handle: string;
  generation: number;
  mode: WorkspacePrepareInput["mode"];
  observedCommit: string | null;
}>;

export type WorkspaceStatus = Readonly<{
  workspace: WorkspaceRecord;
  workingTree: "clean" | "dirty" | "nonGit";
  headState: "branch" | "detached" | "nonGit";
}>;

export type PreparedWorkspace = Readonly<{
  workspace: WorkspaceRecord;
  inputDigest: string;
}>;

export const WORKSPACE_PREPARE_OPERATION = "stageCPrepare";
export const WORKSPACE_PREPARE_TARGET = { kind: "prepare" } as const;
export const WORKSPACE_MATERIALIZE_OPERATION = "stageCMaterialize";
export const WORKSPACE_RUN_OPERATION = "stageCRunWorkload";
export const WORKSPACE_CANCEL_OPERATION = "stageCCancelWorkload";
export const WORKSPACE_CHECKPOINT_OPERATION = "stageCCheckpoint";
export const WORKSPACE_RESTORE_OPERATION = "stageCRestore";
export const WORKSPACE_PUBLISH_OPERATION = "stageCPublish";
export const WORKSPACE_SYNC_OPERATION = "stageCSync";
export const WORKSPACE_PRESERVE_OPERATION = "stageCPreserve";
export const WORKSPACE_RELEASE_OPERATION = "stageCRelease";
export const WORKSPACE_TERMINAL_EVENT = "workspace.command.terminal";
export const WORKSPACE_TERMINAL_SCHEMA =
  "maister.workspace.command.terminal.v1";

export type WorkspaceGenerationTarget = Readonly<{
  kind: "workspace";
  handle: string;
  generation: number;
}>;
export type WorkspaceCancelTarget = Readonly<{
  kind: "cancelWorkload";
  handle: string;
  generation: number;
  commandId: string;
}>;

export type WorkspaceCommandBinding =
  | Readonly<{
      operationId: typeof WORKSPACE_PREPARE_OPERATION;
      target: typeof WORKSPACE_PREPARE_TARGET;
    }>
  | Readonly<{
      operationId: typeof WORKSPACE_MATERIALIZE_OPERATION;
      target: WorkspaceGenerationTarget;
    }>
  | Readonly<{
      operationId: typeof WORKSPACE_RUN_OPERATION;
      target: WorkspaceGenerationTarget;
    }>
  | Readonly<{
      operationId: typeof WORKSPACE_CANCEL_OPERATION;
      target: WorkspaceCancelTarget;
    }>
  | Readonly<{
      operationId: typeof WORKSPACE_CHECKPOINT_OPERATION;
      target: WorkspaceGenerationTarget;
    }>
  | Readonly<{
      operationId: typeof WORKSPACE_RESTORE_OPERATION;
      target: WorkspaceGenerationTarget;
    }>;

export type WorkspacePublishBinding = Readonly<{
  operationId: typeof WORKSPACE_PUBLISH_OPERATION;
  target: WorkspaceGenerationTarget;
}>;
export type WorkspaceSyncBinding = Readonly<{
  operationId: typeof WORKSPACE_SYNC_OPERATION;
  target: WorkspaceGenerationTarget;
}>;
export type WorkspaceDispositionBinding =
  | Readonly<{ operationId: typeof WORKSPACE_PRESERVE_OPERATION; target: WorkspaceGenerationTarget }>
  | Readonly<{ operationId: typeof WORKSPACE_RELEASE_OPERATION; target: WorkspaceGenerationTarget }>;
export type WorkspaceRetainedBinding = WorkspaceSyncBinding | WorkspacePublishBinding | WorkspaceDispositionBinding;
export type WorkspaceRetainedRequest = WorkspaceSyncRequest | WorkspacePublishRequest | WorkspacePreserveRequest | WorkspaceReleaseRequest;

export type WorkspaceTerminalPayload = (
  | (WorkspaceCommandBinding & { owner: WorkspaceAssignmentOwner })
  | (WorkspaceRetainedBinding & { owner: WorkspaceOperationOwner })
) &
  Readonly<{
    commandId: string;
    requestSha256: string;
    phase: "completed" | "rejected" | "indeterminate";
    outcomeSha256: string;
  }>;

export type WorkspaceTerminalEnvelope = Readonly<{
  envelopeVersion: 2;
  eventId: string;
  hostKey: string;
  hostBootId: string;
  streamId: string;
  sequence: string;
  eventType: typeof WORKSPACE_TERMINAL_EVENT;
  occurredAt: string;
  payloadSchema: typeof WORKSPACE_TERMINAL_SCHEMA;
  payload: WorkspaceTerminalPayload;
}>;

type ReceiptIdentity = Readonly<{
  commandId: string;
  requestSha256: string;
}>;

type WorkspaceReceipt<
  Binding extends WorkspaceCommandBinding | WorkspaceRetainedBinding,
  Result,
  Owner = WorkspaceAssignmentOwner,
> = Readonly<
  ReceiptIdentity &
    Binding &
    { owner: Owner } &
    (
      | {
          phase: "accepted";
          status: 202;
          acceptance: { commandId: string; state: "accepted" };
        }
      | ({ streamId: string; eventId: string; outcomeSha256: string } & (
          | { phase: "completed"; result: Result }
          | {
              phase: "rejected";
              refusal: {
                code: string;
                message: string;
                details: { reason: string };
              };
            }
          | {
              phase: "indeterminate";
              condition: "effect_unconfirmed" | "quiescence_unconfirmed";
            }
        ))
    )
>;

export type WorkspacePrepareReceipt = WorkspaceReceipt<
  Extract<
    WorkspaceCommandBinding,
    { operationId: typeof WORKSPACE_PREPARE_OPERATION }
  >,
  PreparedWorkspace
>;
export type WorkspaceMaterializeReceipt = WorkspaceReceipt<
  Extract<
    WorkspaceCommandBinding,
    { operationId: typeof WORKSPACE_MATERIALIZE_OPERATION }
  >,
  MaterializedWorkspaceInputs
>;
export type WorkspaceWorkloadReceipt = WorkspaceReceipt<
  Extract<
    WorkspaceCommandBinding,
    { operationId: typeof WORKSPACE_RUN_OPERATION }
  >,
  WorkspaceWorkloadResult
>;
export type WorkspaceCancelWorkloadReceipt = WorkspaceReceipt<
  Extract<
    WorkspaceCommandBinding,
    { operationId: typeof WORKSPACE_CANCEL_OPERATION }
  >,
  WorkspaceCancelWorkloadResult
>;
export type WorkspaceCommandReceipt =
  | WorkspacePrepareReceipt
  | WorkspaceMaterializeReceipt
  | WorkspaceWorkloadReceipt
  | WorkspaceCancelWorkloadReceipt
  | WorkspaceReceipt<Extract<WorkspaceCommandBinding, { operationId: typeof WORKSPACE_CHECKPOINT_OPERATION }>, WorkspaceGitCheckpointResult>
  | WorkspaceReceipt<Extract<WorkspaceCommandBinding, { operationId: typeof WORKSPACE_RESTORE_OPERATION }>, WorkspaceGitCheckpointResult>
  | WorkspacePublishReceipt
  | WorkspaceSyncReceipt
  | WorkspacePreserveReceipt
  | WorkspaceReleaseReceipt;
export type WorkspacePublishReceipt = WorkspaceReceipt<
  WorkspacePublishBinding,
  WorkspacePublishResult,
  WorkspaceOperationOwner
>;
export type WorkspaceSyncReceipt = WorkspaceReceipt<
  WorkspaceSyncBinding,
  WorkspaceSyncResult,
  WorkspaceOperationOwner
>;
export type WorkspacePreserveReceipt = WorkspaceReceipt<
  Extract<WorkspaceDispositionBinding, { operationId: typeof WORKSPACE_PRESERVE_OPERATION }>,
  WorkspacePreserveResult,
  WorkspaceOperationOwner
>;
export type WorkspaceReleaseReceipt = WorkspaceReceipt<
  Extract<WorkspaceDispositionBinding, { operationId: typeof WORKSPACE_RELEASE_OPERATION }>,
  WorkspaceReleaseResult,
  WorkspaceOperationOwner
>;
export type WorkspaceCommandRequest =
  | WorkspacePrepareRequest
  | WorkspaceMaterializeRequest
  | WorkspaceWorkloadRequest
  | WorkspaceCancelWorkloadRequest
  | WorkspaceCheckpointRequest
  | WorkspaceRestoreRequest;

export function workspaceTerminalOutcome(
  receipt: Extract<WorkspaceCommandReceipt, { streamId: string }>,
): Record<string, unknown> {
  if (receipt.phase === "completed") return { result: receipt.result };
  if (receipt.phase === "rejected") return { refusal: receipt.refusal };

  return { condition: receipt.condition };
}

export function isWorkspaceOperationOwner(
  value: unknown,
): value is WorkspaceOperationOwner {
  return (
    exactRecord(value, [
      "kind", "hostKey", "workspaceHandle", "workspaceGeneration", "claimId", "fence",
    ]) &&
    value.kind === "workspaceOperation" &&
    matches(value.hostKey, EXECUTION_HOST_KEY_PATTERN) &&
    matches(value.claimId, UUID) &&
    typeof value.fence === "number" &&
    Number.isSafeInteger(value.fence) &&
    value.fence > 0 &&
    isWorkspaceGenerationTarget({
      kind: "workspace",
      handle: value.workspaceHandle,
      generation: value.workspaceGeneration,
    })
  );
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SEQUENCE = /^(0|[1-9][0-9]{0,18})$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UTC_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function exactRecord(
  input: unknown,
  keys: readonly string[],
): input is Record<string, unknown> {
  return Boolean(
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input).length === keys.length &&
    keys.every((key) => Object.hasOwn(input as object, key)),
  );
}

function matches(input: unknown, pattern: RegExp): input is string {
  return typeof input === "string" && pattern.test(input);
}

export function isWorkspaceAssignmentOwner(
  value: unknown,
): value is WorkspaceAssignmentOwner {
  return (
    exactRecord(value, [
      "kind",
      "hostKey",
      "runId",
      "assignmentId",
      "assignmentEpoch",
    ]) &&
    value.kind === "assignment" &&
    matches(value.hostKey, EXECUTION_HOST_KEY_PATTERN) &&
    matches(value.runId, RUN_ID) &&
    matches(value.assignmentId, UUID) &&
    typeof value.assignmentEpoch === "number" &&
    Number.isSafeInteger(value.assignmentEpoch) &&
    value.assignmentEpoch > 0 &&
    value.assignmentEpoch <= 2_147_483_647
  );
}

export function isWorkspaceTerminalPayload(
  value: unknown,
): value is WorkspaceTerminalPayload {
  return (
    exactRecord(value, [
      "commandId",
      "requestSha256",
      "operationId",
      "owner",
      "target",
      "phase",
      "outcomeSha256",
    ]) &&
    matches(value.commandId, UUID) &&
    matches(value.requestSha256, DIGEST) &&
    (isWorkspaceRetainedOperation(value.operationId)
      ? isWorkspaceOperationOwner(value.owner) &&
        isWorkspaceGenerationTarget(value.target) &&
        value.owner.workspaceHandle === value.target.handle &&
        value.owner.workspaceGeneration === value.target.generation
      : isWorkspaceAssignmentOwner(value.owner) &&
        (value.operationId === WORKSPACE_PREPARE_OPERATION
      ? exactRecord(value.target, ["kind"]) && value.target.kind === "prepare"
      : value.operationId === WORKSPACE_CANCEL_OPERATION
        ? isWorkspaceCancelTarget(value.target)
        : (value.operationId === WORKSPACE_MATERIALIZE_OPERATION ||
            value.operationId === WORKSPACE_RUN_OPERATION ||
            value.operationId === WORKSPACE_CHECKPOINT_OPERATION ||
            value.operationId === WORKSPACE_RESTORE_OPERATION) &&
          isWorkspaceGenerationTarget(value.target))) &&
    (value.phase === "completed" ||
      value.phase === "rejected" ||
      value.phase === "indeterminate") &&
    matches(value.outcomeSha256, DIGEST)
  );
}

export function isWorkspaceRetainedOperation(
  operationId: unknown,
): operationId is WorkspaceRetainedBinding["operationId"] {
  return operationId === WORKSPACE_PUBLISH_OPERATION ||
    operationId === WORKSPACE_SYNC_OPERATION ||
    operationId === WORKSPACE_PRESERVE_OPERATION ||
    operationId === WORKSPACE_RELEASE_OPERATION;
}

export function isWorkspaceGenerationTarget(
  value: unknown,
): value is WorkspaceGenerationTarget {
  return (
    exactRecord(value, ["kind", "handle", "generation"]) &&
    value.kind === "workspace" &&
    matches(value.handle, /^ws_[a-f0-9]{32}$/) &&
    typeof value.generation === "number" &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0
  );
}

export function isWorkspaceCancelTarget(
  value: unknown,
): value is WorkspaceCancelTarget {
  return (
    exactRecord(value, ["kind", "handle", "generation", "commandId"]) &&
    value.kind === "cancelWorkload" &&
    matches(value.commandId, UUID) &&
    isWorkspaceGenerationTarget({
      kind: "workspace",
      handle: value.handle,
      generation: value.generation,
    })
  );
}

export function isWorkspaceTerminalEnvelope(
  value: unknown,
): value is WorkspaceTerminalEnvelope {
  return (
    exactRecord(value, [
      "envelopeVersion",
      "eventId",
      "hostKey",
      "hostBootId",
      "streamId",
      "sequence",
      "eventType",
      "occurredAt",
      "payloadSchema",
      "payload",
    ]) &&
    value.envelopeVersion === 2 &&
    matches(value.eventId, UUID) &&
    matches(value.hostKey, EXECUTION_HOST_KEY_PATTERN) &&
    matches(value.hostBootId, UUID) &&
    matches(value.streamId, UUID) &&
    matches(value.sequence, SEQUENCE) &&
    BigInt(value.sequence) <= 9_223_372_036_854_775_807n &&
    value.eventType === WORKSPACE_TERMINAL_EVENT &&
    matches(value.occurredAt, UTC_INSTANT) &&
    Number.isFinite(Date.parse(value.occurredAt)) &&
    value.payloadSchema === WORKSPACE_TERMINAL_SCHEMA &&
    isWorkspaceTerminalPayload(value.payload) &&
    value.payload.owner.hostKey === value.hostKey
  );
}

export function workspaceEvidenceDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalCommandJson(value), "utf8")
    .digest("hex");
}

export function workspacePrepareRequestDigest(
  request: WorkspacePrepareRequest,
): string {
  return workspaceCommandRequestDigest(request, {
    operationId: WORKSPACE_PREPARE_OPERATION,
    target: WORKSPACE_PREPARE_TARGET,
  });
}

export function workspaceCommandRequestDigest(
  request: WorkspaceCommandRequest | WorkspaceRetainedRequest,
  binding: WorkspaceCommandBinding | WorkspaceRetainedBinding,
): string {
  return workspaceEvidenceDigest({
    ...binding,
    hostKey: request.owner.hostKey,
    ...request,
  });
}
export type WorkspaceSourceRefPage = Readonly<{
  refs: readonly string[];
  defaultRef: string | null;
  nextCursor: string | null;
}>;

export type WorkspaceRevisionObservation = Readonly<{
  repositoryId: string;
  ref: string;
  commit: string;
  pinnedCommit?: string;
}>;

export function isWorkspaceSourceRef(value: string): boolean {
  const prefix = "refs/heads/";

  return value.length <= 256 &&
    value.startsWith(prefix) &&
    branchNameViolation(value.slice(prefix.length)) === undefined;
}
