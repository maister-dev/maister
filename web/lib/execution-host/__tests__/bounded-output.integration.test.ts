import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { createExecutionHosts } from "@/lib/execution-host/client";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import {
  executionEvents,
  executionRuntimeObjects,
  runMessages,
} from "@/lib/db/schema";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import { prepareSessionContent } from "@/lib/execution-host/events/session-content";
import { projectCanonicalRuntimeObjects } from "@/lib/execution-host/events/runtime-object-projector";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import {
  startProjectionWorker,
  type ProjectionWorker,
} from "@/lib/execution-host/events/projection-worker";
import { SessionContentReferenceSchema } from "@/lib/execution-host/runtime-events";
import { readRuntimeObjectContent } from "@/lib/execution-host/runtime-objects";
import {
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

let database: StartedPostgresTestDb;
let supervisor: RealSupervisor;
let hosts: ExecutionHosts;
let worker: ProjectionWorker;
let project: Awaited<ReturnType<typeof seedProjectRow>>;
let restoreUrl: () => void = () => {};

async function createSession(name: string) {
  const runId = await seedRun(database.db, {
    projectId: project.id,
    status: "Running",
    runKind: "flow",
  });
  const worktreePath = await addWorktree(
    project.repoPath,
    `${supervisor.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );

  await seedWorkspace(database.db, {
    runId,
    projectId: project.id,
    worktreePath,
    parentRepoPath: project.repoPath,
  });
  const client = await hosts.forRun(runId, { reason: "launch" });
  const session = await client.createSession({
    stepId: "output",
    executor: { agent: "claude", model: "mock" },
  });

  return { runId, client, session };
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "bounded_output" });
  supervisor = await startRealSupervisor({
    fixtureArgs: ["--hang", "--lines", "0"],
  });
  restoreUrl = useRealSupervisorUrl(supervisor.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  project = await seedProjectRow(database.db, {
    repoPath: await initRepo(`${supervisor.runtimeRoot}/repo`),
  });
  hosts = createExecutionHosts({ db: database.db as unknown as Db });
  worker = startProjectionWorker({
    db: database.db as unknown as Db,
    projectors: canonicalProjectors,
  });
}, 180_000);

afterAll(async () => {
  restoreUrl();
  await worker?.stop();
  await supervisor?.kill();
  await database?.stop();
});

describe("AT-01 bounded output on the production supervisor", () => {
  it("reconstructs accepted output after releasing the original assignment", async () => {
    const producer = await createSession("historical-reference");
    const handle = await producer.client.prompt(
      producer.session.hostSessionId,
      { stepId: "output", prompt: 'fixture-output:{"bytes":65537}' },
    );

    await producer.client.waitForPrompt(handle, {
      signal: AbortSignal.timeout(15_000),
    });
    await worker.stop();
    try {
      const events = await database.db
        .select()
        .from(executionEvents)
        .where(
          and(
            eq(executionEvents.runId, producer.runId),
            eq(executionEvents.eventType, "session.update"),
          ),
        );
      const event = events.find((row) => row.payload?.contentRef)!;
      const reference = SessionContentReferenceSchema.parse(
        event.payload?.contentRef,
      );

      await database.db
        .delete(executionRuntimeObjects)
        .where(eq(executionRuntimeObjects.id, reference.objectId));
      await releaseAssignmentForRun(
        database.db as unknown as Db,
        producer.runId,
        "historical-output-test",
      );
      const prepared = await prepareSessionContent(
        database.db as unknown as Db,
        event,
        AbortSignal.timeout(10_000),
      );

      expect(prepared.payload).toMatchObject({
        update: { content: { text: "x".repeat(65537) } },
      });
    } finally {
      worker = startProjectionWorker({
        db: database.db as unknown as Db,
        projectors: canonicalProjectors,
      });
    }
  });

  it.each([65536, 65537])(
    "preserves a %i-byte tool result through the transcript consumer",
    async (bytes) => {
      const producer = await createSession(`tool-${bytes}`);
      const handle = await producer.client.prompt(
        producer.session.hostSessionId,
        {
          stepId: "output",
          prompt: `fixture-output:${JSON.stringify({ bytes, tool: true })}`,
        },
      );

      await expect(
        producer.client.waitForPrompt(handle, {
          signal: AbortSignal.timeout(15_000),
        }),
      ).resolves.toMatchObject({ stopReason: "end_turn" });
      await expect
        .poll(
          async () => {
            const rows = await database.db
              .select({ content: runMessages.content })
              .from(runMessages)
              .where(eq(runMessages.runId, producer.runId));

            return rows.some((row) => row.content.includes("x".repeat(bytes)));
          },
          { timeout: 15_000 },
        )
        .toBe(true);
    },
  );

  it("accepts the exact 1-MiB framed boundary", async () => {
    const producer = await createSession("frame-at-limit");
    const handle = await producer.client.prompt(
      producer.session.hostSessionId,
      { stepId: "output", prompt: 'fixture-output:{"frameBytes":1048576}' },
    );

    await expect(
      producer.client.waitForPrompt(handle, {
        signal: AbortSignal.timeout(15_000),
      }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    await expect
      .poll(
        async () => {
          const rows = await database.db
            .select({ content: runMessages.content })
            .from(runMessages)
            .where(eq(runMessages.runId, producer.runId));

          return rows.reduce(
            (total, row) => total + Buffer.byteLength(row.content),
            0,
          );
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(1_048_000);
  });

  it("fails only the producer when a frame exceeds 1 MiB", async () => {
    const sibling = await createSession("over-limit-sibling");
    const producer = await createSession("frame-over-limit");
    const handle = await producer.client.prompt(
      producer.session.hostSessionId,
      { stepId: "output", prompt: 'fixture-output:{"frameBytes":1048577}' },
    );

    await expect(
      producer.client.waitForPrompt(handle, {
        signal: AbortSignal.timeout(15_000),
      }),
    ).rejects.toMatchObject({
      code: "ACP_PROTOCOL",
      details: {
        reason: "runtime_output_frame_too_large",
        outputFailure: "producer_frame_limit",
      },
    });
    const other = await sibling.client.prompt(sibling.session.hostSessionId, {
      stepId: "output",
      prompt: "sibling",
    });

    await expect(
      sibling.client.waitForPrompt(other, {
        signal: AbortSignal.timeout(10_000),
      }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    expect((await fetch(`${supervisor.url}/health`)).status).toBe(200);
  });

  it("preserves a 65,537-byte multibyte ACP message and keeps a sibling usable", async () => {
    const sibling = await createSession("sibling");
    const producer = await createSession("large");
    const handle = await producer.client.prompt(
      producer.session.hostSessionId,
      {
        stepId: "output",
        prompt: 'fixture-output:{"bytes":65537,"multibyte":true}',
      },
    );

    await expect(
      producer.client.waitForPrompt(handle, {
        signal: AbortSignal.timeout(10_000),
      }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    await projectCanonicalRuntimeObjects({
      db: database.db as unknown as Db,
      runId: producer.runId,
    });
    const rows = await database.db
      .select()
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.runId, producer.runId),
          eq(executionEvents.eventType, "session.update"),
        ),
      );
    const reference = SessionContentReferenceSchema.parse(
      rows.find((row) => row.payload?.contentRef)?.payload?.contentRef,
    );

    expect(reference.commandId).toBe(handle.commandId);
    const referenced = rows.find((row) => row.payload?.contentRef)!;

    expect(referenced.payloadSchema).toBe("maister.session.content.v2");
    expect(reference.firstFrame).toBe(referenced.payload?.sourceMonotonicId);
    expect(reference.source).toBe("session_update");
    const object = await readRuntimeObjectContent({
      db: database.db as unknown as Db,
      runId: producer.runId,
      objectId: reference.objectId,
    });
    const payload = JSON.parse(
      new TextDecoder().decode(object.content.bytes),
    ) as { update: { content: { text: string } } };

    expect(payload.update.content.text).toBe("é".repeat(32768) + "x");
    await expect
      .poll(
        async () => {
          const messages = await database.db
            .select({ content: runMessages.content })
            .from(runMessages)
            .where(eq(runMessages.runId, producer.runId));

          return messages.map((message) => message.content).join("");
        },
        { timeout: 10_000 },
      )
      .toBe("é".repeat(32768) + "x");
    const other = await sibling.client.prompt(sibling.session.hostSessionId, {
      stepId: "output",
      prompt: "sibling",
    });

    await expect(sibling.client.waitForPrompt(other)).resolves.toMatchObject({
      stopReason: "end_turn",
    });
    expect((await fetch(`${supervisor.url}/health`)).status).toBe(200);
  });
});
