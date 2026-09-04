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
    "0134_lovely_tarot",
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
  const result = await execFileAsync(tsxPath, [scriptPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_URL: testDatabase.databaseUrl,
      MAISTER_LEGACY_RUNTIME_ROOT: runtimeRoot,
    },
  });

  return result.stdout;
}

describe("execution-data-plane:import-legacy", () => {
  it("preserves ordered events and costs exactly once without prematurely changing the run mode", async () => {
    const first = await runImporter();

    expect(first).toContain('"alreadyComplete":false');
    const imported = await testDatabase.pool.query(
      `select event_type, run_sequence::text as sequence, payload, occurred_at
       from execution_events
       where run_id = $1
       order by run_sequence`,
      [runId],
    );
    expect(imported.rows).toEqual([
      expect.objectContaining({
        event_type: "session.line",
        sequence: "0",
        payload: expect.objectContaining({ line: "hello from preserved history" }),
      }),
      expect.objectContaining({
        event_type: "usage.recorded",
        sequence: "1",
        payload: expect.objectContaining({ inputTokens: 12, outputTokens: 34 }),
      }),
    ]);
    const lanes = await testDatabase.pool.query(
      `select source_kind, state from execution_data_plane_imports
       where run_id = $1 order by source_kind`,
      [runId],
    );
    expect(lanes.rows).toHaveLength(5);
    expect(lanes.rows.every((row) => row.state === "complete")).toBe(true);
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
  });
});
