import "server-only";

import type {
  WorkspacePrepareInput,
  WorkspaceStatus,
  WorkspaceDiffQuery,
  WorkspaceEvidenceObject,
  WorkspaceSourceRefPage,
} from "../../../runtime/workspace-prepare";
import type { Db } from "./db";
import type { ExecutionHostTransport } from "./contracts";
import type { ExecutionAssignment, ExecutionHost } from "@/lib/db/schema";
import type { WorkspaceInputFile } from "./workspace-inputs";

import { randomUUID } from "node:crypto";

import { eq, sql, type SQL } from "drizzle-orm";

import { COMMAND_POLICY } from "./deliverer";
import { defaultTransport } from "./default-transport";
import { issueCommand } from "./ledger";
import { configuredSelectedExecutionEndpoint } from "./selected-endpoint";
import { encodeWorkspaceInputCapture } from "./workspace-input-capture";
import { hostForAssignment } from "./resolver";

import { runs, workspaceInputCaptures, workspaces } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

type WorkspaceMetadata = Pick<
  typeof workspaces.$inferInsert,
  | "projectId"
  | "branch"
  | "baseBranch"
  | "baseCommit"
  | "targetBranch"
  | "promotionMode"
  | "branchDelivery"
  | "rootWorkspaceId"
>;

export function usesHostWorkspacePreparation(host: ExecutionHost): boolean {
  const protocol = host.capabilities.workspaceProtocol;

  return (
    configuredSelectedExecutionEndpoint()?.hostKey === host.hostKey &&
    Array.isArray(protocol) &&
    protocol.length === 1 &&
    protocol[0] === 1
  );
}

export async function observeSelectedWorkspaceRevision(
  repositoryId: string,
  branch: string,
  transport: ExecutionHostTransport = defaultTransport(),
): Promise<string> {
  if (!transport.observeWorkspaceRevision)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Selected host cannot observe approved Git sources",
      {
        details: { reason: "workspace_protocol_unsupported" },
      },
    );
  const ref = branch.startsWith("refs/heads/")
    ? branch
    : `refs/heads/${branch}`;

  return transport.observeWorkspaceRevision(repositoryId, ref);
}

export async function listAddressedWorkspaceRefs(
  repositoryId: string,
  cursor?: string,
  transport = defaultTransport(),
): Promise<WorkspaceSourceRefPage> {
  if (!configuredSelectedExecutionEndpoint() || !transport.listWorkspaceSourceRefs)
    throw new MaisterError("EXECUTOR_UNAVAILABLE", "Selected host cannot list approved Git refs", {
      details: { reason: "workspace_protocol_unsupported" },
    });

  return transport.listWorkspaceSourceRefs(repositoryId, cursor);
}

type RetainedWorkspaceRead = Pick<
  typeof workspaces.$inferSelect,
  | "ownershipKind"
  | "executionHostId"
  | "executionWorkspaceId"
  | "workspaceGeneration"
  | "preparationAssignmentId"
  | "removedAt"
>;

async function resolveAddressedWorkspaceRead(
  db: Db,
  workspace: RetainedWorkspaceRead,
  transport: ExecutionHostTransport,
): Promise<{ handle: string; generation: number }> {
  if (
    workspace.ownershipKind !== "host_owned" ||
    workspace.removedAt ||
    !workspace.executionHostId ||
    !workspace.executionWorkspaceId ||
    !workspace.workspaceGeneration ||
    !workspace.preparationAssignmentId
  )
    throw new MaisterError(
      "PRECONDITION",
      "Run has no retained addressed workspace",
      {
        details: { reason: "workspace_preparation_pending" },
      },
    );
  const host = await hostForAssignment(
    db,
    {
      id: workspace.preparationAssignmentId,
      executionHostId: workspace.executionHostId,
    },
    { transport },
  );
  if (!usesHostWorkspacePreparation(host))
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Assigned host cannot inspect workspaces",
      {
        details: { reason: "workspace_protocol_unsupported" },
      },
    );

  return {
    handle: workspace.executionWorkspaceId,
    generation: workspace.workspaceGeneration,
  };
}

/** Call after the Run's project authorization. The retained owner remains valid after assignment release. */
export async function readAddressedWorkspaceStatus(
  db: Db,
  workspace: RetainedWorkspaceRead,
  transport = defaultTransport(),
): Promise<WorkspaceStatus> {
  if (!transport.getWorkspaceStatus)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Transport cannot inspect workspaces",
      { details: { reason: "workspace_protocol_unsupported" } },
    );
  const { handle, generation } = await resolveAddressedWorkspaceRead(
    db,
    workspace,
    transport,
  );

  return transport.getWorkspaceStatus(handle, generation);
}

/** The caller authorizes `readRepoFiles` for the Run before requesting its diff. */
export async function readAddressedWorkspaceDiff(
  db: Db,
  workspace: RetainedWorkspaceRead,
  range: Omit<WorkspaceDiffQuery, "generation">,
  transport = defaultTransport(),
): Promise<WorkspaceEvidenceObject> {
  if (!transport.getWorkspaceDiff)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Transport cannot capture workspace diffs",
      { details: { reason: "workspace_protocol_unsupported" } },
    );
  const { handle, generation } = await resolveAddressedWorkspaceRead(
    db,
    workspace,
    transport,
  );

  return transport.getWorkspaceDiff(handle, { ...range, generation });
}

/** Reserve the logical workspace and command in the transaction that places the Run. */
export async function reserveHostWorkspace(
  tx: Db,
  placement: Readonly<{ host: ExecutionHost; assignment: ExecutionAssignment }>,
  metadata: WorkspaceMetadata,
  payload: WorkspacePrepareInput,
  files: readonly WorkspaceInputFile[] = [],
  requirementProbeCount = 0,
): Promise<void> {
  const { host, assignment } = placement;
  const workspaceId = randomUUID();
  const capture = encodeWorkspaceInputCapture(files);
  const [run] = await tx
    .select({ userId: runs.createdByUserId })
    .from(runs)
    .where(eq(runs.id, assignment.runId));
  if (!run)
    throw new MaisterError(
      "CONFLICT",
      "Workspace reservation requires its admitted Run",
      {
        details: { reason: "workspace_preparation_changed" },
      },
    );

  await tx.insert(workspaces).values({
    ...metadata,
    id: workspaceId,
    runId: assignment.runId,
    ownershipKind: "host_owned",
    executionHostId: host.id,
    preparationAssignmentId: assignment.id,
    workspaceGeneration: 1,
    workspaceInputDigest: payload.inputDigest,
  });
  await tx.insert(workspaceInputCaptures).values({
    workspaceId,
    originUserId: run.userId,
    requirementProbeCount,
    ...capture,
  });

  await issueCommand(tx, {
    assignment,
    host,
    kind: "workspace.prepare",
    targetSessionId: workspaceId,
    payload,
    maxAttempts: COMMAND_POLICY["workspace.prepare"].maxAttempts,
  });
}

export function workspacePreparationReadySql(runId: SQL): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${workspaces} preparation
    LEFT JOIN ${workspaceInputCaptures} capture ON capture.workspace_id = preparation.id
    WHERE preparation.run_id = ${runId}
      AND preparation.ownership_kind = 'host_owned'
      AND preparation.removed_at IS NULL
      AND (preparation.workspace_materialization_generation IS NULL OR
        ${nextWorkspaceRequirementProbeSql(sql`preparation.preparation_assignment_id`, sql`capture.requirement_probe_count`)} IS NOT NULL)
  )`;
}

export function nextWorkspaceRequirementProbeSql(
  assignmentId: SQL,
  count: SQL,
): SQL {
  return sql`next_workspace_requirement_probe(${assignmentId}, ${count})`;
}
