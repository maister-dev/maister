import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";
import { respondToHitl, HitlActor } from "@/lib/services/hitl";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let runtimeRoot: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/supervisor-client", () => ({
  deliverPermission: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/flows/runner", () => ({
  runFlow: vi.fn(async () => {}),
}));
vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => {}),
}));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("hitl_service_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "hitl-service-int-"));
  process.env.MAISTER_RUNTIME_ROOT = runtimeRoot;
  vi.clearAllMocks();
});

afterEach(async () => {
  delete process.env.MAISTER_RUNTIME_ROOT;
  await rm(runtimeRoot, { recursive: true, force: true });
});

async function seedProject(slug: string) {
  const projectId = randomUUID();

  await (db as any).insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  return projectId;
}

async function seedRunner() {
  const executorId = randomUUID();

  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  return executorId;
}

async function seedRun(projectId: string) {
  const runId = randomUUID();
  const executorId = await seedRunner();

  await (db as any).insert(schema.runs).values({
    id: runId,
    projectId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status: "NeedsInput",
    flowVersion: "v1.0.0",
  });

  return runId;
}

async function seedPermissionHitl(
  runId: string,
  stepId: string = "plan",
  respondedAt?: Date,
) {
  const hitlRequestId = randomUUID();

  await (db as any).insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId,
    kind: "permission",
    prompt: "Allow this action?",
    schema: {
      requestId: "req-1",
      supervisorSessionId: "sup-1",
      options: [{ optionId: "allow" }, { optionId: "deny" }],
    },
    response: null,
    respondedAt: respondedAt ?? null,
  });

  return hitlRequestId;
}

async function seedFormHitl(
  runId: string,
  stepId: string = "review",
  respondedAt?: Date,
) {
  const hitlRequestId = randomUUID();

  await (db as any).insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId,
    kind: "form",
    prompt: "Please review",
    schema: { fields: [] },
    response: null,
    respondedAt: respondedAt ?? null,
  });

  return hitlRequestId;
}

describe("respondToHitl integration — form response with real Postgres", () => {
  it("form response → row.response set + respondedAt set + input-<stepId>.json written", async () => {
    const projectId = await seedProject("test-form");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedFormHitl(runId, "review");
    const actor: HitlActor = {
      kind: "user",
      userId: "u-1",
      label: "Test User",
    };
    const payload = { approved: true, comments: "lgtm" };

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { response: payload } },
      actor,
      { db },
    );

    expect(res.status).toBe(200);

    const rows = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));
    const row = rows[0];

    expect(row.response).toEqual(payload);
    expect(row.respondedAt).toBeInstanceOf(Date);

    const artifactPath = join(
      runtimeRoot,
      ".maister",
      "test-form",
      "runs",
      runId,
      "input-review.json",
    );

    expect(existsSync(artifactPath)).toBe(true);
    const onDisk = JSON.parse(await readFile(artifactPath, "utf8"));

    expect(onDisk).toEqual(payload);
  });
});

describe("respondToHitl integration — permission response with real Postgres", () => {
  it("permission response with deliverPermission mocked → response={optionId} + respondedAt", async () => {
    const projectId = await seedProject("test-perm");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedPermissionHitl(runId, "plan");
    const actor: HitlActor = {
      kind: "user",
      userId: "u-1",
      label: "Test User",
    };

    const { deliverPermission } = await import("@/lib/supervisor-client");
    const deliverSpy = vi.mocked(deliverPermission);

    deliverSpy.mockImplementation(async () => ({ ok: true }));

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db },
    );

    expect(res.status).toBe(200);

    const rows = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));
    const row = rows[0];

    expect(row.response).toEqual({ optionId: "allow" });
    expect(row.respondedAt).toBeInstanceOf(Date);
    expect(deliverSpy).toHaveBeenCalledWith("sup-1", "req-1", "allow");
  });
});

describe("respondToHitl integration — review human decision with real Postgres", () => {
  it("review human_review decision persists decision/workspacePolicy/reworkTarget", async () => {
    const projectId = await seedProject("test-review");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedFormHitl(runId, "approve-step");
    const actor: HitlActor = {
      kind: "user",
      userId: "u-1",
      label: "Test User",
    };

    const reviewSchema = {
      review: true,
      allowedDecisions: ["approve", "rework"],
      transitions: { approve: "done", rework: "implement" },
      reworkTargets: ["implement"],
      workspacePolicies: ["keep"],
    };

    await (db as any)
      .update(schema.hitlRequests)
      .set({ schema: reviewSchema })
      .where(eq(schema.hitlRequests.id, hitlRequestId));

    const res = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: {
          response: {
            decision: "rework",
            comments: "needs more work",
            workspacePolicy: "keep",
          },
        },
      },
      actor,
      { db },
    );

    expect(res.status).toBe(200);

    const rows = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));
    const row = rows[0];

    expect(row.decision).toBe("rework");
    expect(row.workspacePolicy).toBe("keep");
    expect(row.reworkTarget).toBe("implement");
    expect(row.respondedAt).toBeInstanceOf(Date);
  });
});

describe("respondToHitl integration — M17 humanConfidence write with real Postgres", () => {
  it("form response with confidence writes humanConfidence column and echoes in response jsonb", async () => {
    const projectId = await seedProject("test-confidence");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedFormHitl(runId, "review");
    const actor: HitlActor = {
      kind: "user",
      userId: "u-1",
      label: "Test User",
    };

    const res = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: { response: { userComment: "looks good" }, confidence: 0.8 },
      },
      actor,
      { db },
    );

    expect(res.status).toBe(200);

    const rows = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));
    const row = rows[0];

    expect(row.humanConfidence).toBe(0.8);
    expect((row.response as any)?.confidence).toBe(0.8);
    expect((row.response as any)?.userComment).toBe("looks good");
  });
});

describe("respondToHitl integration — conflicting payload with real Postgres", () => {
  it("conflicting-payload re-submit throws CONFLICT, respondedAt unchanged", async () => {
    const projectId = await seedProject("test-conflict");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedFormHitl(runId, "review");
    const actor: HitlActor = {
      kind: "user",
      userId: "u-1",
      label: "Test User",
    };
    const firstPayload = { approved: true };
    const secondPayload = { approved: false };

    const firstRes = await respondToHitl(
      { runId, hitlRequestId, body: { response: firstPayload } },
      actor,
      { db },
    );

    expect(firstRes.status).toBe(200);

    const firstRows = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));
    const respondedAt = firstRows[0].respondedAt;

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { response: secondPayload } },
        actor,
        { db },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const secondRows = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));
    const row = secondRows[0];

    expect(row.response).toEqual(firstPayload);
    expect(row.respondedAt).toEqual(respondedAt);
  });
});

describe("respondToHitl integration — concurrent two-racer CAS (409 contract)", () => {
  it("two simultaneous responses on the same row → exactly one 200, one typed CONFLICT (never a raw Postgres error)", async () => {
    const projectId = await seedProject("test-race");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedFormHitl(runId, "review");
    const actor: HitlActor = {
      kind: "user",
      userId: "u-1",
      label: "Test User",
    };

    // Fire both concurrently. The Phase-1 row-lock CAS must serialize them into
    // ONE winner + ONE documented CONFLICT — never let a concurrent loser
    // surface a raw Postgres 23505 / serialization failure as an unmapped 500.
    const results = await Promise.allSettled([
      respondToHitl(
        { runId, hitlRequestId, body: { response: { approved: true } } },
        actor,
        { db },
      ),
      respondToHitl(
        { runId, hitlRequestId, body: { response: { approved: false } } },
        actor,
        { db },
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(
      (fulfilled[0] as PromiseFulfilledResult<{ status: number }>).value.status,
    ).toBe(200);
    expect(rejected).toHaveLength(1);
    // The loser MUST be a typed MaisterError CONFLICT (→ 409), not a raw pg
    // error (which the route wrapper would surface as an unmapped 500).
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
    });

    // Exactly one response persisted; respondedAt set once.
    const rows = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));

    expect(rows[0].respondedAt).not.toBeNull();
    expect([{ approved: true }, { approved: false }]).toContainEqual(
      rows[0].response,
    );
  });
});
