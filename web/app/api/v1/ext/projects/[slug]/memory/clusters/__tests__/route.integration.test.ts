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
import { issueToken } from "@/lib/tokens/issue";

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

let GET: typeof import("@/app/api/v1/ext/projects/[slug]/memory/clusters/route").GET;

function nearVector(text: string): number[] {
  const v = new Array(DIMS).fill(0);

  v[0] = 1;
  v[1] = text.length * 0.0001;

  return v;
}

function makeClient(): OpenAiCompatibleClient {
  return {
    provider: "openai_compatible",
    model: TEST_EMBEDDING_MODEL,
    dimensions: DIMS,
    version: `${TEST_EMBEDDING_MODEL}@${DIMS}`,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(nearVector);
    },
    async complete(): Promise<string> {
      return "";
    },
  };
}

async function slugOf(projectId: string): Promise<string> {
  const rows = await dbRef.execute(
    sql`SELECT slug FROM projects WHERE id = ${projectId}`,
  );

  return String(rows.rows[0]?.slug);
}

async function seedAgentLink(
  projectId: string,
  axes: { canReadBrain: boolean; canWriteBrain: boolean },
): Promise<string> {
  const agentId = `pkg:cluster-${randomUUID().slice(0, 8)}`;

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

async function agentToken(projectId: string, agentId: string): Promise<string> {
  const t = await issueToken(
    { projectId, name: "agent-clusters", scopes: ["memory:read", "memory:write"] },
    dbRef,
  );

  await dbRef.execute(sql`
    UPDATE project_tokens SET token_kind = 'agent', agent_id = ${agentId} WHERE id = ${t.tokenId}
  `);

  return t.secret;
}

function getReq(slug: string, qs: string, secret: string): NextRequest {
  const req = new NextRequest(
    `http://localhost/api/v1/ext/projects/${slug}/memory/clusters?${qs}`,
    { method: "GET" },
  );

  req.headers.set("authorization", `Bearer ${secret}`);

  return req;
}

beforeAll(async () => {
  ctx = await startBrainTestDb();
  dbRef = ctx.db;

  const mod = await import("@/app/api/v1/ext/projects/[slug]/memory/clusters/route");

  GET = mod.GET;
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

beforeEach(() => {
  fakeClient = makeClient();
});

describe("ext memory clusters route (T10.1)", () => {
  it("returns recurring evidence clusters computed server-side", async () => {
    const projectId = await seedBrainProject(dbRef);
    const slug = await slugOf(projectId);

    for (const content of [
      "SIM: command check keeps failing on lint",
      "SIM: lint command fails after generated files",
      "SIM: recurring lint failure in generated files",
    ]) {
      await retain(
        projectId,
        { kind: "lesson", content },
        { sourceGateKind: "command_check" },
        { db: dbRef, client: fakeClient },
      );
    }

    const token = await issueToken(
      { projectId, name: "cluster-reader", scopes: ["memory:read"] },
      dbRef,
    );
    const res = await GET(
      getReq(slug, "kinds=lesson&minRecurrence=3", token.secret),
      { params: Promise.resolve({ slug }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.clusters).toEqual([
      expect.objectContaining({
        kind: "lesson",
        recurrence: 3,
        evidenceItemIds: expect.arrayContaining([
          expect.any(String),
          expect.any(String),
          expect.any(String),
        ]),
        provenance: expect.objectContaining({ gateKind: "command_check" }),
      }),
    ]);
  });

  it("fails closed on missing read scope, missing agent axis, disabled Brain, and SQLite", async () => {
    const projectId = await seedBrainProject(dbRef);
    const slug = await slugOf(projectId);
    const writeOnly = await issueToken(
      { projectId, name: "write-only", scopes: ["memory:write"] },
      dbRef,
    );

    expect(
      (
        await GET(getReq(slug, "q=x", writeOnly.secret), {
          params: Promise.resolve({ slug }),
        })
      ).status,
    ).toBe(403);

    const agentId = await seedAgentLink(projectId, {
      canReadBrain: false,
      canWriteBrain: true,
    });
    const agentSecret = await agentToken(projectId, agentId);

    expect(
      (
        await GET(getReq(slug, "", agentSecret), {
          params: Promise.resolve({ slug }),
        })
      ).status,
    ).toBe(403);

    const disabledProject = await seedBrainProject(dbRef, { brainEnabled: false });
    const disabledSlug = await slugOf(disabledProject);
    const disabledToken = await issueToken(
      { projectId: disabledProject, name: "disabled", scopes: ["memory:read"] },
      dbRef,
    );

    expect(
      (
        await GET(getReq(disabledSlug, "", disabledToken.secret), {
          params: Promise.resolve({ slug: disabledSlug }),
        })
      ).status,
    ).toBe(422);

    const prev = process.env.DB_URL;

    process.env.DB_URL = "file:./sqlite-mode.db";

    try {
      expect(
        (
          await GET(getReq(slug, "", agentSecret), {
            params: Promise.resolve({ slug }),
          })
        ).status,
      ).toBe(409);
    } finally {
      process.env.DB_URL = prev;
    }
  });
});
