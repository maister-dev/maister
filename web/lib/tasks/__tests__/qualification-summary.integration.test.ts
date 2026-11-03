import type { OperationalTerminal } from "@/lib/run-results/operational-types";
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { runs, tasks, runSessions, executionCommands } from "@/lib/db/schema";
import { getTaskQualificationSummaries } from "@/lib/tasks/qualification-queries";
import {
  loadTaskQualificationInput,
  prepareTaskQualification,
  requireTaskRequalification,
} from "@/lib/tasks/qualification";
import { admitAgentGenerationTurn } from "@/lib/agents/generation-turn";
import { qualificationFixture } from "@/test-support/task-qualification";
import { operationalContractFixture } from "@/test-support/operational-agent";
import {
  seedTaskLaunchFixture,
  type TaskLaunchFixture,
} from "@/test-support/task-launch-admission";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let fixture: TaskLaunchFixture;
let root: string;
let sequence = 0;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "qualification_summary",
  });
  root = await mkdtempReal("qualification-summary-");
  fixture = await seedTaskLaunchFixture(database, root);
}, 180_000);

afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function task(): Promise<string> {
  const id = randomUUID();

  await database.db.insert(tasks).values({
    id,
    projectId: fixture.projectId,
    number: ++sequence,
    title: "Assess request",
    prompt: "Inspect this task",
  });

  return id;
}

function terminal(runId: string): OperationalTerminal {
  const nativeCause = {
    name: "Error",
    code: "ENOENT",
    syscall: "lstat",
    message: "secret-sentinel /private/source/path",
  };

  return {
    version: 1,
    status: "Failed",
    cause: "operational_execution_failed",
    effectiveOutcome: "failed",
    successful: false,
    validation: "unchecked",
    integrity: "indeterminate",
    baselineGeneration: null,
    resultRevision: null,
    reasonCodes: ["operational_integrity_probe_failed"],
    evidenceIds: [],
    infrastructureFailure: {
      runId,
      stage: "baseline",
      causeChain: [nativeCause],
    },
  };
}

async function source(
  taskId: string,
  status: "Running" | "Failed" = "Failed",
  storedDigest?: string,
): Promise<string> {
  const id = randomUUID();
  const input = await loadTaskQualificationInput(
    database.db,
    fixture.projectId,
    taskId,
  );

  await database.db.insert(runs).values({
    id,
    projectId: fixture.projectId,
    taskId,
    runKind: "agent",
    status,
    startedAt: new Date(Date.now() + ++sequence),
    launchedAt: new Date(Date.now() + sequence),
    flowVersion: "agent",
    agentKind: "operational",
    agentWorkspace: "repo_read",
    resultContract: operationalContractFixture("repo_read"),
    taskQualificationSnapshot: {
      version: 1,
      role: "qualifier",
      taskId,
      target: "main",
      sha: "a".repeat(40),
      inputRevision: input.inputRevision,
      inputDigest: storedDigest ?? input.inputDigest,
    },
    operationalTerminal: status === "Failed" ? terminal(id) : null,
  });

  return id;
}

async function summary(taskId: string) {
  return (await getTaskQualificationSummaries(database.db, [taskId])).get(
    taskId,
  );
}

it("projects a zero-command qualifier infrastructure failure without a candidate or unsafe cause contents", async () => {
  const taskId = await task();
  const runId = await source(taskId);
  const value = await summary(taskId);

  expect(value).toMatchObject({
    decision: null,
    freshness: "unassessed",
    candidate: null,
    sourceFailure: {
      runId,
      stage: "baseline",
      causeCode: "ENOENT",
      modelStarted: false,
    },
  });
  expect(JSON.stringify(value)).not.toContain("secret-sentinel");
  expect(JSON.stringify(value)).not.toContain("/private/source/path");
  expect(
    await database.db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.runId, runId)),
  ).toEqual([]);
});

it("latest Running qualifier suppresses an older before-model failure", async () => {
  const taskId = await task();

  await source(taskId);
  await source(taskId, "Running");
  expect(await summary(taskId)).not.toHaveProperty("sourceFailure");
});

it("a semantic task edit suppresses an older failed qualifier instead of relabeling the new input", async () => {
  const taskId = await task();
  const db: Db = database.db;

  await source(taskId);
  await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({ prompt: "The request has changed" })
      .where(eq(tasks.id, taskId));
    await requireTaskRequalification(tx, fixture.projectId, taskId);
  });
  expect(await summary(taskId)).not.toHaveProperty("sourceFailure");
});

it("a legacy qualifier with no frozen input binding remains historical rather than current failure", async () => {
  const taskId = await task();
  const runId = randomUUID();

  await database.db.insert(runs).values({
    id: runId,
    projectId: fixture.projectId,
    taskId,
    runKind: "agent",
    status: "Failed",
    startedAt: new Date(),
    flowVersion: "agent",
    agentKind: "operational",
    agentWorkspace: "repo_read",
    resultContract: operationalContractFixture("repo_read"),
    taskQualificationSnapshot: {
      version: 1,
      role: "qualifier",
      taskId,
      target: "main",
      sha: "a".repeat(40),
    },
    operationalTerminal: terminal(runId),
  });
  expect(await summary(taskId)).not.toHaveProperty("sourceFailure");
});

it("matching input revision alone cannot authorize a failed-source claim with a different digest", async () => {
  const taskId = await task();

  await source(taskId, "Failed", "b".repeat(64));
  expect(await summary(taskId)).not.toHaveProperty("sourceFailure");
});

it("a newer unrelated operational Run does not hide this task's current failed qualifier", async () => {
  const taskId = await task();
  const runId = await source(taskId);

  await database.db.insert(runs).values({
    id: randomUUID(),
    projectId: fixture.projectId,
    taskId,
    runKind: "agent",
    status: "Running",
    startedAt: new Date(Date.now() + 1000),
    launchedAt: new Date(Date.now() + 1000),
    flowVersion: "agent",
    agentKind: "operational",
    agentWorkspace: "none",
    resultContract: operationalContractFixture("none"),
  });
  expect(await summary(taskId)).toHaveProperty("sourceFailure.runId", runId);
});

it.each(["ready", "needs_review"] as const)(
  "a current accepted %s assessment is never relabeled by a later failed attempt",
  async (decision) => {
    const taskId = await task();
    const qualification = qualificationFixture();
    const prepared = await prepareTaskQualification(database.db, {
      projectId: fixture.projectId,
      taskId,
      author: {
        kind: "user",
        identity: fixture.userId,
        userId: fixture.userId,
      },
      request: {
        requestKey: randomUUID(),
        expectedInputRevision: 1,
        expectedQualificationRevision: null,
        qualification:
          decision === "ready"
            ? qualification
            : {
                ...qualification,
                decision,
                checks: qualification.checks.map((check) =>
                  check.dimension === "acceptance"
                    ? {
                        ...check,
                        state: "unknown",
                        rationale: "Needs a decision",
                      }
                    : check,
                ),
                reasonCodes: ["acceptance_incomplete"],
                nextActions: ["Clarify acceptance"],
              },
        enqueue: false,
      },
    });

    await database.db.transaction(prepared.apply);
    await source(taskId);
    expect(await summary(taskId)).toMatchObject({
      decision,
      freshness: "current",
    });
    expect(await summary(taskId)).not.toHaveProperty("sourceFailure");
  },
);

it("a real host-rejected create remains visible without claiming a before-model preparation failure", async () => {
  const taskId = await task();
  const runId = await source(taskId, "Running");
  const { hosts } = await fakeExecutionHosts(database.db);
  const client = await hosts.forRun(runId);
  const db: Db = database.db;

  await database.db
    .insert(runSessions)
    .values({ id: randomUUID(), runId, sessionName: "default" });
  const turn = await db.transaction((tx) =>
    admitAgentGenerationTurn(tx, {
      runId,
      assignmentId: client.assignment.id,
      variant: "initial",
      prompt: "Assess the task",
    }),
  );

  await client.ensureWorkspace();
  await expect(
    client.createOwnedSession(
      { variant: "agent", turnId: turn.id, promptOrdinal: turn.ordinal },
      async () => ({
        stepId: "host-refuses/invalid-segment",
        executor: { agent: "claude", model: "mock" },
      }),
    ),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await database.db
    .update(runs)
    .set({ status: "Failed", operationalTerminal: terminal(runId) })
    .where(eq(runs.id, runId));
  expect(await summary(taskId)).toMatchObject({
    decision: null,
    freshness: "unassessed",
    candidate: null,
    sourceFailure: {
      runId,
      stage: null,
      causeCode: null,
      modelStarted: null,
    },
  });
});

it("a real admitted create and bound host session report failed triage without a before-model claim", async () => {
  const taskId = await task();
  const runId = await source(taskId, "Running");
  const { hosts } = await fakeExecutionHosts(database.db);
  const client = await hosts.forRun(runId);
  const db: Db = database.db;

  await database.db
    .insert(runSessions)
    .values({ id: randomUUID(), runId, sessionName: "default" });
  const turn = await db.transaction((tx) =>
    admitAgentGenerationTurn(tx, {
      runId,
      assignmentId: client.assignment.id,
      variant: "initial",
      prompt: "Assess the task",
    }),
  );

  await client.ensureWorkspace();
  await client.createOwnedSession(
    { variant: "agent", turnId: turn.id, promptOrdinal: turn.ordinal },
    async () => ({
      stepId: "agent",
      executor: { agent: "claude", model: "mock" },
      agentKind: "operational",
      readOnlySession: true,
    }),
  );
  await database.db
    .update(runs)
    .set({ status: "Failed", operationalTerminal: terminal(runId) })
    .where(eq(runs.id, runId));
  expect(
    (
      await database.db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.runId, runId))
    ).some((command) => command.kind === "session.create"),
  ).toBe(true);
  expect(await summary(taskId)).toHaveProperty("sourceFailure", {
    runId,
    stage: null,
    causeCode: null,
    modelStarted: null,
  });
});
