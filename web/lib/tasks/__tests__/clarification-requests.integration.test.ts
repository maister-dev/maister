import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/lib/db/client";
import { agents, projects, taskClarifications, tasks } from "@/lib/db/schema";
import { issueAgentRunToken } from "@/lib/agents/tokens";
import { issueLibrarianTurnToken } from "@/lib/librarian/authority";
import { getTaskClarificationProjection } from "@/lib/queries/task-clarifications";
import { getWorkTable } from "@/lib/queries/work-table";
import { computeDecisionsQueue } from "@/lib/queries/decisions";
import { getUpdatesCount } from "@/lib/queries/updates";
import { abandonUnlaunchedTasks } from "@/lib/services/tasks";
import { classifyTaskLaunchability } from "@/lib/runs/launchability";
import { evaluateC2Candidate } from "@/lib/scheduler/c2-eligibility";
import { countOpenBlockingClarifications } from "@/lib/tasks/clarification-gate";
import { issueToken } from "@/lib/tokens/issue";
import { LIBRARIAN_TOKEN_SCOPES } from "@/types/token-scopes";
import {
  answerClarification,
  cancelClarification,
  requestClarification,
  supersedeClarification,
} from "@/lib/tasks/clarification-requests";
import { seedProject } from "@/test-support/execution-host-seed";
import { updateAdminUser } from "@/lib/users";
import {
  addProjectMember,
  seedActiveUser,
  seedLibrarianTurn,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: ReturnType<typeof getDb>;
let priorDbUrl: string | undefined;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "user_task_clarifications",
  });
  priorDbUrl = process.env.DB_URL;
  process.env.DB_URL = database.databaseUrl;
  db = getDb();
}, 180_000);

afterAll(async () => {
  await closeDb();
  if (priorDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = priorDbUrl;
  await database?.stop();
});

async function setup(): Promise<{
  projectId: string;
  projectSlug: string;
  taskId: string;
  requesterId: string;
  recipientId: string;
  viewerId: string;
}> {
  const projectId = await seedProject(db as unknown as NodePgDatabase);
  const [project] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId));
  const requesterId = await seedActiveUser(db as unknown as NodePgDatabase);
  const recipientId = await seedActiveUser(db as unknown as NodePgDatabase);
  const viewerId = await seedActiveUser(db as unknown as NodePgDatabase);

  await addProjectMember(db as unknown as NodePgDatabase, {
    projectId,
    userId: requesterId,
    role: "admin",
  });
  await addProjectMember(db as unknown as NodePgDatabase, {
    projectId,
    userId: recipientId,
    role: "member",
  });
  await addProjectMember(db as unknown as NodePgDatabase, {
    projectId,
    userId: viewerId,
    role: "viewer",
  });
  const taskId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId,
    number: 1,
    title: "Clarify",
    prompt: "Ship it",
  });

  return {
    projectId,
    projectSlug: project.slug,
    taskId,
    requesterId,
    recipientId,
    viewerId,
  };
}

function request(recipientUserId: string, blocking = true) {
  return {
    recipientUserId,
    question: "Which region?",
    reason: "The target is ambiguous",
    answerFormat: "text" as const,
    blocking,
  };
}

describe("user-origin task clarification", () => {
  it("IT-CLR-02/04/07/10: checks live recipient role, answers once, folds prompt, and corrects without changing task", async () => {
    const seeded = await setup();

    await expect(
      requestClarification(
        {
          taskId: seeded.taskId,
          requesterUserId: seeded.requesterId,
          request: request(seeded.viewerId),
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const first = await requestClarification(
      {
        taskId: seeded.taskId,
        requesterUserId: seeded.requesterId,
        request: request(seeded.recipientId),
      },
      db,
    );
    const [created] = await db
      .select()
      .from(taskClarifications)
      .where(eq(taskClarifications.id, first.clarificationId));

    expect(created).toMatchObject({
      originKind: "user",
      status: "open",
      originRunId: null,
    });
    await db.execute(sql`UPDATE project_members SET role = 'viewer'
      WHERE project_id = ${seeded.projectId} AND user_id = ${seeded.recipientId}`);
    await expect(
      answerClarification(
        {
          taskId: seeded.taskId,
          clarificationId: first.clarificationId,
          recipientUserId: seeded.recipientId,
          answer: "EU",
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await db.execute(sql`UPDATE project_members SET role = 'member'
      WHERE project_id = ${seeded.projectId} AND user_id = ${seeded.recipientId}`);
    const [taskBefore] = await db
      .select({ revision: tasks.revision, prompt: tasks.prompt })
      .from(tasks)
      .where(eq(tasks.id, seeded.taskId));

    await answerClarification(
      {
        taskId: seeded.taskId,
        clarificationId: first.clarificationId,
        recipientUserId: seeded.recipientId,
        answer: "EU",
      },
      db,
    );
    await expect(
      answerClarification(
        {
          taskId: seeded.taskId,
          clarificationId: first.clarificationId,
          recipientUserId: seeded.recipientId,
          answer: "US",
        },
        db,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "clarification_not_open" },
    });
    const [taskAfter] = await db
      .select({ revision: tasks.revision, prompt: tasks.prompt })
      .from(tasks)
      .where(eq(tasks.id, seeded.taskId));

    expect(taskAfter).toEqual(taskBefore);
    expect(await countOpenBlockingClarifications(seeded.taskId, db)).toBe(0);
    expect(
      classifyTaskLaunchability(
        { status: "Backlog", flowId: "flow", triageStatus: null },
        null,
        undefined,
        { openBlocking: 0 },
      ),
    ).toBe("launchable");
    expect(
      (await getTaskClarificationProjection(db, seeded.taskId, "Ship it"))
        .effectivePrompt,
    ).toContain('Answer: "EU"');

    const correction = await supersedeClarification(
      {
        taskId: seeded.taskId,
        clarificationId: first.clarificationId,
        requesterUserId: seeded.requesterId,
        request: {
          ...request(seeded.recipientId),
          question: "Which exact country?",
        },
      },
      db,
    );
    const [prior] = await db
      .select()
      .from(taskClarifications)
      .where(eq(taskClarifications.id, first.clarificationId));

    expect(prior).toMatchObject({
      status: "superseded",
      supersededByClarificationId: correction.clarificationId,
      answer: "EU",
    });
    expect(
      (await getTaskClarificationProjection(db, seeded.taskId, "Ship it"))
        .effectivePrompt,
    ).not.toContain('Answer: "EU"');
  });

  it("IT-CLR-08: requester cancellation ends an open hold and emits a fact", async () => {
    const seeded = await setup();
    const opened = await requestClarification(
      {
        taskId: seeded.taskId,
        requesterUserId: seeded.requesterId,
        request: request(seeded.recipientId),
      },
      db,
    );

    await cancelClarification(
      {
        taskId: seeded.taskId,
        clarificationId: opened.clarificationId,
        actorUserId: seeded.requesterId,
      },
      db,
    );
    const [row] = await db
      .select()
      .from(taskClarifications)
      .where(eq(taskClarifications.id, opened.clarificationId));

    expect(row).toMatchObject({
      status: "cancelled",
      cancelReason: "requester_cancelled",
    });
    await expect(
      cancelClarification(
        {
          taskId: seeded.taskId,
          clarificationId: opened.clarificationId,
          actorUserId: seeded.requesterId,
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("IT-CLR-03: addressed recipient alone gets a decision, without an updates count", async () => {
    const seeded = await setup();
    const opened = await requestClarification(
      {
        taskId: seeded.taskId,
        requesterUserId: seeded.requesterId,
        request: request(seeded.recipientId),
      },
      db,
    );
    const recipient = await computeDecisionsQueue(seeded.recipientId, "member");
    const requester = await computeDecisionsQueue(seeded.requesterId, "member");

    expect(recipient.count).toBe(1);
    expect(recipient.items).toMatchObject([
      { kind: "clarification", clarification: { id: opened.clarificationId } },
    ]);
    expect(requester.count).toBe(0);
    expect(await getUpdatesCount(seeded.recipientId, "member")).toBe(0);
    expect(await getUpdatesCount(seeded.requesterId, "member")).toBe(0);
  });

  it("IT-CLR-05: a blocking request holds launch and appears as a work attribute", async () => {
    const seeded = await setup();
    const initial = classifyTaskLaunchability(
      { status: "Backlog", flowId: "flow", triageStatus: null },
      null,
    );

    expect(initial).toBe("launchable");
    await requestClarification(
      {
        taskId: seeded.taskId,
        requesterUserId: seeded.requesterId,
        request: request(seeded.recipientId),
      },
      db,
    );
    const openBlocking = await countOpenBlockingClarifications(
      seeded.taskId,
      db,
    );
    const work = await getWorkTable({ id: seeded.recipientId, role: "member" });

    expect(openBlocking).toBe(1);
    expect(
      classifyTaskLaunchability(
        { status: "Backlog", flowId: "flow", triageStatus: null },
        null,
        undefined,
        { openBlocking },
      ),
    ).toBe("clarification_pending");
    expect(
      work.rows.find((row) => row.taskId === seeded.taskId)
        ?.clarificationPending,
    ).toBe(true);
    expect(
      await evaluateC2Candidate(
        db,
        {
          taskId: seeded.taskId,
          projectId: seeded.projectId,
          status: "Backlog",
          flowId: "flow",
          triageStatus: "triaged",
          launchArmedAt: null,
          priority: null,
          createdAt: new Date(),
        },
        Date.now(),
      ),
    ).toEqual({ kind: "skip" });
  });

  it("IT-CLR-09: only the addressed human's global personal token with the exact scope answers", async () => {
    const seeded = await setup();
    const opened = await requestClarification(
      {
        taskId: seeded.taskId,
        requesterUserId: seeded.requesterId,
        request: request(seeded.recipientId),
      },
      db,
    );
    const route = await import(
      "@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/clarifications/[id]/answer/route"
    );
    const params = {
      params: Promise.resolve({
        slug: seeded.projectSlug,
        taskId: seeded.taskId,
        id: opened.clarificationId,
      }),
    };
    const send = (secret: string) =>
      route.POST(
        new NextRequest(
          "http://localhost/api/v1/ext/projects/clarifications/answer",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ answer: "EU" }),
          },
        ),
        params,
      );
    const weak = await issueToken(
      {
        projectId: null,
        name: "Weak human token",
        tokenKind: "user",
        ownerUserId: seeded.recipientId,
        scopes: ["hitl:respond"],
      },
      db,
    );
    const valid = await issueToken(
      {
        projectId: null,
        name: "Human answer token",
        tokenKind: "user",
        ownerUserId: seeded.recipientId,
        scopes: ["hitl:respond:human"],
      },
      db,
    );
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      packageName: "clarification-test",
      versionLabel: "v1.0.0",
      origin: "git",
      name: "Clarification Test Agent",
      description: "fixture",
      workspace: "none",
      mode: "session",
      triggers: [],
      riskTier: "read_only",
      sourcePath: "agents/clarification-test.md",
    });
    const agent = await issueAgentRunToken({
      agentId,
      projectId: seeded.projectId,
      runId: randomUUID(),
      db,
    });
    const librarian = await issueLibrarianTurnToken(
      {
        ownerUserId: seeded.recipientId,
        turnId: await seedLibrarianTurn(
          db as unknown as NodePgDatabase,
          seeded.recipientId,
        ),
        scopes: ["hitl:respond:human"],
        expiresAt: new Date(Date.now() + 60_000),
      },
      db,
    );

    expect((await send(weak.secret)).status).toBe(403);
    expect((await send(agent.secret)).status).toBe(403);
    expect((await send(librarian.secret)).status).toBe(403);
    expect((await send(valid.secret)).status).toBe(200);
    expect((await send(valid.secret)).status).toBe(409);
  });

  it("IT-CLR-01/04: owner-message librarian request is idempotent and carries its source", async () => {
    const seeded = await setup();
    const turnId = await seedLibrarianTurn(
      db as unknown as NodePgDatabase,
      seeded.requesterId,
    );
    const [turn] = await db
      .execute(
        sql`
      SELECT conversation_id, segment_id FROM librarian_turns WHERE id = ${turnId}
    `,
      )
      .then(
        (result) =>
          result.rows as Array<{ conversation_id: string; segment_id: string }>,
      );
    const messageId = randomUUID();

    await db.execute(sql`
      INSERT INTO librarian_messages (id, conversation_id, segment_id, seq, author_kind, body)
      VALUES (${messageId}, ${turn.conversation_id}, ${turn.segment_id}, 1, 'owner', 'Ask the recipient')
    `);
    await db.execute(
      sql`UPDATE librarian_turns SET message_id = ${messageId} WHERE id = ${turnId}`,
    );
    const token = await issueLibrarianTurnToken(
      {
        ownerUserId: seeded.requesterId,
        turnId,
        scopes: LIBRARIAN_TOKEN_SCOPES,
        expiresAt: new Date(Date.now() + 60_000),
      },
      db,
    );
    const route = await import(
      "@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/clarifications/route"
    );
    const params = {
      params: Promise.resolve({
        slug: seeded.projectSlug,
        taskId: seeded.taskId,
      }),
    };
    const send = () =>
      route.POST(
        new NextRequest("http://localhost/api/v1/ext/projects/clarifications", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token.secret}`,
            "content-type": "application/json",
            "Idempotency-Key": "ask-recipient-once",
          },
          body: JSON.stringify(request(seeded.recipientId)),
        }),
        params,
      );
    const first = await send();
    const second = await send();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const receipt = await first.json();

    expect(await second.json()).toEqual(receipt);
    const rows = await db
      .select()
      .from(taskClarifications)
      .where(eq(taskClarifications.taskId, seeded.taskId));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceMessageId: messageId,
      requesterUserId: seeded.requesterId,
      recipientUserId: seeded.recipientId,
      requestedViaOperationId: expect.any(String),
    });

    const cancelRoute = await import(
      "@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/clarifications/[id]/route"
    );
    const cancel = () =>
      cancelRoute.DELETE(
        new NextRequest(
          "http://localhost/api/v1/ext/projects/clarifications/id",
          {
            method: "DELETE",
            headers: {
              authorization: `Bearer ${token.secret}`,
              "Idempotency-Key": "cancel-recipient-once",
            },
          },
        ),
        {
          params: Promise.resolve({
            slug: seeded.projectSlug,
            taskId: seeded.taskId,
            id: receipt.clarificationId,
          }),
        },
      );
    const cancelled = await cancel();

    expect(cancelled.status).toBe(200);
    expect((await cancel()).status).toBe(200);
    expect(
      (
        await db
          .select({ status: taskClarifications.status })
          .from(taskClarifications)
          .where(eq(taskClarifications.id, receipt.clarificationId))
      )[0]?.status,
    ).toBe("cancelled");
  });

  it("IT-CLR-08: disabling the recipient cancels an open request", async () => {
    const seeded = await setup();
    const adminUserId = await seedActiveUser(db as unknown as NodePgDatabase, {
      role: "admin",
    });
    const opened = await requestClarification(
      {
        taskId: seeded.taskId,
        requesterUserId: seeded.requesterId,
        request: request(seeded.recipientId),
      },
      db,
    );

    await updateAdminUser({
      adminUserId,
      targetUserId: seeded.recipientId,
      status: "disabled",
    });
    const [row] = await db
      .select()
      .from(taskClarifications)
      .where(eq(taskClarifications.id, opened.clarificationId));

    expect(row).toMatchObject({
      status: "cancelled",
      cancelReason: "recipient_deactivated",
    });
  });

  it("IT-CLR-08: abandoning an unlaunched task cancels its open request", async () => {
    const seeded = await setup();
    const opened = await requestClarification(
      {
        taskId: seeded.taskId,
        requesterUserId: seeded.requesterId,
        request: request(seeded.recipientId),
      },
      db,
    );

    await abandonUnlaunchedTasks(db, [seeded.taskId], new Date());
    const [row] = await db
      .select()
      .from(taskClarifications)
      .where(eq(taskClarifications.id, opened.clarificationId));

    expect(row).toMatchObject({
      status: "cancelled",
      cancelReason: "task_abandoned",
    });
  });
});
