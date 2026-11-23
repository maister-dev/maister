import { createHash } from "node:crypto";

import { canonicalCommandJson } from "./command-json";

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
  command: Readonly<{ id: string; kind: "workspace.prepare"; issuedAt: string }>;
  owner: WorkspaceAssignmentOwner;
  payload: WorkspacePrepareInput;
}>;

export type PreparedWorkspace = Readonly<{
  workspace: Readonly<{
    handle: string;
    generation: number;
    mode: WorkspacePrepareInput["mode"];
    observedCommit: string | null;
  }>;
  inputDigest: string;
}>;

export const WORKSPACE_PREPARE_OPERATION = "stageCPrepare";
export const WORKSPACE_PREPARE_TARGET = { kind: "prepare" } as const;

export function workspaceEvidenceDigest(value: unknown): string {
  return createHash("sha256").update(canonicalCommandJson(value), "utf8").digest("hex");
}

export function workspacePrepareRequestDigest(request: WorkspacePrepareRequest): string {
  return workspaceEvidenceDigest({
    operationId: WORKSPACE_PREPARE_OPERATION,
    hostKey: request.owner.hostKey,
    target: WORKSPACE_PREPARE_TARGET,
    ...request,
  });
}
