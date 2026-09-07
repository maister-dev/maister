import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  executionCommands,
  executionEvents,
  gateResults,
  hitlRequests,
  nodeAttempts,
  runSessionIncarnations,
  runs,
  users,
} from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { lockCreateOwner } from "@/lib/execution-host/create-intent";
import { quarantinePromptProtocol } from "@/lib/execution-host/prompt-evidence";
import {
  startRuntimeEventConsumer,
  stopRuntimeEventConsumers,
} from "@/lib/execution-host/events/consumer";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { startFlowContinuationWorker } from "@/lib/flows/graph/continuation-worker";
import { prepareFlowPermissionResult } from "@/lib/flows/graph/permission-resume";
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";
import { interruptPermissionInputAcknowledgement } from "@/test-support/permission-ack-fault";
import { resumeRun } from "@/lib/runs/resume";
import {
  seedGraphRun,
  type SeededGraphRun,
} from "@/test-support/graph-run-seed";
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
let projection: ProjectionWorker;
let db: Db;
let journalPath: string;
let restoreUrl: () => void = () => {};

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "flow_permission_result_failures",
  });
  db = database.db as unknown as Db;
  await db.insert(users).values({
    id: "gate-permission-user",
    email: "gate-permission@test.local",
  });
  journalPath = await mkdtemp(path.join(tmpdir(), "gate-permission-journal-"));
  supervisor = await startRealSupervisor({
    fixture: "mock-acp-adapter-resumable.mjs",
    env: {
      MOCK_ACP_REQUEST_PERMISSION: "1",
      MOCK_ACP_STATE_DIR: journalPath,
      MOCK_ACP_STOP_REASON: "cancelled",
    },
  });
  restoreUrl = useRealSupervisorUrl(supervisor.url);
  vi.stubEnv("MAISTER_RUNTIME_ROOT", supervisor.runtimeRoot);
  resetRegistrarStateForTests();
  resetResolverForTests();
  projection = startProjectionWorker({ db, projectors: canonicalProjectors });
}, 180_000);

afterAll(async () => {
  await stopRuntimeEventConsumers();
  await projection?.stop();
  await supervisor?.kill();
  restoreUrl();
  vi.unstubAllEnvs();
  await database?.stop();
});

function startProcess(
  script: string,
  runId: string,
  ...args: string[]
): Readonly<{
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
}> {
  const child = fork(
    path.resolve("test-support", script),
    [runId, supervisor.runtimeRoot, ...args],
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
  let output = "";
  const record = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-16_384);
  };

  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });

  return { child, exited, output: () => output };
}

type FailureOwner = "node" | "ai_judgment" | "skill_check";

async function assertQuarantineDuringClaim(
  runId: string,
  commandId: string,
  hosts: ReturnType<typeof createExecutionHosts>,
): Promise<void> {
  const [command] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, commandId));
  const capacity = await database.pool.connect();
  let claim:
    | Promise<Awaited<ReturnType<typeof resumeRun>> | { error: unknown }>
    | undefined;

  try {
    await capacity.query("SELECT pg_advisory_lock($1)", [0x6d61_6973]);
    claim = resumeRun(runId, { db, executionHosts: hosts }).catch(
      (error: unknown) => ({ error }),
    );
    await expect
      .poll(
        async () => {
          const rows = await database.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND NOT granted",
            [0x6d61_6973],
          );

          return rows.rows[0].count;
        },
        { timeout: 15_000, interval: 25 },
      )
      .toBe(1);
    await quarantinePromptProtocol(db, commandId, "receipt");
    await capacity.query("SELECT pg_advisory_unlock_all()");
    expect(await claim).toMatchObject({
      error: {
        code: "CONFLICT",
        details: { causeCode: "permission_result_generation" },
      },
    });
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));

    expect(run.status).toBe("NeedsInputIdle");
    expect(run.executionAssignmentId).toBe(command.executionAssignmentId);
  } finally {
    await capacity.query("SELECT pg_advisory_unlock_all()");
    await claim;
    capacity.release();
    await db
      .update(executionCommands)
      .set({
        applicationState: command.applicationState,
        applicationError: command.applicationError,
        applicationClaimOwner: command.applicationClaimOwner,
        applicationClaimExpiresAt: command.applicationClaimExpiresAt,
        applicationNextRetryAt: command.applicationNextRetryAt,
      })
      .where(eq(executionCommands.id, commandId));
  }
}

async function seedFailureFlow(owner: FailureOwner): Promise<SeededGraphRun> {
  const name = randomUUID();
  const repoPath = await initRepo(`${supervisor.runtimeRoot}/repo-${name}`);
  const branch = `maister/${name}`;
  const worktreePath = await addWorktree(
    repoPath,
    `${supervisor.runtimeRoot}/wt-${name}`,
    branch,
  );
  const gate =
    owner === "node"
      ? {
          id: "review",
          kind: "command_check",
          mode: "blocking",
          command: "true",
        }
      : {
          id: "review",
          kind: owner,
          mode: "blocking",
          ...(owner === "skill_check"
            ? { command: '/review {"verdict":"pass"}' }
            : { prompt: '{"verdict":"pass"}' }),
        };

  return seedGraphRun(
    database.db,
    {
      schemaVersion: 1,
      name: "permission-result-failure",
      nodes: [
        {
          id: "work",
          type: owner === "node" ? "ai_coding" : "cli",
          action:
            owner === "node"
              ? { prompt: "Complete the pending tool." }
              : { command: "printf 'work\\n' >> failure-parent.txt" },
          pre_finish: { gates: [gate] },
          transitions: { success: "after" },
        },
        {
          id: "after",
          type: "cli",
          action: { command: "printf 'after\\n' >> failure-successor.txt" },
          transitions: { success: "done" },
        },
      ],
    },
    {
      repoPath,
      flowRevision: true,
      workspace: { worktreePath, parentRepoPath: repoPath, branch },
    },
  );
}

describe("Owned Flow completed-command failure handoff", () => {
  it.each<
    Readonly<{
      owner: FailureOwner;
      window:
        | "ordinary"
        | "claim SIGKILL"
        | "fresh permission"
        | "refused handle";
    }>
  >([
    { owner: "node", window: "ordinary" },
    { owner: "ai_judgment", window: "ordinary" },
    { owner: "skill_check", window: "ordinary" },
    { owner: "ai_judgment", window: "claim SIGKILL" },
    { owner: "node", window: "fresh permission" },
    { owner: "skill_check", window: "fresh permission" },
    { owner: "node", window: "refused handle" },
  ])(
    "owner-flow-permission-checkpoint-interruption: $owner continues across $window",
    async ({ owner, window }) => {
      await stopRuntimeEventConsumers();
      supervisor = await supervisor.restart({
        env: {
          ...supervisor.options.env,
          MOCK_ACP_STOP_REASON: "end_turn",
          MOCK_ACP_HOLD_AFTER_PERMISSION: "1",
        },
      });
      const seeded = await seedFailureFlow(owner);
      const driver = startProcess("flow-prompt-owner-process.ts", seeded.runId);
      let claimant: ReturnType<typeof startProcess> | undefined;
      let responder: ReturnType<typeof startProcess> | undefined;
      let continuation:
        | ReturnType<typeof startFlowContinuationWorker>
        | undefined;

      try {
        await expect
          .poll(
            async () => {
              if (driver.child.exitCode !== null)
                throw new Error(driver.output());
              const [run] = await db
                .select()
                .from(runs)
                .where(eq(runs.id, seeded.runId));

              return run.status;
            },
            { timeout: 30_000 },
          )
          .toBe("NeedsInput");
        const [source] = await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );
        const [hitl] = await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.runId, seeded.runId));
        const hosts = createExecutionHosts({ db });

        startRuntimeEventConsumer({
          db,
          executionHostId: source.executionHostId,
          transport: hosts.transport,
        });
        await interruptPermissionInputAcknowledgement({
          database,
          hitlRequestId: hitl.id,
          startResponder: () =>
            startProcess(
              "flow-permission-response-process.ts",
              hitl.id,
              "gate-permission-user",
            ),
        });
        expect(
          await hosts.transport.getCommandReceipt(source.id),
        ).toMatchObject({
          phase: "accepted",
        });
        const [incarnation] = await db
          .select()
          .from(runSessionIncarnations)
          .where(
            eq(runSessionIncarnations.hostSessionId, source.targetSessionId!),
          );
        const journalFile = path.join(
          journalPath,
          `${incarnation.acpSessionId}.json`,
        );
        const journal = JSON.parse(
          await readFile(journalFile, "utf8"),
        ) as Record<string, unknown>;

        await writeFile(
          journalFile,
          JSON.stringify({
            ...journal,
            completionText: '{"verdict":"pass"}',
            requestFreshPermission: window === "fresh permission",
            rejectResume: window === "refused handle",
          }),
        );
        await db
          .update(runs)
          .set({ keepaliveUntil: new Date(Date.now() - 1_000) })
          .where(eq(runs.id, seeded.runId));
        await runSweepTick({ db, executionHosts: hosts });
        await expect
          .poll(() => driver.child.exitCode, { timeout: 45_000 })
          .toBe(0);
        await expect
          .poll(
            async () => {
              const [command] = await db
                .select()
                .from(executionCommands)
                .where(eq(executionCommands.id, source.id));

              return { state: command.state, error: command.lastError?.code };
            },
            { timeout: 30_000 },
          )
          .toEqual({ state: "failed", error: "ACP_PROTOCOL" });
        const events = await db
          .select()
          .from(executionEvents)
          .where(eq(executionEvents.runId, seeded.runId));
        const accepted = events.find(
          (event) =>
            event.eventType === "session.command" &&
            event.payload?.kind === "session.checkpoint" &&
            event.payload.phase === "accepted",
        );
        const terminal = events.find(
          (event) =>
            event.payload?.commandId === source.id &&
            event.payload.phase === "rejected",
        );

        expect(accepted?.eventStreamId).toBe(terminal?.eventStreamId);
        expect(accepted?.hostSequence).toBeLessThan(terminal!.hostSequence!);
        if (owner === "node" && window === "ordinary")
          await assertQuarantineDuringClaim(seeded.runId, source.id, hosts);
        if (window === "claim SIGKILL") {
          claimant = startProcess(
            "flow-permission-claim-process.ts",
            seeded.runId,
          );
          let message: unknown;

          claimant.child.on("message", (value: unknown) => {
            message = value;
          });
          await expect
            .poll(() => message, { timeout: 30_000 })
            .toMatchObject({
              state: "claimed",
              result: { ok: true, newSupervisorSessionId: null },
            });
          expect(claimant.child.kill("SIGKILL")).toBe(true);
          await claimant.exited;
          expect(claimant.child.signalCode).toBe("SIGKILL");
        } else {
          await expect(
            resumeRun(seeded.runId, { db, executionHosts: hosts }),
          ).resolves.toMatchObject({ ok: true, runStatus: "Running" });
        }
        const [parked] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, seeded.runId));
        const [parent] = await db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.runId, seeded.runId));
        const prompts = await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );
        const gates = await db
          .select()
          .from(gateResults)
          .where(eq(gateResults.runId, seeded.runId));

        expect(parked.status).toBe("Running");
        expect(parked.executionAssignmentId).not.toBe(
          source.executionAssignmentId,
        );
        if (owner === "node")
          expect(parent.actionResume).toMatchObject({
            kind: "permission_continue",
            promptOrdinal: 1,
          });
        else
          expect(gates[0].permissionResume).toMatchObject({
            kind: "permission_continue",
            promptOrdinal: 1,
          });
        expect(prompts).toHaveLength(1);
        if (
          window === "ordinary" &&
          (owner === "node" || owner === "ai_judgment")
        ) {
          const nodeResume = parent.actionResume;
          const gateResume = gates[0]?.permissionResume;

          if (owner === "node") {
            if (nodeResume?.kind !== "permission_continue")
              throw new Error("Missing node continuation fixture");
            await db
              .update(nodeAttempts)
              .set({
                actionResume: {
                  ...nodeResume,
                  inputCommandId: nodeResume.checkpointCommandId,
                },
              })
              .where(eq(nodeAttempts.id, parent.id));
          } else {
            if (gateResume?.kind !== "permission_continue")
              throw new Error("Missing gate continuation fixture");
            await db
              .update(gateResults)
              .set({
                permissionResume: {
                  ...gateResume,
                  inputCommandId: gateResume.checkpointCommandId,
                },
              })
              .where(eq(gateResults.id, gates[0].id));
          }
          try {
            await expect(
              db.transaction((tx) =>
                lockCreateOwner(tx, {
                  runId: seeded.runId,
                  assignmentId: parked.executionAssignmentId!,
                  owner:
                    owner === "node"
                      ? {
                          variant: "node",
                          nodeAttemptId: parent.id,
                          promptOrdinal: 1,
                        }
                      : {
                          variant: "gate_ai",
                          nodeAttemptId: parent.id,
                          gateId: gates[0].gateId,
                          evaluationId: gates[0].id,
                        },
                }),
              ),
            ).rejects.toMatchObject({
              code: "CONFLICT",
              details: { causeCode: "permission_result_source_generation" },
            });
          } finally {
            if (owner === "node")
              await db
                .update(nodeAttempts)
                .set({ actionResume: nodeResume })
                .where(eq(nodeAttempts.id, parent.id));
            else
              await db
                .update(gateResults)
                .set({ permissionResume: gateResume })
                .where(eq(gateResults.id, gates[0].id));
          }
        }
        continuation = startFlowContinuationWorker({
          db,
          runtimeRoot: supervisor.runtimeRoot,
          executionHosts: hosts,
        });
        if (window === "fresh permission") {
          await expect
            .poll(
              async () => {
                const rows = await db
                  .select()
                  .from(hitlRequests)
                  .where(eq(hitlRequests.runId, seeded.runId));

                return rows.filter(
                  (row) => row.id !== hitl.id && row.respondedAt === null,
                ).length;
              },
              { timeout: 30_000 },
            )
            .toBe(1);
          const rows = await db
            .select()
            .from(hitlRequests)
            .where(eq(hitlRequests.runId, seeded.runId));
          const fresh = rows.find((row) => row.id !== hitl.id)!;

          expect(fresh.response).toBeNull();
          responder = startProcess(
            "flow-permission-response-process.ts",
            fresh.id,
            "gate-permission-user",
          );
          await expect
            .poll(() => responder?.child.exitCode, { timeout: 30_000 })
            .toBe(0);
        }
        await expect
          .poll(
            async () => {
              const [run] = await db
                .select()
                .from(runs)
                .where(eq(runs.id, seeded.runId));

              return run.status;
            },
            { timeout: 60_000 },
          )
          .toBe(window === "refused handle" ? "Failed" : "Review");
        await continuation.stop();
        continuation = undefined;
        const finalPrompts = await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );
        const finalHitls = await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.runId, seeded.runId));

        expect(finalPrompts).toHaveLength(window === "refused handle" ? 1 : 2);
        expect(finalHitls).toHaveLength(window === "fresh permission" ? 2 : 1);
        expect(finalHitls.every((row) => row.respondedAt !== null)).toBe(true);
        if (window === "refused handle") {
          const creates = await db
            .select()
            .from(executionCommands)
            .where(
              and(
                eq(executionCommands.runId, seeded.runId),
                eq(executionCommands.kind, "session.create"),
              ),
            );

          expect(creates).toHaveLength(2);
          expect(
            creates.filter((command) => command.state === "failed"),
          ).toHaveLength(1);
          await expect(
            access(path.join(seeded.worktreePath, "failure-successor.txt")),
          ).rejects.toMatchObject({ code: "ENOENT" });

          return;
        }
        expect(
          await readFile(
            path.join(seeded.worktreePath, "failure-successor.txt"),
            "utf8",
          ),
        ).toBe("after\n");
        if (owner !== "node")
          expect(
            await readFile(
              path.join(seeded.worktreePath, "failure-parent.txt"),
              "utf8",
            ),
          ).toBe("work\n");
      } catch (error) {
        throw new Error(
          `Checkpoint interruption failed for ${seeded.runId} (${owner}); child exit=${driver.child.exitCode}, signal=${driver.child.signalCode}\n${driver.output()}`,
          { cause: error },
        );
      } finally {
        await continuation?.stop();
        claimant?.child.kill("SIGKILL");
        responder?.child.kill("SIGKILL");
        await claimant?.exited;
        await responder?.exited;
        if (driver.child.exitCode === null && driver.child.signalCode === null)
          driver.child.kill("SIGKILL");
        await driver.exited;
        await stopRuntimeEventConsumers();
      }
    },
    120_000,
  );

  it.each<
    Readonly<{
      owner: FailureOwner;
      completion: "cancelled" | "max_tokens" | "executor_unavailable";
    }>
  >([
    { owner: "node", completion: "max_tokens" },
    { owner: "node", completion: "cancelled" },
    { owner: "ai_judgment", completion: "cancelled" },
    { owner: "skill_check", completion: "cancelled" },
    { owner: "node", completion: "executor_unavailable" },
    { owner: "ai_judgment", completion: "executor_unavailable" },
    { owner: "skill_check", completion: "executor_unavailable" },
  ])(
    "owner-flow-permission-result-failure: $owner preserves $completion completion",
    async ({ owner, completion }) => {
      const stopReason =
        completion === "executor_unavailable" ? "end_turn" : completion;
      const failure =
        completion === "executor_unavailable"
          ? "adapter authentication unavailable"
          : "";
      const errorCode =
        completion === "executor_unavailable"
          ? "EXECUTOR_UNAVAILABLE"
          : "ACP_PROTOCOL";

      if (
        supervisor.options.env?.MOCK_ACP_STOP_REASON !== stopReason ||
        supervisor.options.env?.MOCK_ACP_FAIL_AFTER_PERMISSION !== failure ||
        supervisor.options.env?.MOCK_ACP_HOLD_AFTER_PERMISSION === "1"
      ) {
        await stopRuntimeEventConsumers();
        supervisor = await supervisor.restart({
          env: {
            ...supervisor.options.env,
            MOCK_ACP_STOP_REASON: stopReason,
            MOCK_ACP_FAIL_AFTER_PERMISSION: failure,
            MOCK_ACP_HOLD_AFTER_PERMISSION: "0",
          },
        });
      }
      const seeded = await seedFailureFlow(owner);
      const driver = startProcess("flow-prompt-owner-process.ts", seeded.runId);
      let continuation:
        | ReturnType<typeof startFlowContinuationWorker>
        | undefined;

      try {
        await expect
          .poll(
            async () => {
              if (driver.child.exitCode !== null)
                throw new Error(driver.output());
              const [run] = await db
                .select()
                .from(runs)
                .where(eq(runs.id, seeded.runId));

              return run.status;
            },
            { timeout: 30_000 },
          )
          .toBe("NeedsInput");
        const [source] = await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );
        const [hitl] = await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.runId, seeded.runId));
        const [parent] = await db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.runId, seeded.runId));
        const hosts = createExecutionHosts({ db });

        startRuntimeEventConsumer({
          db,
          executionHostId: source.executionHostId,
          transport: hosts.transport,
        });
        await interruptPermissionInputAcknowledgement({
          database,
          hitlRequestId: hitl.id,
          startResponder: () =>
            startProcess(
              "flow-permission-response-process.ts",
              hitl.id,
              "gate-permission-user",
            ),
        });
        await expect
          .poll(() => driver.child.exitCode, { timeout: 45_000 })
          .toBe(0);
        await expect
          .poll(
            async () => {
              const [command] = await db
                .select()
                .from(executionCommands)
                .where(eq(executionCommands.id, source.id));

              return command.state;
            },
            { timeout: 45_000 },
          )
          .toBe(completion === "max_tokens" ? "succeeded" : "failed");
        const sourceReceipt = await hosts.transport.getCommandReceipt(
          source.id,
        );

        expect(sourceReceipt).toMatchObject(
          completion === "max_tokens"
            ? { phase: "completed", body: { stopReason } }
            : { phase: "rejected", body: { code: errorCode } },
        );
        const [pending] = await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.id, hitl.id));
        const response = pending.response as {
          _delivery: { commandId: string };
        };

        expect(pending.respondedAt).toBeNull();
        expect(
          await hosts.transport.getCommandReceipt(response._delivery.commandId),
        ).toMatchObject({ phase: "completed", body: { ok: true } });
        await db
          .update(runs)
          .set({ keepaliveUntil: new Date(Date.now() - 1_000) })
          .where(eq(runs.id, seeded.runId));
        await runSweepTick({ db, executionHosts: hosts });
        const [parked] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, seeded.runId));

        expect(parked.status).toBe("NeedsInputIdle");
        await expect
          .poll(
            async () =>
              (
                await prepareFlowPermissionResult(
                  db,
                  seeded.runId,
                  hosts.transport,
                )
              )?.kind,
            { timeout: 15_000 },
          )
          .toBe("completed");
        if (owner === "node" && stopReason === "max_tokens")
          await assertQuarantineDuringClaim(seeded.runId, source.id, hosts);
        expect(
          await resumeRun(seeded.runId, { db, executionHosts: hosts }),
        ).toMatchObject({ ok: true, newSupervisorSessionId: null });
        const [claimed] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, seeded.runId));
        const [handoff] = await db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.id, parent.id));

        expect(claimed.executionAssignmentId).not.toBe(
          source.executionAssignmentId,
        );
        expect(handoff.executionAssignmentId).toBe(
          claimed.executionAssignmentId,
        );
        expect(handoff.actionPromptOrdinal).toBe(parent.actionPromptOrdinal);
        if (owner === "node") {
          expect(handoff.actionCompletion).toMatchObject({
            commandId: source.id,
            promptOrdinal: 0,
            result: { ok: false, errorCode },
          });
          expect(handoff.actionResume).toMatchObject({
            kind: "permission_result",
            inputCommandId: response._delivery.commandId,
          });
        } else {
          expect(handoff.actionCompletion).toEqual(parent.actionCompletion);
          const [gate] = await db
            .select()
            .from(gateResults)
            .where(eq(gateResults.runId, seeded.runId));

          expect(gate).toMatchObject({
            status: "failed",
            promptOrdinal: 0,
            permissionResume: {
              kind: "permission_result",
              inputCommandId: response._delivery.commandId,
            },
          });
          expect(gate.verdict?.verdict).not.toBe("pass");
        }
        continuation = startFlowContinuationWorker({
          db,
          runtimeRoot: supervisor.runtimeRoot,
          executionHosts: hosts,
        });
        await expect
          .poll(
            async () => {
              const [run] = await db
                .select()
                .from(runs)
                .where(eq(runs.id, seeded.runId));

              return { status: run.status, token: run.flowDriverToken };
            },
            { timeout: 60_000 },
          )
          .toEqual({ status: "Failed", token: null });
        await continuation.stop();
        continuation = undefined;
        const prompts = await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );
        const attempts = await db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.runId, seeded.runId));
        const gates = await db
          .select()
          .from(gateResults)
          .where(eq(gateResults.runId, seeded.runId));
        const [settled] = await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.id, hitl.id));

        expect(prompts).toHaveLength(1);
        expect(prompts[0].id).toBe(source.id);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          id: parent.id,
          status: "Failed",
          actionPromptOrdinal: 0,
        });
        expect(gates).toHaveLength(owner === "node" ? 0 : 1);
        expect(settled.respondedAt).not.toBeNull();
        await expect(
          access(path.join(seeded.worktreePath, "failure-successor.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        if (owner !== "node")
          expect(
            await readFile(
              path.join(seeded.worktreePath, "failure-parent.txt"),
              "utf8",
            ),
          ).toBe("work\n");
      } catch (error) {
        throw new Error(
          `Permission failure handoff failed for ${seeded.runId} (${owner}/${stopReason}); child exit=${driver.child.exitCode}, signal=${driver.child.signalCode}\n${driver.output()}`,
          { cause: error },
        );
      } finally {
        await continuation?.stop();
        if (driver.child.exitCode === null && driver.child.signalCode === null)
          driver.child.kill("SIGKILL");
        await driver.exited;
        await stopRuntimeEventConsumers();
      }
    },
    120_000,
  );
});
