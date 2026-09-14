// S4.5 / D9 steps 8-9: the bytes are on the host and the rows point at them,
// but nothing has yet PROVEN that what the host serves back is what the
// operator froze. `verify` streams every sealed object back through the host,
// compares it to the ORIGINAL manifest, re-checks the source freeze and the
// post-0134 scratch shape. `finalize-proof` is the only writer of a `complete`
// lane record and writes one only for a run whose five lanes all hold —
// unchanged 0135's five-lane preflight is the acceptance.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { open } from "node:fs/promises";
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

import { ensureLocalExecutionHost } from "@/lib/execution-host";
import {
  createImportMaintenanceClient,
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

type Phase =
  | "inventory"
  | "copy"
  | "associate"
  | "rows"
  | "verify"
  | "finalize-proof";

let testDatabase: StartedPostgresTestDb;
let runtimeRoot: string;
let manifestRoot: string;
let projectId: string;
let slug: string;
const supervisors: RealSupervisor[] = [];

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDbUpTo(
    { databaseName: "legacy_data_plane_verify_test" },
    "0133_rich_blob",
  );
  runtimeRoot = await mkdtemp(join(tmpdir(), "legacy-verify-root-"));
  projectId = randomUUID();
  slug = `vf-${projectId.replace(/-/g, "").slice(0, 8)}`;

  await testDatabase.pool.query(
    `insert into users (id, email, role, account_status)
     values ($1, $2, 'admin', 'active')`,
    [randomUUID(), `${slug}@example.test`],
  );
  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [
      projectId,
      slug,
      `Verify ${slug}`,
      `/tmp/${slug}`,
      `V${slug.slice(-5).toUpperCase()}`,
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

beforeEach(async () => {
  manifestRoot = await mkdtemp(join(tmpdir(), "legacy-verify-manifest-"));
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

  await mkdir(join(runDirectory, "uploads", "spec"), { recursive: true });
  await writeFile(
    join(runDirectory, "run.events.jsonl"),
    `${JSON.stringify({ type: "session.line", sessionId: "s", line: "hi" })}\n`,
    "utf8",
  );
  await writeFile(
    join(runDirectory, "cost.jsonl"),
    `${JSON.stringify({ ts: "2026-09-04T00:00:01.000Z", sessionId: "s", input_tokens: 1, output_tokens: 1 })}\n`,
    "utf8",
  );
  await writeFile(
    join(runDirectory, "plan.log"),
    "planning step output\n",
    "utf8",
  );
  await writeFile(
    join(runDirectory, "uploads", "spec", "spec.txt"),
    "spec bytes\n",
    "utf8",
  );

  return { runId, runDirectory };
}

async function seedArtifact(input: {
  runId: string;
  relativePath: string;
}): Promise<string> {
  const id = randomUUID();

  await testDatabase.pool.query(
    `insert into artifact_instances
      (id, run_id, node_id, attempt, kind, producer, locator, validity,
       required_for, visibility, retention)
     values ($1, $2, 'build', 1, 'log', 'runner',
       jsonb_build_object('kind', 'file', 'path', $3::text),
       'current', '["review"]'::jsonb, 'shared', 'run')`,
    [id, input.runId, input.relativePath],
  );

  return id;
}

async function seedAttachment(input: {
  runId: string;
  relativePath: string;
}): Promise<string> {
  const id = randomUUID();

  await testDatabase.pool.query(
    `insert into scratch_runs
      (run_id, project_id, base_branch, base_commit, created_by_user_id,
       initial_prompt)
     values ($1, $2, 'main', 'deadbeef',
       (select id from users limit 1), 'seeded')
     on conflict (run_id) do nothing`,
    [input.runId, projectId],
  );
  await testDatabase.pool.query(
    `insert into scratch_attachments
      (id, run_id, kind, label, value, file_name, mime_type, byte_size,
       sha256, storage_path)
     values ($1, $2, 'uploaded_file', 'spec.txt', $3, 'spec.txt',
       'text/plain', 11, repeat('b', 64), $3)`,
    [id, input.runId, input.relativePath],
  );

  return id;
}

async function cli(command: Phase, args: readonly string[]): Promise<string> {
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
  ).catch((error: Error & { stdout?: string; stderr?: string }) => {
    error.message = `${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    throw error;
  });

  return `${result.stdout}\n${result.stderr}`;
}

async function cliExpectingRefusal(
  command: Phase,
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

async function enabledGeneration(supervisor: RealSupervisor): Promise<number> {
  const log = await supervisor.logTail(256 * 1024);
  const line = log
    .split("\n")
    .reverse()
    .find((entry) => entry.includes("import_admission_enabled"));

  if (!line) throw new Error(`no import_admission_enabled line in:\n${log}`);

  return (JSON.parse(line) as { generation: number }).generation;
}

async function startSupervisorFor(id: string): Promise<RealSupervisor> {
  const supervisor = await startRealSupervisor({
    env: {
      MAISTER_IMPORT_ADMISSION_DIR: manifestRoot,
      MAISTER_IMPORT_ADMISSION_ID: id,
    },
  });

  supervisors.push(supervisor);
  await registerHost(supervisor);

  return supervisor;
}

// The manager knows the host the way a running installation does: registered
// from the supervisor's own identity, as the web boot registers it.
async function registerHost(supervisor: RealSupervisor): Promise<void> {
  process.env.MAISTER_SUPERVISOR_URL = supervisor.url;
  const registration = await ensureLocalExecutionHost({ db: testDatabase.db });

  if (registration.status !== "registered")
    throw new Error(
      `host registration failed: ${JSON.stringify(registration)}`,
    );
}

function importId(): string {
  return `vf-${randomUUID().slice(0, 8)}`;
}

function phaseArgs(id: string, generation: number): string[] {
  return [
    "--import-id",
    id,
    "--manifest-dir",
    manifestRoot,
    "--generation",
    String(generation),
  ];
}

// inventory -> copy -> associate -> rows, the state every S4.5 case starts from.
async function preserved(
  options: {
    afterInventory?: (id: string) => Promise<void>;
    rows?: boolean;
  } = {},
): Promise<{
  id: string;
  generation: number;
  runId: string;
  runDirectory: string;
  supervisor: RealSupervisor;
  artifactId: string;
  attachmentId: string;
}> {
  const id = importId();
  const { runId, runDirectory } = await seedRun();
  const artifactId = await seedArtifact({ runId, relativePath: "plan.log" });
  const attachmentId = await seedAttachment({
    runId,
    relativePath: "uploads/spec/spec.txt",
  });

  await cli("inventory", ["--import-id", id, "--manifest-dir", manifestRoot]);
  // The manifest digest is derived over the lane rows, so anything that edits
  // the manifest has to happen BEFORE the supervisor reads it at boot —
  // otherwise the two sides derive different digests and the host refuses
  // `import_manifest_mismatch` long before any proof is computed.
  await options.afterInventory?.(id);

  const supervisor = await startSupervisorFor(id);
  const generation = await enabledGeneration(supervisor);

  await cli("copy", phaseArgs(id, generation));
  await cli("associate", phaseArgs(id, generation));
  if (options.rows !== false)
    await cli("rows", ["--import-id", id, "--manifest-dir", manifestRoot]);

  return {
    id,
    generation,
    runId,
    runDirectory,
    supervisor,
    artifactId,
    attachmentId,
  };
}

async function sealedObjects(input: {
  id: string;
  generation: number;
}): Promise<Map<string, string>> {
  const manifest = readOperatorImportManifest({
    directory: manifestRoot,
    importId: input.id,
  });
  const client = createImportMaintenanceClient({
    socketPath: join(manifestRoot, "admission", "import.sock"),
    importId: input.id,
    generation: input.generation,
    manifestDigest: manifest.digest,
  });
  const progress = await client.progress();

  return new Map(
    progress.items
      .filter((item) => item.state === "sealed" && item.sealedObjectId)
      .map((item) => [item.itemId, item.sealedObjectId as string]),
  );
}

async function sealedObjectFile(
  supervisor: RealSupervisor,
  objectId: string,
): Promise<string> {
  for (const root of [supervisor.stateDir, supervisor.runtimeRoot]) {
    const candidate = join(root, "runtime-objects", `${objectId}.1`);

    if (await stat(candidate).catch(() => null)) return candidate;
  }

  throw new Error(`sealed object ${objectId} is not on disk`);
}

async function anySealedObjectFile(input: {
  id: string;
  generation: number;
  supervisor: RealSupervisor;
}): Promise<string> {
  const objects = await sealedObjects(input);
  const first = [...objects.values()][0];

  if (!first) throw new Error("copy sealed nothing to corrupt");

  return sealedObjectFile(input.supervisor, first);
}

async function laneRows(
  runId: string,
): Promise<{ sourceKind: string; state: string }[]> {
  const rows = await testDatabase.pool.query<{
    sourceKind: string;
    state: string;
  }>(
    `select source_kind as "sourceKind", state
     from execution_data_plane_imports where run_id = $1 order by source_kind`,
    [runId],
  );

  return rows.rows;
}

async function applyMigration(
  file: string,
): Promise<{ ok: boolean; message: string }> {
  const sql = await readFile(
    resolve(process.cwd(), "lib/db/migrations", file),
    "utf8",
  );

  for (const statement of sql.split("--> statement-breakpoint")) {
    if (!statement.trim()) continue;
    try {
      await testDatabase.pool.query(statement);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  return { ok: true, message: "" };
}

describe("execution-data-plane:import-legacy verify", () => {
  it("proves every lane by streaming the host's own bytes back", async () => {
    const context = await preserved();
    const output = await cli(
      "verify",
      phaseArgs(context.id, context.generation),
    );

    expect(output).toContain("legacy_execution_data_verify_finished");
    expect(output).toContain("proofVersion");
    // Never the bytes themselves, and never an operator source path.
    expect(output).not.toContain("planning step output");
    expect(output).not.toContain("plan.log");
  }, 300_000);

  it("refuses an object the host can no longer serve whole", async () => {
    const context = await preserved();
    const file = await anySealedObjectFile(context);
    const before = await stat(file);

    await truncate(file, Math.max(0, before.size - 1));

    const output = await cliExpectingRefusal(
      "verify",
      phaseArgs(context.id, context.generation),
    );

    expect(output).toContain("verify_bytes_missing");
  }, 300_000);

  it("refuses an object whose bytes changed after the seal", async () => {
    const context = await preserved();
    const file = await anySealedObjectFile(context);
    const handle = await open(file, "r+");

    // Same length, different content: only a real readback catches this.
    try {
      await handle.write(new Uint8Array([0x58]), 0, 1, 0);
    } finally {
      await handle.close();
    }

    const output = await cliExpectingRefusal(
      "verify",
      phaseArgs(context.id, context.generation),
    );

    expect(output).toContain("verify_hash_mismatch");
  }, 300_000);

  // S4.6: the events lane's only manifest item is the manager's row
  // reconstruction, and nothing before this proved those rows exist. A run whose
  // rows were never imported must not reach `complete` on the strength of the
  // bytes alone — 0135 would flip it to canonical with an empty history.
  it("refuses a proof for a run whose rows were never imported", async () => {
    const context = await preserved({ rows: false });
    const output = await cliExpectingRefusal(
      "verify",
      phaseArgs(context.id, context.generation),
    );

    expect(output).toContain("verify_rows_missing");
    expect(
      (await laneRows(context.runId)).every((lane) => lane.state === "pending"),
    ).toBe(true);
  }, 120_000);

  it("refuses a proof whose row evidence no longer matches", async () => {
    const context = await preserved();

    await testDatabase.pool.query(
      `delete from execution_events
       where id = (select id from execution_events
                   where run_id = $1 and source = 'legacy_import' limit 1)`,
      [context.runId],
    );
    const output = await cliExpectingRefusal(
      "verify",
      phaseArgs(context.id, context.generation),
    );

    expect(output).toContain("verify_rows_mismatch");
  }, 120_000);

  // S4.8: the catalogue row the ordinary web read resolves is part of the
  // proof — a lane whose object the manager cannot find, or finds with other
  // bytes, is not preserved for the reader even if the host still has it.
  it("refuses a proof whose catalogue row is gone", async () => {
    const context = await preserved();

    await testDatabase.pool.query(
      `delete from execution_runtime_objects
       where id = (select id from execution_runtime_objects where run_id = $1 limit 1)`,
      [context.runId],
    );
    expect(
      await cliExpectingRefusal(
        "verify",
        phaseArgs(context.id, context.generation),
      ),
    ).toContain("verify_catalog_missing");
  }, 120_000);

  it("refuses a proof whose catalogue row disagrees with the frozen bytes", async () => {
    const context = await preserved();

    await testDatabase.pool.query(
      `update execution_runtime_objects set sha256 = repeat('0', 64)
       where id = (select id from execution_runtime_objects where run_id = $1 limit 1)`,
      [context.runId],
    );
    expect(
      await cliExpectingRefusal(
        "verify",
        phaseArgs(context.id, context.generation),
      ),
    ).toContain("verify_catalog_mismatch");
  }, 120_000);

  it("refuses a source that moved after it was inventoried", async () => {
    const context = await preserved();

    await writeFile(
      join(context.runDirectory, "plan.log"),
      "planning step output, edited\n",
      "utf8",
    );

    const output = await cliExpectingRefusal(
      "verify",
      phaseArgs(context.id, context.generation),
    );

    expect(output).toContain("verify_source_changed");
  }, 300_000);
});

describe("execution-data-plane:import-legacy finalize-proof", () => {
  it("writes the five complete lane records the cutover reads", async () => {
    const context = await preserved();

    // D9 step 4 already committed five `pending` lane cursors. What must not
    // exist before the proof is a `complete` one — that record is the whole
    // thing 0135 reads.
    expect((await laneRows(context.runId)).map((row) => row.state)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    await cli("finalize-proof", phaseArgs(context.id, context.generation));

    const rows = await laneRows(context.runId);

    expect(rows.map((row) => row.sourceKind)).toEqual([
      "cost",
      "events",
      "runtime_objects",
      "scratch_session",
      "transcript",
    ]);
    expect(rows.every((row) => row.state === "complete")).toBe(true);

    const complete = await testDatabase.pool.query<{ n: string }>(
      `select count(*)::text as n from execution_data_plane_imports
       where run_id = $1 and state = 'complete'
         and source_fingerprint is not null
         and last_source_position is not null
         and started_at is not null and completed_at is not null
         and attempts > 0 and last_error is null`,
      [context.runId],
    );

    expect(complete.rows[0].n).toBe("5");
  }, 300_000);

  it("writes no complete record when the proof does not hold", async () => {
    const context = await preserved();
    const file = await anySealedObjectFile(context);

    await truncate(file, 0);

    const output = await cliExpectingRefusal(
      "finalize-proof",
      phaseArgs(context.id, context.generation),
    );

    expect(output).toContain("verify_bytes_missing");
    expect(
      (await laneRows(context.runId)).some((row) => row.state === "complete"),
    ).toBe(false);
  }, 300_000);

  it("refuses a manifest that never inspected one of the five lanes", async () => {
    const context = await preserved({
      afterInventory: async (id) => {
        const db = new DatabaseSync(join(manifestRoot, `import-${id}.sqlite`));

        try {
          db.prepare("DELETE FROM import_lanes WHERE lane = ?").run("cost");
        } finally {
          db.close();
        }
      },
    });
    const output = await cliExpectingRefusal(
      "finalize-proof",
      phaseArgs(context.id, context.generation),
    );

    expect(output).toContain("proof_lane_missing");
  }, 300_000);
});

// 0134 and 0135 are one-way schema migrations against the database this file
// shares, so they are applied exactly once and last. Every case above runs on
// the pre-0134 shape deliberately; these two are the tree the cutover actually
// reaches at D9 steps 8 and 10.
describe("after the unmodified migrations", () => {
  it("refuses a post-0134 scratch shape the manifest does not describe", async () => {
    const context = await preserved();

    expect(await applyMigration("0134_lovely_tarot.sql")).toEqual({
      ok: true,
      message: "",
    });
    // The attachment still names the right object, so the association check
    // passes. What breaks is the post-0134 SHAPE: a scratch row that kept its
    // legacy path is one the cutover would carry forward with nothing behind
    // it, and only counting the canonical rows catches that.
    await testDatabase.pool.query(
      "update scratch_attachments set storage_path = $2 where run_id = $1",
      [context.runId, "uploads/spec/spec.txt"],
    );

    const output = await cliExpectingRefusal(
      "verify",
      phaseArgs(context.id, context.generation),
    );

    expect(output).toContain("verify_scratch_count_mismatch");
  }, 300_000);

  it("lets the unchanged 0135 preflight through because the proof holds", async () => {
    // 0134 is already applied by the case above, which is exactly the shape
    // step 10 runs against.
    const context = await preserved();

    await cli("finalize-proof", phaseArgs(context.id, context.generation));
    expect(await applyMigration("0135_lush_jetstream.sql")).toEqual({
      ok: true,
      message: "",
    });

    const mode = await testDatabase.pool.query<{ mode: string }>(
      "select execution_data_plane_mode as mode from runs where id = $1",
      [context.runId],
    );

    expect(mode.rows[0].mode).toBe("canonical_events_v1");
  }, 300_000);
});
