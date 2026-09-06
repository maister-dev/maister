import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { issueOwnedPrompt } from "../ledger";
import { defaultTransport } from "../default-transport";
import { startAsyncPrompt, waitForPromptCompletion } from "../deliverer";
import { readPromptOutput } from "../prompt-output";

import { createExecutionHosts } from "@/lib/execution-host/client";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import {
  executionEvents,
  executionCommands,
  runSessionIncarnations,
  runs,
  executionRuntimeObjects,
  runMessages,
} from "@/lib/db/schema";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import {
  prepareSessionContent,
  preparePromptContent,
} from "@/lib/execution-host/events/session-content";
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

async function startOwnedFixturePrompt(
  producer: Awaited<ReturnType<typeof createSession>>,
  prompt: string,
): Promise<{
  admitted: Awaited<ReturnType<typeof issueOwnedPrompt>>;
  handle: { commandId: string };
}> {
  const db = database.db as unknown as Db;
  const transport = defaultTransport();

  await database.db
    .update(runs)
    .set({ runKind: "agent" })
    .where(eq(runs.id, producer.runId));
  await expect
    .poll(
      async () => {
        const rows = await database.db
          .select()
          .from(runSessionIncarnations)
          .where(
            eq(
              runSessionIncarnations.hostSessionId,
              producer.session.hostSessionId,
            ),
          );

        return rows[0]?.state;
      },
      { timeout: 15_000 },
    )
    .toBe("active");
  const [incarnation] = await database.db
    .select()
    .from(runSessionIncarnations)
    .where(
      eq(runSessionIncarnations.hostSessionId, producer.session.hostSessionId),
    );
  const turnId = randomUUID();
  const admitted = await issueOwnedPrompt(db, {
    assignment: producer.client.assignment,
    host: producer.client.host,
    targetSessionId: producer.session.hostSessionId,
    payload: {
      stepId: "output",
      prompt,
    },
    maxAttempts: 3,
    admitOwner: async () => ({
      logicalOperationKey: `agent_turn:initial:${turnId}:0`,
      owner: {
        kind: "agent_turn",
        ref: {
          version: 1,
          variant: "initial",
          runId: producer.runId,
          runSessionId: incarnation.runSessionId,
          incarnationId: incarnation.id,
          assignmentId: producer.client.assignment.id,
          assignmentEpoch: producer.client.assignment.epoch,
          turnId,
          promptOrdinal: 0,
        },
      },
    }),
  });
  const handle = await startAsyncPrompt({
    db,
    command: admitted.row,
    envelope: admitted.envelope,
    start: () =>
      transport.startPrompt(producer.session.hostSessionId, admitted.envelope),
    lookupReceipt: (id) => transport.getCommandReceipt(id),
  });

  return { admitted, handle };
}

describe("AT-01 bounded output on the production supervisor", () => {
  it("AT-06 v2: agrees on original private failure bytes after hydrating a canonical command content reference", async () => {
    const producer = await createSession("command-private-failure-v2");
    const { handle } = await startOwnedFixturePrompt(
      producer,
      'fixture-output:{"failMessage":"private failure at /private/original-output.json"}',
    );
    const db = database.db as unknown as Db;
    const transport = defaultTransport();

    await expect(
      waitForPromptCompletion({
        db,
        handle,
        lookupReceipt: (id) => transport.getCommandReceipt(id),
        signal: AbortSignal.timeout(15_000),
      }),
    ).rejects.toMatchObject({ code: "ACP_PROTOCOL" });
    const [command] = await database.db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, handle.commandId));
    const [event] = await database.db
      .select()
      .from(executionEvents)
      .where(eq(executionEvents.id, command.terminalEventId!));
    const prepared = await preparePromptContent(
      db,
      event,
      AbortSignal.timeout(15_000),
    );

    expect(command.state).toBe("failed");
    expect(command.terminalEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(event.payloadSchema).toBe("maister.session.content.v2");
    expect(prepared.payloadSchema).toBe("maister.session.command.v2");
    expect(prepared.payload?.terminal).toEqual(
      command.receiptEvidence?.evidenceV2?.terminal,
    );
    expect(
      command.receiptEvidence?.evidenceV2?.terminal?.error?.message,
    ).toContain("/private/original-output.json");
  });

  it("AT-06 v2: reconstructs original command output from durable evidence after releasing its assignment", async () => {
    const producer = await createSession("command-output-v2");
    const db = database.db as unknown as Db;
    const transport = defaultTransport();
    const originalMeta = {
      result: {
        decision: "accept",
        details: { proof: "original opaque result" },
      },
    };
    const { admitted, handle } = await startOwnedFixturePrompt(
      producer,
      `fixture-output:${JSON.stringify({ bytes: 65537, tool: true, responseMeta: originalMeta })}`,
    );

    await expect(
      waitForPromptCompletion({
        db,
        handle,
        lookupReceipt: (id) => transport.getCommandReceipt(id),
        signal: AbortSignal.timeout(15_000),
      }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    const [stored] = await database.db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, handle.commandId));

    expect(stored.receiptEvidence?.evidenceV2?.requestSha256).toBe(
      admitted.row.requestSha256,
    );
    expect(stored.result).not.toHaveProperty("meta");
    await worker.stop();
    try {
      await database.db
        .delete(runMessages)
        .where(eq(runMessages.runId, producer.runId));
      await releaseAssignmentForRun(
        db,
        producer.runId,
        "historical-command-output",
      );
      const output = await readPromptOutput({
        db,
        commandId: handle.commandId,
        signal: AbortSignal.timeout(15_000),
      });
      const payloads: unknown[] = [];

      for await (const event of output.events) payloads.push(event.payload);
      expect(output.response).toEqual({
        stopReason: "end_turn",
        _meta: originalMeta,
      });
      expect(payloads).toContainEqual(
        expect.objectContaining({
          sourceCommandId: handle.commandId,
          update: expect.objectContaining({
            toolCallId: "large-tool",
            content: [
              {
                type: "content",
                content: { type: "text", text: "x".repeat(65537) },
              },
            ],
          }),
        }),
      );
      // A retained frontier cannot stand in for the original event span.
      const [update] = await database.db
        .select()
        .from(executionEvents)
        .where(
          and(
            eq(executionEvents.runId, producer.runId),
            eq(executionEvents.eventType, "session.update"),
          ),
        )
        .limit(1);

      await database.db
        .delete(executionEvents)
        .where(eq(executionEvents.id, update.id));
      await expect(
        readPromptOutput({
          db,
          commandId: handle.commandId,
          signal: AbortSignal.timeout(15_000),
        }),
      ).rejects.toMatchObject({
        details: {
          reason: "required_output_incomplete",
          causeCode: "event_span_gap",
        },
      });
    } finally {
      worker = startProjectionWorker({ db, projectors: canonicalProjectors });
    }
  });

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
