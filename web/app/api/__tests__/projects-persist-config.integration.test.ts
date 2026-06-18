import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
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
import { requireActiveSession } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { serializeProjectConfig } from "@/lib/packages/yaml-writeback";

const execFileAsync = promisify(execFile);
const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let tmpRoot: string;
let gitConfigStub: string;
let taskKeySeq = 0;

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "usr_admin",
    role: "admin",
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

let POST: typeof import("@/app/api/projects/[slug]/persist-config/route").POST;

function persistReq(body?: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/projects/p/persist-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function callPersist(
  slug: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return POST(persistReq(body), {
    params: Promise.resolve({ slug }),
  }) as unknown as Promise<Response>;
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args]);

  return stdout.trim();
}

// A temp git repo with controllable branch / author / initial-commit / dirtiness.
async function initRepo(opts: {
  branch?: string;
  author?: boolean;
  initialCommit?: boolean;
  dirty?: boolean;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpRoot, "repo-"));

  await git(dir, ["init", "-b", opts.branch ?? "main"]);
  if (opts.author) {
    await git(dir, ["config", "user.name", "Test User"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
  }
  if (opts.initialCommit) {
    await writeFile(join(dir, "README.md"), "# test\n");
    await git(dir, ["add", "README.md"]);
    await git(dir, [
      "-c",
      "user.name=seed",
      "-c",
      "user.email=seed@example.com",
      "commit",
      "-m",
      "init",
    ]);
  }
  if (opts.dirty) {
    await writeFile(join(dir, "dirty.txt"), "uncommitted\n");
  }

  return dir;
}

async function seedProject(opts: {
  repoPath: string;
  mainBranch?: string;
  maisterYamlPath?: string | null;
  name?: string;
}): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = `proj-${id.slice(0, 8)}`;

  taskKeySeq += 1;
  await db.insert(schema.projects).values({
    id,
    slug,
    name: opts.name ?? "My App",
    repoPath: opts.repoPath,
    mainBranch: opts.mainBranch ?? "main",
    branchPrefix: "maister/",
    maisterYamlPath: opts.maisterYamlPath ?? null,
    taskKey: `PCFG${taskKeySeq}`,
  });

  return { id, slug };
}

function expectedYaml(name = "My App"): string {
  return serializeProjectConfig(
    {
      name,
      mainBranch: "main",
      branchPrefix: "maister/",
      defaultRunnerId: null,
      promotionMode: null,
    },
    { flows: [], packages: [] },
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("persist_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  tmpRoot = await mkdtemp(join(tmpdir(), "persist-config-"));

  // Determinism: neutralize host global/system git config so a repo with no
  // LOCAL author config is genuinely "unset" (default-identity path), and a
  // repo WITH local config is genuinely "configured".
  gitConfigStub = join(tmpRoot, "gitconfig-empty");
  await writeFile(gitConfigStub, "");
  process.env.GIT_CONFIG_GLOBAL = gitConfigStub;
  process.env.GIT_CONFIG_SYSTEM = gitConfigStub;

  ({ POST } = await import("@/app/api/projects/[slug]/persist-config/route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.delete(schema.projects);
});

describe("POST /api/projects/[slug]/persist-config (ADR-093, integration)", () => {
  // [FIX] Codex F4: the session gate runs BEFORE the body is parsed. A bad body
  // (non-boolean push) would be a 422 if parsed first; auth-first makes the 401
  // win, so the route contract is not leaked before authentication.
  it("authenticates before parsing the body (unauthenticated + bad body → 401, not 422)", async () => {
    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "sign in"),
    );

    const res = await callPersist("any-slug", { push: "not-a-boolean" });

    expect(res.status).toBe(401);
  });

  it("happy path: writes + commits maister.yaml with the host author, flips the DB", async () => {
    const repo = await initRepo({ author: true, initialCommit: true });
    const { id, slug } = await seedProject({ repoPath: repo });

    const res = await callPersist(slug);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });

    // File materialized + committed, schema-valid, content == serializer output.
    const onDisk = await readFile(join(repo, "maister.yaml"), "utf8");

    expect(onDisk).toBe(expectedYaml());
    expect(await git(repo, ["show", "HEAD:maister.yaml"])).toBe(
      expectedYaml().trimEnd(),
    );
    // The configured host author was used — NOT the default identity.
    expect(await git(repo, ["log", "-1", "--format=%an|%ae"])).toBe(
      "Test User|test@example.com",
    );

    const rows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));

    expect(rows[0].maisterYamlPath).toBe(join(repo, "maister.yaml"));
  });

  it("unset author: commits with the default identity on an unborn HEAD and flags usedDefaultAuthor", async () => {
    // No initial commit -> unborn HEAD (the new-empty onboarding case); no
    // local author config + neutralized global/system -> unset.
    const repo = await initRepo({ author: false, initialCommit: false });
    const { id, slug } = await seedProject({ repoPath: repo });

    const res = await callPersist(slug);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, usedDefaultAuthor: true });
    expect(await git(repo, ["log", "-1", "--format=%an|%ae"])).toBe(
      "maister|noreply@maister.local",
    );

    const rows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));

    expect(rows[0].maisterYamlPath).toBe(join(repo, "maister.yaml"));
  });

  it("already persisted -> 409 CONFLICT", async () => {
    const repo = await initRepo({ author: true, initialCommit: true });
    const { slug } = await seedProject({
      repoPath: repo,
      maisterYamlPath: join(repo, "maister.yaml"),
    });

    const res = await callPersist(slug);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
  });

  it("wrong branch -> PRECONDITION, no write, DB stays null", async () => {
    const repo = await initRepo({
      author: true,
      initialCommit: true,
      branch: "develop",
    });
    const { id, slug } = await seedProject({
      repoPath: repo,
      mainBranch: "main",
    });

    const res = await callPersist(slug);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");

    const rows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));

    expect(rows[0].maisterYamlPath).toBeNull();
  });

  it("dirty tree -> PRECONDITION", async () => {
    const repo = await initRepo({
      author: true,
      initialCommit: true,
      dirty: true,
    });
    const { id, slug } = await seedProject({ repoPath: repo });

    const res = await callPersist(slug);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");

    const rows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));

    expect(rows[0].maisterYamlPath).toBeNull();
  });

  it("detached HEAD -> PRECONDITION", async () => {
    const repo = await initRepo({ author: true, initialCommit: true });

    await git(repo, ["checkout", "--detach"]);
    const { slug } = await seedProject({ repoPath: repo });

    const res = await callPersist(slug);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
  });

  it("an unrelated committed maister.yaml -> PRECONDITION (never clobbered)", async () => {
    const repo = await initRepo({ author: true, initialCommit: true });

    await writeFile(
      join(repo, "maister.yaml"),
      "schemaVersion: 2\nother: true\n",
    );
    await git(repo, ["add", "maister.yaml"]);
    await git(repo, [
      "-c",
      "user.name=seed",
      "-c",
      "user.email=seed@example.com",
      "commit",
      "-m",
      "unrelated yaml",
    ]);
    const { id, slug } = await seedProject({ repoPath: repo });

    const res = await callPersist(slug);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");

    const rows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));

    expect(rows[0].maisterYamlPath).toBeNull();
  });

  it("DB-flip-fail recovery: a committed identical file with a null column reconciles by flipping only", async () => {
    const repo = await initRepo({ author: true, initialCommit: true });

    // Simulate a prior persist that committed the file but crashed before the
    // DB flip: HEAD has the byte-identical serializer output, column is null.
    await writeFile(join(repo, "maister.yaml"), expectedYaml());
    await git(repo, ["add", "maister.yaml"]);
    await git(repo, [
      "-c",
      "user.name=seed",
      "-c",
      "user.email=seed@example.com",
      "commit",
      "-m",
      "persisted but crashed before flip",
    ]);
    const headBefore = await git(repo, ["rev-parse", "HEAD"]);
    const { id, slug } = await seedProject({ repoPath: repo });

    const res = await callPersist(slug);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });

    // Reconcile flips the DB only — NO new commit.
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(headBefore);

    const rows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));

    expect(rows[0].maisterYamlPath).toBe(join(repo, "maister.yaml"));
  });

  it("push requested but fails (no remote): 200 + pushWarning, DB still flipped", async () => {
    const repo = await initRepo({ author: true, initialCommit: true });
    const { id, slug } = await seedProject({ repoPath: repo });

    const res = await callPersist(slug, { push: true });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.pushWarning).toBe("string");
    expect(body.pushWarning.length).toBeGreaterThan(0);

    // Persist succeeded and is never rolled back by a push failure.
    const rows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));

    expect(rows[0].maisterYamlPath).toBe(join(repo, "maister.yaml"));
    expect(await git(repo, ["show", "HEAD:maister.yaml"])).toBe(
      expectedYaml().trimEnd(),
    );
  });
});
