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
  stopRuntimeEventConsumers,
} from "../events/consumer";
import { canonicalLifecycleProjector } from "../events/lifecycle-projector";
import { projectExecutionEvents } from "../events/projector";
import { projectCanonicalRuntimeObjects } from "../events/runtime-object-projector";
import { findStalledEventStreams } from "../events/stream-health";
import { mintPlacement } from "../placement";
import { buildEnvelope } from "../ledger";
import { recoverExecutionCommands } from "../recovery";
import { advanceAddressedWorkspaceAdmission } from "../workspace-dispatch";
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

import { captureAddressedFlowContexts } from "@/lib/context-mounts/addressed-capture";
import { stageProjectFlowMemory } from "@/lib/agent-memory-vault/injection";
import { agentFacadeMcpServerForRun } from "@/lib/agents/launch";
import { issueProjectVaultNodeToken } from "@/lib/agents/tokens";
import { closeDb } from "@/lib/db/client";
import { cliOutputFilePath } from "@/lib/flows/graph/node-output";
import { runFlow } from "@/lib/flows/runner";
import { runCliStep } from "@/lib/flows/runner-cli";
import { loadGitState } from "@/lib/workbench-git/read-model";
import {
  flows,
  flowRevisions,
  gateResults,
  nodeAttempts,
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
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import { git, initRepo } from "@/test-support/git-fixture";
import { seedTaskLaunchFixture } from "@/test-support/task-launch-admission";
import {
  addProjectMember,
  removeProjectMember,
  seedActiveUser,
} from "@/test-support/librarian-seed";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { startRealSupervisor } from "@/test-support/real-supervisor";

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

it("C-05/C-08 accepts a pathless board launch and runs its action and command gate in the selected checkout", async () => {
  root = await mkdtemp(join(tmpdir(), "stage-c-pathless-graph-"));
  database = await startMainPostgresTestDb({
    databaseName: "eh_graph_workload",
  });
  const db = database.db as unknown as Db;
  const {
    userId,
    projectId,
    flowId,
    repo: source,
  } = await seedTaskLaunchFixture(database, root);
  const commit = (await git(source, "rev-parse", "HEAD")).trim();
  const installedScript = join(root, "flow", "scripts", "check.sh");
  await mkdir(join(root, "flow", "scripts"), { recursive: true });
  await writeFile(
    installedScript,
    "#!/bin/sh\ntest \"$(cat acp-marker)\" = 'written by addressed ACP' && printf 'from owning host' > graph-marker && cat graph-marker\n",
    { mode: 0o755 },
  );
  const command = '"$MAISTER_FLOW_DIR/scripts/check.sh"';
  const manifest = {
    schemaVersion: 1,
    name: "addressed-graph",
    compat: { engine_min: "1.1.0" },
    nodes: [
      {
        id: "edit",
        type: "ai_coding",
        settings: { permissionMode: "ask" },
        action: {
          prompt:
            'fixture-output:{"bytes":0,"text":"addressed edit complete","writeWorkspaceMarker":true,"expectedCapabilityAgent":"codex"}',
        },
        transitions: { success: "work" },
      },
      {
        id: "work",
        type: "cli",
        action: { command },
        pre_finish: {
          gates: [
            {
              id: "verify",
              kind: "command_check",
              mode: "blocking",
              command:
                "test \"$(cat graph-marker)\" = 'from owning host' && printf 'gate saw host marker'",
            },
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
    .set({ manifest })
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
  supervisor = await startRealSupervisor({
    fixture: "mock-acp-lifecycle.mjs",
    fixtureAdapters: ["codex"],
    env: {
      MAISTER_WORKSPACE_REPOSITORIES: JSON.stringify({ [projectId]: source }),
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
  await git(source, "commit", "-m", "advance approved branch after acceptance");
  const bound = await prepareTaskLaunchIntent(db, accepted.intentId);
  expect(bound).toMatchObject({
    state: "run_bound",
    runId: expect.any(String),
    snapshot: { baseCommit: commit },
  });
  if (!bound.runId) throw new Error("board intent did not bind a Run");
  await writeFile(installedScript, "#!/bin/sh\nexit 73\n");
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
  const applyCommand = async (commandId: string): Promise<void> => {
    await vi.waitFor(
      async () => {
        await projectCanonicalRuntimeObjects({ db, runId });
        await projectExecutionEvents({
          db,
          projector: canonicalLifecycleProjector,
          runId,
        });
        expect(await getCommand(db, commandId)).toMatchObject({
          state: "succeeded",
        });
      },
      { timeout: 10_000 },
    );
  };
  await advanceAddressedWorkspaceAdmission(db, runId);
  const [prepare] = await listCommandsForRun(db, runId);
  expect(prepare.kind).toBe("workspace.prepare");
  await applyCommand(prepare.id);
  await advanceAddressedWorkspaceAdmission(db, runId);
  const materialization = (await listCommandsForRun(db, runId)).find(
    ({ kind }) => kind === "workspace.materialize",
  );
  if (!materialization)
    throw new Error("launch did not reserve workspace materialization");
  await applyCommand(materialization.id);
  expect(await tryStartRun(runId, { db })).toMatchObject({ started: true });
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
    const queued = await vi.waitFor(() => findDeclaration("node:"), {
      timeout: 3_000,
    });
    commandId = queued.id;
  } finally {
    firstDriver.abort();
    expect(await first).toEqual({ state: "returned" });
  }

  const driving = startDriver(AbortSignal.timeout(20_000));
  try {
    for (const declaration of ["node:", "gate:"]) {
      const queued = await vi.waitFor(() => findDeclaration(declaration), {
        timeout: 3_000,
      });
      if (declaration === "node:") expect(queued.id).toBe(commandId);
      await applyCommand(queued.id);
    }
    await vi.waitFor(async () => {
      await projectCanonicalRuntimeObjects({ db, runId });
      expect(
        await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)),
      ).toEqual([{ status: "Review" }]);
    }, { timeout: 10_000 });
  } finally {
    expect(await driving).toEqual({ state: "returned" });
  }
  expect(
    await db
      .select({ status: nodeAttempts.status, stdout: nodeAttempts.stdout })
      .from(nodeAttempts)
      .where(
        and(eq(nodeAttempts.runId, runId), eq(nodeAttempts.nodeId, "work")),
      ),
  ).toEqual([{ status: "Succeeded", stdout: "from owning host" }]);
  const [editAttempt] = await db
    .select({
      status: nodeAttempts.status,
      acpSessionId: nodeAttempts.acpSessionId,
    })
    .from(nodeAttempts)
    .where(and(eq(nodeAttempts.runId, runId), eq(nodeAttempts.nodeId, "edit")));
  expect(editAttempt).toMatchObject({
    status: "Succeeded",
    acpSessionId: expect.stringMatching(/^mock-/),
  });
  expect(
    await db
      .select({ status: gateResults.status, verdict: gateResults.verdict })
      .from(gateResults)
      .where(eq(gateResults.runId, runId)),
  ).toEqual([
    {
      status: "passed",
      verdict: { verdict: "pass", reasons: ["gate saw host marker"] },
    },
  ]);
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
}, 90_000);

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
      1,
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

  await writeFile(
    join(owned.path, "input.txt"),
    "changed on the selected host\n",
  );
  const diffRoute = (await import("@/app/api/runs/[runId]/diff/route")).GET;
  const requestDiff = () =>
    diffRoute(new Request(`${web.origin}/api/runs/${runId}/diff`), {
      params: Promise.resolve({ runId }),
    });
  const readDiffEvent = async (): Promise<void> => {
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
  };
  const allowedDiff = requestDiff();
  await readDiffEvent();
  await projectCanonicalRuntimeObjects({ db, runId });
  const patchResponse = await allowedDiff;
  expect(patchResponse.status).toBe(200);
  expect(await patchResponse.json()).toMatchObject({
    baseCommit: commit,
    diff: expect.stringContaining("+changed on the selected host\n"),
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
