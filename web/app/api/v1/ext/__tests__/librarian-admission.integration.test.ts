import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { issueLibrarianTurnToken } from "@/lib/librarian/authority";
import { createTask } from "@/lib/services/tasks";
import {
  LIBRARIAN_READ_SCOPES,
  LIBRARIAN_TOKEN_SCOPES,
} from "@/types/token-scopes";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import {
  addProjectMember,
  seedLibrarianTurn,
  removeProjectMember,
  seedActiveUser,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-184: a librarian token is admitted only on routes that opt in, and every
// admitted request re-checks the owner's LIVE project role for the scope.

let database: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

type TaskRoutes = typeof import("@/app/api/v1/ext/projects/[slug]/tasks/route");
type TaskRoute =
  typeof import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/route");
type RunRoute = typeof import("@/app/api/v1/ext/runs/[runId]/route");
type PromoteRoute = typeof import("@/app/api/v1/ext/runs/promote/route");
type DiscardRoute =
  typeof import("@/app/api/v1/ext/runs/[runId]/discard/route");
type DelegateRoute = typeof import("@/app/api/v1/ext/runs/delegate/route");
type RespondRoute =
  typeof import("@/app/api/v1/ext/runs/[runId]/hitl/[hitlRequestId]/respond/route");
type AgentMemoryRoute = typeof import("@/app/api/v1/ext/agent/memory/route");

let tasks: TaskRoutes;
let task: TaskRoute;
let run: RunRoute;
let promote: PromoteRoute;
let discard: DiscardRoute;
let delegate: DelegateRoute;
let respond: RespondRoute;
let agentMemory: AgentMemoryRoute;

const fx = {
  ownerId: "",
  viewerProject: { id: "", slug: "" },
  memberProject: { id: "", slug: "" },
  foreignProject: { id: "", slug: "" },
  viewerTaskId: "",
  memberTaskId: "",
  memberRunId: "",
  foreignRunId: "",
};

function request(method: string, token: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/ext/test", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "idempotency-key": randomUUID(),
    },
  });
}

async function turnToken(scopes: readonly string[]): Promise<string> {
  const issued = await issueLibrarianTurnToken(
    {
      ownerUserId: fx.ownerId,
      turnId: await seedLibrarianTurn(db, fx.ownerId),
      scopes,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
    db,
  );

  return issued.secret;
}

async function seedTask(projectId: string): Promise<string> {
  const created = await createTask(
    { title: "Seeded", prompt: "Seeded prompt" },
    { projectId, actorUserId: null },
    db,
  );

  return created.taskId;
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_admission",
  });
  db = database.db as unknown as NodePgDatabase;

  fx.ownerId = await seedActiveUser(db);
  fx.viewerProject = await seedProjectRow(db);
  fx.memberProject = await seedProjectRow(db);
  fx.foreignProject = await seedProjectRow(db);
  await addProjectMember(db, {
    projectId: fx.viewerProject.id,
    userId: fx.ownerId,
    role: "viewer",
  });
  await addProjectMember(db, {
    projectId: fx.memberProject.id,
    userId: fx.ownerId,
    role: "member",
  });
  fx.viewerTaskId = await seedTask(fx.viewerProject.id);
  fx.memberTaskId = await seedTask(fx.memberProject.id);
  fx.memberRunId = await seedRun(db, { projectId: fx.memberProject.id });
  fx.foreignRunId = await seedRun(db, { projectId: fx.foreignProject.id });

  tasks = await import("@/app/api/v1/ext/projects/[slug]/tasks/route");
  task = await import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/route");
  run = await import("@/app/api/v1/ext/runs/[runId]/route");
  promote = await import("@/app/api/v1/ext/runs/promote/route");
  discard = await import("@/app/api/v1/ext/runs/[runId]/discard/route");
  delegate = await import("@/app/api/v1/ext/runs/delegate/route");
  respond = await import(
    "@/app/api/v1/ext/runs/[runId]/hitl/[hitlRequestId]/respond/route"
  );
  agentMemory = await import("@/app/api/v1/ext/agent/memory/route");
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

const slugParams = (slug: string) => ({ params: Promise.resolve({ slug }) });
const taskParams = (slug: string, taskId: string) => ({
  params: Promise.resolve({ slug, taskId }),
});
const runParams = (runId: string) => ({ params: Promise.resolve({ runId }) });

describe("IT-LAU-03: every request re-checks the owner's live project role", () => {
  it("a viewer owner reads a task but cannot create one there", async () => {
    const token = await turnToken(LIBRARIAN_TOKEN_SCOPES);

    const read = await task.GET(
      request("GET", token),
      taskParams(fx.viewerProject.slug, fx.viewerTaskId),
    );
    const create = await tasks.POST(
      request("POST", token, { title: "New", prompt: "Body" }),
      slugParams(fx.viewerProject.slug),
    );

    expect(read.status).toBe(200);
    expect(create.status).toBe(403);
    expect(await create.json()).toMatchObject({
      code: "UNAUTHORIZED",
      details: { requiredAction: "createTask" },
    });
  });

  it("a member owner creates a task in their project", async () => {
    const token = await turnToken(LIBRARIAN_TOKEN_SCOPES);

    const create = await tasks.POST(
      request("POST", token, {
        title: "New",
        statement: {
          context: "Project context",
          goal: "Create the task",
          acceptance: ["Task is available"],
          constraints: [],
          outOfScope: [],
          links: [],
          openQuestions: [],
        },
      }),
      slugParams(fx.memberProject.slug),
    );

    expect(create.status).toBe(201);
  });

  it("reads a run through its project and hides a foreign run as missing", async () => {
    const token = await turnToken(LIBRARIAN_TOKEN_SCOPES);

    const visible = await run.GET(
      request("GET", token),
      runParams(fx.memberRunId),
    );
    const foreign = await run.GET(
      request("GET", token),
      runParams(fx.foreignRunId),
    );
    const missing = await run.GET(
      request("GET", token),
      runParams(randomUUID()),
    );

    expect(visible.status).toBe(200);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
  });
});

describe("IT-LAU-10 part 2: losing membership refuses the next call of the same turn", () => {
  it("answers 404 once the owner is removed from the project", async () => {
    const token = await turnToken(LIBRARIAN_TOKEN_SCOPES);
    const project = await seedProjectRow(db);
    const taskId = await seedTask(project.id);

    await addProjectMember(db, {
      projectId: project.id,
      userId: fx.ownerId,
      role: "member",
    });

    const before = await task.GET(
      request("GET", token),
      taskParams(project.slug, taskId),
    );

    await removeProjectMember(db, {
      projectId: project.id,
      userId: fx.ownerId,
    });

    const after = await task.GET(
      request("GET", token),
      taskParams(project.slug, taskId),
    );

    expect(before.status).toBe(200);
    expect(after.status).toBe(404);
  });
});

describe("IT-LAU-04: human-only and coordinator routes refuse a librarian token", () => {
  it("refuses promote, discard, delegate, HITL respond and agent memory writes", async () => {
    const token = await turnToken(LIBRARIAN_TOKEN_SCOPES);
    const responses = [
      await promote.POST(
        request("POST", token, { childRunId: fx.memberRunId }),
        {},
      ),
      await discard.POST(request("POST", token), runParams(fx.memberRunId)),
      await delegate.POST(request("POST", token, {}), {}),
      await respond.POST(request("POST", token, { optionId: "allow" }), {
        params: Promise.resolve({
          runId: fx.memberRunId,
          hitlRequestId: randomUUID(),
        }),
      }),
      await agentMemory.POST(request("POST", token, { content: "x" })),
    ];

    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: "UNAUTHORIZED",
        details: { reason: "librarian_not_admitted" },
      });
    }
  });
});

describe("IT-LAU-05: a read-scope token cannot reach an effectful route", () => {
  it("reads a task but is refused task creation", async () => {
    const token = await turnToken(LIBRARIAN_READ_SCOPES);

    const read = await task.GET(
      request("GET", token),
      taskParams(fx.memberProject.slug, fx.memberTaskId),
    );
    const create = await tasks.POST(
      request("POST", token, { title: "New", prompt: "Body" }),
      slugParams(fx.memberProject.slug),
    );

    expect(read.status).toBe(200);
    expect(create.status).toBe(403);
    expect(await create.json()).toMatchObject({
      details: { requiredScope: "tasks:create" },
    });
  });
});
