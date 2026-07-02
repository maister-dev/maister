import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  fakeEmbeddingClient,
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  type BrainTestDb,
} from "./helpers";

import { resetBrainDecayThrottle, runBrainDecaySweep } from "@/lib/brain/decay";
import { resetBrainSchemaProbe } from "@/lib/brain/guard";
import { recall } from "@/lib/brain/recall";

// T3.3 — the throttled decay sweep (real pgvector). Only touches brain_items;
// no embeddings needed.

let ctx: BrainTestDb;
let projectId: string;

async function insertItem(over: {
  status?: string;
  expiresInDays?: number | null;
  confidence?: number;
  content?: string;
}): Promise<string> {
  const id = randomUUID();
  const expires =
    over.expiresInDays === null || over.expiresInDays === undefined
      ? sql`NULL`
      : sql`now() + ${sql.raw(String(over.expiresInDays))} * INTERVAL '1 day'`;

  await ctx.db.execute(sql`
    INSERT INTO brain_items (id, project_id, kind, title, content, status, confidence, content_hash, expires_at)
    VALUES (${id}, ${projectId}, 'lesson', 't', ${over.content ?? "c"}, ${over.status ?? "active"},
            ${over.confidence ?? 0.3}, ${randomUUID()}, ${expires})
  `);

  return id;
}

async function statusOf(id: string): Promise<string> {
  const r = await ctx.db.execute(
    sql`SELECT status FROM brain_items WHERE id = ${id}`,
  );

  return String(r.rows[0]?.status);
}

beforeAll(async () => {
  ctx = await startBrainTestDb();
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

beforeEach(async () => {
  resetBrainDecayThrottle();
  projectId = await seedBrainProject(ctx.db);
});

describe("runBrainDecaySweep (T3.3)", () => {
  it("expires active items past expires_at, keeps fresh + non-decayed items", async () => {
    const expiredItem = await insertItem({ expiresInDays: -1 });
    const freshItem = await insertItem({ expiresInDays: 1 });
    const stateFact = await insertItem({ expiresInDays: null }); // never decays

    const summary = await runBrainDecaySweep({ db: ctx.db, force: true });

    expect(summary.ran).toBe(true);
    expect(summary.expired).toBe(1);
    expect(await statusOf(expiredItem)).toBe("expired");
    expect(await statusOf(freshItem)).toBe("active");
    expect(await statusOf(stateFact)).toBe("active");
  });

  it("an expired item drops out of REAL recall (the ranker's own predicates, not a re-implemented count)", async () => {
    const client = fakeEmbeddingClient();

    await insertItem({
      expiresInDays: -1,
      content: "the decay lesson zzdecayzz appears here",
    });

    // Lexical match pre-sweep (the item has no embeddings — the lexical leg
    // carries it), gone post-sweep via the ranker's status/expiry predicates.
    const before = await recall(projectId, "zzdecayzz", {
      db: ctx.db,
      client,
      limit: 10,
    });

    // Already invisible pre-sweep: the ranker excludes past-expiry rows even
    // before the hourly sweep flips status.
    expect(before).toHaveLength(0);

    await runBrainDecaySweep({ db: ctx.db, force: true });

    const after = await recall(projectId, "zzdecayzz", {
      db: ctx.db,
      client,
      limit: 10,
    });

    expect(after).toHaveLength(0);
  });

  it("self-throttles: a second call within the hour is a no-op", async () => {
    await insertItem({ expiresInDays: -1 });

    const t = 1_000_000_000_000;
    const first = await runBrainDecaySweep({ db: ctx.db, nowMs: t });
    const second = await runBrainDecaySweep({ db: ctx.db, nowMs: t + 5_000 });

    expect(first.ran).toBe(true);
    expect(first.expired).toBe(1);
    expect(second.ran).toBe(false); // throttled
    expect(second.expired).toBe(0);
  });

  it("is idempotent — re-running (forced) never double-expires", async () => {
    const item = await insertItem({ expiresInDays: -1 });

    const first = await runBrainDecaySweep({ db: ctx.db, force: true });
    const again = await runBrainDecaySweep({ db: ctx.db, force: true });

    expect(first.expired).toBe(1);
    expect(again.expired).toBe(0); // already expired → excluded by WHERE status='active'
    expect(await statusOf(item)).toBe("expired");
  });

  it("is a QUIET no-op on Postgres without the brain lineage applied (upgrade forgot db:migrate:brain)", async () => {
    resetBrainSchemaProbe();
    // A db whose to_regclass probe reports the table missing — the sweep must
    // return ran:false with NO error (never a recurring 42P01 per tick).
    const unmigrated = {
      execute: async () => ({ rows: [{ t: null }] }),
    };

    const summary = await runBrainDecaySweep({ db: unmigrated, force: true });

    expect(summary).toEqual({
      ran: false,
      expired: 0,
      prunedSnapshots: 0,
      errors: [],
    });
    resetBrainSchemaProbe();
  });

  it("swallows a DB error into the summary (never throws)", async () => {
    const brokenDb = {
      execute: async () => {
        throw new Error("boom");
      },
    };

    const summary = await runBrainDecaySweep({
      db: brokenDb,
      force: true,
    });

    expect(summary.ran).toBe(true);
    expect(summary.expired).toBe(0);
    // Both sub-sweeps (expiry + snapshot prune) report their own failure.
    expect(summary.errors).toContain("boom");
  });

  it("prunes brain_snapshots older than snapshotTtlDays, keeps fresh ones", async () => {
    const oldId = randomUUID();
    const freshId = randomUUID();
    const insertSnap = (id: string, ageDays: number) =>
      ctx.db.execute(sql`
      INSERT INTO brain_snapshots (id, project_id, actor_type, actor_id, trigger,
        query, query_hash, embedding_model, returned_items, ranker_version, created_at)
      VALUES (${id}, ${projectId}, 'system', 'test', 'explicit', 'q', 'h', 'm', '[]'::jsonb, 'v',
              now() - ${sql.raw(String(ageDays))} * INTERVAL '1 day')
    `);

    await insertSnap(oldId, 40);
    await insertSnap(freshId, 5);

    const summary = await runBrainDecaySweep({ db: ctx.db, force: true });

    expect(summary.prunedSnapshots).toBe(1);

    const left = await ctx.db.execute(
      sql`SELECT id FROM brain_snapshots WHERE project_id = ${projectId}`,
    );

    expect(left.rows.map((r) => String(r.id))).toEqual([freshId]);
  });
});
