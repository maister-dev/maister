import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

// Seeds for librarian suites. Raw SQL naming only the columns set here, so a
// suite replaying a partial migration point is not bound to the current shape.

export async function seedActiveUser(
  db: NodePgDatabase,
  input: { role?: "admin" | "member" | "viewer" } = {},
): Promise<string> {
  const id = randomUUID();

  await db.execute(sql`
    INSERT INTO "users" ("id", "email", "role", "account_status")
    VALUES (${id}, ${`${id}@example.test`}, ${input.role ?? "member"}, 'active')
  `);

  return id;
}

export async function addProjectMember(
  db: NodePgDatabase,
  input: {
    projectId: string;
    userId: string;
    role: "viewer" | "member" | "admin" | "owner";
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO "project_members" ("id", "project_id", "user_id", "role")
    VALUES (${randomUUID()}, ${input.projectId}, ${input.userId}, ${input.role})
  `);
}

export async function removeProjectMember(
  db: NodePgDatabase,
  input: { projectId: string; userId: string },
): Promise<void> {
  await db.execute(sql`
    DELETE FROM "project_members"
    WHERE "project_id" = ${input.projectId} AND "user_id" = ${input.userId}
  `);
}

// A durable RUNNING librarian turn a token can be bound to
// (`project_tokens_librarian_turn_fk`): a turn token verifies only while its
// turn runs. Creates the owner's conversation and first segment when missing,
// completes any turn still active there (one active turn per conversation),
// and gives the turn the context snapshot every running turn carries.
export async function seedLibrarianTurn(
  db: NodePgDatabase,
  ownerUserId: string,
): Promise<string> {
  const conversationId = randomUUID();

  await db.execute(sql`
    INSERT INTO "librarian_conversations" ("id", "user_id")
    VALUES (${conversationId}, ${ownerUserId})
    ON CONFLICT ("user_id") DO NOTHING
  `);
  const conversation = await db.execute(sql`
    SELECT "id", "current_segment_id" FROM "librarian_conversations"
    WHERE "user_id" = ${ownerUserId}
  `);
  const row = (
    conversation as unknown as {
      rows: { id: string; current_segment_id: string | null }[];
    }
  ).rows[0];
  let segmentId = row.current_segment_id;

  if (!segmentId) {
    segmentId = randomUUID();
    await db.execute(sql`
      INSERT INTO "librarian_segments" ("id", "conversation_id", "ordinal", "started_at")
      VALUES (${segmentId}, ${row.id}, 0, now())
    `);
    await db.execute(sql`
      UPDATE "librarian_conversations" SET "current_segment_id" = ${segmentId}
      WHERE "id" = ${row.id}
    `);
  }
  await db.execute(sql`
    UPDATE "librarian_turns" SET "status" = 'completed', "ended_at" = now()
    WHERE "conversation_id" = ${row.id} AND "status" IN ('admitted', 'running')
  `);
  const turnId = randomUUID();
  const snapshotId = randomUUID();

  await db.execute(sql`
    INSERT INTO "librarian_turns" ("id", "conversation_id", "segment_id", "variant", "status")
    VALUES (${turnId}, ${row.id}, ${segmentId}, 'owner_message', 'queued')
  `);
  await db.execute(sql`
    INSERT INTO "librarian_context_snapshots"
      ("id", "turn_id", "instructions_version", "message_ids", "summary_revisions",
       "memory_item_revisions", "authz_fingerprint", "context_epoch", "char_count", "truncated")
    VALUES (${snapshotId}, ${turnId}, 'seed', '{}'::text[], '{}'::jsonb, '{}'::jsonb,
            'seed', 0, 0, false)
  `);
  await db.execute(sql`
    UPDATE "librarian_turns"
    SET "status" = 'running', "context_snapshot_id" = ${snapshotId},
        "admitted_at" = now(), "started_at" = now()
    WHERE "id" = ${turnId}
  `);

  return turnId;
}

// Ends a seeded turn by another path than revocation (a stop, a deadline, a
// host loss), leaving its token row unrevoked.
export async function endLibrarianTurn(
  db: NodePgDatabase,
  turnId: string,
  status: "stopped" | "completed" = "stopped",
): Promise<void> {
  await db.execute(sql`
    UPDATE "librarian_turns" SET "status" = ${status}, "ended_at" = now()
    WHERE "id" = ${turnId}
  `);
}

// A ready, eligible librarian runner and the platform settings singleton that
// names it. `enabled: false` or `ready: false` model the admin's refusals.
export async function seedLibrarianPlatform(
  db: NodePgDatabase,
  input: { enabled?: boolean; ready?: boolean; runnerId?: string } = {},
): Promise<{ runnerId: string }> {
  const runnerId = input.runnerId ?? `librarian-runner-${randomUUID()}`;

  await db.execute(sql`
    INSERT INTO "platform_acp_runners"
      ("id", "adapter", "capability_agent", "model", "provider", "permission_policy",
       "readiness_status", "readiness_reasons", "enabled")
    VALUES (${runnerId}, 'claude', 'claude', 'claude-sonnet-4-6', '{"kind":"anthropic"}'::jsonb,
            'default', ${input.ready === false ? "NotReady" : "Ready"}, '[]'::jsonb, true)
    ON CONFLICT ("id") DO UPDATE SET "readiness_status" = EXCLUDED."readiness_status"
  `);
  await db.execute(sql`
    INSERT INTO "platform_runtime_settings"
      ("id", "default_runner_id", "librarian_enabled", "librarian_runner_id")
    VALUES ('singleton', ${runnerId}, ${input.enabled ?? true}, ${runnerId})
    ON CONFLICT ("id") DO UPDATE SET
      "librarian_enabled" = EXCLUDED."librarian_enabled",
      "librarian_runner_id" = EXCLUDED."librarian_runner_id"
  `);

  return { runnerId };
}
