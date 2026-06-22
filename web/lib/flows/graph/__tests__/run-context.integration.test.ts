import type { NodeAttempt, Run } from "@/lib/db/schema";
import type { SupervisorApi } from "@/lib/flows/runner-agent";
import type { SupervisorEvent } from "@/lib/supervisor-client";

import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

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

const execFileAsync = promisify(execFile);
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

type Seeded = { runId: string; slug: string; runtimeRoot: string; worktreePath: string };

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
    prompt: "fix the bug",
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

  return { runId, slug, runtimeRoot, worktreePath };
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

function makeAgentSupervisor(text: string): SupervisorApi {
  async function* stream(): AsyncGenerator<SupervisorEvent> {
    yield {
      type: "session.update",
      sessionId: "sup-1",
      monotonicId: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    } as SupervisorEvent;
    yield {
      type: "session.exited",
      sessionId: "sup-1",
      monotonicId: 2,
      exitCode: 0,
    } as SupervisorEvent;
  }

  return {
    createSession: (async () => ({
      sessionId: "sup-1",
      pid: 1,
      acpSessionId: "acp-1",
    })) as unknown as SupervisorApi["createSession"],
    deleteSession: (async () =>
      undefined) as unknown as SupervisorApi["deleteSession"],
    sendPrompt: (async () => ({
      stopReason: "end_turn" as const,
    })) as unknown as SupervisorApi["sendPrompt"],
    streamSession: (() => stream()) as unknown as SupervisorApi["streamSession"],
    cancelPermission: (async () => ({
      ok: true,
    })) as unknown as SupervisorApi["cancelPermission"],
    deliverPermission: (async () => ({
      ok: true,
    })) as unknown as SupervisorApi["deliverPermission"],
  };
}

const OPEN = "```json maister:output";
const CLOSE = "```";

describe("runGraph — P7 run-context (ADR-103)", () => {
  it("writes <worktree>/.maister/run.json projecting intent + node vars + promoted", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "emit",
          type: "cli",
          action: {
            command: `echo '{"verdict":"ok","score":7}' > "$MAISTER_OUTPUT_FILE"`,
          },
          output: { result: { schema: SCHEMA } },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const raw = await readFile(
      join(seeded.worktreePath, ".maister", "run.json"),
      "utf8",
    );
    const ctx = JSON.parse(raw) as {
      intent: string;
      nodes: Record<string, { summary: string; vars: Record<string, unknown> }>;
      gates: Record<string, unknown>;
      promoted: Record<string, unknown>;
    };

    expect(ctx.intent).toBe("fix the bug");
    expect(ctx.nodes.emit.vars).toEqual({ verdict: "ok", score: 7 });
    expect(ctx.promoted).toEqual({ verdict: "ok", score: 7 });
  }, 60_000);

  it("keeps run.json out of git (.maister/ is excluded; absent from git status)", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "a",
          type: "cli",
          action: { command: "echo hi" },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    // Make the worktree a real git repo so ensureWorktreeGitExclude resolves
    // info/exclude and run.json can be excluded.
    await execFileAsync("git", ["-C", seeded.worktreePath, "init", "-q"]);
    await execFileAsync("git", [
      "-C",
      seeded.worktreePath,
      "config",
      "user.email",
      "t@t",
    ]);
    await execFileAsync("git", [
      "-C",
      seeded.worktreePath,
      "config",
      "user.name",
      "t",
    ]);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // run.json exists on disk...
    const raw = await readFile(
      join(seeded.worktreePath, ".maister", "run.json"),
      "utf8",
    );

    expect(raw).toContain('"intent"');

    // ...but git ignores the whole .maister/ subtree.
    const { stdout } = await execFileAsync("git", [
      "-C",
      seeded.worktreePath,
      "status",
      "--porcelain",
      "--ignored",
    ]);

    expect(stdout).not.toMatch(/^\?\?\s+\.maister/m); // not untracked
    expect(stdout).toMatch(/!!\s+\.maister/); // shown as ignored
  }, 60_000);

  it("appends a [Run context: <path>] pointer to each agent node's prompt", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "judge",
          type: "judge",
          action: { prompt: "judge {{ task.prompt }}" },
          output: { result: { schema: SCHEMA } },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);
    const api = makeAgentSupervisor(
      `Reviewed.\n${OPEN}\n{"verdict":"ok","score":1}\n${CLOSE}\n`,
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const judge = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "judge",
    );
    const expectedPath = join(seeded.worktreePath, ".maister", "run.json");

    expect(judge?.resolvedPrompt ?? "").toContain(`[Run context: ${expectedPath}]`);
  }, 60_000);
});
