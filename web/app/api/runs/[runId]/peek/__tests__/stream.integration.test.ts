import type { SessionUser } from "@/lib/authz";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import Ajv from "ajv";
import { parse } from "yaml";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
let database: StartedPostgresTestDb;

vi.mock("@/lib/db/client", async (original) => ({
  ...(await original<typeof import("@/lib/db/client")>()),
  getDb: () => database.db,
  createDbNotificationClient: async () => {
    const { Client } = await import("pg");

    return new Client({ connectionString: database.databaseUrl });
  },
}));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => {
    if (!session.user) throw new MaisterError("UNAUTHENTICATED", "No session");

    return session.user;
  },
}));

let streamGet: typeof import("../stream/route").GET;
let projectId: string;
let root: string;
let child: string;

let userId: string;

async function seedRun(
  parentId: string | null,
  project = projectId,
): Promise<string> {
  const id = randomUUID();

  await database.pool.query(
    `INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,parent_run_id,root_run_id,agent_workspace)
     VALUES ($1,$2,'agent','Running','v1','revision',$3,$4,'none')`,
    [id, project, parentId, parentId ? root : null],
  );

  return id;
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "run_peek_wire" });
  ({ GET: streamGet } = await import("../stream/route"));
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

beforeEach(async () => {
  await database.pool.query("DELETE FROM projects");
  await database.pool.query("DELETE FROM users");
  userId = randomUUID();
  projectId = randomUUID();
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [userId, `${userId}@test.invalid`],
  );
  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,main_branch,branch_prefix,maister_yaml_path,task_key) VALUES($1,$2,'Peek',$3,'main','maister/','/tmp/maister.yaml',$4)",
    [
      projectId,
      `peek-${projectId}`,
      `/tmp/peek-${projectId}`,
      `K${projectId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    ],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,user_id,project_id,role) VALUES($3,$1,$2,'member')",
    [userId, projectId, randomUUID()],
  );
  session.user = {
    id: userId,
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  };
  root = await seedRun(null);
  child = await seedRun(root);
  await seedRun(child);
});

const document = parse(
  readFileSync(
    resolve(process.cwd(), "../docs/api/async/web-runs.asyncapi.yaml"),
    "utf8",
  ),
) as { components: { schemas: Record<string, object> } };
const validateFrame = new Ajv({
  strict: false,
  validateFormats: false,
}).compile({
  components: document.components,
  oneOf: [
    "RunPeekReady",
    "RunPeekChanged",
    "RunPeekRunChanged",
    "RunPeekResync",
    "RunPeekSelectionUnavailable",
  ].map((name) => ({ $ref: `#/components/schemas/${name}` })),
});

async function frame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Record<string, unknown>> {
  const result = await reader.read();

  if (result.done) throw new Error("SSE ended before expected frame");

  const text = new TextDecoder().decode(result.value);

  expect(text).not.toMatch(/^id:/m);
  const value: Record<string, unknown> = JSON.parse(
    text.split("data: ")[1].split("\n")[0],
  );

  expect(validateFrame(value), JSON.stringify(validateFrame.errors)).toBe(true);

  return value;
}
it("IT-PKD-08 IT-PKD-09 IT-PKD-10: one framed stream isolates selected ticks, discovers descendants and releases cancellation", async () => {
  const response = await streamGet(
    new NextRequest(
      `http://localhost/api/runs/${root}/peek/stream?selected=${child}`,
    ),
    { params: Promise.resolve({ runId: root }) },
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();

  try {
    expect(await frame(reader)).toEqual({
      type: "peek.ready",
      anchorRunId: root,
      selectedRunId: child,
      selectionState: "ready",
    });
    await database.pool.query("UPDATE runs SET status='Done' WHERE id=$1", [
      child,
    ]);
    const received = [await frame(reader), await frame(reader)];

    expect(received).toContainEqual({
      type: "run.changed",
      runId: child,
      kind: "summary",
    });
    expect(received).toContainEqual({ type: "peek.changed" });
    await seedRun(child);
    expect(await frame(reader)).toEqual({ type: "peek.changed" });
    await database.pool.query("DELETE FROM project_members WHERE user_id=$1", [
      userId,
    ]);
    await database.pool.query("UPDATE runs SET status='Review' WHERE id=$1", [
      root,
    ]);
    expect((await frame(reader)).type).toBe("peek.resync");
    expect((await reader.read()).done).toBe(true);
  } finally {
    await reader.cancel();
  }
});
it("IT-PKD-09: an unrelated selected Run is unavailable while the authorized parent stays live", async () => {
  const response = await streamGet(
    new NextRequest(
      `http://localhost/api/runs/${root}/peek/stream?selected=${randomUUID()}`,
    ),
    { params: Promise.resolve({ runId: root }) },
  );

  expect(response.status).toBe(200);
  const reader = response.body!.getReader();

  try {
    expect(await frame(reader)).toMatchObject({
      type: "peek.ready",
      selectionState: "unavailable",
    });
    await database.pool.query("UPDATE runs SET status='Review' WHERE id=$1", [
      root,
    ]);
    const frames = [await frame(reader), await frame(reader)];

    expect(frames).toContainEqual({
      type: "run.changed",
      runId: root,
      kind: "summary",
    });
  } finally {
    await reader.cancel();
  }
});
