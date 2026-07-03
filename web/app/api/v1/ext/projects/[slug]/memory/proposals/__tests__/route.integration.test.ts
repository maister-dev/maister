import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  type BrainTestDb,
} from "@/lib/brain/__tests__/helpers";
import { issueToken } from "@/lib/tokens/issue";

let ctx: BrainTestDb;
let dbRef: NodePgDatabase;

vi.mock("@/lib/db/client", async (orig) => {
  const actual = await orig<typeof import("@/lib/db/client")>();

  return { ...actual, getDb: () => dbRef };
});

let POST: typeof import("@/app/api/v1/ext/projects/[slug]/memory/proposals/route").POST;

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
  const agentId = `pkg:proposal-${randomUUID().slice(0, 8)}`;

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
    { projectId, name: "agent-proposals", scopes: ["memory:read", "memory:write"] },
    dbRef,
  );

  await dbRef.execute(sql`
    UPDATE project_tokens SET token_kind = 'agent', agent_id = ${agentId} WHERE id = ${t.tokenId}
  `);

  return t.secret;
}

function postReq(slug: string, body: unknown, secret: string): NextRequest {
  const req = new NextRequest(
    `http://localhost/api/v1/ext/projects/${slug}/memory/proposals`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );

  req.headers.set("authorization", `Bearer ${secret}`);

  return req;
}

async function proposalCount(projectId: string): Promise<number> {
  const rows = await dbRef.execute(sql`
    SELECT count(*)::int AS n FROM brain_proposals WHERE project_id = ${projectId}
  `);

  return Number(rows.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  ctx = await startBrainTestDb();
  dbRef = ctx.db;

  const mod = await import("@/app/api/v1/ext/projects/[slug]/memory/proposals/route");

  POST = mod.POST;
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

describe("ext memory proposals route (T10.1)", () => {
  it("creates pending proposals and returns duplicate clusterHash as idempotent", async () => {
    const projectId = await seedBrainProject(dbRef);
    const slug = await slugOf(projectId);
    const token = await issueToken(
      { projectId, name: "proposal-writer", scopes: ["memory:write"] },
      dbRef,
    );
    const body = {
      kind: "rule",
      evidenceItemIds: ["e1", "e2", "e3"],
      draft: { title: "Rule draft" },
      blastRadius: "low",
      clusterHash: "cluster-rule-duplicate",
      rationale: "Recurring evidence",
    };

    const created = await POST(postReq(slug, body, token.secret), {
      params: Promise.resolve({ slug }),
    });
    const createdBody = await created.json();
    const duplicate = await POST(postReq(slug, body, token.secret), {
      params: Promise.resolve({ slug }),
    });
    const duplicateBody = await duplicate.json();

    expect(created.status).toBe(201);
    expect(duplicate.status).toBe(200);
    expect(duplicateBody).toEqual({
      proposalId: createdBody.proposalId,
      status: "pending",
      idempotent: true,
    });
    expect(await proposalCount(projectId)).toBe(1);
  });

  it("does not merge duplicate proposals when clusterHash is omitted", async () => {
    const projectId = await seedBrainProject(dbRef);
    const slug = await slugOf(projectId);
    const token = await issueToken(
      { projectId, name: "proposal-no-hash", scopes: ["memory:write"] },
      dbRef,
    );
    const body = {
      kind: "state",
      draft: { title: "State projection" },
      blastRadius: "medium",
    };

    const first = await POST(postReq(slug, body, token.secret), {
      params: Promise.resolve({ slug }),
    });
    const second = await POST(postReq(slug, body, token.secret), {
      params: Promise.resolve({ slug }),
    });
    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(secondBody.proposalId).not.toBe(firstBody.proposalId);
    expect(await proposalCount(projectId)).toBe(2);
  });

  it("rejects invalid kinds and fails closed on missing write scope, agent axis, disabled Brain, and SQLite", async () => {
    const projectId = await seedBrainProject(dbRef);
    const slug = await slugOf(projectId);
    const writer = await issueToken(
      { projectId, name: "proposal-writer-kind", scopes: ["memory:write"] },
      dbRef,
    );
    const invalidKind = await POST(
      postReq(slug, { kind: "plugin", draft: {} }, writer.secret),
      { params: Promise.resolve({ slug }) },
    );

    expect(invalidKind.status).toBe(422);

    const readOnly = await issueToken(
      { projectId, name: "proposal-reader", scopes: ["memory:read"] },
      dbRef,
    );

    expect(
      (
        await POST(
          postReq(slug, { kind: "rule", draft: {} }, readOnly.secret),
          { params: Promise.resolve({ slug }) },
        )
      ).status,
    ).toBe(403);

    const agentId = await seedAgentLink(projectId, {
      canReadBrain: true,
      canWriteBrain: false,
    });
    const agentSecret = await agentToken(projectId, agentId);

    expect(
      (
        await POST(
          postReq(slug, { kind: "rule", draft: {} }, agentSecret),
          { params: Promise.resolve({ slug }) },
        )
      ).status,
    ).toBe(403);

    const disabledProject = await seedBrainProject(dbRef, { brainEnabled: false });
    const disabledSlug = await slugOf(disabledProject);
    const disabledToken = await issueToken(
      { projectId: disabledProject, name: "disabled", scopes: ["memory:write"] },
      dbRef,
    );

    expect(
      (
        await POST(
          postReq(disabledSlug, { kind: "rule", draft: {} }, disabledToken.secret),
          { params: Promise.resolve({ slug: disabledSlug }) },
        )
      ).status,
    ).toBe(422);

    const prev = process.env.DB_URL;

    process.env.DB_URL = "file:./sqlite-mode.db";

    try {
      expect(
        (
          await POST(
            postReq(slug, { kind: "rule", draft: {} }, writer.secret),
            { params: Promise.resolve({ slug }) },
          )
        ).status,
      ).toBe(409);
    } finally {
      process.env.DB_URL = prev;
    }
  });
});
