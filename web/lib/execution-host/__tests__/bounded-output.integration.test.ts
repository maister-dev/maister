import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { issueOwnedPrompt } from "../ledger";
import { defaultTransport } from "../default-transport";
import {
  queryPrompt,
  startAsyncPrompt,
  waitForPromptCompletion,
} from "../deliverer";
import {
  createPromptOwnerRegistry,
  definePromptOwnerAdapter,
  PromptOwnerInvariantError,
  PromptOwnerDeferred,
  preparePromptOwner,
} from "../prompt-owners";
import {
  applyClaimedPromptOwner,
  claimPromptOwner,
  releasePromptOwnerClaim,
} from "../prompt-owner-application";
import { startPromptOwnerWorker } from "../prompt-owner-recovery";
import { readPromptOutput } from "../prompt-output";
import { rearmPromptAdmission } from "../commands";
import { applyCreateAck } from "../create-ack";
import { canonicalLifecycleProjector } from "../events/lifecycle-projector";
import { recoverExecutionCommands } from "../recovery";
import {
  stopRuntimeEventConsumers,
  startRuntimeEventConsumer,
} from "../events/consumer";

import * as fullSchema from "@/lib/db/schema";
import {
  agentPromptOwners,
  createAgentPromptOwners,
} from "@/lib/agents/prompt-owner";
import { agentMessageText } from "@/lib/run-transcript/agent-text";
import { waitForPromptIncarnation } from "@/lib/execution-host/prompt-incarnation";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import {
  executionEvents,
  executionEventConsumers,
  executionCommands,
  runSessionIncarnations,
  runSessions,
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

async function createRunClient(name: string) {
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

  return { runId, client };
}

async function createSession(name: string) {
  const { runId, client } = await createRunClient(name);
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

async function admitOwnedFixturePrompt(
  producer: Awaited<ReturnType<typeof createSession>>,
  prompt: string,
): Promise<Awaited<ReturnType<typeof issueOwnedPrompt>>> {
  const db = database.db as unknown as Db;

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

  return admitted;
}

async function startOwnedFixturePrompt(
  producer: Awaited<ReturnType<typeof createSession>>,
  prompt: string,
): Promise<{
  admitted: Awaited<ReturnType<typeof issueOwnedPrompt>>;
  handle: { commandId: string };
}> {
  const db = database.db as unknown as Db;
  const transport = defaultTransport();
  const admitted = await admitOwnedFixturePrompt(producer, prompt);
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

async function settledOwnerFixture(name: string) {
  const producer = await createSession(name);
  const db = database.db as unknown as Db;
  const { handle } = await startOwnedFixturePrompt(
    producer,
    'fixture-output:{"bytes":65537}',
  );

  await waitForPromptCompletion({
    db,
    handle,
    signal: AbortSignal.timeout(15_000),
    lookupReceipt: (id) => defaultTransport().getCommandReceipt(id),
  });

  return { db, producer, handle };
}

function startPromptRecoveryProcess(
  commandId: string,
  hostId: string,
): {
  child: ChildProcess;
  messages: Array<Record<string, unknown>>;
  exited: Promise<number | null>;
  output: () => string;
} {
  const child = fork(
    path.resolve("test-support/prompt-recovery-process.ts"),
    [commandId, hostId],
    {
      execArgv: [
        "--import",
        "tsx",
        "--import",
        path.resolve("scripts/_register-shim.mjs"),
      ],
      env: { ...process.env, DB_URL: database.databaseUrl },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const messages: Array<Record<string, unknown>> = [];
  let output = "";
  const record = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-16_384);
  };

  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  child.on("message", (message: Record<string, unknown>) =>
    messages.push(message),
  );
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });

  return { child, messages, exited, output: () => output };
}

describe("AT-01 bounded output on the production supervisor", () => {
  it("failed-create-lifecycle: an initial refused resume records only a binding-free logical session", async () => {
    const producer = await createRunClient("failed-initial-create");

    await expect(
      producer.client.createSession({
        stepId: "output",
        executor: { agent: "claude", model: "mock" },
        resumeSessionId: "uninitialized-resume-handle",
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT" });
    await expect
      .poll(
        async () => {
          const [incarnation] = await database.db
            .select()
            .from(runSessionIncarnations)
            .where(eq(runSessionIncarnations.runId, producer.runId));

          return incarnation?.state;
        },
        { timeout: 5_000 },
      )
      .toBe("exited");
    const [logical] = await database.db
      .select()
      .from(runSessions)
      .where(eq(runSessions.runId, producer.runId));

    expect(logical).toMatchObject({
      sessionName: "default",
      acpSessionId: null,
      hostSessionId: null,
      executionAssignmentId: null,
    });
  }, 20_000);

  it("failed-create-lifecycle: a refused resume cannot poison the next native incarnation", async () => {
    const producer = await createSession("failed-create-lifecycle");

    await producer.client.deleteSession(producer.session.sessionId);
    await expect
      .poll(
        async () => {
          const [incarnation] = await database.db
            .select()
            .from(runSessionIncarnations)
            .where(
              eq(
                runSessionIncarnations.hostSessionId,
                producer.session.sessionId,
              ),
            );

          return incarnation?.state;
        },
        { timeout: 5_000 },
      )
      .toBe("exited");
    await expect(
      producer.client.createSession({
        stepId: "output",
        executor: { agent: "claude", model: "mock" },
        resumeSessionId: producer.session.acpSessionId!,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT" });
    const next = await producer.client.createSession({
      stepId: "output",
      executor: { agent: "claude", model: "mock" },
    });

    try {
      await expect
        .poll(
          async () => {
            const [incarnation] = await database.db
              .select()
              .from(runSessionIncarnations)
              .where(eq(runSessionIncarnations.hostSessionId, next.sessionId));

            return incarnation?.state;
          },
          { timeout: 5_000 },
        )
        .toBe("active");
      const incarnations = await database.db
        .select()
        .from(runSessionIncarnations)
        .where(eq(runSessionIncarnations.runId, producer.runId));

      expect(incarnations).toHaveLength(3);
      const failed = incarnations.find(
        (incarnation) =>
          incarnation.hostSessionId !== producer.session.sessionId &&
          incarnation.hostSessionId !== next.sessionId,
      );

      expect(failed).toMatchObject({
        state: "exited",
        acpSessionId: null,
        activatedAt: null,
        endedAt: expect.any(Date),
        terminalReason: {
          createdByCommandId: expect.any(String),
          sessionName: "default",
          acpSessionId: null,
        },
      });
      const [failedCreate] = await database.db
        .select()
        .from(executionCommands)
        .where(
          eq(
            executionCommands.id,
            failed!.terminalReason!.createdByCommandId as string,
          ),
        );

      expect(failedCreate).toMatchObject({
        runId: producer.runId,
        kind: "session.create",
        state: "failed",
        payload: { sessionName: "default" },
      });
      const terminalEvents = await database.db
        .select()
        .from(executionEvents)
        .where(eq(executionEvents.runSessionIncarnationId, failed!.id));

      expect(
        terminalEvents.some((event) => event.eventType === "session.exited"),
      ).toBe(true);
      const terminal = terminalEvents.find(
        (event) => event.eventType === "session.exited",
      )!;

      for (const payload of [
        { ...terminal.payload, createdByCommandId: null },
        { ...terminal.payload, createdByCommandId: randomUUID() },
        { ...terminal.payload, sessionName: "another-logical-session" },
      ]) {
        await expect(
          database.db.transaction((tx) =>
            canonicalLifecycleProjector.project(tx as unknown as Db, {
              ...terminal,
              hostSessionId: randomUUID(),
              payload,
            }),
          ),
        ).rejects.toMatchObject({ permanent: true });
      }
      expect(
        await applyCreateAck(database.db as unknown as Db, {
          runId: producer.runId,
          sessionName: "default",
          assignmentId: failedCreate.executionAssignmentId,
          nodeAttemptId: null,
          result: {
            sessionId: failed!.hostSessionId,
            acpSessionId: "late-dead-handle",
          },
        }),
      ).toBe("stale");
      const [current] = await database.db
        .select()
        .from(runSessions)
        .where(eq(runSessions.runId, producer.runId));

      expect(current).toMatchObject({
        hostSessionId: next.sessionId,
        acpSessionId: next.acpSessionId,
      });
      const consumers = await database.db
        .select()
        .from(executionEventConsumers)
        .where(eq(executionEventConsumers.runId, producer.runId));

      expect(consumers.every((consumer) => consumer.state !== "poisoned")).toBe(
        true,
      );
    } finally {
      await producer.client.deleteSession(next.sessionId);
    }
  }, 20_000);

  it("S2.5: query applies verified owner output and its marker exactly once", async () => {
    const producer = await createSession("owner-application");
    const db = database.db as unknown as Db;
    const originalMeta = { result: { proof: "owner application output" } };
    const { handle } = await startOwnedFixturePrompt(
      producer,
      `fixture-output:${JSON.stringify({ bytes: 65537, responseMeta: originalMeta })}`,
    );

    await waitForPromptCompletion({
      db,
      handle,
      signal: AbortSignal.timeout(15_000),
      lookupReceipt: (id) => defaultTransport().getCommandReceipt(id),
    });
    let applications = 0;
    // This exercises the dispatch transaction seam. The complete production
    // owner-entrypoint matrix belongs to the domain adapter scenarios.
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter(
        "agent_turn",
        async ({ owner, command, outcome }) => {
          expect(owner.ref.variant).toBe("initial");
          if (outcome.state !== "succeeded")
            throw new Error("fixture requires successful output");
          expect(outcome.response._meta).toEqual(originalMeta);
          let events = 0;

          for await (const event of outcome.events) {
            expect(event.payload?.sourceCommandId).toBe(command.id);
            events += 1;
          }
          expect(events).toBeGreaterThan(0);

          return {
            apply: async (tx) => {
              await tx
                .select()
                .from(runs)
                .where(eq(runs.id, owner.ref.runId))
                .for("update");
              await tx.insert(runMessages).values({
                id: `${command.id}:owner-application`,
                runId: owner.ref.runId,
                sequence: 1_000_000,
                role: "assistant",
                content: JSON.stringify(outcome.response._meta),
              });
              applications += 1;

              return "applied";
            },
          };
        },
      ),
    ]);
    const query = { db, handle, owners, signal: AbortSignal.timeout(15_000) };

    await queryPrompt(query);
    await queryPrompt(query);
    const [command] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, handle.commandId));
    const messages = await db
      .select()
      .from(runMessages)
      .where(eq(runMessages.id, `${handle.commandId}:owner-application`));

    expect(command.applicationState).toBe("applied");
    expect(command.completionAppliedAt).not.toBeNull();
    expect(applications).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe(JSON.stringify(originalMeta));
    await producer.client.deleteSession(producer.session.hostSessionId);
  });

  it("S2.8: draft adapter extension receives complete original output and applies once", async () => {
    const producer = await createSession("agent-draft-adapter");
    const db = database.db as unknown as Db;

    await db
      .update(runs)
      .set({ runKind: "agent" })
      .where(eq(runs.id, producer.runId));
    await waitForPromptIncarnation(
      db,
      producer.client,
      producer.session.hostSessionId,
    );
    const [incarnation] = await db
      .select()
      .from(runSessionIncarnations)
      .where(
        eq(
          runSessionIncarnations.hostSessionId,
          producer.session.hostSessionId,
        ),
      );
    const turnId = randomUUID();
    const ref = {
      version: 1 as const,
      variant: "consensus_draft" as const,
      runId: producer.runId,
      runSessionId: incarnation.runSessionId,
      incarnationId: incarnation.id,
      assignmentId: producer.client.assignment.id,
      assignmentEpoch: producer.client.assignment.epoch,
      turnId,
      promptOrdinal: 0,
      nodeAttemptId: randomUUID(),
      round: 2,
      participantId: "participant-original",
    };
    const expected = "é".repeat(32_769) + "original draft tail";
    const handle = await producer.client.prompt(
      producer.session.hostSessionId,
      {
        stepId: "output",
        prompt:
          'fixture-output:{"bytes":65538,"multibyte":true,"text":"original draft tail"}',
      },
      {
        admitOwner: async () => ({
          owner: { kind: "agent_turn", ref },
          logicalOperationKey: `agent_turn:consensus_draft:${turnId}:0`,
        }),
      },
    );

    await producer.client.waitForPrompt(handle, {
      signal: AbortSignal.timeout(15_000),
    });
    const [command] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, handle.commandId));

    // The default registry stays closed until S2.7 supplies its domain adapter.
    await expect(
      preparePromptOwner({
        db,
        command,
        registry: agentPromptOwners,
        signal: AbortSignal.timeout(15_000),
      }),
    ).rejects.toMatchObject({
      details: { causeCode: "agent_variant_not_implemented" },
    });
    const owners = createAgentPromptOwners({
      prepareConsensusDraft: async ({ owner, outcome, command: original }) => {
        expect(owner.ref).toEqual(ref);
        if (outcome.state !== "succeeded")
          throw new Error("fixture requires successful draft");
        let text = "";

        for await (const event of outcome.events) {
          expect(event.payload?.sourceCommandId).toBe(original.id);
          if (event.eventType === "session.update")
            text += agentMessageText(event.payload?.update) ?? "";
        }
        expect(text).toBe(expected);

        return {
          apply: async (tx) => {
            await tx.insert(runMessages).values({
              id: `${original.id}:draft-adapter`,
              runId: owner.ref.runId,
              sequence: 1_000_000,
              role: "assistant",
              content: text,
            });

            return "applied";
          },
        };
      },
    });

    await queryPrompt({ db, handle, owners });
    await queryPrompt({ db, handle, owners });
    const messages = await db
      .select()
      .from(runMessages)
      .where(eq(runMessages.id, `${command.id}:draft-adapter`));
    const [applied] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, command.id));

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe(expected);
    expect(applied.applicationState).toBe("applied");
    expect(applied.completionAppliedAt).not.toBeNull();
    await producer.client.deleteSession(producer.session.hostSessionId);
  });

  it("S2.8: domain deferral keeps the result pending without poisoning or running cleanup", async () => {
    const { db, producer, handle } = await settledOwnerFixture(
      "owner-domain-pending",
    );

    await db
      .update(runs)
      .set({ status: "NeedsInput" })
      .where(eq(runs.id, producer.runId));
    let cleanupCalls = 0;
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter("agent_turn", async ({ outcome, owner }) => {
        if (outcome.state !== "succeeded")
          throw new Error("fixture requires success");
        for await (const event of outcome.events)
          expect(event.runId).toBe(owner.ref.runId);

        return {
          apply: async (tx) => {
            const [run] = await tx
              .select({ status: runs.status })
              .from(runs)
              .where(eq(runs.id, producer.runId));

            if (run.status === "NeedsInput")
              throw new PromptOwnerDeferred("fixture_domain_pending");

            return "applied";
          },
          afterCommit: async () => {
            const [command] = await db
              .select()
              .from(executionCommands)
              .where(eq(executionCommands.id, handle.commandId));

            expect(command.applicationState).toBe("applied");
            expect(command.completionAppliedAt).not.toBeNull();
            cleanupCalls += 1;
          },
        };
      }),
    ]);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(await queryPrompt({ db, handle, owners })).toMatchObject({
        state: "pending",
      });
      const [pending] = await db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.id, handle.commandId));

      expect(pending).toMatchObject({
        applicationState: "pending",
        applicationAttempts: 0,
        completionAppliedAt: null,
      });
      expect(cleanupCalls).toBe(0);
      await db
        .update(executionCommands)
        .set({ applicationNextRetryAt: new Date(0) })
        .where(eq(executionCommands.id, handle.commandId));
    }
    await db
      .update(runs)
      .set({ status: "Running" })
      .where(eq(runs.id, producer.runId));
    expect(await queryPrompt({ db, handle, owners })).toMatchObject({
      state: "succeeded",
    });
    expect(cleanupCalls).toBe(1);
    await queryPrompt({ db, handle, owners });
    expect(cleanupCalls).toBe(1);
    await producer.client.deleteSession(producer.session.hostSessionId);
  });

  it("S2.5: rolls back domain writes and recovers an expired claim with two workers", async () => {
    const { db, producer, handle } =
      await settledOwnerFixture("owner-rollback");
    let failApply = true;
    const messageId = `${handle.commandId}:rollback`;
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter("agent_turn", async ({ outcome, owner }) => {
        if (outcome.state !== "succeeded")
          throw new Error("fixture requires success");
        for await (const event of outcome.events)
          expect(event.runId).toBe(owner.ref.runId);

        return {
          apply: async (tx) => {
            await tx.insert(runMessages).values({
              id: messageId,
              runId: owner.ref.runId,
              sequence: 1_000_000,
              role: "assistant",
              content: "applied once",
            });
            if (failApply) {
              failApply = false;
              throw new Error("owner transaction rollback fixture");
            }

            return "applied";
          },
        };
      }),
    ]);

    expect(await queryPrompt({ db, handle, owners })).toMatchObject({
      state: "pending",
    });
    const [failed] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, handle.commandId));

    expect(failed).toMatchObject({
      state: "succeeded",
      applicationState: "pending",
      applicationAttempts: 1,
      completionAppliedAt: null,
    });
    expect(
      await db.select().from(runMessages).where(eq(runMessages.id, messageId)),
    ).toHaveLength(0);
    await db
      .update(executionCommands)
      .set({
        applicationNextRetryAt: sql`clock_timestamp() - interval '1 second'`,
      })
      .where(eq(executionCommands.id, handle.commandId));
    const abandoned = await claimPromptOwner({
      db,
      owners,
      commandId: handle.commandId,
    });

    expect(abandoned).not.toBeNull();
    await db
      .update(executionCommands)
      .set({
        applicationClaimExpiresAt: sql`clock_timestamp() - interval '1 second'`,
      })
      .where(eq(executionCommands.id, handle.commandId));
    const first = startPromptOwnerWorker({ db, owners });
    const second = startPromptOwnerWorker({ db, owners });

    try {
      await expect
        .poll(
          async () => {
            const [command] = await db
              .select()
              .from(executionCommands)
              .where(eq(executionCommands.id, handle.commandId));

            return command.applicationState;
          },
          { timeout: 15_000 },
        )
        .toBe("applied");
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
    const [completed] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, handle.commandId));

    expect(completed.completionAppliedAt).not.toBeNull();
    expect(completed.applicationAttempts).toBe(1);
    expect(completed.terminalEvidenceSha256).toBe(
      failed.terminalEvidenceSha256,
    );
    expect(
      await db.select().from(runMessages).where(eq(runMessages.id, messageId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, producer.runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        ),
    ).toHaveLength(1);
    await producer.client.deleteSession(producer.session.hostSessionId);
  });

  it.each(["commit", "failure"] as const)(
    "S2.5: a stale %s cannot overwrite a successor application",
    async (lateOutcome) => {
      const { db, producer, handle } = await settledOwnerFixture(
        `owner-stale-${lateOutcome}`,
      );
      let release: () => void = () => {};
      let announce: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let preparations = 0;
      const messageId = `${handle.commandId}:stale`;
      const owners = createPromptOwnerRegistry([
        definePromptOwnerAdapter("agent_turn", async ({ outcome, owner }) => {
          if (outcome.state !== "succeeded")
            throw new Error("fixture requires success");
          for await (const event of outcome.events)
            expect(event.runId).toBe(owner.ref.runId);
          const generation = ++preparations;

          if (generation === 1) {
            announce();
            await barrier;
          }

          return {
            apply: async (tx) => {
              await tx
                .insert(runMessages)
                .values({
                  id: messageId,
                  runId: owner.ref.runId,
                  sequence: 1_000_000,
                  role: "assistant",
                  content: String(generation),
                })
                .onConflictDoUpdate({
                  target: runMessages.id,
                  set: { content: String(generation) },
                });
              if (generation === 1 && lateOutcome === "failure")
                throw new PromptOwnerInvariantError("late_failure_fixture");

              return "applied";
            },
          };
        }),
      ]);
      const claim = await claimPromptOwner({
        db,
        owners,
        commandId: handle.commandId,
      });

      if (!claim) throw new Error("fixture requires a claimed owner");
      const old = applyClaimedPromptOwner({
        db,
        owners,
        claim,
        signal: AbortSignal.timeout(15_000),
      });

      try {
        await Promise.race([held, old]);
        await db
          .update(executionCommands)
          .set({
            applicationClaimExpiresAt: sql`clock_timestamp() - interval '1 second'`,
          })
          .where(eq(executionCommands.id, handle.commandId));
        expect(await queryPrompt({ db, handle, owners })).toMatchObject({
          state: "succeeded",
        });
        release();
        expect(await old).toBe("deferred");
        const [command] = await db
          .select()
          .from(executionCommands)
          .where(eq(executionCommands.id, handle.commandId));
        const [message] = await db
          .select()
          .from(runMessages)
          .where(eq(runMessages.id, messageId));

        expect(message.content).toBe("2");
        expect(command).toMatchObject({
          applicationState: "applied",
          applicationError: null,
          applicationAttempts: 0,
        });
        expect(command.completionAppliedAt).not.toBeNull();
      } finally {
        release();
        await old;
        await producer.client.deleteSession(producer.session.hostSessionId);
      }
    },
  );

  it("S2.5: refuses owner application after only a prefix of verified output", async () => {
    const { db, producer, handle } = await settledOwnerFixture(
      "owner-output-prefix",
    );
    let applied = false;
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter("agent_turn", async ({ outcome }) => {
        if (outcome.state !== "succeeded")
          throw new Error("fixture requires success");
        for await (const event of outcome.events) {
          expect(event).toBeDefined();
          break;
        }

        return {
          apply: async () => {
            applied = true;

            return "applied";
          },
        };
      }),
    ]);

    await expect(queryPrompt({ db, handle, owners })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "prompt_owner_poisoned" },
    });
    const [command] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, handle.commandId));

    expect(applied).toBe(false);
    expect(command).toMatchObject({
      state: "succeeded",
      applicationState: "poisoned",
      completionAppliedAt: null,
    });
    await producer.client.deleteSession(producer.session.hostSessionId);
  });

  it("S2.5: renews preparation and releases only its claim on worker shutdown", async () => {
    const { db, producer, handle } = await settledOwnerFixture("owner-renewal");
    let preparing = false;
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter("agent_turn", async ({ outcome, signal }) => {
        if (outcome.state !== "succeeded")
          throw new Error("fixture requires success");
        for await (const event of outcome.events)
          expect(event.runId).toBe(producer.runId);
        preparing = true;
        await delay(60_000, undefined, { signal });
        throw new Error("preparation fixture was not aborted");
      }),
    ]);
    const recovering = startPromptOwnerWorker({ db, owners });

    try {
      await expect.poll(() => preparing, { timeout: 15_000 }).toBe(true);
      const [claimed] = await db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.id, handle.commandId));
      const initialExpiry = claimed.applicationClaimExpiresAt!.getTime();

      await expect
        .poll(
          async () => {
            const [renewed] = await db
              .select()
              .from(executionCommands)
              .where(eq(executionCommands.id, handle.commandId));

            return renewed.applicationClaimExpiresAt!.getTime();
          },
          { timeout: 15_000 },
        )
        .toBeGreaterThan(initialExpiry);
    } finally {
      await recovering.stop();
    }
    const [released] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, handle.commandId));

    expect(released).toMatchObject({
      applicationState: "pending",
      applicationClaimOwner: null,
      applicationClaimExpiresAt: null,
      applicationAttempts: 0,
      completionAppliedAt: null,
    });
    expect(recovering.health()).toEqual({ state: "stopped", reason: null });
    // Preserve the fixture's result but remove it from later worker fixtures.
    const finisher = createPromptOwnerRegistry([
      definePromptOwnerAdapter("agent_turn", async ({ outcome }) => {
        if (outcome.state === "succeeded")
          for await (const event of outcome.events)
            expect(event.runId).toBe(producer.runId);

        return { apply: async () => "superseded" };
      }),
    ]);

    await expect(
      queryPrompt({ db, handle, owners: finisher }),
    ).rejects.toMatchObject({ details: { reason: "prompt_owner_superseded" } });
    await producer.client.deleteSession(producer.session.hostSessionId);
  });

  it("S2.5: an unconfirmed shutdown release preserves the claim and reports failure", async () => {
    const { db, producer, handle } = await settledOwnerFixture(
      "owner-shutdown-failure",
    );
    const pool = new Pool({ connectionString: database.databaseUrl, max: 2 });
    const workerDb = drizzle(pool, { schema: fullSchema });
    let preparing = false;
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter("agent_turn", async ({ outcome, signal }) => {
        if (outcome.state !== "succeeded")
          throw new Error("fixture requires success");
        for await (const event of outcome.events)
          expect(event.runId).toBe(producer.runId);
        preparing = true;
        await delay(60_000, undefined, { signal });
        throw new Error("preparation fixture was not aborted");
      }),
    ]);
    const recovering = startPromptOwnerWorker({ db: workerDb, owners });

    try {
      await expect.poll(() => preparing, { timeout: 15_000 }).toBe(true);
      await pool.end();
      await expect(recovering.stop()).rejects.toThrow("pool after calling end");
      const [retained] = await db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.id, handle.commandId));

      expect(retained.applicationState).toBe("applying");
      expect(retained.applicationClaimOwner).not.toBeNull();
      expect(retained.completionAppliedAt).toBeNull();
      expect(recovering.health().state).toBe("degraded");
      await releasePromptOwnerClaim(db, {
        command: retained,
        token: retained.applicationClaimOwner!,
      });
    } finally {
      await recovering.stop().catch(() => undefined);
      if (!pool.ended) await pool.end();
      await producer.client.deleteSession(producer.session.hostSessionId);
    }
  });

  it("S2.5: unavailable output storage keeps owner application retryable without consuming failure attempts", async () => {
    const { db, producer, handle } = await settledOwnerFixture(
      "owner-storage-unavailable",
    );
    const proxy = createServer((incoming) => incoming.socket.destroy());

    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();

    if (!address || typeof address === "string")
      throw new Error("fixture requires a TCP proxy");
    const restore = useRealSupervisorUrl(`http://127.0.0.1:${address.port}`);
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter("agent_turn", async ({ outcome }) => {
        if (outcome.state === "succeeded")
          for await (const event of outcome.events)
            expect(event.runId).toBe(producer.runId);

        return { apply: async () => "applied" };
      }),
    ]);

    try {
      await expect(queryPrompt({ db, handle, owners })).rejects.toMatchObject({
        code: "EXECUTOR_UNAVAILABLE",
      });
      const [waiting] = await db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.id, handle.commandId));

      expect(waiting).toMatchObject({
        state: "succeeded",
        applicationState: "pending",
        applicationAttempts: 0,
        applicationClaimOwner: null,
        completionAppliedAt: null,
      });
    } finally {
      restore();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect(await queryPrompt({ db, handle, owners })).toMatchObject({
      state: "succeeded",
    });
    const [completed] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, handle.commandId));

    expect(completed.applicationState).toBe("applied");
    expect(completed.applicationAttempts).toBe(0);
    await producer.client.deleteSession(producer.session.hostSessionId);
  });

  it.each(["reset", "stalled_body"] as const)(
    "AT-07: %s ACK and blocked receipts past the outbound budget survive a web process restart",
    async (fault) => {
      const producer = await createSession(`unknown-admission-v2-${fault}`);
      const admitted = await admitOwnedFixturePrompt(
        producer,
        'fixture-output:{"textBytes":1200}',
      );
      const db = database.db as unknown as Db;
      const transport = defaultTransport();

      await worker.stop();
      await stopRuntimeEventConsumers();
      const attempts: string[] = [];
      const proxyErrors: Error[] = [];
      let partitioned = true;
      const processes: Array<ReturnType<typeof startPromptRecoveryProcess>> =
        [];
      const proxy = createServer((incoming, outgoing) => {
        if (
          partitioned &&
          incoming.method === "GET" &&
          incoming.url !== "/health"
        ) {
          incoming.socket.destroy();

          return;
        }
        const isPrompt =
          incoming.method === "POST" && incoming.url?.endsWith("/prompts");
        const chunks: Uint8Array[] = [];

        if (isPrompt)
          incoming.on("data", (chunk: Buffer) =>
            chunks.push(Uint8Array.from(chunk)),
          );
        const upstream = httpRequest(
          new URL(incoming.url!, supervisor.url),
          {
            method: incoming.method,
            headers: incoming.headers,
          },
          (response) => {
            if (partitioned && isPrompt) {
              response.resume();
              response.once("end", () => {
                attempts.push(Buffer.concat(chunks).toString("utf8"));
                outgoing.destroy();
              });
            } else {
              outgoing.writeHead(response.statusCode!, response.headers);
              response.pipe(outgoing);
            }
          },
        );

        upstream.on("error", (error) => {
          proxyErrors.push(error);
          outgoing.destroy();
        });
        incoming.pipe(upstream);
      });

      await new Promise<void>((resolve) =>
        proxy.listen(0, "127.0.0.1", resolve),
      );
      const address = proxy.address();

      if (!address || typeof address === "string")
        throw new Error("proxy did not bind a port");
      const restoreProxy = useRealSupervisorUrl(
        `http://127.0.0.1:${address.port}`,
      );

      try {
        const handle = await startAsyncPrompt({
          db,
          command: admitted.row,
          envelope: admitted.envelope,
          start: (envelope) =>
            transport.startPrompt(
              producer.session.hostSessionId,
              envelope as typeof admitted.envelope,
              { timeoutMs: 500 },
            ),
          lookupReceipt: (id) => transport.getCommandReceipt(id),
          sleep: async () => {},
        });

        expect(handle).toEqual({ commandId: admitted.row.id });
        const [unknown] = await db
          .select()
          .from(executionCommands)
          .where(eq(executionCommands.id, handle.commandId));

        expect(unknown).toMatchObject({
          state: "queued",
          transportState: "reconciliation_required",
          attempts: 3,
          completedAt: null,
          terminalEvidenceSha256: null,
          lastError: null,
        });
        expect(unknown.nextAttemptAt).toBeInstanceOf(Date);
        expect(attempts).toHaveLength(3);
        expect(new Set(attempts).size).toBe(1);
        expect(JSON.parse(attempts[0])).toEqual(admitted.envelope);
        expect(proxyErrors).toEqual([]);
        const firstRecovery = startPromptRecoveryProcess(
          handle.commandId,
          producer.client.host.id,
        );

        processes.push(firstRecovery);
        await expect
          .poll(() => firstRecovery.messages[0]?.state, {
            timeout: 15_000,
            message: firstRecovery.output(),
          })
          .toBe("pending");
        expect(firstRecovery.messages[0]).toMatchObject({
          commandId: handle.commandId,
          transportState: "reconciliation_required",
        });
        firstRecovery.child.kill("SIGKILL");
        await firstRecovery.exited;
        partitioned = false;
        const restarted = startPromptRecoveryProcess(
          handle.commandId,
          producer.client.host.id,
        );

        processes.push(restarted);
        await expect
          .poll(
            () =>
              restarted.messages.find(
                (message) => message.state === "completed",
              )?.result,
            { timeout: 45_000, message: restarted.output() },
          )
          .toMatchObject({ stopReason: "end_turn" });
        expect(await restarted.exited).toBe(0);
        expect(attempts).toHaveLength(3);
        startRuntimeEventConsumer({
          db,
          executionHostId: producer.client.host.id,
          transport,
        });
        worker = startProjectionWorker({ db, projectors: canonicalProjectors });
        const [settled] = await db
          .select()
          .from(executionCommands)
          .where(eq(executionCommands.id, handle.commandId));

        expect(settled).toMatchObject({
          state: "succeeded",
          transportState: "acknowledged",
          attempts: 3,
          applicationState: "pending",
          completionAppliedAt: null,
        });
        const events = await db
          .select()
          .from(executionEvents)
          .where(eq(executionEvents.runId, producer.runId));

        expect(
          events.filter(
            (event) =>
              event.eventType === "session.command" &&
              event.payload?.commandId === handle.commandId &&
              event.payload.phase === "accepted",
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) =>
              event.eventType === "session.command" &&
              event.payload?.commandId === handle.commandId &&
              event.payload.phase === "completed",
          ),
        ).toHaveLength(1);
        await producer.client.deleteSession(producer.session.hostSessionId);
      } finally {
        for (const process of processes) {
          if (
            process.child.exitCode === null &&
            process.child.signalCode === null
          )
            process.child.kill("SIGKILL");
          await process.exited;
        }
        restoreProxy();
        proxy.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          proxy.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
    90_000,
  );

  it.each([1, 3])(
    "AT-07: startup handles an unsent v2 prompt after dispatch claim %i with its frozen identity",
    async (attempts) => {
      const producer = await createSession(`unknown-before-send-${attempts}`);
      const originalMeta = { original: "immutable recovery input" };
      const admitted = await admitOwnedFixturePrompt(
        producer,
        `fixture-output:${JSON.stringify({ responseMeta: originalMeta })}`,
      );
      const db = database.db as unknown as Db;
      const transport = defaultTransport();

      // Crash after durable dispatch claim but before the transport writes bytes.
      await db
        .update(executionCommands)
        .set({
          state: "delivering",
          attempts,
          transportState: "dispatching",
          deliveringSince: new Date(0),
        })
        .where(eq(executionCommands.id, admitted.row.id));
      const recovered = await recoverExecutionCommands({ db, graceMs: 0 });

      expect(recovered.errors).toEqual([]);
      if (attempts === 3) {
        expect(await transport.getCommandReceipt(admitted.row.id)).toBeNull();
        const rearmed = await rearmPromptAdmission(db, {
          commandId: admitted.row.id,
          requestSha256: admitted.row.requestSha256!,
          expectedAttempts: 3,
          expectedMaxAttempts: 3,
        });

        expect(rearmed.changed).toBe(true);
        expect(
          (await recoverExecutionCommands({ db, graceMs: 0 })).errors,
        ).toEqual([]);
      } else expect(recovered.redelivered).toBeGreaterThanOrEqual(1);
      await expect(
        waitForPromptCompletion({
          db,
          handle: { commandId: admitted.row.id },
          lookupReceipt: (id) => transport.getCommandReceipt(id),
          signal: AbortSignal.timeout(15_000),
        }),
      ).resolves.toMatchObject({ stopReason: "end_turn" });
      const output = await readPromptOutput({
        db,
        commandId: admitted.row.id,
        signal: AbortSignal.timeout(15_000),
      });

      for await (const event of output.events)
        expect(event.runId).toBe(producer.runId);
      expect(output.response).toEqual({
        stopReason: "end_turn",
        _meta: originalMeta,
      });
      const [row] = await db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.id, admitted.row.id));

      expect(row).toMatchObject({
        attempts: attempts + 1,
        requestSha256: admitted.row.requestSha256,
        requestCanonicalJson: admitted.row.requestCanonicalJson,
        createdAt: admitted.row.createdAt,
      });
      await producer.client.deleteSession(producer.session.hostSessionId);
    },
  );

  it("AT-07: delivery ignores a changed caller payload and verifies the stored v2 request again", async () => {
    const producer = await createSession("unknown-frozen-retry");
    const originalMeta = { original: "frozen delivery input" };
    const admitted = await admitOwnedFixturePrompt(
      producer,
      `fixture-output:${JSON.stringify({ responseMeta: originalMeta })}`,
    );
    const db = database.db as unknown as Db;
    const transport = defaultTransport();
    const handle = await startAsyncPrompt({
      db,
      command: admitted.row,
      envelope: {
        ...admitted.envelope,
        payload: { stepId: "output", prompt: "mutated after admission" },
      },
      start: (envelope) => {
        expect(envelope).toEqual(admitted.envelope);

        return transport.startPrompt(
          producer.session.hostSessionId,
          envelope as typeof admitted.envelope,
        );
      },
      lookupReceipt: (id) => transport.getCommandReceipt(id),
    });

    await waitForPromptCompletion({
      db,
      handle,
      lookupReceipt: (id) => transport.getCommandReceipt(id),
      signal: AbortSignal.timeout(15_000),
    });
    const output = await readPromptOutput({
      db,
      commandId: handle.commandId,
      signal: AbortSignal.timeout(15_000),
    });

    for await (const event of output.events)
      expect(event.runId).toBe(producer.runId);
    expect(output.response).toEqual({
      stopReason: "end_turn",
      _meta: originalMeta,
    });
    await producer.client.deleteSession(producer.session.hostSessionId);
  });

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
