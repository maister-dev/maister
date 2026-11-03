import "server-only";

import type { SqlDatabase } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";

import { nativeDelegationExecutionInput } from "./native-input";

import { requireProjectActionForUser } from "@/lib/authz";
import {
  authorizeRunKnowledgeDisclosure,
  assertRunKnowledgeDisclosure,
} from "@/lib/brain/knowledge-run-disclosure";
import { unavailableKnowledgeReference } from "@/lib/brain/knowledge-restrictions";
import { isMaisterError } from "@/lib/errors";
import { redactQueryError } from "@/lib/db/pg-error";

export type NativeInputInspection = Readonly<{
  title: string;
  prompt: string;
  sourceRunId: string;
  inputDigest: string;
}>;

/** Inspect original delegated input without adding it to shared task/run DTOs. */
export async function loadNativeInputForUser(
  db: SqlDatabase,
  userId: string,
  runId: string,
): Promise<NativeInputInspection | null> {
  try {
    const metadata = (
      await db.execute(sql`SELECT project_id FROM runs WHERE id=${runId}`)
    ).rows[0];

    if (!metadata || typeof metadata.project_id !== "string") return null;
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
      if (row.native_input === null) return null;
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
