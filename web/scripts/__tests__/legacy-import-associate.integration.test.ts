// S4.4 / D9 step 6: after the bytes are verifiably on the host, the manager
// repoints the rows that owned them — artifact file locators and scratch
// attachment values — inside bounded transactions, against the EXACT row
// fingerprint the inventory froze. A row that changed under the operator is
// refused, never overwritten, and every other column survives untouched.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    { databaseName: "legacy_data_plane_associate_test" },
    "0133_rich_blob",
  );
  runtimeRoot = await mkdtemp(join(tmpdir(), "legacy-assoc-root-"));
  projectId = randomUUID();
  slug = `as-${projectId.replace(/-/g, "").slice(0, 8)}`;

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
      `Associate ${slug}`,
      `/tmp/${slug}`,
      `A${slug.slice(-5).toUpperCase()}`,
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
  manifestRoot = await mkdtemp(join(tmpdir(), "legacy-assoc-manifest-"));
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
       'text/plain', 7, repeat('b', 64), $3)`,
    [id, input.runId, input.relativePath],
  );

  return id;
}

async function cli(
  command: "inventory" | "copy" | "associate",
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
  ).catch((error: Error & { stdout?: string; stderr?: string }) => {
    // Surface the CLI's own refusal line: a bare "Command failed" hides the
    // reason the phase actually reported.
    error.message = `${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    throw error;
  });

  return `${result.stdout}\n${result.stderr}`;
}

async function cliExpectingRefusal(
  command: "inventory" | "copy" | "associate",
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

function importId(): string {
  return `as-${randomUUID().slice(0, 8)}`;
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

async function artifactRow(id: string): Promise<Record<string, unknown>> {
  const rows = await testDatabase.pool.query<Record<string, unknown>>(
    "select * from artifact_instances where id = $1",
    [id],
  );

  return rows.rows[0];
}

async function attachmentRow(id: string): Promise<Record<string, unknown>> {
  const rows = await testDatabase.pool.query<Record<string, unknown>>(
    "select * from scratch_attachments where id = $1",
    [id],
  );

  return rows.rows[0];
}

describe("execution-data-plane:import-legacy associate", () => {
  it("repoints every owning row at the object its bytes became", async () => {
    const { runId, runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");
    await mkdir(join(runDirectory, "uploads", "launch"), { recursive: true });
    await writeFile(
      join(runDirectory, "uploads", "launch", "spec.txt"),
      "a spec\n",
      "utf8",
    );

    const artifactId = await seedArtifact({ runId, relativePath: "plan.log" });
    const attachmentId = await seedAttachment({
      runId,
      relativePath: "uploads/launch/spec.txt",
    });
    const id = importId();

    await cli("inventory", ["--import-id", id, "--manifest-dir", manifestRoot]);

    const supervisor = await startSupervisorFor(id);
    const generation = await enabledGeneration(supervisor);

    await cli("copy", phaseArgs(id, generation));

    const output = await cli("associate", phaseArgs(id, generation));

    expect(output).toContain("legacy_execution_data_associate_finished");

    const artifact = await artifactRow(artifactId);
    const locator = artifact.locator as { kind: string; objectId?: string };

    expect(locator.kind).toBe("execution-object");
    expect(locator.objectId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // Everything the row meant survives the repoint: what it is, who produced
    // it, whether it is current and what it gates.
    expect(artifact.kind).toBe("log");
    expect(artifact.producer).toBe("runner");
    expect(artifact.validity).toBe("current");
    expect(artifact.node_id).toBe("build");
    expect(artifact.attempt).toBe(1);
    expect(artifact.required_for).toEqual(["review"]);
    expect(artifact.visibility).toBe("shared");

    const attachment = await attachmentRow(attachmentId);

    // A canonical uploaded file carries the opaque object id in `value` and no
    // storage path at all.
    expect(attachment.storage_path).toBeNull();
    expect(attachment.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(attachment.message_id).toBeNull();
    expect(attachment.kind).toBe("uploaded_file");
    expect(attachment.file_name).toBe("spec.txt");
    expect(attachment.mime_type).toBe("text/plain");
    expect(attachment.byte_size).toBe(7);
  }, 180_000);

  it("re-runs over its own output without changing a row", async () => {
    const { runId, runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");

    const artifactId = await seedArtifact({ runId, relativePath: "plan.log" });
    const id = importId();

    await cli("inventory", ["--import-id", id, "--manifest-dir", manifestRoot]);

    const supervisor = await startSupervisorFor(id);
    const generation = await enabledGeneration(supervisor);

    await cli("copy", phaseArgs(id, generation));
    await cli("associate", phaseArgs(id, generation));

    const first = await artifactRow(artifactId);
    const output = await cli("associate", phaseArgs(id, generation));

    expect(await artifactRow(artifactId)).toEqual(first);
    expect(output).toContain(`"repointed":0`);
    expect(output).toContain(`"alreadyAssociated":1`);
  }, 180_000);

  it("refuses a row that changed under the operator and leaves it alone", async () => {
    const { runId, runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");

    const artifactId = await seedArtifact({ runId, relativePath: "plan.log" });
    const id = importId();

    await cli("inventory", ["--import-id", id, "--manifest-dir", manifestRoot]);

    const supervisor = await startSupervisorFor(id);
    const generation = await enabledGeneration(supervisor);

    await cli("copy", phaseArgs(id, generation));
    await testDatabase.pool.query(
      "update artifact_instances set validity = 'stale' where id = $1",
      [artifactId],
    );

    const output = await cliExpectingRefusal(
      "associate",
      phaseArgs(id, generation),
    );

    expect(output).toContain("association_row_changed");

    const artifact = await artifactRow(artifactId);

    expect((artifact.locator as { kind: string }).kind).toBe("file");
    expect(artifact.validity).toBe("stale");
  }, 180_000);

  // `value` is the column the phase overwrites, so leaving it outside the
  // frozen fingerprint would let a concurrent edit be silently destroyed.
  it("refuses an attachment whose value changed under the operator", async () => {
    const { runId, runDirectory } = await seedRun();

    await mkdir(join(runDirectory, "uploads", "launch"), { recursive: true });
    await writeFile(
      join(runDirectory, "uploads", "launch", "spec.txt"),
      "a spec\n",
      "utf8",
    );

    const attachmentId = await seedAttachment({
      runId,
      relativePath: "uploads/launch/spec.txt",
    });
    const id = importId();

    await inventoryOnly(id);

    const supervisor = await startSupervisorFor(id);
    const generation = await enabledGeneration(supervisor);

    await cli("copy", phaseArgs(id, generation));
    await testDatabase.pool.query(
      "update scratch_attachments set value = 'edited-by-operator' where id = $1",
      [attachmentId],
    );

    const output = await cliExpectingRefusal(
      "associate",
      phaseArgs(id, generation),
    );

    expect(output).toContain("association_row_changed");

    const attachment = await attachmentRow(attachmentId);

    expect(attachment.value).toBe("edited-by-operator");
    expect(attachment.storage_path).toBe("uploads/launch/spec.txt");
  }, 180_000);

  it("refuses to repoint a row at bytes the host has not sealed", async () => {
    const { runId, runDirectory } = await seedRun();

    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");

    const artifactId = await seedArtifact({ runId, relativePath: "plan.log" });
    const id = importId();

    await cli("inventory", ["--import-id", id, "--manifest-dir", manifestRoot]);

    const supervisor = await startSupervisorFor(id);
    const generation = await enabledGeneration(supervisor);
    // No copy phase: the manifest is registered, but nothing was preserved.
    const output = await cliExpectingRefusal(
      "associate",
      phaseArgs(id, generation),
    );

    expect(output).toContain("association_bytes_unverified");
    expect((await artifactRow(artifactId)).locator).toEqual({
      kind: "file",
      path: "plan.log",
    });
  }, 180_000);
});

// D9 step 7: a legacy scratch mirror is only migratable when ONE assignment can
// be proven to own its host session. 0134 refuses any run whose assignment
// count is not exactly 1, so a real multi-assignment history has to be resolved
// from session and event evidence before that migration can run at all.
// Only one active local host may exist, so every case reuses the same row.
async function seedHost(): Promise<string> {
  const existing = await testDatabase.pool.query<{ id: string }>(
    "select id from execution_hosts limit 1",
  );

  if (existing.rows[0]) return existing.rows[0].id;

  const id = randomUUID();

  await testDatabase.pool.query(
    `insert into execution_hosts
      (id, host_key, kind, display_name, transport, readiness)
     values ($1, $2, 'local_direct', 'test host',
       '{"kind":"local_direct"}'::jsonb, 'ready')`,
    [id, `eh_${id.replace(/-/g, "")}`],
  );

  return id;
}

async function seedAssignment(input: {
  runId: string;
  hostId: string;
  epoch: number;
  state: "active" | "superseded";
}): Promise<string> {
  const id = randomUUID();

  await testDatabase.pool.query(
    // A superseded assignment must carry `ended_at`; an active one must not.
    `insert into execution_assignments
      (id, run_id, execution_host_id, epoch, state, placement_reason, ended_at)
     values ($1, $2, $3, $4, $5, 'launch',
       case when $5::text = 'active' then null else now() end)`,
    [id, input.runId, input.hostId, input.epoch, input.state],
  );

  return id;
}

async function seedScratchMirror(input: {
  runId: string;
  hostSessionId: string;
}): Promise<void> {
  await testDatabase.pool.query(
    `insert into scratch_runs
      (run_id, project_id, base_branch, base_commit, created_by_user_id,
       initial_prompt, supervisor_session_id)
     values ($1, $2, 'main', 'deadbeef',
       (select id from users limit 1), 'seeded', $3)
     on conflict (run_id) do update set supervisor_session_id = excluded.supervisor_session_id`,
    [input.runId, projectId, input.hostSessionId],
  );
}

async function seedIncarnation(input: {
  runId: string;
  hostId: string;
  assignmentId: string;
  hostSessionId: string;
}): Promise<void> {
  const sessionId = `rs-${randomUUID()}`;

  await testDatabase.pool.query(
    `insert into run_sessions (id, run_id, session_name)
     values ($1, $2, 'default') on conflict do nothing`,
    [sessionId, input.runId],
  );
  await testDatabase.pool.query(
    `insert into run_session_incarnations
      (id, run_session_id, run_id, execution_assignment_id, assignment_epoch,
       execution_host_id, host_session_id, state, origin)
     values ($1, $2, $3, $4, 1, $5, $6, 'exited', 'native')`,
    [
      randomUUID(),
      sessionId,
      input.runId,
      input.assignmentId,
      input.hostId,
      input.hostSessionId,
    ],
  );
}

async function mirrorOf(runId: string): Promise<string | null> {
  const rows = await testDatabase.pool.query<{
    supervisor_session_id: string | null;
  }>("select supervisor_session_id from scratch_runs where run_id = $1", [
    runId,
  ]);

  return rows.rows[0]?.supervisor_session_id ?? null;
}

async function assignmentCount(runId: string): Promise<number> {
  const rows = await testDatabase.pool.query<{ count: string }>(
    "select count(*)::text as count from execution_assignments where run_id = $1",
    [runId],
  );

  return Number(rows.rows[0].count);
}

async function inventoryOnly(id: string): Promise<void> {
  await cli("inventory", ["--import-id", id, "--manifest-dir", manifestRoot]);
}

describe("scratch session mirror preservation", () => {
  it("binds a multi-assignment mirror to the one assignment that owned it", async () => {
    const { runId } = await seedRun();
    const hostId = await seedHost();
    const hostSessionId = `hs-${randomUUID()}`;
    const owning = await seedAssignment({
      runId,
      hostId,
      epoch: 1,
      state: "superseded",
    });

    await seedAssignment({ runId, hostId, epoch: 2, state: "active" });
    await seedScratchMirror({ runId, hostSessionId });
    await seedIncarnation({
      runId,
      hostId,
      assignmentId: owning,
      hostSessionId,
    });

    const id = importId();

    await inventoryOnly(id);

    const supervisor = await startSupervisorFor(id);
    const generation = await enabledGeneration(supervisor);

    await cli("copy", phaseArgs(id, generation));

    const output = await cli("associate", phaseArgs(id, generation));

    expect(output).toContain("legacy_execution_data_mirror_preserved");
    // The mirror is cleared only after the canonical rows prove it, so the
    // unmodified 0134 no longer sees an ambiguous multi-assignment run.
    expect(await mirrorOf(runId)).toBeNull();
    // Nothing was deleted to make the proof fit.
    expect(await assignmentCount(runId)).toBe(2);

    const session = await testDatabase.pool.query<{
      host_session_id: string | null;
      execution_assignment_id: string | null;
    }>(
      `select host_session_id, execution_assignment_id from run_sessions
       where run_id = $1 and session_name = 'default'`,
      [runId],
    );

    expect(session.rows[0].host_session_id).toBe(hostSessionId);
    expect(session.rows[0].execution_assignment_id).toBe(owning);
  }, 180_000);

  // `(execution_host_id, host_session_id)` is unique, so a host session can
  // never name two assignments. The real ambiguity is the opposite: several
  // assignments and NO surviving evidence of which one held the session.
  it("refuses an ambiguous history rather than guessing an assignment", async () => {
    const { runId } = await seedRun();
    const hostId = await seedHost();
    const hostSessionId = `hs-${randomUUID()}`;

    await seedAssignment({ runId, hostId, epoch: 1, state: "superseded" });
    await seedAssignment({ runId, hostId, epoch: 2, state: "active" });
    await seedScratchMirror({ runId, hostSessionId });

    const id = importId();

    await inventoryOnly(id);

    const supervisor = await startSupervisorFor(id);
    const generation = await enabledGeneration(supervisor);

    await cli("copy", phaseArgs(id, generation));

    const output = await cliExpectingRefusal(
      "associate",
      phaseArgs(id, generation),
    );

    expect(output).toContain("scratch_mirror_ambiguous");
    expect(await mirrorOf(runId)).toBe(hostSessionId);
    expect(await assignmentCount(runId)).toBe(2);
  }, 180_000);

  it("leaves a single-assignment mirror for the unmodified 0134 to preserve", async () => {
    const { runId } = await seedRun();
    const hostId = await seedHost();
    const hostSessionId = `hs-${randomUUID()}`;

    await seedAssignment({ runId, hostId, epoch: 1, state: "active" });
    await seedScratchMirror({ runId, hostSessionId });

    const id = importId();

    await inventoryOnly(id);

    const supervisor = await startSupervisorFor(id);
    const generation = await enabledGeneration(supervisor);

    await cli("copy", phaseArgs(id, generation));
    await cli("associate", phaseArgs(id, generation));

    expect(await mirrorOf(runId)).toBe(hostSessionId);
  }, 180_000);
});

// The acceptance that matters: the UNMODIFIED 0134 refuses a multi-assignment
// mirror outright. Its own SQL is executed here rather than the migrator CLI, so
// the only thing that differs between the two runs is the evidence-bound
// preservation above — not a journal, a stage flag or a filtered root.
async function applyMigration0134(): Promise<{ ok: boolean; message: string }> {
  const sql = await readFile(
    resolve(process.cwd(), "lib/db/migrations/0134_lovely_tarot.sql"),
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

describe("guarded 0134 after preservation", () => {
  it("unblocks the unmodified association migration it used to refuse", async () => {
    const { runId } = await seedRun();
    const hostId = await seedHost();
    const hostSessionId = `hs-${randomUUID()}`;
    const owning = await seedAssignment({
      runId,
      hostId,
      epoch: 1,
      state: "superseded",
    });

    await seedAssignment({ runId, hostId, epoch: 2, state: "active" });
    await seedScratchMirror({ runId, hostSessionId });
    await seedIncarnation({
      runId,
      hostId,
      assignmentId: owning,
      hostSessionId,
    });

    const before = await applyMigration0134();

    expect(before.ok).toBe(false);
    expect(before.message).toContain("assignment ownership is ambiguous");

    const id = importId();

    await inventoryOnly(id);

    const supervisor = await startSupervisorFor(id);
    const generation = await enabledGeneration(supervisor);

    await cli("copy", phaseArgs(id, generation));
    await cli("associate", phaseArgs(id, generation));

    const after = await applyMigration0134();

    expect(after.ok, after.message).toBe(true);

    // The preserved association survives the migration that dropped the mirror.
    const session = await testDatabase.pool.query<{
      host_session_id: string | null;
    }>(
      `select host_session_id from run_sessions
       where run_id = $1 and session_name = 'default'`,
      [runId],
    );

    expect(session.rows[0].host_session_id).toBe(hostSessionId);
    expect(await assignmentCount(runId)).toBe(2);

    // Re-running after 0134 is an ordinary operator act (re-verify, resume a
    // later phase). The mirror column is gone by then, so the phase must skip
    // that half rather than crash on a column that no longer exists.
    const again = await cli("associate", phaseArgs(id, generation));

    expect(again).toContain(`"mirrorsPreserved":0`);
  }, 240_000);
});
