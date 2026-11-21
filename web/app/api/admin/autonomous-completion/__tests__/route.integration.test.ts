import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { platformAcpRunners } from "@/lib/db/schema";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let userId: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/auth", () => ({ auth: () => ({ user: { id: userId } }) }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "completion_settings",
  });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("C01 separates project from platform authority and fences settings revisions", async () => {
  const { PATCH: editPlatform } = await import("../route");
  const { PATCH: editProject } =
    await import("@/app/api/projects/[slug]/settings/route");
  const project = await seedProjectRow(database.db);

  userId = randomUUID();
  const runnerId = randomUUID();

  await database.db
    .insert(platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId));
  await database.pool.query(
    "INSERT INTO platform_runtime_settings (id,default_runner_id) VALUES ('singleton',$1)",
    [runnerId],
  );
  await database.pool.query(
    "INSERT INTO users (id,email,role,account_status) VALUES ($1,$2,'member','active')",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    `INSERT INTO project_members (id,project_id,user_id,role)
    VALUES (gen_random_uuid()::text,$1,$2,'member')`,
    [project.id, userId],
  );

  const origin = new URL(process.env.AUTH_URL ?? "http://localhost").origin;
  const request = (path: string, body: unknown, bearer?: string) =>
    new NextRequest(`${origin}${path}`, {
      method: "PATCH",
      headers: {
        origin,
        "content-type": "application/json",
        ...(bearer ? { authorization: bearer } : {}),
      },
      body: JSON.stringify(body),
    });
  const projectChange = (body: unknown) =>
    editProject(
      request(`/api/projects/${project.slug}/settings`, {
        autonomousCompletion: body,
      }),
      { params: Promise.resolve({ slug: project.slug }) },
    );
  const platformChange = (body: unknown, bearer?: string) =>
    editPlatform(request("/api/admin/autonomous-completion", body, bearer));
  const optIn = {
    enabled: true,
    expectedRevision: 0,
    approvedCiSources: ["github-actions"],
  };

  expect((await projectChange(optIn)).status).toBe(403);
  await database.pool.query(
    "UPDATE project_members SET role='admin' WHERE project_id=$1 AND user_id=$2",
    [project.id, userId],
  );
  expect(
    (await projectChange({ enabled: true, expectedRevision: 0 })).status,
  ).toBe(422);
  const projectEnabled = await projectChange(optIn);

  expect(projectEnabled.status).toBe(200);
  expect(await projectEnabled.json()).toMatchObject({
    autonomousCompletion: { revision: 1, settings: { enabled: true } },
  });
  expect((await projectChange(optIn)).status).toBe(409);
  expect(
    (await platformChange({ enabled: true, expectedRevision: 0 })).status,
  ).toBe(403);

  await database.pool.query("UPDATE users SET role='admin' WHERE id=$1", [
    userId,
  ]);
  expect(
    (
      await platformChange(
        { enabled: true, expectedRevision: 0 },
        "Bearer ci-token",
      )
    ).status,
  ).toBe(403);
  const platformEnabled = await platformChange({
    enabled: true,
    expectedRevision: 0,
  });

  expect(platformEnabled.status).toBe(200);
  expect(await platformEnabled.json()).toEqual({ enabled: true, revision: 1 });
  expect(
    (await platformChange({ enabled: false, expectedRevision: 0 })).status,
  ).toBe(409);
  const killed = await platformChange({ enabled: false, expectedRevision: 1 });

  expect(await killed.json()).toEqual({ enabled: false, revision: 2 });
});
