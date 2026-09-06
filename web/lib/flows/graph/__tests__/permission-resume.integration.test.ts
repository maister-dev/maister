import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  domainEvents,
  executionAssignments,
  assignments,
  executionCommands,
  gateResults,
  hitlRequests,
  nodeAttempts,
  runs,
  users,
} from "@/lib/db/schema";
import { buildOrchestratorResumeConsumer } from "@/lib/domain-events/orchestrator-resume";
import { runFlow } from "@/lib/flows/runner";
import {
  markResumedFromWait,
  rollbackResumeFromWait,
} from "@/lib/runs/state-transitions";
import { createExecutionHosts } from "@/lib/execution-host/client";
import {
  startRuntimeEventConsumer,
  stopRuntimeEventConsumers,
} from "@/lib/execution-host/events/consumer";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { startFlowContinuationWorker } from "@/lib/flows/graph/continuation-worker";
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";
import { resumeRun } from "@/lib/runs/resume";
import { respondToHitl } from "@/lib/services/hitl";
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
    databaseName: "flow_permission_resumes",
  });
  db = database.db as unknown as Db;
  await db
    .insert(users)
    .values({ id: "flow-permission-user", email: "permission@test.local" });
  journalPath = await mkdtemp(path.join(tmpdir(), "flow-permission-journal-"));

  supervisor = await startRealSupervisor({
    fixture: "mock-acp-adapter-resumable.mjs",
    env: { MOCK_ACP_REQUEST_PERMISSION: "1", MOCK_ACP_STATE_DIR: journalPath },
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
): {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
} {
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

function openHostStateForFault(): DatabaseSync {
  const state = new DatabaseSync(
    path.join(supervisor.stateDir, "state.sqlite"),
  );

  state.exec("PRAGMA busy_timeout = 5000");

  return state;
}

async function seedFixtureFlow(manifest: unknown): Promise<SeededGraphRun> {
  const name = randomUUID();
  const repoPath = await initRepo(`${supervisor.runtimeRoot}/repo-${name}`);
  const worktreePath = await addWorktree(
    repoPath,
    `${supervisor.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );

  return await seedGraphRun(database.db, manifest, {
    repoPath,
    flowRevision: true,
    workspace: { worktreePath, parentRepoPath: repoPath },
  });
}

async function seedPermissionFlow(): Promise<SeededGraphRun> {
  return await seedFixtureFlow({
    schemaVersion: 1,
    name: "permission-resume",
    nodes: [
      {
        id: "work",
        type: "ai_coding",
        action: { prompt: "Complete the pending tool and continue." },
        pre_finish: {
          gates: [
            {
              id: "check",
              kind: "command_check",
              mode: "blocking",
              command: "true",
            },
          ],
        },
        transitions: { success: "after" },
      },
      {
        id: "after",
        type: "cli",
        action: {
          command: "printf 'after\\n' >> permission-resume-after.txt",
        },
        transitions: { success: "done" },
      },
    ],
  });
}

async function seedPermissionOrchestrator(): Promise<SeededGraphRun> {
  const parent = await seedFixtureFlow({
    schemaVersion: 1,
    engineMin: "1.6.0",
    name: "permission-orchestrator",
    nodes: [
      {
        id: "coordinate",
        type: "orchestrator",
        action: {
          prompt: "Complete the pending tool and coordinate children.",
        },
        transitions: { success: "done" },
      },
    ],
  });
  const child = await seedFixtureFlow({
    schemaVersion: 1,
    name: "permission-child",
    nodes: [
      {
        id: "child",
        type: "cli",
        action: { command: "true" },
        transitions: { success: "done" },
      },
    ],
  });

  await db
    .update(runs)
    .set({ parentRunId: parent.runId })
    .where(eq(runs.id, child.runId));

  return parent;
}

async function wakePermissionOrchestrator(
  parent: SeededGraphRun,
): Promise<void> {
  const [parked] = await db
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.runId, parent.runId));
  const [child] = await db
    .select()
    .from(runs)
    .where(eq(runs.parentRunId, parent.runId));
  const hosts = createExecutionHosts({ db });

  expect(parked.status).toBe("NeedsInput");
  expect(parked.actionCompletion?.result.ok).toBe(true);
  await runFlow(child.id, { db, runtimeRoot: supervisor.runtimeRoot });
  const events = await db
    .select()
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.runId, child.id),
        eq(domainEvents.kind, "run.review"),
      ),
    );

  expect(events).toHaveLength(1);
  if (parked.actionResume?.kind === "permission_result") {
    const [hitl] = await db
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, parked.actionResume.hitlRequestId));
    const original = hitl.response as {
      optionId: string;
      _audit: Record<string, unknown>;
    };

    try {
      await db
        .update(hitlRequests)
        .set({
          response: {
            ...original,
            _audit: {
              ...original._audit,
              resultHandoffAssignmentId: randomUUID(),
            },
          },
        })
        .where(eq(hitlRequests.id, hitl.id));
      await expect(
        markResumedFromWait(parent.runId, { db }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { causeCode: "permission_result_source_generation" },
      });
      const [unchanged] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, parent.runId));

      expect(unchanged).toMatchObject({
        status: "WaitingOnChildren",
        executionAssignmentId: parked.executionAssignmentId,
      });
    } finally {
      await db
        .update(hitlRequests)
        .set({ response: hitl.response })
        .where(eq(hitlRequests.id, hitl.id));
    }
  }
  // The normal domain claim must retain the same turn through a pre-prompt
  // spawn rollback before the child-event consumer retries it.
  expect(await markResumedFromWait(parent.runId, { db })).toMatchObject({
    ok: true,
  });
  const [claimed] = await db
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, parked.id));

  expect(claimed.actionPromptOrdinal).toBe(parked.actionPromptOrdinal + 1);
  expect(claimed.actionResume).toMatchObject({
    kind: "orchestrator",
    sourceCommandId: parked.actionCompletion!.commandId,
  });
  expect(await rollbackResumeFromWait(parent.runId, { db })).toMatchObject({
    ok: true,
  });
  if (parked.actionResume?.kind === "permission_result") {
    expect(claimed.actionResume).toMatchObject({
      permissionResult: parked.actionResume,
    });
    if (
      claimed.actionResume?.kind !== "orchestrator" ||
      !claimed.actionResume.permissionResult
    )
      throw new Error("orchestrator claim lost its permission-result lineage");
    const resume = claimed.actionResume;

    try {
      await db
        .update(nodeAttempts)
        .set({
          actionResume: {
            ...resume,
            permissionResult: { ...resume.permissionResult!, optionId: "deny" },
          },
        })
        .where(eq(nodeAttempts.id, parked.id));
      await expect(
        markResumedFromWait(parent.runId, { db }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { causeCode: "permission_result_source_generation" },
      });
    } finally {
      await db
        .update(nodeAttempts)
        .set({ actionResume: resume })
        .where(eq(nodeAttempts.id, parked.id));
    }
  }
  const consumer = buildOrchestratorResumeConsumer({
    db: database.db,
    resumeFlow: (runId, options) =>
      runFlow(runId, { ...options, runtimeRoot: supervisor.runtimeRoot }),
  });
  const waking = consumer.handle(events);

  try {
    await expect
      .poll(
        async () => {
          const pending = await db
            .select()
            .from(hitlRequests)
            .where(eq(hitlRequests.runId, parent.runId));

          return pending.find((hitl) => hitl.respondedAt === null);
        },
        { timeout: 45_000 },
      )
      .toMatchObject({ respondedAt: null });
    const pending = await db
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.runId, parent.runId));
    const nextPermission = pending.find((hitl) => hitl.respondedAt === null)!;

    // The prior choice cannot satisfy a fresh permission on the next turn.
    expect(pending).toHaveLength(2);
    const response = await respondToHitl(
      {
        runId: parent.runId,
        hitlRequestId: nextPermission.id,
        body: { optionId: "allow" },
      },
      {
        kind: "user",
        userId: "flow-permission-user",
        label: "Permission test operator",
        preauthorizedProjectId: parent.projectId,
      },
      { db, executionHosts: hosts },
    );

    expect(response.status).toBe(200);
    await waking;
    const [finished] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, parent.runId));
    const attempts = await db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, parent.runId));
    const prompts = await db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, parent.runId),
          eq(executionCommands.kind, "session.prompt"),
        ),
      )
      .orderBy(asc(executionCommands.assignmentEpoch));

    expect(finished.status).toBe("Review");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: parked.id,
      status: "Succeeded",
      actionPromptOrdinal: claimed.actionPromptOrdinal,
    });
    expect(prompts).toHaveLength(claimed.actionPromptOrdinal + 1);
    expect(prompts.at(-1)).toMatchObject({
      ownerRef: {
        variant: "node",
        nodeAttemptId: parked.id,
        promptOrdinal: claimed.actionPromptOrdinal,
      },
      state: "succeeded",
      applicationState: "applied",
    });
    expect(
      new Set(prompts.map((command) => command.logicalOperationKey)).size,
    ).toBe(prompts.length);
    await consumer.handle(events);
    expect(
      await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, parent.runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        ),
    ).toHaveLength(prompts.length);
  } finally {
    await waking;
  }
}

describe("Owned Flow checkpointed permission resume", () => {
  it.each([
    "capacity claim",
    "claim SIGKILL",
    "resume refused",
    "orchestrator",
  ] as const)(
    "owner-flow-permission-resume: %s preserves the exact authorized turn",
    async (scenario) => {
      const seeded =
        scenario === "orchestrator"
          ? await seedPermissionOrchestrator()
          : await seedPermissionFlow();
      const { worktreePath } = seeded;
      const driver = startProcess("flow-prompt-owner-process.ts", seeded.runId);
      let claimProcess: ReturnType<typeof startProcess> | undefined;
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
        const [attempt] = await db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.runId, seeded.runId));
        const hosts = createExecutionHosts({ db });

        expect(source.ownerRef).toMatchObject({
          variant: "node",
          nodeAttemptId: attempt.id,
          promptOrdinal: 0,
        });
        startRuntimeEventConsumer({
          db,
          executionHostId: source.executionHostId,
          transport: hosts.transport,
        });
        await db
          .update(runs)
          .set({ keepaliveUntil: new Date(Date.now() - 1_000) })
          .where(eq(runs.id, seeded.runId));
        await runSweepTick({ db, executionHosts: hosts });
        await expect
          .poll(() => driver.child.exitCode, { timeout: 30_000 })
          .toBe(0);
        const [parked] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, seeded.runId));

        expect(parked.status).toBe("NeedsInputIdle");
        // resumeRun is the capacity-checked production entrypoint called after
        // the response transaction has durably stored the operator's choice.
        await db
          .update(hitlRequests)
          .set({ response: { optionId: "allow" } })
          .where(eq(hitlRequests.id, hitl.id));
        if (scenario === "capacity claim") {
          // A mismatched source cannot mint an assignment or dispatch a turn.
          await db.transaction(async (tx) => {
            const original = hitl.schema as Record<string, unknown>;
            const sourceIdentity = original.flowPrompt as Record<
              string,
              unknown
            >;

            await tx
              .update(hitlRequests)
              .set({
                schema: {
                  ...original,
                  flowPrompt: {
                    ...sourceIdentity,
                    nodeAttemptId: randomUUID(),
                  },
                },
              })
              .where(eq(hitlRequests.id, hitl.id));
            await expect(
              resumeRun(seeded.runId, { db: tx, executionHosts: hosts }),
            ).rejects.toMatchObject({ code: "CONFLICT" });
            await tx
              .update(hitlRequests)
              .set({ schema: original })
              .where(eq(hitlRequests.id, hitl.id));
          });
          const afterRefusal = await db
            .select()
            .from(executionAssignments)
            .where(eq(executionAssignments.runId, seeded.runId));

          expect(afterRefusal).toHaveLength(1);
        }
        if (scenario === "claim SIGKILL") {
          claimProcess = startProcess(
            "flow-permission-claim-process.ts",
            seeded.runId,
          );
          let message: unknown;

          claimProcess.child.on("message", (value: unknown) => {
            message = value;
          });
          await expect
            .poll(() => message, { timeout: 30_000 })
            .toMatchObject({
              state: "claimed",
              result: { ok: true, newSupervisorSessionId: null },
            });
          claimProcess.child.kill("SIGKILL");
          await claimProcess.exited;
        } else {
          const result = await resumeRun(seeded.runId, {
            db,
            executionHosts: hosts,
          });

          expect(result).toMatchObject({
            ok: true,
            newSupervisorSessionId: null,
          });
        }
        const assignments = await db
          .select()
          .from(executionAssignments)
          .where(eq(executionAssignments.runId, seeded.runId))
          .orderBy(asc(executionAssignments.epoch));
        const [resuming] = await db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.id, attempt.id));

        expect(assignments).toHaveLength(2);
        expect(assignments[0]).toMatchObject({
          state: "released",
          releasedReason: "checkpointed",
        });
        expect(assignments[1]).toMatchObject({
          state: "active",
          placementReason: "resume",
        });
        expect(resuming).toMatchObject({
          executionAssignmentId: assignments[1].id,
          actionPromptOrdinal: 1,
          actionCompletion: null,
          actionResume: {
            version: 1,
            kind: "permission",
            sourceCommandId: source.id,
            sourceAssignmentId: source.executionAssignmentId,
            assignmentId: assignments[1].id,
            promptOrdinal: 1,
            hitlRequestId: hitl.id,
            sourceRequestId: (hitl.schema as { requestId: string }).requestId,
            optionId: "allow",
          },
        });
        if (scenario === "resume refused") {
          const file = path.join(
            journalPath,
            `${resuming.actionResume!.resumeSessionId}.json`,
          );
          const journal = JSON.parse(await readFile(file, "utf8")) as Record<
            string,
            unknown
          >;

          await writeFile(
            file,
            JSON.stringify({ ...journal, rejectResume: true }),
          );
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

              return run.status;
            },
            { timeout: 60_000 },
          )
          .toBe(
            scenario === "resume refused"
              ? "Failed"
              : scenario === "orchestrator"
                ? "WaitingOnChildren"
                : "Review",
          );
        if (scenario === "orchestrator") {
          await continuation.stop();
          continuation = undefined;
          await wakePermissionOrchestrator(seeded);

          return;
        }
        const prompts = await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          )
          .orderBy(asc(executionCommands.assignmentEpoch));

        if (scenario === "resume refused") {
          const creates = await db
            .select()
            .from(executionCommands)
            .where(
              and(
                eq(executionCommands.runId, seeded.runId),
                eq(executionCommands.executionAssignmentId, assignments[1].id),
                eq(executionCommands.kind, "session.create"),
              ),
            );

          expect(prompts).toHaveLength(1);
          expect(prompts[0].id).toBe(source.id);
          expect(creates).toHaveLength(1);
          expect(creates[0]).toMatchObject({
            state: "failed",
            lastError: { code: "CHECKPOINT" },
            createIntent: {
              generation: 0,
              sessionFallback: false,
            },
          });
          await expect(
            readFile(path.join(worktreePath, "permission-resume-after.txt")),
          ).rejects.toMatchObject({ code: "ENOENT" });

          return;
        }
        expect(prompts).toHaveLength(2);
        expect(prompts[0].id).toBe(source.id);
        expect(prompts[1]).toMatchObject({
          executionAssignmentId: assignments[1].id,
          state: "succeeded",
          applicationState: "applied",
          ownerRef: {
            variant: "permission_resume",
            nodeAttemptId: attempt.id,
            promptOrdinal: 1,
            hitlRequestId: hitl.id,
          },
        });
        const work = await db
          .select()
          .from(nodeAttempts)
          .where(
            and(
              eq(nodeAttempts.runId, seeded.runId),
              eq(nodeAttempts.nodeId, "work"),
            ),
          );
        const permissions = await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.runId, seeded.runId));
        const gates = await db
          .select()
          .from(gateResults)
          .where(eq(gateResults.runId, seeded.runId));

        expect(work).toHaveLength(1);
        expect(work[0]).toMatchObject({
          id: attempt.id,
          status: "Succeeded",
          actionPromptOrdinal: 1,
        });
        expect(work[0].stdout).toContain(
          "replayed permission outcome: selected allow",
        );
        expect(permissions).toHaveLength(1);
        expect(permissions[0]).toMatchObject({
          id: hitl.id,
          respondedAt: expect.any(Date),
        });
        expect(gates).toHaveLength(1);
        expect(gates[0].status).toBe("passed");
        expect(
          await readFile(`${worktreePath}/permission-resume-after.txt`, "utf8"),
        ).toBe("after\n");
      } finally {
        await continuation?.stop();
        claimProcess?.child.kill("SIGKILL");
        await claimProcess?.exited;
        driver.child.kill("SIGKILL");
        await driver.exited;
      }
    },
    140_000,
  );

  it.each(["capacity", "response", "orchestrator"] as const)(
    "owner-flow-source-handoff: %s reuses the original completed action after a lost input ACK",
    async (entrypoint) => {
      const seeded =
        entrypoint === "orchestrator"
          ? await seedPermissionOrchestrator()
          : await seedPermissionFlow();
      const driver = startProcess("flow-prompt-owner-process.ts", seeded.runId);
      let responder: ReturnType<typeof startProcess> | undefined;
      let responseBody: unknown;
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
        const [attempt] = await db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.runId, seeded.runId));
        const hosts = createExecutionHosts({ db });

        startRuntimeEventConsumer({
          db,
          executionHostId: source.executionHostId,
          transport: hosts.transport,
        });
        const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
        const trigger = `permission_ack_${randomUUID().replaceAll("-", "")}`;
        const lock = await database.pool.connect();

        try {
          await lock.query("SELECT pg_advisory_lock(260912, $1)", [lockKey]);
          await database.pool.query(
            `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${hitl.id}' AND NEW.responded_at IS NOT NULL THEN PERFORM pg_advisory_xact_lock(260912, ${lockKey}); END IF; RETURN NEW; END $$`,
          );
          await database.pool.query(
            `CREATE TRIGGER ${trigger} BEFORE UPDATE ON hitl_requests FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
          );
          responder = startProcess(
            "flow-permission-response-process.ts",
            hitl.id,
            "flow-permission-user",
          );
          await expect
            .poll(
              async () => {
                if (responder?.child.exitCode !== null)
                  throw new Error(responder?.output());
                const waiting = await database.pool.query<{ count: number }>(
                  "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 260912 AND objid = $1 AND NOT granted",
                  [lockKey],
                );

                return waiting.rows[0].count;
              },
              { timeout: 30_000, interval: 25 },
            )
            .toBe(1);
          expect(responder.child.kill("SIGKILL")).toBe(true);
          await responder.exited;
          expect(responder.child.signalCode).toBe("SIGKILL");
        } finally {
          responder?.child.kill("SIGKILL");
          await responder?.exited;
          await lock.query("SELECT pg_advisory_unlock_all()");
          lock.release();
          await database.pool.query(
            `DROP TRIGGER IF EXISTS ${trigger} ON hitl_requests`,
          );
          await database.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
        }
        await expect
          .poll(() => driver.child.exitCode, { timeout: 45_000 })
          .toBe(0);
        const [pendingHitl] = await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.id, hitl.id));
        const response = pendingHitl.response as {
          optionId: string;
          _delivery: { commandId: string };
        };

        expect(pendingHitl.respondedAt).toBeNull();
        expect(response).toMatchObject({
          optionId: "allow",
          _delivery: { commandId: expect.any(String) },
        });
        const receipt = await hosts.transport.getCommandReceipt(
          response._delivery.commandId,
        );

        expect(receipt).toMatchObject({
          phase: "completed",
          kind: "session.input",
          body: { ok: true },
        });
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
          .toBe("succeeded");
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
        const hostState = openHostStateForFault();
        const hiddenId = randomUUID();

        try {
          hostState
            .prepare(
              "UPDATE command_receipts SET command_id = ? WHERE command_id = ?",
            )
            .run(hiddenId, response._delivery.commandId);
          expect(
            await resumeRun(seeded.runId, { db, executionHosts: hosts }),
          ).toMatchObject({ ok: false, retryable: true });
        } finally {
          hostState
            .prepare(
              "UPDATE command_receipts SET command_id = ? WHERE command_id = ?",
            )
            .run(response._delivery.commandId, hiddenId);
          hostState.close();
        }
        const unconfirmedState = openHostStateForFault();

        try {
          unconfirmedState
            .prepare(
              "UPDATE command_receipts SET phase = 'accepted' WHERE command_id = ?",
            )
            .run(response._delivery.commandId);
          expect(
            await resumeRun(seeded.runId, { db, executionHosts: hosts }),
          ).toMatchObject({ ok: false, retryable: true });
        } finally {
          unconfirmedState
            .prepare(
              "UPDATE command_receipts SET phase = 'completed' WHERE command_id = ?",
            )
            .run(response._delivery.commandId);
          unconfirmedState.close();
        }
        const [unclaimed] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, seeded.runId));

        expect(unclaimed.status).toBe("NeedsInputIdle");
        expect(unclaimed.executionAssignmentId).toBe(
          parked.executionAssignmentId,
        );
        const capLock = await database.pool.connect();
        let staleResume:
          | Promise<Awaited<ReturnType<typeof resumeRun>> | unknown>
          | undefined;

        try {
          await capLock.query("SELECT pg_advisory_lock($1)", [0x6d61_6973]);
          staleResume = resumeRun(seeded.runId, {
            db,
            executionHosts: hosts,
          }).catch((error: unknown) => error);
          await expect
            .poll(
              async () => {
                const waiting = await database.pool.query<{ count: number }>(
                  "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND NOT granted",
                  [0x6d61_6973],
                );

                return waiting.rows[0].count;
              },
              { timeout: 15_000, interval: 25 },
            )
            .toBe(1);
          await db
            .update(hitlRequests)
            .set({ response: { ...response, optionId: "deny" } })
            .where(eq(hitlRequests.id, hitl.id));
          await capLock.query("SELECT pg_advisory_unlock_all()");
          expect(await staleResume).toMatchObject({
            code: "CONFLICT",
            details: { causeCode: "permission_result_generation" },
          });
        } finally {
          await capLock.query("SELECT pg_advisory_unlock_all()");
          await staleResume;
          capLock.release();
          await db
            .update(hitlRequests)
            .set({ response: pendingHitl.response })
            .where(eq(hitlRequests.id, hitl.id));
        }
        if (entrypoint !== "response") {
          expect(
            await resumeRun(seeded.runId, { db, executionHosts: hosts }),
          ).toMatchObject({ ok: true });
        } else {
          const result = await respondToHitl(
            {
              runId: seeded.runId,
              hitlRequestId: hitl.id,
              body: { optionId: "allow" },
            },
            {
              kind: "user",
              userId: "flow-permission-user",
              label: "Permission test operator",
              preauthorizedProjectId: seeded.projectId,
            },
            { db, executionHosts: hosts },
          );

          expect(result.status).toBe(202);
          responseBody = await result.json();
        }
        const [handoff] = await db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.id, attempt.id));
        const [claimed] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, seeded.runId));

        expect(handoff).toMatchObject({
          executionAssignmentId: claimed.executionAssignmentId,
          actionPromptOrdinal: 0,
          actionCompletion: {
            commandId: source.id,
            promptOrdinal: 0,
            result: { ok: true },
          },
          actionResume: {
            kind: "permission_result",
            sourceCommandId: source.id,
            assignmentId: claimed.executionAssignmentId,
            promptOrdinal: 0,
            inputCommandId: response._delivery.commandId,
            checkpointCommandId: expect.any(String),
          },
        });
        const [humanAssignment] = await db
          .select()
          .from(assignments)
          .where(eq(assignments.hitlRequestId, hitl.id));

        expect(humanAssignment.status).toBe("completed");
        expect(claimed.executionAssignmentId).not.toBe(
          source.executionAssignmentId,
        );
        if (entrypoint !== "response")
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

              return run.status;
            },
            { timeout: 60_000 },
          )
          .toBe(entrypoint === "orchestrator" ? "WaitingOnChildren" : "Review");
        if (entrypoint === "orchestrator") {
          await continuation?.stop();
          continuation = undefined;
          await wakePermissionOrchestrator(seeded);

          return;
        }
        await expect
          .poll(
            async () => {
              const [run] = await db
                .select()
                .from(runs)
                .where(eq(runs.id, seeded.runId));

              return run.flowDriverToken;
            },
            { timeout: 15_000 },
          )
          .toBeNull();
        const prompts = await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );
        const work = await db
          .select()
          .from(nodeAttempts)
          .where(
            and(
              eq(nodeAttempts.runId, seeded.runId),
              eq(nodeAttempts.nodeId, "work"),
            ),
          );
        const gates = await db
          .select()
          .from(gateResults)
          .where(eq(gateResults.runId, seeded.runId));
        const [delivered] = await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.id, hitl.id));

        expect(prompts).toHaveLength(1);
        expect(prompts[0].id).toBe(source.id);
        expect(work).toHaveLength(1);
        expect(work[0]).toMatchObject({
          id: attempt.id,
          status: "Succeeded",
          actionPromptOrdinal: 0,
        });
        expect(work[0].stdout).toContain("permission outcome: selected allow");
        expect(gates).toHaveLength(1);
        expect(gates[0].status).toBe("passed");
        expect(delivered.respondedAt).toBeInstanceOf(Date);
        if (entrypoint === "response")
          expect(responseBody).toMatchObject({
            ok: true,
            runStatus: "Running",
            state: "resume-in-progress",
          });
        expect(
          await readFile(
            `${seeded.worktreePath}/permission-resume-after.txt`,
            "utf8",
          ),
        ).toBe("after\n");
      } finally {
        await continuation?.stop();
        responder?.child.kill("SIGKILL");
        await responder?.exited;
        driver.child.kill("SIGKILL");
        await driver.exited;
      }
    },
    180_000,
  );
});
