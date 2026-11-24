import "server-only";

import type { Db } from "./db";
import type { ExecutionHostTransport } from "./contracts";

import { and, asc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";

import { workspaceEvidenceDigest } from "../../../runtime/workspace-prepare";

import { createExecutionHosts } from "./client";
import { assertWorkspaceRunAuthority } from "./workspace-input-authority";
import { queueWorkspaceInputs } from "./workspace-inputs";
import { nextWorkspaceRequirementProbeSql } from "./workspace-preparation";
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

/** Queue the next frozen requirement only after all prior probes are proved successful. */
export async function recoverWorkspaceRequirementProbes(
  db: Db,
  reportError: (runId: string, error: unknown) => void,
): Promise<void> {
  const next = nextWorkspaceRequirementProbeSql(
    sql`${executionAssignments.id}`,
    sql`${workspaceInputCaptures.requirementProbeCount}`,
  );
  const candidates = await db
    .select({
      runId: runs.id,
      assignmentId: executionAssignments.id,
      probeIndex: sql<number>`${next}`,
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
        eq(runs.status, "Pending"),
        eq(workspaces.ownershipKind, "host_owned"),
        eq(executionAssignments.state, "active"),
        isNotNull(workspaces.workspaceMaterializationGeneration),
        isNull(workspaces.removedAt),
        gt(workspaceInputCaptures.requirementProbeCount, 0),
        sql`${next} IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM execution_commands command
        WHERE command.execution_assignment_id = ${executionAssignments.id}
          AND command.kind = 'workspace.run'
          AND command.payload->>'workload' = 'requirementProbe'
          AND command.payload->>'declarationId' = 'probe:' || ${next}
      )`,
      ),
    )
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(16);

  for (const { runId, assignmentId, probeIndex } of candidates) {
    const declarationId = `probe:${probeIndex}`;
    try {
      await reserveWorkspaceWorkload(db, {
        runId,
        assignmentId,
        workload: "requirementProbe",
        declarationId,
        operationKey: `preflight:${declarationId}`,
      });
    } catch (error) {
      reportError(runId, error);
    }
  }
}
