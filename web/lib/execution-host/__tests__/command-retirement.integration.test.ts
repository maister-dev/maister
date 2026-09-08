// AT-10 — state-aware command/receipt retirement (D6). Age is never an input:
// every case here proves that a command is reclaimed only after the manager's
// derived eligibility AND the host's own receipt evidence agree, and that what
// survives is a tombstone rather than a replayable request.

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { getCommand, insertCommand } from "@/lib/execution-host/commands";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import {
  reportUnreconciledCommands,
  retireEligibleCommands,
} from "@/lib/execution-host/retirement";
import {
  seedLocalHost,
  seedProjectRow,
  seedRun,
  seedWorkspace,
} from "@/test-support/execution-host-seed";
import { addWorktree, initRepo } from "@/test-support/git-fixture";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: Db;
let sup: RealSupervisor;
let restoreUrl: () => void = () => {};
let hosts: ExecutionHosts;
let project: { id: string; slug: string; repoPath: string };
let hostId: string;

const DAY_MS = 24 * 60 * 60 * 1000;
const CREATE_PAYLOAD = {
  stepId: "s1",
  executor: { agent: "claude" as const, model: "mock" },
};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_retirement_test",
  });
  db = testDatabase.db as unknown as Db;
  sup = await startRealSupervisor();
  restoreUrl = useRealSupervisorUrl(sup.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  project = await seedProjectRow(testDatabase.db, {
    repoPath: await initRepo(`${sup.runtimeRoot}/repo`),
  });
  hosts = createExecutionHosts({ db });
  hostId = (await seedLocalHost(testDatabase.db)).id;
}, 240_000);

afterAll(async () => {
  restoreUrl();
  await sup?.stop();
  await testDatabase?.stop();
});

async function seedFlowRun(name: string, status = "Done") {
  const runId = await seedRun(testDatabase.db, {
    projectId: project.id,
    status,
  });
  const worktreePath = await addWorktree(
    project.repoPath,
    `${sup.runtimeRoot}/wt-${name}-${randomUUID().slice(0, 6)}`,
    `maister/${name}-${randomUUID().slice(0, 6)}`,
  );

  await seedWorkspace(testDatabase.db, {
    runId,
    projectId: project.id,
    worktreePath,
    parentRepoPath: project.repoPath,
  });

  return runId;
}

// The registrar owns the local host row; a run bound through the client uses
// THAT id, so every seeded row must use the same host.
let boundHostId: string | null = null;

async function mint(runId: string) {
  const host = boundHostId ?? hostId;

  return db.transaction((tx) =>
    mintAssignment(tx as unknown as Db, {
      runId,
      hostId: host,
      reason: "launch",
    }),
  );
}

async function bindRun(runId: string) {
  const client = await hosts.forRun(runId, { reason: "launch" });

  boundHostId = client.host.id;

  return client;
}

// A terminal command whose completion is older than the replay grace. Age is
// applied ONLY here so that every retention outcome below is attributable to
// state rather than to the clock.
async function seedTerminalCommand(opts: {
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
  kind?: "session.cancel" | "session.prompt";
  ageDays?: number;
  ownerKind?: string | null;
  applicationState?: string;
  terminalEventId?: string | null;
  state?: "succeeded" | "failed" | "fenced";
}) {
  // S2.12: a prompt row cannot be minted on the unowned path, so a prompt case
  // is written with its owner identity from the start; the ledger's shape
  // checks are real invariants and seeding around them would prove nothing.
  const commandId = randomUUID();
  const prompt = (opts.kind ?? "session.cancel") === "session.prompt";
  const row = prompt
    ? { id: commandId }
    : await insertCommand(db, {
        id: commandId,
        runId: opts.runId,
        assignmentId: opts.assignmentId,
        hostId: boundHostId ?? hostId,
        assignmentEpoch: opts.assignmentEpoch,
        kind: "session.cancel",
        payload: {},
        maxAttempts: 3,
      });

  if (prompt)
    await db.insert(schema.executionCommands).values({
      id: commandId,
      runId: opts.runId,
      executionAssignmentId: opts.assignmentId,
      executionHostId: boundHostId ?? hostId,
      assignmentEpoch: opts.assignmentEpoch,
      kind: "session.prompt",
      payload: {},
      maxAttempts: 3,
      ...(opts.ownerKind
        ? {
            ownerKind: opts.ownerKind,
            ownerRef: {
              version: 1,
              variant: "node",
              nodeAttemptId: randomUUID(),
              promptOrdinal: 0,
              runId: opts.runId,
              runSessionId: randomUUID(),
              incarnationId: randomUUID(),
              assignmentId: opts.assignmentId,
              assignmentEpoch: opts.assignmentEpoch,
            },
            logicalOperationKey: `flow_node_attempt:node:${commandId}:0`,
            requestSchema: "maister.command.request.v1",
            requestSha256: "b".repeat(64),
          }
        : {}),
    });

  // The owner identity above is already durable; the update below only moves
  // the row into the terminal/aged state each case is actually about.
  await db
    .update(schema.executionCommands)
    .set({
      state: opts.state ?? "succeeded",
      completedAt: new Date(Date.now() - (opts.ageDays ?? 30) * DAY_MS),
      ...(opts.applicationState
        ? {
            applicationState: opts.applicationState,
            ...(opts.applicationState === "applied"
              ? { completionAppliedAt: new Date() }
              : {}),
          }
        : {}),
      ...(opts.terminalEventId === undefined
        ? {}
        : { terminalEventId: opts.terminalEventId }),
    })
    .where(eq(schema.executionCommands.id, row.id));

  return row.id;
}

// One ingested terminal event plus the stream row that says how far the manager
// has proven its acknowledgement.
async function seedTerminalEvent(opts: {
  runId: string;
  hostSequence: number;
  ackedThrough: number | null;
}) {
  const streamId = randomUUID();

  await db.insert(schema.executionEventStreams).values({
    id: streamId,
    executionHostId: boundHostId ?? hostId,
    streamId: randomUUID(),
    state: "observed",
    lastReceivedSequence: BigInt(opts.hostSequence),
    lastContiguousSequence: BigInt(opts.hostSequence),
    lastAckConfirmedSequence:
      opts.ackedThrough === null ? null : BigInt(opts.ackedThrough),
  });

  const eventId = randomUUID();

  await db.insert(schema.executionEvents).values({
    id: eventId,
    source: "host",
    runId: opts.runId,
    executionHostId: boundHostId ?? hostId,
    eventStreamId: streamId,
    hostSequence: BigInt(opts.hostSequence),
    hostBootId: randomUUID(),
    envelopeVersion: 1,
    eventType: "session.command",
    payloadSchema: "maister.session.command.v2",
    payload: {},
    occurredAt: new Date(),
    ingestDisposition: "accepted",
  });

  return eventId;
}

async function readRow(id: string) {
  const rows = (await db
    .select()
    .from(schema.executionCommands)
    .where(eq(schema.executionCommands.id, id))) as unknown as Array<{
    retiredAt: Date | null;
    requestCanonicalJson: string | null;
    createIntent: unknown;
    receiptEvidence: unknown;
    requestSha256: string | null;
    state: string;
    kind: string;
    payload: Record<string, unknown>;
  }>;

  return rows[0] ?? null;
}

describe("AT-10 state-aware command retirement", () => {
  it("retires a real terminal command only after BOTH sides confirm, and leaves a tombstone on each", async () => {
    const runId = await seedFlowRun("both-sides");
    const client = await bindRun(runId);
    const session = await client.createSession(CREATE_PAYLOAD);
    const commandId = await deleteSessionCommandId(
      client,
      session.hostSessionId,
    );

    await db
      .update(schema.runs)
      .set({ status: "Done" })
      .where(eq(schema.runs.id, runId));
    await db
      .update(schema.executionCommands)
      .set({ completedAt: new Date(Date.now() - 30 * DAY_MS) })
      .where(eq(schema.executionCommands.id, commandId));

    const before = await hosts.local().getCommandReceipt(commandId);

    expect(before?.phase).not.toBe("accepted");

    const summary = await retireEligibleCommands({ db, hosts });

    expect(summary.retired).toBeGreaterThanOrEqual(1);

    const row = await readRow(commandId);

    expect(row?.retiredAt).toBeInstanceOf(Date);
    // Identity and disposition survive; the executable request does not.
    expect(row?.requestSha256 !== undefined).toBe(true);
    expect(row?.requestCanonicalJson).toBeNull();
    expect(row?.createIntent).toBeNull();
    expect(row?.receiptEvidence).toBeNull();
    expect(row?.payload).toEqual({});
    expect(row?.state).toBe("succeeded");

    // The host keeps the key so a stale replay is still recognisable.
    const after = await hosts.local().getCommandReceipt(commandId);

    expect(after).not.toBeNull();
    expect(after?.body).toEqual({ retired: true });
  }, 180_000);

  it("repeats the eligibility operation idempotently after a lost acknowledgement", async () => {
    const runId = await seedFlowRun("ack-loss");
    const client = await bindRun(runId);
    const session = await client.createSession(CREATE_PAYLOAD);
    const commandId = await deleteSessionCommandId(
      client,
      session.hostSessionId,
    );
    const command = await getCommand(db, commandId);

    const first = await hosts.local().retireCommand(commandId, {
      expectedRequestSha256: command!.requestSha256,
      expectedPhase: "completed",
      assignmentEpoch: command!.assignmentEpoch,
    });

    expect(first.compacted).toBe(true);

    const second = await hosts.local().retireCommand(commandId, {
      expectedRequestSha256: command!.requestSha256,
      expectedPhase: "completed",
      assignmentEpoch: command!.assignmentEpoch,
    });

    expect(second.compacted).toBe(false);
    expect(second.retiredAt).toBe(first.retiredAt);
    expect(second.phase).toBe(first.phase);
  }, 120_000);

  it("refuses the host half when the retirement proof does not match its receipt", async () => {
    const runId = await seedFlowRun("identity");
    const client = await bindRun(runId);
    const session = await client.createSession(CREATE_PAYLOAD);
    const commandId = await deleteSessionCommandId(
      client,
      session.hostSessionId,
    );
    const command = await getCommand(db, commandId);

    await expect(
      hosts.local().retireCommand(commandId, {
        expectedRequestSha256: command!.requestSha256,
        expectedPhase: "completed",
        assignmentEpoch: command!.assignmentEpoch + 7,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) && err.details?.reason === "identity_mismatch",
    );

    const receipt = await hosts.local().getCommandReceipt(commandId);

    expect(receipt?.body).not.toEqual({ retired: true });
  }, 120_000);

  it("reports a typed reconciliation condition when the host retains no receipt", async () => {
    const runId = await seedFlowRun("no-receipt");
    const assignment = await mint(runId);
    const commandId = await seedTerminalCommand({
      runId,
      assignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
    });
    const summary = await retireEligibleCommands({ db, hosts });

    expect(summary.reasons.host_evidence_missing).toBeGreaterThanOrEqual(1);
    expect(await readRow(commandId)).not.toBeNull();
    expect((await readRow(commandId))?.retiredAt).toBeNull();
  }, 120_000);

  it("retains an owned prompt whose owner has not applied, however old it is", async () => {
    const runId = await seedFlowRun("unapplied");

    await bindRun(runId);
    const assignment = await mint(runId);
    const commandId = await seedTerminalCommand({
      runId,
      assignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      kind: "session.prompt",
      ownerKind: "flow_node_attempt",
      applicationState: "pending",
      ageDays: 400,
    });
    const summary = await retireEligibleCommands({ db, hosts });

    expect(summary.reasons.owner_unapplied).toBeGreaterThanOrEqual(1);
    expect((await readRow(commandId))?.retiredAt).toBeNull();
  }, 120_000);

  it("retains an applied prompt whose terminal event is not acknowledged yet", async () => {
    const runId = await seedFlowRun("unacked");

    await bindRun(runId);
    const assignment = await mint(runId);
    const eventId = await seedTerminalEvent({
      runId,
      hostSequence: 40,
      ackedThrough: 12,
    });
    const commandId = await seedTerminalCommand({
      runId,
      assignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      kind: "session.prompt",
      ownerKind: "flow_node_attempt",
      applicationState: "applied",
      terminalEventId: eventId,
    });
    const summary = await retireEligibleCommands({ db, hosts });

    expect(summary.reasons.terminal_event_unacked).toBeGreaterThanOrEqual(1);
    expect((await readRow(commandId))?.retiredAt).toBeNull();

    // Advancing ONLY the ack frontier moves the same row past the ack rule and
    // on to the next obligation — proof that the ack rule is what refused it
    // rather than something else about the row.
    const [event] = await db
      .select({ streamId: schema.executionEvents.eventStreamId })
      .from(schema.executionEvents)
      .where(eq(schema.executionEvents.id, eventId));

    await db
      .update(schema.executionEventStreams)
      .set({ lastAckConfirmedSequence: BigInt(40) })
      .where(eq(schema.executionEventStreams.id, event.streamId));

    const next = await retireEligibleCommands({ db, hosts });

    expect(next.reasons.terminal_event_unacked ?? 0).toBe(0);
    expect(next.reasons.host_evidence_missing).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("retains every command of a run that is still live", async () => {
    const runId = await seedFlowRun("live", "Running");

    await bindRun(runId);
    const assignment = await mint(runId);
    const commandId = await seedTerminalCommand({
      runId,
      assignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      ageDays: 400,
    });
    const summary = await retireEligibleCommands({ db, hosts });

    expect(summary.reasons.run_retained).toBeGreaterThanOrEqual(1);
    expect((await readRow(commandId))?.retiredAt).toBeNull();
  }, 120_000);

  it("refuses to hard-delete a run while it retains protected command evidence", async () => {
    const runId = await seedFlowRun("cascade");

    await bindRun(runId);
    const assignment = await mint(runId);
    const commandId = await seedTerminalCommand({
      runId,
      assignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      kind: "session.prompt",
      ownerKind: "flow_node_attempt",
      applicationState: "pending",
    });

    await expect(
      testDatabase.pool.query("delete from runs where id = $1", [runId]),
    ).rejects.toThrow(/protected execution command evidence/);
    expect(await readRow(commandId)).not.toBeNull();

    // Retirement is the only way through: once the row is a tombstone the
    // parent deletion proceeds on the ordinary path.
    await testDatabase.pool.query(
      "update execution_commands set retired_at = now() where id = $1",
      [commandId],
    );
    await expect(
      testDatabase.pool.query("delete from runs where id = $1", [runId]),
    ).resolves.toBeTruthy();
  }, 120_000);

  it("advances the scan past protected rows so later eligible rows are still reached", async () => {
    const liveRun = await seedFlowRun("fair-protected", "Running");
    const doneRun = await seedFlowRun("fair-eligible");
    const client = await bindRun(doneRun);
    const protectedAssignment = await mint(liveRun);

    await seedTerminalCommand({
      runId: liveRun,
      assignmentId: protectedAssignment.id,
      assignmentEpoch: protectedAssignment.epoch,
      ageDays: 400,
    });

    const session = await client.createSession(CREATE_PAYLOAD);
    const eligible = await deleteSessionCommandId(
      client,
      session.hostSessionId,
    );

    await db
      .update(schema.executionCommands)
      .set({ completedAt: new Date(Date.now() - 100 * DAY_MS) })
      .where(eq(schema.executionCommands.id, eligible));

    const summary = await retireEligibleCommands({ db, hosts, limit: 500 });

    expect(summary.reasons.run_retained).toBeGreaterThanOrEqual(1);
    expect((await readRow(eligible))?.retiredAt).toBeInstanceOf(Date);
    expect(summary.cursor).not.toBeNull();
  }, 180_000);

  it("keeps naming unreconciled terminal prompts instead of waiting silently", async () => {
    const runId = await seedFlowRun("unreconciled");

    await bindRun(runId);
    const assignment = await mint(runId);

    await seedTerminalCommand({
      runId,
      assignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      kind: "session.prompt",
      ownerKind: "flow_node_attempt",
      applicationState: "applied",
      terminalEventId: null,
      ageDays: 90,
    });

    expect(await reportUnreconciledCommands({ db })).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

// The delete of a freshly created session is a real host round-trip that leaves
// a terminal receipt on BOTH sides without needing a scripted agent turn.
async function deleteSessionCommandId(
  client: Awaited<ReturnType<ExecutionHosts["forRun"]>>,
  hostSessionId: string,
): Promise<string> {
  await client.deleteSession(hostSessionId);
  const rows = (await db
    .select()
    .from(schema.executionCommands)
    .where(
      eq(schema.executionCommands.targetSessionId, hostSessionId),
    )) as unknown as Array<{ id: string; kind: string; state: string }>;
  const row = rows.find((r) => r.kind === "session.delete");

  if (!row) throw new Error("no session.delete command was recorded");

  return row.id;
}
