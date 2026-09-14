// S4.6 / D9: the row reconstruction is its own phase — `rows` — and it works
// from the frozen manifest, never from an allowlist of file names. It refuses a
// run whose directory no longer matches what the inventory froze, imports the
// canonical event rows for every inventoried run in one transaction each, and
// completes NOTHING: the events lane keeps its `pending` inventory record and
// only its versioned cursor advances to `phase=rows`. `finalize-proof` stays the
// only writer of a `complete` lane record.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(process.cwd(), "scripts/import-legacy-execution-data-plane.ts");
const tsxPath = resolve(process.cwd(), "node_modules/.bin/tsx");

let testDatabase: StartedPostgresTestDb;
let runtimeRoot: string;
let manifestRoot: string;
let projectId: string;
let runId: string;
let slug: string;

const EVENT_LINE = `${JSON.stringify({
  type: "session.line",
  sessionId: "legacy-session",
  monotonicId: 1,
  line: "hello from preserved history",
  authorization: "Bearer should-not-survive",
  cwd: "/private/host/runtime",
  ts: "2026-09-04T00:00:00.000Z",
})}\n`;
const COST_LINE = `${JSON.stringify({
  ts: "2026-09-04T00:00:01.000Z",
  sessionId: "legacy-session",
  input_tokens: 12,
  output_tokens: 34,
  model: "test-model",
})}\n`;
const STEP_LOG = "host transcript bytes\n";

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDbUpTo(
    { databaseName: "legacy_data_plane_import_cli_test" },
    "0133_rich_blob",
  );
  runtimeRoot = await mkdtemp(join(tmpdir(), "legacy-data-plane-import-"));
  manifestRoot = await mkdtemp(join(tmpdir(), "legacy-data-plane-manifest-"));
  projectId = randomUUID();
  runId = randomUUID();
  slug = `legacy-${projectId.replace(/-/g, "").slice(0, 8)}`;

  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [projectId, slug, `Legacy ${slug}`, `/tmp/${slug}`, `L${slug.slice(-5).toUpperCase()}`],
  );
  await seedRun(runId, { events: EVENT_LINE, cost: COST_LINE, stepLog: STEP_LOG });
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
  await rm(runtimeRoot, { recursive: true, force: true });
  await rm(manifestRoot, { recursive: true, force: true });
});

function runDirectory(id: string): string {
  return join(runtimeRoot, ".maister", slug, "runs", id);
}

async function seedRun(
  id: string,
  files: { events: string; cost: string; stepLog?: string },
): Promise<void> {
  await testDatabase.pool.query(
    `insert into runs
      (id, project_id, run_kind, status, flow_version, flow_revision, execution_data_plane_mode)
     values ($1, $2, 'scratch', 'Done', 'scratch', 'manual', 'legacy_file_v1')`,
    [id, projectId],
  );
  const directory = runDirectory(id);

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "run.events.jsonl"), files.events, "utf8");
  await writeFile(join(directory, "cost.jsonl"), files.cost, "utf8");
  // The file the pre-S4.6 allowlist refused: an ordinary step log.
  if (files.stepLog !== undefined)
    await writeFile(join(directory, "plan.log"), files.stepLog, "utf8");
}

async function runImporter(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<string> {
  const result = await execFileAsync(
    tsxPath,
    ["--import", "./scripts/_register-shim.mjs", scriptPath, ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_URL: testDatabase.databaseUrl,
        MAISTER_LEGACY_RUNTIME_ROOT: runtimeRoot,
        ...env,
      },
    },
  );

  return result.stdout;
}

async function runImporterExpectingRefusal(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<string> {
  try {
    const stdout = await runImporter(args, env);

    throw new Error(`importer succeeded unexpectedly: ${stdout}`);
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };

    return `${failure.stdout ?? ""}\n${failure.stderr ?? failure.message}`;
  }
}

// One frozen source id for the whole file: item identities and lane digests are
// derived from it, so a second id over the same runs would be a different freeze
// and the inventory would refuse it as drift. Re-inventory under the same id is
// idempotent and is how a newly seeded run joins the manifest.
const IMPORT_ID = "s46-rows";

function manifestArgs(): string[] {
  return ["--import-id", IMPORT_ID, "--manifest-dir", manifestRoot];
}

async function inventory(): Promise<string> {
  return runImporter(["inventory", ...manifestArgs()]);
}

async function rows(): Promise<string> {
  return runImporter(["rows", ...manifestArgs()]);
}

function laneDigest(run: string, lane: string): string {
  const db = new DatabaseSync(join(manifestRoot, `import-${IMPORT_ID}.sqlite`), {
    readOnly: true,
  });

  try {
    const row = db
      .prepare(
        `SELECT manifest_digest AS digest FROM import_lanes
         WHERE import_id = ? AND run_id = ? AND lane = ?`,
      )
      .get(IMPORT_ID, run, lane) as { digest: string } | undefined;

    if (!row) throw new Error(`manifest has no ${lane} lane for ${run}`);

    return row.digest;
  } finally {
    db.close();
  }
}

type LaneRow = {
  source_kind: string;
  state: string;
  source_fingerprint: string | null;
  last_source_position: string | null;
  imported_count: number;
  attempts: number;
  last_error: { reason: string; sourcePosition: string | null } | null;
};

async function laneRows(run: string): Promise<LaneRow[]> {
  const result = await testDatabase.pool.query<LaneRow>(
    `select source_kind, state, source_fingerprint, last_source_position,
        imported_count, attempts, last_error
     from execution_data_plane_imports
     where run_id = $1 order by source_kind`,
    [run],
  );

  return result.rows;
}

async function eventCount(run: string): Promise<number> {
  const result = await testDatabase.pool.query<{ count: number }>(
    `select count(*)::int as count from execution_events
     where run_id = $1 and source = 'legacy_import'`,
    [run],
  );

  return result.rows[0].count;
}

describe("execution-data-plane:import-legacy rows", () => {
  it("imports the rows of an inventoried run whose directory holds a step log, and completes nothing", async () => {
    await inventory();
    const first = await rows();

    expect(first).toContain('"alreadyComplete":false');
    const imported = await testDatabase.pool.query(
      `select id, source_key, event_type, run_sequence::text as sequence,
          payload, payload_sha256, payload_bytes, occurred_at
       from execution_events
       where run_id = $1
       order by run_sequence`,
      [runId],
    );
    expect(imported.rows).toEqual([
      expect.objectContaining({
        event_type: "session.line",
        sequence: "0",
        payload: expect.objectContaining({
          line: "hello from preserved history",
          cwd: "[REDACTED_HOST_PATH]",
          legacySourcePosition: "line:1:byte:0",
        }),
      }),
      expect.objectContaining({
        event_type: "usage.recorded",
        sequence: "1",
        payload: expect.objectContaining({ inputTokens: 12, outputTokens: 34 }),
      }),
    ]);
    expect(imported.rows[0].payload).not.toHaveProperty("authorization");
    expect(imported.rows.every((row) => /^[0-9a-f-]{36}$/.test(row.id))).toBe(true);
    expect(imported.rows.every((row) => row.payload_sha256)).toBe(true);
    expect(imported.rows.every((row) => row.payload_bytes > 0)).toBe(true);

    // The inventory wrote five `pending` lanes; `rows` completes none of them
    // and touches only the events lane's cursor. The fingerprint stays the lane
    // digest the inventory froze, so a re-inventory still recognises it.
    const lanes = await laneRows(runId);
    const eventsDigest = laneDigest(runId, "events");

    expect(lanes.map((lane) => [lane.source_kind, lane.state])).toEqual([
      ["cost", "pending"],
      ["events", "pending"],
      ["runtime_objects", "pending"],
      ["scratch_session", "pending"],
      ["transcript", "pending"],
    ]);
    expect(lanes.find((lane) => lane.source_kind === "events")).toEqual(
      expect.objectContaining({
        source_fingerprint: eventsDigest,
        last_source_position: `v1:phase=rows:manifest=${eventsDigest}:items=1:rows=2`,
        imported_count: 2,
        attempts: 2,
        last_error: null,
      }),
    );
    for (const lane of lanes.filter((row) => row.source_kind !== "events")) {
      expect(lane.last_source_position).toMatch(/^v1:phase=inventory:/);
      expect(lane.attempts).toBe(1);
    }
    const mode = await testDatabase.pool.query(
      `select execution_data_plane_mode as mode, next_execution_event_sequence::text as next
       from runs where id = $1`,
      [runId],
    );
    expect(mode.rows).toEqual([{ mode: "legacy_file_v1", next: "2" }]);
    // Sources are read, never written, moved or removed.
    expect(await readFile(join(runDirectory(runId), "plan.log"), "utf8")).toBe(STEP_LOG);

    const second = await rows();

    expect(second).toContain('"alreadyComplete":true');
    expect(await eventCount(runId)).toBe(2);
    expect(
      (await laneRows(runId)).find((lane) => lane.source_kind === "events")?.attempts,
    ).toBe(2);
  }, 120_000);

  it("re-derives its cursor from the rows themselves after a re-inventory reset it", async () => {
    // A later inventory legitimately rewrites every lane `pending` at
    // `phase=inventory`; the rows it cannot see are still there, and `rows` must
    // recognise them by identity rather than import them twice.
    await inventory();
    const events = (await laneRows(runId)).find((lane) => lane.source_kind === "events");

    expect(events?.last_source_position).toMatch(/^v1:phase=inventory:/);

    const output = await rows();
    const digest = laneDigest(runId, "events");

    expect(output).toContain('"alreadyComplete":true');
    expect(await eventCount(runId)).toBe(2);
    expect(
      (await laneRows(runId)).find((lane) => lane.source_kind === "events")
        ?.last_source_position,
    ).toBe(`v1:phase=rows:manifest=${digest}:items=1:rows=2`);
  }, 120_000);

  it("refuses rows in the database that no longer match the frozen source", async () => {
    await inventory();
    await testDatabase.pool.query(
      `delete from execution_events
       where id = (select id from execution_events
                   where run_id = $1 and source = 'legacy_import' limit 1)`,
      [runId],
    );
    const output = await runImporterExpectingRefusal(["rows", ...manifestArgs()]);

    expect(output).toContain("rows_evidence_mismatch");
    expect(await eventCount(runId)).toBe(1);
    expect(
      (await laneRows(runId)).find((lane) => lane.source_kind === "events"),
    ).toEqual(
      expect.objectContaining({
        state: "failed",
        last_error: { reason: "rows_evidence_mismatch", sourcePosition: "rows:1:1" },
      }),
    );

    // With no rows left, the same source imports again from its frozen bytes.
    await testDatabase.pool.query(
      "delete from execution_events where run_id = $1 and source = 'legacy_import'",
      [runId],
    );
    await testDatabase.pool.query(
      "update runs set next_execution_event_sequence = 0 where id = $1",
      [runId],
    );
    expect(await rows()).toContain('"alreadyComplete":false');
    expect(await eventCount(runId)).toBe(2);
    expect(
      (await laneRows(runId)).find((lane) => lane.source_kind === "events")?.state,
    ).toBe("pending");
  }, 120_000);

  it("refuses a run whose directory no longer matches the frozen manifest", async () => {
    const driftedRunId = randomUUID();
    const directory = runDirectory(driftedRunId);

    await seedRun(driftedRunId, { events: EVENT_LINE, cost: COST_LINE, stepLog: STEP_LOG });
    await inventory();

    // A file that appeared after the freeze.
    await writeFile(join(directory, "extra.log"), "appeared after inventory\n", "utf8");
    let output = await runImporterExpectingRefusal(["rows", ...manifestArgs()]);

    expect(output).toContain("source_fingerprint_changed");
    expect(output).toContain('"unresolvedCount":1');
    expect(await eventCount(driftedRunId)).toBe(0);
    expect(
      (await laneRows(driftedRunId)).find((lane) => lane.source_kind === "runtime_objects"),
    ).toEqual(
      expect.objectContaining({
        state: "failed",
        last_error: expect.objectContaining({ reason: "source_fingerprint_changed" }),
      }),
    );
    await rm(join(directory, "extra.log"));

    // Bytes that changed under the same name and size.
    const original = await readFile(join(directory, "run.events.jsonl"), "utf8");

    await writeFile(
      join(directory, "run.events.jsonl"),
      original.replace("hello from", "HELLO FROM"),
      "utf8",
    );
    output = await runImporterExpectingRefusal(["rows", ...manifestArgs()]);
    expect(output).toContain("source_fingerprint_changed");
    expect(await eventCount(driftedRunId)).toBe(0);
    await writeFile(join(directory, "run.events.jsonl"), original, "utf8");

    // A frozen source that is gone.
    await rm(join(directory, "plan.log"));
    output = await runImporterExpectingRefusal(["rows", ...manifestArgs()]);
    expect(output).toContain("required_source_missing");
    expect(
      (await laneRows(driftedRunId)).find((lane) => lane.source_kind === "runtime_objects")
        ?.state,
    ).toBe("missing");
    await writeFile(join(directory, "plan.log"), STEP_LOG, "utf8");

    // Restored to the frozen shape, the same manifest admits the run.
    const restored = await rows();

    expect(restored).toContain(`"runId":"${driftedRunId}"`);
    expect(await eventCount(driftedRunId)).toBe(2);
    expect(
      (await laneRows(driftedRunId)).find((lane) => lane.source_kind === "runtime_objects")
        ?.state,
    ).toBe("missing");
  }, 120_000);

  it("refuses a legacy run the manifest never inventoried", async () => {
    await inventory();
    const lateRunId = randomUUID();

    await seedRun(lateRunId, { events: EVENT_LINE, cost: COST_LINE });
    const output = await runImporterExpectingRefusal(["rows", ...manifestArgs()]);

    expect(output).toContain("proof_lane_missing");
    expect(await eventCount(lateRunId)).toBe(0);
    expect(
      (await laneRows(lateRunId)).find((lane) => lane.source_kind === "events"),
    ).toEqual(
      expect.objectContaining({
        state: "failed",
        last_error: expect.objectContaining({ reason: "proof_lane_missing" }),
      }),
    );
    await testDatabase.pool.query("delete from runs where id = $1", [lateRunId]);
  }, 120_000);

  it("refuses to run out of phase order over a completed lane", async () => {
    await testDatabase.pool.query(
      `update execution_data_plane_imports set state = 'complete', completed_at = now()
       where run_id = $1 and source_kind = 'events'`,
      [runId],
    );
    try {
      const output = await runImporterExpectingRefusal(["rows", ...manifestArgs()]);

      expect(output).toContain("lane_already_complete");
      expect(
        (await laneRows(runId)).find((lane) => lane.source_kind === "events")?.state,
      ).toBe("complete");
    } finally {
      await testDatabase.pool.query(
        `update execution_data_plane_imports set state = 'pending', completed_at = null
         where run_id = $1 and source_kind = 'events'`,
        [runId],
      );
    }
  }, 120_000);

  it("records a malformed source as a failed events lane and counts it unresolved", async () => {
    const malformedRunId = randomUUID();

    await seedRun(malformedRunId, {
      events: '{"type":"session.line","authorization":"must-not-leak"\n',
      cost: "",
    });
    await inventory();
    const output = await runImporterExpectingRefusal(["rows", ...manifestArgs()]);

    expect(output).toContain('"unresolvedCount":1');
    expect(output).not.toContain("must-not-leak");
    expect(
      (await laneRows(malformedRunId)).find((lane) => lane.source_kind === "events"),
    ).toEqual(
      expect.objectContaining({
        state: "failed",
        last_source_position: "line:1:byte:0",
        last_error: { reason: "malformed_json", sourcePosition: "line:1:byte:0" },
      }),
    );
  }, 120_000);

  it("takes the manifest directory from MAISTER_IMPORT_ADMISSION_DIR when the flag is absent", async () => {
    const output = await runImporterExpectingRefusal(["rows", "--import-id", IMPORT_ID], {
      MAISTER_IMPORT_ADMISSION_DIR: manifestRoot,
    });

    // The fixture's malformed run keeps the phase unresolved; what matters here
    // is that the manifest was found through the environment.
    expect(output).toContain('"alreadyComplete":true');
    expect(output).not.toContain("--manifest-dir is required");
  }, 120_000);

  it("refuses an invocation that names no phase", async () => {
    const output = await runImporterExpectingRefusal(["--import-id", IMPORT_ID]);

    expect(output).toContain("expected one of inventory, copy, associate, rows, verify, finalize-proof");
    expect(output).not.toContain('"event":"legacy_execution_data_rows_started"');
  }, 120_000);

  // S4.1: the importer reads its stage from the schema the database carries.
  // These cases construct the two out-of-window stages directly -- dropping the
  // additive lane table is exactly a database the additive stage never reached,
  // and dropping the artifact projection cursors is exactly one 0135 finished.
  it("stamps its lines with the import id, the staged window and the unresolved count", async () => {
    // The fixture above leaves one permanently malformed run, so the operator's
    // bounded unresolved count is a real number rather than a constant zero.
    const output = await runImporterExpectingRefusal(["rows", ...manifestArgs()]);

    expect(output).toContain(`"importId":"${IMPORT_ID}"`);
    expect(output).toContain('"stage":"additive"');
    expect(output).toContain('"unresolvedCount":1');
  }, 120_000);

  it("refuses a database that never ran the additive stage", async () => {
    await testDatabase.pool.query(
      "alter table execution_data_plane_imports rename to execution_data_plane_imports_stashed",
    );

    try {
      const output = await runImporterExpectingRefusal(["rows", ...manifestArgs()]);

      expect(output).toContain("additive_stage_missing");
      expect(output).toContain("execution-ab-additive");
    } finally {
      await testDatabase.pool.query(
        "alter table execution_data_plane_imports_stashed rename to execution_data_plane_imports",
      );
    }
  }, 120_000);

  it("refuses a database that already completed the canonical cut-over", async () => {
    await testDatabase.pool.query(
      "alter table artifact_projection_cursors rename to artifact_projection_cursors_stashed",
    );

    try {
      const output = await runImporterExpectingRefusal(["rows", ...manifestArgs()]);

      expect(output).toContain("already_canonical");
    } finally {
      await testDatabase.pool.query(
        "alter table artifact_projection_cursors_stashed rename to artifact_projection_cursors",
      );
    }
  }, 120_000);
});
