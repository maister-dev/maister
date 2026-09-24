// ADR-167 D5 amendment (2026-09-23), review finding: a turn settled from the
// host's span can reach its owner before canonical ingest reaches the terminal
// event. If the span then cannot be read, the output is behind the canonical
// frontier — evidence that is late, not a failed application. It must not count
// toward poisoning while the stream can still deliver it; once the stream is
// lost nothing will, and counting is the bound.
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
import { applyPromptOwner } from "@/lib/execution-host/prompt-owner-application";
import {
  createPromptOwnerRegistry,
  definePromptOwnerAdapter,
} from "@/lib/execution-host/prompt-owners";
import { reconcilePromptCommand } from "@/lib/execution-host/prompt-reconciliation";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
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

// Reads the whole output, as every real adapter does before applying.
const owners = createPromptOwnerRegistry([
  definePromptOwnerAdapter("flow_node_attempt", async ({ outcome }) => {
    if (outcome.state === "succeeded")
      for await (const event of outcome.events) void event;

    return { apply: async () => "applied" };
  }),
]);

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "prompt_output_frontier",
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
  await fake?.waitForCanonicalEvents();
  await database?.stop();
});

/** A turn settled from the host's span while canonical ingest is held, whose
 * span is then made unreadable. */
async function settledAheadOfCanonical(): Promise<string> {
  const runId = await seedRun(database.db, {
    projectId,
    status: "Running",
    runKind: "flow",
    executionDataPlaneMode: "canonical_events_v1",
  });

  await seedWorkspace(database.db, {
    runId,
    projectId,
    worktreePath: `/tmp/pof/${runId}`,
    parentRepoPath: "/tmp/pof/repo",
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
      async () => {
        await reconcilePromptCommand({
          db,
          commandId: handle.commandId,
          lookupReceipt: (id) => fake.transport.getCommandReceipt(id),
        });

        return (await command(handle.commandId)).settledFrom;
      },
      { timeout: 10_000 },
    )
    .toBe("host_span");
  fake.setPrunedFloor("1000000");

  return handle.commandId;
}

async function command(id: string) {
  const [row] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, id));

  return row!;
}

describe("output behind the canonical frontier (owner application)", () => {
  it("defers without counting a failure while the stream can still deliver the output", async () => {
    const commandId = await settledAheadOfCanonical();

    expect(
      await applyPromptOwner({
        db,
        owners,
        commandId,
        signal: AbortSignal.timeout(30_000),
      }),
    ).toBe("deferred");
    expect(await command(commandId)).toMatchObject({
      applicationState: "pending",
      applicationAttempts: 0,
      applicationError: null,
    });
  }, 60_000);

  it("counts the refusal once the stream is lost, so poisoning still bounds it", async () => {
    const commandId = await settledAheadOfCanonical();

    await db
      .update(executionEventStreams)
      .set({ state: "lost" })
      .where(eq(executionEventStreams.executionHostId, hostId));
    await applyPromptOwner({
      db,
      owners,
      commandId,
      signal: AbortSignal.timeout(30_000),
    });
    expect(await command(commandId)).toMatchObject({
      applicationState: "pending",
      applicationAttempts: 1,
      applicationError: { reason: "prompt_owner_retry" },
    });
  }, 60_000);
});
