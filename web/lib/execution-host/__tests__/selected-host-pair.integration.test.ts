import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHost } from "@/lib/db/schema";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";

import { executionHosts, executionEventStreams, workspaces } from "@/lib/db/schema";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { getCommand, listCommandsForRun } from "@/lib/execution-host/commands";
import { transportForExecutionHost } from "@/lib/execution-host/default-transport";
import { ensureLocalExecutionDataPlane } from "@/lib/execution-host/event-plane";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { canonicalLifecycleProjector } from "@/lib/execution-host/events/lifecycle-projector";
import { projectExecutionEvents } from "@/lib/execution-host/events/projector";
import { resolveTaskLaunchPlacement } from "@/lib/execution-host/project-preference";
import { hostForAssignment } from "@/lib/execution-host/resolver";
import { dispatchQueuedWorkspaceCommand } from "@/lib/execution-host/workspace-dispatch";
import { readAddressedWorkspaceStatus, reserveHostWorkspace } from "@/lib/execution-host/workspace-preparation";
import { seedProject, seedRun } from "@/test-support/execution-host-seed";
import { git, initRepo } from "@/test-support/git-fixture";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { startRealSupervisor } from "@/test-support/real-supervisor";

async function identityOf(url: string): Promise<{ hostKey: string; bootId: string }> {
  const health = await fetch(url + "/health");
  if (!health.ok) throw new Error("The fixture supervisor did not become healthy");
  return (await health.json()).host;
}

it("C-13 registers two independent peers and resolves B after A stops", async () => {
  const database = await startMainPostgresTestDb({ databaseName: "stage_c_host_pair" });
  const db = database.db as unknown as Db;
  const projectId = await seedProject(database.db);
  const root = await mkdtemp(join(tmpdir(), "stage-c-pair-source-"));
  const repository = await initRepo(join(root, "upstream"));
  const env = { MAISTER_WORKSPACE_REPOSITORIES: JSON.stringify({ [projectId]: repository }) };
  const a = await startRealSupervisor({ env });
  let b = await startRealSupervisor({ env });
  try {
    const [aIdentity, bIdentity] = await Promise.all([identityOf(a.url), identityOf(b.url)]);
    expect(aIdentity.hostKey).not.toBe(bIdentity.hostKey);
    vi.stubEnv("MAISTER_SUPERVISOR_URL", a.url);
    vi.stubEnv("MAISTER_SELECTED_EXECUTION_HOST_KEY", aIdentity.hostKey);
    vi.stubEnv("MAISTER_ADDITIONAL_EXECUTION_HOSTS", JSON.stringify([
      { url: b.url, hostKey: bIdentity.hostKey, displayName: "Independent B", projectIds: [projectId] },
    ]));
    const registered = await ensureLocalExecutionDataPlane({ db });
    if (registered.status !== "registered") throw new Error("A was not registered");
    const [peer] = await db.select().from(executionHosts).where(eq(executionHosts.hostKey, bIdentity.hostKey));
    expect(peer).toMatchObject({
      hostKey: bIdentity.hostKey, lastBootId: bIdentity.bootId, readiness: "ready", displayName: "Independent B",
    });
    expect(peer.id).not.toBe(registered.host.id);
    await expect(db.update(executionHosts).set({ readiness: "unknown" })
      .where(eq(executionHosts.id, registered.host.id))).rejects.toMatchObject({
      cause: { code: "P0001", message: expect.stringContaining("registry writer") },
    });

    const placement = await resolveTaskLaunchPlacement(db, {
      id: projectId, defaultExecutionHostId: null, executionHostPreferenceRevision: 0,
    }, peer.id);
    expect(placement?.hostOptions.defaultExecutionHostId).toBe(registered.host.id);
    expect(placement?.selection.effectiveExecutionHostId).toBe(peer.id);
    const commit = await git(repository, "rev-parse", "HEAD");
    const prepare = async (host: ExecutionHost, branch: string) => {
      const runId = await seedRun(database.db, { projectId, runKind: "flow", status: "Pending" });
      const assignment = await db.transaction(async (tx) => {
        const owner = await mintAssignment(tx, { runId, hostId: host.id, reason: "launch" });
        await reserveHostWorkspace(tx, { host, assignment: owner }, {
          projectId, branch, baseBranch: "main", baseCommit: commit,
        }, { mode: "ownWorktree", repositoryId: projectId, commit, inputDigest: "a".repeat(64) });
        return owner;
      });
      const [command] = await listCommandsForRun(db, runId);
      await dispatchQueuedWorkspaceCommand(db, { runId, commandId: command.id });
      return { runId, assignment, commandId: command.id };
    };
    const aRun = await prepare(registered.host, "host-a");
    const { runId, assignment, commandId } = await prepare(peer, "host-b");
    const readStream = async (hostId: string) => (await db.select().from(executionEventStreams)
      .where(eq(executionEventStreams.executionHostId, hostId)))[0];
    await vi.waitFor(async () => {
      expect((await readStream(registered.host.id))?.lastAckConfirmedSequence).toBe(0n);
      expect((await readStream(peer.id))?.lastAckConfirmedSequence).toBe(0n);
    });
    const aStream = await readStream(registered.host.id);
    const bStream = await readStream(peer.id);
    expect(aStream.streamId).not.toBe(bStream.streamId);
    const bTransport = transportForExecutionHost(peer);
    await expect(bTransport.getWorkspaceCommandReceipt?.(aRun.commandId)).resolves.toBeNull();
    await expect(bTransport.acknowledgeRuntimeEvents({
      streamId: aStream.streamId, throughSequence: "0",
    })).rejects.toMatchObject({ code: expect.any(String) });
    await projectExecutionEvents({ db, projector: canonicalLifecycleProjector, runId });
    expect(await getCommand(db, commandId)).toMatchObject({ state: "succeeded" });
    expect(await getCommand(db, aRun.commandId)).toMatchObject({ state: "accepted" });
    await projectExecutionEvents({ db, projector: canonicalLifecycleProjector, runId: aRun.runId });
    expect(await getCommand(db, aRun.commandId)).toMatchObject({ state: "succeeded" });
    const checkoutFor = async (id: string) => (await db.select().from(workspaces).where(eq(workspaces.runId, id)))[0];
    const aCheckout = await checkoutFor(aRun.runId);
    const bCheckout = await checkoutFor(runId);
    expect(aCheckout.executionWorkspaceId).not.toBe(bCheckout.executionWorkspaceId);
    expect(bCheckout).toMatchObject({ executionHostId: peer.id, worktreePath: null });
    await a.kill();
    expect((await ensureLocalExecutionDataPlane({ db })).status).toBe("unavailable");
    await expect(hostForAssignment(db, assignment)).resolves.toMatchObject({
      id: peer.id, hostKey: bIdentity.hostKey, readiness: "ready",
    });
    const binding = await createExecutionHosts({ db }).executionFor(runId, { assignmentId: assignment.id });
    await expect(binding.client.sessionsForRun()).resolves.toEqual([]);
    await expect(binding.admin.health()).resolves.toMatchObject({ kind: "ready", identity: bIdentity });
    await expect(readAddressedWorkspaceStatus(db, bCheckout)).resolves.toMatchObject({
      workspace: { handle: bCheckout.executionWorkspaceId, observedCommit: commit },
    });
    b = await b.restart();
    const restarted = await identityOf(b.url);
    expect(restarted.hostKey).toBe(bIdentity.hostKey);
    expect(restarted.bootId).not.toBe(bIdentity.bootId);
    await expect(hostForAssignment(db, assignment)).resolves.toMatchObject({
      id: peer.id, lastBootId: restarted.bootId,
    });
    await expect(bTransport.getWorkspaceCommandReceipt?.(commandId)).resolves.toMatchObject({
      phase: "completed", result: { workspace: { handle: bCheckout.executionWorkspaceId } },
    });
  } finally {
    await stopRuntimeEventConsumers();
    vi.unstubAllEnvs();
    await Promise.all([a.kill(), b.kill()]);
    await database.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
