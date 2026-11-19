import "server-only";

import type { KnowledgePrincipal } from "./knowledge-types";
import type {
  KnowledgeTransaction,
  KnowledgeDatabase,
} from "./knowledge-access";
import type { KnowledgeAccessWalk } from "./knowledge-restrictions";
import type { KnowledgeWitnessDto } from "./knowledge-read-types";

import { sql } from "drizzle-orm";

import { knowledgeOwner, resolveKnowledgePrincipal } from "./knowledge-access";
import {
  lockKnowledgeReadConsumer,
  recordKnowledgeDisclosure,
} from "./knowledge-disclosure";
import {
  authorizeSourceRestrictions,
  parseKnowledgeRestrictions,
  unavailableKnowledgeReference,
  restrictionsForKnowledgeAccess,
} from "./knowledge-restrictions";
import { knowledgeWitnessSchema } from "./knowledge-read-types";
import { sha256 } from "./codec";

import { MaisterError } from "@/lib/errors";
import { truncateUtf8 } from "@/lib/utf8";
import { postgresTextSchema } from "@/lib/text-schema";
import { redactQueryError } from "@/lib/db/pg-error";
import { databaseTimestamp as knowledgeTimestamp } from "@/lib/db/timestamp";

export { databaseTimestamp as knowledgeTimestamp } from "@/lib/db/timestamp";

/** Inspect pending-proposal proof without requiring a published carrier record. */
export async function getKnowledgeWitness(
  db: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  witnessId: string,
): Promise<KnowledgeWitnessDto> {
  if (!postgresTextSchema.min(1).max(128).safeParse(witnessId).success)
    throw new MaisterError("CONFIG", "Invalid evidence witness identity");
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      const consumer = await lockKnowledgeReadConsumer(tx, principal);

      await resolveKnowledgePrincipal(tx, principal, "knowledge:read");
      const inspection = await inspectKnowledgeWitness(
        tx,
        principal,
        witnessId,
      );

      await recordKnowledgeDisclosure(
        tx,
        consumer,
        restrictionsForKnowledgeAccess(inspection.access),
      );

      return inspection.witness;
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Return retained capture bytes only after current owner and inherited-source authorization. */
export async function inspectKnowledgeWitness(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  witnessId: string,
  access: KnowledgeAccessWalk = { visited: [], remaining: 256 },
): Promise<{ witness: KnowledgeWitnessDto; access: KnowledgeAccessWalk }> {
  const row = (
    await tx.execute(sql`
    SELECT w.id,w.source_version,w.content_sha256,w.selector,w.restrictions,w.capture_locator,w.captured_at,
      o.source_id,o.project_id,o.company_id,o.attribution,o.observed_at,o.source_at,o.independence_group_id
    FROM brain_evidence_witnesses w JOIN brain_evidence_observations o ON o.id=w.observation_id WHERE w.id=${witnessId} FOR SHARE OF w,o
  `)
  ).rows[0];

  if (!row) throw unavailableKnowledgeReference();
  const restrictions = parseKnowledgeRestrictions(row.restrictions);
  const authorized = await authorizeSourceRestrictions(
    tx,
    principal,
    [knowledgeOwner(row), ...(restrictions ?? [])],
    access,
  );
  const locator = row.capture_locator as Readonly<{
    kind?: unknown;
    content?: unknown;
    recordId?: unknown;
    revision?: unknown;
    revisionId?: unknown;
  }>;
  let content = typeof locator.content === "string" ? locator.content : null;
  if (locator.kind === "vault_revision") {
    const source = restrictions?.find(
      (ref) =>
        ref.kind === "agent_vault_revision_v1" &&
        ref.revisionId === locator.revisionId,
    );
    if (source?.kind !== "agent_vault_revision_v1")
      throw unavailableKnowledgeReference();
    const result =
      await tx.execute(sql`SELECT content FROM agent_memory_revision_payloads
      WHERE (vault_id,note_id,revision_id)=(${source.vaultId},${source.noteId},${source.revisionId}) FOR SHARE`);
    if (typeof result.rows[0]?.content !== "string")
      throw unavailableKnowledgeReference();
    content = result.rows[0].content;
  }

  if (content !== null && sha256(content) !== row.content_sha256)
    throw new MaisterError(
      "CRASH",
      "Retained evidence bytes do not match their immutable witness",
      { details: { reason: "knowledge_capture_digest_mismatch" } },
    );
  const availability = await witnessAvailability(tx, row, locator, content);
  const result = knowledgeWitnessSchema.safeParse({
    id: row.id,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    sha256: row.content_sha256,
    selector: row.selector,
    availability,
    capturedAt: knowledgeTimestamp(row.captured_at),
    observedAt: knowledgeTimestamp(row.observed_at),
    sourceAt: knowledgeTimestamp(row.source_at),
    independenceGroupId: row.independence_group_id,
    attribution: row.attribution,
    excerpt: content === null ? null : truncateUtf8(content, 8192),
    excerptTruncated:
      content !== null && Buffer.byteLength(content, "utf8") > 8192,
  });

  if (!result.success)
    throw new MaisterError(
      "CONFIG",
      "Stored evidence does not match its native inspection contract",
    );

  return { witness: result.data, access: authorized };
}

async function witnessAvailability(
  tx: KnowledgeTransaction,
  row: Readonly<Record<string, unknown>>,
  locator: Readonly<{ kind?: unknown; recordId?: unknown; revision?: unknown }>,
  content: string | null,
): Promise<KnowledgeWitnessDto["availability"]> {
  if (locator.kind === "vault_revision")
    return content === null ? "missing" : "available";
  if (locator.kind === "record" && typeof locator.recordId === "string") {
    const record = (
      await tx.execute(
        sql`SELECT current_revision FROM brain_items WHERE id=${locator.recordId} FOR SHARE`,
      )
    ).rows[0];

    if (!record) return "missing";

    return Number(record.current_revision) === locator.revision
      ? "available"
      : "stale";
  }
  const source = (
    await tx.execute(
      sql`SELECT source_hash FROM brain_sources WHERE id=${row.source_id} FOR SHARE`,
    )
  ).rows[0];

  if (!source) return "missing";
  if (
    typeof source.source_hash === "string" &&
    typeof row.source_version === "string"
  ) {
    const version = row.source_version.startsWith("sha256:")
      ? row.source_version.slice(7)
      : row.source_version;

    if (source.source_hash !== version) return "stale";
  }

  return content === null ? "unknown" : "available";
}
