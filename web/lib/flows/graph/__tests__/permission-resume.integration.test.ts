import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  executionAssignments,
  executionCommands,
  gateResults,
  hitlRequests,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
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
import { seedGraphRun } from "@/test-support/graph-run-seed";
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
  journalPath = await mkdtemp(path.join(tmpdir(), "flow-permission-journal-"));

  supervisor = await startRealSupervisor({
    fixture: "mock-acp-adapter-resumable.mjs",
    env: { MOCK_ACP_REQUEST_PERMISSION: "1", MOCK_ACP_STATE_DIR: journalPath },
  });
  restoreUrl = useRealSupervisorUrl(supervisor.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  projection = startProjectionWorker({ db, projectors: canonicalProjectors });
}, 180_000);

afterAll(async () => {
  await stopRuntimeEventConsumers();
  await projection?.stop();
  await supervisor?.kill();
  restoreUrl();
  await database?.stop();
});

function startProcess(
  script: string,
  runId: string,
): {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
} {
  const child = fork(
    path.resolve("test-support", script),
    [runId, supervisor.runtimeRoot],
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

describe("Owned Flow checkpointed permission resume", () => {
  it.each(["capacity claim", "claim SIGKILL", "resume refused"] as const)(
    "owner-flow-permission-resume: %s preserves the exact authorized turn",
    async (scenario) => {
      const name = randomUUID();
      const repoPath = await initRepo(`${supervisor.runtimeRoot}/repo-${name}`);
      const worktreePath = await addWorktree(
        repoPath,
        `${supervisor.runtimeRoot}/wt-${name}`,
        `maister/${name}`,
      );
      const seeded = await seedGraphRun(
        database.db,
        {
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
        },
        {
          repoPath,
          flowRevision: true,
          workspace: { worktreePath, parentRepoPath: repoPath },
        },
      );
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
          .toBe(scenario === "resume refused" ? "Failed" : "Review");
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
});
