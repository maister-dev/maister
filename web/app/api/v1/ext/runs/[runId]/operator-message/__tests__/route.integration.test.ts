import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db/client";
import { acceptAgentMessage } from "@/lib/agents/turns";
import { issueLibrarianTurnToken } from "@/lib/librarian/authority";
import { seedProject, seedRun } from "@/test-support/execution-host-seed";
import { addProjectMember, seedActiveUser, seedLibrarianTurn } from "@/test-support/librarian-seed";
import { startMainPostgresTestDb, type StartedPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: ReturnType<typeof getDb>;
let post: typeof import("@/app/api/v1/ext/runs/[runId]/operator-message/route").POST;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "librarian_operator_message" });
  db = database.db as unknown as ReturnType<typeof getDb>;
  ({ POST: post } = await import("@/app/api/v1/ext/runs/[runId]/operator-message/route"));
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

async function fixture(role: "owner" | "viewer" = "owner") {
  const projectId = await seedProject(db as unknown as NodePgDatabase);
  const userId = await seedActiveUser(db as unknown as NodePgDatabase);
  await addProjectMember(db as unknown as NodePgDatabase, { projectId, userId, role });
  const turnId = await seedLibrarianTurn(db as unknown as NodePgDatabase, userId);
  const token = await issueLibrarianTurnToken({
    ownerUserId: userId,
    turnId,
    scopes: ["runs:message"],
    expiresAt: new Date(Date.now() + 60_000),
  }, db);

  return { projectId, userId, token: token.secret };
}

function request(runId: string, token: string, key: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/ext/runs/${runId}/operator-message`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ message: "Please check the latest result." }),
  });
}

describe("librarian operator message", () => {
  it("IT-LOP-10: a Flow returns a stable rework receipt and no run message", async () => {
    const owner = await fixture();
    const runId = await seedRun(db as unknown as NodePgDatabase, {
      projectId: owner.projectId,
      runKind: "flow",
    });
    const key = randomUUID();
    const first = await post(request(runId, owner.token, key), { params: Promise.resolve({ runId }) });
    const replay = await post(request(runId, owner.token, key), { params: Promise.resolve({ runId }) });

    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ runId, outcome: "refused_requires_rework" });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ runId, outcome: "refused_requires_rework" });
    const messages = await db.execute(sql`SELECT id FROM run_messages WHERE run_id = ${runId}`);
    expect(messages.rows).toHaveLength(0);
    const operations = await db.execute(sql`
      SELECT status FROM librarian_operations WHERE idempotency_key = ${key}
    `);
    expect(operations.rows).toEqual([{ status: "succeeded" }]);
  });

  it("IT-LOP-10: a viewer cannot send a message to a project run", async () => {
    const viewer = await fixture("viewer");
    const runId = await seedRun(db as unknown as NodePgDatabase, {
      projectId: viewer.projectId,
      runKind: "flow",
    });
    const response = await post(request(runId, viewer.token, randomUUID()), {
      params: Promise.resolve({ runId }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ details: { requiredAction: "launchRun" } });
  });

  it("IT-LOP-10: a scratch run owned by another user remains hidden", async () => {
    const owner = await fixture();
    const runId = await seedRun(db as unknown as NodePgDatabase, {
      projectId: owner.projectId,
      runKind: "scratch",
    });
    const response = await post(request(runId, owner.token, randomUUID()), {
      params: Promise.resolve({ runId }),
    });

    expect(response.status).toBe(404);
  });

  it("IT-LOP-10: an accepted persistent-agent message records its user source", async () => {
    const owner = await fixture();
    const runId = await seedRun(db as unknown as NodePgDatabase, {
      projectId: owner.projectId,
      runKind: "agent",
      status: "NeedsInputIdle",
    });
    await db.execute(sql`UPDATE runs SET persistent = true WHERE id = ${runId}`);

    const turn = await acceptAgentMessage(db, runId, "Please check the latest result.", {
      requestKey: randomUUID(),
      requestedByUserId: owner.userId,
    });
    const rows = await db.execute(sql`
      SELECT requested_by_user_id, state, variant FROM agent_turns WHERE id = ${turn.id}
    `);

    expect(rows.rows).toEqual([{
      requested_by_user_id: owner.userId,
      state: "queued",
      variant: "persistent_message",
    }]);
  });
});
