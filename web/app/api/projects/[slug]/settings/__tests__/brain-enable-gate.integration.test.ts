import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { updateBrainSettings } from "@/lib/brain/settings";
import {
  seedBrainProject,
  seedPlatformSettings,
  startBrainTestDb,
  stopBrainTestDb,
  type BrainTestDb,
} from "@/lib/brain/__tests__/helpers";

// T5.2 — the project settings enable-gate. auth + getDb are mocked; the gate
// (getBrainSettings + isBrainFullyConfigured) runs against the real container.

let ctx: BrainTestDb;
let dbRef: NodePgDatabase;

vi.mock("@/lib/db/client", async (orig) => {
  const actual = await orig<typeof import("@/lib/db/client")>();

  return { ...actual, getDb: () => dbRef };
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

let PATCH: typeof import("@/app/api/projects/[slug]/settings/route").PATCH;

async function fullyConfigure(): Promise<void> {
  await updateBrainSettings(
    {
      embeddingBaseUrl: "https://api.test/v1",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      distillModel: "distiller",
    },
    dbRef,
  );
}

async function slugOf(projectId: string): Promise<string> {
  const r = await dbRef.execute(
    sql`SELECT slug FROM projects WHERE id = ${projectId}`,
  );

  return String(r.rows[0]?.slug);
}

async function brainEnabledOf(projectId: string): Promise<boolean> {
  const r = await dbRef.execute(
    sql`SELECT brain_enabled FROM projects WHERE id = ${projectId}`,
  );

  return Boolean(r.rows[0]?.brain_enabled);
}

function patchReq(slug: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/projects/${slug}/settings`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  ctx = await startBrainTestDb();
  dbRef = ctx.db;

  const mod = await import("@/app/api/projects/[slug]/settings/route");

  PATCH = mod.PATCH;
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

beforeEach(async () => {
  await seedPlatformSettings(ctx.db);
  await ctx.db.execute(sql`
    UPDATE platform_runtime_settings
    SET embedding_base_url = NULL, embedding_model = NULL, embedding_dimensions = NULL,
        embedding_api_key_ref = NULL, distill_model = NULL
    WHERE id = 'singleton'
  `);
});

describe("project settings brain enable-gate (T5.2)", () => {
  it("enables the Brain when platform config is complete", async () => {
    await fullyConfigure();
    const projectId = await seedBrainProject(ctx.db, { brainEnabled: false });
    const slug = await slugOf(projectId);

    const res = await PATCH(patchReq(slug, { brainEnabled: true }), {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(200);
    expect(await brainEnabledOf(projectId)).toBe(true);
  });

  it("refuses to enable (422 CONFIG) when the distill model is unset, and does NOT persist", async () => {
    // embedding set but distill unset
    await updateBrainSettings(
      {
        embeddingBaseUrl: "https://api.test/v1",
        embeddingModel: "m",
        embeddingDimensions: 1536,
        distillModel: null,
      },
      dbRef,
    );
    const projectId = await seedBrainProject(ctx.db, { brainEnabled: false });
    const slug = await slugOf(projectId);

    const res = await PATCH(patchReq(slug, { brainEnabled: true }), {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();

    expect(body.code).toBe("CONFIG");
    expect(await brainEnabledOf(projectId)).toBe(false); // not persisted
  });

  it("disabling never hits the gate", async () => {
    // no platform config at all
    const projectId = await seedBrainProject(ctx.db, { brainEnabled: true });
    const slug = await slugOf(projectId);

    const res = await PATCH(patchReq(slug, { brainEnabled: false }), {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(200);
    expect(await brainEnabledOf(projectId)).toBe(false);
  });
});
