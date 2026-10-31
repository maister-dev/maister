import type { AnySchema } from "ajv";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv from "ajv";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { POST } from "@/app/api/projects/[slug]/tasks/[number]/qualification/route";
import { GET } from "@/app/api/projects/[slug]/tasks/[number]/qualifications/route";
import { getTaskDTO } from "@/lib/services/tasks";
import { qualificationFixture } from "@/test-support/task-qualification";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { initRepo } from "@/test-support/git-fixture";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
let actingUserId: string | null = null;
let schemas: Record<string, AnySchema>;
const previousSecret = process.env.AUTH_SECRET;
const ajv = new Ajv({ strict: false, validateFormats: false });

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/auth", () => ({
  auth: async () => (actingUserId ? { user: { id: actingUserId } } : null),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "qualification_http",
  });
  root = await mkdtempReal("qualification-http-");
  process.env.AUTH_SECRET = "qualification-history-cursor-secret";
  const api = await SwaggerParser.dereference(
    path.resolve("../docs/api/web.openapi.yaml"),
  );

  schemas = (
    api as unknown as { components: { schemas: Record<string, AnySchema> } }
  ).components.schemas;
}, 180_000);
afterAll(async () => {
  if (previousSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = previousSecret;
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

function contract(name: string, value: unknown): void {
  const validate = ajv.compile(schemas[name]);

  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

it("IT-UX-19 uses current grants and exact receipt/history contracts, preserves old replay under newer human holds, and never exposes assessment bodies after grant loss", async () => {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const userId = randomUUID();
  const repo = await initRepo(path.join(root, projectId));

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES ($1,$2,'member','active',false)",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,task_key,task_qualification_baseline) VALUES ($1,$1,'HTTP qualification',$2,'HTTPQUAL','required')",
    [projectId, repo],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES ($1,$2,$3,'member')",
    [randomUUID(), projectId, userId],
  );
  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES ($1,$2,1,'Request','Acceptance')",
    [taskId, projectId],
  );
  actingUserId = userId;
  const params = {
    params: Promise.resolve({ slug: projectId, number: taskId }),
  };
  const request = {
    requestKey: randomUUID(),
    expectedInputRevision: 1,
    expectedQualificationRevision: null,
    qualification: qualificationFixture(),
  };
  const send = (body: unknown) =>
    POST(
      new Request("http://test/qualification", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      params,
    );
  const response = await send(request);
  const first = await response.json();

  expect(response.status).toBe(200);
  contract("TaskQualificationReceipt", first);
  const held = {
    ...qualificationFixture(),
    decision: "needs_review",
    reasonCodes: ["runtime_evidence_missing"],
    nextActions: ["Provide an observed reproduction result"],
  };
  const second = await (
    await send({
      ...request,
      requestKey: randomUUID(),
      expectedQualificationRevision: first.qualificationRevision,
      qualification: held,
    })
  ).json();

  expect(second).toMatchObject({
    decision: "needs_review",
    publicationState: "accepted",
  });
  expect(await (await send(request)).json()).toEqual(first);
  const task = await getTaskDTO(taskId, projectId, database.db);

  expect(task?.qualification).toMatchObject({
    decision: "needs_review",
    qualificationRevision: second.qualificationRevision,
  });
  contract("TaskQualificationSummary", task!.qualification);
  const historyResponse = await GET(
    new Request("http://test/qualifications?limit=1"),
    params,
  );
  const history = await historyResponse.json();

  expect(historyResponse.status).toBe(200);
  expect(history.items).toHaveLength(1);
  contract("TaskQualificationHistoryItem", history.items[0]);
  const next = await (
    await GET(
      new Request(
        `http://test/qualifications?limit=1&cursor=${encodeURIComponent(history.nextCursor)}`,
      ),
      params,
    )
  ).json();

  expect(next.items).toHaveLength(1);
  expect(next.items[0].qualificationId).not.toBe(
    history.items[0].qualificationId,
  );
  expect(next.asOf).toBe(history.asOf);
  expect(
    (await send({ ...request, requestKey: randomUUID(), extra: "forged" }))
      .status,
  ).toBe(400);
  expect(
    (
      await POST(
        new Request("http://test/qualification", { method: "POST", body: "{" }),
        params,
      )
    ).status,
  ).toBe(400);
  await database.pool.query(
    "UPDATE tasks SET prompt='Changed statement' WHERE id=$1",
    [taskId],
  );
  const stale = await getTaskDTO(taskId, projectId, database.db);

  contract("TaskQualificationSummary", stale!.qualification);
  expect(stale!.qualification).toMatchObject({
    decision: null,
    freshness: "stale",
    blockedReason: "qualification_required",
  });
  await database.pool.query("DELETE FROM project_members WHERE user_id=$1", [
    userId,
  ]);
  expect(
    (await GET(new Request("http://test/qualifications"), params)).status,
  ).toBe(403);
  expect((await send(request)).status).toBe(403);
});
