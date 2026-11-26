import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
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

import * as schemaModule from "@/lib/db/schema";
import { requireGlobalRole } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { resolveProjectSource } from "@/lib/repo-source";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

// The seeded bootstrap admin (migration 0005) is the FK target for the owner
// membership; requireGlobalRole is mocked to return it (avoids @/auth →
// next-auth in the Vitest module graph).
const ADMIN_ID = "usr_bootstrap_admin";

const seedConfig = {
  schemaVersion: 2,
  project: {
    name: "Saga Proj",
    repo_path: "/repos/saga-proj",
    main_branch: "main",
    branch_prefix: "maister/",
  },
  flows: [
    { id: "bugfix", source: "https://github.com/x/y", version: "v1.0.0" },
  ],
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

vi.mock("@/lib/config", async (original) => ({
  ...(await original<typeof import("@/lib/config")>()),
  loadProjectConfig: vi.fn(async () => {
    if (currentConfigError) throw currentConfigError;

    return currentConfig;
  }),
}));

vi.mock("@/lib/repo-source", async (original) => ({
  ...(await original<typeof import("@/lib/repo-source")>()),
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

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "projects_test",
  });

  db = testDatabase.db;

  tmpRoot = await mkdtemp(join(tmpdir(), "projects-register-"));
  withManifestDir = join(tmpRoot, "with-manifest");
  noManifestDir = join(tmpRoot, "no-manifest");
  await mkdir(withManifestDir, { recursive: true });
  await mkdir(noManifestDir, { recursive: true });
  await writeFile(join(withManifestDir, "maister.yaml"), "schemaVersion: 2\n");

  ({ POST } = await import("@/app/api/projects/route"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  currentConfig = seedConfig;
  currentConfigError = null;
  currentResolved = {
    dir: withManifestDir,
    repoUrl: null,
    provider: null,
    gitStatus: "no-remote",
    clonedByUs: false,
  };
  await rm(join(noManifestDir, "maister.yaml"), { force: true });
  await db.delete(schema.projects);
  await db.delete(schema.platformAcpRunners);
});

describe("POST /api/projects — runner validation (integration)", () => {
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
});

describe("POST /api/projects — maister.yaml bootstrap (integration)", () => {
  function req(body: Record<string, unknown>): NextRequest {
    return new NextRequest("http://localhost/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("registers validated DB defaults without creating a manifest", async () => {
    currentResolved = {
      dir: noManifestDir,
      repoUrl: null,
      provider: null,
      gitStatus: "no-remote",
      clonedByUs: false,
    };
    currentConfig = {
      ...seedConfig,
      project: { ...seedConfig.project, name: "no-manifest" },
      flows: [],
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
    expect(
      await db.select().from(schema.projectDependencyDeclarations),
    ).toHaveLength(0);
    await expect(
      readFile(join(noManifestDir, "maister.yaml"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

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
    currentConfig = {
      ...seedConfig,
      project: { ...seedConfig.project, name: "My Cool App" },
      flows: [],
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
    expect(
      await db.select().from(schema.projectDependencyDeclarations),
    ).toHaveLength(1);
  });

  // ADR-181 (RED 5): project.public_branch_template materializes at
  // registration with SET/CLEAR symmetry — a present value is stored, an
  // absent one is the column default (never a stale previous value).
  it("stores project.public_branch_template when the manifest sets it", async () => {
    currentConfig = {
      ...seedConfig,
      project: {
        ...seedConfig.project,
        public_branch_template: "wip/{task_key}-a{attempt}",
        task_qualification: "legacy",
      },
    };

    const res = await POST(req({ target: "ignored" }));

    expect(res.status).toBe(201);
    const rows = await projectRows("saga-proj");

    expect(rows).toHaveLength(1);
    expect(rows[0].publicBranchTemplate).toBe("wip/{task_key}-a{attempt}");
    expect(rows[0]).toMatchObject({
      taskQualificationBaseline: "required",
      taskQualificationOverride: "legacy",
    });
  });

  it("IT-UX-18 stores the default template when the manifest omits the key", async () => {
    const res = await POST(req({ target: "ignored" }));

    expect(res.status).toBe(201);
    const rows = await projectRows("saga-proj");

    expect(rows).toHaveLength(1);
    expect(rows[0].publicBranchTemplate).toBe("feature/{task_key}-{slug}");
    expect(rows[0]).toMatchObject({
      taskQualificationBaseline: "required",
      taskQualificationOverride: null,
    });
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
    currentConfig = {
      ...seedConfig,
      project: { ...seedConfig.project, name: "Fresh App" },
      flows: [],
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

  it("surfaces a classified clone failure as 409 with reason + detail", async () => {
    vi.mocked(resolveProjectSource).mockRejectedValueOnce(
      new MaisterError("PRECONDITION", "git clone failed: redacted stderr", {
        details: {
          reason: "SSH_AUTH",
          detail: "Permission denied (publickey).",
        },
      }),
    );

    const res = await POST(req({ repoUrl: "git@gitverse.ru:kaa/x.git" }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(body.reason).toBe("SSH_AUTH");
    expect(body.detail).toContain("Permission denied");
  });

  // [FIX] Codex F4: authenticate BEFORE parsing the body. An empty body fails
  // postBodySchema (no repoUrl/target) — a 422 if parsed first; auth-first makes
  // the 403 win, so the route contract is not leaked before the auth gate.
  it("authenticates before parsing the body (unauthorized + bad body → 403, not 422)", async () => {
    vi.mocked(requireGlobalRole).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "admin required"),
    );

    const res = await POST(req({}));

    expect(res.status).toBe(403);
  });

  // [FIX] Codex F3: a present-but-unreadable maister.yaml (stat ELOOP, not
  // ENOENT) MUST fail CONFIG, never silently fall back to DB-default registration.
  it("a present-but-unreadable maister.yaml fails CONFIG (no DB-default fallback)", async () => {
    const looped = await mkdtemp(join(tmpRoot, "eloop-"));

    await symlink("maister.yaml", join(looped, "maister.yaml"));
    currentResolved = {
      dir: looped,
      repoUrl: null,
      provider: null,
      gitStatus: "no-remote",
      clonedByUs: false,
    };

    const res = await POST(req({ target: "ignored" }));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });
});
