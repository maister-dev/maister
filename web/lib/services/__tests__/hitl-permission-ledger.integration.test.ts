// ADR-165 (T4.2 I1–I3 + the driver yield rule) on real Postgres: the permission
// response's `session.input` command is queued in the Phase-1 claim tx and
// delivered afterwards; its ledger row and `hitl_requests.responded_at` land
// together; a definitive 503 leaves the row `failed` and respondedAt NULL, and
// the user's retry issues a NEW command; a host replay after a lost response
// records `_audit.deliveredOptionId`; a fenced delivery writes nothing.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asc, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  afterAll,
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
import { mintAssignment } from "@/lib/execution-host";
import { respondToHitl, type HitlActor } from "@/lib/services/hitl";
import {
  definitiveUnavailableError,
  fakeExecutionHosts,
  type FakeExecutionHost,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let runtimeRoot: string;
let projectId: string;
let executorId: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/flows/runner", () => ({ runFlow: vi.fn(async () => {}) }));
vi.mock("@/lib/runs/resume-driver", () => ({
  scheduleResumedSessionDrive: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => {}),
}));

const actor: HitlActor = { kind: "user", userId: "u-1", label: "Test User" };

beforeAll(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "hitl-ledger-"));
  process.env.MAISTER_RUNTIME_ROOT = runtimeRoot;
  testDatabase = await startMainPostgresTestDb({
    databaseName: "hitl_permission_ledger_test",
  });
  db = testDatabase.db;
  projectId = randomUUID();
  executorId = randomUUID();
  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "hitl-ledger",
    name: "HITL ledger",
    repoPath: "/repos/hitl-ledger",
    maisterYamlPath: "/repos/hitl-ledger/maister.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
  await rm(runtimeRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.delete(schema.executionCommands);
  await db.delete(schema.hitlRequests);
  await db.delete(schema.runSessions);
  await db.delete(schema.runs);
});

type Seeded = {
  runId: string;
  hitlRequestId: string;
  hosts: Awaited<ReturnType<typeof fakeExecutionHosts>>["hosts"];
  fake: FakeExecutionHost;
};

async function seedLiveNeedsInput(): Promise<Seeded> {
  const runId = randomUUID();
  const hitlRequestId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "flow",
    status: "NeedsInput",
    currentStepId: "plan",
    flowVersion: "v1.0.0",
    keepaliveUntil: new Date(Date.now() + 60_000),
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    acpSessionId: "acp-1",
    hostSessionId: "sup-1",
  });
  await db.insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId: "plan",
    kind: "permission",
    prompt: "Allow?",
    schema: {
      requestId: "req-1",
      supervisorSessionId: "sup-1",
      options: [{ optionId: "allow" }, { optionId: "deny" }],
    },
  });

  const { hosts, fake } = await fakeExecutionHosts(db, { runId });

  fake.sessions.set("sup-1", {
    sessionId: "sup-1",
    runId,
    stepId: "plan",
    acpSessionId: "acp-1",
    executionWorkspaceId: "ws_seeded",
    assignmentEpoch: 1,
    createdByCommandId: "seeded",
    status: "live",
  });

  return { runId, hitlRequestId, hosts, fake };
}

async function commandRows(runId: string) {
  return db
    .select()
    .from(schema.executionCommands)
    .where(eq(schema.executionCommands.runId, runId))
    .orderBy(asc(schema.executionCommands.createdAt));
}

async function hitlRow(id: string) {
  const rows = await db
    .select()
    .from(schema.hitlRequests)
    .where(eq(schema.hitlRequests.id, id));

  return rows[0];
}

describe("permission response ledger (ADR-165 I1–I3)", () => {
  it("I1: the session.input command lands `succeeded` together with respondedAt", async () => {
    const { runId, hitlRequestId, hosts, fake } = await seedLiveNeedsInput();

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(200);
    const rows = await commandRows(runId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "session.input",
      state: "succeeded",
      targetSessionId: "sup-1",
      assignmentEpoch: 1,
      payload: {
        kind: "permission",
        action: "select",
        requestId: "req-1",
        optionId: "allow",
      },
    });
    expect(rows[0].completedAt).toBeInstanceOf(Date);
    const hitl = await hitlRow(hitlRequestId);

    expect(hitl.response).toEqual({ optionId: "allow" });
    expect(hitl.respondedAt).toBeInstanceOf(Date);
    expect(fake.callsOf("deliverInput")).toHaveLength(1);
    expect(fake.callsOf("deliverInput")[0].envelope?.command.id).toBe(
      rows[0].id,
    );
  });

  it("I2: a definitive 503 leaves respondedAt NULL and the command `failed`; the retry issues a NEW command", async () => {
    const { runId, hitlRequestId, hosts, fake } = await seedLiveNeedsInput();

    fake.failOnce("deliverInput", definitiveUnavailableError());

    const first = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db, executionHosts: hosts },
    );

    expect(first.status).toBe(503);
    const afterFirst = await commandRows(runId);

    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].state).toBe("failed");
    expect((await hitlRow(hitlRequestId)).respondedAt).toBeNull();
    expect((await hitlRow(hitlRequestId)).response).toEqual({
      optionId: "allow",
    });

    const second = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db, executionHosts: hosts },
    );

    expect(second.status).toBe(200);
    const afterSecond = await commandRows(runId);

    expect(afterSecond.map((r) => r.state)).toEqual(["failed", "succeeded"]);
    expect(afterSecond[1].id).not.toBe(afterSecond[0].id);
    expect((await hitlRow(hitlRequestId)).respondedAt).toBeInstanceOf(Date);
  });

  it("I3: a lost response is retried under the SAME command id; the host replay records _audit.deliveredOptionId", async () => {
    const { runId, hitlRequestId, hosts, fake } = await seedLiveNeedsInput();

    fake.loseResponseOnce("deliverInput");

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(200);
    const deliveries = fake.callsOf("deliverInput");

    expect(deliveries).toHaveLength(2);
    expect(deliveries[0].envelope?.command.id).toBe(
      deliveries[1].envelope?.command.id,
    );
    const rows = await commandRows(runId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "succeeded", attempts: 2 });
    expect((await hitlRow(hitlRequestId)).response).toEqual({
      optionId: "allow",
      _audit: { deliveredOptionId: "allow" },
    });
  });

  it("yield rule: a delivery fenced by a newer driver generation writes no run/HITL state and cancels nothing", async () => {
    const { runId, hitlRequestId, hosts, fake } = await seedLiveNeedsInput();

    // A resume raced the response: epoch 2 exists and the host already saw it.
    await db.transaction(async (tx) => {
      await mintAssignment(tx as never, {
        runId,
        hostId: (await hosts.forRun(runId)).host.id,
        reason: "resume",
      });
    });
    await (await hosts.forRun(runId)).checkpoint("no-such-session");
    fake.sessions.get("sup-1")!.status = "live";

    // The response binds the run's ACTIVE (epoch 2) assignment, so the wire
    // itself is admitted; the fence is exercised by the stale-epoch client the
    // previous driver still holds.
    const stale = await hosts.forAssignment({
      id: (
        await db
          .select()
          .from(schema.executionAssignments)
          .where(eq(schema.executionAssignments.runId, runId))
          .orderBy(asc(schema.executionAssignments.epoch))
      )[0].id,
    });

    await expect(
      stale.deliverInput("sup-1", {
        kind: "permission",
        action: "select",
        requestId: "req-1",
        optionId: "allow",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "assignment_fenced" },
    });
    expect((await hitlRow(hitlRequestId)).respondedAt).toBeNull();
    expect(
      (await commandRows(runId))
        .filter((r) => r.kind === "session.input")
        .map((r) => r.state),
    ).toEqual(["fenced"]);
    // A superseded assignment admits nothing: the select was fenced locally
    // (no wire call) and no cancel followed it.
    expect(fake.callsOf("deliverInput")).toHaveLength(0);
  });
});
