import type { OpenAiCompatibleClient } from "@/lib/brain/openai-compatible";
import type { DomainEventRow } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { harvestEvents } from "@/lib/domain-events/memory-harvest";
import { MaisterError } from "@/lib/errors";
import {
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  TEST_EMBEDDING_DIMENSIONS,
  TEST_EMBEDDING_MODEL,
  type BrainTestDb,
} from "@/lib/brain/__tests__/helpers";

// T3.2 — the memory_harvest consumer (real pgvector). The embedding/distill
// client is injected via harvestEvents; events are inserted into domain_events
// so the provenance FK resolves.

let ctx: BrainTestDb;
const DIMS = TEST_EMBEDDING_DIMENSIONS;
const VALID_LESSON = JSON.stringify({
  content: "always run the migration before seeding",
  kind: "lesson",
  tags: ["db"],
});

function embedVector(): number[] {
  const v = new Array(DIMS).fill(0);

  v[0] = 1;

  return v;
}

function makeClient(
  over: Partial<OpenAiCompatibleClient> = {},
): OpenAiCompatibleClient {
  return {
    provider: "openai_compatible",
    model: TEST_EMBEDDING_MODEL,
    dimensions: DIMS,
    version: `${TEST_EMBEDDING_MODEL}@${DIMS}`,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => embedVector());
    },
    async complete(): Promise<string> {
      return VALID_LESSON;
    },
    ...over,
  };
}

function resolve(client: OpenAiCompatibleClient) {
  return () => Promise.resolve(client);
}

async function insertEvent(over: {
  kind: string;
  projectId: string;
  runId?: string | null;
  taskId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<DomainEventRow> {
  const r = await ctx.db.execute(sql`
    INSERT INTO domain_events (kind, project_id, task_id, run_id, actor_type, actor_id, payload, occurred_at)
    VALUES (${over.kind}, ${over.projectId}, ${over.taskId ?? null}, ${over.runId ?? null},
            'system', NULL, ${JSON.stringify(over.payload ?? {})}::jsonb, now())
    RETURNING id
  `);

  return {
    id: Number(r.rows[0].id),
    kind: over.kind,
    projectId: over.projectId,
    taskId: over.taskId ?? null,
    runId: over.runId ?? null,
    payload: over.payload ?? {},
    actorType: "system",
    actorId: null,
    occurredAt: new Date(),
    createdAt: new Date(),
    txId: "0",
  } as DomainEventRow;
}

async function seedRun(projectId: string): Promise<string> {
  const runId = randomUUID();

  await ctx.db.execute(sql`
    INSERT INTO runs (id, project_id, run_kind, status, flow_version)
    VALUES (${runId}, ${projectId}, 'flow', 'Done', 'v1')
  `);

  return runId;
}

async function activeCount(projectId: string): Promise<number> {
  const r = await ctx.db.execute(
    sql`SELECT count(*)::int AS n FROM brain_items WHERE project_id = ${projectId} AND status = 'active'`,
  );

  return Number(r.rows[0]?.n);
}

let projectId: string;

beforeAll(async () => {
  ctx = await startBrainTestDb();
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

beforeEach(async () => {
  projectId = await seedBrainProject(ctx.db);
});

describe("memory_harvest consumer (T3.2)", () => {
  it("harvests a run-terminal event into a lesson with provenance FKs", async () => {
    const runId = await seedRun(projectId);
    const event = await insertEvent({
      kind: "run.done",
      projectId,
      runId,
      payload: { runId, runKind: "flow", reason: "rework" },
    });

    await harvestEvents([event], {
      db: ctx.db,
      resolveClient: resolve(makeClient()),
    });

    const row = await ctx.db.execute(
      sql`SELECT source_run_id, source_domain_event_id, kind FROM brain_items WHERE project_id = ${projectId}`,
    );

    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.source_run_id).toBe(runId);
    expect(Number(row.rows[0]?.source_domain_event_id)).toBe(event.id);
    expect(row.rows[0]?.kind).toBe("lesson");
  });

  it("is idempotent on re-delivery of the same event (no duplicate)", async () => {
    const runId = await seedRun(projectId);
    const event = await insertEvent({
      kind: "run.done",
      projectId,
      runId,
      payload: { runId },
    });
    const opts = { db: ctx.db, resolveClient: resolve(makeClient()) };

    await harvestEvents([event], opts);
    await harvestEvents([event], opts);

    expect(await activeCount(projectId)).toBe(1);
  });

  it("does NOT harvest run.review (excluded from the predicate)", async () => {
    const runId = await seedRun(projectId);
    const event = await insertEvent({
      kind: "run.review",
      projectId,
      runId,
      payload: { runId },
    });

    await harvestEvents([event], {
      db: ctx.db,
      resolveClient: resolve(makeClient()),
    });

    expect(await activeCount(projectId)).toBe(0);
  });

  it("skips (advances) when the project's Brain is disabled", async () => {
    const disabled = await seedBrainProject(ctx.db, { brainEnabled: false });
    const runId = await seedRun(disabled);
    const event = await insertEvent({
      kind: "run.done",
      projectId: disabled,
      runId,
      payload: { runId },
    });

    // No throw (advances); no write.
    await harvestEvents([event], {
      db: ctx.db,
      resolveClient: resolve(makeClient()),
    });

    expect(await activeCount(disabled)).toBe(0);
  });

  it("THROWS (cursor holds) when distill config is unset — a transient CONFIG", async () => {
    const runId = await seedRun(projectId);
    const event = await insertEvent({
      kind: "run.done",
      projectId,
      runId,
      payload: { runId },
    });
    const client = makeClient({
      async complete(): Promise<string> {
        throw new MaisterError("CONFIG", "distill_model is not configured");
      },
    });

    await expect(
      harvestEvents([event], { db: ctx.db, resolveClient: resolve(client) }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    expect(await activeCount(projectId)).toBe(0);
  });

  it("skips (advances) on schema-invalid distill output — a permanent failure", async () => {
    const runId = await seedRun(projectId);
    const event = await insertEvent({
      kind: "run.done",
      projectId,
      runId,
      payload: { runId },
    });
    const client = makeClient({
      async complete(): Promise<string> {
        return "not json";
      },
    });

    // No throw; no write.
    await harvestEvents([event], {
      db: ctx.db,
      resolveClient: resolve(client),
    });

    expect(await activeCount(projectId)).toBe(0);
  });

  it("THROWS (cursor holds) on a transient embed failure during retain", async () => {
    const runId = await seedRun(projectId);
    const event = await insertEvent({
      kind: "run.done",
      projectId,
      runId,
      payload: { runId },
    });
    const client = makeClient({
      async embed(): Promise<number[][]> {
        throw new MaisterError("EMBEDDING_UNAVAILABLE", "provider down");
      },
    });

    await expect(
      harvestEvents([event], { db: ctx.db, resolveClient: resolve(client) }),
    ).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" });
    expect(await activeCount(projectId)).toBe(0);
  });

  it("harvests a gate.failed event (predicate includes gate.failed)", async () => {
    const runId = await seedRun(projectId);
    const event = await insertEvent({
      kind: "gate.failed",
      projectId,
      runId,
      payload: { runId, gateKind: "command_check", blocking: true },
    });

    await harvestEvents([event], {
      db: ctx.db,
      resolveClient: resolve(makeClient()),
    });

    const row = await ctx.db.execute(
      sql`SELECT source_gate_kind FROM brain_items WHERE project_id = ${projectId}`,
    );

    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.source_gate_kind).toBe("command_check");
  });
});
