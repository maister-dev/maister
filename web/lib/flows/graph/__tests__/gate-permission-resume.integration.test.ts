import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  executionAssignments,
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
    databaseName: "flow_gate_permission_resumes",
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
): Readonly<{
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
}> {
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
                  ? { command: "/review" }
                  : { prompt: "Review the action and emit a pass verdict." }),
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

describe("Owned Flow checkpointed gate permission resume", () => {
  it.each([
    { gateKind: "ai_judgment", parentKind: "cli", window: "live" },
    { gateKind: "ai_judgment", parentKind: "cli", window: "response" },
    { gateKind: "skill_check", parentKind: "cli", window: "live" },
    { gateKind: "ai_judgment", parentKind: "ai_coding", window: "live" },
    { gateKind: "skill_check", parentKind: "cli", window: "claim SIGKILL" },
    { gateKind: "ai_judgment", parentKind: "cli", window: "resume refused" },
  ] as const)(
    "owner-flow-gate-resume: $gateKind after $parentKind ($window)",
    async ({ gateKind, parentKind, window }) => {
      const seeded = await seedGateFlow(gateKind, parentKind);
      const hosts = createExecutionHosts({ db });
      const driver = startProcess("flow-prompt-owner-process.ts", seeded.runId);
      let claimProcess: ReturnType<typeof startProcess> | undefined;
      let continuation:
        | ReturnType<typeof startFlowContinuationWorker>
        | undefined;

      try {
        if (parentKind === "ai_coding") {
          await expect
            .poll(
              async () => {
                const permissions = await db
                  .select()
                  .from(hitlRequests)
                  .where(eq(hitlRequests.runId, seeded.runId));

                return permissions.length;
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
              const permissions = await db
                .select()
                .from(hitlRequests)
                .where(eq(hitlRequests.runId, seeded.runId));

              return permissions.find(
                (hitl) =>
                  (hitl.schema as { flowPrompt?: { gateId?: string } })
                    .flowPrompt?.gateId === "review",
              );
            },
            { timeout: 45_000 },
          )
          .toMatchObject({ respondedAt: null });
        const permissions = await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.runId, seeded.runId));
        const hitl = permissions.find(
          (request) =>
            (request.schema as { flowPrompt?: { gateId?: string } }).flowPrompt
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
          .where(eq(nodeAttempts.runId, seeded.runId));
        const [incarnation] = await db
          .select()
          .from(runSessionIncarnations)
          .where(eq(runSessionIncarnations.id, source.incarnationId));

        startRuntimeEventConsumer({
          db,
          executionHostId: command.executionHostId,
          transport: hosts.transport,
        });
        expect(evaluation.status).toBe("running");
        expect(attempt.actionCompletion?.result.ok).toBe(true);
        await db
          .update(runs)
          .set({ keepaliveUntil: new Date(Date.now() - 1_000) })
          .where(eq(runs.id, seeded.runId));
        await runSweepTick({ db, executionHosts: hosts });
        await expect
          .poll(() => driver.child.exitCode, { timeout: 30_000 })
          .toBe(0);
        const [idle] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, seeded.runId));

        expect(idle.status).toBe("NeedsInputIdle");
        const file = path.join(journalPath, `${incarnation.acpSessionId}.json`);
        const journal = JSON.parse(await readFile(file, "utf8")) as Record<
          string,
          unknown
        >;

        await writeFile(
          file,
          JSON.stringify({
            ...journal,
            completionText: JSON.stringify({
              verdict: "pass",
              confidence: 0.99,
              reasons: ["resumed gate verified"],
            }),
            ...(window === "resume refused" ? { rejectResume: true } : {}),
          }),
        );
        await db
          .update(hitlRequests)
          .set({ response: { optionId: "allow" } })
          .where(eq(hitlRequests.id, hitl.id));
        if (window === "claim SIGKILL") {
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
          expect(claimProcess.child.kill("SIGKILL")).toBe(true);
          await claimProcess.exited;
          expect(claimProcess.child.signalCode).toBe("SIGKILL");
        } else if (window === "response") {
          const result = await respondToHitl(
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

          expect(result.status).toBe(202);
          expect(await result.json()).toMatchObject({
            ok: true,
            state: "resume-in-progress",
            runStatus: "NeedsInput",
          });
        } else {
          expect(
            await resumeRun(seeded.runId, { db, executionHosts: hosts }),
          ).toMatchObject({ ok: true, newSupervisorSessionId: null });
        }
        const [claimed] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, seeded.runId));
        const [resumed] = await db
          .select()
          .from(gateResults)
          .where(eq(gateResults.id, evaluation.id));
        const [parent] = await db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.id, attempt.id));

        expect(resumed).toMatchObject({
          id: evaluation.id,
          promptOrdinal: 1,
          permissionResume: {
            version: 1,
            kind: "permission",
            sourceCommandId: command.id,
            sourceAssignmentId: command.executionAssignmentId,
            assignmentId: claimed.executionAssignmentId,
            promptOrdinal: 1,
            hitlRequestId: hitl.id,
            resumeSessionId: incarnation.acpSessionId,
          },
        });
        expect(parent).toMatchObject({
          executionAssignmentId: claimed.executionAssignmentId,
          actionPromptOrdinal: attempt.actionPromptOrdinal,
          actionCompletion: attempt.actionCompletion,
        });
        if (
          window === "live" &&
          parentKind === "cli" &&
          gateKind === "skill_check"
        ) {
          if (!parent.actionCompletion)
            throw new Error("local parent action snapshot missing");
          let rejectedDriver: ReturnType<typeof startProcess> | undefined;

          try {
            await db
              .update(nodeAttempts)
              .set({
                actionCompletion: {
                  ...parent.actionCompletion,
                  result: {
                    ...parent.actionCompletion.result,
                    stdout: "changed after gate claim",
                  },
                },
              })
              .where(eq(nodeAttempts.id, parent.id));
            rejectedDriver = startProcess(
              "flow-prompt-owner-process.ts",
              seeded.runId,
            );
            await expect
              .poll(() => rejectedDriver?.child.exitCode, { timeout: 30_000 })
              .toBe(1);
            const rejectedCommands = await db
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
              );
            const [unchanged] = await db
              .select()
              .from(runs)
              .where(eq(runs.id, seeded.runId));

            expect(unchanged.status).toBe("NeedsInput");
            expect(rejectedCommands).toHaveLength(0);
          } finally {
            rejectedDriver?.child.kill("SIGKILL");
            await rejectedDriver?.exited;
            await db
              .update(nodeAttempts)
              .set({ actionCompletion: parent.actionCompletion })
              .where(eq(nodeAttempts.id, parent.id));
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
              const [run] = await db
                .select()
                .from(runs)
                .where(eq(runs.id, seeded.runId));

              return run.status;
            },
            { timeout: 60_000 },
          )
          .toBe(window === "resume refused" ? "Failed" : "Review");
        await continuation?.stop();
        continuation = undefined;
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
        const gatePrompts = prompts.filter(
          (prompt) =>
            prompt.ownerRef?.variant === "gate_ai" ||
            prompt.ownerRef?.variant === "gate_skill",
        );
        const gates = await db
          .select()
          .from(gateResults)
          .where(eq(gateResults.runId, seeded.runId));
        const work = await db
          .select()
          .from(nodeAttempts)
          .where(
            and(
              eq(nodeAttempts.runId, seeded.runId),
              eq(nodeAttempts.nodeId, "work"),
            ),
          );
        const assignments = await db
          .select()
          .from(executionAssignments)
          .where(eq(executionAssignments.runId, seeded.runId));

        expect(assignments).toHaveLength(2);
        expect(work).toHaveLength(1);
        expect(gates).toHaveLength(1);
        expect(gatePrompts).toHaveLength(window === "resume refused" ? 1 : 2);
        expect(
          prompts.filter((prompt) => prompt.ownerRef?.variant === "node"),
        ).toHaveLength(parentKind === "ai_coding" ? 1 : 0);
        if (window === "resume refused") {
          const creates = await db
            .select()
            .from(executionCommands)
            .where(
              and(
                eq(executionCommands.runId, seeded.runId),
                eq(
                  executionCommands.executionAssignmentId,
                  claimed.executionAssignmentId!,
                ),
                eq(executionCommands.kind, "session.create"),
              ),
            );

          expect(creates).toHaveLength(1);
          expect(creates[0]).toMatchObject({
            state: "failed",
            lastError: { code: "CHECKPOINT" },
            createIntent: { generation: 0, sessionFallback: false },
          });
          await expect(
            readFile(
              path.join(seeded.worktreePath, "gate-permission-after.txt"),
            ),
          ).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(gates[0]).toMatchObject({
            id: evaluation.id,
            status: "passed",
            verdict: { verdict: "pass", reasons: ["resumed gate verified"] },
          });
          expect(gatePrompts[1]).toMatchObject({
            executionAssignmentId: claimed.executionAssignmentId,
            state: "succeeded",
            applicationState: "applied",
            ownerRef: { evaluationId: evaluation.id, promptOrdinal: 1 },
          });
          const [responded] = await db
            .select()
            .from(hitlRequests)
            .where(eq(hitlRequests.id, hitl.id));

          expect(responded.respondedAt).toBeInstanceOf(Date);
          expect(
            await readFile(
              path.join(seeded.worktreePath, "gate-permission-after.txt"),
              "utf8",
            ),
          ).toBe("after\n");
        }
        if (parentKind === "cli")
          expect(
            await readFile(
              path.join(seeded.worktreePath, "gate-permission-work.txt"),
              "utf8",
            ),
          ).toBe("work\n");
      } finally {
        await continuation?.stop();
        claimProcess?.child.kill("SIGKILL");
        await claimProcess?.exited;
        driver.child.kill("SIGKILL");
        await driver.exited;
      }
    },
    160_000,
  );
});
