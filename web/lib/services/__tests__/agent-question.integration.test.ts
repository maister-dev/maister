import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  cancelOpenAgentQuestionsForTask,
  createOrActivateAgentQuestion,
  recoverPendingAgentQuestions,
} from "@/lib/services/agent-question";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;

type Seed = {
  projectId: string;
  taskId: string;
  runId: string;
  agentId: string;
  acpSessionId: string;
};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "agent_question_service_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await testDatabase.pool.query('TRUNCATE TABLE "projects" CASCADE');
});

async function seed(): Promise<Seed> {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const agentId = `test:${randomUUID().slice(0, 8)}`;
  const acpSessionId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `human-ask-${projectId.slice(0, 8)}`,
    name: "Human ask",
    repoPath: `/tmp/${projectId}`,
    taskKey: "ASK",
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: 1,
    title: "Clarify target",
    prompt: "Deploy the service",
  });
  await db.insert(schema.agents).values({
    id: agentId,
    packageName: "test",
    versionLabel: "v1",
    origin: "authored",
    name: "Test agent",
    description: "Test agent",
    workspace: "none",
    mode: "session",
    triggers: [],
    riskTier: "standard",
    sourcePath: "/tmp/test-agent.md",
  });
  await db.insert(schema.runs).values({
    id: runId,
    runKind: "agent",
    projectId,
    taskId,
    agentId,
    status: "Running",
    currentStepId: "agent",
    flowVersion: "agent",
    flowRevision: "manual",
    agentWorkspace: "none",
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    acpSessionId,
  });

  return { projectId, taskId, runId, agentId, acpSessionId };
}

function input(seed: Seed) {
  return {
    projectId: seed.projectId,
    taskId: seed.taskId,
    sourceRunId: seed.runId,
    sourceAgentId: seed.agentId,
    question: "Which deployment target should be used?",
    schema: {
      schemaVersion: 1,
      fields: [
        {
          name: "target",
          type: "enum" as const,
          required: true,
          options: ["staging", "production"],
        },
      ],
    },
    reTriggerMode: "agent" as const,
  };
}

describe("agent-question lifecycle (ADR-136, integration)", () => {
  it("persists intent, terminates the source, then atomically activates one assignment", async () => {
    const seeded = await seed();
    const deleted: string[] = [];

    const result = await createOrActivateAgentQuestion(input(seeded), {
      db,
      listSessions: async () => [
        {
          sessionId: "supervisor-session-1",
          runId: seeded.runId,
          projectSlug: "human-ask",
          stepId: "agent",
          status: "live",
          pid: 1,
          startedAt: new Date().toISOString(),
          logPath: "/tmp/supervisor.log",
          monotonicId: 1,
          acpSessionId: seeded.acpSessionId,
        },
      ],
      deleteSession: async (sessionId) => {
        deleted.push(sessionId);
      },
    });

    expect(result.activationState).toBe("active");
    expect(result.created).toBe(true);
    expect(deleted).toEqual(["supervisor-session-1"]);

    const [source] = await db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, seeded.runId));
    const [request] = await db
      .select({
        activationState: schema.hitlRequests.activationState,
        taskId: schema.hitlRequests.taskId,
      })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, result.hitlRequestId));
    const [clarification] = await db
      .select({
        seq: schema.taskClarifications.seq,
        sourceHitlRequestId: schema.taskClarifications.sourceHitlRequestId,
      })
      .from(schema.taskClarifications)
      .where(eq(schema.taskClarifications.taskId, seeded.taskId));
    const [assignment] = await db
      .select({ status: schema.assignments.status, actionKind: schema.assignments.actionKind })
      .from(schema.assignments)
      .where(eq(schema.assignments.hitlRequestId, result.hitlRequestId));

    expect(source?.status).toBe("Done");
    expect(request).toEqual({ activationState: "active", taskId: seeded.taskId });
    expect(clarification).toEqual({
      seq: 1,
      sourceHitlRequestId: result.hitlRequestId,
    });
    expect(assignment).toEqual({ status: "open", actionKind: "agent_question" });
  });

  it("retries a durable pending ask after a retryable supervisor error without a duplicate row", async () => {
    const seeded = await seed();

    await expect(
      createOrActivateAgentQuestion(input(seeded), {
        db,
        listSessions: async () => {
          throw new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor offline");
        },
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });

    const [pending] = await db
      .select({ id: schema.hitlRequests.id, activationState: schema.hitlRequests.activationState })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(pending?.activationState).toBe("pending_termination");

    const replay = await createOrActivateAgentQuestion(input(seeded), {
      db,
      listSessions: async () => [
        {
          sessionId: "supervisor-session-2",
          runId: seeded.runId,
          projectSlug: "human-ask",
          stepId: "agent",
          status: "live",
          pid: 1,
          startedAt: new Date().toISOString(),
          logPath: "/tmp/supervisor.log",
          monotonicId: 1,
          acpSessionId: seeded.acpSessionId,
        },
      ],
      deleteSession: async () => undefined,
    });

    expect(replay).toMatchObject({
      hitlRequestId: pending?.id,
      activationState: "active",
      created: false,
    });
    const rows = await db
      .select({ id: schema.hitlRequests.id })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(rows).toHaveLength(1);
    await expect(
      createOrActivateAgentQuestion(
        { ...input(seeded), question: "Use staging or production?" },
        { db, listSessions: async () => [] },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("supersedes every still-open sibling and its assignment only after a successor run exists", async () => {
    const seeded = await seed();
    const created = await createOrActivateAgentQuestion(input(seeded), {
      db,
      listSessions: async () => [],
    });
    const successorRunId = randomUUID();

    await db.insert(schema.runs).values({
      id: successorRunId,
      runKind: "agent",
      projectId: seeded.projectId,
      taskId: seeded.taskId,
      agentId: seeded.agentId,
      status: "Pending",
      currentStepId: "agent",
      flowVersion: "agent",
      flowRevision: "manual",
      agentWorkspace: "none",
    });

    expect(
      await cancelOpenAgentQuestionsForTask({
        db,
        taskId: seeded.taskId,
        supersedingRunId: successorRunId,
      }),
    ).toBe(1);
    expect(
      await cancelOpenAgentQuestionsForTask({
        db,
        taskId: seeded.taskId,
        supersedingRunId: successorRunId,
      }),
    ).toBe(0);

    const [request] = await db
      .select({ supersededByRunId: schema.hitlRequests.supersededByRunId })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, created.hitlRequestId));
    const [clarification] = await db
      .select({ supersededByRunId: schema.taskClarifications.supersededByRunId })
      .from(schema.taskClarifications)
      .where(eq(schema.taskClarifications.sourceHitlRequestId, created.hitlRequestId));
    const [assignment] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.hitlRequestId, created.hitlRequestId));

    expect(request?.supersededByRunId).toBe(successorRunId);
    expect(clarification?.supersededByRunId).toBe(successorRunId);
    expect(assignment?.status).toBe("cancelled");
  });

  it("recovers a pending ask after the source naturally exits without another MCP call", async () => {
    const seeded = await seed();

    await expect(
      createOrActivateAgentQuestion(input(seeded), {
        db,
        listSessions: async () => {
          throw new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor offline");
        },
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
    await db
      .update(schema.runs)
      .set({ status: "Done", endedAt: new Date() })
      .where(eq(schema.runs.id, seeded.runId));
    await db
      .update(schema.runSessions)
      .set({ acpSessionId: null })
      .where(eq(schema.runSessions.runId, seeded.runId));

    expect(
      await recoverPendingAgentQuestions({ db, sessions: [] }),
    ).toBe(1);

    const [request] = await db
      .select({ activationState: schema.hitlRequests.activationState })
      .from(schema.hitlRequests)
      .where(and(eq(schema.hitlRequests.runId, seeded.runId)));

    expect(request?.activationState).toBe("active");
  });

  it("recovers after source termination succeeded but the activation transaction rolled back", async () => {
    const seeded = await seed();
    const deleted: string[] = [];

    await expect(
      createOrActivateAgentQuestion(input(seeded), {
        db,
        listSessions: async () => [
          {
            sessionId: "supervisor-session-rollback",
            runId: seeded.runId,
            projectSlug: "human-ask",
            stepId: "agent",
            status: "live",
            pid: 1,
            startedAt: new Date().toISOString(),
            logPath: "/tmp/supervisor.log",
            monotonicId: 1,
            acpSessionId: seeded.acpSessionId,
          },
        ],
        deleteSession: async (sessionId) => {
          deleted.push(sessionId);
        },
        recordSuccessAudit: async () => {
          throw new Error("forced activation transaction rollback");
        },
      }),
    ).rejects.toThrow("forced activation transaction rollback");

    const [pending] = await db
      .select({ activationState: schema.hitlRequests.activationState })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));
    const [runningSource] = await db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, seeded.runId));

    expect(deleted).toEqual(["supervisor-session-rollback"]);
    expect(pending?.activationState).toBe("pending_termination");
    expect(runningSource?.status).toBe("Running");
    expect(await recoverPendingAgentQuestions({ db, sessions: [] })).toBe(1);

    const [recovered] = await db
      .select({ activationState: schema.hitlRequests.activationState })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(recovered?.activationState).toBe("active");
  });

  it("marks the request terminally failed after a non-retryable supervisor refusal", async () => {
    const seeded = await seed();

    await expect(
      createOrActivateAgentQuestion(input(seeded), {
        db,
        listSessions: async () => [
          {
            sessionId: "supervisor-session-refused",
            runId: seeded.runId,
            projectSlug: "human-ask",
            stepId: "agent",
            status: "live",
            pid: 1,
            startedAt: new Date().toISOString(),
            logPath: "/tmp/supervisor.log",
            monotonicId: 1,
            acpSessionId: seeded.acpSessionId,
          },
        ],
        deleteSession: async () => {
          throw new MaisterError("ACP_PROTOCOL", "supervisor rejected deletion");
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const [failed] = await db
      .select({ activationState: schema.hitlRequests.activationState })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(failed?.activationState).toBe("failed");
  });

  it("refuses a generic agent attempting the triager-only re-trigger mode", async () => {
    const seeded = await seed();

    await expect(
      createOrActivateAgentQuestion(
        { ...input(seeded), reTriggerMode: "triage" },
        { db, listSessions: async () => [] },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
