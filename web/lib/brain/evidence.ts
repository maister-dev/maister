import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { sha256 } from "./codec";

import { MaisterError } from "@/lib/errors";

export type EvidenceDb = {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
};

/** Pin the indexed bytes actually read, separately from their mutable anchor. */
export async function captureChunkEvidence(
  db: EvidenceDb,
  input: Readonly<{
    projectId: string;
    recordId: string;
    chunkId: string;
    sourceId: string;
    sourceVersion: string | null;
    content: string;
  }>,
): Promise<void> {
  const locator = { kind: "inline", content: input.content };

  if (
    Buffer.byteLength(input.content, "utf8") > 262144 ||
    Buffer.byteLength(JSON.stringify(locator), "utf8") > 262144
  ) {
    throw new MaisterError(
      "CONFIG",
      "Source evidence exceeds the bounded inline capture limit",
      { details: { reason: "evidence_capture_too_large" } },
    );
  }
  if (
    input.sourceVersion !== null &&
    (input.sourceVersion.length === 0 || input.sourceVersion.length > 256)
  ) {
    throw new MaisterError(
      "CONFIG",
      "Source version exceeds the evidence contract bounds",
    );
  }
  const record = (
    await db.execute(
      sql`SELECT id,source_run_id,source_node_attempt_id FROM brain_items WHERE id=${input.recordId} AND project_id=${input.projectId} FOR UPDATE`,
    )
  ).rows[0];

  if (!record)
    throw new MaisterError(
      "CONFIG",
      "Knowledge record does not resolve in the source owner",
    );
  const contentHash = sha256(input.content);
  const actor = {
    kind: "system",
    id: "brain_capture",
    runId: record.source_run_id as string | null,
    attemptId: record.source_node_attempt_id as string | null,
  } as const;
  // Origin independence remains unknown. A source/version/content capture is
  // not evidence that a second agent or selector independently observed it.
  const inserted = await db.execute(sql`
    INSERT INTO brain_evidence_observations(project_id,source_id,source_version,content_sha256,attribution)
    VALUES(${input.projectId},${input.sourceId},${input.sourceVersion},${contentHash},${JSON.stringify(actor)}::jsonb)
    ON CONFLICT DO NOTHING RETURNING id
  `);
  const observation =
    inserted.rows[0] ??
    (
      await db.execute(sql`
    SELECT id FROM brain_evidence_observations WHERE project_id=${input.projectId}
      AND source_id=${input.sourceId} AND source_version IS NOT DISTINCT FROM ${input.sourceVersion} AND content_sha256=${contentHash}
  `)
    ).rows[0];

  if (typeof observation?.id !== "string")
    throw new MaisterError("CONFLICT", "Evidence observation was not retained");
  const selector = `chunk:${input.chunkId}`;
  const restrictions = [{ kind: "project", projectId: input.projectId }];
  const witnessInsert = await db.execute(sql`
    INSERT INTO brain_evidence_witnesses(observation_id,source_version,content_sha256,selector,restrictions,capture_locator)
    VALUES(${observation.id},${input.sourceVersion},${contentHash},${selector},${JSON.stringify(restrictions)}::jsonb,${JSON.stringify(locator)}::jsonb)
    ON CONFLICT DO NOTHING RETURNING id
  `);
  const witness =
    witnessInsert.rows[0] ??
    (
      await db.execute(sql`
    SELECT id FROM brain_evidence_witnesses WHERE observation_id=${observation.id}
      AND source_version IS NOT DISTINCT FROM ${input.sourceVersion} AND content_sha256=${contentHash} AND selector=${selector}
  `)
    ).rows[0];

  if (typeof witness?.id !== "string")
    throw new MaisterError("CONFLICT", "Evidence witness was not retained");
  const snapshot = {
    id: witness.id,
    sourceId: input.sourceId,
    sourceVersion: input.sourceVersion,
    sha256: contentHash,
    selector,
    restrictions,
  };

  await db.execute(sql`
    INSERT INTO brain_revision_evidence(record_id,revision,witness_id,relation,witness_snapshot)
    SELECT id,current_revision,${witness.id},'derived_from',${JSON.stringify(snapshot)}::jsonb
    FROM brain_items WHERE id=${input.recordId} AND project_id=${input.projectId}
    ON CONFLICT DO NOTHING
  `);
}
