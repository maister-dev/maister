import "server-only";

import type { SqlDatabase } from "@/lib/db/sql-types";
import type { AssignmentContext } from "./context-types";
import type { KnowledgePrincipal } from "@/lib/brain/knowledge-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { readSpecialistAssignmentContextInTransaction } from "./context";
import { beginAssignmentTransaction } from "./store";

import {
  lockKnowledgeReadConsumer,
  recordKnowledgeDisclosure,
} from "@/lib/brain/knowledge-disclosure";
import { restrictionsForKnowledgeAccess } from "@/lib/brain/knowledge-restrictions";
import { resolveKnowledgeRunIdentity } from "@/lib/brain/knowledge-run-identity";
import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "specialist-context-projection",
  level: process.env.LOG_LEVEL ?? "info",
});

type ContextProjection =
  | Readonly<{ state: "not_assigned" | "not_enabled" }>
  | Readonly<{ state: "available"; context: AssignmentContext }>;

/** Resolve only the server-appointed assignment, recording source capture before returning prompt bytes. */
async function projectExecutionContext(
  db: SqlDatabase,
  runId: string,
  nodeAttemptId: string | null,
): Promise<ContextProjection> {
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const link = (
        await tx.execute(
          sql`SELECT assignment_id FROM specialist_run_links WHERE run_id=${runId}`,
        )
      ).rows[0];

      if (!link) return { state: "not_assigned" };
      const assignmentId = link.assignment_id;

      if (typeof assignmentId !== "string")
        throw new MaisterError(
          "CONFIG",
          "Stored execution assignment link has no valid identity",
        );
      const principal: KnowledgePrincipal = {
        kind: "execution",
        runId,
        nodeAttemptId,
      };
      const consumer = await lockKnowledgeReadConsumer(tx, principal);
      const { identity } = await resolveKnowledgeRunIdentity(
        tx,
        runId,
        nodeAttemptId,
      );

      if (
        identity.kind === "company_agent" &&
        !identity.actionLimits.includes("assignments:read")
      ) {
        log.debug(
          {
            runId,
            nodeAttemptId,
            assignmentId,
            state: "not_enabled",
          },
          "working context omitted by current reviewed role limit",
        );

        return { state: "not_enabled" };
      }
      const result = await readSpecialistAssignmentContextInTransaction(
        tx,
        principal,
        assignmentId,
      );

      await recordKnowledgeDisclosure(
        tx,
        consumer,
        restrictionsForKnowledgeAccess(result.access),
      );
      log.debug(
        {
          runId,
          nodeAttemptId,
          assignmentId,
          contextRevision: result.value.revision,
          inputRevision: result.value.inputRevision,
          entryCount: result.value.entries.length,
        },
        "authorized working context projected for a new prompt",
      );

      return { state: "available", context: result.value };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Newly assembled prompts get a bounded versioned context; retained owner requests keep their original bytes. */
export async function appendSpecialistAssignmentContextPrompt(
  db: SqlDatabase,
  runId: string,
  nodeAttemptId: string | null,
  prompt: string,
): Promise<string> {
  const projection = await projectExecutionContext(db, runId, nodeAttemptId);

  if (projection.state !== "available") return prompt;

  return `${prompt}\n\n## Assignment working context\n\nThis versioned working context is separate from standing instructions, assignment input, permissions, accepted work, and confirmed Company Brain knowledge. Preserve evidence references and explicit limitations.\n\n${JSON.stringify(projection.context)}`;
}
