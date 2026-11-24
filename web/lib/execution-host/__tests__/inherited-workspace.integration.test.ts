import type { Db } from "../db";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";

import { WORKSPACE_WORKLOAD_FILE } from "../../../../runtime/workspace-prepare";

import { closeDb } from "@/lib/db/client";
import {
  artifactInstances,
  executionAssignments,
  nodeAttempts,
  runs,
  workspaces,
} from "@/lib/db/schema";
import { nodeWorkloadDeclarationId } from "@/lib/flows/addressed-workload-input";
import { git, initRepo } from "@/test-support/git-fixture";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  addProjectMember,
  seedActiveUser,
} from "@/test-support/librarian-seed";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { startRealSupervisor } from "@/test-support/real-supervisor";

import { mintPlacement } from "../placement";
import { ensureLocalExecutionHost } from "../registrar";
import { getCommand, insertCommand } from "../commands";
import { releaseAssignmentForRun } from "../assignments";
import { canonicalLifecycleProjector } from "../events/lifecycle-projector";
import {
  startRuntimeEventConsumer,
  stopRuntimeEventConsumers,
} from "../events/consumer";
import { projectExecutionEvents } from "../events/projector";
import { projectCanonicalRuntimeObjects } from "../events/runtime-object-projector";
import {
  startCanonicalProjectionWorker,
  stopCanonicalProjectionWorker,
} from "../events/projection-runtime";
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
const session = vi.hoisted(() => ({ userId: "" }));
const drivers = vi.hoisted(() => [] as Promise<void>[]);

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: session.userId } }),
}));

vi.mock("@/lib/flows/runner", async (importOriginal) => {
  const runner = await importOriginal<typeof import("@/lib/flows/runner")>();

  return {
    ...runner,
    runFlow: (...args: Parameters<typeof runner.runFlow>) => {
      const run = runner.runFlow(...args);
      drivers.push(run);

      return run;
    },
  };
});

afterEach(async () => {
  const results = await Promise.allSettled(drivers.splice(0));
  await stopCanonicalProjectionWorker();
  await stopRuntimeEventConsumers();
  await supervisor?.kill();
  await closeDb();
  vi.unstubAllEnvs();
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
});

async function prepareWorkspaceFixture() {
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
  session.userId = await seedActiveUser(database.db);
  const seeded = await seedGraphRun(
    database.db,
    {
      schemaVersion: 1,
      name: "Addressed takeover",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          finish: {
            human: { role: "maintainer", decisions: ["approve", "takeover"] },
          },
          transitions: { approve: "done", takeover: "validate" },
        },
        {
          id: "validate",
          type: "cli",
          action: { command: "printf 'validation continued'" },
          transitions: { success: "done" },
        },
      ],
    },
    {
      repoPath: join(root, "web-has-no-repo"),
      workspace: false,
      flowRevision: true,
      run: { status: "Pending", createdByUserId: session.userId },
    },
  );
  const { projectId, runId } = seeded;
  await rm(seeded.runtimeRoot, { recursive: true, force: true });
  await rm(seeded.worktreePath, { recursive: true, force: true });
  await addProjectMember(database.db, {
    userId: session.userId,
    projectId,
    role: "member",
  });
  vi.stubEnv("DB_URL", database.databaseUrl);
  vi.stubEnv("MAISTER_RUNTIME_ROOT", join(root, "manager-runtime"));
  supervisor = await startRealSupervisor({
    env: {
      MAISTER_WORKSPACE_REPOSITORIES: JSON.stringify({
        [projectId]: repository,
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
      { projectId, branch: "fixture", baseCommit: base },
      {
        mode: "ownWorktree",
        repositoryId: projectId,
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
              {
                id: nodeWorkloadDeclarationId("validate"),
                workload: "cli",
                command: "printf 'validation continued'",
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

  return {
    db,
    host,
    initial,
    base,
    projectId,
    repository,
    runId,
    readWorkspace,
    projectEvidence,
    patchOf,
    settle,
    supervisor,
  };
}

function privateCheckoutPath(
  owningHost: RealSupervisor,
  handle: string,
): string {
  const state = new DatabaseSync(join(owningHost.stateDir, "state.sqlite"), {
    readOnly: true,
  });
  try {
    const path = state
      .prepare("SELECT real_path AS path FROM workspaces WHERE id=?")
      .get(handle)?.path;
    if (typeof path !== "string")
      throw new Error("The supervisor did not retain the checkout");

    return path;
  } finally {
    state.close();
  }
}

it("C-10 projects a publication from the historical owner and holds removal until the outcome is verified", async () => {
  const {
    db,
    host,
    initial,
    projectId,
    repository,
    base,
    runId,
    readWorkspace,
    settle,
    supervisor: owningHost,
  } = await prepareWorkspaceFixture();
  const {
    executionWorkspaceId: handle,
    workspaceGeneration: generation,
    id,
  } = await readWorkspace();
  if (!handle || !generation)
    throw new Error("The publication fixture has no retained worktree");
  const privateCheckout = privateCheckoutPath(owningHost, handle);
  await git(repository, "config", "receive.denyCurrentBranch", "updateInstead");
  const targetRef = await git(repository, "symbolic-ref", "HEAD");
  await git(
    privateCheckout,
    "commit",
    "--allow-empty",
    "-m",
    "reviewed publication",
  );
  const head = await git(privateCheckout, "rev-parse", "HEAD");
  const claimId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.update(runs).set({ status: "Review" }).where(eq(runs.id, runId));
    await releaseAssignmentForRun(tx, runId, "run_terminal");
    await tx
      .update(workspaces)
      .set({
        promotionState: "claiming",
        promotionAttemptId: claimId,
        promotionClaimedAt: new Date(),
      })
      .where(eq(workspaces.id, id));
  });
  const pending = {
    kind: "workspace.publish" as const,
    runId,
    assignmentId: initial.id,
    hostId: host.id,
    assignmentEpoch: initial.epoch,
    targetSessionId: handle,
    maxAttempts: 3,
    driverless: true,
    payload: {
      generation,
      claimId,
      fence: 1,
      publication: "promote",
      expected: { head, remoteId: projectId, targetRef, priorTarget: base },
    },
  };
  await expect(
    insertCommand(db, {
      ...pending,
      payload: { ...pending.payload, claimId: randomUUID() },
    }),
  ).rejects.toMatchObject({
    cause: { constraint: "retained_workspace_publication_owner" },
  });
  const command = await insertCommand(db, pending);
  await expect(
    db
      .update(workspaces)
      .set({ removedAt: new Date() })
      .where(eq(workspaces.id, id)),
  ).rejects.toMatchObject({
    cause: { constraint: "unsettled_workspace_publication" },
  });
  expect(await git(repository, "rev-parse", targetRef)).toBe(base);
  await settle(command.id);
  expect(await git(repository, "rev-parse", targetRef)).toBe(head);
  expect(await getCommand(db, command.id)).toMatchObject({
    executionAssignmentId: initial.id,
    result: {
      publication: "promote",
      git: { generation, priorTarget: base, head, observedTarget: head },
    },
  });
  await db
    .update(workspaces)
    .set({ promotionState: "done" })
    .where(eq(workspaces.id, id));
}, 60_000);

it("C-09 keeps the same prepared checkout and reuses its checkpoint after a new epoch", async () => {
  const { db, host, initial, runId, readWorkspace, patchOf, settle } =
    await prepareWorkspaceFixture();
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

it("C-09 claims and returns operator commits from the selected supervisor through the normal Run routes", async () => {
  const {
    db,
    host,
    initial,
    base,
    runId,
    readWorkspace,
    supervisor: owningHost,
  } = await prepareWorkspaceFixture();
  await db
    .update(runs)
    .set({ status: "NeedsInput", currentStepId: "review" })
    .where(eq(runs.id, runId));
  await db.insert(nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: "review",
    nodeType: "human",
    attempt: 1,
    status: "NeedsInput",
    executionAssignmentId: initial.id,
  });
  const workspace = await readWorkspace();
  const handle = workspace.executionWorkspaceId;
  if (!handle) throw new Error("the takeover fixture has no prepared handle");
  const privateCheckout = privateCheckoutPath(owningHost, handle);
  const { POST: claim } =
    await import("@/app/api/runs/[runId]/takeover/claim/route");
  const { POST: returnClaim } =
    await import("@/app/api/runs/[runId]/takeover/return/route");
  const params = { params: Promise.resolve({ runId }) };
  const request = (action: string) =>
    new NextRequest(`http://localhost/api/runs/${runId}/takeover/${action}`, {
      method: "POST",
    });
  startCanonicalProjectionWorker();
  const claimed = await claim(request("claim"), params);
  const claimedBody = await claimed.json();
  expect(claimed.status, JSON.stringify(claimedBody)).toBe(200);
  expect(claimedBody).toMatchObject({
    worktreePath: null,
    executionHostId: host.id,
    workspaceHandle: handle,
  });
  expect(JSON.stringify(claimedBody)).not.toContain(privateCheckout);

  expect((await returnClaim(request("return"), params)).status).toBe(409);
  await writeFile(join(privateCheckout, "README.md"), "operator edit\n");
  expect((await returnClaim(request("return"), params)).status).toBe(409);
  await git(privateCheckout, "add", "--", "README.md");
  await git(
    privateCheckout,
    "-c",
    "user.name=Operator",
    "-c",
    "user.email=operator@example.test",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "operator changed the selected checkout",
  );
  const returned = await returnClaim(request("return"), params);
  expect(returned.status, await returned.clone().text()).toBe(200);
  await vi.waitFor(
    async () => {
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      expect(run.status).toBe("Review");
    },
    { timeout: 15_000 },
  );
  const history = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.runId, runId));
  expect(history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        epoch: 2,
        executionHostId: host.id,
        executionWorkspaceId: handle,
      }),
    ]),
  );
  const attempts = await db
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.runId, runId));
  expect(attempts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ownerUserId: session.userId,
        claimHeadSha: base,
      }),
      expect.objectContaining({
        nodeId: "validate",
        status: "Succeeded",
        stdout: "validation continued",
      }),
    ]),
  );
  const artifacts = await db
    .select()
    .from(artifactInstances)
    .where(eq(artifactInstances.runId, runId));
  expect(artifacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        producer: "takeover",
        kind: "diff",
        locator: { kind: "execution-object", objectId: expect.any(String) },
      }),
      expect.objectContaining({
        producer: "takeover",
        kind: "commit_set",
        locator: { kind: "execution-object", objectId: expect.any(String) },
      }),
    ]),
  );
}, 90_000);
