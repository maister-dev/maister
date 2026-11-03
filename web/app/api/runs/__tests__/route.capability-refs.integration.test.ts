/**
 * T1.4 — launch-gate capability ref validation (M14).
 *
 * The synchronous delivery engine rebuilds the project capability registry from the hydrated
 * capability_records catalog and rejects node settings.mcps/skills/restrictions/
 * settingsProfile refs absent from it (CONFIG → 400), BEFORE any side-effect.
 * Imports (agent_definition / flow-package) resolve for any kind; a CLEARed
 * (disabled) record no longer resolves (R-SYM).
 */
import type { LaunchRunInput } from "@/lib/services/runs";
import type { PlatformStatus } from "@/types/platform-status";

import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { git as fixtureGit } from "@/test-support/git-fixture";
import {
  seedAcceptedRepositoryQualification,
  createEngineFixtureRepository,
  isolateEngineFixtureRuntime,
} from "@/test-support/repository-qualification";
import { launchEngineResponse } from "@/test-support/launch-engine-response";
import {
  readyExecutionHostCapabilities,
  TEST_HOST_IDENTITY,
} from "@/test-support/supervisor-health-fixture";
import * as schemaModule from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
const repositories: string[] = [];
let restoreEngineRuntime: (() => Promise<void>) | undefined;
let db: NodePgDatabase;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// These assertions stop at launch preparation; model execution has separate coverage.
vi.mock("@/lib/flows/runner", () => ({
  runFlow: vi.fn(async () => undefined),
}));

function readyPlatformStatus(): PlatformStatus {
  return {
    kind: "ready",
    health: {
      status: "ready",
      host: TEST_HOST_IDENTITY,
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
    getExecutionHostCapabilities: async () => readyExecutionHostCapabilities(),
  };
});

vi.mock("@/lib/worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    addWorktree: async (input: Parameters<typeof actual.addWorktree>[0]) => {
      await addWorktreeMock(input);

      return actual.addWorktree(input);
    },
    removeWorktree: async (
      input: Parameters<typeof actual.removeWorktree>[0],
    ) => {
      await removeWorktreeMock(input);

      return actual.removeWorktree(input);
    },
    listBranches: async () => ["main"],
    resolveBaseCommit: async (args: {
      projectRepoPath: string;
      baseRef: string;
    }) =>
      fixtureGit(
        args.projectRepoPath,
        "rev-parse",
        "--verify",
        `${args.baseRef}^{commit}`,
      ),
  };
});

function launchResponse(input: LaunchRunInput): Promise<Response> {
  return launchEngineResponse(testDatabase.db, input, {
    actorUserId: "u-member",
    authorize: async () => undefined,
  });
}

function request(taskId: string): LaunchRunInput {
  return { taskId };
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

// M27/T-C6 (C6-top): a manifest that declares package-level required MCPs at
// the top level (no node settings.mcps) — exercises the launch package-mcp gate.
function packageMcpManifest(name: string, packageMcps: string[]): unknown {
  return {
    schemaVersion: 1,
    name,
    mcps: packageMcps,
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "/aif-implement" },
        transitions: { success: "done" },
      },
    ],
  };
}

type CapabilitySeed = {
  capabilityRefId: string;
  kind: string;
  source: string;
  disabledAt?: Date | null;
  agents?: string[];
  // ADR-179: the transport gate reads the winner's transport out of material,
  // so the SEND site (services/runs selecting `material`) is what this covers —
  // the unit cases in required-mcp-agent-support.test.ts cover the predicate.
  material?: Record<string, unknown>;
};

async function seedProject(
  id: string,
  manifest: unknown,
  capabilities: CapabilitySeed[] = [],
): Promise<void> {
  const repoPath = await createEngineFixtureRepository();

  repositories.push(repoPath);
  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id,
    slug: id,
    name: id,
    repoPath,
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
    installedPath: `${repoPath}/.fixture-flow`,
    setupStatus: "not_required",
    packageStatus: "Installed",
  });
  await db.insert(schema.flows).values({
    id: `flow-${id}`,
    projectId: id,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: `${repoPath}/.fixture-flow`,
    manifest,
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: "trusted_by_policy",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(`exec-${id}`, "claude"));
  await db
    .update(schema.projects)
    .set({ defaultRunnerId: `exec-${id}` })
    .where(eq(schema.projects.id, id));
  await db.insert(schema.projectMembers).values({
    id: `pm-${id}`,
    projectId: id,
    userId: "u-member",
    role: "member",
  });
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
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
      agents: cap.agents ?? ["claude", "codex"],
      enforceability: "instructed",
      selectedByDefault: true,
      selectable: cap.disabledAt ? false : true,
      material: cap.material ?? {},
      disabledAt: cap.disabledAt ?? null,
    });
  }
  await seedAcceptedRepositoryQualification(testDatabase.db, id, `task-${id}`);
}

async function seedPlatformDefaultRunner(): Promise<void> {
  await db.insert(schema.platformAcpRunners).values({
    id: "claude-default",
    adapter: "claude",
    capabilityAgent: "claude",
    model: "claude-sonnet-4-6",
    provider: { kind: "anthropic" },
    permissionPolicy: "default",
    readinessStatus: "Ready",
    readinessReasons: [],
    enabled: true,
  });
  await db.insert(schema.platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: "claude-default",
  });
}

beforeAll(async () => {
  restoreEngineRuntime = await isolateEngineFixtureRuntime();
  testDatabase = await startMainPostgresTestDb({
    databaseName: "runs_capref_test",
  });

  db = testDatabase.db;

  await db.insert(schema.users).values({
    id: "u-member",
    email: "member@test.com",
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  await seedPlatformDefaultRunner();

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
  // M27/T-C6 (C6-top): package-level required mcp declared but absent from the
  // registry → launch refused; declared + registered → launches.
  await seedProject(
    "proj-unknown-pkg-mcp",
    packageMcpManifest("UnknownPkgMcp", ["ghost-pkg-mcp"]),
    [{ capabilityRefId: "real-mcp", kind: "mcp", source: "project" }],
  );
  await seedProject(
    "proj-known-pkg-mcp",
    packageMcpManifest("KnownPkgMcp", ["pkg-mcp"]),
    [{ capabilityRefId: "pkg-mcp", kind: "mcp", source: "project" }],
  );
  // M27/T-C8b: a REQUIRED mcp whose record excludes the run's agent (claude) →
  // EXECUTOR_UNAVAILABLE; one supporting the agent launches.
  await seedProject(
    "proj-req-mcp-unsupported",
    aiCodingManifest("ReqMcpUnsupported", { mcps: { required: ["github"] } }),
    [
      {
        capabilityRefId: "github",
        kind: "mcp",
        source: "project",
        agents: ["codex"],
      },
    ],
  );
  await seedProject(
    "proj-req-mcp-supported",
    aiCodingManifest("ReqMcpSupported", { mcps: { required: ["github"] } }),
    [{ capabilityRefId: "github", kind: "mcp", source: "project" }],
  );
  // ADR-179: a REQUIRED ref whose TRANSPORT the launch adapter cannot use.
  // These runs launch on `claude`, which accepts sse, so the offending pair is
  // expressed by declaring the server claude-only with an `sse` transport
  // (supported-agent) and — for the transport arm — by an http server the
  // adapter DOES accept.
  await seedProject(
    "proj-req-mcp-sse",
    aiCodingManifest("ReqMcpSse", { mcps: { required: ["legacy"] } }),
    [
      {
        capabilityRefId: "legacy",
        kind: "mcp",
        source: "project",
        material: { transport: "sse", url: "https://mcp.example.com/sse" },
      },
    ],
  );
  await seedProject(
    "proj-req-mcp-http",
    aiCodingManifest("ReqMcpHttp", { mcps: { required: ["vendor"] } }),
    [
      {
        capabilityRefId: "vendor",
        kind: "mcp",
        source: "project",
        material: { transport: "http", url: "https://mcp.example.com/v1" },
      },
    ],
  );
}, 180_000);

afterAll(async () => {
  await restoreEngineRuntime?.();
  await testDatabase?.stop();
  await Promise.all(
    repositories.map((repo) => rm(repo, { recursive: true, force: true })),
  );
});

describe("Delivery engine — capability ref launch gate (M14 T1.4)", () => {
  beforeEach(() => {
    checkSupervisorHealthMock.mockResolvedValue(readyPlatformStatus());
    addWorktreeMock.mockClear();
    removeWorktreeMock.mockClear();
    sessionRef.value = { user: { id: "u-member", role: "member" } };
  });

  it("rejects an unknown skill ref with 400 CONFIG and NO side-effect", async () => {
    const res = await launchResponse(request("task-proj-unknown-skill"));

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
    const res = await launchResponse(request("task-proj-unknown-mcp"));

    expect(res.status).toBe(400);

    const body = await res.json();

    expect(body.code).toBe("CONFIG");
    expect(body.message).toContain("ghost-mcp");
  });

  it("rejects a ref backed only by a DISABLED record (R-SYM) with 400 CONFIG", async () => {
    const res = await launchResponse(request("task-proj-disabled-ref"));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONFIG");
  });

  it("launches (202) when the skill ref resolves to a project capability_record", async () => {
    const res = await launchResponse(request("task-proj-known-skill"));

    expect(res.status).toBe(202);
    expect(addWorktreeMock).toHaveBeenCalledTimes(1);

    // M27/T-C8 (§7.1.8): the resolved capability set is frozen onto the run.
    const launched = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-known-skill"));

    expect(launched).toHaveLength(1);
    const snapshot = (
      launched[0] as {
        resolvedCapabilitySet: {
          flowRevisionId?: string;
          capabilities?: unknown[];
          mcps?: unknown[];
        } | null;
      }
    ).resolvedCapabilitySet;

    expect(snapshot).not.toBeNull();
    expect(typeof snapshot?.flowRevisionId).toBe("string");
    expect(Array.isArray(snapshot?.capabilities)).toBe(true);
    expect(Array.isArray(snapshot?.mcps)).toBe(true);
  });

  it("launches (202) when the ref resolves to an imported (flow-package) capability", async () => {
    const res = await launchResponse(request("task-proj-import-backed"));

    expect(res.status).toBe(202);
    expect(addWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown package-level mcp ref with 400 CONFIG and NO side-effect (C6-top)", async () => {
    const res = await launchResponse(request("task-proj-unknown-pkg-mcp"));

    expect(res.status).toBe(400);

    const body = await res.json();

    expect(body.code).toBe("CONFIG");
    expect(body.message).toContain("ghost-pkg-mcp");
    expect(addWorktreeMock).not.toHaveBeenCalled();

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-unknown-pkg-mcp"));

    expect(runs).toHaveLength(0);
  });

  it("launches (202) when the package-level mcp ref resolves to a project record (C6-top)", async () => {
    const res = await launchResponse(request("task-proj-known-pkg-mcp"));

    expect(res.status).toBe(202);
    expect(addWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a required mcp whose record excludes the executor agent (503 EXECUTOR_UNAVAILABLE) (C8b)", async () => {
    const res = await launchResponse(request("task-proj-req-mcp-unsupported"));

    expect(res.status).toBe(503);

    const body = await res.json();

    expect(body.code).toBe("EXECUTOR_UNAVAILABLE");
    expect(body.message).toContain("github");
    expect(addWorktreeMock).not.toHaveBeenCalled();

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-req-mcp-unsupported"));

    expect(runs).toHaveLength(0);
  });

  it("launches (202) when the required mcp supports the executor agent (C8b)", async () => {
    const res = await launchResponse(request("task-proj-req-mcp-supported"));

    expect(res.status).toBe(202);
    expect(addWorktreeMock).toHaveBeenCalledTimes(1);
  });

  // ADR-179: this pair pins the SEND site — that `material.transport` is
  // actually selected and reaches the predicate. `claude` accepts sse, so both
  // launch; the refusal arm is covered at the unit level, where the adapter can
  // be varied.
  it("launches (202) for a required sse ref on claude — claude accepts sse", async () => {
    const res = await launchResponse(request("task-proj-req-mcp-sse"));

    expect(res.status).toBe(202);
    expect(addWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it("launches (202) for a required http ref", async () => {
    const res = await launchResponse(request("task-proj-req-mcp-http"));

    expect(res.status).toBe(202);
    expect(addWorktreeMock).toHaveBeenCalledTimes(1);
  });
});
