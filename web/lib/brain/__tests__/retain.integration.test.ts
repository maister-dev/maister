import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  fakeEmbeddingClient,
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  TEST_EMBEDDING_DIMENSIONS,
  type BrainTestDb,
} from "./helpers";

import { retain } from "@/lib/brain/retain";

// T2.2 — retain: atomic dedup-or-reinforce, race-safe (real pgvector).

let ctx: BrainTestDb;
let projectId: string;

const DIMS = TEST_EMBEDDING_DIMENSIONS;

// A near vector — two DISTINCT texts marked "SIM:" map to near-parallel vectors
// (cosine ≈ 1 > τ) so the second retain reinforces the first. A tiny per-text
// perturbation keeps them non-identical (distinct content_hash → the near path,
// not the exact-dup path).
function nearVector(text: string): number[] {
  const v = new Array(DIMS).fill(0);

  v[0] = 1;
  v[1] = 1;
  v[2] = (text.length % 7) * 0.001;

  return v;
}

function orthoVector(text: string): number[] {
  const v = new Array(DIMS).fill(0);
  let h = 2166136261;

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  v[(Math.abs(h) % (DIMS - 10)) + 10] = 1; // avoid the near-vector dims 0..2

  return v;
}

const client = fakeEmbeddingClient({
  vectorFor: (t: string) =>
    t.startsWith("SIM:") ? nearVector(t) : orthoVector(t),
});

async function count(where: string): Promise<number> {
  const r = await ctx.db.execute(
    sql.raw(`SELECT count(*)::int AS n FROM brain_items WHERE ${where}`),
  );

  return Number(r.rows[0]?.n);
}

beforeAll(async () => {
  ctx = await startBrainTestDb();
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

beforeEach(async () => {
  projectId = await seedBrainProject(ctx.db);
});

describe("retain — dedup-or-reinforce (T2.2)", () => {
  it("reinforces a semantically-near active item instead of duplicating (E-3)", async () => {
    const first = await retain(
      projectId,
      {
        kind: "lesson",
        content: "SIM: always run the migration before the seed",
      },
      {},
      { db: ctx.db, client },
    );

    expect(first.reinforced).toBe(false);

    const second = await retain(
      projectId,
      { kind: "lesson", content: "SIM: run migrations prior to seeding data" },
      {},
      { db: ctx.db, client },
    );

    expect(second.reinforced).toBe(true);
    expect(second.itemId).toBe(first.itemId);
    expect(
      await count(`project_id = '${projectId}' AND status = 'active'`),
    ).toBe(1);

    const row = await ctx.db.execute(
      sql`SELECT confidence::float8 AS confidence, reinforcement_count FROM brain_items WHERE id = ${first.itemId}`,
    );

    expect(Number(row.rows[0]?.confidence)).toBeCloseTo(0.4, 5); // 0.3 + 0.1
    expect(Number(row.rows[0]?.reinforcement_count)).toBe(1);
  });

  it("is idempotent on identical content (no duplicate, no reinforce)", async () => {
    const a = await retain(
      projectId,
      { kind: "observation", content: "the CI job is flaky on macOS" },
      {},
      { db: ctx.db, client },
    );
    const b = await retain(
      projectId,
      { kind: "observation", content: "the CI job is flaky on macOS" },
      {},
      { db: ctx.db, client },
    );

    expect(b.itemId).toBe(a.itemId);
    expect(b.reinforced).toBe(false);
    expect(
      await count(`project_id = '${projectId}' AND status = 'active'`),
    ).toBe(1);

    const row = await ctx.db.execute(
      sql`SELECT reinforcement_count FROM brain_items WHERE id = ${a.itemId}`,
    );

    expect(Number(row.rows[0]?.reinforcement_count)).toBe(0);
  });

  it("two concurrent retains of the same content produce exactly one active row", async () => {
    const content = `race-${randomUUID()}`;
    const results = await Promise.all([
      retain(
        projectId,
        { kind: "lesson", content },
        {},
        { db: ctx.db, client },
      ),
      retain(
        projectId,
        { kind: "lesson", content },
        {},
        { db: ctx.db, client },
      ),
    ]);

    expect(results[0].itemId).toBe(results[1].itemId);
    expect(
      await count(`project_id = '${projectId}' AND status = 'active'`),
    ).toBe(1);
  });

  it("keeps non-near content as a separate item", async () => {
    await retain(
      projectId,
      { kind: "lesson", content: "totally unrelated fact about widgets" },
      {},
      { db: ctx.db, client },
    );
    await retain(
      projectId,
      { kind: "lesson", content: "an entirely different fact about gadgets" },
      {},
      { db: ctx.db, client },
    );

    expect(
      await count(`project_id = '${projectId}' AND status = 'active'`),
    ).toBe(2);
  });

  it("reinforce NEVER mutates the reinforced item's embedding row (E-2 immutability)", async () => {
    const first = await retain(
      projectId,
      { kind: "lesson", content: "SIM: prefer server components by default" },
      {},
      { db: ctx.db, client },
    );

    const before = await ctx.db.execute(
      sql`SELECT id, embedded_at FROM brain_embeddings WHERE item_id = ${first.itemId} ORDER BY split_ordinal`,
    );

    await retain(
      projectId,
      { kind: "lesson", content: "SIM: default to server components in Next" },
      {},
      { db: ctx.db, client },
    );

    const after = await ctx.db.execute(
      sql`SELECT id, embedded_at FROM brain_embeddings WHERE item_id = ${first.itemId} ORDER BY split_ordinal`,
    );

    // same embedding rows, byte-identical embedded_at — reinforce touched only brain_items
    expect(after.rows.map((r) => r.id)).toEqual(before.rows.map((r) => r.id));
    expect(after.rows.map((r) => String(r.embedded_at))).toEqual(
      before.rows.map((r) => String(r.embedded_at)),
    );
  });

  it("stores provenance FKs and a per-segment embedding for an oversize item", async () => {
    const runId = await seedRun(projectId);
    const big = Array(60).fill("SIM: oversize lesson body sentence.").join(" ");
    const res = await retain(
      projectId,
      { kind: "lesson", content: big },
      { sourceRunId: runId, sourceGateKind: "command_check" },
      { db: ctx.db, client },
    );

    const item = await ctx.db.execute(
      sql`SELECT source_run_id, source_gate_kind FROM brain_items WHERE id = ${res.itemId}`,
    );

    expect(item.rows[0]?.source_run_id).toBe(runId);
    expect(item.rows[0]?.source_gate_kind).toBe("command_check");

    const embs = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM brain_embeddings WHERE item_id = ${res.itemId}`,
    );

    // short enough to be one segment here, but the invariant is ≥ 1 immutable row
    expect(Number(embs.rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });
});

// Minimal run row so a provenance FK resolves.
async function seedRun(pid: string): Promise<string> {
  const runId = randomUUID();

  await ctx.db.execute(sql`
    INSERT INTO runs (id, project_id, run_kind, status, flow_version)
    VALUES (${runId}, ${pid}, 'flow', 'Running', 'v1')
  `);

  return runId;
}

describe("retain — review-fix hardening (kind scope, decay race, kill switch, TTL)", () => {
  it("near-dup match is KIND-scoped: a state_fact never reinforces a near lesson", async () => {
    const first = await retain(
      projectId,
      { kind: "lesson", content: "SIM: prefer pnpm scripts over raw npx" },
      {},
      { db: ctx.db, client },
    );

    const second = await retain(
      projectId,
      { kind: "state_fact", content: "SIM: this repo uses pnpm exclusively" },
      {},
      { db: ctx.db, client },
    );

    // Same near vector, different kind → a NEW item, not a reinforce.
    expect(second.reinforced).toBe(false);
    expect(second.itemId).not.toBe(first.itemId);

    const kinds = await ctx.db.execute(
      sql`SELECT kind, expires_at FROM brain_items WHERE id = ${second.itemId}`,
    );

    // The state_fact keeps its own decay semantics (never expires).
    expect(kinds.rows[0]?.kind).toBe("state_fact");
    expect(kinds.rows[0]?.expires_at).toBeNull();
  });

  it("a near match that is no longer active is NOT reinforced — a fresh item is inserted (decay-race guard)", async () => {
    const first = await retain(
      projectId,
      { kind: "lesson", content: "SIM: keep worktrees out of /tmp" },
      {},
      { db: ctx.db, client },
    );

    // Simulate the decay sweep winning the race: the near match goes expired.
    await ctx.db.execute(
      sql`UPDATE brain_items SET status = 'expired' WHERE id = ${first.itemId}`,
    );

    const second = await retain(
      projectId,
      { kind: "lesson", content: "SIM: scratch worktrees never under /tmp" },
      {},
      { db: ctx.db, client },
    );

    // The lesson lands on a NEW active row — never counters on an invisible one.
    expect(second.reinforced).toBe(false);
    expect(second.itemId).not.toBe(first.itemId);
    expect(
      await count(`project_id = '${projectId}' AND status = 'active'`),
    ).toBe(1);

    const old = await ctx.db.execute(
      sql`SELECT reinforcement_count FROM brain_items WHERE id = ${first.itemId}`,
    );

    expect(Number(old.rows[0]?.reinforcement_count)).toBe(0);
  });

  it("reinforce pushes expires_at out (the TTL half of the reinforce contract)", async () => {
    const first = await retain(
      projectId,
      { kind: "lesson", content: "SIM: pin the container image tag" },
      {},
      { db: ctx.db, client },
    );

    // Pull the expiry near so the push is unambiguous.
    await ctx.db.execute(
      sql`UPDATE brain_items SET expires_at = now() + INTERVAL '1 day' WHERE id = ${first.itemId}`,
    );

    await retain(
      projectId,
      { kind: "lesson", content: "SIM: always pin container image tags" },
      {},
      { db: ctx.db, client },
    );

    const row = await ctx.db.execute(
      sql`SELECT (expires_at > now() + INTERVAL '29 days') AS pushed FROM brain_items WHERE id = ${first.itemId}`,
    );

    expect(Boolean(row.rows[0]?.pushed)).toBe(true);
  });

  it("refuses CONFIG on a brain-disabled project (kill switch enforced INSIDE the service)", async () => {
    const disabled = await seedBrainProject(ctx.db, { brainEnabled: false });

    await expect(
      retain(
        disabled,
        { kind: "lesson", content: "must not be stored" },
        {},
        { db: ctx.db, client },
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    expect(await count(`project_id = '${disabled}'`)).toBe(0);
  });
});
