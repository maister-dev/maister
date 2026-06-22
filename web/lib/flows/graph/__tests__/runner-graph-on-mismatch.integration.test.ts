import type { NodeAttempt, Run } from "@/lib/db/schema";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { runFlow } from "@/lib/flows/runner";

// M38 (ADR-103) on_mismatch — engine-initiated rework on a structured-output
// validation failure. Reuses the M26 fixture schema
// (_fixtures/m26-output-flow/schemas/result.json: { verdict: string (required), score? }):
// emitting JSON without `verdict` fails validation.

const schema = fullSchema as unknown as Record<string, any>;
const FIXTURE_PATH = resolve(__dirname, "_fixtures/m26-output-flow");
const SCHEMA = "./schemas/result.json";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();
}, 180_000);

afterAll(async () => {
  if (originalDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = originalDbUrl;
  await pool?.end();
  await container?.stop();
});

type Seeded = { runId: string; slug: string; runtimeRoot: string };

async function seedGraphRun(manifest: unknown): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "m38",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: FIXTURE_PATH,
    manifest,
    schemaVersion: 1,
  });
  await db.insert(schema.flowRevisions).values({
    id: flowRevisionId,
    flowRefId: "m38",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: randomUUID().replace(/-/g, ""),
    manifestDigest: "test-digest",
    manifest,
    schemaVersion: 1,
    installedPath: FIXTURE_PATH,
    setupStatus: "not_required",
    packageStatus: "Installed",
    execTrust: "trusted",
  });
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    flowRevisionId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: "Running",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { runId, slug, runtimeRoot };
}

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

async function getAttempts(runId: string): Promise<NodeAttempt[]> {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as NodeAttempt[];
}

describe("runGraph — M38 on_mismatch rework", () => {
  it("on_mismatch: retry re-runs the same node with the validation error in commentsVar", async () => {
    // Attempt 1 emits invalid output (no `verdict`); attempt 2 (marker present)
    // emits valid output. The command echoes the injected commentsVar so we can
    // confirm the validation error reached the retried attempt's prompt.
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "extract",
          type: "cli",
          action: {
            command:
              `echo "notes:{{ fix_notes }}"; ` +
              `if [ -f once.marker ]; then echo '{"verdict":"ok","score":1}' > "$MAISTER_OUTPUT_FILE"; ` +
              `else echo '{"score":1}' > "$MAISTER_OUTPUT_FILE"; touch once.marker; fi`,
          },
          output: { result: { schema: SCHEMA, on_mismatch: "retry" } },
          rework: {
            allowedTargets: ["extract"],
            workspacePolicies: ["keep"],
            maxLoops: 3,
            commentsVar: "fix_notes",
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = (await getAttempts(seeded.runId))
      .filter((a) => a.nodeId === "extract")
      .sort((a, b) => a.attempt - b.attempt);

    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe("Reworked");
    expect(attempts[0].decision).toBe("retry");
    expect(attempts[1].status).toBe("Succeeded");
    // The retried attempt rendered the injected validation error.
    expect(attempts[1].stdout ?? "").toContain("notes:");
    expect(attempts[1].stdout ?? "").toMatch(/required|schema|absent/i);
  }, 60_000);

  it("on_mismatch: <outcome> redirects to a rework target with the error injected", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "extract",
          type: "cli",
          action: {
            command: `echo '{"score":1}' > "$MAISTER_OUTPUT_FILE"`, // always missing verdict
          },
          output: { result: { schema: SCHEMA, on_mismatch: "repair" } },
          rework: {
            allowedTargets: ["fixer"],
            workspacePolicies: ["keep"],
            maxLoops: 1,
            commentsVar: "notes",
          },
          transitions: { repair: "fixer" },
        },
        {
          id: "fixer",
          type: "cli",
          action: { command: `echo "fixing:{{ notes }}"` },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = await getAttempts(seeded.runId);

    expect(attempts.find((a) => a.nodeId === "extract")?.status).toBe(
      "Reworked",
    );
    const fixer = attempts.find((a) => a.nodeId === "fixer");

    expect(fixer?.status).toBe("Succeeded");
    expect(fixer?.stdout ?? "").toMatch(/fixing:.*(required|schema|absent)/i);
  }, 60_000);

  it("a node WITHOUT on_mismatch still CONFIG-fails on malformed output (M26 regression)", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "extract",
          type: "cli",
          action: {
            command: `echo '{"score":1}' > "$MAISTER_OUTPUT_FILE"`,
          },
          output: { result: { schema: SCHEMA } }, // no on_mismatch
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");
    expect(
      (await getAttempts(seeded.runId)).find((a) => a.nodeId === "extract")
        ?.status,
    ).toBe("Failed");
  }, 60_000);

  it("an always-malformed on_mismatch: retry node halts at maxLoops + 1 attempts (Failed)", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "extract",
          type: "cli",
          action: {
            command: `echo '{"score":1}' > "$MAISTER_OUTPUT_FILE"`, // never valid
          },
          output: { result: { schema: SCHEMA, on_mismatch: "retry" } },
          rework: {
            allowedTargets: ["extract"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            commentsVar: "fix_notes",
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");

    // initial visit + maxLoops(2) reworks = 3 attempts, then the loop-top
    // backstop refuses the 4th entry with CONFIG.
    const attempts = (await getAttempts(seeded.runId)).filter(
      (a) => a.nodeId === "extract",
    );

    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.status === "Reworked")).toBe(true);
  }, 60_000);
});
