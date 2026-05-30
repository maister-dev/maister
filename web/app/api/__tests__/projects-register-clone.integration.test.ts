import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let reposRoot: string;

// The seeded bootstrap admin (migration 0005) is the FK target for the owner
// membership; requireGlobalRole is mocked to return it (avoids @/auth →
// next-auth in the Vitest module graph). DB client is mocked to the
// testcontainer db. Everything else (@/lib/repo-source, @/lib/config,
// @/lib/flows) runs REAL — this test exercises real git source resolution.
const ADMIN_ID = "usr_bootstrap_admin";

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: vi.fn(async () => ({
    id: ADMIN_ID,
    role: "admin",
    mustChangePassword: false,
  })),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

let POST: typeof import("@/app/api/projects/route").POST;

const GIT_IDENT = [
  "-c",
  "user.email=t@t",
  "-c",
  "user.name=t",
  "-c",
  "init.defaultBranch=main",
];

function maisterYaml(name: string, withRepoPath: boolean): string {
  const repoPathLine = withRepoPath ? `  repo_path: /repos/x\n` : "";

  return [
    "schemaVersion: 2",
    "project:",
    `  name: ${name}`,
    repoPathLine.trimEnd(),
    "  main_branch: main",
    "  branch_prefix: maister/",
    "executors:",
    "  - id: claude-sonnet",
    "    agent: claude",
    "    model: claude-sonnet-4-6",
    "default_executor: claude-sonnet",
    "flows: []",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

async function writeMaisterYaml(
  dir: string,
  name: string,
  withRepoPath: boolean,
): Promise<void> {
  await writeFile(join(dir, "maister.yaml"), maisterYaml(name, withRepoPath));
}

// Build a local bare repo with a committed maister.yaml. Mirrors the
// "git init work, commit, clone --bare" pattern — fully offline, no network.
async function buildBareRepo(
  name: string,
  projectName: string,
): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "maister-work-"));

  execFileSync("git", [...GIT_IDENT, "init", work], { stdio: "pipe" });
  await writeMaisterYaml(work, projectName, false);
  execFileSync("git", ["-C", work, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", work, ...GIT_IDENT, "commit", "-m", "init"], {
    stdio: "pipe",
  });

  const bareParent = await mkdtemp(join(tmpdir(), "maister-bare-"));
  const bare = join(bareParent, `${name}.git`);

  execFileSync("git", ["clone", "--bare", work, bare], { stdio: "pipe" });
  await rm(work, { recursive: true, force: true });

  return bare;
}

// Like buildBareRepo but commits arbitrary (possibly invalid) maister.yaml
// content — used to fail a post-clone step and exercise clone compensation.
async function buildBareRepoRaw(name: string, yaml: string): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "maister-work-"));

  execFileSync("git", [...GIT_IDENT, "init", work], { stdio: "pipe" });
  await writeFile(join(work, "maister.yaml"), yaml);
  execFileSync("git", ["-C", work, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", work, ...GIT_IDENT, "commit", "-m", "init"], {
    stdio: "pipe",
  });

  const bareParent = await mkdtemp(join(tmpdir(), "maister-bare-"));
  const bare = join(bareParent, `${name}.git`);

  execFileSync("git", ["clone", "--bare", work, bare], { stdio: "pipe" });
  await rm(work, { recursive: true, force: true });

  return bare;
}

function request(payload: { repoUrl?: string; target?: string }): NextRequest {
  return new NextRequest("http://localhost/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function projectRow(slug: string) {
  const rows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.slug, slug));

  return rows[0];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);

    return true;
  } catch {
    return false;
  }
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

  reposRoot = await mkdtemp(join(tmpdir(), "maister-repos-"));
  process.env.MAISTER_REPOS_ROOT = reposRoot;

  ({ POST } = await import("@/app/api/projects/route"));
}, 180_000);

afterAll(async () => {
  delete process.env.MAISTER_REPOS_ROOT;
  await rm(reposRoot, { recursive: true, force: true }).catch(() => {});
  await pool?.end();
  await container?.stop();
});

describe("POST /api/projects — real source resolution (integration)", () => {
  it("clone success: clones a file:// bare repo, derives repo_path, provider=generic", async () => {
    const bare = await buildBareRepo("clone-success", "Clone Success Proj");
    const derivedName = basename(bare).replace(/\.git$/, "");
    const repoUrl = `file://${bare}`;

    const res = await POST(request({ repoUrl }));

    expect(res.status).toBe(201);

    const body = await res.json();

    expect(body.gitStatus).toBe("remote");
    expect(body.slug).toBe("clone-success-proj");

    const row = await projectRow("clone-success-proj");

    expect(row.repoUrl).toBe(repoUrl);
    expect(row.provider).toBe("generic");
    expect(row.repoPath).toBe(join(reposRoot, derivedName));

    expect(await pathExists(join(reposRoot, derivedName))).toBe(true);
    expect(await pathExists(join(reposRoot, derivedName, "maister.yaml"))).toBe(
      true,
    );
  });

  it("clone target exists → 409 PRECONDITION, no project row", async () => {
    const bare = await buildBareRepo("collide", "Collide Proj");
    const derivedName = basename(bare).replace(/\.git$/, "");

    // Pre-create the would-be clone target so resolveProjectSource refuses.
    await mkdir(join(reposRoot, derivedName), { recursive: true });

    const res = await POST(request({ repoUrl: `file://${bare}` }));

    expect(res.status).toBe(409);

    const body = await res.json();

    expect(body.code).toBe("PRECONDITION");
    expect(await projectRow("collide-proj")).toBeUndefined();
  });

  it("clone succeeds but a post-clone step fails → clone is removed (compensation)", async () => {
    // Clone succeeds (clonedByUs=true), then loadProjectConfig rejects the
    // invalid maister.yaml → the route's clonedByUs catch must rm the clone.
    const bare = await buildBareRepoRaw("badcfg", "schemaVersion: 99\n");
    const derivedName = basename(bare).replace(/\.git$/, "");

    // Sanity: the clone target does not exist before the request.
    expect(await pathExists(join(reposRoot, derivedName))).toBe(false);

    const res = await POST(request({ repoUrl: `file://${bare}` }));

    expect(res.status).toBe(422);

    const body = await res.json();

    expect(body.code).toBe("CONFIG");
    // The clone happened (CONFIG is thrown only after resolveProjectSource
    // cloned) and was rolled back — no leftover dir under reposRoot.
    expect(await pathExists(join(reposRoot, derivedName))).toBe(false);
  });

  it("existing-local with remote: resolves origin url, provider=github", async () => {
    const dir = join(reposRoot, "local-remote");

    await mkdir(dir, { recursive: true });
    execFileSync("git", [...GIT_IDENT, "init", dir], { stdio: "pipe" });
    await writeMaisterYaml(dir, "Local Remote Proj", false);
    execFileSync("git", ["-C", dir, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", dir, ...GIT_IDENT, "commit", "-m", "init"], {
      stdio: "pipe",
    });
    execFileSync(
      "git",
      [
        "-C",
        dir,
        "remote",
        "add",
        "origin",
        "https://github.com/acme/widget.git",
      ],
      { stdio: "pipe" },
    );

    const res = await POST(request({ target: "local-remote" }));

    expect(res.status).toBe(201);

    const body = await res.json();

    expect(body.gitStatus).toBe("remote");

    const row = await projectRow("local-remote-proj");

    expect(row.repoUrl).toBe("https://github.com/acme/widget.git");
    expect(row.provider).toBe("github");
  });

  it("existing-local non-git → initialized, repoUrl/provider null, dir becomes a git repo", async () => {
    const dir = join(reposRoot, "plain-dir");

    await mkdir(dir, { recursive: true });
    await writeMaisterYaml(dir, "Plain Dir Proj", false);

    const res = await POST(request({ target: "plain-dir" }));

    expect(res.status).toBe(201);

    const body = await res.json();

    expect(body.gitStatus).toBe("initialized");

    const row = await projectRow("plain-dir-proj");

    expect(row.repoUrl).toBeNull();
    expect(row.provider).toBeNull();
    expect(await pathExists(join(dir, ".git"))).toBe(true);
  });

  it("existing-local non-git + invalid maister.yaml → 422, dir NOT mutated (init deferred)", async () => {
    const dir = join(reposRoot, "plain-invalid");

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "maister.yaml"), "schemaVersion: 99\n");

    const res = await POST(request({ target: "plain-invalid" }));

    expect(res.status).toBe(422);

    const body = await res.json();

    expect(body.code).toBe("CONFIG");
    // The manifest is validated before any git init, so the operator's
    // directory must be left untouched — no .git created on a failed register.
    expect(await pathExists(join(dir, ".git"))).toBe(false);
  });

  it("existing-local git no remote → no-remote, repoUrl/provider null", async () => {
    const dir = join(reposRoot, "no-remote-dir");

    await mkdir(dir, { recursive: true });
    execFileSync("git", [...GIT_IDENT, "init", dir], { stdio: "pipe" });
    await writeMaisterYaml(dir, "No Remote Proj", false);
    execFileSync("git", ["-C", dir, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", dir, ...GIT_IDENT, "commit", "-m", "init"], {
      stdio: "pipe",
    });

    const res = await POST(request({ target: "no-remote-dir" }));

    expect(res.status).toBe(201);

    const body = await res.json();

    expect(body.gitStatus).toBe("no-remote");

    const row = await projectRow("no-remote-proj");

    expect(row.repoUrl).toBeNull();
    expect(row.provider).toBeNull();
  });
});
