// ADR-182 T2.1 (C14, C26): `session.steer` through the bound client and the
// REAL wire — a real supervisor child running the lifecycle mock with steering
// advertised and a held (controlled) parent prompt, behind the fault proxy.

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient, ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { SupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

import { randomUUID } from "node:crypto";
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
  startMainAndBrainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";
import { startSupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";
import { seedNodePromptOwner } from "@/test-support/prompt-owner-fixture";
import {
  invocationFromEnvironment,
  processIdentity,
  signalInvocationProcess,
} from "@/test-support/process-invocation";
import { seedNativeFindingsExecution } from "@/test-support/native-findings-seed";
import { buildAgentProfileContract } from "@/lib/run-results/contract";

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
async function heldPrompt(
  name: string,
  configureRun?: (runId: string) => Promise<void>,
): Promise<Held> {
  const runId = await seedFlowRun(name);

  await configureRun?.(runId);
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
  const session = (await client.sessionsForRun()).find(
    (session) => session.sessionId === created.sessionId,
  );
  const invocation = invocationFromEnvironment();

  if (!invocation || !session?.adapterPid || !session.processGroup)
    throw new Error(
      "Controlled prompt requires its owned native adapter metadata",
    );
  const adapter = await processIdentity(invocation, session.adapterPid);

  expect(adapter.pgid).toBe(session.processGroup);
  expect(adapter.pid).not.toBe(session.pid);
  expect(
    (await invocations()).find(
      (row) =>
        row.method === "session/prompt" &&
        row.sessionId === created.acpSessionId,
    )?.pid,
  ).toBe(adapter.pid);

  return {
    runId,
    client,
    hostSessionId: created.hostSessionId,
    acpSessionId: created.acpSessionId,
    parentCommandId: handle.commandId,
    release: async () => {
      await signalInvocationProcess(invocation, adapter, "SIGUSR1");
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
  testDatabase = await startMainAndBrainPostgresTestDb({
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
  it.each(["before_wire", "after_lost_ack"] as const)(
    "IT-CBE-06 native steering rechecks current recipient sources %s without inventing an external outcome",
    async (window) => {
      const contract = buildAgentProfileContract({
        profileName: "findings",
        flowRefId: "native-wire",
        resolvedRevision: "a".repeat(40),
        sourceFlowRevisionId: "retained-profile",
        schemaStem: "findings.v1",
        nativeContract: "evidence_findings_v1",
        schemaVersion: 1,
        sha256: "b".repeat(64),
        schema: { schemaVersion: 1, fields: [] },
      });
      const source = await seedNativeFindingsExecution(testDatabase, contract);

      await testDatabase.pool.query(
        "INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name) SELECT $1,$2,package_install_id,package_name FROM project_package_attachments WHERE project_id=$3",
        [randomUUID(), project.id, source.projectId],
      );
      await testDatabase.pool.query(
        "INSERT INTO agent_project_links(id,project_id,agent_id,enabled,can_read_brain) VALUES($1,$2,$3,true,true)",
        [randomUUID(), project.id, source.agentId],
      );
      const held = await heldPrompt(
        `native-source-steer-${window}`,
        async (runId) => {
          const flowId = randomUUID();
          const taskId = randomUUID();

          await testDatabase.pool.query(
            "INSERT INTO flows(id,project_id,flow_ref_id,source,version,installed_path,manifest,schema_version) VALUES($1,$2,$3,'github.com/fixture/native','v1.0.0','/tmp/native-wire',$4::jsonb,1)",
            [
              flowId,
              project.id,
              `native-wire-${window}`,
              JSON.stringify({
                schemaVersion: 1,
                name: "Native wire",
                nodes: [
                  {
                    id: "s1",
                    type: "ai_coding",
                    prompt: "Hold the current professional turn.",
                  },
                ],
              }),
            ],
          );
          await testDatabase.pool.query(
            "INSERT INTO tasks(id,project_id,number,title,prompt,status,stage,flow_id) SELECT $1,$2,coalesce(max(number),0)+1,'Native wire','Hold the current professional turn.','InFlight','InFlight',$3 FROM tasks WHERE project_id=$2",
            [taskId, project.id, flowId],
          );
          await testDatabase.pool.query(
            "UPDATE runs SET run_kind='flow',flow_version='v1.0.0',task_id=$2,flow_id=$3 WHERE id=$1",
            [runId, taskId, flowId],
          );
          await testDatabase.pool.query(
            "UPDATE runs target SET source_agent_id=source.source_agent_id,agent_activity_snapshot=source.agent_activity_snapshot,launched_at=now(),activity_sort_at=now(),activity_timestamp_provenance='launch',current_step_id='s1',knowledge_access=$3::jsonb FROM runs source WHERE target.id=$1 AND source.id=$2",
            [
              runId,
              source.runId,
              JSON.stringify({
                schemaVersion: 1,
                state: "complete",
                generation: 1,
                restrictions: [
                  { kind: "company", companyId: source.companyId },
                ],
              }),
            ],
          );
        },
      );

      try {
        const first = await db.transaction((tx) =>
          held.client.prepareSteer(
            tx,
            held.hostSessionId,
            steerPayload(held.parentCommandId, "Authorized native follow-up"),
          ),
        );

        await expect(first.deliver()).resolves.toMatchObject({
          outcome: "injected",
        });
        const second = await db.transaction((tx) =>
          held.client.prepareSteer(
            tx,
            held.hostSessionId,
            steerPayload(
              held.parentCommandId,
              "This private follow-up must not reach the revoked role",
            ),
          ),
        );
        const revoke = async (): Promise<void> => {
          await testDatabase.pool.query(
            "UPDATE company_grants SET revoked_at=now() WHERE company_id=$1 AND principal_type='agent' AND principal_id=$2 AND action='knowledge:read'",
            [source.companyId, source.agentId],
          );
        };

        if (window === "before_wire") {
          await revoke();
          await expect(second.deliver()).rejects.toMatchObject({
            code: "PRECONDITION",
            details: { reason: "knowledge_reference_unavailable" },
          });
          expect(await ledgerState(second.commandId)).toBe("failed");
          expect(
            steersFor(await invocations(), held.acpSessionId),
          ).toHaveLength(1);
        } else {
          const barrier = proxy.arm(
            {
              caseId: "native-steer-lost-ack",
              method: "POST",
              path: /^\/sessions\/[^/]+\/steer$/,
              commandId: second.commandId,
            },
            "hold-response",
          );
          const delivered = second.deliver();

          await barrier.awaitReached();
          await revoke();
          barrier.cut();
          await expect(delivered).rejects.toMatchObject({
            code: "EXECUTOR_UNAVAILABLE",
            details: { reason: "native_steer_reconciliation_required" },
          });
          expect(await ledgerState(second.commandId)).toBe("delivering");
          expect(
            steersFor(await invocations(), held.acpSessionId),
          ).toHaveLength(2);
          await recoverExecutionCommands({
            db,
            transport: defaultTransport(),
            graceMs: 0,
          });
          expect(await ledgerState(second.commandId)).toBe("succeeded");
          expect(
            steersFor(await invocations(), held.acpSessionId),
          ).toHaveLength(2);
        }
        const before = (
          await testDatabase.pool.query<{ count: number }>(
            "SELECT count(*)::int FROM execution_commands WHERE run_id=$1 AND kind='session.steer'",
            [held.runId],
          )
        ).rows[0]!.count;

        await expect(
          db.transaction((tx) =>
            held.client.prepareSteer(
              tx,
              held.hostSessionId,
              steerPayload(
                held.parentCommandId,
                "Rejected before another intent",
              ),
            ),
          ),
        ).rejects.toMatchObject({ code: "PRECONDITION" });
        expect(
          (
            await testDatabase.pool.query<{ count: number }>(
              "SELECT count(*)::int FROM execution_commands WHERE run_id=$1 AND kind='session.steer'",
              [held.runId],
            )
          ).rows[0]!.count,
        ).toBe(before);
      } finally {
        await held.release();
      }
    },
    120000,
  );

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
