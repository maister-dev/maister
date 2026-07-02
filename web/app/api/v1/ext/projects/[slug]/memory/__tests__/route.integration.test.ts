import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { OpenAiCompatibleClient } from "@/lib/brain/openai-compatible";

import { randomUUID } from "node:crypto";

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

import { retain } from "@/lib/brain/retain";
import {
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  TEST_EMBEDDING_DIMENSIONS,
  TEST_EMBEDDING_MODEL,
  type BrainTestDb,
} from "@/lib/brain/__tests__/helpers";
import { MaisterError } from "@/lib/errors";
import { issueToken } from "@/lib/tokens/issue";

// T4.2 — the ext memory routes (real pgvector). getDb + getBrainEmbeddingClient
// are mocked so the route runs against the test container with no network.

let ctx: BrainTestDb;
let dbRef: NodePgDatabase;
let fakeClient: OpenAiCompatibleClient;
const DIMS = TEST_EMBEDDING_DIMENSIONS;

vi.mock("@/lib/db/client", async (orig) => {
  const actual = await orig<typeof import("@/lib/db/client")>();

  return { ...actual, getDb: () => dbRef };
});

vi.mock("@/lib/brain/openai-compatible", async (orig) => {
  const actual = await orig<typeof import("@/lib/brain/openai-compatible")>();

  return { ...actual, getBrainEmbeddingClient: async () => fakeClient };
});

let GET: typeof import("@/app/api/v1/ext/projects/[slug]/memory/route").GET;
let POST: typeof import("@/app/api/v1/ext/projects/[slug]/memory/route").POST;

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
      return "";
    },
    ...over,
  };
}

async function seedAgentLink(
  projectId: string,
  axes: { canReadBrain: boolean; canWriteBrain: boolean },
): Promise<string> {
  const agentId = `pkg:agent-${randomUUID().slice(0, 8)}`;

  await dbRef.execute(sql`
    INSERT INTO agents (id, package_name, version_label, origin, name, description,
                        workspace, mode, triggers, risk_tier, source_path)
    VALUES (${agentId}, 'pkg', 'v1', 'git', ${agentId}, 'd', 'none', 'session',
            '["manual"]'::jsonb, 'read_only', '/tmp/a.md')
  `);
  await dbRef.execute(sql`
    INSERT INTO agent_project_links (id, agent_id, project_id, can_read_brain, can_write_brain)
    VALUES (${randomUUID()}, ${agentId}, ${projectId}, ${axes.canReadBrain}, ${axes.canWriteBrain})
  `);

  return agentId;
}

// Mint a project token, then promote it to an agent token bound to `agentId`.
async function agentToken(projectId: string, agentId: string): Promise<string> {
  const t = await issueToken(
    { projectId, name: "agent-tok", scopes: ["memory:read", "memory:write"] },
    dbRef,
  );

  await dbRef.execute(sql`
    UPDATE project_tokens SET token_kind = 'agent', agent_id = ${agentId} WHERE id = ${t.tokenId}
  `);

  return t.secret;
}

function getReq(slug: string, qs: string, secret: string): NextRequest {
  const req = new NextRequest(
    `http://localhost/api/v1/ext/projects/${slug}/memory?${qs}`,
    { method: "GET" },
  );

  req.headers.set("authorization", `Bearer ${secret}`);

  return req;
}

function postReq(slug: string, body: unknown, secret: string): NextRequest {
  const req = new NextRequest(
    `http://localhost/api/v1/ext/projects/${slug}/memory`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );

  req.headers.set("authorization", `Bearer ${secret}`);

  return req;
}

beforeAll(async () => {
  ctx = await startBrainTestDb();
  dbRef = ctx.db;

  const mod = await import("@/app/api/v1/ext/projects/[slug]/memory/route");

  GET = mod.GET;
  POST = mod.POST;
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

beforeEach(() => {
  fakeClient = makeClient();
});

describe("ext memory routes (T4.2)", () => {
  it("recall returns items and writes an explicit brain_snapshots row", async () => {
    const projectId = await seedBrainProject(dbRef);
    const slugRow = await dbRef.execute(
      sql`SELECT slug FROM projects WHERE id = ${projectId}`,
    );
    const slug = String(slugRow.rows[0]?.slug);

    await retain(
      projectId,
      { kind: "lesson", content: "always migrate before seeding" },
      {},
      { db: dbRef, client: fakeClient },
    );

    const token = await issueToken(
      { projectId, name: "reader", scopes: ["memory:read"] },
      dbRef,
    );

    const res = await GET(getReq(slug, "q=migrate", token.secret), {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items.length).toBeGreaterThanOrEqual(1);

    const snap = await dbRef.execute(
      sql`SELECT trigger, run_id, actor_type FROM brain_snapshots WHERE project_id = ${projectId}`,
    );

    expect(snap.rows).toHaveLength(1);
    expect(snap.rows[0]?.trigger).toBe("explicit");
    expect(snap.rows[0]?.run_id).toBeNull();
    expect(snap.rows[0]?.actor_type).toBe("system");
  });

  it("retain writes an item", async () => {
    const projectId = await seedBrainProject(dbRef);
    const slug = String(
      (
        await dbRef.execute(
          sql`SELECT slug FROM projects WHERE id = ${projectId}`,
        )
      ).rows[0]?.slug,
    );
    const token = await issueToken(
      { projectId, name: "writer", scopes: ["memory:write"] },
      dbRef,
    );

    const res = await POST(
      postReq(
        slug,
        { content: "a retained fact", kind: "state_fact" },
        token.secret,
      ),
      { params: Promise.resolve({ slug }) },
    );

    expect(res.status).toBe(200);
    const count = await dbRef.execute(
      sql`SELECT count(*)::int AS n FROM brain_items WHERE project_id = ${projectId}`,
    );

    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it("cross-project token → 404 (body carries no project id)", async () => {
    const projectA = await seedBrainProject(dbRef);
    const projectB = await seedBrainProject(dbRef);
    const slugB = String(
      (
        await dbRef.execute(
          sql`SELECT slug FROM projects WHERE id = ${projectB}`,
        )
      ).rows[0]?.slug,
    );
    const tokenA = await issueToken(
      { projectId: projectA, name: "a", scopes: ["memory:read"] },
      dbRef,
    );

    const res = await GET(getReq(slugB, "q=x", tokenA.secret), {
      params: Promise.resolve({ slug: slugB }),
    });

    expect(res.status).toBe(404);
  });

  it("missing scope → 403", async () => {
    const projectId = await seedBrainProject(dbRef);
    const slug = String(
      (
        await dbRef.execute(
          sql`SELECT slug FROM projects WHERE id = ${projectId}`,
        )
      ).rows[0]?.slug,
    );
    const token = await issueToken(
      { projectId, name: "noscope", scopes: ["tasks:read"] },
      dbRef,
    );

    const res = await GET(getReq(slug, "q=x", token.secret), {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(403);
  });

  it("agent token without can_read_brain → recall 403; read grant does NOT open write", async () => {
    const projectId = await seedBrainProject(dbRef);
    const slug = String(
      (
        await dbRef.execute(
          sql`SELECT slug FROM projects WHERE id = ${projectId}`,
        )
      ).rows[0]?.slug,
    );
    // can read, cannot write
    const agentId = await seedAgentLink(projectId, {
      canReadBrain: true,
      canWriteBrain: false,
    });
    const secret = await agentToken(projectId, agentId);

    const readRes = await GET(getReq(slug, "q=x", secret), {
      params: Promise.resolve({ slug }),
    });

    expect(readRes.status).toBe(200); // can_read_brain=true

    const writeRes = await POST(
      postReq(slug, { content: "nope", kind: "lesson" }, secret),
      { params: Promise.resolve({ slug }) },
    );

    expect(writeRes.status).toBe(403); // can_write_brain=false — read never grants write
  });

  it("agent token with can_read_brain=false → recall 403", async () => {
    const projectId = await seedBrainProject(dbRef);
    const slug = String(
      (
        await dbRef.execute(
          sql`SELECT slug FROM projects WHERE id = ${projectId}`,
        )
      ).rows[0]?.slug,
    );
    const agentId = await seedAgentLink(projectId, {
      canReadBrain: false,
      canWriteBrain: false,
    });
    const secret = await agentToken(projectId, agentId);

    const res = await GET(getReq(slug, "q=x", secret), {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(403);
  });

  it("embedding outage during retain → 503", async () => {
    const projectId = await seedBrainProject(dbRef);
    const slug = String(
      (
        await dbRef.execute(
          sql`SELECT slug FROM projects WHERE id = ${projectId}`,
        )
      ).rows[0]?.slug,
    );
    const token = await issueToken(
      { projectId, name: "w", scopes: ["memory:write"] },
      dbRef,
    );

    fakeClient = makeClient({
      async embed(): Promise<number[][]> {
        throw new MaisterError("EMBEDDING_UNAVAILABLE", "down");
      },
    });

    const res = await POST(
      postReq(slug, { content: "x", kind: "lesson" }, token.secret),
      { params: Promise.resolve({ slug }) },
    );

    expect(res.status).toBe(503);
  });

  it("recall on a Brain-disabled project → 422 CONFIG", async () => {
    const projectId = await seedBrainProject(dbRef, { brainEnabled: false });
    const slug = String(
      (
        await dbRef.execute(
          sql`SELECT slug FROM projects WHERE id = ${projectId}`,
        )
      ).rows[0]?.slug,
    );
    const token = await issueToken(
      { projectId, name: "r", scopes: ["memory:read"] },
      dbRef,
    );

    const res = await GET(getReq(slug, "q=x", token.secret), {
      params: Promise.resolve({ slug }),
    });

    expect(res.status).toBe(422);
  });

  it("SQLite dialect → fails closed with PRECONDITION (409)", async () => {
    const projectId = await seedBrainProject(dbRef);
    const slug = String(
      (
        await dbRef.execute(
          sql`SELECT slug FROM projects WHERE id = ${projectId}`,
        )
      ).rows[0]?.slug,
    );
    const token = await issueToken(
      { projectId, name: "r", scopes: ["memory:read"] },
      dbRef,
    );

    const prev = process.env.DB_URL;

    process.env.DB_URL = "file:./sqlite-mode.db";

    try {
      const res = await GET(getReq(slug, "q=x", token.secret), {
        params: Promise.resolve({ slug }),
      });

      expect(res.status).toBe(409);
    } finally {
      process.env.DB_URL = prev;
    }
  });
});
