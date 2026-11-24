import type { Db } from "../db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { WorkspacePrepareRequest } from "../../../../runtime/workspace-prepare";
import { WORKSPACE_WORKLOAD_FILE } from "../../../../runtime/workspace-prepare";

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";

import { getAssignmentById } from "../assignments";
import { createExecutionHosts } from "../client";
import { getCommand, listCommandsForRun } from "../commands";
import { consumeRuntimeEventStreamOnce } from "../events/consumer";
import { canonicalLifecycleProjector } from "../events/lifecycle-projector";
import { projectExecutionEvents } from "../events/projector";
import { projectCanonicalRuntimeObjects } from "../events/runtime-object-projector";
import { mintPlacement } from "../placement";
import { buildEnvelope } from "../ledger";
import { recoverExecutionCommands } from "../recovery";
import { ensureLocalExecutionHost } from "../registrar";
import { createLocalDirectTransport } from "../transports/local-direct";
import {
  readAddressedWorkspaceStatus,
  reserveHostWorkspace,
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
import { readSealedCliOutput } from "@/lib/flows/graph/node-output";
import { workspaces } from "@/lib/db/schema";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import { initRepo } from "@/test-support/git-fixture";
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

afterEach(async () => {
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

it("C-06 applies one real checkout after a lost acceptance and a rolled-back projection", async () => {
  root = await mkdtemp(join(tmpdir(), "stage-c-preparation-recovery-"));
  const source = await initRepo(join(root, "origin"));
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
            id: "fixture-check",
            workload: "check",
            command:
              "printf 'check diagnostic'; printf '%s' '{\"verified\":true}' > \"$MAISTER_OUTPUT_FILE\"",
            timeoutMs: 5000,
            structuredOutput: "jsonFile",
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
  const workDelivery = await recoverExecutionCommands({
    db,
    transport,
    graceMs: 0,
  });
  expect(workDelivery.errors).toEqual([]);
  expect(workDelivery.redelivered).toBe(1);
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
  const objects = appliedWork?.result?.objects as {
    objectId: string;
    sha256: string;
  }[];
  const workOutput = await readRuntimeObjectContent({
    db,
    runId,
    objectId: objects[0].objectId,
    transportForHost: async () => transport,
  });
  expect(Buffer.from(workOutput.content.bytes).toString("utf8")).toBe(
    "check diagnostic",
  );
  const checkResult = await readSealedCliOutput({
    db,
    runId,
    ...objects[2],
    transportForHost: async () => transport,
  });
  expect(checkResult).toEqual({ kind: "value", value: { verified: true } });

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
}, 120_000);
