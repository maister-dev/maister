/**
 * T1.4 — launch-gate capability ref validation (M14).
 *
 * POST /api/runs rebuilds the project capability registry from the hydrated
 * capability_records catalog and rejects node settings.mcps/skills/restrictions/
 * settingsProfile refs absent from it (CONFIG → 400), BEFORE any side-effect.
 * Imports (agent_definition / flow-package) resolve for any kind; a CLEARed
 * (disabled) record no longer resolves (R-SYM).
 */
import type { PlatformStatus } from "@/types/platform-status";

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

function readyPlatformStatus(): PlatformStatus {
  return {
    kind: "ready",
    health: {
      status: "ready",
      version: "0.0.1",
      uptimeMs: 1,
      checkedAt: new Date().toISOString(),
      sessions: { live: 0, exited: 0, crashed: 0 },
    },
  };
}

const checkSupervisorHealthMock = vi.fn<() => Promise<PlatformStatus>>(
  async () => readyPlatformStatus(),
);
const addWorktreeMock = vi.fn(async (_input: unknown) => undefined);
const removeWorktreeMock = vi.fn(async (_input: unknown) => undefined);

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    checkSupervisorHealth: () => checkSupervisorHealthMock(),
  };
});

vi.mock("@/lib/worktree", () => ({
  addWorktree: (input: unknown) => addWorktreeMock(input),
  removeWorktree: (input: unknown) => removeWorktreeMock(input),
}));

let POST: typeof import("@/app/api/runs/route").POST;

function request(taskId: string): NextRequest {
  return new NextRequest("http://localhost/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
}

function aiCodingManifest(name: string, settings: unknown): unknown {
  return {
    schemaVersion: 1,
    name,
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "/aif-implement" },
        transitions: { success: "done" },
        settings,
      },
    ],
  };
}

type CapabilitySeed = {
  capabilityRefId: string;
  kind: string;
  source: string;
  disabledAt?: Date | null;
};

async function seedProject(
  id: string,
  manifest: unknown,
  capabilities: CapabilitySeed[] = [],
): Promise<void> {
  await db.insert(schema.projects).values({
    id,
    slug: id,
    name: id,
    repoPath: `/repos/${id}`,
    maisterYamlPath: `/repos/${id}/maister.yaml`,
  });

  const revisionId = `rev-${id}`;

  await db.insert(schema.flowRevisions).values({
    id: revisionId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: id.padEnd(40, "x").slice(0, 40),
    manifestDigest: `digest-${id}`,
    manifest,
    schemaVersion: 1,
    installedPath: `/cache/${id}`,
    setupStatus: "not_required",
    packageStatus: "Installed",
  });
  await db.insert(schema.flows).values({
    id: `flow-${id}`,
    projectId: id,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: `/cache/${id}`,
    manifest,
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: "trusted_by_policy",
  });
  await db.insert(schema.executors).values({
    id: `exec-${id}`,
    projectId: id,
    executorRefId: "claude-default",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });
  await db
    .update(schema.projects)
    .set({ defaultExecutorId: `exec-${id}` })
    .where(eq(schema.projects.id, id));
  await db.insert(schema.projectMembers).values({
    id: `pm-${id}`,
    projectId: id,
    userId: "u-member",
    role: "member",
  });
  await db.insert(schema.tasks).values({
    id: `task-${id}`,
    projectId: id,
    title: `${id} task`,
    prompt: "do it",
    flowId: `flow-${id}`,
  });

  for (const cap of capabilities) {
    await db.insert(schema.capabilityRecords).values({
      id: randomUUID(),
      projectId: id,
      capabilityRefId: cap.capabilityRefId,
      kind: cap.kind,
      label: cap.capabilityRefId,
      source: cap.source,
      agents: ["claude", "codex"],
      enforceability: "instructed",
      selectedByDefault: true,
      selectable: cap.disabledAt ? false : true,
      material: {},
      disabledAt: cap.disabledAt ?? null,
    });
  }
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("runs_capref_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  await db.insert(schema.users).values({
    id: "u-member",
    email: "member@test.com",
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });

  await seedProject(
    "proj-unknown-skill",
    aiCodingManifest("UnknownSkill", { skills: ["ghost-skill"] }),
    [{ capabilityRefId: "real-skill", kind: "skill", source: "project" }],
  );
  await seedProject(
    "proj-unknown-mcp",
    aiCodingManifest("UnknownMcp", { mcps: ["ghost-mcp"] }),
    [{ capabilityRefId: "real-mcp", kind: "mcp", source: "project" }],
  );
  await seedProject(
    "proj-known-skill",
    aiCodingManifest("KnownSkill", { skills: ["github-skill"] }),
    [{ capabilityRefId: "github-skill", kind: "skill", source: "project" }],
  );
  await seedProject(
    "proj-import-backed",
    aiCodingManifest("ImportBacked", { skills: ["aif-pkg"] }),
    [
      {
        capabilityRefId: "aif-pkg",
        kind: "agent_definition",
        source: "flow-package",
      },
    ],
  );
  await seedProject(
    "proj-disabled-ref",
    aiCodingManifest("DisabledRef", { skills: ["removed-skill"] }),
    [
      {
        capabilityRefId: "removed-skill",
        kind: "skill",
        source: "project",
        disabledAt: new Date(),
      },
    ],
  );

  ({ POST } = await import("@/app/api/runs/route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("POST /api/runs — capability ref launch gate (M14 T1.4)", () => {
  beforeEach(() => {
    checkSupervisorHealthMock.mockResolvedValue(readyPlatformStatus());
    addWorktreeMock.mockClear();
    removeWorktreeMock.mockClear();
    sessionRef.value = { user: { id: "u-member", role: "member" } };
  });

  it("rejects an unknown skill ref with 400 CONFIG and NO side-effect", async () => {
    const res = await POST(request("task-proj-unknown-skill"));

    expect(res.status).toBe(400);

    const body = await res.json();

    expect(body.code).toBe("CONFIG");
    expect(body.message).toContain("ghost-skill");
    expect(body.message).toContain("skill");
    expect(addWorktreeMock).not.toHaveBeenCalled();

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-unknown-skill"));

    expect(runs).toHaveLength(0);
  });

  it("rejects an unknown mcp ref with 400 CONFIG", async () => {
    const res = await POST(request("task-proj-unknown-mcp"));

    expect(res.status).toBe(400);

    const body = await res.json();

    expect(body.code).toBe("CONFIG");
    expect(body.message).toContain("ghost-mcp");
  });

  it("rejects a ref backed only by a DISABLED record (R-SYM) with 400 CONFIG", async () => {
    const res = await POST(request("task-proj-disabled-ref"));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONFIG");
  });

  it("launches (202) when the skill ref resolves to a project capability_record", async () => {
    const res = await POST(request("task-proj-known-skill"));

    expect(res.status).toBe(202);
    expect(addWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it("launches (202) when the ref resolves to an imported (flow-package) capability", async () => {
    const res = await POST(request("task-proj-import-backed"));

    expect(res.status).toBe(202);
    expect(addWorktreeMock).toHaveBeenCalledTimes(1);
  });
});
