import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";

import {
  currentMemoryEmbeddingProfile,
  memoryEmbeddingsEnabled,
  memoryVectorLiteral,
} from "./embedding-profile";
import { reindexLegacyVaultHeads } from "./index-backfill";
import { lockVault } from "./store";

import { isMaisterError, MaisterError } from "@/lib/errors";

const log = pino({
  name: "agent-memory-index-sweep",
  level: process.env.LOG_LEVEL ?? "info",
});
const perTick = 12;
const maxAttempts = 5;
type Profile = Awaited<ReturnType<typeof currentMemoryEmbeddingProfile>>;
type Claim = {
  vault_id: string;
  note_id: string;
  revision_id: string;
  attempts: number;
  lease_token: string;
  content: string;
};

async function enqueueCurrentHeads(db: Db, profile: Profile) {
  await db.execute(sql`
    DELETE FROM agent_memory_embeddings e
    WHERE NOT EXISTS (
      SELECT 1 FROM agent_memory_notes note
      WHERE (note.vault_id,note.id,note.head_revision_id)=(e.vault_id,e.note_id,e.revision_id)
        AND note.deleted_at IS NULL
    ) OR (e.model,e.dimensions,e.generation)<>(${profile.model},${profile.dimensions},${profile.generation})
  `);
  await db.execute(sql`
    INSERT INTO agent_memory_embeddings(vault_id,note_id,revision_id,model,dimensions,generation)
    SELECT v.vault_id,v.note_id,v.revision_id,${profile.model},${profile.dimensions},${profile.generation}
    FROM agent_memory_note_index v
    JOIN agent_memory_notes note ON (note.vault_id,note.id,note.head_revision_id)=(v.vault_id,v.note_id,v.revision_id)
    WHERE v.state='ready' AND note.deleted_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM agent_memory_embeddings e
      WHERE (e.vault_id,e.note_id,e.revision_id,e.model,e.dimensions,e.generation) =
        (v.vault_id,v.note_id,v.revision_id,${profile.model},${profile.dimensions},${profile.generation})
    )
    ORDER BY v.vault_id,v.note_id LIMIT ${perTick}
    ON CONFLICT DO NOTHING
  `);
}

async function claimCurrentHead(
  db: Db,
  profile: Profile,
): Promise<Claim | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE agent_memory_embeddings SET state='poisoned',lease_token=NULL,lease_until=NULL
      WHERE state='pending' AND attempts>=${maxAttempts} AND lease_until<=clock_timestamp()
    `);
    const { rows } = await tx.execute<Claim>(sql`
      WITH due AS (
        SELECT e.vault_id,e.note_id,e.revision_id,payload.content
        FROM agent_memory_embeddings e
        JOIN agent_memory_notes n ON (n.vault_id,n.id,n.head_revision_id)=(e.vault_id,e.note_id,e.revision_id)
        JOIN agent_memory_revision_payloads payload
          ON (payload.vault_id,payload.note_id,payload.revision_id)=(e.vault_id,e.note_id,e.revision_id)
        WHERE (e.model,e.dimensions,e.generation)=(${profile.model},${profile.dimensions},${profile.generation})
          AND n.deleted_at IS NULL AND e.state='pending' AND e.attempts<${maxAttempts}
          AND e.next_attempt_at<=clock_timestamp() AND (e.lease_until IS NULL OR e.lease_until<=clock_timestamp())
        ORDER BY e.next_attempt_at,e.vault_id,e.note_id
        LIMIT 1 FOR UPDATE OF e SKIP LOCKED
      )
      UPDATE agent_memory_embeddings e
      SET attempts=e.attempts+1, lease_token=${randomUUID()},
          lease_until=clock_timestamp()+interval '3 minutes'
      FROM due
      WHERE (e.vault_id,e.note_id,e.revision_id,e.model,e.dimensions,e.generation) =
            (due.vault_id,due.note_id,due.revision_id,${profile.model},${profile.dimensions},${profile.generation})
      RETURNING e.vault_id,e.note_id,e.revision_id,e.attempts,e.lease_token,due.content
    `);

    return rows[0];
  });
}

function ownedJob(profile: Profile, claim: Claim) {
  return sql`e.vault_id=${claim.vault_id} AND e.note_id=${claim.note_id}
    AND e.revision_id=${claim.revision_id} AND e.model=${profile.model} AND e.dimensions=${profile.dimensions}
    AND e.generation=${profile.generation} AND e.lease_token=${claim.lease_token}
    AND e.state='pending' AND e.lease_until>clock_timestamp()`;
}

async function settleVector(
  db: Db,
  profile: Profile,
  claim: Claim,
  values: readonly number[],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockVault(tx, claim.vault_id);
    const liveProfile = await currentMemoryEmbeddingProfile(tx);
    if (liveProfile.generation !== profile.generation) return false;
    const { rows } = await tx.execute(sql`
      UPDATE agent_memory_embeddings e
      SET vector=${memoryVectorLiteral(values)}::vector,state='ready',lease_token=NULL,lease_until=NULL
      WHERE ${ownedJob(profile, claim)}
        AND EXISTS (
          SELECT 1 FROM agent_memory_notes n JOIN agent_memory_revision_payloads p
            ON (n.vault_id,n.id,n.head_revision_id)=(p.vault_id,p.note_id,p.revision_id)
          WHERE (n.vault_id,n.id,n.head_revision_id)=(e.vault_id,e.note_id,e.revision_id)
            AND n.deleted_at IS NULL
        ) RETURNING e.revision_id
    `);

    return rows.length > 0;
  });
}

async function retryVector(
  db: Db,
  profile: Profile,
  claim: Claim,
  error: unknown,
) {
  const code = isMaisterError(error) ? error.code : "CRASH";
  const poisoned = claim.attempts >= maxAttempts;
  await db.execute(sql`
    UPDATE agent_memory_embeddings e
    SET state=${poisoned ? "poisoned" : "pending"},
        lease_token=NULL, lease_until=NULL, next_attempt_at=clock_timestamp()+(${2 ** claim.attempts} * interval '1 minute')
    WHERE ${ownedJob(profile, claim)}
  `);
  log.warn(
    {
      vaultId: claim.vault_id,
      revisionId: claim.revision_id,
      code,
      attempts: claim.attempts,
      poisoned,
    },
    "memory embedding job failed",
  );
}

export async function runMemoryIndexSweep(
  db: Db,
): Promise<{ indexed: number; embedded: number; failed: number }> {
  const indexed = await reindexLegacyVaultHeads(db);
  if (!memoryEmbeddingsEnabled()) return { indexed, embedded: 0, failed: 0 };
  const profile = await currentMemoryEmbeddingProfile(db);

  await enqueueCurrentHeads(db, profile);
  let embedded = 0;
  let failed = 0;
  for (let item = 0; item < perTick; item++) {
    const claim = await claimCurrentHead(db, profile);
    if (!claim) break;
    try {
      const values = (await profile.client.embed([claim.content]))[0];
      if (!values)
        throw new MaisterError(
          "EMBEDDING_UNAVAILABLE",
          "Provider returned no note vector",
        );
      if (await settleVector(db, profile, claim, values)) embedded++;
    } catch (error) {
      await retryVector(db, profile, claim, error);
      failed++;
    }
  }

  return { indexed, embedded, failed };
}
