import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  executionCommands,
  gateResults,
  hitlRequests,
  nodeAttempts,
  runs,
  runSessionIncarnations,
  users,
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
import { interruptPermissionInputAcknowledgement } from "@/test-support/permission-ack-fault";
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
    databaseName: "flow_gate_permission_results",
  });
  db = database.db as unknown as Db;
  await db.insert(users).values({
    id: "gate-permission-user",
    email: "gate-permission@test.local",
  });
  journalPath = await mkdtemp(path.join(tmpdir(), "gate-permission-journal-"));
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

async function seedGateFlow(
  gateKind: "ai_judgment" | "skill_check",
  parentKind: "cli" | "ai_coding",
): Promise<SeededGraphRun> {
  const name = randomUUID();
  const repoPath = await initRepo(`${supervisor.runtimeRoot}/repo-${name}`);
  const branch = `maister/${name}`;
  const worktreePath = await addWorktree(
    repoPath,
    `${supervisor.runtimeRoot}/wt-${name}`,
    branch,
  );

  return seedGraphRun(
    database.db,
    {
      schemaVersion: 1,
      name: "gate-permission-resume",
      nodes: [
        {
          id: "work",
          type: parentKind,
          action:
            parentKind === "cli"
              ? { command: "printf 'work\\n' >> gate-permission-work.txt" }
              : { prompt: "Complete the parent action once." },
          pre_finish: {
            gates: [
              {
                id: "review",
                kind: gateKind,
                mode: "blocking",
                ...(gateKind === "skill_check"
                  ? {
                      command:
                        '/review {"verdict":"pass","confidence":0.99,"reasons":["original gate verified"]}',
                    }
                  : {
                      prompt:
                        '{"verdict":"pass","confidence":0.99,"reasons":["original gate verified"]}',
                    }),
              },
            ],
          },
          transitions: { success: "after" },
        },
        {
          id: "after",
          type: "cli",
          action: { command: "printf 'after\\n' >> gate-permission-after.txt" },
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

describe("Owned Flow completed gate permission result", () => {
  it.each([
    {
      gateKind: "ai_judgment",
      parentKind: "ai_coding",
      window: "capacity claim",
    },
    { gateKind: "skill_check", parentKind: "cli", window: "response" },
    { gateKind: "ai_judgment", parentKind: "cli", window: "claim SIGKILL" },
  ] as const)(
    "owner-flow-gate-result: $gateKind after $parentKind ($window)",
    async ({ gateKind, parentKind, window }) => {
      const seeded = await seedGateFlow(gateKind, parentKind);
      const hosts = createExecutionHosts({ db });
      const driver = startProcess("flow-prompt-owner-process.ts", seeded.runId);
      let claimant: ReturnType<typeof startProcess> | undefined;
      let continuation:
        | ReturnType<typeof startFlowContinuationWorker>
        | undefined;

      try {
        if (parentKind === "ai_coding") {
          await expect
            .poll(
              async () => {
                const rows = await db
                  .select()
                  .from(hitlRequests)
                  .where(eq(hitlRequests.runId, seeded.runId));

                return rows.length;
              },
              { timeout: 30_000 },
            )
            .toBe(1);
          const [parentPermission] = await db
            .select()
            .from(hitlRequests)
            .where(eq(hitlRequests.runId, seeded.runId));
          const response = await respondToHitl(
            {
              runId: seeded.runId,
              hitlRequestId: parentPermission.id,
              body: { optionId: "allow" },
            },
            {
              kind: "user",
              userId: "gate-permission-user",
              label: "Gate test operator",
              preauthorizedProjectId: seeded.projectId,
            },
            { db, executionHosts: hosts },
          );

          expect(response.status).toBe(200);
        }
        await expect
          .poll(
            async () => {
              if (driver.child.exitCode !== null)
                throw new Error(driver.output());
              const rows = await db
                .select()
                .from(hitlRequests)
                .where(eq(hitlRequests.runId, seeded.runId));

              return rows.find(
                (row) =>
                  (row.schema as { flowPrompt?: { gateId?: string } })
                    .flowPrompt?.gateId === "review",
              );
            },
            { timeout: 45_000 },
          )
          .toMatchObject({ respondedAt: null });
        const rows = await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.runId, seeded.runId));
        const hitl = rows.find(
          (row) =>
            (row.schema as { flowPrompt?: { gateId?: string } }).flowPrompt
              ?.gateId === "review",
        )!;
        const source = (
          hitl.schema as {
            flowPrompt: { commandId: string; incarnationId: string };
          }
        ).flowPrompt;
        const [command] = await db
          .select()
          .from(executionCommands)
          .where(eq(executionCommands.id, source.commandId));
        const [evaluation] = await db
          .select()
          .from(gateResults)
          .where(eq(gateResults.runId, seeded.runId));
        const [attempt] = await db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.id, evaluation.nodeAttemptId!));
        const [incarnation] = await db
          .select()
          .from(runSessionIncarnations)
          .where(eq(runSessionIncarnations.id, source.incarnationId));

        startRuntimeEventConsumer({
          db,
          executionHostId: command.executionHostId,
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
        const [pending] = await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.id, hitl.id));
        const response = pending.response as {
          optionId: string;
          _delivery: { commandId: string };
        };

        expect(pending.respondedAt).toBeNull();
        expect(response).toMatchObject({
          optionId: "allow",
          _delivery: { commandId: expect.any(String) },
        });
        expect(
          await hosts.transport.getCommandReceipt(response._delivery.commandId),
        ).toMatchObject({
          phase: "completed",
          kind: "session.input",
          body: { ok: true },
        });
        await expect
          .poll(
            async () => {
              const [row] = await db
                .select()
                .from(executionCommands)
                .where(eq(executionCommands.id, command.id));

              return row.state;
            },
            { timeout: 45_000 },
          )
          .toBe("succeeded");
        await db
          .update(runs)
          .set({ keepaliveUntil: new Date(Date.now() - 1_000) })
          .where(eq(runs.id, seeded.runId));
        await runSweepTick({ db, executionHosts: hosts });
        const [idle] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, seeded.runId));

        expect(idle.status).toBe("NeedsInputIdle");

        if (window === "capacity claim") {
          const hostState = new DatabaseSync(
            path.join(supervisor.stateDir, "state.sqlite"),
          );

          hostState.exec("PRAGMA busy_timeout = 5000");
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
          const originalAction = attempt.actionCompletion;

          if (!originalAction) throw new Error("parent action missing");
          const capacity = await database.pool.connect();
          let staleClaim: Promise<unknown> | undefined;

          try {
            await capacity.query("SELECT pg_advisory_lock($1)", [0x6d61_6973]);
            staleClaim = resumeRun(seeded.runId, {
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
                { timeout: 30_000, interval: 25 },
              )
              .toBe(1);
            await db
              .update(nodeAttempts)
              .set({
                actionCompletion: {
                  ...originalAction,
                  result: {
                    ...originalAction.result,
                    stdout: "parent changed after preflight",
                  },
                },
              })
              .where(eq(nodeAttempts.id, attempt.id));
            await capacity.query("SELECT pg_advisory_unlock_all()");
            await expect(staleClaim).resolves.toMatchObject({
              code: "CONFLICT",
              details: { causeCode: "gate_permission_result_generation" },
            });
            const [unchanged] = await db
              .select()
              .from(runs)
              .where(eq(runs.id, seeded.runId));

            expect(unchanged).toMatchObject({
              status: "NeedsInputIdle",
              executionAssignmentId: idle.executionAssignmentId,
            });
          } finally {
            await capacity.query("SELECT pg_advisory_unlock_all()");
            capacity.release();
            await staleClaim;
            await db
              .update(nodeAttempts)
              .set({ actionCompletion: originalAction })
              .where(eq(nodeAttempts.id, attempt.id));
          }
        }

        if (window === "capacity claim") {
          expect(
            await resumeRun(seeded.runId, { db, executionHosts: hosts }),
          ).toMatchObject({ ok: true, newSupervisorSessionId: null });
        } else if (window === "claim SIGKILL") {
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
          const reply = await respondToHitl(
            {
              runId: seeded.runId,
              hitlRequestId: hitl.id,
              body: { optionId: "allow" },
            },
            {
              kind: "user",
              userId: "gate-permission-user",
              label: "Gate test operator",
              preauthorizedProjectId: seeded.projectId,
            },
            { db, executionHosts: hosts },
          );

          expect(reply.status).toBe(202);
          expect(await reply.json()).toMatchObject({
            ok: true,
            state: "resume-in-progress",
            runStatus: "Running",
          });
        }
        const [claimed] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, seeded.runId));
        const [transferred] = await db
          .select()
          .from(gateResults)
          .where(eq(gateResults.id, evaluation.id));
        const [parent] = await db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.id, attempt.id));

        expect(transferred).toMatchObject({
          id: evaluation.id,
          promptOrdinal: 0,
          status: "passed",
          verdict: { verdict: "pass", reasons: ["original gate verified"] },
          permissionResume: {
            kind: "permission_result",
            promptOrdinal: 0,
            sourceCommandId: command.id,
            sourceAssignmentId: command.executionAssignmentId,
            sourceIncarnationId: incarnation.id,
            assignmentId: claimed.executionAssignmentId,
            inputCommandId: response._delivery.commandId,
            hitlRequestId: hitl.id,
            resumeSessionId: incarnation.acpSessionId,
          },
        });
        expect(parent).toMatchObject({
          executionAssignmentId: claimed.executionAssignmentId,
          actionPromptOrdinal: attempt.actionPromptOrdinal,
          actionCompletion: attempt.actionCompletion,
        });
        if (window === "capacity claim") {
          let rejected: ReturnType<typeof startProcess> | undefined;

          try {
            await db
              .update(gateResults)
              .set({
                verdict: {
                  ...transferred.verdict,
                  reasons: ["changed after result claim"],
                },
              })
              .where(eq(gateResults.id, evaluation.id));
            rejected = startProcess(
              "flow-prompt-owner-process.ts",
              seeded.runId,
            );
            await expect
              .poll(() => rejected?.child.exitCode, { timeout: 30_000 })
              .toBe(1);
            expect(
              await db
                .select()
                .from(executionCommands)
                .where(
                  and(
                    eq(executionCommands.runId, seeded.runId),
                    eq(
                      executionCommands.executionAssignmentId,
                      claimed.executionAssignmentId!,
                    ),
                  ),
                ),
            ).toHaveLength(0);
          } finally {
            rejected?.child.kill("SIGKILL");
            await rejected?.exited;
            await db
              .update(gateResults)
              .set({ verdict: transferred.verdict })
              .where(eq(gateResults.id, evaluation.id));
          }
        }
        if (window !== "response")
          continuation = startFlowContinuationWorker({
            db,
            runtimeRoot: supervisor.runtimeRoot,
            executionHosts: hosts,
          });
        await expect
          .poll(
            async () => {
              const [row] = await db
                .select()
                .from(runs)
                .where(eq(runs.id, seeded.runId));

              return row.status;
            },
            { timeout: 60_000 },
          )
          .toBe("Review");
        const prompts = await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );

        expect(
          prompts.filter(
            (row) =>
              row.ownerRef?.variant === "gate_ai" ||
              row.ownerRef?.variant === "gate_skill",
          ),
        ).toHaveLength(1);
        expect(
          prompts.filter((row) => row.ownerRef?.variant === "node"),
        ).toHaveLength(parentKind === "ai_coding" ? 1 : 0);
        expect(
          await readFile(
            `${seeded.worktreePath}/gate-permission-after.txt`,
            "utf8",
          ),
        ).toBe("after\n");
        if (parentKind === "cli")
          expect(
            await readFile(
              `${seeded.worktreePath}/gate-permission-work.txt`,
              "utf8",
            ),
          ).toBe("work\n");
        expect(
          await db
            .select()
            .from(gateResults)
            .where(eq(gateResults.runId, seeded.runId)),
        ).toHaveLength(1);
      } finally {
        driver.child.kill("SIGKILL");
        await driver.exited;
        claimant?.child.kill("SIGKILL");
        await claimant?.exited;
        await continuation?.stop();
      }
    },
    180_000,
  );
});
