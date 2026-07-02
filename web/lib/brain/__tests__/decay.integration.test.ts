import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  type BrainTestDb,
} from "./helpers";

import { resetBrainDecayThrottle, runBrainDecaySweep } from "@/lib/brain/decay";

// T3.3 — the throttled decay sweep (real pgvector). Only touches brain_items;
// no embeddings needed.

let ctx: BrainTestDb;
let projectId: string;

async function insertItem(over: {
  status?: string;
  expiresInDays?: number | null;
  confidence?: number;
}): Promise<string> {
  const id = randomUUID();
  const expires =
    over.expiresInDays === null || over.expiresInDays === undefined
      ? sql`NULL`
      : sql`now() + ${sql.raw(String(over.expiresInDays))} * INTERVAL '1 day'`;

  await ctx.db.execute(sql`
    INSERT INTO brain_items (id, project_id, kind, title, content, status, confidence, content_hash, expires_at)
    VALUES (${id}, ${projectId}, 'lesson', 't', 'c', ${over.status ?? "active"},
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

  it("an expired item is excluded from an active-only query (absent from recall)", async () => {
    await insertItem({ expiresInDays: -1 });
    await runBrainDecaySweep({ db: ctx.db, force: true });

    const active = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM brain_items WHERE project_id = ${projectId} AND status = 'active'`,
    );

    expect(Number(active.rows[0]?.n)).toBe(0);
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
    expect(summary.errors).toEqual(["boom"]);
  });
});
