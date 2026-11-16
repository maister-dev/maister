// ADR-207: `set_task_resolution` freezes once delivery starts (C9, last clause).
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const fx = { projectId: "", memberId: "", viewerId: "" };

async function seedRun(
  opts: {
    withTask?: boolean;
    promotionState?: string;
    prNumber?: number | null;
    trigger?: string;
  } = {},
): Promise<string> {
  const runId = randomUUID();
  let taskId: string | null = null;

  if (opts.withTask !== false) {
    taskId = randomUUID();
    await db.insert(schema.tasks).values({
      id: taskId,
      projectId: fx.projectId,
      number: Math.trunc(Math.random() * 1e9) + 1,
      title: "t",
      prompt: "p",
      status: "InFlight",
    });
  }
  await db.insert(schema.runs).values({
    id: runId,
    projectId: fx.projectId,
    taskId,
    status: "Review",
    flowVersion: "v1.0.0",
    deliveryPolicySnapshot: {
      strategy: "pull_request",
      push: "on_success",
      trigger: opts.trigger ?? "manual",
      targetBranch: "main",
    },
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId: fx.projectId,
    branch: `b-${runId.slice(0, 8)}`,
    worktreePath: `/tmp/${runId}`,
    parentRepoPath: "/tmp/repo",
    promotionMode: "pull_request",
    promotionState: opts.promotionState ?? "none",
    prNumber: opts.prNumber ?? null,
  });

  return runId;
}

async function patch(runId: string, body: unknown, userId = fx.memberId) {
  sessionRef.value = { user: { id: userId } };
  const { PATCH } = await import("../route");
  const res = await PATCH(
    new NextRequest(`http://localhost/api/runs/${runId}/delivery-policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId }) },
  );

  return { status: res.status, body: await res.json() };
}

async function snapshotOf(runId: string) {
  const [row] = await db
    .select({ snapshot: schema.runs.deliveryPolicySnapshot })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return row.snapshot as Record<string, unknown>;
}

const partial = { action: "set_task_resolution", resolvesTask: false };

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "delivery_policy_test",
  });
  db = testDatabase.db;
  fx.projectId = randomUUID();
  fx.memberId = randomUUID();
  fx.viewerId = randomUUID();
  await db.insert(schema.users).values(
    [fx.memberId, fx.viewerId].map((id) => ({
      id,
      email: `${id.slice(0, 8)}@example.test`,
      role: "member",
      accountStatus: "active",
      passwordHash: "x",
    })),
  );
  await db.insert(schema.projects).values({
    id: fx.projectId,
    slug: "delivery-policy",
    name: "delivery-policy",
    repoPath: "/tmp/delivery-policy",
    maisterYamlPath: "/tmp/delivery-policy/maister.yaml",
    taskKey: "DLP",
  });
  await db.insert(schema.projectMembers).values([
    { projectId: fx.projectId, userId: fx.memberId, role: "member" },
    { projectId: fx.projectId, userId: fx.viewerId, role: "viewer" },
  ]);
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("PATCH /api/runs/{runId}/delivery-policy set_task_resolution", () => {
  it("records partial work before delivery starts", async () => {
    const runId = await seedRun();

    expect(await patch(runId, partial)).toMatchObject({
      status: 200,
      body: { deliveryPolicy: { resolvesTask: false } },
    });
    expect((await snapshotOf(runId)).resolvesTask).toBe(false);
  });

  it.each([
    ["a PR is recorded", { prNumber: 7 }],
    ["promotion is claiming", { promotionState: "claiming" }],
    ["promotion is done", { promotionState: "done" }],
  ])("refuses delivery_already_started when %s", async (_name, opts) => {
    const runId = await seedRun(opts);

    expect(await patch(runId, partial)).toMatchObject({
      status: 409,
      body: { details: { reason: "delivery_already_started" } },
    });
    expect((await snapshotOf(runId)).resolvesTask).toBeUndefined();
  });

  it("refuses a task-less run and a viewer", async () => {
    expect(
      await patch(await seedRun({ withTask: false }), partial),
    ).toMatchObject({
      status: 409,
      body: { details: { reason: "run_has_no_task" } },
    });
    expect((await patch(await seedRun(), partial, fx.viewerId)).status).toBe(
      403,
    );
  });

  it("switch_to_manual keeps a recorded resolvesTask", async () => {
    const runId = await seedRun({ trigger: "auto_on_ready" });

    await patch(runId, partial);
    await patch(runId, { action: "switch_to_manual" });

    expect(await snapshotOf(runId)).toMatchObject({
      trigger: "manual",
      resolvesTask: false,
    });
  });
});
