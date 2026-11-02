import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { POST } from "@/app/api/task-launch-intents/route";
import { GET } from "@/app/api/task-launch-intents/[intentId]/route";
import { tasks } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { taskLaunchSettingsToken } from "@/lib/tasks/launch-intent";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  seedTaskLaunchFixture,
  type TaskLaunchFixture,
} from "@/test-support/task-launch-admission";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
let fixture: TaskLaunchFixture;
let sessionActive = true;
let sessionUserId: string | null = null;
let seq = 0;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => {
    if (!sessionActive)
      throw new MaisterError("UNAUTHENTICATED", "Session is required");

    return { id: sessionUserId ?? fixture.userId };
  },
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "task_launch_http",
  });
  root = await mkdtempReal("task-launch-http-");
  fixture = await seedTaskLaunchFixture(database, root);
}, 180_000);
afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function body() {
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++seq,
    title: "Launch via API",
    prompt: "Private execution input",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });

  return {
    taskId,
    expectedTaskRevision: 0,
    expectedSettingsToken: await taskLaunchSettingsToken(database.db, taskId),
  };
}
function request(
  payload: unknown,
  key = randomUUID(),
  origin = "http://localhost",
): Request {
  return new Request("http://localhost/api/task-launch-intents", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      Origin: origin,
    },
    body: JSON.stringify(payload),
  });
}

it("LA13 accepts a recoverable intent-only response, replays its key, and GET exposes no input or mutation", async () => {
  const input = await body();
  const key = randomUUID();
  const accepted = await POST(request(input, key));

  expect(accepted.status).toBe(202);
  const receipt = await accepted.json();

  expect(receipt).toMatchObject({
    runId: null,
    state: "queued",
    basis: "manual",
  });
  expect(accepted.headers.get("location")).toBe(
    `/api/task-launch-intents/${receipt.intentId}`,
  );
  expect(await (await POST(request(input, key))).json()).toEqual(receipt);
  const before = (
    await database.pool.query(
      "SELECT to_jsonb(i) AS value FROM task_launch_intents i WHERE id=$1",
      [receipt.intentId],
    )
  ).rows[0].value;
  const read = await GET(
    new Request(`http://localhost${accepted.headers.get("location")}`),
    { params: Promise.resolve({ intentId: receipt.intentId }) },
  );

  expect(read.status).toBe(200);
  expect(await read.json()).toEqual(receipt);
  expect(JSON.stringify(receipt)).not.toContain("Private execution input");
  expect(JSON.stringify(receipt)).not.toContain("provider");
  expect(
    (
      await database.pool.query(
        "SELECT to_jsonb(i) AS value FROM task_launch_intents i WHERE id=$1",
        [receipt.intentId],
      )
    ).rows[0].value,
  ).toEqual(before);
});

it("LA07 authenticates before body parsing and refuses client admission authority fields", async () => {
  const input = await body();

  sessionActive = false;
  expect((await POST(request({ isHuman: true }))).status).toBe(401);
  sessionActive = true;
  const forged = await POST(
    request({
      ...input,
      actorUserId: fixture.userId,
      mode: "manual",
      skipQualification: true,
    }),
  );

  expect(forged.status).toBe(400);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
        [input.taskId],
      )
    ).rows[0].n,
  ).toBe(0);
});

it("LA07 refuses cross-origin session authorization before accepting a launch", async () => {
  const input = await body();
  const response = await POST(
    request(input, randomUUID(), "https://untrusted.invalid"),
  );

  expect(response.status).toBe(403);
  const missingOrigin = request(input);

  missingOrigin.headers.delete("Origin");
  expect((await POST(missingOrigin)).status).toBe(403);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
        [input.taskId],
      )
    ).rows[0].n,
  ).toBe(0);
});

it("LA07 keeps an intent ID from becoming a readable cross-project capability", async () => {
  const input = await body();
  const accepted = await POST(request(input));
  const receipt = await accepted.json();
  const outsider = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES($1,$2,'viewer','active',false)",
    [outsider, `${outsider}@test.local`],
  );
  sessionUserId = outsider;
  const response = await GET(
    new Request("http://localhost/api/task-launch-intents/private"),
    { params: Promise.resolve({ intentId: receipt.intentId }) },
  );

  sessionUserId = null;
  expect(response.status).toBe(404);
  expect(JSON.stringify(await response.json())).not.toContain(
    receipt.settingsDigest,
  );
});
