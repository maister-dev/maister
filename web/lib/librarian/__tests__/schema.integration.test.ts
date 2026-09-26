import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedLocalHost, seedProject } from "@/test-support/execution-host-seed";
import { seedActiveUser } from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-183 / ADR-188 (migrations 0182, 0183): the conversation, turn and run
// invariants the librarian relies on are database constraints, so a buggy
// writer is refused rather than trusted.

let database: StartedPostgresTestDb;
let db: NodePgDatabase;

type PgErrorLike = { constraint?: string; cause?: { constraint?: string } };

function constraintOf(err: unknown): string | undefined {
  const e = err as PgErrorLike;

  return e?.constraint ?? e?.cause?.constraint;
}

async function refusal(statement: ReturnType<typeof sql>): Promise<unknown> {
  try {
    await db.execute(statement);

    return null;
  } catch (err) {
    return err;
  }
}

async function seedConversation(): Promise<{
  userId: string;
  conversationId: string;
  segmentId: string;
}> {
  const userId = await seedActiveUser(db);
  const conversationId = randomUUID();
  const segmentId = randomUUID();

  await db.execute(sql`
    INSERT INTO librarian_conversations (id, user_id) VALUES (${conversationId}, ${userId})
  `);
  await db.execute(sql`
    INSERT INTO librarian_segments (id, conversation_id, ordinal, started_at)
    VALUES (${segmentId}, ${conversationId}, 0, now())
  `);

  return { userId, conversationId, segmentId };
}

function insertTurn(input: {
  conversationId: string;
  segmentId: string;
  status: string;
  variant?: string;
  snapshotId?: string | null;
  failureReason?: string | null;
}) {
  return sql`
    INSERT INTO librarian_turns
      (id, conversation_id, segment_id, variant, status, context_snapshot_id, failure_reason)
    VALUES
      (${randomUUID()}, ${input.conversationId}, ${input.segmentId},
       ${input.variant ?? "owner_message"}, ${input.status},
       ${input.snapshotId ?? null}, ${input.failureReason ?? null})
  `;
}

function insertRun(input: {
  runKind: string;
  projectId?: string | null;
  persistent?: boolean;
  createdByUserId?: string | null;
  agentWorkspace?: string | null;
  id?: string;
}) {
  return sql`
    INSERT INTO runs
      (id, project_id, run_kind, status, flow_version, persistent,
       created_by_user_id, agent_workspace, execution_data_plane_mode)
    VALUES
      (${input.id ?? randomUUID()}, ${input.projectId ?? null}, ${input.runKind},
       'NeedsInputIdle', 'librarian', ${input.persistent ?? true},
       ${input.createdByUserId ?? null}, ${input.agentWorkspace ?? null},
       'canonical_events_v1')
  `;
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_schema",
  });
  db = database.db as unknown as NodePgDatabase;
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("IT-LCV-01: one conversation per user", () => {
  it("refuses a second conversation for the same user", async () => {
    const { userId } = await seedConversation();
    const err = await refusal(sql`
      INSERT INTO librarian_conversations (id, user_id) VALUES (${randomUUID()}, ${userId})
    `);

    expect(constraintOf(err)).toBe("librarian_conversations_user_uq");
  });

  it("refuses an unknown reset state", async () => {
    const { conversationId } = await seedConversation();
    const err = await refusal(sql`
      UPDATE librarian_conversations SET reset_state = 'wiping' WHERE id = ${conversationId}
    `);

    expect(constraintOf(err)).toBe("librarian_conversations_reset_state_check");
  });

  it("refuses a reused seq and a reused client message id", async () => {
    const { conversationId, segmentId } = await seedConversation();
    const clientId = randomUUID();
    const message = (seq: number, client: string | null) => sql`
      INSERT INTO librarian_messages
        (id, conversation_id, segment_id, seq, author_kind, client_message_id, body)
      VALUES (${randomUUID()}, ${conversationId}, ${segmentId}, ${seq}, 'owner', ${client}, 'hi')
    `;

    await db.execute(message(1, clientId));
    expect(constraintOf(await refusal(message(1, null)))).toBe(
      "librarian_messages_seq_uq",
    );
    expect(constraintOf(await refusal(message(2, clientId)))).toBe(
      "librarian_messages_client_id_uq",
    );
    // Messages without a client id never collide on it.
    await db.execute(message(3, null));
    await db.execute(message(4, null));
  });
});

describe("Phase 3 database invariants", () => {
  it("IT-TST-01: accepted statement revisions refuse updates and deletes", async () => {
    const projectId = await seedProject(db);
    const taskId = randomUUID();

    await db.execute(sql`
      INSERT INTO tasks (id, project_id, number, title, prompt)
      VALUES (${taskId}, ${projectId}, 1, 'Statement task', 'Original prompt')
    `);
    await db.execute(sql`
      INSERT INTO task_statement_revisions
        (task_id, revision, statement, author_actor_type)
      VALUES (${taskId}, 1, '{"goal":"Ship"}'::jsonb, 'user')
    `);

    const updateError = await refusal(sql`
      UPDATE task_statement_revisions SET statement = '{"goal":"Changed"}'::jsonb
      WHERE task_id = ${taskId} AND revision = 1
    `);
    const deleteError = await refusal(sql`
      DELETE FROM task_statement_revisions WHERE task_id = ${taskId} AND revision = 1
    `);

    expect(constraintOf(updateError)).toBe("task_statement_revisions_immutable");
    expect(constraintOf(deleteError)).toBe("task_statement_revisions_immutable");
  });

  it("IT-LOP-02: a conversation cannot reuse an operation key", async () => {
    const { conversationId, segmentId } = await seedConversation();

    await db.execute(sql`
      INSERT INTO librarian_operations
        (id, conversation_id, segment_id, idempotency_key, kind, request_digest, target, status)
      VALUES
        (${randomUUID()}, ${conversationId}, ${segmentId}, 'same-key', 'task_create', 'digest-1', '{}'::jsonb, 'admitted')
    `);

    const duplicateError = await refusal(sql`
      INSERT INTO librarian_operations
        (id, conversation_id, segment_id, idempotency_key, kind, request_digest, target, status)
      VALUES
        (${randomUUID()}, ${conversationId}, ${segmentId}, 'same-key', 'task_create', 'digest-2', '{}'::jsonb, 'admitted')
    `);

    expect(constraintOf(duplicateError)).toBe("librarian_operations_key_uq");
  });
});

describe("IT-LCV-03 part 1: at most one active turn per conversation", () => {
  it("refuses a second admitted or running turn", async () => {
    const { conversationId, segmentId } = await seedConversation();

    await db.execute(
      insertTurn({ conversationId, segmentId, status: "admitted" }),
    );
    const err = await refusal(
      insertTurn({
        conversationId,
        segmentId,
        status: "running",
        snapshotId: randomUUID(),
      }),
    );

    expect(constraintOf(err)).toBe("librarian_turns_one_active_uq");
    // Queued turns wait behind the active one without colliding.
    await db.execute(
      insertTurn({ conversationId, segmentId, status: "queued" }),
    );
    await db.execute(
      insertTurn({ conversationId, segmentId, status: "queued" }),
    );
  });

  it("refuses a second pending summary turn in one segment", async () => {
    const { conversationId, segmentId } = await seedConversation();

    await db.execute(
      insertTurn({
        conversationId,
        segmentId,
        status: "queued",
        variant: "summary",
      }),
    );
    const err = await refusal(
      insertTurn({
        conversationId,
        segmentId,
        status: "queued",
        variant: "summary",
      }),
    );

    expect(constraintOf(err)).toBe("librarian_turns_one_summary_uq");
  });
});

describe("IT-LCV-07 part 1: a running turn always has its context snapshot", () => {
  it("refuses a running turn without a snapshot and a failed turn without a reason", async () => {
    const { conversationId, segmentId } = await seedConversation();

    expect(
      constraintOf(
        await refusal(
          insertTurn({ conversationId, segmentId, status: "running" }),
        ),
      ),
    ).toBe("librarian_turns_running_has_snapshot_check");
    expect(
      constraintOf(
        await refusal(
          insertTurn({ conversationId, segmentId, status: "failed" }),
        ),
      ),
    ).toBe("librarian_turns_failed_has_reason_check");
    await db.execute(
      insertTurn({
        conversationId,
        segmentId,
        status: "failed",
        failureReason: "host_lost",
      }),
    );
  });

  it("deletes a turn's token with the turn", async () => {
    const { userId, conversationId, segmentId } = await seedConversation();
    const turnId = randomUUID();

    await db.execute(sql`
      INSERT INTO librarian_turns (id, conversation_id, segment_id, variant, status)
      VALUES (${turnId}, ${conversationId}, ${segmentId}, 'owner_message', 'queued')
    `);
    await db.execute(sql`
      INSERT INTO project_tokens
        (id, name, token_kind, owner_user_id, librarian_turn_id, prefix, token_hash, scopes, expires_at)
      VALUES (${randomUUID()}, ${`librarian-turn:${turnId}`}, 'librarian', ${userId}, ${turnId},
              'mst_x', 'h', '["tasks:read"]'::jsonb, now() + interval '5 minutes')
    `);
    await db.execute(sql`DELETE FROM librarian_turns WHERE id = ${turnId}`);
    const rows = await db.execute(sql`
      SELECT count(*)::int AS n FROM project_tokens WHERE librarian_turn_id = ${turnId}
    `);

    expect((rows as unknown as { rows: { n: number }[] }).rows[0].n).toBe(0);
  });

  it("refuses a token bound to a turn that does not exist", async () => {
    const userId = await seedActiveUser(db);
    const err = await refusal(sql`
      INSERT INTO project_tokens
        (id, name, token_kind, owner_user_id, librarian_turn_id, prefix, token_hash, scopes, expires_at)
      VALUES (${randomUUID()}, 'librarian-turn:x', 'librarian', ${userId}, ${randomUUID()},
              'mst_x', 'h', '["tasks:read"]'::jsonb, now() + interval '5 minutes')
    `);

    expect(constraintOf(err)).toBe("project_tokens_librarian_turn_fk");
  });
});

describe("IT-LCV-04 part 1: the librarian run shape is a database invariant", () => {
  it("accepts a project-less, persistent, owned, workspace-less librarian run", async () => {
    const userId = await seedActiveUser(db);

    await db.execute(
      insertRun({
        runKind: "librarian",
        createdByUserId: userId,
        agentWorkspace: "none",
      }),
    );
  });

  it("refuses a librarian run with a project, without persistence, owner or workspace axis", async () => {
    const userId = await seedActiveUser(db);
    const projectId = await seedProject(db);
    const shapes = [
      { projectId, createdByUserId: userId, agentWorkspace: "none" },
      { persistent: false, createdByUserId: userId, agentWorkspace: "none" },
      { createdByUserId: null, agentWorkspace: "none" },
      { createdByUserId: userId, agentWorkspace: null },
    ];

    for (const shape of shapes) {
      const err = await refusal(insertRun({ runKind: "librarian", ...shape }));

      expect(constraintOf(err)).toBe("runs_librarian_shape_check");
    }
  });

  it("refuses an unknown run kind", async () => {
    const err = await refusal(insertRun({ runKind: "assistant" }));

    expect(constraintOf(err)).toBe("runs_run_kind_check");
  });

  it("refuses a prompt command on a librarian run without an owner", async () => {
    const userId = await seedActiveUser(db);
    const runId = randomUUID();
    const host = await seedLocalHost(db);
    const assignmentId = randomUUID();

    await db.execute(
      insertRun({
        id: runId,
        runKind: "librarian",
        createdByUserId: userId,
        agentWorkspace: "none",
      }),
    );
    await db.execute(sql`
      INSERT INTO execution_assignments
        (id, run_id, execution_host_id, epoch, state, placement_reason)
      VALUES (${assignmentId}, ${runId}, ${host.id}, 1, 'active', 'librarian_turn')
    `);
    const err = await refusal(sql`
      INSERT INTO execution_commands
        (id, run_id, execution_assignment_id, execution_host_id, assignment_epoch,
         kind, target_session_id, max_attempts)
      VALUES (${randomUUID()}, ${runId}, ${assignmentId}, ${host.id}, 1,
              'session.prompt', 'sess_x', 1)
    `);

    expect(constraintOf(err)).toBe("execution_commands_prompt_owner_required");
  });
});
