import "server-only";

import type { SqlDatabase } from "@/lib/db/sql-types";
import type { RunResultContract } from "./types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { projectNativeFindings } from "./findings-projection";
import { evidenceFindingsV1Schema } from "./findings-types";

import { requireProjectActionForUser } from "@/lib/authz";
import {
  authorizeRunKnowledgeDisclosure,
  assertRunKnowledgeDisclosure,
} from "@/lib/brain/knowledge-run-disclosure";
import { knowledgeRevisionSchema } from "@/lib/brain/knowledge-types";
import { databaseTimestamp } from "@/lib/db/timestamp";
import { redactQueryError } from "@/lib/db/pg-error";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { postgresTextSchema } from "@/lib/text-schema";

export const retainedResultSelectorSchema = z
  .object({
    runId: postgresTextSchema.min(1).max(128),
    revision: knowledgeRevisionSchema,
  })
  .strict();

/** URL revisions have one decimal representation and the existing Postgres revision bound. */
export function retainedResultRevision(value: string): number {
  if (
    !/^[1-9][0-9]*$/.test(value) ||
    !knowledgeRevisionSchema.safeParse(Number(value)).success
  )
    throw new MaisterError(
      "CONFIG",
      "The retained result revision must be a bounded positive decimal integer",
    );

  return Number(value);
}

export const retainedResultSchema = z
  .object({
    runId: postgresTextSchema.min(1).max(128),
    revision: knowledgeRevisionSchema,
    validity: z.enum(["valid", "stale", "superseded", "invalid"]),
    schemaRef: postgresTextSchema.min(1).max(1024),
    schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
    schemaVersion: z.number().int().positive(),
    producerKind: z.enum(["flow_node", "agent_session"]),
    producerRef: postgresTextSchema.min(1).max(512),
    nodeAttemptId: postgresTextSchema.min(1).max(128).nullable(),
    value: z.record(z.string(), z.unknown()).nullable(),
    valueBytes: z.number().int().nonnegative(),
    invalidReason: postgresTextSchema.min(1).max(128).nullable(),
    publishedAt: z.string().datetime(),
    collectedAt: z.string().datetime().nullable(),
    supersededByRevision: knowledgeRevisionSchema.nullable(),
    findings: evidenceFindingsV1Schema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const invalid = value.validity === "invalid";

    if (
      invalid !== (value.value === null) ||
      invalid !== (value.invalidReason !== null) ||
      (invalid && value.findings !== undefined)
    )
      context.addIssue({
        code: "custom",
        message:
          "Invalid publication attempts require a reason and no value; retained successful values require no invalid reason",
      });
  });

export type RetainedRunResult = z.infer<typeof retainedResultSchema>;

/** Human inspection of an exact ledger row; never consumes child work or grants a token direct-grandchild access. */
export async function loadRetainedResultForUser(
  db: SqlDatabase,
  userId: string,
  input: z.infer<typeof retainedResultSelectorSchema>,
): Promise<RetainedRunResult | null> {
  const selector = retainedResultSelectorSchema.safeParse(input);

  if (!selector.success)
    throw new MaisterError(
      "CONFIG",
      "An exact retained result identity and positive revision are required",
    );
  const { runId, revision } = selector.data;

  try {
    const metadata = (
      await db.execute(
        sql`SELECT project_id,result_contract FROM runs WHERE id=${runId}`,
      )
    ).rows[0];

    if (!metadata || typeof metadata.project_id !== "string") return null;
    const projectId = metadata.project_id;
    const recipient = { kind: "user" as const, userId };

    await requireProjectActionForUser(userId, projectId, "readBoard");
    const result = await db.transaction(async (tx) => {
      await authorizeRunKnowledgeDisclosure(tx, recipient, runId);
      const row = (
        await tx.execute(sql`SELECT r.validity,r.schema_ref,r.schema_sha256,r.schema_version,r.producer_kind,r.producer_ref,r.node_attempt_id,r.value,r.value_bytes,r.invalid_reason,r.created_at,r.first_collected_at,next.revision AS superseded_by_revision
        FROM run_results r LEFT JOIN run_results next ON next.id=r.superseded_by_id AND next.run_id=r.run_id
        WHERE r.run_id=${runId} AND r.revision=${revision} FOR SHARE OF r`)
      ).rows[0];

      if (!row) return null;
      const findings = projectNativeFindings(
        metadata.result_contract as RunResultContract | null,
        row.value,
      );
      const parsed = retainedResultSchema.safeParse({
        runId,
        revision,
        validity: row.validity,
        schemaRef: row.schema_ref,
        schemaSha256: row.schema_sha256,
        schemaVersion: row.schema_version,
        producerKind: row.producer_kind,
        producerRef: row.producer_ref,
        nodeAttemptId: row.node_attempt_id,
        value: row.value,
        valueBytes: row.value_bytes,
        invalidReason: row.invalid_reason,
        publishedAt: databaseTimestamp(row.created_at),
        collectedAt: databaseTimestamp(row.first_collected_at),
        supersededByRevision: row.superseded_by_revision ?? null,
        ...(findings ? { findings } : {}),
      });

      if (!parsed.success)
        throw new MaisterError(
          "CRASH",
          "The retained result does not match its inspection contract",
        );

      return parsed.data;
    });

    await requireProjectActionForUser(userId, projectId, "readBoard");
    await assertRunKnowledgeDisclosure(db, recipient, runId);

    return result;
  } catch (error) {
    if (isMaisterError(error) && error.code === "UNAUTHORIZED") return null;
    throw redactQueryError(error);
  }
}
