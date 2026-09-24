// ADR-167 D5 amendment (2026-09-23), D-B7 / ADR-177 amendment: a turn the host
// completed is not lost with the manager's event stream. In the stream-lost
// branch only, the recovery resolver offers a `pending_ingest` command with a
// `completed` receipt to the host-evidence feeds once before the classifier
// would crash the run `stream-lost`. With a live stream nothing is read.
//
// Only a read that ANSWERED decides (review findings, 2026-09-23). Each read
// records its verdict on the command (`host_span_verdict`, cleared when a read
// claims it): a read in flight, a host that answered busy, or a receipt still
// being read leaves the evidence able to arrive, so the stream-lost bound does
// not hold; a refusal recorded by ANY reader does, whoever holds the claim.
import type { Db } from "@/lib/execution-host/db";
import type { BoundClient } from "@/lib/execution-host/client";
import type { FakeExecutionHost } from "@/test-support/fake-execution-host";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  executionCommands,
  executionEventStreams,
  runs,
} from "@/lib/db/schema";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import {
  HOST_SPAN_BUSY_ATTEMPTS,
  reconcilePromptCommand,
} from "@/lib/execution-host/prompt-reconciliation";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { MaisterError } from "@/lib/errors";
import { resolvePromptEvidence } from "@/lib/reconcile-evidence-db";
import {
  seedLocalHost,
  seedProject,
  seedRun,
  seedWorkspace,
} from "@/test-support/execution-host-seed";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { seedNodePromptOwner } from "@/test-support/prompt-owner-fixture";

let database: StartedPostgresTestDb;
let db: Db;
let projectId: string;
let hostId: string;
let fake: FakeExecutionHost;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "reconcile_host_evidence",
  });
  db = database.db as unknown as Db;
  projectId = await seedProject(database.db);
  fake = createFakeExecutionHost();
  hostId = (
    await seedLocalHost(database.db, {
      hostKey: fake.identity.hostKey,
      bootId: fake.identity.bootId,
    })
  ).id;
}, 180_000);

beforeEach(async () => {
  resetResolverForTests();
  resetRegistrarStateForTests();
  await fake.releaseIngest();
  fake.setPrunedFloor(null);
  await database.pool.query(
    "UPDATE execution_event_streams SET state = 'active' WHERE execution_host_id = $1",
    [hostId],
  );
});

afterAll(async () => {
  await fake?.releaseIngest();
  // Drain in-flight turns and canonical deliveries before the pool ends, or a
  // late delivery meets a terminated connection (57P01) after the suite.
  await fake?.waitForCanonicalEvents();
  await database?.stop();
});

/** A sessionless-looking Running node whose completed turn was never ingested. */
async function completedButUningested(): Promise<{
  runId: string;
  commandId: string;
}> {
  const runId = await seedRun(database.db, {
    projectId,
    status: "Running",
    runKind: "flow",
    executionDataPlaneMode: "canonical_events_v1",
  });

  await seedWorkspace(database.db, {
    runId,
    projectId,
    worktreePath: `/tmp/eh/${runId}`,
    parentRepoPath: "/tmp/eh/repo",
  });
  const installed = await fakeExecutionHosts(db, { fake, runId });
  const client: BoundClient = await installed.hosts.forAssignment(
    installed.assignment!,
  );
  const session = await client.createSession({
    stepId: "s1",
    executor: { agent: "claude", model: "mock" },
  });

  await db.update(runs).set({ currentStepId: "s1" }).where(eq(runs.id, runId));
  fake.holdIngest();
  const handle = await client.prompt(
    session.hostSessionId,
    { stepId: "s1", prompt: "hello" },
    {
      admitOwner: await seedNodePromptOwner(db, client, session.hostSessionId),
    },
  );

  await expect
    .poll(
      async () =>
        (await fake.transport.getCommandReceipt(handle.commandId))?.phase,
      { timeout: 10_000 },
    )
    .toBe("completed");

  return { runId, commandId: handle.commandId };
}

async function loseStream(): Promise<void> {
  await db
    .update(executionEventStreams)
    .set({ state: "lost" })
    .where(eq(executionEventStreams.executionHostId, hostId));
}

async function command(id: string) {
  const [row] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, id));

  return row!;
}

describe("stream-lost recovery settles on host evidence (D-B7)", () => {
  it("settles a completed turn from the host span instead of classifying it for a stream-lost crash", async () => {
    const { runId, commandId } = await completedButUningested();

    await loseStream();
    expect(
      await resolvePromptEvidence(db, fake.transport, { runId, nodeId: "s1" }),
    ).toMatchObject({
      evidence: "pending_application",
      streamLost: true,
      commandId,
    });
    expect(await command(commandId)).toMatchObject({
      settledFrom: "host_span",
      state: "succeeded",
    });
  });

  it("keeps the stream-lost classification when the span cannot be read", async () => {
    const { runId, commandId } = await completedButUningested();

    fake.setPrunedFloor("1000000");
    await loseStream();
    expect(
      await resolvePromptEvidence(db, fake.transport, { runId, nodeId: "s1" }),
    ).toMatchObject({ evidence: "pending_ingest", streamLost: true });
    expect(await command(commandId)).toMatchObject({
      terminalEvidenceSha256: null,
      settledFrom: null,
    });
  });

  it("defers while a concurrent reader holds the settlement claim, and that reader's settlement stands", async () => {
    const { runId, commandId } = await completedButUningested();
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    let pauseNext = true;

    // Parks the concurrent reader INSIDE its claim, mid span read — the window
    // in which a completed, readable turn was classified for a stream-lost crash.
    fake.onCall("readRuntimeEventSpan", async () => {
      if (!pauseNext) return;
      pauseNext = false;
      entered();
      await held;
    });
    await loseStream();
    const reader = reconcilePromptCommand({
      db,
      commandId,
      lookupReceipt: (id) => fake.transport.getCommandReceipt(id),
    });

    await inside;
    try {
      const reads = fake.callsOf("readRuntimeEventSpan").length;

      expect(
        await resolvePromptEvidence(db, fake.transport, {
          runId,
          nodeId: "s1",
        }),
        "a claim another reader holds is no verdict on the span: not crash-eligible",
      ).toMatchObject({
        evidence: "pending_ingest",
        streamLost: false,
        commandId,
      });
      expect(fake.callsOf("readRuntimeEventSpan").length).toBe(reads);
    } finally {
      // A failed assertion must not leave the reader parked for later cases.
      release();
    }
    await reader;
    expect(await command(commandId)).toMatchObject({
      settledFrom: "host_span",
      state: "succeeded",
      applicationState: "pending",
    });
    expect(
      await resolvePromptEvidence(db, fake.transport, { runId, nodeId: "s1" }),
    ).toMatchObject({ evidence: "pending_application", commandId });
  });

  it("defers when the host answers every span read busy; the next free claim settles", async () => {
    const { runId, commandId } = await completedButUningested();
    const busy = () =>
      new MaisterError(
        "PRECONDITION",
        "runtime object verification is busy; retry the read",
        { details: { reason: "command_in_progress" } },
      );

    await loseStream();
    // Exactly one fault per bounded re-read: a leftover would fail the next read.
    for (let i = 0; i < HOST_SPAN_BUSY_ATTEMPTS; i += 1)
      fake.failOnce("getRuntimeObjectContent", busy());
    expect(
      await resolvePromptEvidence(db, fake.transport, { runId, nodeId: "s1" }),
      "a busy host gave no verdict on the span: not crash-eligible",
    ).toMatchObject({ evidence: "pending_ingest", streamLost: false });
    expect(await command(commandId)).toMatchObject({
      terminalEvidenceSha256: null,
      hostSpanVerdict: "busy",
    });
    // The retry delay the deferred read left behind, which a later tick waits out.
    await db
      .update(executionCommands)
      .set({ nextAttemptAt: null })
      .where(eq(executionCommands.id, commandId));
    expect(
      await resolvePromptEvidence(db, fake.transport, { runId, nodeId: "s1" }),
    ).toMatchObject({ evidence: "pending_application", commandId });
    expect(await command(commandId)).toMatchObject({
      settledFrom: "host_span",
    });
  });

  it("crashes on a refusal another reader recorded, even while that reader's retry delay blocks the sweep's own read", async () => {
    const { runId, commandId } = await completedButUningested();

    fake.setPrunedFloor("1000000");
    await loseStream();
    // A flow wait reads the span first and is refused; its claim now sits in
    // the 5 s retry delay, so the sweep cannot read for itself.
    await reconcilePromptCommand({
      db,
      commandId,
      lookupReceipt: (id) => fake.transport.getCommandReceipt(id),
    });
    expect(await command(commandId)).toMatchObject({
      hostSpanVerdict: "refused",
      terminalEvidenceSha256: null,
    });
    const reads = fake.callsOf("readRuntimeEventSpan").length;

    expect(
      await resolvePromptEvidence(db, fake.transport, { runId, nodeId: "s1" }),
      "the recorded refusal is the answer; waiting for the claim would defer on chance",
    ).toMatchObject({ evidence: "pending_ingest", streamLost: true });
    expect(fake.callsOf("readRuntimeEventSpan").length).toBe(reads);
  });

  it("a read that claims the command clears an earlier refusal, so its own answer is awaited", async () => {
    const { runId, commandId } = await completedButUningested();

    fake.setPrunedFloor("1000000");
    await loseStream();
    await reconcilePromptCommand({
      db,
      commandId,
      lookupReceipt: (id) => fake.transport.getCommandReceipt(id),
    });
    expect(await command(commandId)).toMatchObject({
      hostSpanVerdict: "refused",
    });
    // The span became readable again (the refusal was a transient one); a new
    // reader claims once the retry delay lapses and is parked mid-read.
    fake.setPrunedFloor(null);
    await db
      .update(executionCommands)
      .set({ nextAttemptAt: null })
      .where(eq(executionCommands.id, commandId));
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    let pauseNext = true;

    fake.onCall("readRuntimeEventSpan", async () => {
      if (!pauseNext) return;
      pauseNext = false;
      entered();
      await held;
    });
    const reader = reconcilePromptCommand({
      db,
      commandId,
      lookupReceipt: (id) => fake.transport.getCommandReceipt(id),
    });

    await inside;
    try {
      expect(
        await resolvePromptEvidence(db, fake.transport, {
          runId,
          nodeId: "s1",
        }),
        "the earlier refusal is stale once a new read claimed the command",
      ).toMatchObject({ evidence: "pending_ingest", streamLost: false });
    } finally {
      release();
    }
    await reader;
    expect(await command(commandId)).toMatchObject({
      settledFrom: "host_span",
      hostSpanVerdict: null,
    });
  });

  it("defers while another reader holds the receipt claim and nothing is deposited yet", async () => {
    const { runId, commandId } = await completedButUningested();

    await loseStream();
    await db
      .update(executionCommands)
      .set({ nextAttemptAt: new Date(Date.now() + 30_000) })
      .where(eq(executionCommands.id, commandId));
    expect(await command(commandId)).toMatchObject({ receiptEvidence: null });
    expect(
      await resolvePromptEvidence(db, fake.transport, { runId, nodeId: "s1" }),
    ).toMatchObject({ evidence: "pending_ingest", streamLost: false });
    // The holder's claim lapses; the next tick reads and settles for itself.
    await db
      .update(executionCommands)
      .set({ nextAttemptAt: null })
      .where(eq(executionCommands.id, commandId));
    expect(
      await resolvePromptEvidence(db, fake.transport, { runId, nodeId: "s1" }),
    ).toMatchObject({ evidence: "pending_application", commandId });
  });

  it("never throws when the offer's receipt read fails outright (a throw would reject the whole sweep pass)", async () => {
    const { runId, commandId } = await completedButUningested();
    let reads = 0;

    await loseStream();
    // The probe's read succeeds (`completed`); the offer's own read, a moment
    // later, fails with an error the transport classifier does not retry.
    const stop = fake.onCall("getCommandReceipt", (call) => {
      if (call.args[0] !== commandId) return;
      reads += 1;
      if (reads === 2)
        throw new MaisterError("PRECONDITION", "fake: receipt read failed", {
          details: { httpStatus: 500 },
        });
    });

    try {
      expect(
        await resolvePromptEvidence(db, fake.transport, {
          runId,
          nodeId: "s1",
        }),
        "an offer that could not read is no settlement, and no verdict either",
      ).toMatchObject({
        evidence: "pending_ingest",
        streamLost: false,
        commandId,
      });
    } finally {
      stop();
    }
    expect(reads).toBe(2);
    expect(await command(commandId)).toMatchObject({
      terminalEvidenceSha256: null,
    });
  });

  it("reads nothing from the host while the stream is live: pending_ingest still skips", async () => {
    const { runId, commandId } = await completedButUningested();
    const reads = fake.callsOf("readRuntimeEventSpan").length;

    expect(
      await resolvePromptEvidence(db, fake.transport, { runId, nodeId: "s1" }),
    ).toMatchObject({ evidence: "pending_ingest", streamLost: false });
    expect(fake.callsOf("readRuntimeEventSpan").length).toBe(reads);
    expect(await command(commandId)).toMatchObject({
      terminalEvidenceSha256: null,
    });
  });
});
