// ADR-167 D5 amendment (2026-09-23), D-B7 / ADR-177 amendment: a turn the host
// completed is not lost with the manager's event stream. In the stream-lost
// branch only, the recovery resolver offers a `pending_ingest` command with a
// `completed` receipt to the host-evidence feeds once before the classifier
// would crash the run `stream-lost`. With a live stream nothing is read.
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
import { resetResolverForTests } from "@/lib/execution-host/resolver";
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
