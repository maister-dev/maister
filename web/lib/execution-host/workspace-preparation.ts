import "server-only";

import type {
  WorkspacePrepareInput,
  WorkspaceStatus,
  WorkspaceDiffQuery,
  WorkspaceLogQuery,
  WorkspaceEvidenceObject,
  WorkspaceSourceRefPage,
  WorkspaceRevisionObservation,
  WorkspacePullRequestQuery,
  WorkspacePullRequestStatus,
} from "../../../runtime/workspace-prepare";
import type { Db } from "./db";
import type { ExecutionHostTransport } from "./contracts";
import type { ExecutionAssignment, ExecutionHost } from "@/lib/db/schema";
import type { WorkspaceInputFile } from "./workspace-inputs";

import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql, type SQL } from "drizzle-orm";

import { COMMAND_POLICY } from "./deliverer";
import { defaultTransport } from "./default-transport";
import { issueCommand } from "./ledger";
import { configuredSelectedExecutionEndpoint } from "./selected-endpoint";
import { encodeWorkspaceInputCapture } from "./workspace-input-capture";
import { hostForAssignment } from "./resolver";

import { executionAssignments, runs, workspaceInputCaptures, workspaces } from "@/lib/db/schema";
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

/** Read affinity for an existing shared root without opening or probing its checkout. */
export async function readAddressedSharedRoot(
  db: Db,
  rootRunId: string,
): Promise<typeof workspaces.$inferSelect | null> {
  const [root] = await db
    .select()
    .from(workspaces)
    .where(and(
      eq(workspaces.runId, rootRunId),
      eq(workspaces.ownershipKind, "host_owned"),
      isNull(workspaces.removedAt),
    ));
  return root ?? null;
}

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

/** Observe the advertised tip and optionally verify a historical pin on its branch. */
export async function resolveAddressedWorkspaceRevision(
  repositoryId: string,
  branch: string,
  pinnedCommit?: string,
  transport = defaultTransport(),
): Promise<WorkspaceRevisionObservation> {
  if (!configuredSelectedExecutionEndpoint() || !transport.resolveWorkspaceRevision)
    throw new MaisterError("EXECUTOR_UNAVAILABLE", "Selected host cannot verify an approved Git revision", {
      details: { reason: "workspace_protocol_unsupported" },
    });
  const ref = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;

  return transport.resolveWorkspaceRevision(repositoryId, ref, pinnedCommit);
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

export async function readAddressedWorkspaceReviewFingerprint(
  db: Db,
  workspace: RetainedWorkspaceRead,
  base: string,
  transport = defaultTransport(),
) {
  if (!transport.getWorkspaceReviewFingerprint)
    throw new MaisterError("EXECUTOR_UNAVAILABLE", "Transport cannot verify a workspace review fingerprint", {
      details: { reason: "workspace_protocol_unsupported" },
    });
  const { handle, generation } = await resolveAddressedWorkspaceRead(db, workspace, transport);

  return transport.getWorkspaceReviewFingerprint(handle, { generation, base });
}

export async function readAddressedWorkspacePublicationTarget(
  db: Db,
  workspace: RetainedWorkspaceRead,
  input: { remoteId: string; targetRef: string },
  transport = defaultTransport(),
) {
  if (!transport.getWorkspacePublicationTarget)
    throw new MaisterError("EXECUTOR_UNAVAILABLE", "Transport cannot observe a workspace publication target", {
      details: { reason: "workspace_protocol_unsupported" },
    });
  const { handle, generation } = await resolveAddressedWorkspaceRead(db, workspace, transport);

  return transport.getWorkspacePublicationTarget(handle, { ...input, generation });
}

export async function readAddressedWorkspacePullRequest(
  db: Db,
  workspace: RetainedWorkspaceRead,
  input: Omit<WorkspacePullRequestQuery, "generation">,
  transport = defaultTransport(),
): Promise<WorkspacePullRequestStatus> {
  if (!transport.getWorkspacePullRequest)
    throw new MaisterError("EXECUTOR_UNAVAILABLE", "Transport cannot observe the workspace's PR", {
      details: { reason: "workspace_protocol_unsupported" },
    });
  const { handle, generation } = await resolveAddressedWorkspaceRead(db, workspace, transport);

  return transport.getWorkspacePullRequest(handle, { ...input, generation });
}

/** The caller authorizes repository content access before requesting history. */
export async function readAddressedWorkspaceLog(
  db: Db,
  workspace: RetainedWorkspaceRead,
  page: Omit<WorkspaceLogQuery, "generation">,
  transport = defaultTransport(),
): Promise<WorkspaceEvidenceObject> {
  if (!transport.getWorkspaceLog)
    throw new MaisterError("EXECUTOR_UNAVAILABLE", "Transport cannot capture workspace history", {
      details: { reason: "workspace_protocol_unsupported" },
    });
  const { handle, generation } = await resolveAddressedWorkspaceRead(db, workspace, transport);

  return transport.getWorkspaceLog(handle, { ...page, generation });
}

/** Reserve the logical workspace and command in the transaction that places the Run. */
export async function reserveHostWorkspace(
  tx: Db,
  placement: Readonly<{ host: ExecutionHost; assignment: ExecutionAssignment }>,
  metadata: WorkspaceMetadata,
  payload: WorkspacePrepareInput,
  files: readonly WorkspaceInputFile[] = [],
  preflight: Readonly<{
    requirementProbeCount?: number;
    flowSetupRevisionId?: string;
  }> = {},
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
    ...preflight,
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
    SELECT 1 FROM ${runs} preparing_run
    JOIN ${executionAssignments} owner ON owner.id=preparing_run.execution_assignment_id
    WHERE preparing_run.id=${runId} AND owner.state='active' AND owner.addressed_stop_requested_at IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM ${workspaces} preparation
    LEFT JOIN ${workspaceInputCaptures} capture ON capture.workspace_id = preparation.id
    WHERE preparation.run_id = ${runId}
      AND preparation.ownership_kind = 'host_owned'
      AND preparation.removed_at IS NULL
      AND (preparation.workspace_materialization_generation IS NULL OR
        ${workspaceSetupPendingSql(sql`preparation.preparation_assignment_id`, sql`capture.flow_setup_revision_id`)} OR
        ${nextWorkspaceRequirementProbeSql(sql`preparation.preparation_assignment_id`, sql`capture.requirement_probe_count`)} IS NOT NULL)
  )`;
}

export function workspaceSetupPendingSql(assignmentId: SQL, revisionId: SQL): SQL {
  return sql`workspace_flow_setup_pending(${assignmentId}, ${revisionId})`;
}

export function nextWorkspaceRequirementProbeSql(
  assignmentId: SQL,
  count: SQL,
): SQL {
  return sql`next_workspace_requirement_probe(${assignmentId}, ${count})`;
}
