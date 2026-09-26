// ADR-182 T2.1 (C14, C26): `session.steer` through the bound client and the
// REAL wire — a real supervisor child running the lifecycle mock with steering
// advertised and a held (controlled) parent prompt, behind the fault proxy.

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient, ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { SupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  executionCommands,
  runMessages,
  runSessionIncarnations,
} from "@/lib/db/schema";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import {
  startProjectionWorker,
  type ProjectionWorker,
} from "@/lib/execution-host/events/projection-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { isMaisterError } from "@/lib/errors";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { recoverExecutionCommands } from "@/lib/execution-host/recovery";
import { defaultTransport } from "@/lib/execution-host/default-transport";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
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
import { startSupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";
import { seedNodePromptOwner } from "@/test-support/prompt-owner-fixture";

let testDatabase: StartedPostgresTestDb;
let projectionWorker: ProjectionWorker;
let db: Db;
let sup: RealSupervisor;
let proxy: SupervisorFaultProxy;
let restoreUrl: () => void = () => {};
let hosts: ExecutionHosts;
let project: { id: string; slug: string; repoPath: string };
let logDir: string;
let adapterLog: string;

const CREATE_PAYLOAD = {
  stepId: "s1",
  executor: { agent: "claude" as const, model: "mock" },
};

async function seedFlowRun(name: string) {
  const runId = await seedRun(testDatabase.db, {
    projectId: project.id,
    status: "Running",
  });
  const worktreePath = await addWorktree(
    project.repoPath,
    `${sup.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );

  await seedWorkspace(testDatabase.db, {
    runId,
    projectId: project.id,
    worktreePath,
    parentRepoPath: project.repoPath,
  });

  return runId;
}

async function invocations(): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(adapterLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function waitForInvocation(
  predicate: (row: Record<string, unknown>) => boolean,
): Promise<void> {
  const startedAt = Date.now();

  while (!(await invocations()).some(predicate)) {
    if (Date.now() - startedAt > 15_000)
      throw new Error("adapter invocation never arrived");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type Held = {
  runId: string;
  client: BoundClient;
  hostSessionId: string;
  acpSessionId: string;
  parentCommandId: string;
  release: () => Promise<void>;
};

// A run whose parent prompt the adapter holds open until SIGUSR1.
async function heldPrompt(name: string): Promise<Held> {
  const runId = await seedFlowRun(name);
  const client = await hosts.forRun(runId, { reason: "launch" });
  const created = await client.createSession(CREATE_PAYLOAD);
  const handle = await client.prompt(
    created.hostSessionId,
    { stepId: "s1", prompt: "hold" },
    {
      admitOwner: await seedNodePromptOwner(db, client, created.hostSessionId),
    },
  );

  await waitForInvocation(
    (row) =>
      row.method === "session/prompt" && row.sessionId === created.acpSessionId,
  );
  const pid = (await hosts.local().listSessions()).find(
    (session) => session.sessionId === created.sessionId,
  )?.pid;

  return {
    runId,
    client,
    hostSessionId: created.hostSessionId,
    acpSessionId: created.acpSessionId,
    parentCommandId: handle.commandId,
    release: async () => {
      if (pid) process.kill(pid, "SIGUSR1");
      await client.waitForPrompt(handle, {
        signal: AbortSignal.timeout(15_000),
      });
    },
  };
}

function steerPayload(parentCommandId: string, text = "also X") {
  return { contentBlocks: [{ type: "text" as const, text }], parentCommandId };
}

async function ledgerState(commandId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ state: executionCommands.state })
    .from(executionCommands)
    .where(eq(executionCommands.id, commandId));

  return row?.state;
}

function steersFor(
  rows: Array<Record<string, unknown>>,
  acpSessionId: string,
): Array<Record<string, unknown>> {
  return rows.filter(
    (row) =>
      row.method === "_session/steering" && row.sessionId === acpSessionId,
  );
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_steer_deliverer",
  });
  db = testDatabase.db as unknown as Db;
  logDir = await mkdtemp(path.join(tmpdir(), "steer-deliverer-"));
  adapterLog = path.join(logDir, "adapter-invocations.ndjson");
  sup = await startRealSupervisor({
    fixtureArgs: [
      "--hang",
      "--steering",
      "--controlled-prompt",
      "--invocation-log",
      adapterLog,
    ],
  });
  proxy = await startSupervisorFaultProxy(sup.url);
  restoreUrl = useRealSupervisorUrl(proxy.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  project = await seedProjectRow(testDatabase.db, {
    repoPath: await initRepo(`${sup.runtimeRoot}/repo`),
  });
  hosts = createExecutionHosts({ db });
  projectionWorker = startProjectionWorker({
    db,
    projectors: canonicalProjectors,
  });
}, 180_000);

afterAll(async () => {
  restoreUrl();
  await stopRuntimeEventConsumers();
  await projectionWorker?.stop();
  await proxy?.close();
  await sup?.kill();
  await testDatabase?.stop();
  await rm(logDir, { recursive: true, force: true });
});

describe("session.steer through the bound client (ADR-182)", () => {
  it("records the adapter's steering advertisement on the incarnation at the create ACK", async () => {
    const runId = await seedFlowRun("steer-capability");
    const client = await hosts.forRun(runId, { reason: "launch" });
    const created = await client.createSession(CREATE_PAYLOAD);

    expect(created.steeringSupported).toBe(true);
    const [incarnation] = await db
      .select({ steeringSupported: runSessionIncarnations.steeringSupported })
      .from(runSessionIncarnations)
      .where(eq(runSessionIncarnations.hostSessionId, created.hostSessionId));

    expect(incarnation.steeringSupported).toBe(true);
  }, 120_000);

  it("injects and runs onAck in the transaction that marks the row succeeded", async () => {
    const held = await heldPrompt("steer-inject");
    const prepared = await db.transaction((tx) =>
      held.client.prepareSteer(
        tx as unknown as Db,
        held.hostSessionId,
        steerPayload(held.parentCommandId),
      ),
    );

    expect(await ledgerState(prepared.commandId)).toBe("queued");
    const seenInAck: Array<string | undefined> = [];
    const result = await prepared.deliver({
      onAck: async (tx) => {
        const [row] = await tx
          .select({ state: executionCommands.state })
          .from(executionCommands)
          .where(eq(executionCommands.id, prepared.commandId));

        seenInAck.push(row?.state);
      },
      onReject: async () => {
        throw new Error("a successful steer must not run onReject");
      },
    });

    expect(result).toMatchObject({
      outcome: "injected",
      parentCommandId: held.parentCommandId,
      replayed: false,
    });
    expect(seenInAck).toEqual(["succeeded"]);
    const [row] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, prepared.commandId));

    expect(row).toMatchObject({
      kind: "session.steer",
      state: "succeeded",
      ownerKind: null,
    });
    expect(Object.keys(row.payload).sort()).toEqual([
      "contentBlockCount",
      "parentCommandId",
      "promptBytes",
    ]);
    await held.release();
  }, 120_000);

  it("runs onReject in the transaction that marks a definitive refusal failed", async () => {
    const held = await heldPrompt("steer-refused");
    const prepared = await db.transaction((tx) =>
      held.client.prepareSteer(
        tx as unknown as Db,
        held.hostSessionId,
        steerPayload("00000000-0000-4000-8000-000000000000"),
      ),
    );
    const seenInReject: Array<{ state?: string; reason?: unknown }> = [];

    await expect(
      prepared.deliver({
        onReject: async (tx, error) => {
          const [row] = await tx
            .select({ state: executionCommands.state })
            .from(executionCommands)
            .where(eq(executionCommands.id, prepared.commandId));

          seenInReject.push({
            state: row?.state,
            reason: isMaisterError(error) ? error.details?.reason : null,
          });
        },
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "CONFLICT" &&
        err.details?.reason === "steer_no_active_turn",
    );
    expect(seenInReject).toEqual([
      { state: "failed", reason: "steer_no_active_turn" },
    ]);
    expect(await ledgerState(prepared.commandId)).toBe("failed");
    await held.release();
  }, 120_000);

  it("rolls the ledger back with a throwing settlement; recovery re-runs both from the receipt", async () => {
    const held = await heldPrompt("steer-throwing-reject");
    const messageId = crypto.randomUUID();
    const prepared = await db.transaction(async (tx) => {
      const steer = await held.client.prepareSteer(
        tx as unknown as Db,
        held.hostSessionId,
        steerPayload("00000000-0000-4000-8000-000000000001"),
      );

      await tx.insert(runMessages).values({
        id: messageId,
        runId: held.runId,
        sequence: 1,
        role: "user",
        content: "also X",
        delivery: "steered",
        steerCommandId: steer.commandId,
      });

      return steer;
    });

    await expect(
      prepared.deliver({
        onReject: async () => {
          throw new Error("settlement crashed");
        },
      }),
    ).rejects.toThrow("settlement crashed");
    expect(await ledgerState(prepared.commandId)).toBe("delivering");

    await recoverExecutionCommands({
      db,
      transport: defaultTransport(),
      graceMs: 0,
    });

    expect(await ledgerState(prepared.commandId)).toBe("failed");
    const [message] = await db
      .select({ delivery: runMessages.delivery })
      .from(runMessages)
      .where(eq(runMessages.id, messageId));

    expect(message.delivery).toBe("queued");
    await held.release();
  }, 120_000);

  it("W1: an intent that never reached the wire is orphaned and converted once, even across two passes", async () => {
    const held = await heldPrompt("steer-orphaned-intent");
    const messageId = crypto.randomUUID();
    const prepared = await db.transaction(async (tx) => {
      const steer = await held.client.prepareSteer(
        tx as unknown as Db,
        held.hostSessionId,
        steerPayload(held.parentCommandId, "never sent"),
      );

      await tx.insert(runMessages).values({
        id: messageId,
        runId: held.runId,
        sequence: 1,
        role: "user",
        content: "never sent",
        delivery: "steered",
        steerCommandId: steer.commandId,
      });

      return steer;
    });

    // The issuing request died here: no deliver() call ever runs.
    for (let pass = 0; pass < 2; pass += 1)
      await recoverExecutionCommands({
        db,
        transport: defaultTransport(),
        graceMs: 0,
      });

    const [row] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, prepared.commandId));
    const [message] = await db
      .select({ delivery: runMessages.delivery })
      .from(runMessages)
      .where(eq(runMessages.id, messageId));

    expect(row).toMatchObject({
      state: "failed",
      lastError: { code: "CRASH", reason: "ORPHANED" },
    });
    expect(message.delivery).toBe("queued");
    expect(steersFor(await invocations(), held.acpSessionId)).toHaveLength(0);
    await held.release();
  }, 120_000);

  it("marks a fenced steer fenced through the same hook", async () => {
    const held = await heldPrompt("steer-fenced");
    const successor = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, {
        runId: held.runId,
        hostId: held.client.host.id,
        reason: "resume",
      }),
    );
    const clientTwo = await hosts.forAssignment(successor);

    // Any epoch-2 command advances the host's fence for the run.
    await clientTwo.createSession({ ...CREATE_PAYLOAD, sessionName: "epoch2" });
    const prepared = await db.transaction((tx) =>
      held.client.prepareSteer(
        tx as unknown as Db,
        held.hostSessionId,
        steerPayload(held.parentCommandId),
      ),
    );
    const seenInReject: Array<string | undefined> = [];

    await expect(
      prepared.deliver({
        onReject: async (tx) => {
          const [row] = await tx
            .select({ state: executionCommands.state })
            .from(executionCommands)
            .where(eq(executionCommands.id, prepared.commandId));

          seenInReject.push(row?.state);
        },
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "CONFLICT" &&
        err.details?.reason === "assignment_fenced",
    );
    expect(seenInReject).toEqual(["fenced"]);
    expect(await ledgerState(prepared.commandId)).toBe("fenced");
  }, 120_000);

  it("retries the same id after a lost response and never reaches the adapter twice", async () => {
    const held = await heldPrompt("steer-lost-response");
    const prepared = await db.transaction((tx) =>
      held.client.prepareSteer(
        tx as unknown as Db,
        held.hostSessionId,
        steerPayload(held.parentCommandId, "once"),
      ),
    );
    const barrier = proxy.arm(
      {
        caseId: "steer-lost-response",
        method: "POST",
        path: /^\/sessions\/[^/]+\/steer$/,
        commandId: prepared.commandId,
      },
      "hold-response",
    );
    const delivered = prepared.deliver();

    await barrier.awaitReached();
    barrier.cut();
    const result = await delivered;

    expect(result).toMatchObject({ outcome: "injected", replayed: true });
    expect(await ledgerState(prepared.commandId)).toBe("succeeded");
    expect(steersFor(await invocations(), held.acpSessionId)).toHaveLength(1);
    await held.release();
  }, 120_000);
});
