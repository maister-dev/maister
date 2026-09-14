// S4.6 / AT-11: the whole D9 procedure over a Stage A installation, executed by
// the operator's REAL tools — `db:migrate --stage` for every migration stage and
// `execution-data-plane:import-legacy` for every phase — against a real
// supervisor booted in import mode. It proves the positive migration with every
// source byte untouched, an interrupted copy that resumes at the host's
// committed offset across a supervisor crash, duplicates that change nothing,
// changed sources refused at the copy and verify boundaries, a coordinated
// snapshot set that restores and completes the cut-over, and a fresh install.

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigrationRootBefore } from "@/lib/db/m43-cutover-migration-root";
import { ensureLocalExecutionHost } from "@/lib/execution-host";
import { readRuntimeObjectContent } from "@/lib/execution-host/runtime-objects";
import {
  createImportMaintenanceClient,
  IMPORT_CHUNK_BYTES,
  readOperatorImportManifest,
  type ImportProgress,
} from "@/lib/execution-host/import-maintenance";
import {
  startBarePostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  type RealSupervisor,
} from "@/test-support/real-supervisor";

const execFileAsync = promisify(execFile);
const importerPath = resolve(
  process.cwd(),
  "scripts/import-legacy-execution-data-plane.ts",
);
const tsxPath = resolve(process.cwd(), "node_modules/.bin/tsx");
const MIGRATIONS_DIR = resolve(process.cwd(), "lib/db/migrations");
// Above the 25 MiB ordinary-upload limit and five full protocol chunks plus a
// tail, so an interrupted copy has a committed offset that is neither 0 nor the
// whole file.
const LARGE_LOG_BYTES = 5 * IMPORT_CHUNK_BYTES + 17;
const IMPORT_ID = "at11-cutover";

type Phase =
  | "inventory"
  | "copy"
  | "associate"
  | "rows"
  | "verify"
  | "finalize-proof";

type SourceListing = Map<string, { size: number; sha256: string }>;

type Fixture = {
  flowRunId: string;
  scratchRunId: string;
  crashedRunId: string;
  artifactIds: { plan: string; report: string; large: string[] };
  attachmentIds: string[];
  expectedRows: Record<string, number>;
};

let testDatabase: StartedPostgresTestDb;
let preStageRoot: string;
let legacyRoot: string;
let manifestRoot: string;
let snapshotRoot: string;
let projectId: string;
let slug: string;
let fixture: Fixture;
let supervisor: RealSupervisor;
const supervisors: RealSupervisor[] = [];
const extraDatabases: StartedPostgresTestDb[] = [];
let restoredPool: Pool | undefined;

// State the restore case continues from: the four-part snapshot the first case
// takes right before the destructive stage.
let snapshot:
  | {
      legacyRoot: string;
      manifestRoot: string;
      runtimeRoot: string;
      stateDir: string;
      dumpFile: string;
    }
  | undefined;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(absolutePath)) {
    hash.update(new Uint8Array(chunk as Buffer));
  }

  return hash.digest("hex");
}

async function listSources(root: string): Promise<SourceListing> {
  const listing: SourceListing = new Map();

  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(absolute, relativePath);
        continue;
      }
      const metadata = await stat(absolute);

      listing.set(relativePath, {
        size: metadata.size,
        sha256: await hashFile(absolute),
      });
    }
  }

  await walk(root, "");

  return listing;
}

function runDirectory(root: string, runId: string): string {
  return join(root, ".maister", slug, "runs", runId);
}

function eventLine(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

function largeLogBytes(): Buffer {
  // A repeating pattern rather than zeros, so a chunk replayed at the wrong
  // offset could never hash equal by accident.
  const bytes = Buffer.alloc(LARGE_LOG_BYTES);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = 32 + ((index * 7919 + (index >> 12)) % 90);
  }

  return bytes;
}

async function insertRun(
  runId: string,
  runKind: "flow" | "scratch",
): Promise<void> {
  // The 0130 shape: no data-plane mode column yet — 0131 adds it and marks every
  // existing run `legacy_file_v1`, exactly as the upgrade does.
  await testDatabase.pool.query(
    `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision, started_at)
     values ($1, $2, $3, 'Done', $4, $5, '2026-09-04T00:00:00.000Z')`,
    [
      runId,
      projectId,
      runKind,
      runKind === "flow" ? "test-flow" : "scratch",
      runKind === "flow" ? "legacy" : "manual",
    ],
  );
}

async function insertArtifact(input: {
  runId: string;
  nodeAttemptId: string | null;
  kind: string;
  relativePath: string;
}): Promise<string> {
  const id = randomUUID();

  await testDatabase.pool.query(
    `insert into artifact_instances
      (id, run_id, node_attempt_id, node_id, attempt, kind, producer, locator,
       validity, required_for, visibility, retention)
     values ($1, $2, $3, 'build', 1, $4, 'runner',
       jsonb_build_object('kind', 'file', 'path', $5::text),
       'current', '["review"]'::jsonb, 'shared', 'run')`,
    [id, input.runId, input.nodeAttemptId, input.kind, input.relativePath],
  );

  return id;
}

async function insertAttachment(input: {
  runId: string;
  relativePath: string;
  bytes: Buffer;
  mime: string;
}): Promise<string> {
  const id = randomUUID();
  const fileName = input.relativePath.split("/").pop() ?? input.relativePath;

  await testDatabase.pool.query(
    `insert into scratch_attachments
      (id, run_id, kind, label, value, file_name, mime_type, byte_size, sha256, storage_path)
     values ($1, $2, 'uploaded_file', $3, $4, $3, $5, $6, $7, $4)`,
    [
      id,
      input.runId,
      fileName,
      input.relativePath,
      input.mime,
      input.bytes.length,
      sha256(new Uint8Array(input.bytes)),
    ],
  );

  return id;
}

// A Stage A history the pre-S4.6 importer could not have preserved: ordinary,
// empty and >25 MiB logs, nested evidence, a produced artifact with a name no
// rule recognises, two artifact rows over one file, uploads, several sessions
// with checkpoint metadata, a run that crashed before writing any cost.
async function seedStageAHistory(): Promise<Fixture> {
  const flowRunId = randomUUID();
  const scratchRunId = randomUUID();
  const crashedRunId = randomUUID();

  await insertRun(flowRunId, "flow");
  await insertRun(scratchRunId, "scratch");
  await insertRun(crashedRunId, "flow");

  const attemptIds = { plan: randomUUID(), build: randomUUID() };

  for (const [nodeId, session] of [
    ["plan", "acp-plan-1"],
    ["build", "acp-build-1"],
  ] as const) {
    await testDatabase.pool.query(
      `insert into node_attempts (id, run_id, node_id, node_type, attempt, status, acp_session_id)
       values ($1, $2, $3, 'ai_coding', 1, 'Succeeded', $4)`,
      [attemptIds[nodeId], flowRunId, nodeId, session],
    );
  }

  const flowDirectory = runDirectory(legacyRoot, flowRunId);

  await mkdir(join(flowDirectory, "steps", "review"), { recursive: true });
  const flowEvents = [
    {
      type: "session.created",
      sessionId: "acp-plan-1",
      monotonicId: 1,
      ts: "2026-09-04T00:00:01.000Z",
    },
    {
      type: "session.line",
      sessionId: "acp-plan-1",
      monotonicId: 2,
      line: "planning the change",
      ts: "2026-09-04T00:00:02.000Z",
    },
    {
      type: "session.update",
      sessionId: "acp-plan-1",
      monotonicId: 3,
      update: { kind: "agent_message_chunk" },
      ts: "2026-09-04T00:00:03.000Z",
    },
    {
      type: "session.exited",
      sessionId: "acp-plan-1",
      monotonicId: 4,
      exitCode: 0,
      ts: "2026-09-04T00:00:04.000Z",
    },
    {
      type: "session.created",
      sessionId: "acp-build-1",
      monotonicId: 5,
      ts: "2026-09-04T00:01:00.000Z",
    },
    {
      type: "session.line",
      sessionId: "acp-build-1",
      monotonicId: 6,
      line: "building",
      authorization: "Bearer must-not-survive",
      ts: "2026-09-04T00:01:01.000Z",
    },
    {
      type: "session.permission_request",
      sessionId: "acp-build-1",
      monotonicId: 7,
      requestId: "perm-1",
      ts: "2026-09-04T00:01:02.000Z",
    },
    {
      type: "session.exited",
      sessionId: "acp-build-1",
      monotonicId: 8,
      exitCode: 0,
      ts: "2026-09-04T00:01:03.000Z",
    },
  ];
  const flowCosts = [
    {
      ts: "2026-09-04T00:00:04.000Z",
      sessionId: "acp-plan-1",
      input_tokens: 120,
      output_tokens: 40,
      model: "test-model",
    },
    {
      ts: "2026-09-04T00:01:03.000Z",
      sessionId: "acp-build-1",
      input_tokens: 300,
      output_tokens: 90,
      model: "test-model",
      resumed: true,
    },
  ];

  await writeFile(
    join(flowDirectory, "run.events.jsonl"),
    flowEvents.map(eventLine).join(""),
    "utf8",
  );
  await writeFile(
    join(flowDirectory, "cost.jsonl"),
    flowCosts.map(eventLine).join(""),
    "utf8",
  );
  await writeFile(
    join(flowDirectory, "plan.log"),
    "planning step output\n",
    "utf8",
  );
  await writeFile(join(flowDirectory, "empty.log"), "", "utf8");
  await writeFile(
    join(flowDirectory, "build.log"),
    new Uint8Array(largeLogBytes()),
  );
  await writeFile(
    join(flowDirectory, "steps", "review", "attempt-1.log"),
    "review notes\n",
    "utf8",
  );
  await writeFile(
    join(flowDirectory, "e2e-report.tar.gz"),
    new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]),
  );
  await writeFile(
    join(flowDirectory, "run.json"),
    eventLine({ status: "Done" }),
    "utf8",
  );
  await writeFile(
    join(flowDirectory, "needs-input.json"),
    eventLine({ pending: null }),
    "utf8",
  );
  await writeFile(
    join(flowDirectory, "input-review.json"),
    eventLine({ decision: "approve" }),
    "utf8",
  );
  await writeFile(
    join(flowDirectory, "output-plan.json"),
    eventLine({ result: { ok: true } }),
    "utf8",
  );
  await writeFile(
    join(flowDirectory, "session.json"),
    eventLine({ acp_session_id: "acp-build-1", executor_id: "claude" }),
    "utf8",
  );
  await writeFile(
    join(flowDirectory, "checkpoint-1.json"),
    eventLine({ acp_session_id: "acp-plan-1" }),
    "utf8",
  );
  await writeFile(
    join(flowDirectory, "checkpoint-2.json"),
    eventLine({ acp_session_id: "acp-build-1" }),
    "utf8",
  );

  const artifactIds = {
    plan: await insertArtifact({
      runId: flowRunId,
      nodeAttemptId: attemptIds.plan,
      kind: "log",
      relativePath: "plan.log",
    }),
    report: await insertArtifact({
      runId: flowRunId,
      nodeAttemptId: attemptIds.build,
      kind: "generic_file",
      relativePath: "e2e-report.tar.gz",
    }),
    large: [
      await insertArtifact({
        runId: flowRunId,
        nodeAttemptId: attemptIds.build,
        kind: "log",
        relativePath: "build.log",
      }),
      await insertArtifact({
        runId: flowRunId,
        nodeAttemptId: null,
        kind: "test_report",
        relativePath: join(flowDirectory, "build.log"),
      }),
    ],
  };

  const scratchDirectory = runDirectory(legacyRoot, scratchRunId);
  const specBytes = Buffer.from("scratch spec bytes\n", "utf8");
  const diagramBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
  ]);

  await mkdir(join(scratchDirectory, "uploads", "msg-1"), { recursive: true });
  await mkdir(join(scratchDirectory, "uploads", "msg-2"), { recursive: true });
  await writeFile(
    join(scratchDirectory, "run.events.jsonl"),
    [
      {
        type: "session.created",
        sessionId: "acp-scratch-1",
        monotonicId: 1,
        ts: "2026-09-05T10:00:00.000Z",
      },
      {
        type: "session.chat_turn",
        sessionId: "acp-scratch-1",
        monotonicId: 2,
        role: "user",
        text: "look at the spec",
        ts: "2026-09-05T10:00:01.000Z",
      },
      {
        type: "session.exited",
        sessionId: "acp-scratch-1",
        monotonicId: 3,
        exitCode: 0,
        ts: "2026-09-05T10:00:02.000Z",
      },
    ]
      .map(eventLine)
      .join(""),
    "utf8",
  );
  await writeFile(
    join(scratchDirectory, "cost.jsonl"),
    eventLine({
      ts: "2026-09-05T10:00:02.000Z",
      sessionId: "acp-scratch-1",
      input_tokens: 10,
      output_tokens: 5,
    }),
    "utf8",
  );
  await writeFile(
    join(scratchDirectory, "uploads", "msg-1", "spec.txt"),
    new Uint8Array(specBytes),
  );
  await writeFile(
    join(scratchDirectory, "uploads", "msg-2", "diagram.png"),
    new Uint8Array(diagramBytes),
  );
  await testDatabase.pool.query(
    `insert into scratch_runs (run_id, project_id, base_branch, base_commit, created_by_user_id, initial_prompt)
     values ($1, $2, 'main', 'deadbeef', (select id from users limit 1), 'seeded')`,
    [scratchRunId, projectId],
  );
  const attachmentIds = [
    await insertAttachment({
      runId: scratchRunId,
      relativePath: "uploads/msg-1/spec.txt",
      bytes: specBytes,
      mime: "text/plain",
    }),
    await insertAttachment({
      runId: scratchRunId,
      relativePath: "uploads/msg-2/diagram.png",
      bytes: diagramBytes,
      mime: "image/png",
    }),
  ];

  const crashedDirectory = runDirectory(legacyRoot, crashedRunId);

  await mkdir(crashedDirectory, { recursive: true });
  await writeFile(
    join(crashedDirectory, "run.events.jsonl"),
    [
      {
        type: "session.created",
        sessionId: "acp-crash-1",
        monotonicId: 1,
        ts: "2026-09-06T00:00:00.000Z",
      },
      {
        type: "session.crashed",
        sessionId: "acp-crash-1",
        monotonicId: 2,
        signal: "SIGKILL",
        ts: "2026-09-06T00:00:01.000Z",
      },
    ]
      .map(eventLine)
      .join(""),
    "utf8",
  );
  await writeFile(join(crashedDirectory, "crash.log"), "", "utf8");

  return {
    flowRunId,
    scratchRunId,
    crashedRunId,
    artifactIds,
    attachmentIds,
    expectedRows: {
      [flowRunId]: flowEvents.length + flowCosts.length,
      [scratchRunId]: 3 + 1,
      [crashedRunId]: 2,
    },
  };
}

beforeAll(async () => {
  testDatabase = await startBarePostgresTestDb({
    databaseName: "legacy_cutover_at11_test",
  });
  // A Stage A installation: the committed lineage through 0130, applied by
  // drizzle so the migration ledger is exactly what an upgrade starts from.
  preStageRoot = await createMigrationRootBefore(
    MIGRATIONS_DIR,
    "0131_foamy_venom",
  );
  await migrate(testDatabase.db, { migrationsFolder: preStageRoot });

  legacyRoot = await mkdtemp(join(tmpdir(), "at11-legacy-"));
  manifestRoot = await mkdtemp(join(tmpdir(), "at11-manifest-"));
  snapshotRoot = await mkdtemp(join(tmpdir(), "at11-snapshot-"));
  projectId = randomUUID();
  slug = `at11-${projectId.replace(/-/g, "").slice(0, 8)}`;

  await testDatabase.pool.query(
    `insert into users (id, email, role, account_status) values ($1, $2, 'admin', 'active')`,
    [randomUUID(), `${slug}@example.test`],
  );
  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [
      projectId,
      slug,
      `AT-11 ${slug}`,
      `/tmp/${slug}`,
      `A${slug.slice(-5).toUpperCase()}`,
    ],
  );
  fixture = await seedStageAHistory();
}, 300_000);

afterAll(async () => {
  for (const running of supervisors.splice(0))
    await running.stop().catch(() => undefined);
  await restoredPool?.end();
  for (const database of extraDatabases.splice(0)) await database.stop();
  await testDatabase?.stop();
  for (const directory of [
    legacyRoot,
    manifestRoot,
    snapshotRoot,
    preStageRoot,
  ]) {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

type CliEnv = { DB_URL?: string; MAISTER_LEGACY_RUNTIME_ROOT?: string };

function cliEnv(overrides: CliEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DB_URL: overrides.DB_URL ?? testDatabase.databaseUrl,
    MAISTER_LEGACY_RUNTIME_ROOT:
      overrides.MAISTER_LEGACY_RUNTIME_ROOT ?? legacyRoot,
  };
}

async function cli(
  command: Phase,
  args: readonly string[],
  env: CliEnv = {},
): Promise<string> {
  const result = await execFileAsync(
    tsxPath,
    [
      "--import",
      "./scripts/_register-shim.mjs",
      importerPath,
      command,
      ...args,
    ],
    { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024, env: cliEnv(env) },
  ).catch((error: Error & { stdout?: string; stderr?: string }) => {
    error.message = `${command} failed: ${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    throw error;
  });

  return `${result.stdout}\n${result.stderr}`;
}

async function cliExpectingRefusal(
  command: Phase,
  args: readonly string[],
  env: CliEnv = {},
): Promise<string> {
  try {
    const output = await cli(command, args, env);

    throw new Error(`${command} succeeded unexpectedly: ${output}`);
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };

    return `${failure.stdout ?? ""}\n${failure.stderr ?? failure.message}`;
  }
}

async function migrator(
  args: readonly string[],
  env: CliEnv = {},
): Promise<{ exitCode: number; output: string }> {
  try {
    const result = await execFileAsync(
      tsxPath,
      [
        "--import",
        "./scripts/_register-shim.mjs",
        "lib/db/migrate.ts",
        ...args,
      ],
      { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024, env: cliEnv(env) },
    );

    return { exitCode: 0, output: `${result.stdout}\n${result.stderr}` };
  } catch (error) {
    const failure = error as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };

    return {
      exitCode: failure.code ?? 1,
      output: `${failure.stdout ?? ""}\n${failure.stderr ?? failure.message}`,
    };
  }
}

// The CLI as a killable process: it leads its own group so SIGKILL reaches the
// node process behind the tsx shim, exactly like an operator's Ctrl-C or a host
// crash would.
function spawnCli(
  command: Phase,
  args: readonly string[],
): {
  killGroup(): void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
} {
  const child = spawn(
    tsxPath,
    [
      "--import",
      "./scripts/_register-shim.mjs",
      importerPath,
      command,
      ...args,
    ],
    { cwd: process.cwd(), env: cliEnv(), stdio: "ignore", detached: true },
  );
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

  return {
    killGroup: () => {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    },
    exited,
  };
}

function lastLogLine(output: string, event: string): Record<string, unknown> {
  const line = output
    .split("\n")
    .reverse()
    .find((entry) => entry.includes(`"event":"${event}"`));

  if (!line) throw new Error(`no ${event} line in:\n${output.slice(-4000)}`);

  return JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>;
}

async function enabledGeneration(running: RealSupervisor): Promise<number> {
  const log = await running.logTail(512 * 1024);
  const line = log
    .split("\n")
    .reverse()
    .find((entry) => entry.includes("import_admission_enabled"));

  if (!line) throw new Error(`no import_admission_enabled line in:\n${log}`);

  return (JSON.parse(line) as { generation: number }).generation;
}

async function bootSupervisor(input: {
  manifestRoot: string;
  runtimeRoot?: string;
  stateDir?: string;
}): Promise<RealSupervisor> {
  const running = await startRealSupervisor({
    runtimeRoot: input.runtimeRoot,
    stateDir: input.stateDir,
    env: {
      MAISTER_IMPORT_ADMISSION_DIR: input.manifestRoot,
      MAISTER_IMPORT_ADMISSION_ID: IMPORT_ID,
    },
  });

  supervisors.push(running);

  return running;
}

// A Stage A installation already knows its host: the web tier registered it
// from the supervisor's own identity at its last boot. Registering again after
// a restart is what the web boot does and changes nothing but the boot id.
async function registerHost(
  running: RealSupervisor,
  db: typeof testDatabase.db,
): Promise<void> {
  process.env.MAISTER_SUPERVISOR_URL = running.url;
  const registration = await ensureLocalExecutionHost({ db });

  if (registration.status !== "registered")
    throw new Error(
      `host registration failed: ${JSON.stringify(registration)}`,
    );
}

function phaseArgs(generation: number, directory = manifestRoot): string[] {
  return [
    "--import-id",
    IMPORT_ID,
    "--manifest-dir",
    directory,
    "--generation",
    String(generation),
  ];
}

function manifestArgs(directory = manifestRoot): string[] {
  return ["--import-id", IMPORT_ID, "--manifest-dir", directory];
}

function maintenanceClient(generation: number, directory = manifestRoot) {
  const manifest = readOperatorImportManifest({
    directory,
    importId: IMPORT_ID,
  });

  return {
    manifest,
    client: createImportMaintenanceClient({
      socketPath: join(directory, "admission", "import.sock"),
      importId: IMPORT_ID,
      generation,
      manifestDigest: manifest.digest,
    }),
  };
}

async function laneStates(
  pool: Pool,
  runId: string,
): Promise<Record<string, string>> {
  const rows = await pool.query<{ kind: string; state: string }>(
    `select source_kind as kind, state from execution_data_plane_imports where run_id = $1 order by source_kind`,
    [runId],
  );

  return Object.fromEntries(rows.rows.map((row) => [row.kind, row.state]));
}

async function legacyRowCount(pool: Pool, runId: string): Promise<number> {
  const rows = await pool.query<{ n: number }>(
    `select count(*)::int as n from execution_events where run_id = $1 and source = 'legacy_import'`,
    [runId],
  );

  return rows.rows[0].n;
}

async function sealedObjectFile(
  running: RealSupervisor,
  objectId: string,
): Promise<string> {
  for (const root of [running.stateDir, running.runtimeRoot]) {
    const candidate = join(root, "runtime-objects", `${objectId}.1`);

    if (await stat(candidate).catch(() => null)) return candidate;
  }

  throw new Error(`sealed object ${objectId} is not on disk`);
}

// Every copy item the manifest froze must be on the host as a sealed object
// whose bytes hash exactly like the source, and every row the phases repointed
// must name one of those objects.
async function assertPreserved(input: {
  pool: Pool;
  running: RealSupervisor;
  generation: number;
  manifestDirectory: string;
}): Promise<void> {
  const { manifest, client } = maintenanceClient(
    input.generation,
    input.manifestDirectory,
  );
  const progress = await client.progress();
  const sealed = new Map(
    progress.items
      .filter((item) => item.state === "sealed" && item.sealedObjectId)
      .map((item) => [item.itemId, item.sealedObjectId as string]),
  );

  expect(manifest.items.length).toBeGreaterThan(0);
  for (const item of manifest.items) {
    const objectId = sealed.get(item.itemId);

    expect(
      objectId,
      `item ${item.itemId} (${item.lane}) never sealed`,
    ).toBeDefined();
    const objectFile = await sealedObjectFile(
      input.running,
      objectId as string,
    );

    expect((await stat(objectFile)).size).toBe(item.sizeBytes);
    expect(await hashFile(objectFile)).toBe(item.sha256);
  }

  const artifacts = await input.pool.query<{
    id: string;
    locator: { kind: string; objectId?: string };
  }>(
    `select id, locator from artifact_instances where run_id = $1 order by id`,
    [fixture.flowRunId],
  );

  expect(artifacts.rows).toHaveLength(4);
  for (const artifact of artifacts.rows) {
    expect(artifact.locator.kind).toBe("execution-object");
    expect([...sealed.values()]).toContain(artifact.locator.objectId);
  }

  const attachments = await input.pool.query<{
    value: string;
    storage_path: string | null;
  }>(
    `select value, storage_path from scratch_attachments where run_id = $1 order by id`,
    [fixture.scratchRunId],
  );

  expect(attachments.rows).toHaveLength(2);
  for (const attachment of attachments.rows) {
    expect(attachment.storage_path).toBeNull();
    expect([...sealed.values()]).toContain(attachment.value);
  }

  for (const [runId, expected] of Object.entries(fixture.expectedRows)) {
    expect(await legacyRowCount(input.pool, runId), `rows of ${runId}`).toBe(
      expected,
    );
  }
}

async function assertCanonical(pool: Pool): Promise<void> {
  const modes = await pool.query<{ mode: string; n: number }>(
    `select execution_data_plane_mode as mode, count(*)::int as n from runs group by 1`,
  );

  expect(modes.rows).toEqual([{ mode: "canonical_events_v1", n: 3 }]);
  const cursors = await pool.query(
    `select 1 from information_schema.tables where table_name = 'artifact_projection_cursors'`,
  );

  expect(cursors.rows).toHaveLength(0);
}

function largeItem(progress: ImportProgress) {
  return progress.items.find((item) => item.sizeBytes === LARGE_LOG_BYTES);
}

describe("AT-11 baseline upgrade", () => {
  it("migrates a Stage A installation through the real operator tools with every source byte untouched", async () => {
    const before = await listSources(legacyRoot);

    expect(before.size).toBe(20);
    expect(
      before.get(`.maister/${slug}/runs/${fixture.flowRunId}/build.log`)?.size,
    ).toBe(LARGE_LOG_BYTES);

    // Step 3: additive stage. The importer's window opens; nothing destructive.
    const additive = await migrator(["--stage", "execution-ab-additive"]);

    expect(additive.exitCode, additive.output).toBe(0);

    // Step 4: inventory freezes every source of every run, five pending lanes
    // each, and a second inventory over unchanged sources is a no-op.
    await cli("inventory", manifestArgs());
    const frozenDigest = readOperatorImportManifest({
      directory: manifestRoot,
      importId: IMPORT_ID,
    }).digest;

    await cli("inventory", manifestArgs());
    expect(
      readOperatorImportManifest({
        directory: manifestRoot,
        importId: IMPORT_ID,
      }).digest,
    ).toBe(frozenDigest);
    for (const runId of Object.keys(fixture.expectedRows)) {
      expect(Object.values(await laneStates(testDatabase.pool, runId))).toEqual(
        Array(5).fill("pending"),
      );
    }

    // Step 5: a changed source is refused at the copy boundary before a byte of
    // it lands. The large log is the one edited, so it is also the one item the
    // interrupted copy below still has to send.
    supervisor = await bootSupervisor({ manifestRoot });
    await registerHost(supervisor, testDatabase.db);
    const generation1 = await enabledGeneration(supervisor);
    const buildLog = join(
      runDirectory(legacyRoot, fixture.flowRunId),
      "build.log",
    );
    const buildLogKey = `.maister/${slug}/runs/${fixture.flowRunId}/build.log`;

    await appendFile(buildLog, "x", "utf8");
    const refusedCopy = await cliExpectingRefusal(
      "copy",
      phaseArgs(generation1),
    );

    expect(refusedCopy).toContain("source_fingerprint_changed");
    const { manifest: frozenManifest, client: client1 } =
      maintenanceClient(generation1);
    const largeItemCount = frozenManifest.items.filter(
      (item) => item.sizeBytes === LARGE_LOG_BYTES,
    ).length;

    expect(largeItemCount).toBe(3);
    expect(largeItem(await client1.progress())?.receivedBytes).toBe(0);
    await truncate(buildLog, LARGE_LOG_BYTES);
    expect(await hashFile(buildLog)).toBe(before.get(buildLogKey)?.sha256);

    // Step 5, interrupted: the copy is killed while the large log is in flight.
    const interrupted = spawnCli("copy", phaseArgs(generation1));
    let committedBytes = 0;

    for (;;) {
      const item = largeItem(await client1.progress());

      if (item && item.receivedBytes > 0 && item.state !== "sealed") {
        committedBytes = item.receivedBytes;
        break;
      }
      if (item?.state === "sealed")
        throw new Error(
          "the large log sealed before the copy could be interrupted",
        );
    }
    interrupted.killGroup();
    expect((await interrupted.exited).signal).toBe("SIGKILL");
    const afterKill = largeItem(await client1.progress());

    expect(afterKill?.state).not.toBe("sealed");
    expect(afterKill?.receivedBytes).toBeGreaterThanOrEqual(committedBytes);
    expect(afterKill?.receivedBytes).toBeLessThanOrEqual(LARGE_LOG_BYTES);
    // Whatever was in flight, the ledger only ever holds whole chunks.
    expect(
      (afterKill?.receivedBytes ?? 0) % IMPORT_CHUNK_BYTES === 0 ||
        afterKill?.receivedBytes === LARGE_LOG_BYTES,
    ).toBe(true);

    // The host dies too. Its restart mints the next generation; the old one is
    // refused, and the copy resumes at the committed offset rather than at 0.
    supervisor = await supervisor.restart();
    supervisors.push(supervisor);
    await registerHost(supervisor, testDatabase.db);
    const generation2 = await enabledGeneration(supervisor);

    expect(generation2).toBeGreaterThan(generation1);
    expect(await cliExpectingRefusal("copy", phaseArgs(generation1))).toContain(
      "import_generation_stale",
    );
    const resumed = lastLogLine(
      await cli("copy", phaseArgs(generation2)),
      "legacy_execution_data_copy_finished",
    );

    expect(resumed.unresolvedCount).toBe(0);
    expect(resumed.sealed).toBe(largeItemCount);
    expect(Number(resumed.resentBytes)).toBeLessThanOrEqual(IMPORT_CHUNK_BYTES);
    const { client: client2 } = maintenanceClient(generation2);
    const totals = (await client2.progress()).totals;

    expect(totals.sealed).toBe(totals.items);
    expect(totals.receivedBytes).toBe(totals.expectedBytes);

    // Steps 6-7 and the row reconstruction. The inventory is the one phase
    // that cannot follow `associate` — the rows it reads were repointed by the
    // import itself — so it refuses and leaves the frozen manifest intact.
    await cli("associate", phaseArgs(generation2));
    expect(await cliExpectingRefusal("inventory", manifestArgs())).toContain(
      "source_fingerprint_changed",
    );
    expect(
      readOperatorImportManifest({
        directory: manifestRoot,
        importId: IMPORT_ID,
      }).digest,
    ).toBe(frozenDigest);
    await cli("rows", manifestArgs());
    for (const [runId, expected] of Object.entries(fixture.expectedRows)) {
      expect(await legacyRowCount(testDatabase.pool, runId)).toBe(expected);
      expect(Object.values(await laneStates(testDatabase.pool, runId))).toEqual(
        Array(5).fill("pending"),
      );
    }
    const redacted = await testDatabase.pool.query(
      `select payload::text as payload from execution_events where run_id = $1`,
      [fixture.flowRunId],
    );

    expect(
      redacted.rows.some((row) => row.payload.includes("must-not-survive")),
    ).toBe(false);

    // Step 9 before 0134: the proof holds, and a source changed after the seal
    // is refused at the verify boundary until it is restored.
    await cli("verify", phaseArgs(generation2));
    const emptyLog = join(
      runDirectory(legacyRoot, fixture.flowRunId),
      "empty.log",
    );

    await appendFile(emptyLog, "x", "utf8");
    expect(
      await cliExpectingRefusal("verify", phaseArgs(generation2)),
    ).toContain("verify_source_changed");
    await truncate(emptyLog, 0);
    await cli("verify", phaseArgs(generation2));

    // The coordinated snapshot set (D9 steps 1-2) is taken with every writer
    // stopped, right before the destructive stage: Postgres, the host's runtime
    // root and state, the operator manifest directory and the legacy sources.
    await supervisor.stop();
    const dumpFile = "/tmp/at11-before-0134.dump";
    const dump = await testDatabase.container.exec([
      "sh",
      "-c",
      `PGPASSWORD=test pg_dump -U test -Fc -d legacy_cutover_at11_test -f ${dumpFile}`,
    ]);

    expect(dump.exitCode, dump.output).toBe(0);
    snapshot = {
      legacyRoot: join(snapshotRoot, "legacy"),
      manifestRoot: join(snapshotRoot, "manifest"),
      runtimeRoot: join(snapshotRoot, "runtime"),
      stateDir: join(snapshotRoot, "runtime", ".maister", "execution-host"),
      dumpFile,
    };
    await cp(legacyRoot, snapshot.legacyRoot, { recursive: true });
    await cp(manifestRoot, snapshot.manifestRoot, {
      recursive: true,
      // The socket is the live listener's, not state; the restored host binds its own.
      filter: (source) => !source.includes(`${manifestRoot}/admission`),
    });
    await cp(supervisor.runtimeRoot, snapshot.runtimeRoot, { recursive: true });
    supervisor = await supervisor.restart();
    supervisors.push(supervisor);
    await registerHost(supervisor, testDatabase.db);
    const generation3 = await enabledGeneration(supervisor);

    // Step 8: 0134 alone, through the staged migrator, then the proof again
    // against the post-0134 shape.
    const associations = await migrator([
      "--stage",
      "execution-ab-associations",
    ]);

    expect(associations.exitCode, associations.output).toBe(0);
    await cli("verify", phaseArgs(generation3));

    // Duplicates: every phase re-run changes nothing. 0134 has already written
    // the scratch lane's no-mirror record, so from here the inventory refuses
    // out of phase order rather than as drift.
    expect(await cliExpectingRefusal("inventory", manifestArgs())).toContain(
      "lane_already_complete",
    );
    const rowsAgain = await cli("rows", manifestArgs());

    expect((rowsAgain.match(/"alreadyComplete":true/g) ?? []).length).toBe(3);
    const copyAgain = lastLogLine(
      await cli("copy", phaseArgs(generation3)),
      "legacy_execution_data_copy_finished",
    );

    expect(copyAgain.sealed).toBe(0);
    expect(copyAgain.skipped).toBe(totals.items);
    expect(copyAgain.resentBytes).toBe(0);
    const associateAgain = await cli("associate", phaseArgs(generation3));

    expect(associateAgain).not.toContain('"outcome":"repointed"');
    await cli("verify", phaseArgs(generation3));
    for (const [runId, expected] of Object.entries(fixture.expectedRows)) {
      expect(await legacyRowCount(testDatabase.pool, runId)).toBe(expected);
    }

    // Step 9: the only writer of `complete`; afterwards the earlier phases refuse
    // to run out of order rather than write over the proof.
    await cli("finalize-proof", phaseArgs(generation3));
    for (const runId of Object.keys(fixture.expectedRows)) {
      expect(Object.values(await laneStates(testDatabase.pool, runId))).toEqual(
        Array(5).fill("complete"),
      );
    }
    expect(await cliExpectingRefusal("rows", manifestArgs())).toContain(
      "lane_already_complete",
    );
    expect(await cliExpectingRefusal("inventory", manifestArgs())).toContain(
      "lane_already_complete",
    );
    await assertPreserved({
      pool: testDatabase.pool,
      running: supervisor,
      generation: generation3,
      manifestDirectory: manifestRoot,
    });

    // Step 10: unchanged 0135-0136 and every forward migration after them.
    const finalize = await migrator(["--stage", "execution-ab-finalize"]);

    expect(finalize.exitCode, finalize.output).toBe(0);
    await assertCanonical(testDatabase.pool);
    expect(await cliExpectingRefusal("rows", manifestArgs())).toContain(
      "already_canonical",
    );
    // Step 10, the writer floor: a session that declares no capability — every
    // binary older than this floor — can no longer touch a preservation record.
    await expect(
      testDatabase.pool.query(
        `update execution_data_plane_imports set attempts = attempts + 1 where run_id = $1`,
        [fixture.flowRunId],
      ),
    ).rejects.toThrow(/writer_class=undeclared/);

    // Step 11: the current web tier, with the legacy root inaccessible, serves
    // the preserved history through its ORDINARY path — the manager catalogue
    // and the host's content route — never through the maintenance socket and
    // never from a source file.
    await registerHost(supervisor, testDatabase.db);
    const offlineRoot = `${legacyRoot}.offline`;

    await rename(legacyRoot, offlineRoot);
    try {
      const artifact = await testDatabase.pool.query<{ objectId: string }>(
        `select locator->>'objectId' as "objectId" from artifact_instances where id = $1`,
        [fixture.artifactIds.plan],
      );
      const attachment = await testDatabase.pool.query<{ objectId: string }>(
        `select value as "objectId" from scratch_attachments where id = $1`,
        [fixture.attachmentIds[0]],
      );
      const planLog = await readRuntimeObjectContent({
        db: testDatabase.db,
        runId: fixture.flowRunId,
        objectId: artifact.rows[0].objectId,
      });
      const spec = await readRuntimeObjectContent({
        db: testDatabase.db,
        runId: fixture.scratchRunId,
        objectId: attachment.rows[0].objectId,
      });

      expect(new TextDecoder().decode(planLog.content.bytes)).toBe(
        "planning step output\n",
      );
      expect(new TextDecoder().decode(spec.content.bytes)).toBe(
        "scratch spec bytes\n",
      );
    } finally {
      await rename(offlineRoot, legacyRoot);
    }

    // Sources were read and never written, moved or removed.
    expect(await listSources(legacyRoot)).toEqual(before);
  }, 600_000);

  it("restores the coordinated snapshot set and completes the cut-over from it", async () => {
    if (!snapshot)
      throw new Error(
        "the positive migration did not leave a snapshot to restore",
      );

    // Restore to disposable storage: a new database in the same server from the
    // dump, and the three directories from their copies.
    const restoredName = "legacy_cutover_at11_restored";

    await testDatabase.pool.query(`create database ${restoredName}`);
    const restore = await testDatabase.container.exec([
      "sh",
      "-c",
      `PGPASSWORD=test pg_restore -U test -d ${restoredName} --no-owner ${snapshot.dumpFile}`,
    ]);

    expect(restore.exitCode, restore.output).toBe(0);
    const restoredUrl = new URL(testDatabase.databaseUrl);

    restoredUrl.pathname = `/${restoredName}`;
    restoredPool = new Pool({
      connectionString: restoredUrl.toString(),
      max: 2,
    });
    const env = {
      DB_URL: restoredUrl.toString(),
      MAISTER_LEGACY_RUNTIME_ROOT: snapshot.legacyRoot,
    };

    // The restored database is exactly the pre-0134 state: proven lanes still
    // pending, rows present, the mirror column still there.
    for (const [runId, expected] of Object.entries(fixture.expectedRows)) {
      expect(await legacyRowCount(restoredPool, runId)).toBe(expected);
      expect(Object.values(await laneStates(restoredPool, runId))).toEqual(
        Array(5).fill("pending"),
      );
    }
    const mirror = await restoredPool.query(
      `select 1 from information_schema.columns where table_name = 'scratch_runs' and column_name = 'supervisor_session_id'`,
    );

    expect(mirror.rows).toHaveLength(1);

    // The restored host resumes the same import id from its restored ledger.
    const restored = await bootSupervisor({
      manifestRoot: snapshot.manifestRoot,
      runtimeRoot: snapshot.runtimeRoot,
      stateDir: snapshot.stateDir,
    });
    const generation = await enabledGeneration(restored);

    await cli("verify", phaseArgs(generation, snapshot.manifestRoot), env);
    const associations = await migrator(
      ["--stage", "execution-ab-associations"],
      env,
    );

    expect(associations.exitCode, associations.output).toBe(0);
    await cli("verify", phaseArgs(generation, snapshot.manifestRoot), env);
    await cli(
      "finalize-proof",
      phaseArgs(generation, snapshot.manifestRoot),
      env,
    );
    await assertPreserved({
      pool: restoredPool,
      running: restored,
      generation,
      manifestDirectory: snapshot.manifestRoot,
    });
    const finalize = await migrator(["--stage", "execution-ab-finalize"], env);

    expect(finalize.exitCode, finalize.output).toBe(0);
    await assertCanonical(restoredPool);
    expect(await listSources(snapshot.legacyRoot)).toEqual(
      await listSources(legacyRoot),
    );
  }, 600_000);

  it("installs fresh: the whole chain applies with no history and the importer refuses", async () => {
    const fresh = await startBarePostgresTestDb({
      databaseName: "legacy_cutover_at11_fresh_test",
    });

    extraDatabases.push(fresh);
    const env = { DB_URL: fresh.databaseUrl };
    const applied = await migrator([], env);

    expect(applied.exitCode, applied.output).toBe(0);
    const tables = await fresh.pool.query<{ name: string }>(
      `select table_name as name from information_schema.tables
       where table_name in ('execution_data_plane_imports', 'artifact_projection_cursors')`,
    );

    expect(tables.rows.map((row) => row.name)).toEqual([
      "execution_data_plane_imports",
    ]);
    expect(await cliExpectingRefusal("rows", manifestArgs(), env)).toContain(
      "already_canonical",
    );
  }, 300_000);
});
