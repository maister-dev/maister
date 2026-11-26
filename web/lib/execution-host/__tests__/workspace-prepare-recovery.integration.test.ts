import type { Db } from "../db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { WorkspacePrepareRequest } from "../../../../runtime/workspace-prepare";
import { inspectProcessGroup } from "../../../../runtime/process-group";
import { WORKSPACE_WORKLOAD_FILE } from "../../../../runtime/workspace-prepare";

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";

import { getAssignmentById } from "../assignments";
import { createExecutionHosts } from "../client";
import { getCommand, listCommandsForRun } from "../commands";
import {
  consumeRuntimeEventStreamOnce,
  startRuntimeEventConsumer,
  stopRuntimeEventConsumers,
} from "../events/consumer";
import { canonicalLifecycleProjector } from "../events/lifecycle-projector";
import { projectExecutionEvents } from "../events/projector";
import { projectCanonicalRuntimeObjects } from "../events/runtime-object-projector";
import { startCanonicalProjectionWorker, stopCanonicalProjectionWorker } from "../events/projection-runtime";
import { findStalledEventStreams } from "../events/stream-health";
import { mintPlacement } from "../placement";
import { buildEnvelope } from "../ledger";
import { recoverExecutionCommands } from "../recovery";
import { advanceAddressedWorkspaceAdmission, dispatchQueuedWorkspaceCommand } from "../workspace-dispatch";
import { ensureLocalExecutionHost } from "../registrar";
import { createLocalDirectTransport } from "../transports/local-direct";
import {
  readAddressedWorkspaceStatus,
  reserveHostWorkspace,
  workspacePreparationReadySql,
} from "../workspace-preparation";
import { readRuntimeObjectContent } from "../runtime-objects";
import { WorkspaceMaterializationPayloadSchema } from "../workspace-prepare-schema";
import { asExecutionWorkspaceId } from "../types";
import { reserveWorkspaceWorkload } from "../workspace-workloads";
import { reserveWorkspaceGitOperation } from "../workspace-checkpoint";

import { captureAddressedFlowContexts } from "@/lib/context-mounts/addressed-capture";
import { stageProjectFlowMemory } from "@/lib/agent-memory-vault/injection";
import { agentFacadeMcpServerForRun } from "@/lib/agents/launch";
import { issueProjectVaultNodeToken } from "@/lib/agents/tokens";
import { closeDb } from "@/lib/db/client";
import { cliOutputFilePath } from "@/lib/flows/graph/node-output";
import { runFlow } from "@/lib/flows/runner";
import { dispatchBoundTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";
import { runCliStep } from "@/lib/flows/runner-cli";
import { loadGitState } from "@/lib/workbench-git/read-model";
import {
  artifactInstances,
  agents,
  flows,
  flowRevisions,
  gateResults,
  nodeAttempts,
  packageInstalls,
  platformAcpRunners,
  projects,
  runs,
  taskLaunchIntents,
  tasks,
  workspaces,
} from "@/lib/db/schema";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import { acceptInteractiveTaskLaunch } from "@/lib/tasks/launch-intent";
import { prepareTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";
import { tryStartRun } from "@/lib/scheduler";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import { git, initRepo } from "@/test-support/git-fixture";
import { seedTaskLaunchFixture } from "@/test-support/task-launch-admission";
import { seedTaskAgentFlowFacadeFixture } from "@/test-support/task-agent-flow-facade";
import {
  addProjectMember,
  removeProjectMember,
  seedActiveUser,
} from "@/test-support/librarian-seed";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { freePort, startRealSupervisor } from "@/test-support/real-supervisor";

let root: string | undefined;
let supervisor: RealSupervisor | undefined;
let database: StartedPostgresTestDb | undefined;
let webServer: Server | undefined;
const session = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: session.userId } }),
}));

afterEach(async () => {
  await stopRuntimeEventConsumers();
  await supervisor?.kill();
  if (webServer)
    await new Promise<void>((resolve) => webServer!.close(() => resolve()));
  await closeDb();
  vi.unstubAllEnvs();
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function startVaultRoute(): Promise<{
  origin: string;
  outcomes: { status: number; reason?: string }[];
}> {
  const { POST } = await import("@/app/api/v1/ext/agent/memory/commands/route");
  const outcomes: { status: number; reason?: string }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (
        request.method !== "POST" ||
        request.url !== "/api/v1/ext/agent/memory/commands"
      ) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await POST(
        new Request(`http://localhost${request.url}`, {
          method: "POST",
          headers: {
            authorization: request.headers.authorization ?? "",
            "content-type":
              request.headers["content-type"] ?? "application/json",
          },
          body: Buffer.concat(chunks),
        }),
      );
      const body = (await result.json()) as { details?: { reason?: string } };
      outcomes.push({
        status: result.status,
        ...(body.details?.reason ? { reason: body.details.reason } : {}),
      });
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    })().catch((error: unknown) => {
      outcomes.push({
        status: 500,
        reason: error instanceof Error ? error.name : "unknown",
      });
      response.writeHead(500).end();
    });
  });
  webServer = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return { origin: `http://127.0.0.1:${address.port}`, outcomes };
}

it.each([
  { probe: "node --version", probeExit: 0 },
  { probe: "exit 42", probeExit: 42 },
])(
  "C-06/C-08 applies one checkout and the owning host's requirement result ($probeExit)",
  assertAddressedRequirement,
  120_000,
);

it.each([
  {
    outcome:
      "accepts a pathless board launch and runs its action and command gate in the selected checkout",
    refusedRoot: false,
  },
  {
    outcome:
      "holds a pathless board launch whose supervisor refuses the preparation root",
    refusedRoot: true,
  },
])(
  "C-05/C-08 $outcome",
  async ({ refusedRoot }) => {
    root = await mkdtemp(join(tmpdir(), "stage-c-pathless-graph-"));
    database = await startMainPostgresTestDb({
      databaseName: "eh_graph_workload",
    });
    const db = database.db as unknown as Db;
    const {
      userId,
      projectId,
      flowId,
      runnerId,
      repo: source,
    } = await seedTaskLaunchFixture(database, root);
    const adapter = refusedRoot ? "codex" : "claude";
    const runner = testPlatformRunnerRow(runnerId, adapter);
    await db.update(platformAcpRunners).set(runner)
      .where(eq(platformAcpRunners.id, runnerId));
    const commit = (await git(source, "rev-parse", "HEAD")).trim();
    const role = refusedRoot ? null : await seedTaskAgentFlowFacadeFixture(database, { root, projectId, flowId });
    const roleSource = role ? join(role.installedPath, "maister-agents", "facade.md") : null;
    if (role && roleSource) {
      await writeFile(roleSource, `---\nname: Host review\ndescription: Reviews the selected host checkout\nworkspace: worktree\nmode: subagent\ntriggers: [flow]\nrisk_tier: read_only\n---\nUse the pinned role bytes.\n`);
      await db.update(agents).set({ mode: "subagent", triggers: ["flow"] }).where(eq(agents.id, role.agentId));
    }
    const installedScript = join(root, "flow", "scripts", "check.sh");
    await mkdir(join(root, "flow", "scripts"), { recursive: true });
    const setupPath = join(root, "flow", "setup.sh");
    if (!refusedRoot)
      await writeFile(setupPath, "printf prepared >> setup-output.txt\n");
    await writeFile(
      installedScript,
      "#!/bin/sh\nset -eu\ntest \"$(cat \"$MAISTER_FLOW_DIR/setup-output.txt\")\" = prepared\ntest \"$(cat acp-marker)\" = 'written by addressed ACP'\nprintf 'from owning host' > graph-marker\ngit add -- graph-marker\ngit -c user.name=Fixture -c user.email=fixture@example.test -c commit.gpgSign=false -c core.hooksPath=/dev/null commit -qm 'fixture graph marker'\ncat graph-marker\nprintf '%s' '{\"verified\":true}' > \"$MAISTER_OUTPUT_FILE\"\n",
      { mode: 0o755 },
    );
    await writeFile(
      join(root, "flow", "result.json"),
      JSON.stringify({
        schemaVersion: 1,
        fields: [{ name: "verified", type: "boolean", required: true }],
      }),
    );
    const command = 'test "{{ task.title }}" = "Addressed task" && test "{{ env.LANG }}" = "C" && "$MAISTER_FLOW_DIR/scripts/check.sh"';
    const manifest = {
      schemaVersion: 1,
      name: "addressed-graph",
      compat: { engine_min: "1.2.0" },
      ...(!refusedRoot
        ? { requirements: [{ name: "Node runtime", probe: "node --version" }] }
        : {}),
      nodes: [
        {
          id: "edit",
          type: "ai_coding",
          ...(!refusedRoot ? {
            settings: {
              agent: role?.agentId,
              permissionMode: "deny",
              tools: { claude: ["Read"] },
              hooks: { pathGuard: { allowedPaths: ["src/**"] } },
            },
          } : {}),
          retry_policy: {
            attempts: 2,
            on_errors: ["SPAWN"],
            workspace: "rewind-to-node-checkpoint",
          },
          action: {
            prompt: `fixture-output:${JSON.stringify({
              bytes: 0,
              text: "addressed edit complete",
              writeWorkspaceMarker: true,
              expectedCapabilityAgent: runner.capabilityAgent,
            })}`,
          },
          transitions: { success: "work" },
        },
        {
          id: "work",
          type: "cli",
          action: { command },
          output: {
            result: { schema: "./result.json", required: true },
            produces: [{ id: "delta", kind: "diff", requiredFor: ["review"] }, { id: "commits", kind: "commit_set", requiredFor: ["review"] }],
          },
          pre_finish: {
            gates: [
              {
                id: "verify",
                kind: "command_check",
                mode: "blocking",
                command:
                  "test \"$(cat graph-marker)\" = 'from owning host' && printf 'gate saw host marker'",
              },
              { id: "node-changed", kind: "artifact_required", mode: "blocking", must_touch: ["graph-marker"] },
              { id: "prior-change", kind: "artifact_required", mode: "advisory", must_touch: ["acp-marker"] },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    };
    session.userId = userId;
    const managerRepoPath = join(root, "no-manager-checkout");
    await db
      .update(projects)
      .set({ repoPath: managerRepoPath })
      .where(eq(projects.id, projectId));
    await db.update(flows).set({ manifest }).where(eq(flows.id, flowId));
    await db
      .update(flowRevisions)
      .set({
        manifest,
        ...(!refusedRoot ? { setupStatus: "pending", execTrust: "trusted" } : {}),
      })
      .where(eq(flowRevisions.flowRefId, flowId));
    const taskId = randomUUID();
    await db.insert(tasks).values({
      id: taskId,
      projectId,
      number: 1,
      title: "Addressed task",
      prompt: "Run the approved check",
      flowId,
    });
    vi.stubEnv("DB_URL", database.databaseUrl);
    vi.stubEnv("MAISTER_RUNTIME_ROOT", join(root, "web"));
    vi.stubEnv("MAISTER_WORKTREES_ROOT", join(root, "web-worktrees"));
    vi.stubEnv("LANG", "en_US.UTF-8");
    supervisor = await startRealSupervisor({
      fixture: "mock-acp-lifecycle.mjs",
      fixtureAdapters: refusedRoot ? [adapter] : ["claude", "codex"],
      fixtureArgsByAdapter: { codex: [] },
      fixtureArgs: adapter === "claude" && runner.model
        ? ["--expect-native-model", runner.model, "--expect-claude-native"]
        : [],
      env: {
        LANG: "C",
        MAISTER_WORKSPACE_REPOSITORIES: JSON.stringify({ [projectId]: source }),
        ...(refusedRoot ? { MAISTER_WORKSPACE_ROOTS: source } : {}),
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
      throw new Error("graph fixture host failed registration");
    const { host } = registration;
    const { GET } = await import("@/app/api/runs/launch-options/route");
    const preview = await GET(
      new NextRequest(
        `http://localhost/api/runs/launch-options?taskId=${taskId}&executionHostId=${host.id}`,
      ),
    );
    const previewBody = (await preview.json()) as {
      settingsToken: string;
      task: { revision: number };
    };
    expect(preview.status, JSON.stringify(previewBody)).toBe(200);
    expect(previewBody).toMatchObject({
      branches: ["main"],
      executionHostSelection: {
        effectiveExecutionHostId: host.id,
        provenance: "explicit",
      },
      executionHostOptions: {
        defaultExecutionHostId: host.id,
        hosts: [{ id: host.id, displayName: host.displayName }],
      },
    });
    const accepted = await acceptInteractiveTaskLaunch(
      db,
      await interactiveTaskLaunchPrincipal(),
      {
        taskId,
        executionHostId: host.id,
        expectedTaskRevision: previewBody.task.revision,
        expectedSettingsToken: previewBody.settingsToken,
      },
      randomUUID(),
    );
    await writeFile(
      join(source, "after-acceptance.txt"),
      "a later upstream commit\n",
    );
    await git(source, "add", "--", "after-acceptance.txt");
    await git(
      source,
      "commit",
      "-m",
      "advance approved branch after acceptance",
    );
    const bound = await prepareTaskLaunchIntent(db, accepted.intentId);
    expect(bound).toMatchObject({
      state: "run_bound",
      runId: expect.any(String),
      snapshot: { baseCommit: commit },
    });
    if (!bound.runId) throw new Error("board intent did not bind a Run");
    if (roleSource) await writeFile(roleSource, "a later replacement");
    await writeFile(installedScript, "#!/bin/sh\nexit 73\n");
    if (!refusedRoot) await writeFile(setupPath, "exit 74\n");
    const { runId } = bound;
    const [intent] = await db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, bound.intentId));
    expect(intent.preparationIdentity).toMatchObject({
      version: 3,
      executionHostId: host.id,
      runId,
      worktreePath: null,
      parentRepoPath: null,
    });
    expect(await tryStartRun(runId, { db })).toMatchObject({ started: false });
    const projectEvidence = async (): Promise<void> => {
      await projectCanonicalRuntimeObjects({ db, runId });
      await projectExecutionEvents({
        db,
        projector: canonicalLifecycleProjector,
        runId,
      });
    };
    const applyCommand = async (
      commandId: string,
      state: "succeeded" | "failed" = "succeeded",
    ): Promise<void> => {
      await vi.waitFor(
        async () => {
          await projectEvidence();
          expect(await getCommand(db, commandId)).toMatchObject({
            state,
          });
        },
        { timeout: 10_000 },
      );
    };
    await advanceAddressedWorkspaceAdmission(db, runId);
    const [prepare] = await listCommandsForRun(db, runId);
    expect(prepare.kind).toBe("workspace.prepare");
    if (refusedRoot) {
      await applyCommand(prepare.id, "failed");
      await dispatchBoundTaskLaunchIntent(db, bound.intentId);
      const [held] = await db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.id, bound.intentId));
      expect(held).toMatchObject({
        state: "held",
        reason: "workspace_preparation_refused",
        dispatchCommittedAt: null,
      });
      expect(
        (await listCommandsForRun(db, runId)).map(({ kind }) => kind),
      ).toEqual(["workspace.prepare"]);
      return;
    }
    await applyCommand(prepare.id);
    await advanceAddressedWorkspaceAdmission(db, runId);
    const materialization = (await listCommandsForRun(db, runId)).find(
      ({ kind }) => kind === "workspace.materialize",
    );
    if (!materialization)
      throw new Error("launch did not reserve workspace materialization");
    await applyCommand(materialization.id);
    expect(await tryStartRun(runId, { db })).toMatchObject({ started: false });
    await db.update(flowRevisions).set({ execTrust: "untrusted" })
      .where(eq(flowRevisions.flowRefId, flowId));
    await expect(advanceAddressedWorkspaceAdmission(db, runId)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "launch_authority_revoked" },
    });
    expect((await listCommandsForRun(db, runId))
      .map(({ kind }) => kind).filter((kind) => kind.startsWith("workspace.")))
      .toEqual(["workspace.prepare", "workspace.materialize"]);
    await db.update(flowRevisions).set({ execTrust: "trusted" })
      .where(eq(flowRevisions.flowRefId, flowId));
    if (role) {
      await db.update(agents).set({ enabled: false }).where(eq(agents.id, role.agentId));
      await expect(advanceAddressedWorkspaceAdmission(db, runId)).rejects.toMatchObject({
        details: { reason: "launch_authority_revoked", agentId: role.agentId },
      });
      expect((await listCommandsForRun(db, runId)).some(({ kind }) => kind === "workspace.run"))
        .toBe(false);
      await db.update(agents).set({ enabled: true }).where(eq(agents.id, role.agentId));
    }
    await advanceAddressedWorkspaceAdmission(db, runId);
    const setup = (await listCommandsForRun(db, runId)).find(
      ({ kind, payload }) => kind === "workspace.run" && payload.workload === "setup",
    );
    if (!setup) throw new Error("Addressed launch did not reserve its frozen setup");
    await applyCommand(setup.id);
    expect(await getCommand(db, setup.id)).toMatchObject({
      result: { exitCode: 0, quiescence: "proved", processOutcome: "exited" },
    });
    expect(await tryStartRun(runId, { db })).toMatchObject({ started: false });
    await advanceAddressedWorkspaceAdmission(db, runId);
    const probe = (await listCommandsForRun(db, runId)).find(
      ({ kind, payload }) => kind === "workspace.run" && payload.workload === "requirementProbe",
    );
    if (!probe) throw new Error("Addressed launch did not reserve its requirement probe");
    await applyCommand(probe.id);
    expect(await tryStartRun(runId, { db })).toMatchObject({ started: true });
    const childAgent = await seedTaskAgentFlowFacadeFixture(database, { root, projectId, flowId });
    const childRunnerId = randomUUID();
    await db.insert(platformAcpRunners).values(testPlatformRunnerRow(childRunnerId, "codex"));
    await writeFile(join(childAgent.installedPath, "maister-agents", "facade.md"),
      "---\nname: Shared check\ndescription: Shared addressed child\nkind: code_delivery\nworkspace: worktree\nmode: session\ntriggers: [domain_event]\nrisk_tier: read_only\nplatform_mcp: false\n---\nCheck the retained parent worktree.\n");
    const skillPath = "skills/shared-check/SKILL.md";
    const skillContent = "---\nname: shared-check\ndescription: Verify the shared checkout\n---\nInspect the owning checkout.\n";
    await mkdir(join(childAgent.installedPath, "assets", "skills", "shared-check"), { recursive: true });
    await writeFile(join(childAgent.installedPath, "assets", skillPath), skillContent);
    await db.update(packageInstalls)
      .set({ manifest: { spec: { capabilities: [{ id: "shared-check", path: "assets" }] } } })
      .where(eq(packageInstalls.id, childAgent.packageInstallId));
    await db.update(agents).set({ triggers: ["domain_event"] }).where(eq(agents.id, childAgent.agentId));
    const childTaskId = randomUUID();
    await db.insert(tasks).values({
      id: childTaskId,
      projectId,
      number: 2,
      title: "Check the retained parent worktree",
      prompt: "Run within the original root",
      flowId,
    });
    const { addTaskRelation } = await import("@/lib/social/relations");
    const { establishExecutionChildAdmission } = await import("@/lib/tasks/qualification-admission");
    const { launchAgentRun, startAgentSession } = await import("@/lib/agents/launch");
    await addTaskRelation({
      projectId, fromTaskId: taskId, toTaskId: childTaskId,
      kind: "parent_of", actor: { type: "system", id: null },
    }, db);
    await db.transaction((tx) => establishExecutionChildAdmission(tx, {
      projectId, parentRunId: runId, childTaskId, planRevision: "addressed-root-v1",
    }));
    const child = await launchAgentRun({
      agentId: childAgent.agentId,
      projectId,
      taskId: childTaskId,
      workspace: "worktree",
      workspaceMode: "shared",
      launchOverrideRunnerId: childRunnerId,
      parentRunId: runId,
      rootRunId: runId,
      trigger: { source: "domain_event" },
      db,
    });
    if (!("queued" in child)) throw new Error("Shared child bypassed launch admission");
    expect(child.receipt.executionHostSelection).toMatchObject({
      effectiveExecutionHostId: host.id, provenance: "sharedRoot",
    });
    vi.stubEnv("MAISTER_SUPERVISOR_URL", `http://127.0.0.1:${await freePort()}`);
    try {
      const offline = await prepareTaskLaunchIntent(db, child.receipt.intentId);
      expect(offline).toMatchObject({
        state: "queued", runId: null, reason: "launch_execution_host_unavailable",
        executionHostSelection: child.receipt.executionHostSelection,
      });
    } finally {
      vi.stubEnv("MAISTER_SUPERVISOR_URL", supervisor.url);
    }
    const childIntent = await vi.waitFor(async () => {
      const receipt = await prepareTaskLaunchIntent(db, child.receipt.intentId);
      expect(receipt.state, JSON.stringify(receipt)).toBe("run_bound");
      return receipt;
    }, { timeout: 8_000 });
    expect(childIntent.state, JSON.stringify(childIntent)).toBe("run_bound");
    if (!childIntent.runId) throw new Error("Shared child has no reserved Run");
    const childRunId = childIntent.runId;
    const [preparedChild] = await db.select().from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, childIntent.intentId));
    expect(preparedChild.preparationIdentity).toMatchObject({
      version: 4, executionHostId: host.id,
      parentRepoPath: null, worktreePath: null, runtimePath: null,
    });
    for (const kind of ["workspace.prepare", "workspace.materialize"]) {
      await advanceAddressedWorkspaceAdmission(db, childRunId);
      await vi.waitFor(async () => {
        await projectCanonicalRuntimeObjects({ db, runId: childRunId });
        await projectExecutionEvents({ db, projector: canonicalLifecycleProjector, runId: childRunId });
        expect((await listCommandsForRun(db, childRunId)).find((command) => command.kind === kind))
          .toMatchObject({ state: "succeeded" });
      }, { timeout: 8_000 });
    }
    expect(await tryStartRun(childRunId, { db })).toMatchObject({ started: true });
    const childDriver = startAgentSession(childRunId, { db, signal: AbortSignal.timeout(12_000) });
    await expect(childDriver).resolves.toBeUndefined();
    const childCommands = await listCommandsForRun(db, childRunId);
    expect(childCommands.filter(({ kind }) => kind === "session.create")).toHaveLength(1);
    expect(childCommands.filter(({ kind }) => kind === "session.prompt")).toHaveLength(1);
    const preparedWorkspace = childCommands.find(({ kind }) => kind === "workspace.prepare");
    const materializedWorkspace = childCommands.find(({ kind }) => kind === "workspace.materialize");
    const manifestDigest = materializedWorkspace?.payload.manifestDigest;
    expect(manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(
      supervisor.runtimeRoot, ".maister", projectId, "runs", childRunId, "inputs",
      String(manifestDigest), "bundles", "0", skillPath,
    ), "utf8")).toBe(skillContent);
    const [childWorkspace] = await db.select().from(workspaces).where(eq(workspaces.runId, childRunId));
    const [rootWorkspace] = await db.select().from(workspaces).where(eq(workspaces.runId, runId));
    expect(childWorkspace).toMatchObject({
      rootWorkspaceId: rootWorkspace.id,
      baseCommit: commit,
      worktreePath: null,
      executionHostId: host.id,
    });
    const [dispatchedChild] = await db.select().from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, childIntent.intentId));
    expect(dispatchedChild.dispatchReceipt?.addressedPreparation).toMatchObject({
      workspaceId: childWorkspace.id,
      handle: expect.stringMatching(/^ws_[a-f0-9]{32}$/),
      generation: 1,
      materializationGeneration: 1,
    });
    expect(preparedWorkspace?.result).toMatchObject({
      workspace: { handle: dispatchedChild.dispatchReceipt?.addressedPreparation?.handle },
    });
    expect(dispatchedChild.dispatchReceipt?.addressedPreparation?.handle)
      .not.toBe(rootWorkspace.executionWorkspaceId);
    const runtimeRoot = join(root, "web");
    const firstDriver = new AbortController();
    const startDriver = (signal: AbortSignal) =>
      runFlow(runId, { db, runtimeRoot, signal }).then(
        () => ({ state: "returned" as const }),
        (error: unknown) => ({ state: "threw" as const, error }),
      );
    const findDeclaration = async (prefix: string) => {
      const commands = (await listCommandsForRun(db, runId)).filter(
        ({ kind, payload }) =>
          kind === "workspace.run" &&
          typeof payload.declarationId === "string" &&
          payload.declarationId.startsWith(prefix),
      );
      expect(commands).toHaveLength(1);

      return commands[0];
    };
    const first = startDriver(firstDriver.signal);
    let commandId: string;
    try {
      const queued = await vi.waitFor(async () => {
        await projectEvidence();
        return findDeclaration("node:");
      }, {
        timeout: 20_000,
      });
      commandId = queued.id;
    } finally {
      firstDriver.abort();
      expect(await first).toEqual({ state: "returned" });
    }

    const driving = startDriver(AbortSignal.timeout(20_000));
    try {
      for (const declaration of ["node:", "gate:"]) {
        const queued = await vi.waitFor(
          async () => {
            await projectEvidence();
            return findDeclaration(declaration);
          },
          {
            timeout: 6_000,
          },
        );
        if (declaration === "node:") expect(queued.id).toBe(commandId);
        await applyCommand(queued.id);
      }
      await vi.waitFor(
        async () => {
          await projectEvidence();
          expect(
            await db
              .select({ status: runs.status })
              .from(runs)
              .where(eq(runs.id, runId)),
          ).toEqual([{ status: "Review" }]);
        },
        { timeout: 10_000 },
      );
    } finally {
      expect(await driving).toEqual({ state: "returned" });
    }
    expect(
      await db
        .select({
          status: nodeAttempts.status,
          stdout: nodeAttempts.stdout,
          vars: nodeAttempts.vars,
        })
        .from(nodeAttempts)
        .where(
          and(eq(nodeAttempts.runId, runId), eq(nodeAttempts.nodeId, "work")),
        ),
    ).toMatchObject([
      {
        status: "Succeeded",
        stdout: "from owning host",
        vars: { verified: true },
      },
    ]);
    const [editAttempt] = await db
      .select({
        status: nodeAttempts.status,
        acpSessionId: nodeAttempts.acpSessionId,
        checkpointRef: nodeAttempts.checkpointRef,
      })
      .from(nodeAttempts)
      .where(
        and(eq(nodeAttempts.runId, runId), eq(nodeAttempts.nodeId, "edit")),
      );
    expect(editAttempt).toMatchObject({
      status: "Succeeded",
      acpSessionId: expect.stringMatching(/^mock-/),
      checkpointRef: expect.stringMatching(/^host-checkpoint:[0-9a-f-]{36}$/),
    });
    expect(
      await db
        .select({ gateId: gateResults.gateId, status: gateResults.status, verdict: gateResults.verdict })
        .from(gateResults)
        .where(eq(gateResults.runId, runId)),
    ).toEqual(expect.arrayContaining([
      {
        gateId: "verify",
        status: "passed",
        verdict: { verdict: "pass", reasons: ["gate saw host marker"] },
      },
      { gateId: "node-changed", status: "passed", verdict: { verdict: "pass", reasons: ["all 0 required artifact(s) present and current", "mutation assertions passed"] } },
      { gateId: "prior-change", status: "failed", verdict: { verdict: "fail", reasons: ["must_touch: no path matched [acp-marker]"], payload: { assertionFailed: true } } },
    ]));
    expect(
      await db
        .select({ path: workspaces.worktreePath })
        .from(workspaces)
        .where(eq(workspaces.runId, runId)),
    ).toEqual([{ path: null }]);
    expect(await findDeclaration("node:")).toMatchObject({
      id: commandId,
      state: "succeeded",
      attempts: 1,
    });
    const [delta] = await db.select().from(artifactInstances).where(and(
      eq(artifactInstances.runId, runId), eq(artifactInstances.artifactDefId, "delta"),
    ));
    expect(delta).toMatchObject({ kind: "diff", validity: "current", hash: expect.stringMatching(/^[a-f0-9]{64}$/), locator: { kind: "execution-object" } });
    if (delta.locator.kind !== "execution-object") throw new Error("diff is not a retained object");
    const capturedDiff = await readRuntimeObjectContent({ db, runId, objectId: delta.locator.objectId });
    expect(capturedDiff.object.sha256).toBe(delta.hash);
    expect(delta.sizeBytes).toBe(capturedDiff.content.bytes.byteLength);
    expect(Buffer.from(capturedDiff.content.bytes).toString()).toContain("+from owning host");
    const [commits] = await db.select().from(artifactInstances).where(and(
      eq(artifactInstances.runId, runId), eq(artifactInstances.artifactDefId, "commits"),
    ));
    expect(commits).toMatchObject({ kind: "commit_set", validity: "current", locator: { kind: "execution-object" } });
    if (commits.locator.kind !== "execution-object") throw new Error("commit set is not a retained object");
    const capturedCommits = await readRuntimeObjectContent({ db, runId, objectId: commits.locator.objectId });
    expect(capturedCommits.object.sha256).toBe(commits.hash);
    expect(Buffer.from(capturedCommits.content.bytes).toString()).toMatch(/^[0-9a-f]+ fixture graph marker\n$/);
    const [defaultDiff] = await db.select().from(artifactInstances).where(and(
      eq(artifactInstances.runId, runId), eq(artifactInstances.artifactDefId, "default:work:diff"),
    ));
    expect(defaultDiff).toMatchObject({ kind: "diff", validity: "current", locator: { kind: "execution-object" } });
    if (defaultDiff.locator.kind !== "execution-object") throw new Error("default diff is not a retained object");
    const payload = await readRuntimeObjectContent({ db, runId, objectId: defaultDiff.locator.objectId });
    const defaultPatch = Buffer.from(payload.content.bytes).toString();
    expect(defaultPatch).toContain("+from owning host");
    expect(defaultPatch).not.toContain("acp-marker");
    const { GET: getIntent } = await import("@/app/api/task-launch-intents/[intentId]/route");
    const receipt = await getIntent(
      new Request(`http://localhost/api/task-launch-intents/${bound.intentId}`),
      { params: Promise.resolve({ intentId: bound.intentId }) },
    );
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({
      runStatus: "Review",
      executionHostSelection: { requestedExecutionHostId: host.id, effectiveExecutionHostId: host.id },
      executionHostPlacement: {
        savedDisplayName: host.displayName,
        actual: { executionHostId: host.id, displayName: host.displayName, assignmentEpoch: 1 },
      },
    });
    const { GET: getDiff } = await import("@/app/api/runs/[runId]/diff/route");
    const lastNodeDiff = getDiff(
      new Request(`http://localhost/api/runs/${runId}/diff?scope=last-node&raw=1`),
      { params: Promise.resolve({ runId }) },
    );
    let stopProjecting = false;
    const projection = vi.waitFor(async () => {
      await projectEvidence();
      expect(stopProjecting).toBe(true);
    }, { timeout: 12_000 });
    try {
      const response = await lastNodeDiff;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        scope: "last-node",
        scopes: { "last-node": { available: true } },
        baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
        diff: expect.stringContaining("+from owning host"),
      });
      const review = await getDiff(
        new Request(`http://localhost/api/runs/${runId}/diff?scope=review`),
        { params: Promise.resolve({ runId }) },
      );
      expect(review.status).toBe(200);
      const { reviewSourceFingerprint } = await review.json() as { reviewSourceFingerprint: string };
      expect(reviewSourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
      const { GET: getSummary } = await import("@/app/api/runs/[runId]/change-summary/route");
      const summary = await getSummary(
        new Request(`http://localhost/api/runs/${runId}/change-summary?scope=review`),
        { params: Promise.resolve({ runId }) },
      );
      expect(summary.status).toBe(200);
      expect(await summary.json()).toMatchObject({
        reviewSourceFingerprint,
        files: expect.arrayContaining([{ path: "acp-marker", status: "A", additions: 1, deletions: 0, binary: false }]),
      });
    } finally {
      stopProjecting = true;
      await projection;
    }
  },
  90_000,
);

async function assertAddressedRequirement({
  probe,
  probeExit,
}: {
  probe: string;
  probeExit: number;
}): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "stage-c-preparation-recovery-"));
  const source = await initRepo(join(root, "origin"));
  await writeFile(join(source, "input.txt"), "original source\n");
  await git(source, "add", "--", "input.txt");
  await git(source, "commit", "-m", "tracked source for revision fixture");
  const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  database = await startMainPostgresTestDb({
    databaseName: "eh_prepare_recovery",
  });
  const db = database.db as unknown as Db;
  const project = await seedProjectRow(database.db, {
    repoPath: join(root, "manager-has-no-checkout"),
  });
  const sibling = await seedProjectRow(database.db, {
    repoPath: join(root, "manager-has-no-context-checkout"),
  });
  const siblingSource = await initRepo(join(root, "sibling-origin"));
  const userId = await seedActiveUser(database.db);
  session.userId = userId;
  const siblingGrant = {
    userId,
    projectId: sibling.id,
    role: "member",
  } as const;
  await addProjectMember(database.db, {
    userId,
    projectId: project.id,
    role: "member",
  });
  await addProjectMember(database.db, siblingGrant);
  vi.stubEnv("DB_URL", database.databaseUrl);
  vi.stubEnv("MAISTER_RUNTIME_ROOT", join(root, "web-runtime"));
  const web = await startVaultRoute();
  vi.stubEnv("MAISTER_API_BASE_URL", web.origin);
  supervisor = await startRealSupervisor({
    fixture: "mock-acp-librarian.mjs",
    env: {
      MAISTER_API_BASE_URL: web.origin,
      MAISTER_WORKSPACE_REPOSITORIES: JSON.stringify({
        [project.id]: source,
        [sibling.id]: siblingSource,
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
    throw new Error("selected host failed registration");
  const { host } = registration;
  const runId = await seedRun(database.db, {
    projectId: project.id,
    runKind: "flow",
    status: "Pending",
  });
  await database.pool.query(
    "UPDATE runs SET created_by_user_id = $2 WHERE id = $1",
    [runId, userId],
  );
  const contexts = await captureAddressedFlowContexts(
    db,
    [
      {
        stepId: "step-1",
        repositories: [{ project: sibling.slug }],
      },
    ],
    userId,
  );
  const installed = join(root, "installed-package");
  await mkdir(installed);
  const instructions = join(installed, "instructions.md");
  await writeFile(instructions, "# sealed instructions");
  const capture = [
    { path: "instructions.md", bytes: await readFile(instructions) },
    ...contexts,
    {
      path: WORKSPACE_WORKLOAD_FILE,
      bytes: Buffer.from(
        JSON.stringify([
          {
            id: "probe:0",
            workload: "requirementProbe",
            command: probe,
            timeoutMs: 10_000,
          },
          {
            id: "fixture-check",
            workload: "check",
            command:
              "printf 'check diagnostic'; printf '%s' '{\"verified\":true}' > \"$MAISTER_OUTPUT_FILE\"",
            timeoutMs: 5000,
            structuredOutput: "jsonFile",
          },
          {
            id: "crash-check",
            workload: "check",
            command:
              "printf 'started\\n' >> .workload-crash-fixture; for ((i=0;i<200;i++)); do test -f .workload-crash-release && exit 0; sleep 0.1; done; exit 1",
            timeoutMs: 25_000,
          },
          {
            id: "stop-check",
            workload: "check",
            command: "printf 'partial stop output'; : > .stop-ready; for ((i=0;i<400;i++)); do test -f .stop-release && exit 0; sleep 0.1; done; exit 1",
            timeoutMs: 45_000,
          },
        ]),
      ),
    },
  ];
  const assignment = await db.transaction(async (tx) => {
    const placed = await mintPlacement(tx as unknown as Db, {
      runId,
      reason: "launch",
      host,
    });
    await reserveHostWorkspace(
      tx as unknown as Db,
      { host, assignment: placed },
      { projectId: project.id, branch: "fixture", baseCommit: commit },
      {
        mode: "ownWorktree",
        repositoryId: project.id,
        commit,
        inputDigest: "2".repeat(64),
      },
      capture,
      { requirementProbeCount: 1 },
    );
    return placed;
  });
  const [queued] = await listCommandsForRun(db, runId);
  const dropAcceptance = {
    ...transport,
    async sendWorkspacePreparation(input: WorkspacePrepareRequest) {
      await transport.sendWorkspacePreparation!(input);
      throw new Error("fixture lost the accepted reply");
    },
  };
  const delivery = await recoverExecutionCommands({
    db,
    transport: dropAcceptance,
    graceMs: 0,
  });
  expect(delivery.errors).toHaveLength(1);

  // An authority-independent SSE consumer can commit and ACK the original
  // event even if the owner projection cannot yet commit.
  const ingest = await consumeRuntimeEventStreamOnce({
    db,
    executionHostId: host.id,
    transport,
    owner: "fixture",
    maxEvents: 1,
    signal: AbortSignal.timeout(15_000),
  });
  expect(ingest).toMatchObject({ received: 1, acknowledged: 1 });
  const readWorkspace = async () =>
    (await db.select().from(workspaces).where(eq(workspaces.runId, runId)))[0];
  expect((await readWorkspace()).executionWorkspaceId).toBeNull();
  const projectedAt = new Date();
  await database.pool.query(`
    CREATE FUNCTION receipt_application_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'fixture rolls back owner application';
    END $$;
    CREATE TRIGGER receipt_application_fault BEFORE UPDATE OF execution_workspace_id ON workspaces
    FOR EACH ROW EXECUTE FUNCTION receipt_application_fault();
  `);
  try {
    const failed = await projectExecutionEvents({
      db,
      projector: canonicalLifecycleProjector,
      runId,
      now: projectedAt,
    });
    expect(failed.projected).toBe(0);
    expect((await readWorkspace()).executionWorkspaceId).toBeNull();
  } finally {
    await database.pool.query(
      "DROP TRIGGER receipt_application_fault ON workspaces",
    );
    await database.pool.query("DROP FUNCTION receipt_application_fault()");
  }

  const output = execFileSync(
    process.execPath,
    [
      "--import",
      resolve("node_modules/tsx/dist/loader.mjs"),
      "--import",
      resolve("scripts/_register-shim.mjs"),
      resolve("test-support/workspace-prepare-projection-worker.ts"),
      runId,
      new Date(projectedAt.getTime() + 60_000).toISOString(),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DB_URL: database.databaseUrl,
        TSX_TSCONFIG_PATH: resolve("tsconfig.json"),
      },
      timeout: 15_000,
    },
  );
  const marker = "workspace-projection ";
  const line = output.split("\n").find((entry) => entry.startsWith(marker));
  if (!line)
    throw new Error("replacement worker returned no projection summary");
  const after = JSON.parse(line.slice(marker.length)) as {
    pid: number;
    projected: number;
  };
  expect(after.pid).not.toBe(process.pid);
  expect(after.projected).toBe(1);
  const [applied] = await listCommandsForRun(db, runId);
  expect(applied).toMatchObject({
    id: queued.id,
    state: "succeeded",
    attempts: 1,
  });
  const workspace = await readWorkspace();
  expect(workspace.executionWorkspaceId).toMatch(/^ws_[a-f0-9]{32}$/);
  expect(workspace.worktreePath).toBeNull();
  expect(
    (await getAssignmentById(db, assignment.id))?.executionWorkspaceId,
  ).toBe(workspace.executionWorkspaceId);
  expect(await readAddressedWorkspaceStatus(db, workspace, transport)).toEqual({
    workspace: {
      handle: workspace.executionWorkspaceId,
      generation: workspace.workspaceGeneration,
      mode: "ownWorktree",
      observedCommit: commit,
    },
    workingTree: "clean",
    headState: "detached",
  });
  const gitPanel = await loadGitState({
    db,
    runId,
    viewerUserId: userId,
    origin: web.origin,
  });
  expect(gitPanel).toMatchObject({
    head: commit,
    worktreePresent: true,
    workspaceStatus: { workingTree: "clean", headState: "detached" },
  });
  expect(JSON.stringify(gitPanel)).not.toContain(supervisor.runtimeRoot);

  expect(workspace.workspaceMaterializationGeneration).toBeNull();
  await writeFile(instructions, "# updated after acceptance");
  await removeProjectMember(database.db, siblingGrant);
  const revoked = await recoverExecutionCommands({ db, transport, graceMs: 0 });
  expect(revoked.errors).toEqual([
    `workspace inputs ${runId}: launch_authority_revoked`,
  ]);
  expect((await listCommandsForRun(db, runId)).map(({ kind }) => kind)).toEqual(
    ["workspace.prepare"],
  );
  await addProjectMember(database.db, siblingGrant);
  const materializationDelivery = await recoverExecutionCommands({
    db,
    transport,
    graceMs: 0,
  });
  expect(materializationDelivery.redelivered).toBe(1);
  expect(materializationDelivery.errors).toEqual([]);
  const inputEvents = await consumeRuntimeEventStreamOnce({
    db,
    executionHostId: host.id,
    transport,
    owner: "fixture",
    maxEvents: 9,
    signal: AbortSignal.timeout(15_000),
  });
  expect(inputEvents).toMatchObject({
    received: 9,
    reconnectRequired: false,
  });
  const confirmed = await database.pool.query<{ confirmed: string }>(
    `SELECT last_ack_confirmed_sequence::text AS confirmed FROM execution_event_streams
     WHERE execution_host_id = $1 AND state = 'active'`,
    [host.id],
  );
  expect(confirmed.rows).toEqual([{ confirmed: "9" }]);
  await projectExecutionEvents({
    db,
    projector: canonicalLifecycleProjector,
    runId,
    now: new Date(projectedAt.getTime() + 90_000),
  });
  expect((await readWorkspace()).workspaceMaterializationGeneration).toBe(1);
  const command = (await listCommandsForRun(db, runId)).find(
    ({ kind }) => kind === "workspace.materialize",
  );
  expect(command).toMatchObject({
    kind: "workspace.materialize",
    state: "succeeded",
    attempts: 1,
  });
  if (!command)
    throw new Error("prepared workspace did not issue its input command");
  const receipt = await transport.getWorkspaceCommandReceipt!(command.id);
  const client = await createExecutionHosts({ db, transport }).forAssignment({
    id: assignment.id,
  });
  if (
    receipt?.phase !== "completed" ||
    receipt.operationId !== "stageCMaterialize"
  )
    throw new Error("host did not retain the completed input receipt");
  const payload = WorkspaceMaterializationPayloadSchema.parse(command.payload);
  expect(receipt.result.manifestDigest).toBe(payload.manifestDigest);
  await projectCanonicalRuntimeObjects({ db, runId });
  const { content } = await readRuntimeObjectContent({
    db,
    runId,
    objectId: payload.objects[2].objectId,
    transportForHost: async () => transport,
  });
  expect(Buffer.from(content.bytes).toString("utf8")).toBe(
    "# sealed instructions",
  );
  expect(client.assignment.executionWorkspaceId).toBe(
    workspace.executionWorkspaceId,
  );

  const launchReady = async (): Promise<boolean> => {
    const readiness = await db.execute<{ ready: boolean }>(
      sql`SELECT ${workspacePreparationReadySql(sql`${runId}`)} AS ready`,
    );

    return readiness.rows[0].ready;
  };
  expect(await launchReady()).toBe(false);
  expect(
    await recoverExecutionCommands({ db, transport, graceMs: 0 }),
  ).toMatchObject({ errors: [], redelivered: 1 });
  const probeEvents = await consumeRuntimeEventStreamOnce({
    db,
    executionHostId: host.id,
    transport,
    owner: "fixture",
    maxEvents: 3,
    signal: AbortSignal.timeout(15_000),
  });
  expect(probeEvents).toMatchObject({ received: 3, reconnectRequired: false });
  expect(await launchReady()).toBe(false);
  await projectExecutionEvents({
    db,
    projector: canonicalLifecycleProjector,
    runId,
    now: new Date(projectedAt.getTime() + 105_000),
  });
  expect(await launchReady()).toBe(probeExit === 0);
  const admittedProbes = (await listCommandsForRun(db, runId)).filter(
    ({ kind }) => kind === "workspace.run",
  );
  expect(admittedProbes).toEqual([
    expect.objectContaining({
      payload: expect.objectContaining({
        workload: "requirementProbe",
        declarationId: "probe:0",
      }),
      state: "succeeded",
      result: expect.objectContaining({
        exitCode: probeExit,
        quiescence: "proved",
      }),
    }),
  ]);
  if (probeExit !== 0) {
    const run = await database.pool.query(
      "SELECT status FROM runs WHERE id=$1",
      [runId],
    );
    expect(run.rows).toEqual([{ status: "Failed" }]);
    expect(await getAssignmentById(db, assignment.id)).toMatchObject({
      state: "released",
      releasedReason: "workspace_requirement_failed",
    });
    expect((await readWorkspace()).executionWorkspaceId).toBe(
      workspace.executionWorkspaceId,
    );

    return;
  }

  await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
    runId,
  ]);
  const workloadIntent = {
    runId,
    assignmentId: assignment.id,
    operationKey: "fixture-check-0",
    workload: "check",
    declarationId: "fixture-check",
  } as const;
  const workload = await reserveWorkspaceWorkload(db, workloadIntent);
  expect((await reserveWorkspaceWorkload(db, workloadIntent)).id).toBe(
    workload.id,
  );
  const action = runCliStep(
    {
      id: "fixture-check",
      type: "cli",
      command:
        "printf 'check diagnostic'; printf '%s' '{\"verified\":true}' > \"$MAISTER_OUTPUT_FILE\"",
    },
    {
      runtimeRoot: join(root, "web-runtime"),
      projectSlug: project.slug,
      runId,
      stepId: "fixture-check",
      attempt: 1,
      timeoutMs: 5000,
      workload: { db, ...workloadIntent },
      context: {
        task: {
          id: "fixture-check",
          title: "Fixture",
          prompt: "",
          effectivePrompt: "",
          clarifications: [],
          attemptNumber: 1,
        },
        run: { id: runId, attemptNumber: 1, projectSlug: project.slug },
        executor: { id: "fixture", agent: "claude", model: "fixture" },
        steps: {},
        env: {},
        artifacts: {},
      },
    },
  ).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  const workEvents = await consumeRuntimeEventStreamOnce({
    db,
    executionHostId: host.id,
    transport,
    owner: "fixture",
    maxEvents: 4,
    signal: AbortSignal.timeout(15_000),
  });
  expect(workEvents).toMatchObject({ received: 4, reconnectRequired: false });
  await projectExecutionEvents({
    db,
    projector: canonicalLifecycleProjector,
    runId,
    now: new Date(projectedAt.getTime() + 120_000),
  });
  await projectCanonicalRuntimeObjects({ db, runId });
  const appliedWork = await getCommand(db, workload.id);
  expect(appliedWork).toMatchObject({
    state: "succeeded",
    result: {
      exitCode: 0,
      checkValidity: "valid",
      outputState: "sealed",
      quiescence: "proved",
    },
  });
  expect(await action).toMatchObject({
    result: {
      ok: true,
      stdout: "check diagnostic",
      originalOutput: { kind: "value", value: { verified: true } },
    },
  });
  await expect(
    readFile(
      cliOutputFilePath({
        runtimeRoot: join(root, "web-runtime"),
        projectSlug: project.slug,
        runId,
        nodeId: "fixture-check",
        attempt: 1,
      }),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });

  const crashWork = await reserveWorkspaceWorkload(db, {
    ...workloadIntent,
    operationKey: "crash-check-0",
    declarationId: "crash-check",
  });
  supervisor = await supervisor.restart();
  expect(await transport.getWorkspaceCommandReceipt!(crashWork.id)).toBeNull();
  expect(
    await recoverExecutionCommands({ db, transport, graceMs: 0 }),
  ).toMatchObject({ errors: [], redelivered: 1 });
  const hostDb = new DatabaseSync(join(supervisor.stateDir, "state.sqlite"), {
    readOnly: true,
  });
  const owned = (() => {
    try {
      return hostDb
        .prepare("SELECT real_path AS path FROM workspaces WHERE id = ?")
        .get(workspace.executionWorkspaceId) as { path: string };
    } finally {
      hostDb.close();
    }
  })();
  const markerPath = join(owned.path, ".workload-crash-fixture");
  const releasePath = join(owned.path, ".workload-crash-release");
  const group = await vi.waitFor(async () => {
    expect(await readFile(markerPath, "utf8")).toBe("started\n");
    const hostDb = new DatabaseSync(
      join(supervisor!.stateDir, "state.sqlite"),
      { readOnly: true },
    );
    try {
      const process = hostDb
        .prepare(
          "SELECT json_extract(body_json, '$.workspaceProcess.group') AS pgid FROM command_receipts WHERE command_id = ?",
        )
        .get(crashWork.id) as { pgid: number };
      expect(process.pgid).toBeGreaterThan(1);
      return process.pgid;
    } finally {
      hostDb.close();
    }
  });
  const recoverAt = async (seconds: number) =>
    recoverExecutionCommands({
      db,
      transport,
      graceMs: 0,
      now: () => new Date(Date.now() + seconds * 1000),
    });
  try {
    expect(
      (
        await findStalledEventStreams({
          db,
          now: new Date(Date.now() + 10_000),
          stallSeconds: 1,
        })
      ).map(({ executionHostId }) => executionHostId),
    ).not.toContain(host.id);
    supervisor = await supervisor.restart();
    expect((await inspectProcessGroup(group)).state).toBe("active");
    expect(await recoverAt(30)).toMatchObject({ errors: [], redelivered: 1 });
    // The replay observes an active group while the fixture retains the release marker.
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(
      await transport.getWorkspaceCommandReceipt!(crashWork.id),
    ).toMatchObject({ phase: "accepted" });
    await writeFile(releasePath, "release");
    await vi.waitFor(async () =>
      expect((await inspectProcessGroup(group)).state).toBe("retired"),
    );
    expect(await recoverAt(60)).toMatchObject({ errors: [], redelivered: 1 });
    await vi.waitFor(async () => {
      expect(
        await transport.getWorkspaceCommandReceipt!(crashWork.id),
      ).toMatchObject({
        phase: "completed",
        result: { processOutcome: "interrupted", quiescence: "proved" },
      });
    });
    expect(
      await consumeRuntimeEventStreamOnce({
        db,
        executionHostId: host.id,
        transport,
        owner: "fixture",
        maxEvents: 1,
        signal: AbortSignal.timeout(15_000),
      }),
    ).toMatchObject({ received: 1, acknowledged: 1 });
    await projectExecutionEvents({
      db,
      projector: canonicalLifecycleProjector,
      runId,
      now: new Date(projectedAt.getTime() + 150_000),
    });
    expect(await getCommand(db, crashWork.id)).toMatchObject({
      attempts: 1,
      state: "succeeded",
      result: { processOutcome: "interrupted", quiescence: "proved" },
    });
    expect(await readFile(markerPath, "utf8")).toBe("started\n");
  } finally {
    await writeFile(releasePath, "release");
    await vi.waitFor(async () =>
      expect((await inspectProcessGroup(group)).state).toBe("retired"),
    );
  }

  const file = join(owned.path, "input.txt");
  await writeFile(file, "checkpointed by host\n");
  const checkpoint = await reserveWorkspaceGitOperation(db, {
    runId, assignmentId: assignment.id, kind: "workspace.checkpoint", operationKey: "fixture:checkpoint",
  });
  const projectGit = async (future: number, id: string): Promise<Record<string, unknown>> => {
    expect(await recoverAt(future)).toMatchObject({ errors: [], redelivered: 1 });
    expect(await consumeRuntimeEventStreamOnce({
      db, executionHostId: host.id, transport, owner: "fixture", maxEvents: 1,
      signal: AbortSignal.timeout(15_000),
    })).toMatchObject({ received: 1 });
    await projectExecutionEvents({ db, projector: canonicalLifecycleProjector, runId, now: new Date(projectedAt.getTime() + 200_000) });
    const row = await getCommand(db, id);
    expect(row?.state).toBe("succeeded");
    return row?.result ?? {};
  };
  const checkpointResult = await projectGit(90, checkpoint.id);
  expect(checkpointResult).toMatchObject({ checkpointId: checkpoint.id, generation: 1, tree: expect.any(String) });
  await writeFile(file, "changed after snapshot\n");
  const restored = await reserveWorkspaceGitOperation(db, {
    runId, assignmentId: assignment.id, kind: "workspace.restore", operationKey: "fixture:restore", checkpointId: checkpoint.id,
  });
  expect(await projectGit(120, restored.id)).toMatchObject({ checkpointId: checkpoint.id, tree: checkpointResult.tree });
  expect(await readFile(file, "utf8")).toBe("checkpointed by host\n");

  await writeFile(
    join(owned.path, "input.txt"),
    "changed on the selected host\n",
  );
  const stoppedWork = await reserveWorkspaceWorkload(db, {
    ...workloadIntent,
    operationKey: "stop-check-0",
    declarationId: "stop-check",
  });
  try {
    expect(await recoverAt(150)).toMatchObject({ errors: [], redelivered: 1 });
    await vi.waitFor(async () => expect(await readFile(join(owned.path, ".stop-ready"), "utf8")).toBe(""));
    const supervisorState = new DatabaseSync(join(supervisor.stateDir, "state.sqlite"), { readOnly: true });
    const stopGroup = (() => {
      try {
        return supervisorState.prepare(
          "SELECT json_extract(body_json, '$.workspaceProcess.group') AS pgid FROM command_receipts WHERE command_id = ?",
        ).get(stoppedWork.id) as { pgid: number };
      } finally {
        supervisorState.close();
      }
    })();
    expect((await inspectProcessGroup(stopGroup.pgid)).state).toBe("active");
    const undeliveredWork = await reserveWorkspaceWorkload(db, {
      ...workloadIntent,
      operationKey: "stop-check-before-wire",
      declarationId: "stop-check",
    });
    startRuntimeEventConsumer({ db, executionHostId: host.id, transport });
    startCanonicalProjectionWorker();
    const reserveChild = async (branch: string) => {
      const id = await seedRun(database!.db, { projectId: project.id, runKind: "flow", status: "Pending" });
      await db.update(runs).set({ parentRunId: runId, rootRunId: runId }).where(eq(runs.id, id));
      const owner = await db.transaction(async (tx) => {
        const placement = await mintPlacement(tx, { runId: id, host, reason: "launch" });
        await reserveHostWorkspace(tx, { host, assignment: placement }, {
          projectId: project.id, branch, baseCommit: commit,
        }, {
          mode: "ownWorktree", repositoryId: project.id, commit, inputDigest: "9".repeat(64),
        }, capture.filter(({ path }) => path === WORKSPACE_WORKLOAD_FILE));
        return placement;
      });
      return { id, owner };
    };
    const { id: childId, owner: childAssignment } = await reserveChild("stop-active-child");
    const materializedChild = await vi.waitFor(async () => {
      await advanceAddressedWorkspaceAdmission(db, childId);
      const [child] = await db.select().from(workspaces).where(eq(workspaces.runId, childId));
      expect(child?.workspaceMaterializationGeneration).toBe(1);
      return child;
    }, { timeout: 10_000 });
    await db.update(runs).set({ status: "Running" }).where(eq(runs.id, childId));
    const childCheck = await reserveWorkspaceWorkload(db, {
      runId: childId, assignmentId: childAssignment.id, operationKey: "child-stop-check",
      workload: "check", declarationId: "stop-check",
    });
    await dispatchQueuedWorkspaceCommand(db, { runId: childId, commandId: childCheck.id });
    const childState = new DatabaseSync(join(supervisor.stateDir, "state.sqlite"), { readOnly: true });
    let childPath: string;
    let childGroup: number;
    try {
      const childWorkspace = childState.prepare("SELECT real_path AS path FROM workspaces WHERE id=?")
        .get(materializedChild.executionWorkspaceId) as { path: string };
      childPath = childWorkspace.path;
      childGroup = await vi.waitFor(async () => {
        expect(await readFile(join(childPath, ".stop-ready"), "utf8")).toBe("");
        const receipt = childState.prepare(
          "SELECT json_extract(body_json, '$.workspaceProcess.group') AS pgid FROM command_receipts WHERE command_id=?",
        ).get(childCheck.id) as { pgid: number };
        expect(receipt.pgid).toBeGreaterThan(1);
        return receipt.pgid;
      });
    } finally {
      childState.close();
    }
    const { id: pendingChildId } = await reserveChild("stop-pending-child");
    const [pendingPrepare] = await listCommandsForRun(db, pendingChildId);
    expect(pendingPrepare).toMatchObject({ state: "queued", kind: "workspace.prepare" });
    await db.update(runs).set({ status: "WaitingOnChildren" }).where(eq(runs.id, runId));
    const stop = (await import("@/app/api/runs/[runId]/stop/route")).POST;
    const stopped = await (async () => {
      try {
        return await stop(new Request(`${web.origin}/api/runs/${runId}/stop`, { method: "POST" }), {
          params: Promise.resolve({ runId }),
        });
      } finally {
        await writeFile(join(childPath, ".stop-release"), "release");
      }
    })();
    expect(stopped.status, await stopped.clone().text()).toBe(200);
    expect(await stopped.json()).toMatchObject({ runStatus: "Review", supervisorStopped: true });
    expect(await getCommand(db, stoppedWork.id)).toMatchObject({
      state: "succeeded",
      result: { processOutcome: "cancelled", quiescence: "proved" },
    });
    expect((await inspectProcessGroup(stopGroup.pgid)).state).toBe("retired");
    expect((await inspectProcessGroup(childGroup)).state).toBe("retired");
    expect(await getCommand(db, childCheck.id)).toMatchObject({
      state: "succeeded",
      result: { processOutcome: "cancelled", quiescence: "proved" },
    });
    expect(await db.select({ status: runs.status }).from(runs).where(eq(runs.id, childId)))
      .toEqual([{ status: "Abandoned" }]);
    expect(await db.select({ status: runs.status }).from(runs).where(eq(runs.id, pendingChildId)))
      .toEqual([{ status: "Abandoned" }]);
    expect(await transport.getWorkspaceCommandReceipt!(pendingPrepare.id)).toBeNull();
    const cancellations = (await listCommandsForRun(db, runId)).filter(({ kind }) => kind === "workspace.cancel");
    expect(cancellations).toHaveLength(2);
    expect(cancellations).toEqual(expect.arrayContaining([stoppedWork, undeliveredWork].map(({ id }) =>
      expect.objectContaining({ state: "succeeded", result: expect.objectContaining({ targetCommandId: id, quiescence: "proved" }) }),
    )));
    expect(await transport.getWorkspaceCommandReceipt!(undeliveredWork.id)).toBeNull();
  } finally {
    await writeFile(join(owned.path, ".stop-release"), "release");
    await stopRuntimeEventConsumers();
    await stopCanonicalProjectionWorker();
  }
  const diffRoute = (await import("@/app/api/runs/[runId]/diff/route")).GET;
  const requestDiff = (query = "") =>
    diffRoute(new Request(`${web.origin}/api/runs/${runId}/diff${query}`), {
      params: Promise.resolve({ runId }),
    });
  const readDiffEvent = async (): Promise<void> => {
    const batch = await consumeRuntimeEventStreamOnce({
        db,
        executionHostId: host.id,
        transport,
        owner: "fixture",
        maxEvents: 1,
        signal: AbortSignal.timeout(15_000),
      });
    expect(batch.received).toBe(1);
    expect(batch.acknowledged).toBeGreaterThanOrEqual(1);
  };
  const allowedDiff = requestDiff();
  await readDiffEvent();
  await projectCanonicalRuntimeObjects({ db, runId });
  const patchResponse = await allowedDiff;
  expect(patchResponse.status).toBe(200);
  const preparedPatch = await patchResponse.json();
  expect(preparedPatch).toMatchObject({
    baseCommit: commit,
    files: expect.arrayContaining([
      expect.objectContaining({ path: "input.txt", additions: 1 }),
    ]),
  });
  expect(preparedPatch).not.toHaveProperty("diff");
  const allowedRawDiff = requestDiff("?raw=1");
  await readDiffEvent();
  await projectCanonicalRuntimeObjects({ db, runId });
  const rawPatchResponse = await allowedRawDiff;
  expect(rawPatchResponse.status).toBe(200);
  expect(await rawPatchResponse.json()).toMatchObject({
    baseCommit: commit,
    diff: expect.stringContaining("+changed on the selected host\n"),
  });
  const gitLog = (await import("@/app/api/runs/[runId]/git-log/route")).GET;
  const requestLog = () => gitLog(
    new Request(`${web.origin}/api/runs/${runId}/git-log?limit=1`),
    { params: Promise.resolve({ runId }) },
  );
  const allowedLog = requestLog();
  await readDiffEvent();
  await projectCanonicalRuntimeObjects({ db, runId });
  const historyResponse = await allowedLog;
  expect(historyResponse.status).toBe(200);
  expect(await historyResponse.json()).toMatchObject({
    head: commit,
    commits: [{ commit }],
    nextCursor: expect.any(String),
  });
  const [{ objectId }] = (
    await database.pool.query<{ objectId: string }>(
      `SELECT id AS "objectId" FROM execution_runtime_objects WHERE run_id=$1 AND logical_name='workspace-diff.patch' AND mime_type='text/x-diff' AND state='available'`,
      [runId],
    )
  ).rows;
  const foreignRun = await seedRun(database.db, { projectId: sibling.id });
  await expect(
    readRuntimeObjectContent({
      db,
      runId: foreignRun,
      objectId,
      transportForHost: async () => transport,
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  const revokedDiff = requestDiff();
  await readDiffEvent();
  await database.pool.query(
    "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
    [project.id, userId],
  );
  try {
    await projectCanonicalRuntimeObjects({ db, runId });
    expect((await revokedDiff).status).toBe(403);
    expect((await requestLog()).status).toBe(403);
  } finally {
    await database.pool.query(
      "UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",
      [project.id, userId],
    );
  }

  const agentId = "fixture-vault:reader";
  await database.pool.query(
    `INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
      VALUES ($1,'fixture-vault','v1.0.0','git','Vault reader','','none','session','["manual"]','read_only','/fixture/reader.md')`,
    [agentId],
  );
  await database.pool.query(
    `INSERT INTO agent_project_links(id,project_id,agent_id,enabled,memory_enabled)
      VALUES ($1,$2,$3,true,true)`,
    [randomUUID(), project.id, agentId],
  );
  await database.pool.query(
    "INSERT INTO agent_memory_cutover(generation) VALUES (1)",
  );
  await database.pool.query(
    "UPDATE runs SET status='Running', agent_id=$2, trigger_source='manual', current_step_id='step-1' WHERE id=$1",
    [runId, agentId],
  );
  const nodeAttemptId = randomUUID();
  await database.pool.query(
    `INSERT INTO node_attempts(id,run_id,node_id,node_type,status,attempt)
      VALUES ($1,$2,'step-1','ai_coding','Running',1)`,
    [nodeAttemptId, runId],
  );
  expect(
    await stageProjectFlowMemory(db, {
      runId,
      nodeId: "step-1",
      nodeAttemptId,
      agentId,
    }),
  ).toBeDefined();
  const token = await issueProjectVaultNodeToken({
    db,
    projectId: project.id,
    runId,
    nodeAttemptId,
  });
  const facade = await agentFacadeMcpServerForRun(
    db,
    runId,
    token.secret,
    "vault",
  );
  if (!facade || !workspace.executionWorkspaceId)
    throw new Error("addressed vault session descriptor is unavailable");
  expect(facade.command).toBeUndefined();
  const fence = {
    runId,
    hostKey: host.hostKey,
    assignmentId: assignment.id,
    assignmentEpoch: assignment.epoch,
  };
  const opened = await transport.createSession(
    buildEnvelope({
      ...fence,
      commandId: randomUUID(),
      kind: "session.create",
      payload: {
        executionWorkspaceId: asExecutionWorkspaceId(
          workspace.executionWorkspaceId,
        ),
        executor: { agent: "claude" as const, model: "claude-sonnet-4-6" },
        stepId: "step-1",
        autoApprovePermissions: true,
        mcpServers: [facade],
      },
    }),
  );
  const inspectVault = async (): Promise<void> => {
    const commandId = randomUUID();
    const script = {
      calls: [{ tool: "memory", args: { command: "view", path: "/memories" } }],
    };
    await transport.startPrompt(
      opened.sessionId,
      buildEnvelope({
        ...fence,
        commandId,
        kind: "session.prompt",
        payload: {
          stepId: "step-1",
          prompt: `\`\`\`json\n${JSON.stringify(script)}\n\`\`\``,
        },
      }),
    );
    await vi.waitFor(
      async () => {
        const receipt = await transport.getCommandReceipt(commandId);
        expect(receipt?.phase).toBe("completed");
      },
      { timeout: 15_000 },
    );
  };
  try {
    await inspectVault();
    expect(web.outcomes).toEqual([{ status: 200 }]);
    await database.pool.query(
      "UPDATE agent_project_links SET memory_enabled=false WHERE project_id=$1 AND agent_id=$2",
      [project.id, agentId],
    );
    await inspectVault();
    expect(web.outcomes).toEqual([
      { status: 200 },
      { status: 409, reason: "agent_memory_disabled" },
    ]);
  } finally {
    await transport.deleteSession(
      opened.sessionId,
      buildEnvelope({
        ...fence,
        commandId: randomUUID(),
        kind: "session.delete",
        payload: {},
      }),
    );
  }
}
