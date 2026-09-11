// S4.2 / D9 step 4: the `inventory` subcommand walks every legacy run, accounts
// for every file and owner association across the five lanes, and commits a
// pending lane manifest. The default one-shot import path is unchanged; this is
// the phase that runs before any byte is copied.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

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
let userId: string;
let slug: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDbUpTo(
    { databaseName: "legacy_data_plane_inventory_test" },
    "0133_rich_blob",
  );
  runtimeRoot = await mkdtemp(join(tmpdir(), "legacy-inventory-root-"));
  manifestRoot = await mkdtemp(join(tmpdir(), "legacy-inventory-manifest-"));
  projectId = randomUUID();
  userId = randomUUID();
  slug = `inv-${projectId.replace(/-/g, "").slice(0, 8)}`;

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
      `Inventory ${slug}`,
      `/tmp/${slug}`,
      `I${slug.slice(-5).toUpperCase()}`,
    ],
  );
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
  await rm(runtimeRoot, { recursive: true, force: true });
  await rm(manifestRoot, { recursive: true, force: true });
});

afterEach(async () => {
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

function importId(): string {
  return `inv-${randomUUID().slice(0, 8)}`;
}

async function runInventory(id: string): Promise<string> {
  const result = await execFileAsync(
    tsxPath,
    [
      "--import",
      "./scripts/_register-shim.mjs",
      scriptPath,
      "inventory",
      "--import-id",
      id,
      "--manifest-dir",
      manifestRoot,
      "--batch-size",
      "2",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_URL: testDatabase.databaseUrl,
        MAISTER_LEGACY_RUNTIME_ROOT: runtimeRoot,
      },
    },
  );

  return result.stdout;
}

async function runInventoryExpectingRefusal(id: string): Promise<string> {
  try {
    const stdout = await runInventory(id);

    throw new Error(`inventory succeeded unexpectedly: ${stdout}`);
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };

    return `${failure.stdout ?? ""}\n${failure.stderr ?? failure.message}`;
  }
}

function readManifest(id: string): {
  items: Array<Record<string, unknown>>;
  lanes: Array<Record<string, unknown>>;
} {
  const db = new DatabaseSync(join(manifestRoot, `import-${id}.sqlite`), {
    readOnly: true,
  });

  try {
    return {
      items: db.prepare("SELECT * FROM import_items ORDER BY item_id").all() as Array<
        Record<string, unknown>
      >,
      lanes: db
        .prepare("SELECT * FROM import_lanes ORDER BY run_id, lane")
        .all() as Array<Record<string, unknown>>,
    };
  } finally {
    db.close();
  }
}

async function readLanes(
  runId: string,
): Promise<Array<{ kind: string; state: string; fingerprint: string; cursor: string }>> {
  const result = await testDatabase.pool.query<{
    kind: string;
    state: string;
    fingerprint: string;
    cursor: string;
  }>(
    `select source_kind as kind, state, source_fingerprint as fingerprint,
        last_source_position as cursor
     from execution_data_plane_imports where run_id = $1 order by source_kind`,
    [runId],
  );

  return result.rows;
}

describe("execution-data-plane:import-legacy inventory", () => {
  it("accounts for ordinary logs, nested evidence and uploads the old audit refused", async () => {
    const { runId, runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");
    await mkdir(join(runDirectory, "steps", "build"), { recursive: true });
    await writeFile(
      join(runDirectory, "steps", "build", "attempt-1.log"),
      "building\n",
      "utf8",
    );
    await mkdir(join(runDirectory, "uploads", "msg-1"), { recursive: true });
    await writeFile(
      join(runDirectory, "uploads", "msg-1", "spec.txt"),
      "a spec\n",
      "utf8",
    );

    const id = importId();
    const stdout = await runInventory(id);
    const lanes = await readLanes(runId);

    expect(lanes.map((lane) => lane.kind)).toEqual([
      "cost",
      "events",
      "runtime_objects",
      "scratch_session",
      "transcript",
    ]);
    expect(lanes.every((lane) => lane.state === "pending")).toBe(true);
    expect(lanes.every((lane) => /^[0-9a-f]{64}$/.test(lane.fingerprint))).toBe(true);
    expect(
      lanes.every((lane) => lane.cursor.startsWith("v1:phase=inventory:manifest=")),
    ).toBe(true);

    const runtimeObjects = lanes.find((lane) => lane.kind === "runtime_objects");

    expect(runtimeObjects?.cursor).toContain("items=2");
    expect(stdout).toContain("legacy_execution_data_lane_inventoried");
  });

  it("keeps raw paths in the host-private manifest and out of Postgres and the log", async () => {
    const { runId, runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "secret-step.log"), "planning\n", "utf8");

    const id = importId();
    const stdout = await runInventory(id);
    const lanes = await readLanes(runId);

    expect(JSON.stringify(lanes)).not.toContain("secret-step.log");
    expect(stdout).not.toContain("secret-step.log");
    expect(stdout).not.toContain(runtimeRoot);
    expect(
      readManifest(id).items.some((item) => item.relative_path === "secret-step.log"),
    ).toBe(true);
  });

  it("preserves both artifact references to one file as distinct associations", async () => {
    const { runId, runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "shared.log"), "shared evidence\n", "utf8");
    for (const artifactId of ["art-1", "art-2"]) {
      await testDatabase.pool.query(
        `insert into artifact_instances (id, run_id, kind, producer, locator)
         values ($1, $2, 'log', 'runner', $3::jsonb)`,
        [
          `${runId}-${artifactId}`,
          runId,
          JSON.stringify({ kind: "file", path: join(runDirectory, "shared.log") }),
        ],
      );
    }

    const id = importId();

    await runInventory(id);
    const associations = readManifest(id).items.filter((item) =>
      String(item.association_key).startsWith("artifact:"),
    );

    expect(associations).toHaveLength(2);
    expect(new Set(associations.map((item) => item.sha256)).size).toBe(1);
    expect(new Set(associations.map((item) => item.item_id)).size).toBe(2);
    expect(associations.every((item) => item.row_fingerprint !== null)).toBe(true);
  });

  it("preserves a scratch attachment as a scratch-session association", async () => {
    const { runId, runDirectory } = await seedRun();

    await mkdir(join(runDirectory, "uploads", "msg-9"), { recursive: true });
    await writeFile(
      join(runDirectory, "uploads", "msg-9", "note.txt"),
      "attached\n",
      "utf8",
    );
    await testDatabase.pool.query(
      `insert into scratch_runs
        (run_id, project_id, initial_prompt, base_branch, base_commit,
         created_by_user_id)
       values ($1, $2, 'legacy', 'main', 'deadbeef', $3)`,
      [runId, projectId, userId],
    );
    await testDatabase.pool.query(
      `insert into scratch_attachments
        (id, run_id, kind, value, file_name, storage_path)
       values ($1, $2, 'uploaded_file', 'note.txt', 'note.txt', $3)`,
      [`${runId}-att`, runId, join(runDirectory, "uploads", "msg-9", "note.txt")],
    );

    const id = importId();

    await runInventory(id);
    const attachment = readManifest(id).items.find(
      (item) => item.association_key === `attachment:${runId}-att`,
    );

    expect(attachment).toBeDefined();
    expect(attachment?.lane).toBe("scratch_session");
  });

  it("blocks an unclassified source instead of reporting a complete inventory", async () => {
    const { runId, runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "mystery.bin"), "??\n", "utf8");

    const id = importId();
    const output = await runInventoryExpectingRefusal(id);
    const lanes = await readLanes(runId);

    expect(output).toContain("unclassified_source");
    expect(output).toContain("legacy_execution_data_inventory_blocked");
    expect(lanes.every((lane) => lane.state !== "complete")).toBe(true);
  });

  it("proves an absent lane against the scope it inspected, not a blanket zero", async () => {
    const { runId } = await seedRun();
    const id = importId();

    await runInventory(id);
    const lanes = await readLanes(runId);
    const scratch = lanes.find((lane) => lane.kind === "scratch_session");
    const manifestLane = readManifest(id).lanes.find(
      (lane) => lane.lane === "scratch_session",
    );

    expect(scratch?.cursor).toContain("items=0");
    expect(scratch?.state).toBe("pending");
    expect(manifestLane?.expected_items).toBe(0);
    expect(String(manifestLane?.inspected_scope)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is idempotent for unchanged sources and refuses a source that changed", async () => {
    const { runId, runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");
    const first = importId();

    await runInventory(first);
    const before = await readLanes(runId);

    await runInventory(first);
    expect(await readLanes(runId)).toEqual(before);

    await writeFile(join(runDirectory, "plan.log"), "planning again\n", "utf8");
    const output = await runInventoryExpectingRefusal(first);

    expect(output).toContain("source_fingerprint_changed");
  });

  it("leaves the frozen manifest intact when a source changed under it", async () => {
    const { runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");
    const id = importId();

    await runInventory(id);
    const frozen = readManifest(id).items.map((item) => item.sha256).sort();

    await writeFile(join(runDirectory, "plan.log"), "planning again\n", "utf8");
    await runInventoryExpectingRefusal(id);

    expect(readManifest(id).items.map((item) => item.sha256).sort()).toEqual(
      frozen,
    );
  });

  it("does not read a failed attempt's fingerprint as a changed source", async () => {
    const { runId, runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");
    await testDatabase.pool.query(
      `insert into execution_data_plane_imports
        (run_id, source_kind, state, source_fingerprint)
       values ($1, 'runtime_objects', 'failed', $2)`,
      [runId, "0".repeat(64)],
    );

    const id = importId();
    const stdout = await runInventory(id);

    expect(stdout).not.toContain("source_fingerprint_changed");
    expect(
      (await readLanes(runId)).every((lane) => lane.state === "pending"),
    ).toBe(true);
  });

  it("refuses to re-inventory a lane a completed import already owns", async () => {
    const { runId } = await seedRun();

    await testDatabase.pool.query(
      `insert into execution_data_plane_imports (run_id, source_kind, state)
       values ($1, 'events', 'complete')`,
      [runId],
    );

    const output = await runInventoryExpectingRefusal(importId());

    expect(output).toContain("lane_already_complete");
  });
});
