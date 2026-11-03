import type { Db } from "@/lib/execution-host/db";
import type { RunResultContract } from "@/lib/run-results/types";
import type { BoundClient } from "@/lib/execution-host/client";
import type { AgentTurn } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq, and, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  prepareAgentRunFinalization,
  prepareUndispatchedAgentFailure,
} from "@/lib/agents/finalization";
import { RUN_SETTLED_EVENT_KINDS } from "@/lib/domain-events/taxonomy";
import { agentWorkdirPath } from "@/lib/agents/workspace-paths";
import {
  agentTurns,
  executionCommands,
  domainEvents,
  projects,
  runResults,
  runSessions,
  runs,
  runSessionIncarnations,
} from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  mintAssignment,
  releaseAssignmentForRun,
} from "@/lib/execution-host/assignments";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import { admitAgentGenerationTurn } from "@/lib/agents/generation-turn";
import { settleAgentCreateFailure } from "@/lib/agents/create-failure";
import { MaisterError } from "@/lib/errors";
import { UNKNOWN_OUTCOME_DETAIL } from "@/lib/execution-host/contracts";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { normalizeCommandReceiptV2 } from "@/lib/execution-host/command-receipt";
import { recoverExecutionCommands } from "@/lib/execution-host/recovery";
import { retireEligibleCommands } from "@/lib/execution-host/retirement";
import { getAgentRetryOptions } from "@/lib/agents/retry";
import { freshQualificationSafetyReason } from "@/lib/agents/retry-guards";
import { operationalTerminalDecision } from "@/lib/agents/operational-completion";
import {
  admitAgentTurnPrompt,
  waitForAgentPrompt,
} from "@/lib/agents/prompt-owner";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import {
  casTransition,
  claimDelivering,
  requeueDelivering,
} from "@/lib/execution-host/commands";

let database: StartedPostgresTestDb;
let db: Db;
let directory: string;
const originalWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;

const contract: RunResultContract = {
  kind: "agent_profile",
  profileName: "research",
  schemaRef: "fixture@abcdef123456:research-result.v1",
  schemaVersion: 1,
  sha256: "f".repeat(64),
  required: true,
  schema: {
    schemaVersion: 1,
    fields: [{ name: "summary", type: "string", required: true }],
  },
  sourceFlowRevisionId: "rev-1",
};
const finalText = '```json maister:output\n{"summary":"original result"}\n```';

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "agent_finalization_transaction",
  });
  db = database.db as unknown as Db;
  directory = await mkdtempReal("agent-finalization-");
  process.env.MAISTER_WORKTREES_ROOT = directory;
}, 180_000);

afterAll(async () => {
  if (originalWorktreesRoot === undefined)
    delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = originalWorktreesRoot;
  await database?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function seedRun(): Promise<{ runId: string; marker: string }> {
  const projectId = randomUUID();
  const runId = randomUUID();
  const slug = `p-${projectId.slice(0, 8)}`;
  const repoPath = path.join(directory, `repo-${projectId}`);

  await mkdir(repoPath);
  await db.insert(projects).values({
    id: projectId,
    slug,
    name: "Finalization fixture",
    taskKey: `T${projectId.replaceAll("-", "").slice(0, 7)}`.toUpperCase(),
    repoPath,
    maisterYamlPath: path.join(repoPath, "maister.yaml"),
  });
  await db.insert(runs).values({
    id: runId,
    runKind: "agent",
    projectId,
    status: "Running",
    flowVersion: "agent",
    flowRevision: "manual",
    agentWorkspace: "none",
    resultContract: contract,
  });
  const cwd = agentWorkdirPath(slug, runId);
  const marker = path.join(cwd, "KEEP");

  await mkdir(cwd, { recursive: true });
  await writeFile(marker, "uncommitted work");

  return { runId, marker };
}

async function readOutcome(runId: string): Promise<{
  status: string;
  results: number;
  events: number;
}> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const results = await db
    .select()
    .from(runResults)
    .where(eq(runResults.runId, runId));
  const events = await db
    .select()
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.runId, runId),
        inArray(domainEvents.kind, [...RUN_SETTLED_EVENT_KINDS]),
      ),
    );

  return { status: run.status, results: results.length, events: events.length };
}

async function operationalGeneration(): Promise<
  Awaited<ReturnType<typeof fakeExecutionHosts>> &
    Readonly<{ runId: string; client: BoundClient; turn: AgentTurn }>
> {
  const { hosts, fake } = await fakeExecutionHosts(db);
  const runId = await seedAgentRun(db, {
    runtimeRoot: directory,
    definition:
      "---\nname: Operator\ndescription: controlled rejected create\nkind: operational\ncompletion: {contract: operational_v1}\nmode: session\nworkspace: none\ntriggers: [manual]\nrisk_tier: read_only\nplatform_mcp: false\n---\nPerform the controlled operation.",
    workspace: "none",
    resultContract: null,
    operational: true,
  });
  const client = await hosts.forRun(runId);
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const taskId = randomUUID();

  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES($1,$2,1,'Controlled operation','Inspect the original host execution')",
    [taskId, run.projectId],
  );
  await db.update(runs).set({ taskId }).where(eq(runs.id, runId));
  const turn = await db.transaction((tx) =>
    admitAgentGenerationTurn(tx, {
      runId,
      assignmentId: client.assignment.id,
      variant: "initial",
      prompt: "Perform the controlled operation.",
    }),
  );

  return {
    hosts,
    fake,
    hostId: client.host.id,
    host: client.host,
    assignment: client.assignment,
    runId,
    client,
    turn,
  };
}

async function operationalRetryOptions(
  runId: string,
): Promise<Awaited<ReturnType<typeof getAgentRetryOptions>>> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const [session] = await db
    .select()
    .from(runSessions)
    .where(eq(runSessions.runId, runId));
  const userId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES($1,$2,'member','active',false)",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), run.projectId, userId],
  );
  await database.pool.query(
    "INSERT INTO platform_runtime_settings(id,default_runner_id) VALUES('singleton',$1) ON CONFLICT(id) DO UPDATE SET default_runner_id=excluded.default_runner_id",
    [session.runnerId],
  );

  return getAgentRetryOptions(db, runId, userId);
}

describe("Agent terminal application transaction", () => {
  it("defers readiness with a monotonic claim and unchanged wire budget, then posts the same owned create", async () => {
    const {
      client: original,
      turn,
      fake,
      runId,
    } = await operationalGeneration();
    const previousUrl = process.env.MAISTER_SUPERVISOR_URL;
    let ready = false;
    let unresolvedOwner = false;
    const postedIds: string[] = [];
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        if (unresolvedOwner) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              code: "EXECUTOR_UNAVAILABLE",
              message: "Original native process owner remains unconfirmed",
              details: { reason: "session_process_owner_unconfirmed" },
            }),
          );

          return;
        }
        if (ready)
          response.setHeader("X-Maister-Session-Ownership-Version", "1");
        response.writeHead(200, { "content-type": "application/json" });
        response.end("[]");

        return;
      }
      const bytes: Buffer[] = [];

      request.on("data", (chunk: Buffer) => bytes.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(bytes).toString("utf8")) as {
          command: { id: string };
        };

        postedIds.push(body.command.id);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            sessionId: "readiness-session",
            acpSessionId: "readiness-acp",
            pid: 1234,
          }),
        );
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();

    if (!address || typeof address === "string")
      throw new Error("Readiness fixture has no port");
    process.env.MAISTER_SUPERVISOR_URL = `http://127.0.0.1:${address.port}`;
    try {
      fake.failOnce(
        "createSession",
        new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          "Earlier wire outcome is unknown",
          { details: { transport: UNKNOWN_OUTCOME_DETAIL } },
        ),
      );
      const owner = {
        variant: "agent" as const,
        turnId: turn.id,
        promptOrdinal: turn.ordinal,
      };

      await expect(
        original.createOwnedSession(owner, async () => ({
          stepId: "agent",
          executor: { agent: "claude", model: "mock" },
        })),
      ).rejects.toBeInstanceOf(MaisterError);
      const [initial] = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.create"),
          ),
        );
      const budget = initial.maxAttempts - initial.attempts;
      const wire = createLocalDirectTransport();
      const client = await createExecutionHosts({
        db,
        transport: {
          ...fake.transport,
          createSession: (envelope, options) =>
            wire.createSession(envelope, options),
        },
      }).forAssignment(original.assignment);

      for (let index = 0; index < 2; index += 1) {
        unresolvedOwner = index === 1;
        await db
          .update(executionCommands)
          .set({ nextAttemptAt: null })
          .where(eq(executionCommands.id, initial.id));
        await expect(
          client.createOwnedSession(owner, async () => {
            throw new Error("Readiness must retain its stored request");
          }),
        ).rejects.toBeInstanceOf(MaisterError);
        const [deferred] = await db
          .select()
          .from(executionCommands)
          .where(eq(executionCommands.id, initial.id));

        expect(deferred.state).toBe("queued");
        expect(deferred.maxAttempts - deferred.attempts).toBe(budget);
        expect(deferred.lastError).toMatchObject({
          details: {
            transport: UNKNOWN_OUTCOME_DETAIL,
            managerReadiness: {
              reason: "session_inventory_pending",
              sourceReason:
                index === 0
                  ? "session_inventory_unproven"
                  : "session_process_owner_unconfirmed",
              createPostSent: false,
            },
          },
        });
        expect(postedIds).toHaveLength(0);
      }
      const [before] = await db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.id, initial.id));

      expect(
        (await claimDelivering(db, initial.id, before.attempts)).changed,
      ).toBe(true);
      const stale = await casTransition(
        db,
        initial.id,
        ["delivering"],
        before.attempts,
        { state: "queued", maxAttempts: before.maxAttempts + 1 },
      );

      expect(stale.changed).toBe(false);
      expect(stale.row?.maxAttempts).toBe(before.maxAttempts);
      await requeueDelivering(db, initial.id);
      ready = true;
      unresolvedOwner = false;
      await db
        .update(executionCommands)
        .set({ nextAttemptAt: null })
        .where(eq(executionCommands.id, initial.id));
      await expect(
        client.createOwnedSession(owner, async () => {
          throw new Error("Readiness must not mint a new generation");
        }),
      ).resolves.toMatchObject({ sessionId: "readiness-session" });
      expect(postedIds).toEqual([initial.id]);
      expect(
        await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, runId),
              eq(executionCommands.kind, "session.create"),
            ),
          ),
      ).toHaveLength(1);
    } finally {
      if (previousUrl === undefined) delete process.env.MAISTER_SUPERVISOR_URL;
      else process.env.MAISTER_SUPERVISOR_URL = previousUrl;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("guards an unproven CHECKPOINT from the second generic create after a proven readoption", async () => {
    const { client, fake } = await operationalGeneration();
    const workspaceId = await client.ensureWorkspace();
    const remove = fake.onCall("createSession", async () => {
      remove();
      await client.releaseWorkspace(workspaceId);
    });

    fake.setCanonicalEventSink(async () => {
      throw new MaisterError(
        "CHECKPOINT",
        "Controlled post-spawn session restoration failed",
        { details: { httpStatus: 422 } },
      );
    });
    await expect(
      client.createSession({
        stepId: "agent",
        executor: { agent: "claude", model: "mock" },
      }),
    ).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      details: { reason: "session_create_quiescence_unproven" },
    });
    expect(fake.callsOf("createSession")).toHaveLength(2);
    expect(
      [...fake.sessions.values()].filter(
        (session) => session.status === "live",
      ),
    ).toHaveLength(1);
  });

  it("preserves a proven rejected create after its same owner re-adopts, prompts and reaches a terminal session", async () => {
    const { runId, client, turn, fake } = await operationalGeneration();
    const workspaceId = await client.ensureWorkspace();
    const remove = fake.onCall("createSession", async () => {
      remove();
      await client.releaseWorkspace(workspaceId);
    });
    const session = await client.createOwnedSession(
      { variant: "agent", turnId: turn.id, promptOrdinal: turn.ordinal },
      async () => ({
        stepId: "agent",
        executor: { agent: "claude", model: "mock" },
      }),
    );
    const creates = await db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, runId),
          eq(executionCommands.kind, "session.create"),
        ),
      );

    expect(creates).toHaveLength(2);
    expect(creates.find((command) => command.state === "failed")).toMatchObject(
      {
        receiptEvidence: {
          body: {
            details: {
              sessionCreateQuiescence: { version: 1, process: "not_started" },
            },
          },
        },
      },
    );
    const prompt = await client.prompt(
      session.sessionId,
      { stepId: "agent", prompt: turn.prompt },
      {
        admitOwner: (tx) =>
          admitAgentTurnPrompt(tx, client, session.sessionId, turn.id),
      },
    );

    await expect
      .poll(() => fake.receipts.get(prompt.commandId)?.phase, {
        timeout: 4_000,
      })
      .toBe("completed");
    await client.deleteSession(session.sessionId);
    await waitForAgentPrompt(
      db,
      client,
      prompt.commandId,
      AbortSignal.timeout(4_000),
    );
    const [source] = await db.select().from(runs).where(eq(runs.id, runId));
    const [applied] = await db
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.id, turn.id));

    expect(source.status).toBe("Failed");
    expect(applied).toMatchObject({
      state: "applied",
      commandId: prompt.commandId,
    });
    expect(await freshQualificationSafetyReason(db, source)).toBeNull();
  });

  it("settles an operational generation after its actual host-rejected create without inventing a session lifecycle", async () => {
    const { runId, client, turn, fake, hosts } = await operationalGeneration();

    await expect(
      client.createOwnedSession(
        { variant: "agent", turnId: turn.id, promptOrdinal: turn.ordinal },
        async () => ({
          stepId: "host-refuses/invalid-segment",
          executor: { agent: "claude", model: "mock" },
        }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    const [command] = await db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, runId),
          eq(executionCommands.kind, "session.create"),
        ),
      );

    expect(command).toMatchObject({
      state: "failed",
      receiptEvidence: {
        phase: "rejected",
        inflight: false,
        kind: "session.create",
        runId,
        assignmentEpoch: client.assignment.epoch,
        body: {
          details: {
            sessionCreateQuiescence: { version: 1, process: "not_started" },
          },
        },
      },
    });
    expect(
      await db
        .select()
        .from(runSessionIncarnations)
        .where(eq(runSessionIncarnations.runId, runId)),
    ).toHaveLength(0);
    expect(fake.callsOf("sendPrompt")).toHaveLength(0);
    expect(await settleAgentCreateFailure(db, client, turn)).toBe(true);
    expect((await readOutcome(runId)).status).toBe("Failed");
    expect(await operationalRetryOptions(runId)).toMatchObject({
      eligible: true,
      reason: null,
    });
    for (const mutation of [
      "create_intent=jsonb_set(create_intent,'{sessionFallback}','true'::jsonb)",
      "request_canonical_json='{}'",
      'payload=\'{"stepId":"silently-changed"}\'::jsonb',
      "create_intent=NULL,retired_at=clock_timestamp()",
    ])
      await expect(
        database.pool.query(
          `UPDATE execution_commands SET ${mutation} WHERE id=$1`,
          [command.id],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "execution_commands_immutable_create_intent",
      });
    await db
      .update(executionCommands)
      .set({ completedAt: new Date(Date.now() - 30 * 86_400_000) })
      .where(eq(executionCommands.id, command.id));
    const retired = await retireEligibleCommands({ db, hosts });

    expect(retired.retired).toBeGreaterThanOrEqual(1);
    const [tombstone] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, command.id));

    expect(tombstone).toMatchObject({
      state: "failed",
      createIntent: null,
      retiredAt: expect.any(Date),
      payload: {},
    });
    expect(
      fake.callsOf("retireCommand").some((call) => call.args[0] === command.id),
    ).toBe(true);
  });

  it.each(["V2", "unsettled V1"] as const)(
    "retains an accepted %s create without inferring a lost process",
    async (format) => {
      const { runId, client, turn, fake } = await operationalGeneration();

      fake.setCanonicalEventSink(async () => {
        throw new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          "Controlled post-spawn outcome is unknown",
          { details: { transport: UNKNOWN_OUTCOME_DETAIL } },
        );
      });
      const owner = {
        variant: "agent" as const,
        turnId: turn.id,
        promptOrdinal: turn.ordinal,
      };

      await expect(
        client.createOwnedSession(owner, async () => ({
          stepId: "agent",
          executor: { agent: "claude", model: "mock" },
        })),
      ).rejects.toBeInstanceOf(MaisterError);
      const [command] = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.create"),
          ),
        );

      await db
        .update(executionCommands)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(executionCommands.id, command.id));
      const transport = {
        ...fake.transport,
        async getCommandReceipt(commandId: string) {
          const receipt = await fake.transport.getCommandReceipt(commandId);

          if (!receipt || receipt.kind !== "session.create") return receipt;
          if (format === "unsettled V1")
            return {
              ...receipt,
              body: {
                code: "EXECUTOR_UNAVAILABLE",
                message: "Original create process exit is unconfirmed",
                details: { reason: "session_create_exit_unconfirmed" },
              },
            };

          return normalizeCommandReceiptV2({
            receiptVersion: 2,
            commandId: receipt.commandId,
            kind: receipt.kind,
            hostKey: client.host.hostKey,
            runId,
            assignmentId: client.assignment.id,
            assignmentEpoch: client.assignment.epoch,
            hostSessionId: null,
            requestSchema: "maister.command.request.v2",
            requestSha256: command.createIntent?.requestSha256,
            phase: "accepted",
            httpStatus: 202,
            receivedAt: receipt.receivedAt,
            terminal: null,
          });
        },
      };
      const recovered = await createExecutionHosts({
        db,
        transport,
      }).forAssignment(client.assignment);

      await recoverExecutionCommands({ db, transport, graceMs: 0 });
      const [afterRecovery] = await db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.id, command.id));

      expect(afterRecovery).toMatchObject({ state: "queued" });

      await expect(
        recovered.createOwnedSession(owner, async () => {
          throw new Error(
            "Accepted create must retain its original command without resolving a replacement",
          );
        }),
      ).rejects.toMatchObject({
        details: { reason: "session_create_pending" },
      });
      const commands = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.create"),
          ),
        );

      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ id: command.id, state: "queued" });
      expect(fake.callsOf("createSession")).toHaveLength(1);
    },
  );

  it("retains an unknown create outcome and an actually created session for reconciliation", async () => {
    const unknown = await operationalGeneration();

    unknown.fake.setCanonicalEventSink(async () => {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "Controlled post-spawn outcome is unknown",
        { details: { transport: UNKNOWN_OUTCOME_DETAIL } },
      );
    });
    await expect(
      unknown.client.createOwnedSession(
        {
          variant: "agent",
          turnId: unknown.turn.id,
          promptOrdinal: unknown.turn.ordinal,
        },
        async () => ({
          stepId: "agent",
          executor: { agent: "claude", model: "mock" },
        }),
      ),
    ).rejects.toBeInstanceOf(MaisterError);
    expect(
      await db
        .select()
        .from(runSessionIncarnations)
        .where(eq(runSessionIncarnations.runId, unknown.runId)),
    ).toHaveLength(0);
    expect(
      [...unknown.fake.receipts.values()].find(
        (receipt) => receipt.kind === "session.create",
      ),
    ).toMatchObject({ phase: "accepted", completedAt: null });
    await expect(
      settleAgentCreateFailure(db, unknown.client, unknown.turn),
    ).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      details: { reason: "agent_execution_quiescence_unproven" },
    });
    expect((await readOutcome(unknown.runId)).status).toBe("Running");

    const created = await operationalGeneration();

    const session = await created.client.createOwnedSession(
      {
        variant: "agent",
        turnId: created.turn.id,
        promptOrdinal: created.turn.ordinal,
      },
      async () => ({
        stepId: "agent",
        executor: { agent: "claude", model: "mock" },
      }),
    );

    expect(
      await db
        .select()
        .from(runSessionIncarnations)
        .where(eq(runSessionIncarnations.runId, created.runId)),
    ).toHaveLength(1);
    await expect(
      settleAgentCreateFailure(db, created.client, created.turn),
    ).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      details: { reason: "agent_execution_quiescence_unproven" },
    });
    expect((await readOutcome(created.runId)).status).toBe("Running");
    await created.client.deleteSession(session.sessionId);
    const failed = await prepareAgentRunFinalization(created.runId, "Failed", {
      db,
      reason: "controlled_session_failure",
    });

    await db.transaction(failed.apply);
    const [terminal] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, created.runId));

    expect(terminal.status).toBe("Failed");
    expect(await freshQualificationSafetyReason(db, terminal)).toBeNull();
  });

  it("refuses historical unstamped rejected receipts even when their host inventory is empty", async () => {
    const {
      runId,
      client: originalClient,
      turn,
      fake,
    } = await operationalGeneration();
    const transport = {
      ...fake.transport,
      async getCommandReceipt(commandId: string) {
        const receipt = await fake.transport.getCommandReceipt(commandId);

        if (!receipt || receipt.kind !== "session.create") return receipt;
        const details = receipt.body.details;
        const historicalDetails =
          details && typeof details === "object" && !Array.isArray(details)
            ? Object.fromEntries(
                Object.entries(details).filter(
                  ([key]) => key !== "sessionCreateQuiescence",
                ),
              )
            : {};

        return {
          ...receipt,
          body: { ...receipt.body, details: historicalDetails },
        };
      },
    };
    const client = await createExecutionHosts({ db, transport }).forAssignment(
      originalClient.assignment,
    );

    await expect(
      client.createOwnedSession(
        { variant: "agent", turnId: turn.id, promptOrdinal: turn.ordinal },
        async () => ({
          stepId: "host-refuses/invalid-segment",
          executor: { agent: "claude", model: "mock" },
        }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    const [command] = await db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, runId),
          eq(executionCommands.kind, "session.create"),
        ),
      );

    expect(command).toMatchObject({
      state: "failed",
      receiptEvidence: { phase: "rejected", inflight: false },
    });
    expect(command.receiptEvidence?.body.details).not.toHaveProperty(
      "sessionCreateQuiescence",
    );
    expect(fake.sessions.size).toBe(0);
    await expect(
      settleAgentCreateFailure(db, client, turn),
    ).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      details: { reason: "agent_execution_quiescence_unproven" },
    });
    expect((await readOutcome(runId)).status).toBe("Running");
    // Compatibility fixture for a historical terminal row: preserve its actual
    // unstamped command receipt, which the current finalizer refuses to create.
    const terminal = operationalTerminalDecision({
      requested: "Failed",
      result: { kind: "none" },
      integrity: {
        verdict: "indeterminate",
        reasonCodes: ["operational_baseline_missing"],
        changedPaths: [],
      },
    });

    await db.transaction(async (tx) => {
      await tx
        .update(runs)
        .set({
          status: "Failed",
          endedAt: new Date(),
          operationalTerminal: {
            ...terminal,
            baselineGeneration: null,
            resultRevision: null,
            evidenceIds: [],
          },
        })
        .where(eq(runs.id, runId));
      await releaseAssignmentForRun(tx, runId, "historical_failure_fixture");
    });
    expect(await operationalRetryOptions(runId)).toMatchObject({
      eligible: false,
      reason: "reconciliation_required",
    });
    const [historical] = await db.select().from(runs).where(eq(runs.id, runId));

    expect(await freshQualificationSafetyReason(db, historical)).toBe(
      "reconciliation_required",
    );
  });

  it("does not apply a rejected create from a superseded assignment to its successor", async () => {
    const { runId, client, turn } = await operationalGeneration();

    await expect(
      client.createOwnedSession(
        { variant: "agent", turnId: turn.id, promptOrdinal: turn.ordinal },
        async () => ({
          stepId: "host-refuses/invalid-segment",
          executor: { agent: "claude", model: "mock" },
        }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    const successor = await db.transaction((tx) =>
      mintAssignment(tx, { runId, hostId: client.host.id, reason: "recover" }),
    );

    await expect(
      settleAgentCreateFailure(db, client, turn),
    ).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      details: { reason: "agent_execution_quiescence_unproven" },
    });
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));

    expect(run).toMatchObject({
      status: "Running",
      executionAssignmentId: successor.id,
    });
    const [originalTurn] = await db
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.id, turn.id));

    expect(originalTurn).toMatchObject({
      executionAssignmentId: client.assignment.id,
      commandId: null,
      state: "claimed",
    });
  });

  it("IT-UX-13 settles a known Pending preparation failure and refuses a live session", async () => {
    const pending = await seedRun();

    await database.pool.query("UPDATE runs SET status='Pending' WHERE id=$1", [
      pending.runId,
    ]);
    const prepared = await prepareUndispatchedAgentFailure(pending.runId, {
      db,
      reason: "agent_workspace_prepare_failed",
    });

    expect(await db.transaction(prepared.apply)).toMatchObject({
      finalized: true,
      status: "Failed",
    });
    expect((await readOutcome(pending.runId)).status).toBe("Failed");
    const live = await seedRun();

    await db.insert(runSessions).values({
      id: randomUUID(),
      runId: live.runId,
      sessionName: "default",
      acpSessionId: "live-session",
    });
    const unsafe = await prepareUndispatchedAgentFailure(live.runId, {
      db,
      reason: "agent_dispatch_failed",
    });

    expect(await db.transaction(unsafe.apply)).toEqual({ finalized: false });
    expect((await readOutcome(live.runId)).status).toBe("Running");
    const uncertain = await seedRun();
    const { hostId } = await fakeExecutionHosts(db);
    const assignment = await db.transaction((tx) =>
      mintAssignment(tx, { runId: uncertain.runId, hostId, reason: "launch" }),
    );

    await db.insert(executionCommands).values({
      id: randomUUID(),
      runId: uncertain.runId,
      executionAssignmentId: assignment.id,
      executionHostId: hostId,
      assignmentEpoch: assignment.epoch,
      kind: "session.create",
      maxAttempts: 3,
      transportState: "unknown",
    });
    const uncertainFailure = await prepareUndispatchedAgentFailure(
      uncertain.runId,
      { db, reason: "agent_dispatch_failed" },
    );

    expect(await db.transaction(uncertainFailure.apply)).toEqual({
      finalized: false,
    });
    expect((await readOutcome(uncertain.runId)).status).toBe("Running");
    const raced = await seedRun();

    await database.pool.query("UPDATE runs SET status='Pending' WHERE id=$1", [
      raced.runId,
    ]);
    const raceFailure = await prepareUndispatchedAgentFailure(raced.runId, {
      db,
      reason: "agent_dispatch_failed",
    });

    await Promise.all([
      database.pool.query(
        "UPDATE runs SET status='Running' WHERE id=$1 AND status='Pending'",
        [raced.runId],
      ),
      db.transaction(raceFailure.apply),
    ]);
    expect((await readOutcome(raced.runId)).status).toBe("Failed");
  });

  it("IT-UX-02 IT-UX-03 creates one episode with terminal facts and rolls both back together", async () => {
    const first = await seedRun();
    const [bound] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, first.runId));
    const second = await seedRun();

    await database.pool.query("UPDATE runs SET project_id=$2 WHERE id=$1", [
      second.runId,
      bound.projectId,
    ]);
    for (const runId of [first.runId, second.runId]) {
      await database.pool.query(
        "UPDATE runs SET source_agent_id='fixture:triager',launched_at=now(),activity_sort_at=now(),activity_timestamp_provenance='launch' WHERE id=$1",
        [runId],
      );
    }
    const prepared = await prepareAgentRunFinalization(first.runId, "Failed", {
      db,
      reason: "agent_session_create_failed",
    });
    const abort = new Error("roll back terminal and incident");

    await expect(
      db.transaction(async (tx) => {
        await prepared.apply(tx);
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM agent_incident_occurrences WHERE original_run_id=$1",
          [first.runId],
        )
      ).rows[0].n,
    ).toBe(0);
    await db.transaction(prepared.apply);
    const next = await prepareAgentRunFinalization(second.runId, "Failed", {
      db,
      reason: "agent_session_create_failed",
    });

    await db.transaction(next.apply);
    await db.transaction(next.apply);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM agent_incident_episodes WHERE project_id=$1",
          [bound.projectId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM agent_incident_occurrences WHERE original_run_id=ANY($1::text[])",
          [[first.runId, second.runId]],
        )
      ).rows[0].n,
    ).toBe(2);
  });

  it("refuses a transaction connection as the preparation and cleanup connection", async () => {
    const { runId, marker } = await seedRun();

    await db.transaction(async (tx) => {
      await expect(
        prepareAgentRunFinalization(runId, "Done", { db: tx, finalText }),
      ).rejects.toMatchObject({
        code: "PRECONDITION",
        details: { reason: "agent_finalization_requires_pooled_db" },
      });
    });
    expect(await readOutcome(runId)).toEqual({
      status: "Running",
      results: 0,
      events: 0,
    });
    expect(await readFile(marker, "utf8")).toBe("uncommitted work");
  });

  it("outer rollback reverts the result and events and preserves the directory", async () => {
    const { runId, marker } = await seedRun();
    const prepared = await prepareAgentRunFinalization(runId, "Done", {
      db,
      finalText,
    });
    const rollback = new Error("rollback the outer command application");

    await expect(
      db.transaction(async (tx) => {
        const result = await prepared.apply(tx);

        expect(result).toMatchObject({ finalized: true, status: "Done" });
        await expect(prepared.afterCommit(result)).rejects.toMatchObject({
          code: "PRECONDITION",
          details: { reason: "agent_finalization_commit_unconfirmed" },
        });
        expect(await readFile(marker, "utf8")).toBe("uncommitted work");
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await readOutcome(runId)).toEqual({
      status: "Running",
      results: 0,
      events: 0,
    });
    expect(await readFile(marker, "utf8")).toBe("uncommitted work");

    const committed = await db.transaction(prepared.apply);

    expect(await readFile(marker, "utf8")).toBe("uncommitted work");
    await prepared.afterCommit(committed);
    expect(await readOutcome(runId)).toEqual({
      status: "Done",
      results: 1,
      events: 1,
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // A turn bound to the run's generation, as a claim leaves it (the state
  // check refuses a claimed turn without its assignment and session).
  async function claimedTurn(
    runId: string,
    input: { ordinal: number; variant: "live_message" },
  ): Promise<string> {
    const { hostId } = await fakeExecutionHosts(db);
    const assignment = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
    );
    const runSessionId = randomUUID();
    const id = randomUUID();

    await db.insert(runSessions).values({
      id: runSessionId,
      runId,
      sessionName: `s-${input.ordinal}`,
      executionAssignmentId: assignment.id,
    });
    await db.insert(agentTurns).values({
      id,
      runId,
      ordinal: input.ordinal,
      variant: input.variant,
      logicalKey: `${input.variant}:${id}`,
      prompt: "work",
      state: "claimed",
      executionAssignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      runSessionId,
    });

    return id;
  }

  async function turnStates(runId: string) {
    return Object.fromEntries(
      (
        await db
          .select({ id: agentTurns.id, state: agentTurns.state })
          .from(agentTurns)
          .where(eq(agentTurns.runId, runId))
      ).map((row) => [row.id, row.state]),
    );
  }

  // D-M1 (ADR-182): a message behind the ending turn can never be dispatched
  // once the run is terminal, so the finalization closes it in its OWN
  // transaction — a rollback must leave it queued, a commit superseded. A
  // message claimed as the run's active turn but never dispatched is closed
  // too: its admission refuses a superseded turn.
  it("a Crashed finalization supersedes undispatched messages atomically with the status flip", async () => {
    const { runId } = await seedRun();
    const claimed = await claimedTurn(runId, {
      ordinal: 1,
      variant: "live_message",
    });
    const queued = randomUUID();

    await db.insert(agentTurns).values({
      id: queued,
      runId,
      ordinal: 2,
      variant: "live_message",
      logicalKey: `message:auto:${queued}`,
      prompt: "also this",
      state: "queued",
    });
    const prepared = await prepareAgentRunFinalization(runId, "Crashed", {
      db,
      reason: "agent_turn_lost",
    });
    const rollback = new Error("rollback");

    await expect(
      db.transaction(async (tx) => {
        await prepared.apply(tx);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await turnStates(runId)).toEqual({
      [claimed]: "claimed",
      [queued]: "queued",
    });

    const committed = await db.transaction(prepared.apply);

    expect(committed).toMatchObject({ finalized: true, status: "Crashed" });
    const [crashed] = await db
      .select({ payload: domainEvents.payload })
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.runId, runId),
          inArray(domainEvents.kind, [...RUN_SETTLED_EVENT_KINDS]),
        ),
      );

    // B6: a token reason is the cause's reason; an agent crash is CRASH.
    expect(crashed.payload.cause).toEqual({
      code: "CRASH",
      reason: "agent_turn_lost",
      source: "agent",
    });
    expect(await turnStates(runId)).toEqual({
      [claimed]: "superseded",
      [queued]: "superseded",
    });
  });

  // `CLOSES_MESSAGE_TURNS` marks `Done` too: a finished run dispatches
  // nothing either.
  it("a Done finalization supersedes a queued message as well", async () => {
    const { runId } = await seedRun();
    const queued = randomUUID();

    await db.insert(agentTurns).values({
      id: queued,
      runId,
      ordinal: 1,
      variant: "live_message",
      logicalKey: `message:auto:${queued}`,
      prompt: "one more thing",
      state: "queued",
    });
    const prepared = await prepareAgentRunFinalization(runId, "Done", {
      db,
      finalText,
    });

    await expect(db.transaction(prepared.apply)).resolves.toMatchObject({
      finalized: true,
      status: "Done",
    });
    expect(await turnStates(runId)).toEqual({ [queued]: "superseded" });
  });

  it("refuses a result contract changed after preparation", async () => {
    const { runId, marker } = await seedRun();
    const prepared = await prepareAgentRunFinalization(runId, "Done", {
      db,
      finalText,
    });

    await db
      .update(runs)
      .set({ resultContract: { ...contract, sha256: "a".repeat(64) } })
      .where(eq(runs.id, runId));
    await expect(db.transaction(prepared.apply)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "agent_finalization_provenance_changed" },
    });
    expect(await readOutcome(runId)).toEqual({
      status: "Running",
      results: 0,
      events: 0,
    });
    expect(await readFile(marker, "utf8")).toBe("uncommitted work");
  });

  it("competing applications publish one result and one terminal wake", async () => {
    const { runId, marker } = await seedRun();
    const first = await prepareAgentRunFinalization(runId, "Done", {
      db,
      finalText,
    });
    const second = await prepareAgentRunFinalization(runId, "Done", {
      db,
      finalText,
    });
    const results = await Promise.all([
      db.transaction(first.apply),
      db.transaction(second.apply),
    ]);

    expect(results.filter((result) => result.finalized)).toHaveLength(1);
    expect(await readOutcome(runId)).toEqual({
      status: "Done",
      results: 1,
      events: 1,
    });
    await first.afterCommit(results[0]);
    await second.afterCommit(results[1]);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
