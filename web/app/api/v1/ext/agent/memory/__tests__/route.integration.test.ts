// ADR-152 T-C7a / T-C8a — the agent-facing CAS write path against real
// Postgres and a real temp runtime root.

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
const routeMocks = vi.hoisted(() => ({ verifyToken: vi.fn() }));

vi.mock("@/lib/runtime-root", () => ({
  runtimeRoot: () => runtimeRootMock.value,
}));

vi.mock("@/lib/tokens/verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tokens/verify")>();

  return { ...actual, verifyToken: routeMocks.verifyToken };
});

vi.mock("@/lib/tokens/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tokens/audit")>();

  return {
    ...actual,
    recordTokenAudit: vi.fn(async () => {}),
    bumpTokenLastUsed: vi.fn(async () => {}),
  };
});

let testDatabase: import("@/test-support/pg-container").StartedPostgresTestDb;

vi.mock("@/lib/db/client", () => ({ getDb: () => testDatabase.db }));

import { agentMemoryPath, hashAgentMemory } from "@/lib/agents/memory-store";
import {
  issueAgentRunToken,
  issueProjectVaultNodeToken,
} from "@/lib/agents/tokens";
import { stageProjectFlowMemory } from "@/lib/agent-memory-vault/injection";
import * as schemaModule from "@/lib/db/schema";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { seedRun } from "@/test-support/execution-host-seed";

// FIXME(any): dual drizzle-orm peer-dep variants.
const schema = schemaModule as unknown as Record<string, any>;

const AGENT_ID = "mem-pkg:keeper";
const SLUG = "ext-mem";

let GET: typeof import("@/app/api/v1/ext/agent/memory/route").GET;
let POST: typeof import("@/app/api/v1/ext/agent/memory/route").POST;
let root: string;
let projectId: string;
let runId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_agent_memory_test",
  });

  const mod = await import("@/app/api/v1/ext/agent/memory/route");

  GET = mod.GET;
  POST = mod.POST;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
  await rm(root, { force: true, recursive: true });
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "maister-extmem-"));
  runtimeRootMock.value = root;
  delete process.env.MAISTER_AGENT_MEMORY_MAX_CHARS;
  routeMocks.verifyToken.mockReset();
  await testDatabase.pool.query("DELETE FROM agent_memory_cutover");

  await testDatabase.db.delete(schema.agentProjectLinks);
  await testDatabase.db.delete(schema.agents);
  await testDatabase.db.delete(schema.projects);

  projectId = randomUUID();
  await testDatabase.db.insert(schema.projects).values({
    id: projectId,
    slug: SLUG,
    name: "Ext memory",
    repoPath: `/tmp/${SLUG}`,
    maisterYamlPath: "/tmp/maister.yaml",
    taskKey: "EXTM",
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
  runId = await seedRun(testDatabase.db, {
    projectId,
    runKind: "agent",
    agentWorkspace: "none",
  });
});

async function attach(memoryEnabled: boolean): Promise<void> {
  await testDatabase.db.insert(schema.agentProjectLinks).values({
    id: randomUUID(),
    agentId: AGENT_ID,
    projectId,
    enabled: true,
    memoryEnabled,
  });
}

function agentActor(over: Record<string, unknown> = {}) {
  return {
    tokenId: "tok-1",
    tokenKind: "agent",
    projectId,
    actorLabel: `agent:${AGENT_ID}`,
    scopes: ["agent_memory:write"],
    ownerUserId: null,
    agentId: AGENT_ID,
    boundRunId: runId,
    ...over,
  };
}

function postRequest(body: unknown): NextRequest {
  const req = new NextRequest("http://localhost/api/v1/ext/agent/memory", {
    method: "POST",
    body: JSON.stringify(body),
  });

  req.headers.set("authorization", "Bearer secret");
  req.headers.set("content-type", "application/json");

  return req;
}

function getRequest(): NextRequest {
  const req = new NextRequest("http://localhost/api/v1/ext/agent/memory", {
    method: "GET",
  });

  req.headers.set("authorization", "Bearer secret");

  return req;
}

async function write(body: unknown) {
  const res = await POST(postRequest(body));

  return { status: res.status, body: (await res.json()) as any };
}

it("AV-04/15 binds commands to the credential's current run and applies the preview review guard", async () => {
  const commands = await import("../commands/route");
  const { verifyToken } = await vi.importActual<
    typeof import("@/lib/tokens/verify")
  >("@/lib/tokens/verify");

  await attach(true);
  await testDatabase.pool.query(
    "INSERT INTO agent_memory_cutover(generation) VALUES (1)",
  );
  await testDatabase.pool.query(
    "UPDATE runs SET agent_id=$2, trigger_source='manual' WHERE id=$1",
    [runId, AGENT_ID],
  );
  const issued = await issueAgentRunToken({
    db: testDatabase.db,
    runId,
    projectId,
    agentId: AGENT_ID,
  });
  const actor = await verifyToken(issued.secret, testDatabase.db);

  routeMocks.verifyToken.mockResolvedValue(actor);
  const send = (body: unknown) =>
    commands.POST(
      new NextRequest("http://localhost/api/v1/ext/agent/memory/commands", {
        method: "POST",
        headers: {
          authorization: `Bearer ${issued.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  const index = { command: "view", path: "/memories/index.md" };
  const patches = {
    command: "create",
    path: index.path,
    file_text: "retained",
    ifHash: null,
    ifRevisionId: null,
    requestKey: "native-first",
  };

  expect((await send({ ...patches, agentId: "another:agent" })).status).toBe(
    422,
  );
  expect((await send(patches)).status).toBe(200);
  const get = await send(index);
  const head = await get.json();

  expect(get.headers.get("Cache-Control")).toBe("private, no-store");
  expect(head).toMatchObject({ kind: "note", content: "retained" });
  const search = await import("../search/route");
  const searchRequest = (query: string) =>
    new NextRequest(
      `http://localhost/api/v1/ext/agent/memory/search?${query}`,
      { headers: { authorization: `Bearer ${issued.secret}` } },
    );
  const results = await search.GET(searchRequest("q=retain&limit=1"));

  expect(results.status).toBe(200);
  expect(results.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await results.json()).toMatchObject({
    hits: [{ revisionId: head.revisionId }],
  });
  expect(
    (await search.GET(searchRequest("q=retain&vaultId=another"))).status,
  ).toBe(422);
  const legacy = await GET(getRequest());

  expect(await legacy.json()).toMatchObject({
    content: "retained",
    hash: head.hash,
  });
  await testDatabase.pool.query(
    "UPDATE runs SET trigger_source='webhook' WHERE id=$1",
    [runId],
  );
  const refused = await send({
    ...patches,
    requestKey: "native-webhook",
    file_text: "external",
    ifHash: head.hash,
    ifRevisionId: head.revisionId,
  });

  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "PRECONDITION" });
  expect(await (await send(index)).json()).toMatchObject({
    content: "retained",
  });
  routeMocks.verifyToken.mockResolvedValue({
    ...actor,
    boundRunId: randomUUID(),
  });
  expect((await send(index)).status).toBe(404);
});

it("AV-01 scopes sibling Flow credentials per acting persona and fences superseded attempts", async () => {
  const commands = await import("../commands/route");
  const { verifyToken } = await vi.importActual<
    typeof import("@/lib/tokens/verify")
  >("@/lib/tokens/verify");
  const flowRunId = await seedRun(testDatabase.db, {
    projectId,
    runKind: "flow",
  });
  const peer = "mem-pkg:peer";

  await attach(true);
  await testDatabase.pool.query(
    "INSERT INTO agent_memory_cutover(generation) VALUES (1)",
  );
  await testDatabase.pool.query(
    `INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
      SELECT $2,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path FROM agents WHERE id=$1`,
    [AGENT_ID, peer],
  );
  await testDatabase.pool.query(
    "INSERT INTO agent_project_links(id,project_id,agent_id,enabled,memory_enabled) VALUES ($1,$2,$3,true,true)",
    [randomUUID(), projectId, peer],
  );
  await testDatabase.pool.query(
    "UPDATE runs SET trigger_source='manual', agent_id=$2 WHERE id=$1",
    [flowRunId, AGENT_ID],
  );
  const makeAttempt = async (nodeId: string, selected: string, ordinal = 1) => {
    const nodeAttemptId = randomUUID();

    await testDatabase.pool.query(
      "INSERT INTO node_attempts(id,run_id,node_id,node_type,status,attempt) VALUES ($1,$2,$3,'ai_coding','Running',$4)",
      [nodeAttemptId, flowRunId, nodeId, ordinal],
    );
    const staged = await stageProjectFlowMemory(testDatabase.db, {
      runId: flowRunId,
      agentId: selected,
      nodeId,
      nodeAttemptId,
    });

    expect(staged?.text).toContain("memory-protocol/v1");

    return issueProjectVaultNodeToken({
      db: testDatabase.db,
      runId: flowRunId,
      nodeAttemptId,
      projectId,
    });
  };
  const first = await makeAttempt("driver", AGENT_ID);
  const second = await makeAttempt("peer", peer);
  const sibling = await makeAttempt("driver-sibling", AGENT_ID);

  routeMocks.verifyToken.mockImplementation((secret: string) =>
    verifyToken(secret, testDatabase.db),
  );
  const call = (secret: string, args: unknown) =>
    commands.POST(
      new NextRequest("http://localhost/api/v1/ext/agent/memory/commands", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
      }),
    );
  const write = (secret: string, path: string, content: string) =>
    call(secret, {
      command: "create",
      path,
      file_text: content,
      ifHash: null,
      ifRevisionId: null,
      requestKey: "flow-write",
    });
  const path = "/memories/index.md";
  const results = await Promise.all([
    write(first.secret, path, "driver only"),
    write(second.secret, path, "peer only"),
    write(
      sibling.secret,
      "/memories/notes/sibling.md",
      "same driver, different note",
    ),
  ]);

  expect(results.map(({ status }) => status)).toEqual([200, 200, 200]);
  const inspect = (secret: string) => call(secret, { command: "view", path });

  expect(await (await inspect(first.secret)).json()).toMatchObject({
    content: "driver only",
  });
  expect(await (await inspect(second.secret)).json()).toMatchObject({
    content: "peer only",
  });
  await makeAttempt("driver", AGENT_ID, 2);
  expect((await inspect(first.secret)).status).toBe(404);
  expect((await inspect(second.secret)).status).toBe(200);
});

describe("T-C8a / REQ-C8 — the write path fails closed on every authorization axis", () => {
  it("403 — the token is not an agent token", async () => {
    await attach(true);
    routeMocks.verifyToken.mockResolvedValue(
      agentActor({ tokenKind: "project", agentId: null }),
    );

    expect((await write({ content: "x", ifHash: null })).status).toBe(403);
  });

  it("403 — an agent-kind token carrying a null agentId (fails closed)", async () => {
    await attach(true);
    routeMocks.verifyToken.mockResolvedValue(agentActor({ agentId: null }));

    expect((await write({ content: "x", ifHash: null })).status).toBe(403);
  });

  it("403 — the agent is DETACHED from the token's project", async () => {
    routeMocks.verifyToken.mockResolvedValue(agentActor());

    expect((await write({ content: "x", ifHash: null })).status).toBe(403);
  });

  it("403 — the attachment exists but memory_enabled is false", async () => {
    await attach(false);
    routeMocks.verifyToken.mockResolvedValue(agentActor());

    expect((await write({ content: "x", ifHash: null })).status).toBe(403);
  });

  it("403 — the token lacks the agent_memory:write scope", async () => {
    await attach(true);
    routeMocks.verifyToken.mockResolvedValue(
      agentActor({ scopes: ["runs:read"] }),
    );

    const res = await write({ content: "x", ifHash: null });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain("insufficient scope");
  });

  it("422 CONFIG — content over the cap", async () => {
    process.env.MAISTER_AGENT_MEMORY_MAX_CHARS = "8";
    await attach(true);
    routeMocks.verifyToken.mockResolvedValue(agentActor());

    const res = await write({ content: "x".repeat(9), ifHash: null });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("CONFIG");
  });

  it("409 CONFLICT — a stale ifHash, with the CURRENT content in the body to merge", async () => {
    await attach(true);
    routeMocks.verifyToken.mockResolvedValue(agentActor());

    await write({ content: "first", ifHash: null });

    const res = await write({ content: "second", ifHash: "deadbeef" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
    expect(res.body.current).toMatchObject({
      content: "first",
      hash: hashAgentMemory("first"),
      sizeChars: 5,
    });
  });
});

describe("T-C7a / REQ-C7 — the content-hash CAS", () => {
  beforeEach(async () => {
    await attach(true);
    routeMocks.verifyToken.mockResolvedValue(agentActor());
  });

  it("REQ-C7 AC1/AC3 — first write with ifHash:null succeeds and returns the POST-write hash", async () => {
    const res = await write({ content: "hello", ifHash: null });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content: "hello",
      hash: hashAgentMemory("hello"),
      sizeChars: 5,
    });
    expect(res.body.updatedAt).toEqual(expect.any(String));
  });

  it("REQ-C7 AC1 — a second write with the returned hash succeeds; a third with the now-stale hash loses", async () => {
    const first = await write({ content: "one", ifHash: null });
    const second = await write({ content: "two", ifHash: first.body.hash });

    expect(second.status).toBe(200);

    const third = await write({ content: "three", ifHash: first.body.hash });

    expect(third.status).toBe(409);
    expect(third.body.current.content).toBe("two");
  });

  it("REQ-C7 AC1 — ifHash:null against an EXISTING file loses (it is the first-writer form only)", async () => {
    await write({ content: "existing", ifHash: null });

    expect((await write({ content: "clobber", ifHash: null })).status).toBe(
      409,
    );
  });

  it("REQ-C7 AC4 — two genuinely CONCURRENT writes leave exactly one writer's bytes", async () => {
    const [a, b] = await Promise.all([
      write({ content: "A".repeat(64), ifHash: null }),
      write({ content: "B".repeat(64), ifHash: null }),
    ]);
    const statuses = [a.status, b.status].sort();

    expect(statuses).toEqual([200, 409]);

    const onDisk = await readFile(agentMemoryPath(SLUG, AGENT_ID), "utf8");

    // Exactly one payload, byte for byte — no interleaving, no partial write.
    expect(["A".repeat(64), "B".repeat(64)]).toContain(onDisk);
  });

  it("REQ-C8 AC3 — GET reports an absent file as the first-writer state, not a 404", async () => {
    const res = await GET(getRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      content: "",
      hash: null,
      sizeChars: 0,
      updatedAt: null,
    });
  });

  it("REQ-C8 AC3 — a workspace:none agent writes and re-reads: the store is never the worktree", async () => {
    await write({ content: "notes for none", ifHash: null });

    const res = await GET(getRequest());
    const body = (await res.json()) as { content: string };

    expect(body.content).toBe("notes for none");
    // Under .maister/<slug>/agents/… — reachable regardless of workspace mode.
    expect(agentMemoryPath(SLUG, AGENT_ID)).toContain(
      path.join(".maister", SLUG, "agents"),
    );
  });

  it("422 CONFIG — a malformed JSON body maps to the documented family, not an unhandled throw", async () => {
    const req = new NextRequest("http://localhost/api/v1/ext/agent/memory", {
      method: "POST",
      body: "{not json",
    });

    req.headers.set("authorization", "Bearer secret");
    req.headers.set("content-type", "application/json");

    const res = await POST(req);

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: "CONFIG" });
  });

  it("D15 — an unknown body key is refused: the body carries payload only, never locators", async () => {
    const res = await write({ content: "x", ifHash: null, slug: "other" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("CONFIG");
  });
});
