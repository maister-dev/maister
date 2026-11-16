import "server-only";

import type { SqlDatabase } from "@/lib/db/sql-types";
import type { AssignmentInputRevision } from "@/lib/specialist-assignments/types";

import { sql } from "drizzle-orm";

import { nativeDelegationExecutionInput } from "./native-input";

import {
  assertCompanyRunReadAccess,
  assertCompanyRunReadAccessInTransaction,
} from "@/lib/agents/company-run-read-access";
import { companyExecutionSnapshotSchema } from "@/lib/agents/company-execution-types";
import { requireProjectActionForUser } from "@/lib/authz";
import {
  authorizeRunKnowledgeDisclosure,
  assertRunKnowledgeDisclosure,
} from "@/lib/brain/knowledge-run-disclosure";
import { unavailableKnowledgeReference } from "@/lib/brain/knowledge-restrictions";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { redactQueryError } from "@/lib/db/pg-error";
import { getSpecialistAssignmentInputInTransaction } from "@/lib/specialist-assignments/store";
import { knowledgeAccessCaptureSchema } from "@/lib/company/types";

export type AssignmentInputInspection = Readonly<{
  kind: "assignment_input";
  input: AssignmentInputRevision;
}>;

export type NativeInputInspection =
  | AssignmentInputInspection
  | Readonly<{
      title: string;
      prompt: string;
      sourceRunId: string;
      inputDigest: string;
    }>;

/** Inspect the exact Run-bound company input; snapshots describe history and never grant current authority. */
export async function loadCompanyAssignmentInputForUser(
  db: SqlDatabase,
  userId: string,
  runId: string,
): Promise<AssignmentInputInspection | null> {
  try {
    const inspection = await db.transaction(async (tx) => {
      await assertCompanyRunReadAccessInTransaction(tx, userId, runId);
      const row = (
        await tx.execute(
          sql`SELECT company_execution_snapshot FROM runs WHERE id=${runId} FOR SHARE`,
        )
      ).rows[0];
      const snapshot = companyExecutionSnapshotSchema.safeParse(
        row?.company_execution_snapshot,
      );

      if (!snapshot.success)
        throw new MaisterError("PRECONDITION", "Run is unavailable", {
          details: { reason: "run_unavailable" },
        });
      const input = await getSpecialistAssignmentInputInTransaction(
        tx,
        userId,
        snapshot.data.assignment.id,
        snapshot.data.assignment.inputRevision,
      );

      if (input.digest !== snapshot.data.assignment.inputSha256)
        throw unavailableKnowledgeReference();

      return { kind: "assignment_input" as const, input };
    });

    await assertCompanyRunReadAccess(db, userId, runId);

    return inspection;
  } catch (error) {
    if (
      isMaisterError(error) &&
      (error.code === "UNAUTHORIZED" ||
        (error.code === "PRECONDITION" &&
          error.details?.reason === "run_unavailable"))
    )
      return null;
    throw redactQueryError(error);
  }
}

/** Inspect exact assignment or delegated input without adding it to shared task/run DTOs. */
export async function loadNativeInputForUser(
  db: SqlDatabase,
  userId: string,
  runId: string,
): Promise<NativeInputInspection | null> {
  try {
    const metadata = (
      await db.execute(
        sql`SELECT project_id,company_id FROM runs WHERE id=${runId}`,
      )
    ).rows[0];

    if (!metadata) return null;
    if (typeof metadata.project_id !== "string")
      return typeof metadata.company_id === "string"
        ? loadCompanyAssignmentInputForUser(db, userId, runId)
        : null;
    const projectId = metadata.project_id;
    const recipient = { kind: "user" as const, userId };

    await requireProjectActionForUser(userId, projectId, "readRepoFiles");
    const result = await db.transaction(async (tx) => {
      await authorizeRunKnowledgeDisclosure(tx, recipient, runId);
      const row = (
        await tx.execute(
          sql`SELECT run_kind,agent_id,source_agent_id,flow_id,parent_run_id,task_id,knowledge_access,delegation_snapshot->'nativeInput' AS native_input,delegation_snapshot->>'kind' AS delegation_kind,delegation_snapshot->>'carrierTaskId' AS carrier_task_id FROM runs WHERE id=${runId} AND project_id=${projectId} FOR SHARE`,
        )
      ).rows[0];

      if (!row) throw unavailableKnowledgeReference();
      if (row.native_input === null) {
        if (row.knowledge_access === null) return null;
        const capture = knowledgeAccessCaptureSchema.safeParse(
          row.knowledge_access,
        );

        if (!capture.success || capture.data.state !== "complete")
          throw unavailableKnowledgeReference();
        const references = capture.data.restrictions.filter(
          (item) => item.kind === "assignment_input",
        );

        if (references.length === 0) return null;
        if (references.length !== 1) throw unavailableKnowledgeReference();
        const reference = references[0]!;
        const appointment = (
          await tx.execute(sql`
          SELECT link.assignment_id FROM specialist_run_links link
          JOIN specialist_assignments assignment ON assignment.id=link.assignment_id
          WHERE link.run_id=${runId} AND assignment.project_id=${projectId}
            AND link.assignment_id=${reference.assignmentId} AND link.input_revision=${reference.inputRevision}
          FOR SHARE OF link,assignment
        `)
        ).rows[0];

        if (!appointment) throw unavailableKnowledgeReference();
        const input = await getSpecialistAssignmentInputInTransaction(
          tx,
          userId,
          reference.assignmentId,
          reference.inputRevision,
        );

        if (input.digest !== reference.inputSha256)
          throw unavailableKnowledgeReference();

        return { kind: "assignment_input" as const, input };
      }
      const agentId =
        row.run_kind === "agent" ? row.agent_id : row.source_agent_id;
      const target =
        typeof agentId === "string"
          ? { kind: "agent" as const, id: agentId }
          : typeof row.flow_id === "string"
            ? { kind: "flow" as const, id: row.flow_id }
            : null;

      if (
        !target ||
        typeof row.parent_run_id !== "string" ||
        (row.run_kind === "flow" &&
          (row.delegation_kind !== "flow" ||
            row.carrier_task_id !== row.task_id)) ||
        (row.run_kind === "agent" &&
          row.delegation_kind !== null &&
          row.delegation_kind !== "agent") ||
        !["agent", "flow"].includes(String(row.run_kind))
      )
        throw unavailableKnowledgeReference();
      const input = nativeDelegationExecutionInput(row.native_input, {
        parentRunId: row.parent_run_id,
        target,
        knowledgeAccess: row.knowledge_access,
      });

      return {
        title: input.title,
        prompt: input.prompt,
        sourceRunId: input.sourceRunId,
        inputDigest: input.inputDigest,
      };
    });

    await requireProjectActionForUser(userId, projectId, "readRepoFiles");
    await assertRunKnowledgeDisclosure(db, recipient, runId);

    return result;
  } catch (error) {
    if (isMaisterError(error) && error.code === "UNAUTHORIZED") return null;
    throw redactQueryError(error);
  }
}
