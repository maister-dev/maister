// ADR-152 T-C9a — the owner's view/edit/clear surface, against real Postgres.

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

import {
  agentMemoryPath,
  hashAgentMemory,
  writeAgentMemory,
} from "@/lib/agents/memory-store";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  addProjectMember,
  seedActiveUser,
} from "@/test-support/librarian-seed";
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

  const mod =
    await import("@/app/api/projects/[slug]/agents/[agentId]/memory/route");

  GET = mod.GET;
  PUT = mod.PUT;
  DELETE = mod.DELETE;
  ({ PATCH } =
    await import("@/app/api/projects/[slug]/agents/[agentId]/route"));
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
  await testDatabase.pool.query("DELETE FROM agent_memory_cutover");

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

it("AV-03/15 serves only the activated vault with live user rights and legacy index CAS", async () => {
  const notes = await import("../notes/route");
  const commands = await import("../commands/route");
  const history = await import("../revisions/route");
  const detail = await import("../revisions/[revisionId]/route");
  const url = `http://localhost/api/projects/${SLUG}/agents/${AGENT_ID}/memory`;
  const admin = await seedActiveUser(testDatabase.db, { role: "admin" });
  const member = await seedActiveUser(testDatabase.db);
  const viewer = await seedActiveUser(testDatabase.db);

  await addProjectMember(testDatabase.db, {
    projectId,
    userId: member,
    role: "member",
  });
  await addProjectMember(testDatabase.db, {
    projectId,
    userId: viewer,
    role: "viewer",
  });
  await testDatabase.pool.query(
    "UPDATE agent_project_links SET memory_enabled=true WHERE project_id=$1",
    [projectId],
  );
  authMocks.requireActiveSession.mockResolvedValue({ id: admin });
  const noteRead = new Request(`${url}/notes?path=/memories/index.md`);
  const blocked = await notes.GET(noteRead, routeParams);

  expect(blocked.status).toBe(409);
  await testDatabase.pool.query(
    "INSERT INTO agent_memory_cutover(generation) VALUES (1)",
  );
  const initial = await PUT(
    req("PUT", { content: "index first", ifHash: null }),
    routeParams,
  );

  expect(initial.status).toBe(200);
  const index = await initial.json();

  const create = () =>
    new Request(`${url}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "create",
        path: "/memories/notes/second.md",
        file_text: "outside index",
        requestKey: "create-extra",
        ifRevisionId: null,
        ifHash: null,
      }),
    });

  expect((await commands.POST(create(), routeParams)).status).toBe(200);
  authMocks.requireActiveSession.mockResolvedValue({ id: member });
  const current = await notes.GET(noteRead, routeParams);
  const note = await current.json();

  expect(current.headers.get("Cache-Control")).toBe("private, no-store");
  expect(note).toMatchObject({
    hash: index.hash,
    content: "index first",
    kind: "note",
  });
  expect((await commands.POST(create(), routeParams)).status).toBe(403);
  expect(
    await (
      await history.GET(
        new Request(`${url}/revisions?noteId=${note.noteId}`),
        routeParams,
      )
    ).json(),
  ).toMatchObject({
    items: [{ id: note.revisionId, state: "available" }],
    nextCursor: null,
  });
  expect(
    await (
      await detail.GET(new Request(`${url}/revisions/${note.revisionId}`), {
        params: Promise.resolve({
          slug: SLUG,
          agentId: AGENT_ID,
          revisionId: note.revisionId,
        }),
      })
    ).json(),
  ).toMatchObject({ content: "index first" });
  authMocks.requireActiveSession.mockResolvedValue({ id: viewer });
  expect((await notes.GET(noteRead, routeParams)).status).toBe(403);
  authMocks.requireActiveSession.mockResolvedValue({ id: admin });
  expect(
    (await DELETE(req("DELETE", { ifHash: index.hash }), routeParams)).status,
  ).toBe(204);
  expect((await notes.GET(noteRead, routeParams)).status).toBe(404);
  const other = await notes.GET(
    new Request(`${url}/notes?path=/memories/notes/second.md`),
    routeParams,
  );

  expect(await other.json()).toMatchObject({ content: "outside index" });
});

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

    expect(
      (
        await DELETE(
          req("DELETE", { ifHash: hashAgentMemory("gone soon") }),
          routeParams,
        )
      ).status,
    ).toBe(204);

    const afterFirst = await GET(req("GET"), routeParams);

    await expect(afterFirst.json()).resolves.toMatchObject({ hash: null });

    // Second clear on an already-absent file: ifHash null matches the absent
    // state, so idempotency survives the CAS.
    expect(
      (await DELETE(req("DELETE", { ifHash: null }), routeParams)).status,
    ).toBe(204);
  });

  it("D27 — DELETE with a STALE ifHash returns 409 and leaves the file intact", async () => {
    await writeAgentMemory(SLUG, AGENT_ID, "the agent just wrote this");

    // The operator loaded the drawer before that write landed.
    const res = await DELETE(
      req("DELETE", { ifHash: "deadbeef" }),
      routeParams,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "CONFLICT",
      current: { content: "the agent just wrote this" },
    });

    // The bytes survive — a blind unlink would have destroyed them.
    await expect(
      readFile(agentMemoryPath(SLUG, AGENT_ID), "utf8"),
    ).resolves.toBe("the agent just wrote this");
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

  it("D28 — GET requires readRepoFiles, so a member reads it but a viewer cannot", async () => {
    authMocks.requireProjectAction.mockImplementation(
      async (_projectId: string, action: string) => {
        if (action === "readRepoFiles") {
          throw new MaisterError("UNAUTHORIZED", "insufficient role");
        }
      },
    );

    expect((await GET(req("GET"), routeParams)).status).toBe(403);

    authMocks.requireProjectAction.mockImplementation(async () => {});

    expect((await GET(req("GET"), routeParams)).status).toBe(200);
  });

  it("REQ-C9 — PUT and DELETE require editSettings; a viewer is refused", async () => {
    // A real viewer clears NEITHER bar: editSettings (admin) nor readRepoFiles
    // (member). Modelling only editSettings would let the GET assertion below
    // pass for a role that cannot actually reach this route.
    authMocks.requireProjectAction.mockImplementation(
      async (_projectId: string, action: string) => {
        if (action === "editSettings" || action === "readRepoFiles") {
          throw new MaisterError("UNAUTHORIZED", "insufficient role");
        }
      },
    );

    expect(
      (await PUT(req("PUT", { content: "x", ifHash: null }), routeParams))
        .status,
    ).toBe(403);
    expect(
      (await DELETE(req("DELETE", { ifHash: null }), routeParams)).status,
    ).toBe(403);
    // ADR-152 D28: GET is readRepoFiles (member), NOT readBoard — the file can
    // hold repo-derived content the ADR-053 boundary keeps from viewers.
    expect((await GET(req("GET"), routeParams)).status).toBe(403);
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
