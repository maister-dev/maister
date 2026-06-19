import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches run-node-status.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let runtimeRootDir: string;
let originalRuntimeRoot: string | undefined;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let getInboxCardContext: typeof import("@/lib/queries/inbox-context").getInboxCardContext;

const TWO_NODE_MANIFEST = {
  schemaVersion: 1,
  name: "two-node",
  nodes: [
    { id: "plan", type: "ai_coding", action: { prompt: "go" } },
    { id: "checks", type: "check" },
  ],
};

const LEGACY_LINEAR_MANIFEST = {
  schemaVersion: 1,
  name: "legacy-linear",
  steps: [
    { id: "build", type: "cli" },
    { id: "review", type: "human" },
  ],
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("inbox_context_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  // loadLastAgentMessage reads run.events.jsonl under runtimeRoot(); point it at
  // a throwaway dir so the events-tail path is exercised against real files.
  runtimeRootDir = await mkdtemp(path.join(tmpdir(), "inbox-ctx-"));
  originalRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;
  process.env.MAISTER_RUNTIME_ROOT = runtimeRootDir;

  ({ getInboxCardContext } = await import("@/lib/queries/inbox-context"));
}, 180_000);

afterAll(async () => {
  if (originalRuntimeRoot === undefined)
    delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = originalRuntimeRoot;
  if (runtimeRootDir)
    await rm(runtimeRootDir, { recursive: true, force: true });
  await pool?.end();
  await container?.stop();
});

interface SeedOpts {
  manifest?: unknown;
  currentStepId?: string | null;
}

async function seedRun(
  opts: SeedOpts = {},
): Promise<{ projectId: string; runId: string; slug: string; flowId: string }> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Inbox Context Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "aif",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/aif",
    manifest: opts.manifest ?? { schemaVersion: 1, name: "aif", nodes: [] },
    schemaVersion: 1,
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
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status: "NeedsInput",
    currentStepId:
      opts.currentStepId === undefined ? "checks" : opts.currentStepId,
    flowVersion: "v1.0.0",
  });

  return { projectId, runId, slug, flowId };
}

async function writeEventsLog(
  slug: string,
  runId: string,
  lines: string[],
): Promise<void> {
  const dir = path.join(runtimeRootDir, ".maister", slug, "runs", runId);

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "run.events.jsonl"), lines.join("\n"), "utf8");
}

function agentMessageEvent(text: string): string {
  return JSON.stringify({
    type: "session.update",
    update: { sessionUpdate: "agent_message_chunk", content: { text } },
  });
}

async function loadContext(seed: {
  projectId: string;
  runId: string;
  currentStepId?: string | null;
  flowId?: string | null;
}) {
  return getInboxCardContext({
    id: seed.runId,
    projectId: seed.projectId,
    currentStepId:
      seed.currentStepId === undefined ? "checks" : seed.currentStepId,
    flowRevisionId: null,
    flowId: seed.flowId ?? null,
  });
}

describe("getInboxCardContext (integration)", () => {
  it("maps the current node attempt's gates", async () => {
    const seed = await seedRun({ currentStepId: "checks" });
    const attemptId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: attemptId,
      runId: seed.runId,
      nodeId: "checks",
      nodeType: "check",
      attempt: 1,
      status: "Failed",
      startedAt: new Date("2026-06-01T10:00:00.000Z"),
    });
    await db.insert(schema.gateResults).values({
      id: randomUUID(),
      runId: seed.runId,
      nodeAttemptId: attemptId,
      gateId: "lint",
      kind: "command_check",
      mode: "blocking",
      status: "failed",
      verdict: { verdict: "fail" },
      createdAt: new Date("2026-06-01T10:00:30.000Z"),
    });

    const ctx = await loadContext(seed);

    expect(ctx.gates).toEqual([
      {
        gateId: "lint",
        kind: "command_check",
        mode: "blocking",
        status: "failed",
      },
    ]);
  });

  it("computes progress (done/total) over the compiled graph node map", async () => {
    const seed = await seedRun({ manifest: TWO_NODE_MANIFEST });

    // One of the two graph nodes has a succeeded attempt → done=1, total=2.
    await db.insert(schema.nodeAttempts).values({
      id: randomUUID(),
      runId: seed.runId,
      nodeId: "plan",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Succeeded",
      startedAt: new Date("2026-06-01T09:00:00.000Z"),
    });

    const withFlow = await loadContext(seed);
    // A run whose manifest cannot be resolved (no flowId) degrades to null.
    const degraded = await loadContext({ ...seed, flowId: null });

    expect(withFlow.progress).toEqual({ done: 1, total: 2 });
    expect(degraded.progress).toBeNull();
  });

  it("counts succeeded step_runs (not node_attempts) for legacy linear runs", async () => {
    const seed = await seedRun({
      manifest: LEGACY_LINEAR_MANIFEST,
      currentStepId: "review",
    });

    // Legacy `steps[]` runs ledger progress in step_runs; a legacy run has no
    // node_attempts, so counting only that table would render 0/2.
    await db.insert(schema.stepRuns).values({
      id: randomUUID(),
      runId: seed.runId,
      stepId: "build",
      stepType: "cli",
      attempt: 1,
      status: "Succeeded",
      startedAt: new Date("2026-06-01T09:00:00.000Z"),
      endedAt: new Date("2026-06-01T09:01:00.000Z"),
    });

    const ctx = await loadContext({ ...seed, currentStepId: "review" });

    expect(ctx.progress).toEqual({ done: 1, total: 2 });
  });

  it("returns the trailing agent message from run.events.jsonl", async () => {
    const seed = await seedRun({ currentStepId: null });

    await writeEventsLog(seed.slug, seed.runId, [
      agentMessageEvent("Should I "),
      agentMessageEvent("proceed?"),
    ]);

    const ctx = await loadContext({ ...seed, currentStepId: null });

    expect(ctx.lastAgentMessage?.text).toBe("Should I proceed?");
    expect(typeof ctx.lastAgentMessage?.at).toBe("string");
  });

  it("degrades lastAgentMessage to null when the events file is missing (never throws)", async () => {
    const seed = await seedRun({ currentStepId: null });

    const ctx = await loadContext({ ...seed, currentStepId: null });

    expect(ctx.lastAgentMessage).toBeNull();
    // No workspace row seeded → the diff peek also degrades, not 500s.
    expect(ctx.diff).toBeNull();
  });
});
