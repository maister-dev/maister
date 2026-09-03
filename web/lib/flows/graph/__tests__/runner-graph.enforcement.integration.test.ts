import type { NodeAttempt, Run } from "@/lib/db/schema";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { FakeCall } from "@/test-support/fake-execution-host";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runFlow } from "@/lib/flows/runner";
import { fakeGraphHosts } from "@/test-support/fake-execution-host";
import { schema, seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "enforcement_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

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

// ADR-165: a fake execution host + a spy on every `session.create` payload.
// The refusal path MUST never reach the host — a create would mean an agent
// process was spawned and a permission deferred could leak. The pass path
// (instruct-only) WOULD spawn; the fake's clean end-turn lets the run finish
// without a real agent.
async function makeSupervisorSpy(runId: string): Promise<{
  hosts: ExecutionHosts;
  createSpy: ReturnType<typeof vi.fn>;
}> {
  const createSpy = vi.fn();
  const { hosts, fake } = await fakeGraphHosts(db, runId);

  fake.onCall("createSession", (call: FakeCall) => {
    createSpy(call.envelope?.payload);
  });

  return { hosts, createSpy };
}

// ai_coding node declaring strict skills — REFUSED on the ADR-130 table:
// skills is `instructed` for every agent (not seam-interceptable), so the
// static gate throws CONFIG. strict tools/mcps no longer refuse here — the
// seam flip made them `enforced` for all agents, admission-gated by the async
// evidence gate instead (EXECUTOR_UNAVAILABLE, covered in
// enforcement-evidence.test.ts).
const strictRefusalFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
      settings: { enforcement: { skills: "strict" } },
    },
  ],
};

// ai_coding node declaring only instruct enforcement — passes the gate.
const passFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
      settings: {
        tools: { claude: ["Edit"] },
        enforcement: { mcps: "instruct", tools: "instruct" },
      },
    },
  ],
};

describe("runGraph — per-node enforcement gate (3.5 / 3.6 / 2.2)", () => {
  it("refuses a strict-skills ai_coding node: attempt Failed errorCode=CONFIG, run Failed, NO supervisor spawn", async () => {
    const seeded = await seedGraphRun(db, strictRefusalFlow);
    const api = await makeSupervisorSpy(seeded.runId);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: api.hosts,
    });

    // Run goes terminal Failed.
    expect((await getRun(seeded.runId)).status).toBe("Failed");

    // The node attempt is recorded Failed with the typed errorCode.
    const attempt = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "implement",
    );

    expect(attempt).toBeDefined();
    expect(attempt!.status).toBe("Failed");
    expect(attempt!.errorCode).toBe("CONFIG");

    // 3.6 deferred-release: NO agent session was ever spawned for the refused
    // node, so no permission deferred can leak.
    expect(api.createSpy).not.toHaveBeenCalled();
  }, 60_000);

  it("writes node_attempts.enforcement_snapshot on the REFUSAL path (2.2)", async () => {
    const seeded = await seedGraphRun(db, strictRefusalFlow);
    const api = await makeSupervisorSpy(seeded.runId);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: api.hosts,
    });

    const attempt = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "implement",
    );

    expect(attempt?.enforcementSnapshot).not.toBeNull();
    expect(attempt!.enforcementSnapshot).toContainEqual({
      class: "skills",
      declared: "strict",
      capability: "instructed",
      verdict: "refused",
    });
  }, 60_000);

  it("writes node_attempts.enforcement_snapshot on the PASS path (2.2)", async () => {
    const seeded = await seedGraphRun(db, passFlow);
    const api = await makeSupervisorSpy(seeded.runId);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: api.hosts,
    });

    // The spy models a clean end-turn, so the run must finish Review with the
    // node Succeeded — a CONFIG-Failed run here means a runner seam fell back
    // to env getDb() (DB_URL is unset in vitest workers) instead of the
    // injected db.
    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempt = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "implement",
    );

    expect(attempt?.status).toBe("Succeeded");
    expect(attempt?.enforcementSnapshot).not.toBeNull();
    // Every class here is declared `instruct`, which resolves to `instructed`
    // regardless of the agent's capability — never `refused`.
    const verdicts = (attempt!.enforcementSnapshot ?? []).map((e) => e.verdict);

    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts).not.toContain("refused");
  }, 60_000);
});
