// ADR-167 B4: exercise the actual one-shot CLI over Postgres and a legacy
// runtime fixture. The CLI preserves rows first; migration 0135 performs the
// only mode flip after its five-lane preflight succeeds.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
let runId: string;
let slug: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDbUpTo(
    { databaseName: "legacy_data_plane_import_cli_test" },
    "0133_rich_blob",
  );
  runtimeRoot = await mkdtemp(join(tmpdir(), "legacy-data-plane-import-"));
  const projectId = randomUUID();
  runId = randomUUID();
  slug = `legacy-${projectId.replace(/-/g, "").slice(0, 8)}`;

  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [projectId, slug, `Legacy ${slug}`, `/tmp/${slug}`, `L${slug.slice(-5).toUpperCase()}`],
  );
  await testDatabase.pool.query(
    `insert into runs
      (id, project_id, run_kind, status, flow_version, flow_revision, execution_data_plane_mode)
     values ($1, $2, 'scratch', 'Done', 'scratch', 'manual', 'legacy_file_v1')`,
    [runId, projectId],
  );
  const runDir = join(runtimeRoot, ".maister", slug, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "run.events.jsonl"),
    `${JSON.stringify({
      type: "session.line",
      sessionId: "legacy-session",
      monotonicId: 1,
      line: "hello from preserved history",
      authorization: "Bearer should-not-survive",
      cwd: "/private/host/runtime",
      ts: "2026-09-04T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(runDir, "cost.jsonl"),
    `${JSON.stringify({
      ts: "2026-09-04T00:00:01.000Z",
      sessionId: "legacy-session",
      input_tokens: 12,
      output_tokens: 34,
      model: "test-model",
    })}\n`,
    "utf8",
  );
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
  await rm(runtimeRoot, { recursive: true, force: true });
});

async function runImporter(): Promise<string> {
  const result = await execFileAsync(
    tsxPath,
    ["--import", "./scripts/_register-shim.mjs", scriptPath],
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

describe("execution-data-plane:import-legacy", () => {
  it("preserves ordered events and costs exactly once without prematurely changing the run mode", async () => {
    const first = await runImporter();

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
    const lanes = await testDatabase.pool.query(
      `select source_kind, state, source_fingerprint, last_source_position,
          attempts, last_error
       from execution_data_plane_imports
       where run_id = $1 order by source_kind`,
      [runId],
    );
    expect(lanes.rows).toHaveLength(4);
    expect(lanes.rows.filter((row) => row.state === "complete")).toHaveLength(4);
    expect(lanes.rows.find((row) => row.source_kind === "scratch_session")).toBeUndefined();
    expect(
      lanes.rows
        .filter((row) => row.state === "complete")
        .every(
          (row) =>
            row.source_fingerprint &&
            row.last_source_position &&
            row.attempts > 0 &&
            row.last_error === null,
        ),
    ).toBe(true);
    const mode = await testDatabase.pool.query(
      `select execution_data_plane_mode as mode, next_execution_event_sequence::text as next
       from runs where id = $1`,
      [runId],
    );
    expect(mode.rows).toEqual([{ mode: "legacy_file_v1", next: "2" }]);

    const second = await runImporter();

    expect(second).toContain('"alreadyComplete":true');
    const count = await testDatabase.pool.query(
      `select count(*)::int as count from execution_events where run_id = $1`,
      [runId],
    );
    expect(count.rows).toEqual([{ count: 2 }]);

    const unpreservedRunId = randomUUID();
    await testDatabase.pool.query(
      `insert into runs
        (id, project_id, run_kind, status, flow_version, flow_revision, execution_data_plane_mode)
       select $1, project_id, 'scratch', 'Done', 'scratch', 'manual', 'legacy_file_v1'
       from runs where id = $2`,
      [unpreservedRunId, runId],
    );
    const unpreservedDir = join(
      runtimeRoot,
      ".maister",
      slug,
      "runs",
      unpreservedRunId,
    );
    await mkdir(unpreservedDir, { recursive: true });
    await writeFile(
      join(unpreservedDir, "run.events.jsonl"),
      `${JSON.stringify({
        type: "session.exited",
        sessionId: "legacy-unpreserved",
        monotonicId: 1,
        exitCode: 0,
        ts: "2026-09-04T00:00:02.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(join(unpreservedDir, "cost.jsonl"), "", "utf8");
    const unpreservedLog = join(unpreservedDir, "plan.log");
    await writeFile(unpreservedLog, "host transcript bytes", "utf8");

    await expect(runImporter()).rejects.toThrow();
    const objectFailure = await testDatabase.pool.query(
      `select state, last_source_position, last_error
       from execution_data_plane_imports
       where run_id = $1 and source_kind = 'runtime_objects'`,
      [unpreservedRunId],
    );
    expect(objectFailure.rows).toEqual([
      {
        state: "failed",
        last_source_position: "entries:1",
        last_error: {
          reason: "runtime_object_unpreserved",
          sourcePosition: "entries:1",
        },
      },
    ]);
    await rm(unpreservedLog);
    await expect(runImporter()).resolves.toContain('"alreadyComplete":false');

    const malformedRunId = randomUUID();
    await testDatabase.pool.query(
      `insert into runs
        (id, project_id, run_kind, status, flow_version, flow_revision, execution_data_plane_mode)
       select $1, project_id, 'scratch', 'Done', 'scratch', 'manual', 'legacy_file_v1'
       from runs where id = $2`,
      [malformedRunId, runId],
    );
    const malformedDir = join(runtimeRoot, ".maister", slug, "runs", malformedRunId);
    await mkdir(malformedDir, { recursive: true });
    await writeFile(
      join(malformedDir, "run.events.jsonl"),
      '{"type":"session.line","authorization":"must-not-leak"\n',
      "utf8",
    );
    await writeFile(join(malformedDir, "cost.jsonl"), "", "utf8");
    await expect(runImporter()).rejects.toThrow();
    const failed = await testDatabase.pool.query(
      `select state, last_source_position, last_error
       from execution_data_plane_imports
       where run_id = $1 and source_kind = 'events'`,
      [malformedRunId],
    );
    expect(failed.rows).toEqual([
      {
        state: "failed",
        last_source_position: "line:1:byte:0",
        last_error: {
          reason: "malformed_json",
          sourcePosition: "line:1:byte:0",
        },
      },
    ]);
  });
});
