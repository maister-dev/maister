import "server-only";

import type { WorkspacePrepareInput } from "../../../runtime/workspace-prepare";
import type { Db } from "./db";
import type { ExecutionAssignment, ExecutionHost } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import { COMMAND_POLICY } from "./deliverer";
import { issueCommand } from "./ledger";
import { configuredSelectedExecutionEndpoint } from "./selected-endpoint";

import { workspaces } from "@/lib/db/schema";

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

/** Reserve the logical workspace and command in the transaction that places the Run. */
export async function reserveHostWorkspace(
  tx: Db,
  placement: Readonly<{ host: ExecutionHost; assignment: ExecutionAssignment }>,
  metadata: WorkspaceMetadata,
  payload: WorkspacePrepareInput,
): Promise<void> {
  const { host, assignment } = placement;
  const workspaceId = randomUUID();

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
    WHERE preparation.run_id = ${runId}
      AND preparation.ownership_kind = 'host_owned'
      AND preparation.execution_workspace_id IS NULL
      AND preparation.removed_at IS NULL
  )`;
}
