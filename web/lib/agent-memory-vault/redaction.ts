import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { lockConfirmationSourceRedaction } from "./card-redaction-fence";
import { requireVaultActive } from "./cutover";
import { lockVault, tombstoneRedactedHead, unavailableMemory } from "./store";

import {
  agentMemoryRedactions as redactions,
  agentMemoryRevisions as revisions,
  agentMemoryRevisionPayloads as payloads,
  users,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "agent-memory-redaction",
  level: process.env.LOG_LEVEL ?? "info",
});
const redactionInput = z.strictObject({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine((value) => !value.includes("\0") && value.isWellFormed()),
  requestKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
});

export function parseMemoryRedaction(input: unknown) {
  const parsed = redactionInput.safeParse(input);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid vault redaction request");

  return parsed.data;
}

async function removeDerivedVaultContent(
  tx: Db,
  revisionId: string,
  restriction: object,
) {
  await tx.execute(sql`
    WITH dependent AS (
      SELECT p.id,p.vault_id FROM agent_memory_proposals p
      WHERE p.source_restrictions @> ${JSON.stringify([restriction])}::jsonb
        OR EXISTS (SELECT 1 FROM agent_memory_operation_revisions refs
          WHERE refs.vault_id=p.vault_id AND refs.operation_id IN (p.operation_id,p.applied_operation_id)
            AND refs.revision_id=${revisionId})
    ), scrubbed AS (
      UPDATE agent_memory_proposals p SET
        state=CASE WHEN p.state='pending' THEN 'redacted' ELSE p.state END,
        version=CASE WHEN p.state='pending' THEN 2 ELSE p.version END,
        decided_at=CASE WHEN p.state='pending' THEN now() ELSE p.decided_at END,
        decision_reason=NULL
      FROM dependent d WHERE p.id=d.id AND (p.state='pending' OR p.decision_reason IS NOT NULL)
      RETURNING p.id
    )
    DELETE FROM agent_memory_proposal_payloads payload USING dependent d
    WHERE (payload.vault_id,payload.proposal_id)=(d.vault_id,d.id)
  `);
  await tx.execute(sql`
    UPDATE librarian_cards
    SET status=CASE WHEN status='pending' THEN 'superseded' ELSE status END,
      payload='{}'::jsonb, effect_context=NULL
    WHERE effect_context->'restrictions' @> ${JSON.stringify([restriction])}::jsonb
  `);
  const cache = await tx.execute<{ enabled: boolean }>(
    sql`SELECT to_regclass('agent_memory_embeddings') IS NOT NULL AS enabled`,
  );

  if (cache.rows[0]?.enabled)
    await tx.execute(
      sql`DELETE FROM agent_memory_embeddings WHERE revision_id=${revisionId}`,
    );
}

export async function redactMemoryRevision(
  db: Db,
  userId: string,
  revisionId: string,
  input: z.infer<typeof redactionInput>,
) {
  const receipt = await db.transaction(async (tx) => {
    const [admin] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.role, "admin"),
          eq(users.accountStatus, "active"),
          eq(users.mustChangePassword, false),
        ),
      )
      .for("share");

    if (!admin)
      throw new MaisterError(
        "UNAUTHORIZED",
        "An active global administrator is required",
      );
    await lockConfirmationSourceRedaction(tx);
    await requireVaultActive(tx);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["agent-memory-redact", userId, input.requestKey])},0))`,
    );
    const [prior] = await tx
      .select()
      .from(redactions)
      .where(
        and(
          eq(redactions.administratorId, userId),
          eq(redactions.requestKey, input.requestKey),
        ),
      );

    if (prior) {
      if (prior.revisionId !== revisionId || prior.reason !== input.reason)
        throw new MaisterError(
          "CONFLICT",
          "Redaction request key already belongs to another operation",
        );

      return { revisionId, redactionId: prior.id };
    }
    const [revision] = await tx
      .select()
      .from(revisions)
      .where(eq(revisions.id, revisionId));

    if (!revision || revision.contentSha256 === null) throw unavailableMemory();
    const vault = await lockVault(tx, revision.vaultId);
    const [existing] = await tx
      .select({ id: redactions.id })
      .from(redactions)
      .where(
        and(
          eq(redactions.vaultId, vault.id),
          eq(redactions.noteId, revision.noteId),
          eq(redactions.revisionId, revision.id),
        ),
      );

    if (existing)
      throw new MaisterError(
        "CONFLICT",
        "Memory revision was already redacted",
      );
    const [record] = await tx
      .insert(redactions)
      .values({
        vaultId: vault.id,
        noteId: revision.noteId,
        revisionId,
        administratorId: userId,
        requestKey: input.requestKey,
        reason: input.reason,
      })
      .returning({ id: redactions.id });

    if (!record)
      throw new MaisterError("CRASH", "Redaction receipt was not stored");

    await tombstoneRedactedHead(tx, vault, revision, userId, record.id);
    await removeDerivedVaultContent(tx, revisionId, {
      kind: "agent_vault_revision_v1",
      vaultId: vault.id,
      noteId: revision.noteId,
      revisionId,
      contentSha256: revision.contentSha256,
    });
    await tx
      .delete(payloads)
      .where(
        and(
          eq(payloads.vaultId, vault.id),
          eq(payloads.noteId, revision.noteId),
          eq(payloads.revisionId, revisionId),
        ),
      );

    return { revisionId, redactionId: record.id };
  });

  log.info({ ...receipt, userId }, "memory revision redacted");

  return receipt;
}
