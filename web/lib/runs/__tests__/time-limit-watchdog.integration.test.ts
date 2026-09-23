// M11c Phase 3B — time-limit kill-on-cap watchdog (limits.maxDurationMinutes).
// Agent-agnostic, inherently enforced (NOT subject to the strict/instruct
// table). The watchdog reuses the keep-alive / scheduler sweep: for a `Running`
// node whose effective `limits.maxDurationMinutes` is exceeded (elapsed from the
// active node_attempts.started_at, full-µs), it terminates via supervisor
// `DELETE /sessions/:id`, marks the node `Failed`, and ends the run terminal.
//
// Seam (confirmed by reading lib/runs/keepalive-sweeper.ts): the public entry
// is `runSweepTick({ db, executionHosts: hosts })`. The watchdog folds in as a new pass. Tests drive
// the public `runSweepTick`; if the implementor instead exposes a dedicated
// `runTimeLimitPass`, swap the import — the seeding + assertions are the
// contract either way. See "Seam decisions" in the tester report.

import type { ExecutionHosts } from "@/lib/execution-host";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
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

// Supervisor seam: the watchdog must call deleteSession to tear the agent down
// (the DELETE drives teardown so no permission deferred leaks). listSessions is
// how the run is matched to a live supervisor session (mirrors pass 1).
const deleteSessionSpy = vi.fn(async (_id: string) => undefined);
const listSessionsSpy = vi.fn(async () => [] as unknown[]);
const checkpointSessionSpy = vi.fn(async (_id: string) => ({}) as unknown);

// ADR-166: the sweeper addresses the host through clients bound to each run's
// execution assignment. The fake host below routes the three session calls the
// watchdog makes to the existing spies, so every case keeps its wire-level
// assertions while the real ledger/binding path runs underneath.
function spyBackedTransport(fake: FakeExecutionHost): void {
  Object.assign(fake.transport, {
    getCommandReceipt: (commandId: string) => receiptSpy(commandId),
    listSessions: () => listSessionsSpy(),
    deleteSession: async (sessionId: string) => {
      await deleteSessionSpy(sessionId);

      return { outcome: "terminated" as const };
    },
    checkpointSession: async (sessionId: string) => {
      const result = await checkpointSessionSpy(sessionId);

      return (
        result ?? { alreadyCheckpointed: false, sessionId, monotonicId: 1 }
      );
    },
  });
}

// A watchdog kill frees a scheduler slot and promotes the next Pending run via
// a lazy import of runFlow; mock it to a spy so the dispatch is observable and
// no real flow execution runs in the test.
const runFlowSpy = vi.fn(async (_runId: string) => undefined);
// ADR-167 D5 amendment (D-C1): the watchdog probes the newest owned prompt's
// receipt before a kill; each case scripts what the host answers.
const receiptSpy = vi.fn(async (_commandId: string) => null as unknown);

vi.mock("@/lib/flows/runner", () => ({
  runFlow: (id: string) => runFlowSpy(id),
}));

let runSweepTick: (opts?: {
  db?: unknown;
  executionHosts?: ExecutionHosts;
}) => Promise<unknown>;
let hosts: ExecutionHosts;
let hostId: string;
let fake: FakeExecutionHost;

import * as schemaModule from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { MaisterError } from "@/lib/errors";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
  type FakeExecutionHost,
} from "@/test-support/fake-execution-host";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let projectId: string;
let executorId: string;

// A graph manifest with an ai_coding node carrying the given limits (duration
// cap, cost cap, both, or none).
function manifestWithLimits(limits?: {
  maxDurationMinutes?: number;
  maxCostUsd?: number;
}): unknown {
  const inner: Record<string, number> = {};

  if (limits?.maxDurationMinutes !== undefined) {
    inner.maxDurationMinutes = limits.maxDurationMinutes;
  }
  if (limits?.maxCostUsd !== undefined) {
    inner.maxCostUsd = limits.maxCostUsd;
  }

  const settings = Object.keys(inner).length === 0 ? {} : { limits: inner };

  return {
    schemaVersion: 1,
    name: "g",
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "/aif-implement" },
        transitions: { success: "done" },
        settings,
      },
    ],
  };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "watchdog_test",
  });

  db = testDatabase.db;

  projectId = randomUUID();
  executorId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "wd-app",
    name: "Watchdog App",
    repoPath: "/repos/wd-app",
    maisterYamlPath: "/repos/wd-app/maister.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  fake = createFakeExecutionHost();

  spyBackedTransport(fake);
  ({ hosts, hostId } = await fakeExecutionHosts(db, { fake }));

  ({ runSweepTick } = await import("../keepalive-sweeper"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.delete(schema.executionCommands);
  await db.delete(schema.nodeAttempts);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
  await db.delete(schema.flows);
  deleteSessionSpy.mockClear();
  deleteSessionSpy.mockReset();
  deleteSessionSpy.mockResolvedValue(undefined);
  listSessionsSpy.mockReset();
  listSessionsSpy.mockResolvedValue([]);
  checkpointSessionSpy.mockReset();
  runFlowSpy.mockClear();
  receiptSpy.mockReset();
  receiptSpy.mockResolvedValue(null);
});

// Seed a Running run with one active node_attempts row. `attemptStartedAt`
// controls the watchdog's elapsed calculation. `acpSessionId` ties the run to a
// live supervisor session record.
async function seedRunningNode(opts: {
  maxDurationMinutes?: number;
  maxCostUsd?: number;
  attemptStartedAt: Date;
  acpSessionId: string | null;
  manifest?: unknown;
}): Promise<{ runId: string; supervisorSessionId: string }> {
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const supervisorSessionId = `sup-${runId.slice(0, 8)}`;
  const legacyManifest =
    typeof opts.manifest === "object" &&
    opts.manifest !== null &&
    "steps" in opts.manifest;
  const manifest = legacyManifest
    ? manifestWithLimits({})
    : (opts.manifest ??
      manifestWithLimits({
        maxDurationMinutes: opts.maxDurationMinutes,
        maxCostUsd: opts.maxCostUsd,
      }));

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: `g-${flowId.slice(0, 8)}`,
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest,
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "InFlight",
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: "Running",
    currentStepId: "implement",
    acpSessionId: opts.acpSessionId,
    startedAt: opts.attemptStartedAt,
  });
  await db.insert(schema.nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Running",
    startedAt: opts.attemptStartedAt,
  });

  if (legacyManifest) {
    await db
      .update(schema.flows)
      .set({ manifest: opts.manifest })
      .where(eq(schema.flows.id, flowId));
  }

  return { runId, supervisorSessionId };
}

// The watchdog matches a live session by runId, not by acp_session_id (which the
// runner persists only after the prompt returns) and not by stepId (a per-prompt
// label that does not equal the run's node cursor for gates or substeps).
function liveSessionRecord(
  runId: string,
  supervisorSessionId: string,
  acpSessionId?: string,
  stepId = "implement",
) {
  return {
    sessionId: supervisorSessionId,
    runId,
    projectSlug: "wd-app",
    stepId,
    status: "live" as const,
    pid: 1,
    startedAt: "",
    monotonicId: 0,
    acpSessionId,
  };
}

// A queued Pending run (no worktree/attempt needed) used to assert the watchdog
// promotes queued work after a kill frees a scheduler slot.
async function seedPendingRun(startedAt: Date): Promise<string> {
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g-pending",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g-pending",
    manifest: manifestWithLimits({}),
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "InFlight",
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: "Pending",
    startedAt,
  });

  return runId;
}

async function getRun(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return rows[0];
}

async function getAttempt(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId));

  return rows[0];
}

describe("time-limit watchdog — kill-on-cap (3B.1 / 3B.2)", () => {
  it("skips a legacy anomaly without aborting another capped candidate", async () => {
    const legacy = await seedRunningNode({
      attemptStartedAt: new Date(Date.now() - 30 * 60_000),
      acpSessionId: null,
      manifest: { schemaVersion: 1, name: "Legacy", steps: [] },
    });
    const capped = await seedRunningNode({
      maxDurationMinutes: 10,
      attemptStartedAt: new Date(Date.now() - 30 * 60_000),
      acpSessionId: null,
    });

    await runSweepTick({ db, executionHosts: hosts });

    expect((await getRun(legacy.runId)).status).toBe("Running");
    expect((await getRun(capped.runId)).status).toBe("Failed");
  }, 60_000);

  it("kills a run past maxDurationMinutes: deleteSession called, node Failed, run terminal Failed", async () => {
    const acp = "acp-over";
    const { runId, supervisorSessionId } = await seedRunningNode({
      maxDurationMinutes: 10,
      // 30 minutes ago → well past the 10-minute cap.
      attemptStartedAt: new Date(Date.now() - 30 * 60_000),
      acpSessionId: acp,
    });

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, supervisorSessionId, acp),
    ]);

    await runSweepTick({ db, executionHosts: hosts });

    // Supervisor session torn down (DELETE drives teardown → no leaked
    // permission deferred).
    expect(deleteSessionSpy).toHaveBeenCalledTimes(1);

    const run = await getRun(runId);

    expect(run.status).toBe("Failed");

    const attempt = await getAttempt(runId);

    expect(attempt.status).toBe("Failed");
    expect(attempt.errorCode).not.toBeNull();
    // ADR-166 D7: the terminal flip ends the run's driver generation in the
    // same tx (the lazily placed legacy generation, here).
    const assignments = await db
      .select({
        state: schema.executionAssignments.state,
        releasedReason: schema.executionAssignments.releasedReason,
      })
      .from(schema.executionAssignments)
      .where(eq(schema.executionAssignments.runId, runId));

    expect(assignments).toEqual([
      { state: "released", releasedReason: "failed" },
    ]);
  }, 60_000);

  it("does NOT kill a run under the cap", async () => {
    const acp = "acp-under";
    const { runId, supervisorSessionId } = await seedRunningNode({
      maxDurationMinutes: 60,
      // 1 minute ago → far under the 60-minute cap.
      attemptStartedAt: new Date(Date.now() - 60_000),
      acpSessionId: acp,
    });

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, supervisorSessionId, acp),
    ]);

    await runSweepTick({ db, executionHosts: hosts });

    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect((await getRun(runId)).status).toBe("Running");
    expect((await getAttempt(runId)).status).toBe("Running");
  }, 60_000);

  it("never arms the watchdog for a node with no limits (no false kill)", async () => {
    const acp = "acp-nolimits";
    const { runId, supervisorSessionId } = await seedRunningNode({
      maxDurationMinutes: undefined,
      // Ancient start — but with no limits the watchdog must never fire.
      attemptStartedAt: new Date(Date.now() - 24 * 3600_000),
      acpSessionId: acp,
    });

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, supervisorSessionId, acp),
    ]);

    await runSweepTick({ db, executionHosts: hosts });

    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect((await getRun(runId)).status).toBe("Running");
  }, 60_000);

  it("never kills on a cost cap alone — maxCostUsd is record-only", async () => {
    const acp = "acp-cost";
    const { runId, supervisorSessionId } = await seedRunningNode({
      // Cost cap only, NO duration cap; ancient start so a duration cap WOULD
      // have fired — proving cost never arms the watchdog.
      maxCostUsd: 0.01,
      attemptStartedAt: new Date(Date.now() - 24 * 3600_000),
      acpSessionId: acp,
    });

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, supervisorSessionId, acp),
    ]);

    await runSweepTick({ db, executionHosts: hosts });

    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect((await getRun(runId)).status).toBe("Running");
    expect((await getAttempt(runId)).status).toBe("Running");
  }, 60_000);

  it("kills a capped node with no acp_session_id (deleteSession skipped, run still Failed)", async () => {
    // A node that exceeded its duration cap but never reported an
    // acp_session_id MUST still be terminated; deleteSession is best-effort and
    // is skipped when no live session matches (regression guard for the
    // acp_session_id candidate filter).
    const { runId } = await seedRunningNode({
      maxDurationMinutes: 10,
      attemptStartedAt: new Date(Date.now() - 30 * 60_000),
      acpSessionId: null,
    });

    listSessionsSpy.mockResolvedValue([]);

    await runSweepTick({ db, executionHosts: hosts });

    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect((await getRun(runId)).status).toBe("Failed");

    const attempt = await getAttempt(runId);

    expect(attempt.status).toBe("Failed");
    expect(attempt.errorCode).not.toBeNull();
  }, 60_000);

  it("tears down a mid-prompt over-cap session even when acp_session_id is still null (matched by runId)", async () => {
    // The dangerous path: the run is over cap while the node prompt is still
    // running, so runs.acp_session_id has NOT been persisted yet — but a live
    // supervisor session exists. The run-keyed lookup MUST find and kill it,
    // otherwise the run is marked Failed while the agent keeps running.
    const { runId, supervisorSessionId } = await seedRunningNode({
      maxDurationMinutes: 10,
      attemptStartedAt: new Date(Date.now() - 30 * 60_000),
      acpSessionId: null,
    });

    listSessionsSpy.mockResolvedValue([
      // No acpSessionId on the record either — matched purely by runId.
      liveSessionRecord(runId, supervisorSessionId),
    ]);

    await runSweepTick({ db, executionHosts: hosts });

    expect(deleteSessionSpy).toHaveBeenCalledTimes(1);
    expect(deleteSessionSpy).toHaveBeenCalledWith(supervisorSessionId);
    expect((await getRun(runId)).status).toBe("Failed");
    expect((await getAttempt(runId)).status).toBe("Failed");
  }, 60_000);

  // A session's stepId is a LABEL, not the run's node cursor: the host rewrites
  // it on every prompt, consensus substeps send `<node>-verify` / `-synthesize`
  // and gates send the gate id, none of which equal runs.current_step_id.
  // Narrowing the lookup by it makes the watchdog declare a live agent
  // "confirmed absent" and mark the run Failed while it keeps spending.
  it("tears down a live session whose stepId is not the node cursor", async () => {
    const { runId, supervisorSessionId } = await seedRunningNode({
      maxDurationMinutes: 10,
      attemptStartedAt: new Date(Date.now() - 30 * 60_000),
      acpSessionId: null,
    });

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(
        runId,
        supervisorSessionId,
        undefined,
        "implement-verify",
      ),
    ]);

    await runSweepTick({ db, executionHosts: hosts });

    expect(deleteSessionSpy).toHaveBeenCalledTimes(1);
    expect(deleteSessionSpy).toHaveBeenCalledWith(supervisorSessionId);
    expect((await getRun(runId)).status).toBe("Failed");
  }, 60_000);

  it("leaves the run Running (retries next tick) when deleteSession fails with a retryable 5xx", async () => {
    // Marking Failed without confirming teardown is split-brain (terminal run,
    // live agent). A retryable supervisor failure must leave the run Running.
    const { runId, supervisorSessionId } = await seedRunningNode({
      maxDurationMinutes: 10,
      attemptStartedAt: new Date(Date.now() - 30 * 60_000),
      acpSessionId: "acp-5xx",
    });

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, supervisorSessionId, "acp-5xx"),
    ]);
    deleteSessionSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 503"),
    );

    await runSweepTick({ db, executionHosts: hosts });

    expect(deleteSessionSpy).toHaveBeenCalledTimes(1);
    expect((await getRun(runId)).status).toBe("Running");
    expect((await getAttempt(runId)).status).toBe("Running");
  }, 60_000);

  it("promotes a queued Pending run after a timeout kill frees the slot", async () => {
    const { runId, supervisorSessionId } = await seedRunningNode({
      maxDurationMinutes: 10,
      attemptStartedAt: new Date(Date.now() - 30 * 60_000),
      acpSessionId: "acp-promote",
    });
    const pendingRunId = await seedPendingRun(new Date(Date.now() - 60_000));

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, supervisorSessionId, "acp-promote"),
    ]);

    await runSweepTick({ db, executionHosts: hosts });

    // The capped run is terminal Failed; the freed slot promotes the Pending
    // run to Running AND dispatches runFlow for it (F3).
    expect((await getRun(runId)).status).toBe("Failed");
    expect((await getRun(pendingRunId)).status).toBe("Running");

    // runFlow is dispatched via queueMicrotask inside promoteNextPending; flush
    // the task queue before asserting the dispatch fired.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runFlowSpy).toHaveBeenCalledWith(pendingRunId);
  }, 60_000);
});

type Probe = "completed" | "indeterminate" | "rejected";

/** A v1-schema owned prompt of `variant` on the run's active attempt: the
 * watchdog classifies it by shape, not by canonical request identity. */
async function seedAttemptPrompt(
  runId: string,
  variant: "node" | "gate_skill" | "gate_ai",
  shape: "accepted" | "settled" | "applied",
  createdAt: Date,
): Promise<string> {
  const { mintAssignment } = await import("@/lib/execution-host/assignments");
  const [existing] = await db
    .select()
    .from(schema.executionAssignments)
    .where(eq(schema.executionAssignments.runId, runId));
  const assignment =
    existing ??
    (await db.transaction((tx) =>
      mintAssignment(tx as never, { runId, hostId, reason: "launch" }),
    ));
  const attempt = await getAttempt(runId);
  const commandId = randomUUID();
  const settled = shape !== "accepted";

  await db.insert(schema.executionCommands).values({
    id: commandId,
    runId,
    executionAssignmentId: assignment.id,
    executionHostId: hostId,
    assignmentEpoch: assignment.epoch,
    kind: "session.prompt",
    targetSessionId: `sess-${runId.slice(0, 8)}`,
    payload: {},
    maxAttempts: 3,
    ownerKind: "flow_node_attempt",
    ownerRef: {
      version: 1,
      variant,
      nodeAttemptId: attempt.id,
      promptOrdinal: 0,
      runId,
      runSessionId: randomUUID(),
      incarnationId: randomUUID(),
      assignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      ...(variant === "node"
        ? {}
        : { gateId: "g1", evaluationId: randomUUID() }),
    },
    logicalOperationKey: `flow_node_attempt:${variant}:${commandId}`,
    requestSchema: "maister.command.request.v1",
    requestSha256: "a".repeat(64),
    createdAt,
    ...(settled
      ? {
          state: "succeeded",
          acceptedAt: createdAt,
          completedAt: createdAt,
          result: { stopReason: "end_turn" },
          receiptEvidence: {
            commandId,
            runId,
            kind: "session.prompt",
            assignmentEpoch: assignment.epoch,
            phase: "completed",
            httpStatus: 200,
            body: { stopReason: "end_turn" },
            receivedAt: createdAt.toISOString(),
            inflight: false,
          },
          terminalEvidenceSha256: "b".repeat(64),
          settledFrom: "host_span",
          ...(shape === "applied"
            ? { applicationState: "applied", completionAppliedAt: createdAt }
            : {}),
        }
      : { state: "accepted", acceptedAt: createdAt }),
  });

  return commandId;
}

function scriptProbe(commandId: string, probe: Probe): void {
  receiptSpy.mockImplementation(async (id: string) => {
    if (id !== commandId) return null;
    if (probe === "completed")
      return { phase: "completed", body: { stopReason: "end_turn" } };
    if (probe === "rejected")
      return {
        phase: "rejected",
        body: { code: "ACP_PROTOCOL", message: "ordinary failure" },
      };

    return { phase: "accepted", evidenceV2: {}, inflight: false };
  });
}

describe("time-limit watchdog — a finished turn is never killed (ADR-167 D5 amendment, D-C1)", () => {
  const overCap = () =>
    seedRunningNode({
      maxDurationMinutes: 10,
      attemptStartedAt: new Date(Date.now() - 30 * 60_000),
      acpSessionId: null,
    });
  const earlier = new Date(Date.now() - 20 * 60_000);
  const later = new Date(Date.now() - 5 * 60_000);

  async function tick() {
    return (await runSweepTick({ db, executionHosts: hosts })) as {
      killedCount: number;
      deferredCompletedCount: number;
    };
  }

  it("C1-completed: an accepted turn whose receipt completed is deferred, and nothing but the probe reads the host", async () => {
    const { runId } = await overCap();
    const commandId = await seedAttemptPrompt(runId, "node", "accepted", later);

    scriptProbe(commandId, "completed");
    const spans = fake.callsOf("readRuntimeEventSpan").length;
    const result = await tick();

    expect((await getRun(runId)).status).toBe("Running");
    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect(result.deferredCompletedCount).toBe(1);
    expect(receiptSpy).toHaveBeenCalledWith(commandId);
    expect(fake.callsOf("readRuntimeEventSpan").length).toBe(spans);
    // No settlement or deposit either: the waiting driver owns that.
    const [row] = await db
      .select()
      .from(schema.executionCommands)
      .where(eq(schema.executionCommands.id, commandId));

    expect(row.receiptEvidence).toBeNull();
  }, 60_000);

  it("C1-settled: a settled but unapplied turn is deferred without a probe", async () => {
    const { runId } = await overCap();

    await seedAttemptPrompt(runId, "node", "settled", later);
    const result = await tick();

    expect((await getRun(runId)).status).toBe("Running");
    expect(result.deferredCompletedCount).toBe(1);
    expect(receiptSpy).not.toHaveBeenCalled();
  }, 60_000);

  it.each([
    [
      "C1-running: a running v2 turn (indeterminate) is killed",
      "indeterminate",
    ],
    [
      "C1-failed: an ordinary rejected turn is killed (failed turns settle canonically)",
      "rejected",
    ],
  ] as const)(
    "%s",
    async (_name, probe) => {
      const { runId } = await overCap();
      const commandId = await seedAttemptPrompt(
        runId,
        "node",
        "accepted",
        later,
      );

      scriptProbe(commandId, probe);
      const result = await tick();

      expect((await getRun(runId)).status).toBe("Failed");
      expect(result.deferredCompletedCount).toBe(0);
    },
    60_000,
  );

  it("C1-gate: the newest prompt across variants decides — a running gate prompt after the applied action is killed", async () => {
    const { runId } = await overCap();

    await seedAttemptPrompt(runId, "node", "applied", earlier);
    const gate = await seedAttemptPrompt(runId, "gate_ai", "accepted", later);

    scriptProbe(gate, "indeterminate");
    await tick();

    expect((await getRun(runId)).status).toBe("Failed");
    expect(receiptSpy).toHaveBeenCalledWith(gate);
  }, 60_000);

  it("C1-gate-done: a gate prompt that completed after the applied action is deferred", async () => {
    const { runId } = await overCap();

    await seedAttemptPrompt(runId, "node", "applied", earlier);
    const gate = await seedAttemptPrompt(
      runId,
      "gate_skill",
      "accepted",
      later,
    );

    scriptProbe(gate, "completed");
    const result = await tick();

    expect((await getRun(runId)).status).toBe("Running");
    expect(result.deferredCompletedCount).toBe(1);
  }, 60_000);

  it("C1-applied: an applied newest command means the driver sits between prompts — killed without a probe", async () => {
    const { runId } = await overCap();

    await seedAttemptPrompt(runId, "node", "applied", later);
    await tick();

    expect((await getRun(runId)).status).toBe("Failed");
    expect(receiptSpy).not.toHaveBeenCalled();
  }, 60_000);

  it("probes nothing for a candidate under its cap", async () => {
    const { runId } = await seedRunningNode({
      maxDurationMinutes: 60,
      attemptStartedAt: new Date(Date.now() - 5 * 60_000),
      acpSessionId: null,
    });

    await seedAttemptPrompt(runId, "node", "accepted", later);
    await tick();

    expect(receiptSpy).not.toHaveBeenCalled();
    expect((await getRun(runId)).status).toBe("Running");
  }, 60_000);
});
