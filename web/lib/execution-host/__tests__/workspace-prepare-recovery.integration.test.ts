import type { Db } from "../db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { WorkspacePrepareRequest } from "../../../../runtime/workspace-prepare";

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";

import { getAssignmentById } from "../assignments";
import { listCommandsForRun } from "../commands";
import { consumeRuntimeEventStreamOnce } from "../events/consumer";
import { canonicalLifecycleProjector } from "../events/lifecycle-projector";
import { projectExecutionEvents } from "../events/projector";
import { mintPlacement } from "../placement";
import { recoverExecutionCommands } from "../recovery";
import { ensureLocalExecutionHost } from "../registrar";
import { createLocalDirectTransport } from "../transports/local-direct";
import { reserveHostWorkspace } from "../workspace-preparation";

import { workspaces } from "@/lib/db/schema";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import { initRepo } from "@/test-support/git-fixture";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { startRealSupervisor } from "@/test-support/real-supervisor";

let root: string | undefined;
let supervisor: RealSupervisor | undefined;
let database: StartedPostgresTestDb | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await supervisor?.kill();
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

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
  supervisor = await startRealSupervisor({
    env: {
      MAISTER_WORKSPACE_REPOSITORIES: JSON.stringify({ [project.id]: source }),
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

    const output = execFileSync(process.execPath, [
      "--import", resolve("node_modules/tsx/dist/loader.mjs"),
      "--import", resolve("scripts/_register-shim.mjs"),
      resolve("test-support/workspace-prepare-projection-worker.ts"),
      runId, new Date(projectedAt.getTime() + 60_000).toISOString(),
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        DB_URL: database.databaseUrl,
        TSX_TSCONFIG_PATH: resolve("tsconfig.json"),
      },
      timeout: 15_000,
    });
    const marker = "workspace-projection ";
    const line = output.split("\n").find((entry) => entry.startsWith(marker));
    if (!line) throw new Error("replacement worker returned no projection summary");
    const after = JSON.parse(line.slice(marker.length)) as { pid: number; projected: number };
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
}, 120_000);
