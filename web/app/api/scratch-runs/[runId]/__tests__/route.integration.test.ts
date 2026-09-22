import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { GET } from "@/app/api/scratch-runs/[runId]/route";
import * as schema from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: StartedPostgresTestDb["db"];

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({ id: "operator" })),
  requireProjectAction: vi.fn(async () => {}),
}));

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scratch_hitl_read_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

it("scratch GET exposes the saved public answer until delivery and never leaks the host intent", async () => {
  const projectId = randomUUID();
  const runId = randomUUID();
  const userId = randomUUID();
  const hitlRequestId = randomUUID();

  await db
    .insert(schema.users)
    .values({ id: userId, email: "scratch-operator@test.local" });
  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    slug: "scratch-stored-answer",
    name: "Scratch stored answer",
    repoPath: "/tmp/scratch-stored-answer",
    maisterYamlPath: "/tmp/scratch-stored-answer/maister.yaml",
  });
  await db.insert(schema.runs).values({
    id: runId,
    runKind: "scratch",
    projectId,
    flowVersion: "scratch",
    status: "NeedsInput",
  });
  await db.insert(schema.scratchRuns).values({
    runId,
    projectId,
    createdByUserId: userId,
    initialPrompt: "Do the thing",
    baseBranch: "main",
    baseCommit: "deadbeef",
    dialogStatus: "NeedsInput",
  });
  await db.insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId: "permission",
    kind: "permission",
    prompt: "Allow?",
    schema: {
      options: [{ optionId: "allow", label: "Allow" }],
      supervisorSessionId: "private-session",
    },
    response: {
      optionId: "allow",
      _delivery: { commandId: "private-command" },
    },
  });

  const read = async () =>
    GET(new Request(`http://localhost/api/scratch-runs/${runId}`), {
      params: Promise.resolve({ runId }),
    });
  const response = await read();

  expect(response.status).toBe(200);
  const body = await response.json();

  expect(body.pendingHitl).toMatchObject({
    answerState: "answer_stored",
    storedResponse: { optionId: "allow" },
  });
  expect(JSON.stringify(body.pendingHitl)).not.toContain("private-command");
  expect(JSON.stringify(body.pendingHitl)).not.toContain("private-session");

  await db
    .update(schema.hitlRequests)
    .set({ respondedAt: new Date() })
    .where(eq(schema.hitlRequests.id, hitlRequestId));
  expect((await (await read()).json()).pendingHitl).toBeNull();
});
