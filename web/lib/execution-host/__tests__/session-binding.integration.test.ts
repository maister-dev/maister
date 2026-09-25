import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  executionCommands,
  runs,
  runSessions,
  runSessionIncarnations,
} from "@/lib/db/schema";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { applyCreateAck } from "@/lib/execution-host/create-ack";
import { seedLocalHost } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: Db;
let hostId: string;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "session_binding_supersede",
  });
  db = database.db as unknown as Db;
  hostId = (await seedLocalHost(database.db)).id;
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

async function ack(
  runId: string,
  assignmentId: string,
  hostSessionId: string,
): Promise<void> {
  await expect(
    db.transaction((tx) =>
      applyCreateAck(tx as unknown as Db, {
        runId,
        sessionName: "default",
        assignmentId,
        nodeAttemptId: null,
        result: { sessionId: hostSessionId, acpSessionId: null },
      }),
    ),
  ).resolves.toBe("applied");
}

async function incarnation(hostSessionId: string) {
  const [row] = await db
    .select()
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.hostSessionId, hostSessionId));

  return row;
}

describe("retireSupersededSessionIncarnations", () => {
  it("names a lower-epoch retirement assignment_superseded and a same-epoch one session_superseded", async () => {
    const runId = randomUUID();

    await db.insert(runs).values({
      id: runId,
      runKind: "agent",
      flowVersion: "agent",
      flowRevision: "manual",
      status: "Running",
      persistent: true,
    });
    const mint = (reason: "launch" | "resume") =>
      db.transaction((tx) =>
        mintAssignment(tx as unknown as Db, { runId, hostId, reason }),
      );
    const first = await mint("launch");
    const launched = `host-${randomUUID()}`;

    await ack(runId, first.id, launched);

    // A resume mints epoch 2; its create ACK retires the epoch-1 incarnation.
    const second = await mint("resume");
    const resumed = `host-${randomUUID()}`;

    expect(second.epoch).toBeGreaterThan(first.epoch);
    await ack(runId, second.id, resumed);
    expect(await incarnation(launched)).toMatchObject({
      state: "lost",
      assignmentEpoch: first.epoch,
      terminalReason: { reason: "assignment_superseded" },
    });

    // A consecutive session on the SAME epoch is the other CASE arm.
    const next = `host-${randomUUID()}`;

    await ack(runId, second.id, next);
    expect(await incarnation(resumed)).toMatchObject({
      state: "lost",
      assignmentEpoch: second.epoch,
      terminalReason: { reason: "session_superseded" },
    });
    expect(await incarnation(next)).toMatchObject({
      state: "created",
      terminalReason: null,
    });
  }, 60_000);
});

describe("an unowned create's late acknowledgement (review finding)", () => {
  /** An unowned `session.create`, as a consensus substep or the resume
   * fallback issues it: no create intent, so no generation to order by. */
  async function unownedCreate(
    runId: string,
    assignment: { id: string; epoch: number },
    createdAt: Date,
  ): Promise<string> {
    const id = randomUUID();

    await db.insert(executionCommands).values({
      id,
      runId,
      executionAssignmentId: assignment.id,
      executionHostId: hostId,
      assignmentEpoch: assignment.epoch,
      kind: "session.create",
      payload: {
        sessionName: "default",
        stepId: "s1",
        executor: { agent: "claude", model: "mock" },
      },
      maxAttempts: 3,
      logicalOperationKey: `session.create:${id}`,
      requestSchema: "maister.command.request.v1",
      requestSha256: "e".repeat(64),
      state: "accepted",
      acceptedAt: createdAt,
      createdAt,
    });

    return id;
  }

  function ackCommand(
    runId: string,
    assignmentId: string,
    commandId: string,
    hostSessionId: string,
  ) {
    return db.transaction((tx) =>
      applyCreateAck(tx as unknown as Db, {
        commandId,
        runId,
        sessionName: "default",
        assignmentId,
        nodeAttemptId: null,
        result: { sessionId: hostSessionId, acpSessionId: null },
      }),
    );
  }

  it("is stale once a newer unowned create of the same session bound: the live successor stays bound", async () => {
    const runId = randomUUID();

    await db.insert(runs).values({
      id: runId,
      runKind: "agent",
      flowVersion: "agent",
      flowRevision: "manual",
      status: "Running",
      persistent: true,
    });
    const assignment = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
    );
    const older = await unownedCreate(
      runId,
      assignment,
      new Date(Date.now() - 60_000),
    );
    const newer = await unownedCreate(runId, assignment, new Date());
    const orphan = `host-${randomUUID()}`;
    const live = `host-${randomUUID()}`;

    expect(await ackCommand(runId, assignment.id, newer, live)).toBe("applied");
    // The older create's host session answered late (a W2 receipt fold or a
    // lagging projector). Applying it would retire `live` as superseded.
    expect(await ackCommand(runId, assignment.id, older, orphan)).toBe("stale");
    expect(await incarnation(live)).toMatchObject({
      state: "created",
      terminalReason: null,
    });
    expect(await incarnation(orphan)).toBeUndefined();
    const [session] = await db
      .select({ hostSessionId: runSessions.hostSessionId })
      .from(runSessions)
      .where(eq(runSessions.runId, runId));

    expect(session?.hostSessionId).toBe(live);
  }, 60_000);
});

// ADR-182 D-A3 (T2.2): the capability is a per-incarnation fact written by the
// single create-ACK writer. The live ACK, the receipt fold and the lifecycle
// projector all pass through `applyCreateAck`; a later write fills an
// unobserved NULL and never rewrites a recorded value.
describe("steering capability at the create ACK", () => {
  async function steeringAck(
    runId: string,
    assignmentId: string,
    hostSessionId: string,
    steeringSupported: boolean | null | undefined,
  ): Promise<void> {
    await db.transaction((tx) =>
      applyCreateAck(tx as unknown as Db, {
        runId,
        sessionName: "default",
        assignmentId,
        nodeAttemptId: null,
        result: {
          sessionId: hostSessionId,
          acpSessionId: null,
          ...(steeringSupported === undefined ? {} : { steeringSupported }),
        },
      }),
    );
  }

  async function launchedRun(): Promise<{
    runId: string;
    assignmentId: string;
  }> {
    const runId = randomUUID();

    await db.insert(runs).values({
      id: runId,
      runKind: "agent",
      flowVersion: "agent",
      flowRevision: "manual",
      status: "Running",
      persistent: true,
    });
    const assignment = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
    );

    return { runId, assignmentId: assignment.id };
  }

  it("records false as a fact and unknown as NULL", async () => {
    const { runId, assignmentId } = await launchedRun();
    const unsupported = `host-${randomUUID()}`;

    await steeringAck(runId, assignmentId, unsupported, false);
    expect((await incarnation(unsupported)).steeringSupported).toBe(false);

    const unknown = `host-${randomUUID()}`;

    await steeringAck(runId, assignmentId, unknown, undefined);
    expect((await incarnation(unknown)).steeringSupported).toBeNull();
  }, 60_000);

  it("fills an unobserved capability and never overwrites a recorded one", async () => {
    const { runId, assignmentId } = await launchedRun();
    const hostSessionId = `host-${randomUUID()}`;

    // An older host's ACK carried no capability; the event from a current
    // host fills it.
    await steeringAck(runId, assignmentId, hostSessionId, null);
    expect((await incarnation(hostSessionId)).steeringSupported).toBeNull();
    await steeringAck(runId, assignmentId, hostSessionId, true);
    expect((await incarnation(hostSessionId)).steeringSupported).toBe(true);

    // A replayed or lagging write never rewrites it.
    await steeringAck(runId, assignmentId, hostSessionId, false);
    expect((await incarnation(hostSessionId)).steeringSupported).toBe(true);
  }, 60_000);
});
