import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db/client";
import {
  agents,
  librarianCards,
  librarianConversations,
  librarianOperations,
  librarianTaskLinks,
  taskStatementRevisions,
  tasks,
} from "@/lib/db/schema";
import { issueAgentRunToken } from "@/lib/agents/tokens";
import { issueLibrarianTurnToken } from "@/lib/librarian/authority";
import { decideLibrarianCard } from "@/lib/librarian/card-decisions";
import { getLinkedWork } from "@/lib/librarian/read-models";
import { librarianIndicator } from "@/lib/librarian/view";
import {
  forgetPersonalMemory,
  listPersonalMemory,
} from "@/lib/librarian/memory";
import { seedProject, seedRun } from "@/test-support/execution-host-seed";
import {
  addProjectMember,
  removeProjectMember,
  seedActiveUser,
  seedLibrarianTurn,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: ReturnType<typeof getDb>;
let proposePost: typeof import("@/app/api/v1/ext/librarian/cards/route").POST;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/services/hitl", () => ({
  respondToHitl: vi.fn(async () => ({ status: 409 })),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "librarian_cards" });
  db = database.db as unknown as ReturnType<typeof getDb>;
  ({ POST: proposePost } = await import(
    "@/app/api/v1/ext/librarian/cards/route"
  ));
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("IT-LMM-01/06: memory suggestion needs owner acceptance", () => {
  it("persists only after acceptance and refuses a forgotten exact suggestion", async () => {
    const owner = await fixture();
    const request = (allowDuplicate = false) =>
      new NextRequest("http://localhost/api/v1/ext/librarian/cards", {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.token}`,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          ...(allowDuplicate ? { "X-Maister-Allow-Duplicate": "true" } : {}),
        },
        body: JSON.stringify({
          action: "memory_suggest",
          memory: {
            kind: "preference",
            content: "Use brief updates",
            scope: "general",
          },
        }),
      });
    const proposed = await proposePost(request());

    expect(proposed.status).toBe(201);
    const { cardId } = (await proposed.json()) as { cardId: string };

    expect((await listPersonalMemory(owner.userId, db)).items).toHaveLength(0);
    const linked = await getLinkedWork(owner.userId, db);

    expect(linked.cards.find((card) => card.id === cardId)).toMatchObject({
      kind: "memory_suggestion",
      available: true,
      status: "pending",
    });
    const decided = await decideLibrarianCard(
      {
        cardId,
        user: { id: owner.userId, role: "member" },
        decision: "accept",
      },
      db,
    );

    expect(decided.body.status).toBe("accepted");
    const [item] = (await listPersonalMemory(owner.userId, db)).items;

    expect(item).toMatchObject({
      content: "Use brief updates",
      origin: "accepted_suggestion",
    });
    await forgetPersonalMemory(owner.userId, item.id, db);
    const repeated = await proposePost(request(true));

    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({
      details: { reason: "forgotten_memory" },
    });
    expect((await listPersonalMemory(owner.userId, db)).items).toHaveLength(0);
  });
});

async function fixture() {
  const projectId = await seedProject(db as unknown as NodePgDatabase);
  const userId = await seedActiveUser(db as unknown as NodePgDatabase);

  await addProjectMember(db as unknown as NodePgDatabase, {
    projectId,
    userId,
    role: "owner",
  });
  const turnId = await seedLibrarianTurn(
    db as unknown as NodePgDatabase,
    userId,
  );
  const token = await issueLibrarianTurnToken(
    {
      ownerUserId: userId,
      turnId,
      scopes: ["librarian:cards"],
      expiresAt: new Date(Date.now() + 60_000),
    },
    db,
  );
  const taskId = randomUUID();

  await db.execute(sql`
    INSERT INTO tasks (id, project_id, number, title, prompt, status, stage)
    VALUES (${taskId}, ${projectId}, 1, 'Card task', 'Original', 'Backlog', 'Backlog')
  `);

  return { projectId, userId, token: token.secret, taskId };
}

const statement = {
  context: "Current state",
  goal: "Improve it",
  acceptance: ["Done"],
  constraints: [],
  outOfScope: [],
  links: [],
  openQuestions: [],
};

function proposalRequest(
  token: string,
  taskId: string,
  expectedRevision: number,
): NextRequest {
  return new NextRequest("http://localhost/api/v1/ext/librarian/cards", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({
      action: "statement_accept",
      taskId,
      expectedRevision,
      statement,
    }),
  });
}

describe("librarian statement cards", () => {
  it("IT-LAU-04: an agent token cannot propose an owner confirmation card", async () => {
    const owner = await fixture();
    const agentId = `pkg:card-agent-${randomUUID()}`;

    await db.insert(agents).values({
      id: agentId,
      packageName: "pkg",
      versionLabel: "v1.0.0",
      origin: "git",
      name: "Card test agent",
      description: "fixture",
      workspace: "none",
      mode: "session",
      triggers: [],
      riskTier: "read_only",
      sourcePath: "maister-agents/card-test.md",
    });
    const agent = await issueAgentRunToken({
      agentId,
      projectId: owner.projectId,
      runId: randomUUID(),
      db,
    });

    await db.execute(
      sql`UPDATE project_tokens SET scopes = '["*"]'::jsonb WHERE id = ${agent.tokenId}`,
    );
    const response = await proposePost(
      proposalRequest(agent.secret, owner.taskId, 0),
    );

    expect(response.status).toBe(403);
    const cards = await db
      .select()
      .from(librarianCards)
      .innerJoin(
        librarianConversations,
        eq(librarianConversations.id, librarianCards.conversationId),
      )
      .where(eq(librarianConversations.userId, owner.userId));

    expect(cards).toHaveLength(0);
  });

  it("IT-LOP-08/09: revision drift refuses acceptance; a fresh card applies once as the user", async () => {
    const owner = await fixture();
    const first = await proposePost(
      proposalRequest(owner.token, owner.taskId, 0),
    );

    expect(first.status).toBe(201);
    const firstCardId = (await first.json()).cardId as string;

    await db.execute(
      sql`UPDATE tasks SET revision = revision + 1 WHERE id = ${owner.taskId}`,
    );

    await expect(
      decideLibrarianCard(
        {
          cardId: firstCardId,
          user: { id: owner.userId, role: "member" },
          decision: "accept",
          expectedRevision: 0,
        },
        db,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "target_changed" },
    });
    const unchanged = await db
      .select({ prompt: tasks.prompt })
      .from(tasks)
      .where(eq(tasks.id, owner.taskId));

    expect(unchanged[0].prompt).toBe("Original");

    const second = await proposePost(
      proposalRequest(owner.token, owner.taskId, 1),
    );

    expect(second.status).toBe(201);
    const secondCardId = (await second.json()).cardId as string;
    const accepted = await decideLibrarianCard(
      {
        cardId: secondCardId,
        user: { id: owner.userId, role: "member" },
        decision: "accept",
        expectedRevision: 1,
      },
      db,
    );
    const replay = await decideLibrarianCard(
      {
        cardId: secondCardId,
        user: { id: owner.userId, role: "member" },
        decision: "accept",
        expectedRevision: 1,
      },
      db,
    );

    expect(accepted.statusCode).toBe(200);
    expect(replay).toEqual(accepted);
    const [revision] = await db
      .select()
      .from(taskStatementRevisions)
      .where(eq(taskStatementRevisions.taskId, owner.taskId));

    expect(revision).toMatchObject({
      revision: 1,
      authorActorType: "user",
      authorActorId: owner.userId,
    });
    const [card] = await db
      .select()
      .from(librarianCards)
      .where(eq(librarianCards.id, secondCardId));

    expect(card.status).toBe("accepted");
    const operations = await db
      .select()
      .from(librarianOperations)
      .where(eq(librarianOperations.idempotencyKey, `card:${secondCardId}`));

    expect(operations).toHaveLength(1);
    expect(operations[0].status).toBe("succeeded");
  });

  it("IT-LOP-08: an expired card is no longer actionable", async () => {
    const owner = await fixture();
    const proposed = await proposePost(
      proposalRequest(owner.token, owner.taskId, 0),
    );
    const cardId = (await proposed.json()).cardId as string;

    await db
      .update(librarianCards)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(librarianCards.id, cardId));

    const linked = await getLinkedWork(owner.userId, db);

    expect(linked.cards[0].status).toBe("expired");
    const [conversation] = await db
      .select()
      .from(librarianConversations)
      .where(eq(librarianConversations.userId, owner.userId));

    expect(await librarianIndicator(db, conversation)).toBe("running");
    await expect(
      decideLibrarianCard(
        {
          cardId,
          user: { id: owner.userId, role: "member" },
          decision: "accept",
          expectedRevision: 0,
        },
        db,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "target_changed" },
    });
    const [task] = await db
      .select({ prompt: tasks.prompt })
      .from(tasks)
      .where(eq(tasks.id, owner.taskId));

    expect(task.prompt).toBe("Original");
  });

  it("IT-TST-08: receipts use current run status and revoked task links become unavailable", async () => {
    const owner = await fixture();
    const runId = await seedRun(db as unknown as NodePgDatabase, {
      projectId: owner.projectId,
      status: "Pending",
    });
    const [conversation] = await db
      .select({ id: librarianConversations.id })
      .from(librarianConversations)
      .where(eq(librarianConversations.userId, owner.userId));

    await db.insert(librarianTaskLinks).values({
      conversationId: conversation.id,
      taskId: owner.taskId,
      meaning: "mentioned",
    });
    await db.execute(sql`
      INSERT INTO librarian_operations
        (id, conversation_id, segment_id, idempotency_key, kind, request_digest, target, status, result)
      SELECT ${randomUUID()}, id, current_segment_id, ${randomUUID()}, 'run_launch', 'test',
        ${JSON.stringify({ projectId: owner.projectId, runId })}::jsonb,
        'succeeded', ${JSON.stringify({ statusCode: 202, body: { runId, status: "Pending" } })}::jsonb
      FROM librarian_conversations WHERE id = ${conversation.id}
    `);

    const first = await getLinkedWork(owner.userId, db);

    expect(first.operations[0]).toMatchObject({
      liveRunStatus: "Pending",
      available: true,
    });
    expect(first.tasks[0]).toMatchObject({
      available: true,
      title: "Card task",
    });

    await db.execute(
      sql`UPDATE runs SET status = 'Running' WHERE id = ${runId}`,
    );
    const running = await getLinkedWork(owner.userId, db);

    expect(running.operations[0].liveRunStatus).toBe("Running");
    expect(running.operations[0].result).toMatchObject({
      runId,
      status: "Pending",
    });

    await removeProjectMember(db as unknown as NodePgDatabase, {
      projectId: owner.projectId,
      userId: owner.userId,
    });
    const revoked = await getLinkedWork(owner.userId, db);

    expect(revoked.operations[0]).toMatchObject({
      available: false,
      result: null,
    });
    expect(revoked.tasks[0]).toMatchObject({
      available: false,
      title: null,
      projectSlug: null,
    });
  });
});

describe("IT-LOP-09: a refused human effect", () => {
  it("settles the card operation as refused and still lets the owner reject it", async () => {
    const owner = await fixture();
    const runId = await seedRun(db as unknown as NodePgDatabase, {
      projectId: owner.projectId,
      status: "Pending",
    });
    const hitlRequestId = randomUUID();

    await db.execute(sql`
      INSERT INTO hitl_requests (id, run_id, step_id, kind, prompt)
      VALUES (${hitlRequestId}, ${runId}, 'review', 'human', 'Continue?')
    `);
    const proposed = await proposePost(
      new NextRequest("http://localhost/api/v1/ext/librarian/cards", {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.token}`,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({
          action: "hitl_respond",
          runId,
          hitlRequestId,
          response: { answer: "yes" },
        }),
      }),
    );

    expect(proposed.status).toBe(201);
    const { cardId } = (await proposed.json()) as { cardId: string };
    const refused = await decideLibrarianCard(
      {
        cardId,
        user: { id: owner.userId, role: "member" },
        decision: "accept",
      },
      db,
    );
    const [operation] = await db
      .select({ status: librarianOperations.status })
      .from(librarianOperations)
      .where(eq(librarianOperations.idempotencyKey, `card:${cardId}`));

    expect(refused.statusCode).toBe(409);
    expect(refused.body.code).toBe("PRECONDITION");
    expect(operation.status).toBe("refused");
    expect(
      await decideLibrarianCard(
        {
          cardId,
          user: { id: owner.userId, role: "member" },
          decision: "reject",
        },
        db,
      ),
    ).toMatchObject({ body: { status: "rejected" } });
  });
});
