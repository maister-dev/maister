import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { issueLibrarianTurnToken } from "@/lib/librarian/authority";
import {
  admitLibrarianOperation,
  reconcileAdmittedLibrarianOperations,
  settleLibrarianOperation,
} from "@/lib/librarian/operations";
import { recordRequiredTokenAudit } from "@/lib/tokens/ext-handler";
import { seedProject, seedRun } from "@/test-support/execution-host-seed";
import { seedActiveUser } from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: ReturnType<typeof getDb>;

async function seedTurn(): Promise<{
  conversationId: string;
  segmentId: string;
  turnId: string;
  userId: string;
}> {
  const userId = await seedActiveUser(db as unknown as NodePgDatabase);
  const conversationId = randomUUID();
  const segmentId = randomUUID();
  const turnId = randomUUID();

  await db.execute(
    sql`INSERT INTO librarian_conversations (id, user_id) VALUES (${conversationId}, ${userId})`,
  );
  await db.execute(sql`
    INSERT INTO librarian_segments (id, conversation_id, ordinal, started_at)
    VALUES (${segmentId}, ${conversationId}, 0, now())
  `);
  await db.execute(sql`
    INSERT INTO librarian_turns
      (id, conversation_id, segment_id, variant, status, context_snapshot_id)
    VALUES (${turnId}, ${conversationId}, ${segmentId}, 'owner_message', 'running', ${randomUUID()})
  `);

  return { conversationId, segmentId, turnId, userId };
}

function operationInput(
  seed: Awaited<ReturnType<typeof seedTurn>>,
  key: string,
) {
  return {
    conversationId: seed.conversationId,
    segmentId: seed.segmentId,
    turnId: seed.turnId,
    idempotencyKey: key,
    kind: "task_create",
    target: { projectId: "project-1" },
    body: { title: "A", prompt: "B" },
    allowDuplicate: false,
  };
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_operations",
  });
  db = database.db as unknown as ReturnType<typeof getDb>;
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("librarian operation ledger", () => {
  it("IT-EDGE-LOP-01: racing same-key admissions share one stored receipt and one task effect", async () => {
    const seed = await seedTurn();
    const input = operationInput(seed, `racing-${randomUUID()}`);
    const [first, second] = await Promise.all([
      admitLibrarianOperation(input, db),
      admitLibrarianOperation(input, db),
    ]);

    expect(second.id).toBe(first.id);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    await settleLibrarianOperation(
      {
        id: first.id,
        result: { statusCode: 201, body: { taskId: "task-result" } },
      },
      db,
    );
    const replay = await admitLibrarianOperation(input, db);

    expect(replay).toMatchObject({
      id: first.id,
      reused: true,
      status: "succeeded",
      result: { statusCode: 201, body: { taskId: "task-result" } },
    });
    const projectId = await seedProject(db as unknown as NodePgDatabase);

    await db.execute(sql`INSERT INTO tasks (id, project_id, number, title, prompt, created_via_operation_id)
      VALUES (${randomUUID()}, ${projectId}, 1, 'First', 'First', ${first.id})`);
    await expect(
      db.execute(sql`INSERT INTO tasks (id, project_id, number, title, prompt, created_via_operation_id)
      VALUES (${randomUUID()}, ${projectId}, 2, 'Second', 'Second', ${first.id})`),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("IT-EDGE-LOP-02: a retry reuses completed batch items and leaves only the unsettled item admitted", async () => {
    const seed = await seedTurn();
    const firstInput = operationInput(seed, `batch-first-${randomUUID()}`);
    const secondInput = {
      ...operationInput(seed, `batch-second-${randomUUID()}`),
      body: { title: "Second", prompt: "B" },
    };
    const first = await admitLibrarianOperation(firstInput, db);
    const second = await admitLibrarianOperation(secondInput, db);

    expect(first.id).not.toBe(second.id);
    await settleLibrarianOperation(
      {
        id: first.id,
        result: { statusCode: 201, body: { taskId: "first-result" } },
      },
      db,
    );
    const [firstRetry, secondRetry] = await Promise.all([
      admitLibrarianOperation(firstInput, db),
      admitLibrarianOperation(secondInput, db),
    ]);

    expect(firstRetry).toMatchObject({
      id: first.id,
      reused: true,
      status: "succeeded",
      result: { body: { taskId: "first-result" } },
    });
    expect(secondRetry).toMatchObject({
      id: second.id,
      reused: true,
      status: "admitted",
      result: null,
    });
  });

  it("IT-LOP-02: reuses the same key and digest, refuses changed or duplicate effects", async () => {
    const seed = await seedTurn();
    const input = operationInput(seed, "create-1");
    const first = await admitLibrarianOperation(input, db);
    const replay = await admitLibrarianOperation(
      { ...input, body: { prompt: "B", title: "A" } },
      db,
    );

    expect(replay).toMatchObject({
      id: first.id,
      reused: true,
      status: "admitted",
    });
    await expect(
      admitLibrarianOperation({ ...input, body: { title: "Changed" } }, db),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "idempotency_payload_mismatch" },
    });

    await settleLibrarianOperation(
      { id: first.id, result: { statusCode: 201, body: { taskId: "t" } } },
      db,
    );
    await expect(
      admitLibrarianOperation({ ...input, idempotencyKey: "create-2" }, db),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "duplicate_of_operation" },
    });

    const explicitlyRepeated = await admitLibrarianOperation(
      { ...input, idempotencyKey: "create-3", allowDuplicate: true },
      db,
    );

    expect(explicitlyRepeated.reused).toBe(false);
  });

  it("IT-LOP-01/03: effect, audit, and settlement roll back together, then reconcile", async () => {
    const seed = await seedTurn();
    const projectId = await seedProject(db as unknown as NodePgDatabase);
    const taskId = randomUUID();
    const operation = await admitLibrarianOperation(
      operationInput(seed, "rollback-1"),
      db,
    );
    const token = await issueLibrarianTurnToken(
      {
        ownerUserId: seed.userId,
        turnId: seed.turnId,
        scopes: ["tasks:create"],
        expiresAt: new Date(Date.now() + 60_000),
      },
      db,
    );

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`
        INSERT INTO tasks (id, project_id, number, title, prompt, created_via_operation_id)
        VALUES (${taskId}, ${projectId}, 1, 'A', 'B', ${operation.id})
      `);
        await recordRequiredTokenAudit(
          {
            tokenId: token.tokenId,
            projectId,
            actorLabel: "librarian",
            scopeUsed: "tasks:create",
            endpoint: "POST /ext/tasks",
            method: "POST",
            result: "ok",
            statusCode: 201,
            operationId: operation.id,
            operation: {
              id: operation.id,
              result: { statusCode: 201, body: { taskId } },
            },
          },
          tx,
        );
        throw new MaisterError("CRASH", "injected failure after domain write");
      }),
    ).rejects.toMatchObject({ code: "CRASH" });

    const taskRows = await db.execute(
      sql`SELECT id FROM tasks WHERE id = ${taskId}`,
    );
    const auditRows = await db.execute(
      sql`SELECT id FROM token_audit_log WHERE operation_id = ${operation.id}`,
    );
    const operationRows = await db.execute(
      sql`SELECT status FROM librarian_operations WHERE id = ${operation.id}`,
    );

    expect(taskRows.rows).toHaveLength(0);
    expect(auditRows.rows).toHaveLength(0);
    expect(operationRows.rows[0]?.status).toBe("admitted");

    await reconcileAdmittedLibrarianOperations(
      new Date(Date.now() + 1_000),
      db,
    );

    const settledRows = await db.execute(
      sql`SELECT status, error_code FROM librarian_operations WHERE id = ${operation.id}`,
    );

    expect(settledRows.rows[0]).toMatchObject({
      status: "failed",
      error_code: "not_applied",
    });
  });

  it("IT-LOP-03: an admitted launch with a committed run is recovered by its operation id", async () => {
    const seed = await seedTurn();
    const projectId = await seedProject(db as unknown as NodePgDatabase);
    const operation = await admitLibrarianOperation(
      {
        ...operationInput(seed, "recover-launch-1"),
        kind: "run_launch",
        body: { taskId: "task-1" },
      },
      db,
    );
    const runId = await seedRun(db as unknown as NodePgDatabase, {
      projectId,
      status: "Pending",
    });

    await db.execute(
      sql`UPDATE runs SET librarian_operation_id = ${operation.id} WHERE id = ${runId}`,
    );
    await reconcileAdmittedLibrarianOperations(
      new Date(Date.now() + 1_000),
      db,
    );
    const rows = await db.execute(
      sql`SELECT status, result FROM librarian_operations WHERE id = ${operation.id}`,
    );

    expect(rows.rows[0]?.status).toBe("succeeded");
    expect(rows.rows[0]?.result).toMatchObject({ body: { runId } });
  });
});
