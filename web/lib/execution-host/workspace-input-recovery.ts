import "server-only";

import type { Db } from "./db";
import type { ExecutionHostTransport } from "./contracts";

import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { WORKSPACE_FLOW_SETUP_ID, workspaceEvidenceDigest } from "../../../runtime/workspace-prepare";

import { createExecutionHosts } from "./client";
import { assertWorkspaceRunAuthority } from "./workspace-input-authority";
import { queueWorkspaceInputs } from "./workspace-inputs";
import { nextWorkspaceRequirementProbeSql, workspaceSetupPendingSql } from "./workspace-preparation";
import { reserveWorkspaceWorkload } from "./workspace-workloads";

import {
  executionAssignments,
  executionCommands,
  runs,
  workspaceInputCaptures,
  workspaces,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export async function recoverWorkspaceInputCaptures(
  db: Db,
  transport: ExecutionHostTransport,
  reportError: (runId: string, error: unknown) => void,
  onlyRunId?: string,
): Promise<void> {
  const ready = await db
    .select({
      runId: workspaces.runId,
      workspaceId: workspaces.id,
      assignmentId: executionAssignments.id,
    })
    .from(workspaces)
    .innerJoin(
      workspaceInputCaptures,
      eq(workspaceInputCaptures.workspaceId, workspaces.id),
    )
    .innerJoin(
      executionAssignments,
      eq(executionAssignments.id, workspaces.preparationAssignmentId),
    )
    .innerJoin(
      runs,
      and(
        eq(runs.id, workspaces.runId),
        eq(runs.executionAssignmentId, executionAssignments.id),
      ),
    )
    .where(
      and(
        onlyRunId ? eq(workspaces.runId, onlyRunId) : undefined,
        eq(runs.status, "Pending"),
        eq(workspaces.ownershipKind, "host_owned"),
        eq(executionAssignments.state, "active"),
        isNotNull(executionAssignments.executionWorkspaceId),
        isNull(workspaces.workspaceMaterializationGeneration),
        isNull(workspaces.removedAt),
        sql`NOT EXISTS (SELECT 1 FROM ${executionCommands} command
        WHERE command.execution_assignment_id = ${executionAssignments.id}
        AND command.kind = 'workspace.materialize')`,
      ),
    )
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(16);
  const hosts = createExecutionHosts({ db, transport });

  for (const entry of ready) {
    try {
      await assertWorkspaceRunAuthority(db, entry.runId);
      const [capture] = await db
        .select()
        .from(workspaceInputCaptures)
        .where(eq(workspaceInputCaptures.workspaceId, entry.workspaceId));
      if (
        !capture ||
        workspaceEvidenceDigest(capture.files) !== capture.contentDigest
      )
        throw new MaisterError(
          "PRECONDITION",
          "Retained workspace input capture failed its digest check",
          {
            details: { reason: "workspace_input_changed" },
          },
        );
      const client = await hosts.forAssignment({ id: entry.assignmentId });
      await queueWorkspaceInputs(db, {
        client,
        files: capture.files.map(({ path, base64, executable }) => ({
          path,
          bytes: Buffer.from(base64, "base64"),
          ...(executable ? { executable } : {}),
        })),
        assertAuthority: (tx) => assertWorkspaceRunAuthority(tx, entry.runId),
      });
    } catch (error) {
      reportError(entry.runId, error);
    }
  }
}

/** Queue frozen setup first, then the next probe only after its predecessors succeed. */
export async function recoverWorkspacePreflight(
  db: Db,
  reportError: (runId: string, error: unknown) => void,
  onlyRunId?: string,
): Promise<void> {
  const next = nextWorkspaceRequirementProbeSql(
    sql`${executionAssignments.id}`,
    sql`${workspaceInputCaptures.requirementProbeCount}`,
  );
  const pendingSetup = workspaceSetupPendingSql(
    sql`${executionAssignments.id}`,
    sql`${workspaceInputCaptures.flowSetupRevisionId}`,
  );
  const declaration = sql<string>`CASE WHEN ${pendingSetup} THEN ${WORKSPACE_FLOW_SETUP_ID}
    ELSE 'probe:' || ${next} END`;
  const candidates = await db
    .select({
      runId: runs.id,
      assignmentId: executionAssignments.id,
      declarationId: declaration,
    })
    .from(workspaces)
    .innerJoin(
      workspaceInputCaptures,
      eq(workspaceInputCaptures.workspaceId, workspaces.id),
    )
    .innerJoin(
      executionAssignments,
      eq(executionAssignments.id, workspaces.preparationAssignmentId),
    )
    .innerJoin(
      runs,
      and(
        eq(runs.id, workspaces.runId),
        eq(runs.executionAssignmentId, executionAssignments.id),
      ),
    )
    .where(
      and(
        onlyRunId ? eq(workspaces.runId, onlyRunId) : undefined,
        eq(runs.status, "Pending"),
        eq(workspaces.ownershipKind, "host_owned"),
        eq(executionAssignments.state, "active"),
        isNotNull(workspaces.workspaceMaterializationGeneration),
        isNull(workspaces.removedAt),
        sql`${declaration} IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM execution_commands command
        WHERE command.execution_assignment_id = ${executionAssignments.id}
          AND command.kind = 'workspace.run'
          AND command.payload->>'workload' IN ('setup', 'requirementProbe')
          AND command.payload->>'declarationId' = ${declaration}
      )`,
      ),
    )
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(16);

  for (const { runId, assignmentId, declarationId } of candidates) {
    try {
      await reserveWorkspaceWorkload(db, {
        runId,
        assignmentId,
        workload: declarationId === WORKSPACE_FLOW_SETUP_ID ? "setup" : "requirementProbe",
        declarationId,
        operationKey: `preflight:${declarationId}`,
      });
    } catch (error) {
      reportError(runId, error);
    }
  }
}
