import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { finalizeAgentRun } from "@/lib/agents/launch";
import {
  cancelOpenAgentQuestionsForTask,
  cancelOpenAgentQuestionsForTaskInTransaction,
  createOrActivateAgentQuestion,
  recoverPendingAgentQuestions,
} from "@/lib/services/agent-question";
import { respondToHitl } from "@/lib/services/hitl";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
  type FakeExecutionHost,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;
let fake: FakeExecutionHost;

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
  // ADR-165: a fresh fake local host per case — the source session is torn
  // down through the client bound to the source run's assignment.
  fake = createFakeExecutionHost();
});

async function seed(options: { agentId?: string } = {}): Promise<Seed> {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const agentId = options.agentId ?? `test:${randomUUID().slice(0, 8)}`;
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

// The fake registered as THE local host, with the run's `launch` assignment
// minted so the teardown binds the way a driven run's would.
async function hostsFor(seed: Pick<Seed, "runId">) {
  const { hosts } = await fakeExecutionHosts(db, { fake, runId: seed.runId });

  return hosts;
}

// A live supervisor session for the seeded source run, as its driver left it.
function liveSource(
  sessionId: string,
  seed: Seed,
  acpSessionId: string = seed.acpSessionId,
): void {
  fake.sessions.set(sessionId, {
    sessionId,
    runId: seed.runId,
    stepId: "agent",
    acpSessionId,
    executionWorkspaceId: "ws-source",
    assignmentEpoch: 1,
    createdByCommandId: "seed",
    status: "live",
  });
}

function deletedSessions(): string[] {
  return fake.callsOf("deleteSession").map((call) => call.args[0] as string);
}

async function activateQuestion(seed: Seed, question = input(seed).question) {
  return await createOrActivateAgentQuestion(
    { ...input(seed), question },
    { db, executionHosts: await hostsFor(seed) },
  );
}

async function createSiblingQuestion(seed: Seed, question: string) {
  const runId = randomUUID();
  const acpSessionId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    runKind: "agent",
    projectId: seed.projectId,
    taskId: seed.taskId,
    agentId: seed.agentId,
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

  return await activateQuestion({ ...seed, runId, acpSessionId }, question);
}

async function seedHumanUser(userId: string): Promise<void> {
  await db.insert(schema.users).values({
    id: userId,
    name: "Human responder",
    email: `${userId}@example.test`,
    accountStatus: "active",
  });
}

describe("agent-question lifecycle (ADR-136, integration)", () => {
  it("persists intent, terminates the source, then atomically activates one assignment", async () => {
    const seeded = await seed();
    const hosts = await hostsFor(seeded);

    liveSource("supervisor-session-1", seeded);

    const result = await createOrActivateAgentQuestion(input(seeded), {
      db,
      executionHosts: hosts,
    });

    expect(result.activationState).toBe("active");
    expect(result.created).toBe(true);
    expect(deletedSessions()).toEqual(["supervisor-session-1"]);
    // ADR-165: the teardown is a fenced `session.delete` under the source
    // run's assignment.
    expect(fake.callsOf("deleteSession")[0]?.envelope).toMatchObject({
      command: { kind: "session.delete" },
      fence: { runId: seeded.runId, assignmentEpoch: 1 },
    });

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
      .select({
        status: schema.assignments.status,
        actionKind: schema.assignments.actionKind,
      })
      .from(schema.assignments)
      .where(eq(schema.assignments.hitlRequestId, result.hitlRequestId));

    expect(source?.status).toBe("Done");
    expect(request).toEqual({
      activationState: "active",
      taskId: seeded.taskId,
    });
    expect(clarification).toEqual({
      seq: 1,
      sourceHitlRequestId: result.hitlRequestId,
    });
    expect(assignment).toEqual({
      status: "open",
      actionKind: "agent_question",
    });
  });

  it("retries a durable pending ask after a retryable supervisor error without a duplicate row", async () => {
    const seeded = await seed();
    const hosts = await hostsFor(seeded);

    fake.failOnce(
      "listSessions",
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor offline"),
    );
    await expect(
      createOrActivateAgentQuestion(input(seeded), {
        db,
        executionHosts: hosts,
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });

    const [pending] = await db
      .select({
        id: schema.hitlRequests.id,
        activationState: schema.hitlRequests.activationState,
      })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(pending?.activationState).toBe("pending_termination");

    liveSource("supervisor-session-2", seeded);
    const replay = await createOrActivateAgentQuestion(input(seeded), {
      db,
      executionHosts: hosts,
    });

    expect(replay).toMatchObject({
      hitlRequestId: pending?.id,
      activationState: "active",
      created: false,
    });
    expect(deletedSessions()).toEqual(["supervisor-session-2"]);
    const rows = await db
      .select({ id: schema.hitlRequests.id })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(rows).toHaveLength(1);
    await expect(
      createOrActivateAgentQuestion(
        { ...input(seeded), question: "Use staging or production?" },
        { db, executionHosts: hosts },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("activates when the listed source session exits before its delete request", async () => {
    const seeded = await seed();
    const hosts = await hostsFor(seeded);

    liveSource("supervisor-session-gone", seeded);
    // The session exits between the list and the delete: the host answers
    // `gone` and the ask still activates.
    fake.onCall("deleteSession", () => {
      fake.sessions.delete("supervisor-session-gone");
    });

    const result = await createOrActivateAgentQuestion(input(seeded), {
      db,
      executionHosts: hosts,
    });

    expect(result.activationState).toBe("active");
    const [source] = await db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, seeded.runId));

    expect(source?.status).toBe("Done");
  });

  it("keeps the intent pending when source deletion is temporarily unavailable", async () => {
    const seeded = await seed();
    const hosts = await hostsFor(seeded);

    liveSource("supervisor-session-retry", seeded);
    fake.failOnce(
      "deleteSession",
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor restart"),
    );

    await expect(
      createOrActivateAgentQuestion(input(seeded), {
        db,
        executionHosts: hosts,
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });

    const [request] = await db
      .select({ activationState: schema.hitlRequests.activationState })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(request?.activationState).toBe("pending_termination");
  });

  it("fails a source-session identity mismatch without exposing an Inbox assignment", async () => {
    const seeded = await seed();
    const hosts = await hostsFor(seeded);

    liveSource("supervisor-session-mismatch", seeded, randomUUID());

    await expect(
      createOrActivateAgentQuestion(input(seeded), {
        db,
        executionHosts: hosts,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(deletedSessions()).toEqual([]);

    const [request] = await db
      .select({ activationState: schema.hitlRequests.activationState })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));
    const assignments = await db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(eq(schema.assignments.runId, seeded.runId));

    expect(request?.activationState).toBe("failed");
    expect(assignments).toEqual([]);
  });

  it("normalizes a source crash after durable intent into the human-ask Done outcome", async () => {
    const seeded = await seed();
    const hosts = await hostsFor(seeded);

    fake.failOnce(
      "listSessions",
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor offline"),
    );
    await expect(
      createOrActivateAgentQuestion(input(seeded), {
        db,
        executionHosts: hosts,
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
    await db
      .update(schema.runs)
      .set({ status: "Crashed", endedAt: new Date() })
      .where(eq(schema.runs.id, seeded.runId));

    const result = await createOrActivateAgentQuestion(input(seeded), {
      db,
      executionHosts: hosts,
    });

    const [source] = await db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, seeded.runId));

    expect(result.activationState).toBe("active");
    expect(source?.status).toBe("Done");
  });

  it("defers generic terminal finalization until the pending human ask owns Done", async () => {
    const seeded = await seed();
    const hosts = await hostsFor(seeded);

    fake.failOnce(
      "listSessions",
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor offline"),
    );
    await expect(
      createOrActivateAgentQuestion(input(seeded), {
        db,
        executionHosts: hosts,
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });

    await expect(
      finalizeAgentRun(seeded.runId, "Crashed", {
        db,
        reason: "supervisor reported session crash",
      }),
    ).resolves.toEqual({ finalized: false });

    const [deferredSource] = await db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, seeded.runId));

    expect(deferredSource?.status).toBe("Running");

    const activated = await createOrActivateAgentQuestion(input(seeded), {
      db,
      executionHosts: hosts,
    });
    const [source] = await db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, seeded.runId));

    expect(activated.activationState).toBe("active");
    expect(source?.status).toBe("Done");
  });

  it("supersedes every still-open sibling and its assignment only after a successor run exists", async () => {
    const seeded = await seed();
    const hosts = await hostsFor(seeded);
    const created = await createOrActivateAgentQuestion(input(seeded), {
      db,
      executionHosts: hosts,
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
      .select({
        supersededByRunId: schema.taskClarifications.supersededByRunId,
      })
      .from(schema.taskClarifications)
      .where(
        eq(
          schema.taskClarifications.sourceHitlRequestId,
          created.hitlRequestId,
        ),
      );
    const [assignment] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.hitlRequestId, created.hitlRequestId));

    expect(request?.supersededByRunId).toBe(successorRunId);
    expect(clarification?.supersededByRunId).toBe(successorRunId);
    expect(assignment?.status).toBe("cancelled");
  });

  it("serializes a human answer and successor supersession into one terminal winner", async () => {
    const seeded = await seed();
    const question = await activateQuestion(seeded);
    const successorRunId = randomUUID();
    const actor = {
      kind: "user" as const,
      userId: "answer-launch-racer",
      label: "Human responder",
      preauthorizedProjectId: seeded.projectId,
    };

    await seedHumanUser(actor.userId);
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

    const [answer, supersession] = await Promise.allSettled([
      respondToHitl(
        {
          runId: seeded.runId,
          hitlRequestId: question.hitlRequestId,
          body: { response: { target: "staging" } },
        },
        actor,
        { db },
      ),
      db.transaction(
        async (tx) =>
          await cancelOpenAgentQuestionsForTaskInTransaction(tx, {
            taskId: seeded.taskId,
            supersedingRunId: successorRunId,
          }),
      ),
    ]);

    const answerWon =
      answer.status === "fulfilled" && answer.value.status === 200;
    const supersessionWon =
      supersession.status === "fulfilled" && supersession.value === 1;

    expect(answerWon || supersessionWon).toBe(true);
    expect(answerWon && supersessionWon).toBe(false);

    const [request] = await db
      .select({
        respondedAt: schema.hitlRequests.respondedAt,
        supersededAt: schema.hitlRequests.supersededAt,
      })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, question.hitlRequestId));
    const [assignment] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.hitlRequestId, question.hitlRequestId));

    expect(request?.respondedAt !== null).toBe(answerWon);
    expect(request?.supersededAt !== null).toBe(supersessionWon);
    expect(assignment?.status).toBe(answerWon ? "completed" : "cancelled");
  });

  it("recovers a pending ask after the source naturally exits without another MCP call", async () => {
    const seeded = await seed();
    const hosts = await hostsFor(seeded);

    fake.failOnce(
      "listSessions",
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor offline"),
    );
    await expect(
      createOrActivateAgentQuestion(input(seeded), {
        db,
        executionHosts: hosts,
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
      await recoverPendingAgentQuestions({
        db,
        sessions: [],
        executionHosts: hosts,
      }),
    ).toBe(1);

    const [request] = await db
      .select({ activationState: schema.hitlRequests.activationState })
      .from(schema.hitlRequests)
      .where(and(eq(schema.hitlRequests.runId, seeded.runId)));

    expect(request?.activationState).toBe("active");
  });

  it("recovers after source termination succeeded but the activation transaction rolled back", async () => {
    const seeded = await seed();
    const hosts = await hostsFor(seeded);

    liveSource("supervisor-session-rollback", seeded);

    await expect(
      createOrActivateAgentQuestion(input(seeded), {
        db,
        executionHosts: hosts,
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

    expect(deletedSessions()).toEqual(["supervisor-session-rollback"]);
    expect(pending?.activationState).toBe("pending_termination");
    expect(runningSource?.status).toBe("Running");
    expect(
      await recoverPendingAgentQuestions({
        db,
        sessions: [],
        executionHosts: hosts,
      }),
    ).toBe(1);

    const [recovered] = await db
      .select({ activationState: schema.hitlRequests.activationState })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(recovered?.activationState).toBe("active");
  });

  it("marks the request terminally failed after a non-retryable supervisor refusal", async () => {
    const seeded = await seed();
    const hosts = await hostsFor(seeded);

    liveSource("supervisor-session-refused", seeded);
    fake.failOnce(
      "deleteSession",
      new MaisterError("ACP_PROTOCOL", "supervisor rejected deletion"),
    );

    await expect(
      createOrActivateAgentQuestion(input(seeded), {
        db,
        executionHosts: hosts,
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
    const hosts = await hostsFor(seeded);

    await expect(
      createOrActivateAgentQuestion(
        { ...input(seeded), reTriggerMode: "triage" },
        { db, executionHosts: hosts },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("answers atomically, supersedes siblings, emits one directed event, and replays safely", async () => {
    const seeded = await seed();
    const winner = await activateQuestion(seeded);
    const sibling = await createSiblingQuestion(
      seeded,
      "Which region should receive the deployment?",
    );
    const response = { target: "staging" };
    let auditCount = 0;
    const actor = {
      kind: "user" as const,
      userId: "human-ask-responder",
      label: "Human responder",
      preauthorizedProjectId: seeded.projectId,
    };

    await seedHumanUser(actor.userId);
    await db
      .update(schema.runs)
      .set({ status: "Crashed", endedAt: new Date() })
      .where(eq(schema.runs.id, seeded.runId));

    const first = await respondToHitl(
      {
        runId: seeded.runId,
        hitlRequestId: winner.hitlRequestId,
        body: { response },
      },
      actor,
      {
        db,
        recordSuccessAudit: async () => {
          auditCount += 1;
        },
      },
    );

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, runStatus: "Done" });

    const [answered] = await db
      .select({
        response: schema.hitlRequests.response,
        respondedAt: schema.hitlRequests.respondedAt,
      })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, winner.hitlRequestId));
    const [answeredClarification] = await db
      .select({
        answer: schema.taskClarifications.answer,
        answeredByUserId: schema.taskClarifications.answeredByUserId,
      })
      .from(schema.taskClarifications)
      .where(
        eq(schema.taskClarifications.sourceHitlRequestId, winner.hitlRequestId),
      );
    const [superseded] = await db
      .select({
        supersededByHitlRequestId:
          schema.hitlRequests.supersededByHitlRequestId,
      })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, sibling.hitlRequestId));
    const assignmentRows = await db
      .select({
        hitlRequestId: schema.assignments.hitlRequestId,
        status: schema.assignments.status,
      })
      .from(schema.assignments)
      .where(
        and(
          eq(schema.assignments.projectId, seeded.projectId),
          eq(schema.assignments.actionKind, "agent_question"),
        ),
      );
    const events = await db
      .select({
        kind: schema.domainEvents.kind,
        payload: schema.domainEvents.payload,
      })
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.taskId, seeded.taskId));
    const [source] = await db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, seeded.runId));

    expect(answered).toMatchObject({ response, respondedAt: expect.any(Date) });
    expect(answeredClarification).toEqual({
      answer: response,
      answeredByUserId: actor.userId,
    });
    expect(superseded?.supersededByHitlRequestId).toBe(winner.hitlRequestId);
    expect(assignmentRows).toEqual(
      expect.arrayContaining([
        { hitlRequestId: winner.hitlRequestId, status: "completed" },
        { hitlRequestId: sibling.hitlRequestId, status: "cancelled" },
      ]),
    );
    expect(events).toEqual([
      {
        kind: "task.clarification_answered",
        payload: {
          clarificationId: expect.any(String),
          hitlRequestId: winner.hitlRequestId,
          requestingAgentId: seeded.agentId,
        },
      },
    ]);
    expect(auditCount).toBe(1);
    expect(source?.status).toBe("Done");

    const replay = await respondToHitl(
      {
        runId: seeded.runId,
        hitlRequestId: winner.hitlRequestId,
        body: { response },
      },
      actor,
      {
        db,
        recordSuccessAudit: async () => {
          auditCount += 1;
        },
      },
    );

    expect(await replay.json()).toEqual({
      ok: true,
      runStatus: "Done",
      idempotent: true,
    });
    expect(auditCount).toBe(2);
    await expect(
      respondToHitl(
        {
          runId: seeded.runId,
          hitlRequestId: winner.hitlRequestId,
          body: { response: { target: "production" } },
        },
        actor,
        { db },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rolls back the answer, assignment, and event when its audit write fails", async () => {
    const seeded = await seed();
    const question = await activateQuestion(seeded);
    const actor = {
      kind: "user" as const,
      userId: "audit-failure-responder",
      label: "Human responder",
      preauthorizedProjectId: seeded.projectId,
    };

    await seedHumanUser(actor.userId);

    await expect(
      respondToHitl(
        {
          runId: seeded.runId,
          hitlRequestId: question.hitlRequestId,
          body: { response: { target: "staging" } },
        },
        actor,
        {
          db,
          recordSuccessAudit: async () => {
            throw new Error("forced answer audit rollback");
          },
        },
      ),
    ).rejects.toThrow("forced answer audit rollback");

    const [request] = await db
      .select({
        response: schema.hitlRequests.response,
        respondedAt: schema.hitlRequests.respondedAt,
      })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, question.hitlRequestId));
    const [clarification] = await db
      .select({
        answer: schema.taskClarifications.answer,
        answeredAt: schema.taskClarifications.answeredAt,
      })
      .from(schema.taskClarifications)
      .where(
        eq(
          schema.taskClarifications.sourceHitlRequestId,
          question.hitlRequestId,
        ),
      );
    const [assignment] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.hitlRequestId, question.hitlRequestId));
    const events = await db
      .select({ id: schema.domainEvents.id })
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.taskId, seeded.taskId));

    expect(request).toEqual({ response: null, respondedAt: null });
    expect(clarification).toEqual({ answer: null, answeredAt: null });
    expect(assignment?.status).toBe("open");
    expect(events).toEqual([]);
  });

  it("requeues a triager clarification through the triage event only", async () => {
    const seeded = await seed({ agentId: "core:triager" });
    const question = await createOrActivateAgentQuestion(
      { ...input(seeded), reTriggerMode: "triage" },
      { db, executionHosts: await hostsFor(seeded) },
    );

    await seedHumanUser("triage-responder");

    await respondToHitl(
      {
        runId: seeded.runId,
        hitlRequestId: question.hitlRequestId,
        body: { response: { target: "production" } },
      },
      {
        kind: "user",
        userId: "triage-responder",
        label: "Human responder",
        preauthorizedProjectId: seeded.projectId,
      },
      { db },
    );

    const events = await db
      .select({ kind: schema.domainEvents.kind })
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.taskId, seeded.taskId));

    expect(events).toEqual([{ kind: "task.triage_requeued" }]);
  });
});
