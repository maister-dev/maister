import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-140 (Task 17) — branch-sync project settings round-trip through the
// AGGREGATE settings PATCH (one transactional endpoint, per the house rule).
// Config-state symmetry: SET and CLEAR are BOTH asserted, plus an idempotent
// re-SET, so a half-implemented clear can never pass.

let db: NodePgDatabase;

vi.mock("@/lib/db/client", async (orig) => {
  const actual = await orig<typeof import("@/lib/db/client")>();

  return { ...actual, getDb: () => db };
});

vi.mock("@/lib/authz", async (orig) => {
  const actual = await orig<typeof import("@/lib/authz")>();

  return {
    ...actual,
    requireActiveSession: async () => ({
      id: "u1",
      role: "admin",
      accountStatus: "active",
      mustChangePassword: false,
    }),
    requireProjectAction: async () => ({ user: { id: "u1" }, role: "owner" }),
  };
});

const { PATCH } = await import("@/app/api/projects/[slug]/settings/route");

const schema = fullSchema as unknown as Record<string, any>;

let started: StartedPostgresTestDb;
let slug: string;
let projectId: string;
let runnerId: string;

async function patch(
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const res = await PATCH(
    new NextRequest(`http://t/api/projects/${slug}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );

  return { status: res.status, json: await res.json() };
}

async function projectRow(): Promise<{
  syncStrategyDefault: string;
  syncRunnerId: string | null;
}> {
  const rows = await db
    .select({
      syncStrategyDefault: schema.projects.syncStrategyDefault,
      syncRunnerId: schema.projects.syncRunnerId,
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));

  return rows[0];
}

beforeAll(async () => {
  started = await startMainPostgresTestDb({ databaseName: "maister_test" });
  db = started.db;

  projectId = randomUUID();
  runnerId = randomUUID();
  slug = `p-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "P",
    repoPath: `/repos/${projectId}`,
    mainBranch: "main",
    maisterYamlPath: "/tmp/m.yaml",
    taskKey: `T${projectId
      .replace(/[^0-9A-Za-z]/g, "")
      .slice(0, 7)
      .toUpperCase()}`,
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
}, 180_000);

afterAll(async () => {
  await started?.stop();
});

describe("project settings — branch-sync defaults (ADR-140)", () => {
  it("ships the migration default (rebase, no resolver override)", async () => {
    const row = await projectRow();

    expect(row.syncStrategyDefault).toBe("rebase");
    expect(row.syncRunnerId).toBeNull();
  });

  it("SET persists both the strategy and the resolver runner", async () => {
    const res = await patch({
      syncStrategyDefault: "merge",
      syncRunnerId: runnerId,
    });

    expect(res.status).toBe(200);
    expect(res.json.syncStrategyDefault).toBe("merge");
    expect(res.json.syncRunnerId).toBe(runnerId);

    const row = await projectRow();

    expect(row.syncStrategyDefault).toBe("merge");
    expect(row.syncRunnerId).toBe(runnerId);
  });

  it("re-SET with the same values is idempotent", async () => {
    const res = await patch({
      syncStrategyDefault: "merge",
      syncRunnerId: runnerId,
    });

    expect(res.status).toBe(200);

    const row = await projectRow();

    expect(row.syncStrategyDefault).toBe("merge");
    expect(row.syncRunnerId).toBe(runnerId);
  });

  it("CLEAR returns the strategy to the default and drops the resolver override", async () => {
    const res = await patch({
      syncStrategyDefault: "rebase",
      syncRunnerId: null,
    });

    expect(res.status).toBe(200);
    expect(res.json.syncRunnerId).toBeNull();

    const row = await projectRow();

    expect(row.syncStrategyDefault).toBe("rebase");
    expect(row.syncRunnerId).toBeNull();
  });

  it("refuses an unknown resolver runner (PRECONDITION → 409), leaving state untouched", async () => {
    const res = await patch({ syncRunnerId: randomUUID() });

    expect(res.status).toBe(409);
    expect(res.json.code).toBe("PRECONDITION");

    const row = await projectRow();

    expect(row.syncRunnerId).toBeNull();
  });

  it("refuses an invalid strategy at the schema boundary (CONFIG → 422)", async () => {
    const res = await patch({ syncStrategyDefault: "squash" });

    expect(res.status).toBe(422);
    expect(res.json.code).toBe("CONFIG");
  });

  it("sets the strategy alone without touching the resolver override", async () => {
    await patch({ syncRunnerId: runnerId });
    const res = await patch({ syncStrategyDefault: "merge" });

    expect(res.status).toBe(200);

    const row = await projectRow();

    expect(row.syncStrategyDefault).toBe("merge");
    // The untouched field survives a partial PATCH (aggregate-endpoint rule).
    expect(row.syncRunnerId).toBe(runnerId);
  });
});
