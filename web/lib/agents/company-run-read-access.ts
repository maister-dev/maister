import "server-only";

import type { SqlDatabase } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { companyAgentExecutionSnapshotSchema } from "./company-agent-execution-types";

import { authorizeRunKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { knowledgeAccessCaptureSchema } from "@/lib/company/types";
import { isMaisterError, MaisterError } from "@/lib/errors";

const log = pino({
  name: "company-run-read",
  level: process.env.LOG_LEVEL ?? "info",
});

function unavailableCompanyRun(): MaisterError {
  return new MaisterError("PRECONDITION", "Run is unavailable", {
    details: { reason: "run_unavailable" },
  });
}

/** Historical content uses current reader/source authority, independently of execution eligibility. */
export async function assertCompanyRunReadAccess(
  db: SqlDatabase,
  userId: string,
  runId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = (
      await tx.execute(sql`
      SELECT execution.company_id,execution.company_execution_snapshot,execution.knowledge_access,
             link.assignment_id,link.input_revision,input.digest
      FROM runs execution
      JOIN specialist_run_links link ON link.run_id=execution.id
      JOIN specialist_assignments assignment ON assignment.id=link.assignment_id
        AND assignment.company_id=execution.company_id AND assignment.project_id IS NULL
      JOIN specialist_input_revisions input ON input.assignment_id=link.assignment_id
        AND input.revision=link.input_revision
      WHERE execution.id=${runId} AND execution.project_id IS NULL AND execution.company_id IS NOT NULL
      FOR SHARE OF execution,link,assignment,input
    `)
    ).rows;
    const snapshot = companyAgentExecutionSnapshotSchema.safeParse(
      row?.company_execution_snapshot,
    );
    const capture = knowledgeAccessCaptureSchema.safeParse(
      row?.knowledge_access,
    );

    if (
      !row ||
      !snapshot.success ||
      !capture.success ||
      capture.data.state !== "complete" ||
      snapshot.data.owner.companyId !== row.company_id ||
      snapshot.data.assignment.id !== row.assignment_id ||
      snapshot.data.assignment.inputRevision !== row.input_revision ||
      snapshot.data.assignment.inputSha256 !== row.digest ||
      !capture.data.restrictions.some(
        (restriction) =>
          restriction.kind === "assignment_input" &&
          restriction.assignmentId === row.assignment_id &&
          restriction.inputRevision === row.input_revision &&
          restriction.inputSha256 === row.digest,
      )
    )
      throw unavailableCompanyRun();

    try {
      await authorizeCompanyUserAction(
        tx,
        userId,
        snapshot.data.owner.companyId,
        "assignments:read",
      );
    } catch (error) {
      if (isMaisterError(error) && error.code === "UNAUTHORIZED")
        throw unavailableCompanyRun();
      throw error;
    }
    await authorizeRunKnowledgeDisclosure(tx, { kind: "user", userId }, runId);
    log.debug(
      { runId, companyId: snapshot.data.owner.companyId, userId },
      "company Run reader and retained sources authorized",
    );
  });
}
