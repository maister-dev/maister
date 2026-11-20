import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";

import { indexMemoryRevision, resolveIndexedMemoryLinks } from "./indexes";
import { loadActiveHeads, lockVault, readVaultPayload } from "./store";

/** Restartable repair of existing heads after the main projection migration. */
export async function reindexLegacyVaultHeads(
  db: Db,
  budget = 50,
): Promise<number> {
  const batch = await db.execute<{ vault_id: string; note_id: string }>(sql`
    SELECT note.vault_id,note.id AS note_id
    FROM agent_memory_notes note
    WHERE note.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_memory_note_index projection
        WHERE (projection.vault_id,projection.note_id,projection.revision_id) =
              (note.vault_id,note.id,note.head_revision_id)
      )
    ORDER BY note.vault_id,note.id LIMIT ${budget}
  `);
  const byVault = new Map<string, Set<string>>();

  for (const { vault_id, note_id } of batch.rows) {
    const notes = byVault.get(vault_id) ?? new Set<string>();

    notes.add(note_id);
    byVault.set(vault_id, notes);
  }

  let refreshed = 0;

  for (const [vaultId, noteIds] of byVault) {
    refreshed += await db.transaction(async (tx) => {
      const vault = await lockVault(tx, vaultId);
      let count = 0;

      for (const { revision } of await loadActiveHeads(tx, vault.id)) {
        if (!noteIds.has(revision.noteId)) continue;
        const existing = await tx.execute(sql`
          SELECT 1 FROM agent_memory_note_index
          WHERE (vault_id,note_id,revision_id)=(${vault.id},${revision.noteId},${revision.id})
        `);

        if (existing.rows.length > 0) continue;
        await indexMemoryRevision(
          tx,
          revision,
          await readVaultPayload(tx, revision),
          "retain-legacy",
        );
        count++;
      }
      if (count > 0) await resolveIndexedMemoryLinks(tx, vault.id);

      return count;
    });
  }

  return refreshed;
}
