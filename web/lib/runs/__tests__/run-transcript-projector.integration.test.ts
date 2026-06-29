import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  getRunNodeTranscript,
  projectRunTranscript,
} from "@/lib/runs/run-transcript-projector";

const schema = fullSchema as unknown as Record<string, any>;

type Db = NodePgDatabase<typeof fullSchema>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let runtimeRoot: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_transcript_projector_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema: fullSchema }) as unknown as Db;

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  runtimeRoot = await mkdtemp(join(tmpdir(), "transcript-projector-"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
});

function textLine(nodeAttemptId: string, monotonicId: number, text: string) {
  return JSON.stringify({
    type: "session.update",
    monotonicId,
    sessionName: "node",
    nodeAttemptId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });
}

function toolLine(nodeAttemptId: string, monotonicId: number) {
  return JSON.stringify({
    type: "session.update",
    monotonicId,
    sessionName: "node",
    nodeAttemptId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Edit file",
      kind: "edit",
      status: "completed",
      content: [],
    },
  });
}

function usageLine(nodeAttemptId: string, monotonicId: number, used: number) {
  return JSON.stringify({
    type: "session.update",
    monotonicId,
    sessionName: "node",
    nodeAttemptId,
    update: { sessionUpdate: "usage_update", used, size: 200000 },
  });
}

async function seed(): Promise<{
  runId: string;
  slug: string;
  planAttemptId: string;
  implAttemptId: string;
}> {
  const projectId = randomUUID();
  const runId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${projectId.slice(0, 8)}`.toUpperCase(),
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "flow",
    status: "Running",
    flowVersion: "v1",
    flowRevision: "manual",
  });

  const planAttemptId = randomUUID();
  const implAttemptId = randomUUID();

  await db.insert(schema.nodeAttempts).values([
    {
      id: planAttemptId,
      runId,
      nodeId: "plan",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Succeeded",
    },
    {
      id: implAttemptId,
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Running",
    },
  ]);

  return { runId, slug, planAttemptId, implAttemptId };
}

async function writeEvents(slug: string, runId: string, lines: string[]) {
  const dir = join(runtimeRoot, ".maister", slug, "runs", runId);

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.events.jsonl"), lines.join("\n") + "\n");
}

describe("projectRunTranscript", () => {
  it("attributes coalesced messages to the right node attempt and is idempotent", async () => {
    const { runId, slug, planAttemptId, implAttemptId } = await seed();

    await writeEvents(slug, runId, [
      textLine(planAttemptId, 1, "Plan "),
      textLine(planAttemptId, 2, "ready."),
      textLine(implAttemptId, 3, "Editing..."),
      toolLine(implAttemptId, 4),
      usageLine(implAttemptId, 5, 1234),
    ]);

    const first = await projectRunTranscript(runId, {
      client: db,
      runtimeRoot,
    });

    expect(first.status).toBe("projected");
    expect(first.nodeAttempts).toBe(2);

    // plan: one coalesced assistant message.
    const plan = await getRunNodeTranscript(runId, "plan", { client: db });

    expect(plan?.messages).toHaveLength(1);
    expect(plan?.messages[0]).toMatchObject({
      role: "assistant",
      content: "Plan ready.",
    });

    // implement: assistant text + tool + usage(system); usage surfaced.
    const impl = await getRunNodeTranscript(runId, "implement", { client: db });

    expect(impl?.messages.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "system",
    ]);
    expect(impl?.usage).toMatchObject({ used: 1234 });

    // Idempotent: re-projection with no new events is a no-op; row count holds.
    const again = await projectRunTranscript(runId, {
      client: db,
      runtimeRoot,
    });

    expect(again.status).toBe("unchanged");

    const planAfter = await getRunNodeTranscript(runId, "plan", { client: db });

    expect(planAfter?.messages).toHaveLength(1);
  });

  it("returns the LATEST attempt's transcript for a reworked node", async () => {
    const { runId, slug } = await seed();
    const nodeId = "review";
    const attempt1 = randomUUID();
    const attempt2 = randomUUID();

    await db.insert(schema.nodeAttempts).values([
      {
        id: attempt1,
        runId,
        nodeId,
        nodeType: "ai_coding",
        attempt: 1,
        status: "Reworked",
      },
      {
        id: attempt2,
        runId,
        nodeId,
        nodeType: "ai_coding",
        attempt: 2,
        status: "Running",
      },
    ]);

    await writeEvents(slug, runId, [
      textLine(attempt1, 1, "first attempt output"),
      textLine(attempt2, 2, "second attempt output"),
    ]);

    await projectRunTranscript(runId, { client: db, runtimeRoot });

    const transcript = await getRunNodeTranscript(runId, nodeId, {
      client: db,
    });

    expect(transcript?.messages).toHaveLength(1);
    expect(transcript?.messages[0].content).toBe("second attempt output");
  });

  it("returns missing-run for an unknown run and empty for a node with no attempt", async () => {
    const missing = await projectRunTranscript(randomUUID(), {
      client: db,
      runtimeRoot,
    });

    expect(missing.status).toBe("missing-run");

    const { runId } = await seed();
    const empty = await getRunNodeTranscript(runId, "never-ran", {
      client: db,
    });

    expect(empty?.messages).toEqual([]);
  });
});
