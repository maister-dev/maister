import "server-only";

import type { PrepareVaultAccess, VaultRevision } from "./store";
import type { Db } from "@/lib/execution-host/db";

import { createHash } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { MAX_PAGE_ENTRIES } from "./limits";
import { lockVault, readVaultPayload, unavailableMemory } from "./store";

import { agentMemoryRevisions as revisions } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";

const namespace = "maister.agent-memory.history.v1";
const timestamp = sql<string>`to_char(${revisions.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const historyQuery = z.strictObject({
  noteId: z.string().min(1).max(192),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_ENTRIES).default(20),
});

type HistoryQuery = z.infer<typeof historyQuery>;

export function parseVaultHistory(value: unknown): HistoryQuery {
  const result = historyQuery.safeParse(value);

  if (!result.success)
    throw new MaisterError("CONFIG", "Invalid memory history query");

  return result.data;
}

async function describeRevision(db: Db, revision: VaultRevision) {
  const redaction = await db.execute(sql`
    SELECT 1 FROM agent_memory_redactions
    WHERE (vault_id,note_id,revision_id) = (${revision.vaultId},${revision.noteId},${revision.id})
  `);

  return {
    id: revision.id,
    noteId: revision.noteId,
    path: revision.path,
    hash: revision.contentSha256,
    state:
      redaction.rows.length > 0
        ? ("redacted" as const)
        : revision.contentSha256 === null
          ? ("tombstone" as const)
          : ("available" as const),
    createdAt: revision.createdAt.toISOString(),
  };
}

export async function vaultRevisionDetail(
  db: Db,
  revisionId: string,
  prepare: PrepareVaultAccess,
) {
  return db.transaction(async (tx) => {
    const access = await prepare(tx);

    await lockVault(tx, access.vaultId);
    const [row] = await tx
      .select()
      .from(revisions)
      .where(
        and(
          eq(revisions.vaultId, access.vaultId),
          eq(revisions.id, revisionId),
        ),
      );

    if (!row || !(await access.canRead(tx, row))) throw unavailableMemory();
    const revision = await describeRevision(tx, row);
    const content =
      revision.state === "available" ? await readVaultPayload(tx, row) : null;

    await access.capture(tx, revision.state === "redacted" ? [] : [row]);

    return { revision, content };
  });
}

export async function vaultHistory(
  db: Db,
  selection: HistoryQuery,
  prepare: PrepareVaultAccess,
) {
  return db.transaction(async (tx) => {
    const access = await prepare(tx);

    await lockVault(tx, access.vaultId);
    const scope = createHash("sha256")
      .update(
        JSON.stringify([
          access.vaultId,
          access.principalKey,
          selection.noteId,
          selection.limit,
        ]),
      )
      .digest("hex");
    const cursor = selection.cursor
      ? decodeKeysetCursor(namespace, selection.cursor, scope)
      : null;
    const { rows } = await tx.execute<{ now: string }>(sql`
      SELECT to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now
    `);
    const upper = cursor?.upper ?? rows[0]?.now;

    if (upper === undefined)
      throw new MaisterError(
        "CRASH",
        "No database timestamp for memory history",
      );
    const page: { revision: VaultRevision; preciseAt: string }[] = [];
    let boundary = cursor;

    while (page.length <= selection.limit) {
      const batch = await tx
        .select({ revision: revisions, preciseAt: timestamp })
        .from(revisions)
        .where(
          and(
            eq(revisions.vaultId, access.vaultId),
            eq(revisions.noteId, selection.noteId),
            sql`${revisions.createdAt} <= ${upper}::timestamptz`,
            boundary
              ? sql`(${revisions.createdAt},${revisions.id}) < (${boundary.at}::timestamptz,${boundary.id})`
              : undefined,
          ),
        )
        .orderBy(desc(revisions.createdAt), desc(revisions.id))
        .limit(MAX_PAGE_ENTRIES);

      for (const row of batch) {
        if (await access.canRead(tx, row.revision)) page.push(row);
        if (page.length > selection.limit) break;
      }
      const end = batch.at(-1);

      if (batch.length < MAX_PAGE_ENTRIES || !end) break;
      boundary = {
        version: 1,
        scope,
        upper,
        at: end.preciseAt,
        id: end.revision.id,
      };
    }

    const delivered = page.slice(0, selection.limit);
    const last = delivered.at(-1);

    if (!last && !cursor) throw unavailableMemory();
    const items = await Promise.all(
      delivered.map(({ revision }) => describeRevision(tx, revision)),
    );

    await access.capture(
      tx,
      delivered.flatMap(({ revision }, index) =>
        items[index]?.state === "redacted" ? [] : [revision],
      ),
    );

    return {
      items,
      nextCursor:
        page.length > delivered.length && last
          ? encodeKeysetCursor(namespace, {
              version: 1,
              scope,
              upper,
              at: last.preciseAt,
              id: last.revision.id,
            })
          : null,
    };
  });
}
