import type { Db } from "../db";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";

import { WORKSPACE_WORKLOAD_FILE } from "../../../../runtime/workspace-prepare";

import { closeDb } from "@/lib/db/client";
import { runs, workspaces } from "@/lib/db/schema";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import { git, initRepo } from "@/test-support/git-fixture";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { startRealSupervisor } from "@/test-support/real-supervisor";

import { mintPlacement } from "../placement";
import { ensureLocalExecutionHost } from "../registrar";
import { getCommand } from "../commands";
import { canonicalLifecycleProjector } from "../events/lifecycle-projector";
import {
  startRuntimeEventConsumer,
  stopRuntimeEventConsumers,
} from "../events/consumer";
import { projectExecutionEvents } from "../events/projector";
import { projectCanonicalRuntimeObjects } from "../events/runtime-object-projector";
import { createLocalDirectTransport } from "../transports/local-direct";
import { reserveWorkspaceGitOperation } from "../workspace-checkpoint";
import {
  advanceAddressedWorkspaceAdmission,
  dispatchQueuedWorkspaceCommand,
} from "../workspace-dispatch";
import { reserveHostWorkspace } from "../workspace-preparation";
import { readAddressedWorkspacePatch } from "../workspace-review";
import { reserveWorkspaceWorkload } from "../workspace-workloads";

let root: string | undefined;
let database: StartedPostgresTestDb | undefined;
let supervisor: RealSupervisor | undefined;

afterEach(async () => {
  await stopRuntimeEventConsumers();
  await supervisor?.kill();
  await closeDb();
  vi.unstubAllEnvs();
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

it("C-09 keeps the same prepared checkout and reuses its checkpoint after a new epoch", async () => {
  root = await mkdtemp(join(tmpdir(), "stage-c-inherited-workspace-"));
  const repository = await initRepo(join(root, "approved-source"));
  await writeFile(join(repository, "README.md"), "captured base\n");
  await git(repository, "add", "--", "README.md");
  await git(repository, "commit", "-m", "tracked starting state");
  const base = (await git(repository, "rev-parse", "HEAD")).trim();
  database = await startMainPostgresTestDb({
    databaseName: "eh_inherited_workspace",
  });
  const db = database.db as unknown as Db;
  const project = await seedProjectRow(database.db, {
    repoPath: join(root, "web-has-no-repo"),
  });
  const runId = await seedRun(database.db, {
    projectId: project.id,
    runKind: "flow",
    status: "Pending",
  });
  vi.stubEnv("DB_URL", database.databaseUrl);
  supervisor = await startRealSupervisor({
    env: {
      MAISTER_WORKSPACE_REPOSITORIES: JSON.stringify({
        [project.id]: repository,
      }),
    },
  });
  const health = (await (await fetch(supervisor.url + "/health")).json()) as {
    host: { hostKey: string };
  };
  vi.stubEnv("MAISTER_SUPERVISOR_URL", supervisor.url);
  vi.stubEnv("MAISTER_SELECTED_EXECUTION_HOST_KEY", health.host.hostKey);
  const transport = createLocalDirectTransport();
  const registration = await ensureLocalExecutionHost({ db, transport });
  if (registration.status !== "registered")
    throw new Error("fixture supervisor did not register");
  const { host } = registration;
  startRuntimeEventConsumer({ db, transport, executionHostId: host.id });
  const initial = await db.transaction(async (tx) => {
    const assignment = await mintPlacement(tx, {
      host,
      runId,
      reason: "launch",
    });
    await reserveHostWorkspace(
      tx,
      { host, assignment },
      { projectId: project.id, branch: "fixture", baseCommit: base },
      {
        mode: "ownWorktree",
        repositoryId: project.id,
        commit: base,
        inputDigest: "a".repeat(64),
      },
      [
        {
          path: WORKSPACE_WORKLOAD_FILE,
          bytes: Buffer.from(
            JSON.stringify([
              {
                id: "fixture-edit",
                workload: "cli",
                command: "printf 'after handoff\\n' > README.md",
                timeoutMs: 5_000,
              },
            ]),
          ),
        },
      ],
    );
    return assignment;
  });
  const readWorkspace = async () =>
    (await db.select().from(workspaces).where(eq(workspaces.runId, runId)))[0];
  const projectEvidence = async () => {
    await projectCanonicalRuntimeObjects({ db, runId });
    await projectExecutionEvents({
      db,
      projector: canonicalLifecycleProjector,
      runId,
    });
  };
  const settle = async (commandId: string): Promise<void> => {
    await dispatchQueuedWorkspaceCommand(db, { runId, commandId });
    await vi.waitFor(
      async () => {
        await projectEvidence();
        expect(await getCommand(db, commandId)).toMatchObject({
          state: "succeeded",
        });
      },
      { timeout: 10_000 },
    );
  };
  const patchOf = async (
    workspace: typeof workspaces.$inferSelect,
  ): Promise<string> => {
    let patch: string | undefined;
    const reading = readAddressedWorkspacePatch({
      db,
      workspace,
      range: { base },
      signal: AbortSignal.timeout(10_000),
    }).then(({ patch: observed }) => {
      patch = observed;
    });
    try {
      await vi.waitFor(
        async () => {
          await projectEvidence();
          expect(patch).toBeDefined();
        },
        { timeout: 10_000 },
      );
      if (patch === undefined)
        throw new Error("workspace evidence did not settle");
      return patch;
    } finally {
      await reading;
    }
  };
  await vi.waitFor(
    async () => {
      await advanceAddressedWorkspaceAdmission(db, runId);
      await projectEvidence();
      expect(await readWorkspace()).toMatchObject({
        worktreePath: null,
        workspaceMaterializationGeneration: 1,
      });
    },
    { timeout: 10_000 },
  );
  await db.update(runs).set({ status: "Running" }).where(eq(runs.id, runId));
  const checkpoint = await reserveWorkspaceGitOperation(db, {
    runId,
    assignmentId: initial.id,
    kind: "workspace.checkpoint",
    operationKey: "prior",
  });
  await settle(checkpoint.id);
  const workspace = await readWorkspace();
  await expect(
    db.transaction((tx) =>
      mintPlacement(tx, {
        runId,
        reason: "rework_return",
        host: { ...host, id: "substituted" },
      }),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const next = await db.transaction((tx) =>
    mintPlacement(tx, { runId, reason: "rework_return" }),
  );
  expect(next).toMatchObject({
    epoch: 2,
    executionHostId: host.id,
    executionWorkspaceId: workspace.executionWorkspaceId,
  });
  const workload = {
    runId,
    operationKey: "review-reentry",
    declarationId: "fixture-edit",
    workload: "cli" as const,
  };
  await expect(
    reserveWorkspaceWorkload(db, { ...workload, assignmentId: initial.id }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await settle(
    (await reserveWorkspaceWorkload(db, { ...workload, assignmentId: next.id }))
      .id,
  );
  expect(await patchOf(workspace)).toContain("+after handoff");
  const restore = await reserveWorkspaceGitOperation(db, {
    runId,
    assignmentId: next.id,
    kind: "workspace.restore",
    operationKey: "undo",
    checkpointId: checkpoint.id,
  });
  await settle(restore.id);
  expect((await readWorkspace()).preparationAssignmentId).toBe(initial.id);
  expect(await patchOf(workspace)).toBe("");
}, 60_000);
