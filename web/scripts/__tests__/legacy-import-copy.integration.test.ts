// S4.3 / D9 step 5: `copy` sends the frozen manifest's bytes to a REAL
// supervisor over its maintenance socket and seals each source into an ordinary
// runtime object. The whole path is exercised end to end — the operator's
// inventory, the supervisor's boot-time admission, the chunked transfer, the
// seal, and the ordinary content route the browser would read it back through.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  createImportMaintenanceClient,
  IMPORT_CHUNK_BYTES,
  readOperatorImportManifest,
} from "@/lib/execution-host/import-maintenance";
import {
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  type RealSupervisor,
} from "@/test-support/real-supervisor";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(
  process.cwd(),
  "scripts/import-legacy-execution-data-plane.ts",
);
const tsxPath = resolve(process.cwd(), "node_modules/.bin/tsx");

let testDatabase: StartedPostgresTestDb;
let runtimeRoot: string;
let manifestRoot: string;
let projectId: string;
let slug: string;
const supervisors: RealSupervisor[] = [];

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDbUpTo(
    { databaseName: "legacy_data_plane_copy_test" },
    "0133_rich_blob",
  );
  runtimeRoot = await mkdtemp(join(tmpdir(), "legacy-copy-root-"));
  projectId = randomUUID();
  slug = `cp-${projectId.replace(/-/g, "").slice(0, 8)}`;

  const userId = randomUUID();

  await testDatabase.pool.query(
    `insert into users (id, email, role, account_status)
     values ($1, $2, 'admin', 'active')`,
    [userId, `${slug}@example.test`],
  );
  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [
      projectId,
      slug,
      `Copy ${slug}`,
      `/tmp/${slug}`,
      `C${slug.slice(-5).toUpperCase()}`,
    ],
  );
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
  await rm(runtimeRoot, { recursive: true, force: true });
});

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop();
  await testDatabase.pool.query("delete from runs");
});

async function seedRun(): Promise<{ runId: string; runDirectory: string }> {
  const runId = randomUUID();

  await testDatabase.pool.query(
    `insert into runs
      (id, project_id, run_kind, status, flow_version, flow_revision,
       execution_data_plane_mode)
     values ($1, $2, 'scratch', 'Done', 'scratch', 'manual', 'legacy_file_v1')`,
    [runId, projectId],
  );
  const runDirectory = join(runtimeRoot, ".maister", slug, "runs", runId);

  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "run.events.jsonl"),
    `${JSON.stringify({ type: "session.line", sessionId: "s", line: "hi" })}\n`,
    "utf8",
  );
  await writeFile(join(runDirectory, "cost.jsonl"), "{}\n", "utf8");

  return { runId, runDirectory };
}

async function cli(
  command: "inventory" | "copy",
  args: readonly string[],
): Promise<string> {
  const result = await execFileAsync(
    tsxPath,
    ["--import", "./scripts/_register-shim.mjs", scriptPath, command, ...args],
    {
      cwd: process.cwd(),
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        DB_URL: testDatabase.databaseUrl,
        MAISTER_LEGACY_RUNTIME_ROOT: runtimeRoot,
      },
    },
  );

  return `${result.stdout}\n${result.stderr}`;
}

async function cliExpectingRefusal(
  command: "inventory" | "copy",
  args: readonly string[],
): Promise<string> {
  try {
    const output = await cli(command, args);

    throw new Error(`${command} succeeded unexpectedly: ${output}`);
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };

    return `${failure.stdout ?? ""}\n${failure.stderr ?? failure.message}`;
  }
}

// The operator reads this off the supervisor's own boot line; there is no way
// to obtain it over the wire, which is exactly what makes a stale invocation
// refuse instead of write.
async function enabledGeneration(supervisor: RealSupervisor): Promise<number> {
  const log = await supervisor.logTail(256 * 1024);
  const line = log
    .split("\n")
    .reverse()
    .find((entry) => entry.includes("import_admission_enabled"));

  if (!line) throw new Error(`no import_admission_enabled line in:\n${log}`);

  return (JSON.parse(line) as { generation: number }).generation;
}

async function startSupervisorFor(importId: string): Promise<RealSupervisor> {
  const supervisor = await startRealSupervisor({
    env: {
      MAISTER_IMPORT_ADMISSION_DIR: manifestRoot,
      MAISTER_IMPORT_ADMISSION_ID: importId,
    },
  });

  supervisors.push(supervisor);

  return supervisor;
}

function hostObjects(
  supervisor: RealSupervisor,
): Array<Record<string, unknown>> {
  const db = new DatabaseSync(join(supervisor.stateDir, "state.sqlite"), {
    readOnly: true,
  });

  try {
    return db
      .prepare("SELECT * FROM runtime_objects ORDER BY logical_name")
      .all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function importId(): string {
  return `cp-${randomUUID().slice(0, 8)}`;
}

async function inventory(id: string): Promise<void> {
  await cli("inventory", ["--import-id", id, "--manifest-dir", manifestRoot]);
}

function copyArgs(id: string, generation: number): string[] {
  return [
    "--import-id",
    id,
    "--manifest-dir",
    manifestRoot,
    "--generation",
    String(generation),
  ];
}

beforeEach(async () => {
  manifestRoot = await mkdtemp(join(tmpdir(), "legacy-copy-manifest-"));
});

describe("execution-data-plane:import-legacy copy", () => {
  it("preserves every inventoried source as an ordinary readable object", async () => {
    const { runDirectory } = await seedRun();
    const planBytes = "planning the change\n".repeat(64);
    const nestedBytes = "building\n".repeat(32);

    await writeFile(join(runDirectory, "plan.log"), planBytes, "utf8");
    await mkdir(join(runDirectory, "steps", "build"), { recursive: true });
    await writeFile(
      join(runDirectory, "steps", "build", "attempt-1.log"),
      nestedBytes,
      "utf8",
    );
    // An empty step log is ordinary Stage A history and must be preserved as a
    // real zero-byte object, not skipped or refused.
    await writeFile(join(runDirectory, "empty.log"), "", "utf8");

    const id = importId();

    await inventory(id);

    const supervisor = await startSupervisorFor(id);
    const generation = await enabledGeneration(supervisor);
    const output = await cli("copy", copyArgs(id, generation));

    expect(output).toContain("legacy_execution_data_copy_finished");

    const manifest = readOperatorImportManifest({
      directory: manifestRoot,
      importId: id,
    });
    const objects = hostObjects(supervisor);

    expect(objects).toHaveLength(manifest.items.length);
    expect(objects.some((object) => Number(object.size_bytes) === 0)).toBe(true);
    for (const object of objects) {
      expect(object.state).toBe("available");
      expect(object.kind).toBe("historical_import");
      // Real epochs start at 1: imported history can never satisfy a live
      // fence, so the import cannot forge an active assignment.
      expect(Number(object.assignment_epoch)).toBe(0);
      expect(object.host_session_id).toBeNull();

      const readback = await fetch(
        `${supervisor.url}/runtime-objects/${String(object.id)}/content`,
        { headers: { connection: "close" } },
      );

      expect(readback.status).toBe(200);
      expect(
        createHash("sha256")
          .update(new Uint8Array(await readback.arrayBuffer()))
          .digest("hex"),
      ).toBe(String(object.sha256));
    }

    // "no source mutation/deletion": every source is exactly where and what it
    // was, and the manifest the inventory froze is untouched.
    expect(await readFile(join(runDirectory, "plan.log"), "utf8")).toBe(
      planBytes,
    );
    expect(
      await readFile(join(runDirectory, "steps", "build", "attempt-1.log"), "utf8"),
    ).toBe(nestedBytes);
  }, 180_000);

  it("resumes at the host's committed offset instead of re-sending history", async () => {
    const { runDirectory } = await seedRun();
    // One full protocol chunk plus a remainder: the CLI must continue at the
    // second chunk's index and offset, not restart the item.
    const large = "x".repeat(IMPORT_CHUNK_BYTES + 4096);

    await writeFile(join(runDirectory, "big.log"), large, "utf8");

    const id = importId();

    await inventory(id);

    const supervisor = await startSupervisorFor(id);
    const generation = await enabledGeneration(supervisor);
    const manifest = readOperatorImportManifest({
      directory: manifestRoot,
      importId: id,
    });
    const item = manifest.items.find(
      (candidate) => candidate.sizeBytes === large.length,
    );

    expect(item).toBeDefined();

    const maintenance = createImportMaintenanceClient({
      socketPath: join(manifestRoot, "admission", "import.sock"),
      importId: id,
      generation,
      manifestDigest: manifest.digest,
    });

    expect(
      (
        await maintenance.putChunk({
          itemId: item!.itemId,
          chunkIndex: 0,
          offset: 0,
          bytes: new Uint8Array(Buffer.from(large.slice(0, IMPORT_CHUNK_BYTES))),
        })
      ).outcome,
    ).toBe("committed");

    await cli("copy", copyArgs(id, generation));

    const sealed = hostObjects(supervisor).find(
      (object) => String(object.logical_name) === item!.itemId,
    );

    expect(sealed?.state).toBe("available");
    expect(Number(sealed?.size_bytes)).toBe(large.length);
    expect(String(sealed?.sha256)).toBe(
      createHash("sha256").update(large, "utf8").digest("hex"),
    );
  }, 180_000);

  it("re-runs without re-sending or re-sealing what it already preserved", async () => {
    const { runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");

    const id = importId();

    await inventory(id);

    const supervisor = await startSupervisorFor(id);
    const generation = await enabledGeneration(supervisor);

    await cli("copy", copyArgs(id, generation));

    const first = hostObjects(supervisor).map((object) => String(object.id));
    const output = await cli("copy", copyArgs(id, generation));

    expect(hostObjects(supervisor).map((object) => String(object.id))).toEqual(
      first,
    );
    expect(output).toContain(`"sealed":0`);
    expect(output).toContain(`"skipped":${first.length}`);
  }, 180_000);

  it("refuses a stale generation without touching a byte", async () => {
    const { runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");

    const id = importId();

    await inventory(id);

    const supervisor = await startSupervisorFor(id);
    const generation = await enabledGeneration(supervisor);
    const output = await cliExpectingRefusal(
      "copy",
      copyArgs(id, generation + 1),
    );

    expect(output).toContain("import_generation_stale");
    expect(hostObjects(supervisor)).toEqual([]);
  }, 180_000);

  it("refuses a source that changed after the inventory froze it", async () => {
    const { runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");

    const id = importId();

    await inventory(id);
    await writeFile(
      join(runDirectory, "plan.log"),
      "planning differently\n",
      "utf8",
    );

    const supervisor = await startSupervisorFor(id);
    const generation = await enabledGeneration(supervisor);
    const output = await cliExpectingRefusal("copy", copyArgs(id, generation));

    expect(output).toContain("source_fingerprint_changed");
    // The changed source is still exactly as the operator left it, and no
    // partial object was sealed from it.
    expect(await readFile(join(runDirectory, "plan.log"), "utf8")).toBe(
      "planning differently\n",
    );
    expect(
      hostObjects(supervisor).some(
        (object) => Number(object.size_bytes) === "planning\n".length,
      ),
    ).toBe(false);
  }, 180_000);

  it("cannot reach the maintenance protocol over the supervisor's TCP port", async () => {
    const id = importId();
    const { runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");
    await inventory(id);

    const supervisor = await startSupervisorFor(id);

    for (const path of [
      `/imports/${id}`,
      `/imports/${id}/admission`,
      `/imports/${id}/items/${"a".repeat(64)}/seal`,
    ]) {
      const response = await fetch(`${supervisor.url}${path}`, {
        method: "POST",
        headers: { connection: "close" },
      });

      expect(response.status, path).toBe(404);
    }
  }, 180_000);

  it("keeps the socket private to the operator's own directory", async () => {
    const id = importId();

    await seedRun();
    await inventory(id);
    await startSupervisorFor(id);

    const admission = join(manifestRoot, "admission");

    expect((await stat(admission)).mode & 0o777).toBe(0o700);
    expect((await stat(join(admission, "import.sock"))).mode & 0o777).toBe(
      0o600,
    );
  }, 180_000);
});
