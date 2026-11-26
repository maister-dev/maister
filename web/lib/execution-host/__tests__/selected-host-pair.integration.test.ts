import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHost } from "@/lib/db/schema";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";

import { WORKSPACE_WORKLOAD_FILE } from "../../../../runtime/workspace-prepare";
import { executionHosts, executionEventStreams, runs, workspaces } from "@/lib/db/schema";
import { mintAssignment, releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { getCommand, listCommandsForRun } from "@/lib/execution-host/commands";
import { transportForExecutionHost } from "@/lib/execution-host/default-transport";
import { ensureAdditionalExecutionDataPlane, ensureLocalExecutionDataPlane } from "@/lib/execution-host/event-plane";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { canonicalLifecycleProjector } from "@/lib/execution-host/events/lifecycle-projector";
import { projectExecutionEvents } from "@/lib/execution-host/events/projector";
import { recordHostPressureRefusal, recordHostPressureSample } from "@/lib/execution-host/host-pressure";
import { resolveTaskLaunchPlacement } from "@/lib/execution-host/project-preference";
import { hostForAssignment } from "@/lib/execution-host/resolver";
import { configuredAdditionalExecutionEndpoints } from "@/lib/execution-host/selected-endpoint";
import { advanceAddressedWorkspaceAdmission, dispatchQueuedWorkspaceCommand } from "@/lib/execution-host/workspace-dispatch";
import { readAddressedWorkspaceStatus, reserveHostWorkspace } from "@/lib/execution-host/workspace-preparation";
import { reserveWorkspaceWorkload } from "@/lib/execution-host/workspace-workloads";
import { promoteNextPending, tryStartRun } from "@/lib/scheduler";
import { seedProject, seedRun } from "@/test-support/execution-host-seed";
import { git, initRepo } from "@/test-support/git-fixture";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { startRealSupervisor } from "@/test-support/real-supervisor";

async function identityOf(url: string): Promise<{ hostKey: string; bootId: string }> {
  const health = await fetch(url + "/health");
  if (!health.ok) throw new Error("The fixture supervisor did not become healthy");
  return (await health.json()).host;
}

it("C-13/C-14 isolate transport and retain a slot through partition, restart and drain", async () => {
  const database = await startMainPostgresTestDb({ databaseName: "stage_c_host_pair" });
  const db = database.db as unknown as Db;
  const projectId = await seedProject(database.db);
  const root = await mkdtemp(join(tmpdir(), "stage-c-pair-source-"));
  const repository = await initRepo(join(root, "upstream"));
  const env = { MAISTER_WORKSPACE_REPOSITORIES: JSON.stringify({ [projectId]: repository }) };
  const a = await startRealSupervisor({ env });
  let b = await startRealSupervisor({ env });
  let partitioned = false;
  const connections = new Set<Socket>();
  const relay = createServer((client) => {
    if (partitioned) {
      client.destroy();
      return;
    }
    const endpoint = new URL(b.url);
    const upstream = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
    connections.add(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => { upstream.destroy(); connections.delete(client); });
    upstream.on("close", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", resolve);
    });
    const listener = relay.address();
    if (!listener || typeof listener === "string") throw new Error("No test relay port assigned");
    const peerUrl = `http://127.0.0.1:${listener.port}`;
    const [aIdentity, bIdentity] = await Promise.all([identityOf(a.url), identityOf(b.url)]);
    expect(aIdentity.hostKey).not.toBe(bIdentity.hostKey);
    vi.stubEnv("MAISTER_SUPERVISOR_URL", a.url);
    vi.stubEnv("MAISTER_SELECTED_EXECUTION_HOST_KEY", aIdentity.hostKey);
    const configurePeer = (draining = false): void => {
      vi.stubEnv("MAISTER_ADDITIONAL_EXECUTION_HOSTS", JSON.stringify([
        { url: peerUrl, hostKey: bIdentity.hostKey, displayName: "Independent B", projectIds: [projectId], maxConcurrentRuns: 1, draining },
      ]));
    };
    configurePeer();
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
        }, { mode: "ownWorktree", repositoryId: projectId, commit, inputDigest: "a".repeat(64) }, [{
          path: WORKSPACE_WORKLOAD_FILE,
          bytes: Buffer.from(JSON.stringify([{
            id: "hold-slot",
            workload: "check",
            command: 'printf "%s" "$$" > slot-started; while [ ! -f slot-finish ]; do sleep 0.1; done',
            timeoutMs: 30_000,
          }])),
        }]);
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
    const releaseRun = (id: string) => db.transaction(async (tx) => {
      await tx.update(runs).set({ status: "Done" }).where(eq(runs.id, id));
      await releaseAssignmentForRun(tx, id, "run_terminal");
    });

    const candidates = await Promise.all(["first", "second"].map(async () => {
      const candidate = await seedRun(database.db, { projectId, runKind: "flow", status: "Pending" });
      await db.transaction((tx) => mintAssignment(tx, { runId: candidate, hostId: peer.id, reason: "launch" }));
      return candidate;
    }));
    await vi.waitFor(async () => {
      await advanceAddressedWorkspaceAdmission(db, runId);
      await projectExecutionEvents({ db, projector: canonicalLifecycleProjector, runId });
      expect(await checkoutFor(runId)).toMatchObject({ workspaceMaterializationGeneration: 1 });
    });
    await expect(tryStartRun(runId, { db })).resolves.toMatchObject({ started: true });
    const workload = await reserveWorkspaceWorkload(db, {
      runId, assignmentId: assignment.id, declarationId: "hold-slot",
      operationKey: "capacity-test", workload: "check",
    });
    await dispatchQueuedWorkspaceCommand(db, { runId, commandId: workload.id });
    const state = new DatabaseSync(join(b.stateDir, "state.sqlite"), { readOnly: true });
    const repo = state.prepare("SELECT real_path FROM workspaces WHERE id = ?")
      .get(bCheckout.executionWorkspaceId!) as { real_path: string };
    state.close();
    await vi.waitFor(async () => {
      expect(await readFile(join(repo.real_path, "slot-started"), "utf8")).toMatch(/^\d+$/u);
      expect(await bTransport.getWorkspaceCommandReceipt?.(workload.id)).toMatchObject({ phase: "accepted" });
    });
    await releaseRun(runId);
    await expect(tryStartRun(candidates[0], { db })).resolves.toMatchObject({
      started: false, queueReason: "launch_execution_host_capacity",
    });
    await expect(db.transaction((tx) => mintAssignment(tx, { runId, hostId: peer.id, reason: "launch" })))
      .rejects.toMatchObject({ details: { reason: "execution_host_quiescence_pending" } });
    partitioned = true;
    for (const connection of connections) connection.destroy();
    const probePeer = () => ensureAdditionalExecutionDataPlane(configuredAdditionalExecutionEndpoints()[0], { db, healthTimeoutMs: 1_000 });
    await expect(probePeer()).resolves.toMatchObject({ status: "unavailable" });
    await expect(tryStartRun(candidates[0], { db })).resolves.toMatchObject({
      started: false, queueReason: "launch_execution_host_unavailable",
    });
    configurePeer(true);
    await writeFile(join(repo.real_path, "slot-finish"), "");
    await vi.waitFor(async () => {
      const state = new DatabaseSync(join(b.stateDir, "state.sqlite"), { readOnly: true });
      try {
        expect(state.prepare("SELECT phase FROM command_receipts WHERE command_id=?").get(workload.id))
          .toMatchObject({ phase: "completed" });
      } finally {
        state.close();
      }
    }, { timeout: 10_000 });
    b = await b.restart();
    expect((await identityOf(b.url)).bootId).not.toBe(restarted.bootId);
    expect(await getCommand(db, workload.id)).toMatchObject({ state: "accepted" });
    await expect(db.transaction((tx) => mintAssignment(tx, { runId, hostId: peer.id, reason: "launch" })))
      .rejects.toMatchObject({ details: { reason: "execution_host_quiescence_pending" } });
    partitioned = false;
    await expect(probePeer()).resolves.toMatchObject({ status: "registered" });
    await vi.waitFor(async () => {
      await projectExecutionEvents({ db, projector: canonicalLifecycleProjector, runId });
      expect(await getCommand(db, workload.id)).toMatchObject({ state: "succeeded", result: { quiescence: "proved" } });
    }, { timeout: 10_000 });
    await expect(tryStartRun(candidates[0], { db })).resolves.toMatchObject({
      started: false, queueReason: "launch_execution_host_draining",
    });
    configurePeer();
    await recordHostPressureRefusal(db, peer.id);
    await expect(tryStartRun(candidates[0], { db })).resolves.toMatchObject({
      started: false, queueReason: "host_pressured",
    });
    const health = await bTransport.platformStatus();
    if (health.kind !== "ready" || !health.health.stream) throw new Error("No B pressure sample");
    await expect(recordHostPressureSample({ db, hostKey: bIdentity.hostKey, stream: health.health.stream }))
      .resolves.toMatchObject({ transition: "cleared", hostId: peer.id });
    const decisions = await Promise.all(candidates.map((candidate) => tryStartRun(candidate, { db })));
    expect(decisions.filter(({ started }) => started)).toHaveLength(1);
    expect(decisions.find(({ started }) => !started)).toMatchObject({
      queueReason: "launch_execution_host_capacity",
    });
    const occupied = candidates[decisions.findIndex(({ started }) => started)];
    const queued = candidates[decisions.findIndex(({ started }) => !started)];
    await releaseRun(occupied);
    await releaseRun(aRun.runId);
    const next = await seedRun(database.db, { projectId, runKind: "flow", status: "Pending" });
    await db.transaction((tx) => mintAssignment(tx, { runId: next, hostId: peer.id, reason: "launch" }));
    await db.update(runs).set({ startedAt: new Date(0) }).where(eq(runs.id, queued));
    const dispatch = vi.fn(async () => {});
    await expect(promoteNextPending({ db, runFlow: dispatch })).resolves.toMatchObject({ promotedRunId: queued });
    expect(dispatch).toHaveBeenCalledWith(queued);
  } finally {
    await stopRuntimeEventConsumers();
    vi.unstubAllEnvs();
    for (const connection of connections) connection.destroy();
    if (relay.listening) await new Promise<void>((resolve, reject) => relay.close((error) => error ? reject(error) : resolve()));
    await Promise.all([a.kill(), b.kill()]);
    await database.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
