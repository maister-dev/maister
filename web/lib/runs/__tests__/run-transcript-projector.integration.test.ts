import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("stays 'unchanged' when only a run-level line (no nodeAttemptId) is appended", async () => {
    const { runId, slug, planAttemptId } = await seed();

    await writeEvents(slug, runId, [textLine(planAttemptId, 1, "plan output")]);
    await projectRunTranscript(runId, { client: db, runtimeRoot });

    // A run-level marker (e.g. `run.needs_input`) advances the file's max
    // monotonicId but carries no nodeAttemptId, so it must not re-trigger
    // projection — otherwise a run in NeedsInput re-derives on every read.
    await writeEvents(slug, runId, [
      textLine(planAttemptId, 1, "plan output"),
      JSON.stringify({ type: "run.needs_input", monotonicId: 999 }),
    ]);

    const again = await projectRunTranscript(runId, {
      client: db,
      runtimeRoot,
    });

    expect(again.status).toBe("unchanged");
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

  // Codex adversarial finding #2: cross-run attribution must not leak.
  it("never attributes transcript rows to a node attempt owned by a different run", async () => {
    const a = await seed();
    const b = await seed();

    // Run A's durable log carries a line mis-stamped with run B's attempt id.
    await writeEvents(a.slug, a.runId, [
      textLine(a.planAttemptId, 1, "legit A output"),
      textLine(b.planAttemptId, 2, "would leak into A's transcript"),
    ]);

    await projectRunTranscript(a.runId, { client: db, runtimeRoot });

    // A's own attempt projected correctly.
    const aPlan = await getRunNodeTranscript(a.runId, "plan", { client: db });

    expect(aPlan?.messages).toHaveLength(1);
    expect(aPlan?.messages[0].content).toBe("legit A output");

    // The mis-attributed line created NO row for run B's attempt (insert-side
    // ownership guard), and run B's transcript stays empty.
    const bRows = await db
      .select()
      .from(schema.runMessages)
      .where(eq(schema.runMessages.nodeAttemptId, b.planAttemptId));

    expect(bRows).toHaveLength(0);

    const bPlan = await getRunNodeTranscript(b.runId, "plan", { client: db });

    expect(bPlan?.messages).toEqual([]);

    // Read-side defense-in-depth: even a hand-inserted cross-run row (run B's
    // id, run A's attempt) is excluded by getRunNodeTranscript's runId filter.
    await db.insert(schema.runMessages).values({
      id: randomUUID(),
      runId: b.runId,
      nodeAttemptId: a.planAttemptId,
      sequence: 999,
      role: "assistant",
      content: "cross-run row",
    });

    const aPlanAfter = await getRunNodeTranscript(a.runId, "plan", {
      client: db,
    });

    expect(aPlanAfter?.messages.map((m) => m.content)).toEqual([
      "legit A output",
    ]);
  });

  // Codex adversarial finding #1: a partial/failed projection must not advance
  // the cursor and strand rows — projection is atomic, so a failure rolls back
  // and the next call repairs the full transcript.
  it("rolls back a failed projection and repairs the full transcript on the next call", async () => {
    const { runId, slug, planAttemptId, implAttemptId } = await seed();

    await writeEvents(slug, runId, [
      textLine(planAttemptId, 1, "plan output"),
      textLine(implAttemptId, 2, "impl output"),
    ]);

    // Inject a failure on the 2nd insert INSIDE the projection transaction.
    await expect(
      projectRunTranscript(runId, {
        client: clientFailingOnNthInsert(db, 2),
        runtimeRoot,
      }),
    ).rejects.toThrow();

    // The transaction rolled back — nothing committed, so the cursor (max
    // supervisor_event_id) never advanced past the missing rows.
    const afterFailure = await db
      .select()
      .from(schema.runMessages)
      .where(eq(schema.runMessages.runId, runId));

    expect(afterFailure).toHaveLength(0);

    // A clean re-projection derives and commits the FULL transcript.
    const repaired = await projectRunTranscript(runId, {
      client: db,
      runtimeRoot,
    });

    expect(repaired.status).toBe("projected");

    const plan = await getRunNodeTranscript(runId, "plan", { client: db });
    const impl = await getRunNodeTranscript(runId, "implement", { client: db });

    expect(plan?.messages).toHaveLength(1);
    expect(impl?.messages).toHaveLength(1);
  });
});

// Wraps the real client so the Nth `insert` issued inside a `transaction`
// throws — simulating a mid-batch DB/timeout failure to prove atomic rollback.
function clientFailingOnNthInsert(real: Db, failOnNth: number): Db {
  let inserts = 0;
  const bound = (target: any, prop: PropertyKey) => {
    const value = target[prop];

    return typeof value === "function" ? value.bind(target) : value;
  };

  return new Proxy(real as unknown as Record<PropertyKey, unknown>, {
    get(target, prop) {
      if (prop !== "transaction") return bound(target, prop);

      return (cb: (tx: unknown) => unknown, ...rest: unknown[]) =>
        (target as any).transaction(
          (tx: any) => {
            const txProxy = new Proxy(tx, {
              get(t, p) {
                if (p !== "insert") return bound(t, p);

                return (...args: unknown[]) => {
                  inserts += 1;
                  if (inserts >= failOnNth) {
                    throw new Error("injected projection failure");
                  }

                  return t.insert(...args);
                };
              },
            });

            return cb(txProxy);
          },
          ...rest,
        );
    },
  }) as unknown as Db;
}
