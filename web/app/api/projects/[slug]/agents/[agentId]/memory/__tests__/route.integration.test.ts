// ADR-152 T-C9a — the owner's view/edit/clear surface, against real Postgres.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

const runtimeRootMock = vi.hoisted(() => ({ value: "/tmp/unset" }));
const authMocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
}));

vi.mock("@/lib/runtime-root", () => ({
  runtimeRoot: () => runtimeRootMock.value,
}));

vi.mock("@/lib/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authz")>();

  return {
    ...actual,
    requireActiveSession: authMocks.requireActiveSession,
    requireProjectAction: authMocks.requireProjectAction,
  };
});

let testDatabase: import("@/test-support/pg-container").StartedPostgresTestDb;

vi.mock("@/lib/db/client", () => ({ getDb: () => testDatabase.db }));

import { hashAgentMemory, writeAgentMemory } from "@/lib/agents/memory-store";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

// FIXME(any): dual drizzle-orm peer-dep variants.
const schema = schemaModule as unknown as Record<string, any>;

const AGENT_ID = "mem-pkg:keeper";
const SLUG = "owner-mem";

let GET: typeof import("@/app/api/projects/[slug]/agents/[agentId]/memory/route").GET;
let PUT: typeof import("@/app/api/projects/[slug]/agents/[agentId]/memory/route").PUT;
let DELETE: typeof import("@/app/api/projects/[slug]/agents/[agentId]/memory/route").DELETE;
let PATCH: typeof import("@/app/api/projects/[slug]/agents/[agentId]/route").PATCH;
let root: string;
let projectId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "owner_agent_memory_test",
  });

  const mod = await import(
    "@/app/api/projects/[slug]/agents/[agentId]/memory/route"
  );

  GET = mod.GET;
  PUT = mod.PUT;
  DELETE = mod.DELETE;
  ({ PATCH } = await import(
    "@/app/api/projects/[slug]/agents/[agentId]/route"
  ));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
  await rm(root, { force: true, recursive: true });
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "maister-ownermem-"));
  runtimeRootMock.value = root;
  authMocks.requireActiveSession.mockReset();
  authMocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  authMocks.requireProjectAction.mockReset();
  authMocks.requireProjectAction.mockResolvedValue(undefined);

  await testDatabase.db.delete(schema.agentProjectLinks);
  await testDatabase.db.delete(schema.agents);
  await testDatabase.db.delete(schema.projects);

  projectId = randomUUID();
  await testDatabase.db.insert(schema.projects).values({
    id: projectId,
    slug: SLUG,
    name: "Owner memory",
    repoPath: `/tmp/${SLUG}`,
    maisterYamlPath: "/tmp/maister.yaml",
    taskKey: "OWNM",
  });
  await testDatabase.db.insert(schema.agents).values({
    id: AGENT_ID,
    packageName: "mem-pkg",
    versionLabel: "v1.0.0",
    origin: "git",
    name: "Keeper",
    description: "d",
    workspace: "none",
    mode: "session",
    triggers: ["manual"],
    riskTier: "read_only",
    sourcePath: "/tmp/keeper.md",
  });
  await testDatabase.db.insert(schema.agentProjectLinks).values({
    id: randomUUID(),
    agentId: AGENT_ID,
    projectId,
    enabled: true,
    memoryEnabled: false,
  });
});

const routeParams = {
  params: Promise.resolve({ slug: SLUG, agentId: AGENT_ID }),
};

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/projects/${SLUG}/agents/${AGENT_ID}/memory`,
    body === undefined ? { method } : { method, body: JSON.stringify(body) },
  );
}

describe("T-C9a / REQ-C9 — the owner memory surface", () => {
  it("GET reports an absent file as the first-writer state with the resolved cap", async () => {
    const res = await GET(req("GET"), routeParams);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      content: "",
      hash: null,
      sizeChars: 0,
      maxChars: 32_768,
      updatedAt: null,
    });
  });

  it("REQ-C9 AC1 — PUT with a stale ifHash returns 409 carrying the CURRENT content", async () => {
    await writeAgentMemory(SLUG, AGENT_ID, "agent wrote this");

    const res = await PUT(
      req("PUT", { content: "human clobber", ifHash: "stale" }),
      routeParams,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "CONFLICT",
      current: {
        content: "agent wrote this",
        hash: hashAgentMemory("agent wrote this"),
      },
    });
  });

  it("REQ-C9 AC1 — PUT with the current hash succeeds and returns the POST-write state", async () => {
    await writeAgentMemory(SLUG, AGENT_ID, "before");

    const res = await PUT(
      req("PUT", { content: "after", ifHash: hashAgentMemory("before") }),
      routeParams,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      content: "after",
      hash: hashAgentMemory("after"),
      sizeChars: 5,
    });
  });

  it("REQ-C9 AC2 — DELETE clears the file and is IDEMPOTENT when already absent", async () => {
    await writeAgentMemory(SLUG, AGENT_ID, "gone soon");

    expect((await DELETE(req("DELETE"), routeParams)).status).toBe(204);

    const afterFirst = await GET(req("GET"), routeParams);

    await expect(afterFirst.json()).resolves.toMatchObject({ hash: null });

    // Second clear on an already-absent file must still succeed.
    expect((await DELETE(req("DELETE"), routeParams)).status).toBe(204);
  });

  it("REQ-C9 AC3 — memoryEnabled flows through the EXISTING aggregating PATCH, not a per-field route", async () => {
    const patchRes = await PATCH(
      new NextRequest(
        `http://localhost/api/projects/${SLUG}/agents/${AGENT_ID}`,
        { method: "PATCH", body: JSON.stringify({ memoryEnabled: true }) },
      ),
      routeParams,
    );

    expect(patchRes.status).toBe(200);

    const rows = await testDatabase.db
      .select({ memoryEnabled: schema.agentProjectLinks.memoryEnabled })
      .from(schema.agentProjectLinks);

    expect(rows[0]?.memoryEnabled).toBe(true);
  });

  it("REQ-C9 — PUT and DELETE require editSettings; a viewer is refused", async () => {
    authMocks.requireProjectAction.mockImplementation(
      async (_projectId: string, action: string) => {
        if (action === "editSettings") {
          throw new MaisterError("UNAUTHORIZED", "insufficient role");
        }
      },
    );

    expect(
      (await PUT(req("PUT", { content: "x", ifHash: null }), routeParams))
        .status,
    ).toBe(403);
    expect((await DELETE(req("DELETE"), routeParams)).status).toBe(403);
    // GET clears only the readBoard bar, so a viewer still sees it.
    expect((await GET(req("GET"), routeParams)).status).toBe(200);
  });

  it("404 — memory for an agent this project has not attached does not exist here", async () => {
    await testDatabase.db.delete(schema.agentProjectLinks);

    expect((await GET(req("GET"), routeParams)).status).toBe(404);
  });

  it("422 CONFIG — over-cap content is refused", async () => {
    process.env.MAISTER_AGENT_MEMORY_MAX_CHARS = "8";

    try {
      const res = await PUT(
        req("PUT", { content: "x".repeat(9), ifHash: null }),
        routeParams,
      );

      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toMatchObject({ code: "CONFIG" });
    } finally {
      delete process.env.MAISTER_AGENT_MEMORY_MAX_CHARS;
    }
  });
});
