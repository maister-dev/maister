import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { MaisterError } from "@/lib/errors";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// installFlowPlugin behavior is swapped per test.
const installFlowPlugin = vi.fn(
  async (_args: Record<string, unknown>): Promise<unknown> => undefined,
);

// ADR-088: packages[] orchestration is spy-tested here (the real install +
// attach pipeline is covered by lib/packages attach tests and the
// projects-register-packages real-fixture test); behavior swapped per test.
const installPackageRevision = vi.fn(
  async (_args: Record<string, unknown>): Promise<unknown> => ({
    id: "pkg-install-1",
    name: "pkg",
    versionLabel: "pkg/v1.0.0",
    resolvedRevision: "a".repeat(40),
    reused: false,
    manifest: {
      spec: {
        schemaVersion: 1,
        name: "pkg",
        flows: [],
        capabilities: [],
        mcps: [],
        restrictions: [],
      },
      inventory: { skills: [], agents: [] },
    },
  }),
);
const attachPackage = vi.fn(
  async (_args: Record<string, unknown>): Promise<unknown> => ({
    attachmentId: "att-1",
    memberFlows: [],
  }),
);

// The seeded bootstrap admin (migration 0005) is the FK target for the owner
// membership; requireGlobalRole is mocked to return it (avoids @/auth →
// next-auth in the Vitest module graph).
const ADMIN_ID = "usr_bootstrap_admin";

const baseManifest = {
  schemaVersion: 1,
  name: "Bugfix",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "implement" },
      transitions: { success: "done" },
    },
  ],
};

const seedConfig = {
  schemaVersion: 2,
  project: {
    name: "Saga Proj",
    repo_path: "/repos/saga-proj",
    main_branch: "main",
    branch_prefix: "maister/",
  },
  flows: [{ id: "bugfix", source: "github.com/x/y", version: "v1.0.0" }],
  capabilities: {
    mcps: [],
    skills: [],
    rules: [],
    restrictions: [],
    settings: [],
    tools: [],
    agent_definitions: [],
    env_profiles: [],
  },
  capability_imports: [],
  // The real loadProjectConfig applies the zod default — the mock mirrors it.
  packages: [],
};
let currentConfig: Record<string, any> = seedConfig;
let currentManifest: Record<string, any> = baseManifest;
// ADR-093: drive register()'s real maister.yaml presence check + source.
let currentConfigError: unknown = null;
let currentResolved: Record<string, any> = {
  dir: "/repos/saga-proj",
  repoUrl: null,
  provider: null,
  gitStatus: "no-remote",
  clonedByUs: false,
};
let tmpRoot: string;
let withManifestDir: string;
let noManifestDir: string;

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: vi.fn(async () => ({
    id: ADMIN_ID,
    role: "admin",
    mustChangePassword: false,
  })),
}));

vi.mock("@/lib/config", () => ({
  loadProjectConfig: vi.fn(async () => {
    if (currentConfigError) throw currentConfigError;

    return currentConfig;
  }),
  buildCapabilityRefIds: vi.fn(() => ({
    mcp: new Set<string>(),
    skill: new Set<string>(),
    restriction: new Set<string>(),
    setting: new Set<string>(),
  })),
}));

vi.mock("@/lib/flows", () => ({
  installFlowPlugin: (...args: unknown[]) =>
    installFlowPlugin(...(args as [Record<string, unknown>])),
}));

// The route only needs the pure label helper from packages/install — mocking
// it severs the heavy real-module graph (flows, capabilities) from this test.
vi.mock("@/lib/packages/install", () => ({
  packageVersionLabel: (version: string) => version.replaceAll("/", "-"),
}));

vi.mock("@/lib/packages/attach", () => ({
  installPackageRevision: (...args: unknown[]) =>
    installPackageRevision(...(args as [Record<string, unknown>])),
  attachPackage: (...args: unknown[]) =>
    attachPackage(...(args as [Record<string, unknown>])),
}));

// This saga test is about flow-install rollback, not source resolution; mock
// resolveProjectSource so no real git clone/init runs. clonedByUs:false means
// the route's clone-cleanup path never fires.
vi.mock("@/lib/repo-source", () => ({
  resolveProjectSource: vi.fn(async () => currentResolved),
  gitInit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

let POST: typeof import("@/app/api/projects/route").POST;

function request(): NextRequest {
  return new NextRequest("http://localhost/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: "saga-proj" }),
  });
}

async function projectRows(slug: string) {
  return db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.slug, slug));
}

async function seedPlatformRunner(id: string): Promise<void> {
  await db.insert(schema.platformAcpRunners).values({
    id,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "claude-sonnet-4-6",
    provider: { kind: "anthropic" },
    permissionPolicy: "default",
    readinessStatus: "Ready",
    readinessReasons: [],
    enabled: true,
  });
}

async function seedNotReadyPlatformRunner(id: string): Promise<void> {
  await db.insert(schema.platformAcpRunners).values({
    id,
    adapter: "codex",
    capabilityAgent: "codex",
    model: "gpt-5",
    provider: { kind: "openai" },
    permissionPolicy: "default",
    readinessStatus: "NotReady",
    readinessReasons: ["missing token"],
    enabled: true,
  });
}

async function installFlow(args: Record<string, unknown>) {
  const revisionId = randomUUID();
  const flowRowId = randomUUID();
  const resolvedRevision = randomUUID().replaceAll("-", "");
  const manifest = currentManifest;

  await db.insert(schema.flowRevisions).values({
    id: revisionId,
    flowRefId: args.flowId,
    source: args.source,
    versionLabel: args.version,
    resolvedRevision,
    manifestDigest: randomUUID().replaceAll("-", ""),
    manifest,
    schemaVersion: 1,
    installedPath: `/tmp/maister/flows/${args.flowId}`,
    setupStatus: "not_required",
    packageStatus: "Installed",
  });
  await db.insert(schema.flows).values({
    id: flowRowId,
    projectId: args.projectId,
    flowRefId: args.flowId,
    source: args.source,
    version: args.version,
    revision: resolvedRevision,
    installedPath: `/tmp/maister/flows/${args.flowId}`,
    manifest,
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: "trusted_by_policy",
  });

  return {
    flowRowId,
    revisionId,
    installedPath: `/tmp/maister/flows/${args.flowId}`,
    symlinkPath: `/tmp/maister/projects/${args.flowId}`,
    manifest,
    revision: resolvedRevision,
    trustStatus: "trusted_by_policy",
    enablementState: "Enabled",
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("projects_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  tmpRoot = await mkdtemp(join(tmpdir(), "projects-register-"));
  withManifestDir = join(tmpRoot, "with-manifest");
  noManifestDir = join(tmpRoot, "no-manifest");
  await mkdir(withManifestDir, { recursive: true });
  await mkdir(noManifestDir, { recursive: true });
  await writeFile(join(withManifestDir, "maister.yaml"), "schemaVersion: 2\n");

  ({ POST } = await import("@/app/api/projects/route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  installFlowPlugin.mockReset();
  installFlowPlugin.mockImplementation((args: Record<string, unknown>) =>
    installFlow(args),
  );
  installPackageRevision.mockClear();
  attachPackage.mockClear();
  currentConfig = seedConfig;
  currentManifest = baseManifest;
  currentConfigError = null;
  currentResolved = {
    dir: withManifestDir,
    repoUrl: null,
    provider: null,
    gitStatus: "no-remote",
    clonedByUs: false,
  };
  await db.delete(schema.projects);
  await db.delete(schema.platformAcpRunners);
});

describe("POST /api/projects — flow-install failure saga (integration)", () => {
  it("rolls the whole project back when a flow install fails, leaving no row", async () => {
    installFlowPlugin.mockRejectedValueOnce(
      new MaisterError("FLOW_INSTALL", "clone failed"),
    );

    const res = await POST(request());

    expect(res.status).toBe(502);
    const body = await res.json();

    expect(body.code).toBe("FLOW_INSTALL");

    // Full compensation: project + cascade children are gone.
    expect(await projectRows("saga-proj")).toHaveLength(0);

    const flows = await db.select().from(schema.flows);

    expect(flows).toHaveLength(0);
  });

  it("allows an identical retry to succeed (no leftover 409)", async () => {
    const res = await POST(request());

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.slug).toBe("saga-proj");

    const rows = await projectRows("saga-proj");

    expect(rows).toHaveLength(1);

    const members = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.projectId, rows[0].id));

    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("owner");

    const flows = await db.select().from(schema.flows);

    expect(flows).toHaveLength(1);
  });

  it("stores a project default runner only when it exists in the platform catalog", async () => {
    await seedPlatformRunner("claude-code");
    currentConfig = {
      ...seedConfig,
      project: { ...seedConfig.project, default_runner: "claude-code" },
    };

    const res = await POST(request());

    expect(res.status).toBe(201);

    const rows = await projectRows("saga-proj");

    expect(rows[0].defaultRunnerId).toBe("claude-code");
  });

  it("rejects a project default runner that is not ready", async () => {
    await seedNotReadyPlatformRunner("codex-not-ready");
    currentConfig = {
      ...seedConfig,
      project: { ...seedConfig.project, default_runner: "codex-not-ready" },
    };

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    expect(await projectRows("saga-proj")).toHaveLength(0);
  });

  it("creates a pending Flow runner remap and disables the attachment for missing step targets", async () => {
    currentManifest = {
      ...baseManifest,
      nodes: [
        {
          ...baseManifest.nodes[0],
          settings: { runner_type: "acp", runner: "claude-glm" },
        },
      ],
    };

    const res = await POST(request());

    expect(res.status).toBe(201);

    const rows = await projectRows("saga-proj");
    const flowRows = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.projectId, rows[0].id));
    const remaps = await db
      .select()
      .from(schema.flowRunnerRemaps)
      .where(eq(schema.flowRunnerRemaps.projectId, rows[0].id));

    expect(flowRows[0].enablementState).toBe("Disabled");
    expect(remaps).toHaveLength(1);
    expect(remaps[0]).toMatchObject({
      stepId: "implement",
      sourceRunnerId: "claude-glm",
      status: "Pending",
      mappedRunnerId: null,
    });
  });

  it("does not create Flow runner remaps when step targets already exist", async () => {
    await seedPlatformRunner("claude-glm");
    currentManifest = {
      ...baseManifest,
      nodes: [
        {
          ...baseManifest.nodes[0],
          settings: { runner_type: "acp", runner: "claude-glm" },
        },
      ],
    };

    const res = await POST(request());

    expect(res.status).toBe(201);

    const rows = await projectRows("saga-proj");
    const flowRows = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.projectId, rows[0].id));
    const remaps = await db
      .select()
      .from(schema.flowRunnerRemaps)
      .where(eq(schema.flowRunnerRemaps.projectId, rows[0].id));

    expect(flowRows[0].enablementState).toBe("Enabled");
    expect(remaps).toHaveLength(0);
  });
});

describe("POST /api/projects — packages[] bootstrap (ADR-088, integration)", () => {
  it("installs + attaches each packages[] entry and ingests package-derived capabilities", async () => {
    currentConfig = {
      ...seedConfig,
      flows: [],
      packages: [
        {
          id: "aif",
          source: "github.com/org/maister-plugins",
          version: "aif/v2.0.0",
          path: "packages/aif",
        },
      ],
    };
    installPackageRevision.mockResolvedValueOnce({
      id: "aif-install-1",
      name: "aif",
      versionLabel: "aif/v2.0.0",
      resolvedRevision: "b".repeat(40),
      reused: false,
      manifest: {
        spec: {
          schemaVersion: 1,
          name: "aif",
          flows: [],
          capabilities: [{ id: "aif-bundle", path: "capability" }],
          mcps: [],
          restrictions: [],
        },
        inventory: { skills: [], agents: [] },
      },
    });

    const res = await POST(request());

    expect(res.status).toBe(201);
    expect(installPackageRevision).toHaveBeenCalledTimes(1);
    expect(installPackageRevision.mock.calls[0][0]).toMatchObject({
      source: "github.com/org/maister-plugins",
      version: "aif/v2.0.0",
      path: "packages/aif",
      trustStatus: "untrusted",
    });
    // Registration rides the SAME attach pipeline as the UI surface.
    expect(attachPackage).toHaveBeenCalledTimes(1);
    expect(attachPackage.mock.calls[0][0]).toMatchObject({
      projectSlug: "saga-proj",
      packageInstallId: "aif-install-1",
    });

    // The package-derived bundle entry rode the SAME SET/CLEAR ingest as
    // config capability_imports (additionalImportDerived plumbing), built
    // from the install manifest with the path-safe version label.
    const records = await db
      .select()
      .from(schema.capabilityRecords)
      .where(eq(schema.capabilityRecords.capabilityRefId, "aif-bundle"));

    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe("agent_definition");
    expect(records[0].source).toBe("flow-package");
    expect(records[0].version).toBe("aif-v2.0.0");
  });

  it("rolls the whole project back when a package install fails (same compensation)", async () => {
    currentConfig = {
      ...seedConfig,
      flows: [],
      packages: [
        {
          id: "aif",
          source: "github.com/org/maister-plugins",
          version: "aif/v2.0.0",
        },
      ],
    };
    installPackageRevision.mockRejectedValueOnce(
      new MaisterError("FLOW_INSTALL", "package clone failed"),
    );

    const res = await POST(request());

    expect(res.status).toBe(502);
    expect(await projectRows("saga-proj")).toHaveLength(0);

    // Retry succeeds with the default install + attach mocks.
    currentConfig = {
      ...seedConfig,
      flows: [],
      packages: [
        {
          id: "aif",
          source: "github.com/org/maister-plugins",
          version: "aif/v2.0.0",
        },
      ],
    };
    const retry = await POST(request());

    expect(retry.status).toBe(201);
    expect(await projectRows("saga-proj")).toHaveLength(1);
  });
});

describe("POST /api/projects — maister.yaml optional (ADR-093, integration)", () => {
  function req(body: Record<string, unknown>): NextRequest {
    return new NextRequest("http://localhost/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("registers from DB defaults when no maister.yaml is on disk", async () => {
    currentResolved = {
      dir: noManifestDir,
      repoUrl: null,
      provider: null,
      gitStatus: "no-remote",
      clonedByUs: false,
    };

    const res = await POST(req({ target: "ignored-by-mock" }));

    expect(res.status).toBe(201);

    // basename(noManifestDir) === "no-manifest" → slug "no-manifest".
    const rows = await projectRows("no-manifest");

    expect(rows).toHaveLength(1);
    expect(rows[0].maisterYamlPath).toBeNull();
    expect(rows[0].name).toBe("no-manifest");
    expect(rows[0].mainBranch).toBe("main"); // non-git dir → tier-3 fallback
    expect(rows[0].taskKey).toBe("NOM"); // deriveTaskKey("no-manifest")
    expect(installFlowPlugin).not.toHaveBeenCalled();

    const members = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.projectId, rows[0].id));

    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("owner");
  });

  it("lets an explicit name and task key win over the derived values", async () => {
    currentResolved = {
      dir: noManifestDir,
      repoUrl: null,
      provider: null,
      gitStatus: "no-remote",
      clonedByUs: false,
    };

    const res = await POST(
      req({ target: "ignored", name: "My Cool App", taskKey: "COOL" }),
    );

    expect(res.status).toBe(201);

    const rows = await projectRows("my-cool-app");

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("My Cool App");
    expect(rows[0].taskKey).toBe("COOL");
    expect(rows[0].maisterYamlPath).toBeNull();
  });

  it("still loads the manifest (maisterYamlPath set) when maister.yaml is present", async () => {
    const res = await POST(req({ target: "ignored" }));

    expect(res.status).toBe(201);

    const rows = await projectRows("saga-proj");

    expect(rows).toHaveLength(1);
    expect(rows[0].maisterYamlPath).toBe(join(withManifestDir, "maister.yaml"));
    expect(installFlowPlugin).toHaveBeenCalled();
  });

  it("fails CONFIG when a present maister.yaml is invalid (no DB-default fallback)", async () => {
    currentConfigError = new MaisterError("CONFIG", "bad manifest");

    const res = await POST(req({ target: "ignored" }));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    expect(await projectRows("saga-proj")).toHaveLength(0);
  });

  it("refuses a duplicate task key with CONFLICT", async () => {
    currentResolved = {
      dir: noManifestDir,
      repoUrl: null,
      provider: null,
      gitStatus: "no-remote",
      clonedByUs: false,
    };

    const first = await POST(req({ target: "ignored", taskKey: "DUP" }));

    expect(first.status).toBe(201);

    const second = await POST(req({ target: "ignored", taskKey: "DUP" }));
    const body = await second.json();

    expect(second.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
  });

  it("git-inits a created new-empty project (gitStatus initialized)", async () => {
    currentResolved = {
      dir: noManifestDir,
      repoUrl: null,
      provider: null,
      gitStatus: "initialized",
      clonedByUs: false,
      createdByUs: true,
    };

    const res = await POST(
      req({ target: "ignored", name: "Fresh App", mode: "new" }),
    );

    expect(res.status).toBe(201);

    const rows = await projectRows("fresh-app");

    expect(rows).toHaveLength(1);
    expect(rows[0].maisterYamlPath).toBeNull();

    // register's "initialized" branch ran the (mocked) gitInit on the dir.
    const { gitInit } = await import("@/lib/repo-source");

    expect(gitInit).toHaveBeenCalledWith(noManifestDir);
  });
});
