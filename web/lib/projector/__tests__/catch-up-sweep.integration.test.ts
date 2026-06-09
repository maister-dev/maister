// T5.2 (RED): failing integration tests for the projector startup catch-up
// sweep.
//
// Contract under test (module not yet implemented — these MUST fail RED on the
// missing import):
//   web/lib/projector/catch-up-sweep.ts exports
//     runProjectorCatchUpSweep(opts?: { db?: Db; limit?: number })
//       : Promise<{ candidatesFound: number; projected: number }>
//
// It selects runs whose status is IN-FLIGHT
//   ["Running","NeedsInput","NeedsInputIdle","HumanWorking","Review"]
// (terminal Pending/Crashed/Done/Abandoned/Failed are NOT swept), bounded by
// `limit` (default constant), and calls projectRunEvents(runId,{db}) for each.
// Projection failures are caught/logged, never thrown. Idempotent via the
// deterministic-PK upsert inside projectRunEvents.

import type { ArtifactInstance } from "@/lib/db/schema";

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { runProjectorCatchUpSweep } from "@/lib/projector/catch-up-sweep";

// FIXME(any): dual drizzle-orm peer-dep variants (matches the store/ledger idiom).
const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let runtimeRoot: string;

const ORIGINAL_RUNTIME_ROOT = process.env.MAISTER_RUNTIME_ROOT;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  runtimeRoot = await mkdtemp(join(tmpdir(), "rt-sweep-"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  // Single shared runtime root for the whole file; each run lives under its
  // own slug subtree so paths never collide across runs or tests.
  process.env.MAISTER_RUNTIME_ROOT = runtimeRoot;
});

afterEach(() => {
  if (ORIGINAL_RUNTIME_ROOT === undefined) {
    delete process.env.MAISTER_RUNTIME_ROOT;
  } else {
    process.env.MAISTER_RUNTIME_ROOT = ORIGINAL_RUNTIME_ROOT;
  }
});

// One realistic supervisor tool_call line (mirrors supervisor/src/types.ts).
function toolCallLine(monotonicId: number, sessionId: string): string {
  return JSON.stringify({
    type: "session.update",
    sessionId,
    monotonicId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: `call-${monotonicId}`,
      title: "Run command",
      kind: "execute",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ran ok" } }],
      locations: [],
    },
  });
}

type SeededRun = {
  runId: string;
  slug: string;
  sessionId: string;
};

// Seed a project + run + one node_attempt, optionally writing a
// run.events.jsonl with one tool_call line. Each run gets its own slug.
async function seedRun(opts: {
  status: string;
  writeEvents: boolean;
}): Promise<SeededRun> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const sessionId = `acp-session-${randomUUID()}`;

  await db.insert(schema.projects).values({
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
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest: { schemaVersion: 1, name: "g" },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
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
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: opts.status,
  });
  await db.insert(schema.nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Running",
    acpSessionId: sessionId,
  });

  if (opts.writeEvents) {
    const dir = join(runtimeRoot, ".maister", slug, "runs", runId);

    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "run.events.jsonl"),
      toolCallLine(1, sessionId) + "\n",
      "utf8",
    );
  }

  return { runId, slug, sessionId };
}

async function getArtifacts(runId: string): Promise<ArtifactInstance[]> {
  return (await db
    .select()
    .from(schema.artifactInstances)
    .where(
      eq(schema.artifactInstances.runId, runId),
    )) as unknown as ArtifactInstance[];
}

describe("T5.2: projector startup catch-up sweep", () => {
  // Case 1: projects in-flight runs, skips terminal.
  it("projects in-flight runs and skips terminal runs", async () => {
    const running = await seedRun({ status: "Running", writeEvents: true });
    const review = await seedRun({ status: "Review", writeEvents: true });
    const done = await seedRun({ status: "Done", writeEvents: true });

    const result = await runProjectorCatchUpSweep({ db });

    // Both in-flight runs derived projector artifacts.
    expect((await getArtifacts(running.runId)).length).toBeGreaterThanOrEqual(
      1,
    );
    expect((await getArtifacts(review.runId)).length).toBeGreaterThanOrEqual(1);

    // The terminal Done run is never swept, even though it has an events file.
    expect(await getArtifacts(done.runId)).toHaveLength(0);

    expect(result.candidatesFound).toBe(2);
    expect(result.projected).toBeGreaterThanOrEqual(2);
  });

  // Case 2: idempotent across repeated sweeps.
  it("is idempotent: a second sweep adds no duplicate rows", async () => {
    const running = await seedRun({ status: "Running", writeEvents: true });
    const needsInput = await seedRun({
      status: "NeedsInput",
      writeEvents: true,
    });

    await runProjectorCatchUpSweep({ db });

    const afterFirst =
      (await getArtifacts(running.runId)).length +
      (await getArtifacts(needsInput.runId)).length;

    await runProjectorCatchUpSweep({ db });

    const afterSecond =
      (await getArtifacts(running.runId)).length +
      (await getArtifacts(needsInput.runId)).length;

    expect(afterFirst).toBeGreaterThanOrEqual(2);
    expect(afterSecond).toBe(afterFirst);
  });

  // Case 3: bounded by limit.
  it("processes at most `limit` candidate runs in one pass", async () => {
    await seedRun({ status: "Running", writeEvents: true });
    await seedRun({ status: "HumanWorking", writeEvents: true });
    await seedRun({ status: "Review", writeEvents: true });

    const bounded = await runProjectorCatchUpSweep({ db, limit: 2 });

    expect(bounded.candidatesFound).toBe(2);

    // A subsequent unbounded pass picks up the remaining in-flight run(s).
    const rest = await runProjectorCatchUpSweep({ db, limit: 10 });

    expect(rest.candidatesFound).toBeGreaterThanOrEqual(1);
  });
});
