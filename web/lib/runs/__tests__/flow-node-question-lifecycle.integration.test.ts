import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createHitlAssignmentForRun } from "@/lib/assignments/service";
import { assignments, hitlRequests, nodeAttempts, runs } from "@/lib/db/schema";
import { getActivityFeed } from "@/lib/queries/activity";
import { closeCrashedNodeAttempts } from "@/lib/runs/crash-recover";
import { reconcileClosedFlowNodeQuestions } from "@/lib/runs/flow-question-lifecycle";
import { runPass2 } from "@/lib/runs/keepalive-sweeper";
import { crashRunningRun, markAbandoned } from "@/lib/runs/state-transitions";
import { stopWorkbenchRun } from "@/lib/workbench-lifecycle/service";
import {
  seedProject,
  seedRun,
  seedWorkspace,
} from "@/test-support/execution-host-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  declareCurrentTestDatabaseWriter,
  startMainPostgresTestDb,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: Db;

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => db,
}));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({
    id: "lifecycle-operator",
    role: "admin",
  }),
  requireProjectAction: async () => undefined,
}));

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "flow_node_question_lifecycle",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seedParkedQuestion(db: StartedPostgresTestDb["db"]) {
  const projectId = await seedProject(db);
  const runId = await seedRun(db, {
    projectId,
    runKind: "flow",
    status: "NeedsInputIdle",
  });

  await seedWorkspace(db, {
    runId,
    projectId,
    parentRepoPath: "/tmp/flow-question-test",
    worktreePath: `/tmp/flow-question-test/${runId}`,
  });
  const { assignment } = await fakeExecutionHosts(db, { runId });
  const attemptId = randomUUID();
  const questionId = randomUUID();
  const assignmentId = assignment!.id;

  await db.insert(nodeAttempts).values({
    id: attemptId,
    runId,
    nodeId: "design",
    nodeType: "ai_coding",
    status: "NeedsInput",
    attempt: 1,
    executionAssignmentId: assignmentId,
    actionPromptOrdinal: 1,
    actionResume: {
      version: 1,
      kind: "node_question",
      questionId,
      checkpointCommandId: "fixture-checkpoint",
      sourceCommandId: "fixture-prompt",
      sourceAssignmentId: assignmentId,
      assignmentId,
      sourceIncarnationId: "fixture-incarnation",
      promptOrdinal: 1,
      resumeSessionId: "fixture-acp-session",
    },
  });
  await db.insert(hitlRequests).values({
    id: questionId,
    runId,
    stepId: "design",
    kind: "agent_question",
    prompt: "Which path?",
    activationState: "active",
    flowNodeAttemptId: attemptId,
    flowRequestKey: "choose-path",
    schema: {
      schemaVersion: 1,
      fields: [{ name: "path", type: "string", required: true }],
      flowQuestion: {
        nodeAttemptId: attemptId,
        promptOrdinal: 0,
        commandId: "fixture-prompt",
        assignmentId,
        incarnationId: "fixture-incarnation",
      },
      supervisorSessionId: "fixture-host-session",
      tokenId: "fixture-token",
      requestDigest: "a".repeat(64),
    },
  });
  const work = await createHitlAssignmentForRun({
    db,
    runId,
    stepId: "design",
    hitlRequestId: questionId,
    actionKind: "agent_question",
    title: "Which path?",
    roleRefs: [],
  });

  return { projectId, runId, attemptId, questionId, workId: work.id };
}

it.each(["crash", "ttl", "abandon", "stop"] as const)(
  "IT-EDGE-ASK-03 closes an unanswered node question and its Inbox work through %s",
  async (operation) => {
    const { projectId, runId, attemptId, questionId, workId } =
      await seedParkedQuestion(testDatabase.db);

    switch (operation) {
      case "crash":
        await expect(
          crashRunningRun(runId, "agent-session-gone", {
            db,
            fromStatuses: ["NeedsInputIdle"],
          }),
        ).resolves.toMatchObject({ ok: true });
        expect(
          await closeCrashedNodeAttempts(db, { runId, nodeId: "design" }),
        ).toEqual([attemptId]);
        break;
      case "ttl":
        await db
          .update(runs)
          .set({ checkpointAt: new Date(0) })
          .where(eq(runs.id, runId));
        await expect(runPass2(db)).resolves.toBe(1);
        break;
      case "abandon":
        await expect(markAbandoned(runId, { db })).resolves.toMatchObject({
          ok: true,
        });
        break;
      case "stop":
        expect(await getActivityFeed(projectId)).toContainEqual(
          expect.objectContaining({ id: `hitl-${questionId}` }),
        );
        await expect(stopWorkbenchRun(runId)).resolves.toMatchObject({
          ok: true,
          runStatus: "Review",
        });
        expect(await getActivityFeed(projectId)).not.toContainEqual(
          expect.objectContaining({ id: `hitl-${questionId}` }),
        );
        break;
    }

    const [row] = await db
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, questionId));
    const [inbox] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, workId));

    expect(row).toMatchObject({
      supersededAt: expect.any(Date),
      response: null,
      respondedAt: null,
      supersededByRunId: null,
      supersededByHitlRequestId: null,
      flowAnswerAcceptedAt: null,
    });
    expect(inbox.status).toBe("cancelled");
  },
);

it("IT-EDGE-ASK-05 repairs a pre-upgrade orphan while retaining the task-question invariant", async () => {
  const cutoff = "0406_flow_node_questions";
  const prior = await startMainPostgresTestDbUpTo(
    {
      databaseName: "flow_node_question_closure_upgrade",
    },
    cutoff,
  );

  try {
    await declareCurrentTestDatabaseWriter(prior);
    const { projectId, runId, questionId, workId } = await seedParkedQuestion(
      prior.db,
    );
    const taskId = randomUUID();
    const legacyQuestionId = randomUUID();

    await prior.db
      .execute(sql`INSERT INTO tasks(id,project_id,number,title,prompt)
      VALUES(${taskId},${projectId},1,'Request','Review')`);
    await prior.db
      .execute(sql`INSERT INTO hitl_requests(id,run_id,step_id,kind,prompt,schema,task_id,activation_state,retrigger_mode)
      VALUES (${legacyQuestionId},${runId},'previous','agent_question','Keep waiting','{}',${taskId},'active','agent')`);
    // This is the exact orphan old Stop/Abandon could have left before the upgrade.
    await prior.db
      .update(runs)
      .set({ status: "Abandoned", endedAt: new Date() })
      .where(eq(runs.id, runId));
    const close = (id: string) =>
      prior.db
        .update(hitlRequests)
        .set({ supersededAt: new Date() })
        .where(eq(hitlRequests.id, id));

    await expect(close(questionId)).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint: "hitl_requests_agent_question_supersession_check",
      },
    });
    await upgradeMainTestDb(prior, cutoff);
    await reconcileClosedFlowNodeQuestions(prior.db);

    expect(
      (
        await prior.db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.id, questionId))
      )[0],
    ).toMatchObject({
      supersededAt: expect.any(Date),
      respondedAt: null,
    });
    expect(
      (
        await prior.db
          .select()
          .from(assignments)
          .where(eq(assignments.id, workId))
      )[0].status,
    ).toBe("cancelled");
    await expect(close(legacyQuestionId)).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint: "hitl_requests_agent_question_supersession_check",
      },
    });
  } finally {
    await prior.stop();
  }
});
