import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
import { MaisterError } from "@/lib/errors";
import {
  addProjectRemote,
  listProjectRemotes,
  reconcileOriginRepoUrl,
  removeProjectRemote,
  setProjectRemoteUrl,
} from "@/lib/git-remotes";

const execFileAsync = promisify(execFile);
const schema = schemaModule as unknown as Record<string, any>;

// Controllable authz mock (vi.hoisted so it exists before the hoisted vi.mock).
const { mockRequireProjectAction } = vi.hoisted(() => ({
  mockRequireProjectAction: vi.fn(async () => undefined),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "usr_admin",
    role: "admin",
    mustChangePassword: false,
  })),
  requireProjectAction: mockRequireProjectAction,
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let tmpRoot: string;
let taskKeySeq = 0;
let route: typeof import("@/app/api/projects/[slug]/remotes/route");

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args]);

  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpRoot, "repo-"));

  await git(dir, ["init", "-b", "main"]);

  return dir;
}

async function seedProject(
  repoPath: string,
): Promise<{ id: string; slug: string; repoPath: string }> {
  const id = randomUUID();
  const slug = `proj-${id.slice(0, 8)}`;

  taskKeySeq += 1;
  await db.insert(schema.projects).values({
    id,
    slug,
    name: "Remotes App",
    repoPath,
    taskKey: `RMT${taskKeySeq}`,
  });

  return { id, slug, repoPath };
}

async function projectRow(id: string) {
  const rows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, id));

  return rows[0];
}

function remotesReq(
  method: string,
  body?: Record<string, unknown>,
): NextRequest {
  return new NextRequest("http://localhost/api/projects/p/remotes", {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("remotes_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  tmpRoot = await mkdtemp(join(tmpdir(), "projects-remotes-"));
  route = await import("@/app/api/projects/[slug]/remotes/route");
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  mockRequireProjectAction.mockReset();
  mockRequireProjectAction.mockResolvedValue(undefined);
  await db.delete(schema.projects);
});

describe("git-remotes orchestrator (ADR-093, integration)", () => {
  it("adds origin, redacts creds in the DB cache, and detects the provider", async () => {
    const repo = await initRepo();
    const project = await seedProject(repo);

    await addProjectRemote({
      db,
      project,
      name: "origin",
      url: "https://user:tok@github.com/org/app.git",
    });

    // Git stores the URL verbatim (the user's repo config).
    expect(await git(repo, ["remote", "get-url", "origin"])).toBe(
      "https://user:tok@github.com/org/app.git",
    );

    // The DB cache is redacted + provider-detected.
    const row = await projectRow(project.id);

    expect(row.repoUrl).toBe("https://user:***@github.com/org/app.git");
    expect(row.provider).toBe("github");

    // The list redacts too.
    expect(await listProjectRemotes(repo)).toEqual([
      { name: "origin", url: "https://user:***@github.com/org/app.git" },
    ]);
  });

  it("set-url on origin updates git and the DB cache", async () => {
    const repo = await initRepo();
    const project = await seedProject(repo);

    await addProjectRemote({
      db,
      project,
      name: "origin",
      url: "https://github.com/org/old.git",
    });
    await setProjectRemoteUrl({
      db,
      project,
      name: "origin",
      url: "https://gitlab.com/org/new.git",
    });

    expect(await git(repo, ["remote", "get-url", "origin"])).toBe(
      "https://gitlab.com/org/new.git",
    );
    const row = await projectRow(project.id);

    expect(row.repoUrl).toBe("https://gitlab.com/org/new.git");
    expect(row.provider).toBe("gitlab");
  });

  it("removing origin nulls the DB cache (SET/CLEAR symmetry)", async () => {
    const repo = await initRepo();
    const project = await seedProject(repo);

    await addProjectRemote({
      db,
      project,
      name: "origin",
      url: "https://github.com/org/app.git",
    });
    await removeProjectRemote({ db, project, name: "origin" });

    await expect(git(repo, ["remote", "get-url", "origin"])).rejects.toThrow();
    const row = await projectRow(project.id);

    expect(row.repoUrl).toBeNull();
    expect(row.provider).toBeNull();
  });

  it("a non-origin remote never touches the DB cache", async () => {
    const repo = await initRepo();
    const project = await seedProject(repo);

    await addProjectRemote({
      db,
      project,
      name: "upstream",
      url: "https://github.com/upstream/app.git",
    });

    expect(await git(repo, ["remote", "get-url", "upstream"])).toBe(
      "https://github.com/upstream/app.git",
    );
    const row = await projectRow(project.id);

    expect(row.repoUrl).toBeNull();
    expect(row.provider).toBeNull();
  });

  it("self-heals a null cache from git's live origin (DB-fail-after-git window)", async () => {
    const repo = await initRepo();
    const project = await seedProject(repo);

    // Simulate the crash window: git has origin, the DB write never landed.
    await git(repo, [
      "remote",
      "add",
      "origin",
      "https://github.com/org/healed.git",
    ]);
    let row = await projectRow(project.id);

    expect(row.repoUrl).toBeNull();

    const healed = await reconcileOriginRepoUrl({
      db,
      project: { ...project, repoUrl: row.repoUrl },
    });

    expect(healed).toBe("https://github.com/org/healed.git");
    row = await projectRow(project.id);
    expect(row.repoUrl).toBe("https://github.com/org/healed.git");
    expect(row.provider).toBe("github");
  });
});

describe("POST/GET/PATCH/DELETE /api/projects/[slug]/remotes (route, integration)", () => {
  it("403 when the viewer cannot editSettings", async () => {
    const repo = await initRepo();
    const { slug } = await seedProject(repo);

    mockRequireProjectAction.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "forbidden"),
    );

    const res = await route.POST(
      remotesReq("POST", { name: "origin", url: "https://github.com/o/r.git" }),
      { params: Promise.resolve({ slug }) },
    );

    expect(res.status).toBe(403);
  });

  it("POST add origin → 201 + redacted echo + DB sync", async () => {
    const repo = await initRepo();
    const { id, slug } = await seedProject(repo);

    const res = await route.POST(
      remotesReq("POST", {
        name: "origin",
        url: "https://u:tok@github.com/o/r.git",
      }),
      { params: Promise.resolve({ slug }) },
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual({
      ok: true,
      remote: { name: "origin", url: "https://u:***@github.com/o/r.git" },
    });
    const row = await projectRow(id);

    expect(row.repoUrl).toBe("https://u:***@github.com/o/r.git");
    expect(row.provider).toBe("github");
  });

  it("POST add with a bad remote name → 409 PRECONDITION", async () => {
    const repo = await initRepo();
    const { slug } = await seedProject(repo);

    const res = await route.POST(
      remotesReq("POST", { name: "-bad", url: "https://github.com/o/r.git" }),
      { params: Promise.resolve({ slug }) },
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
  });

  it("POST malformed body (neither add nor action) → 422 CONFIG", async () => {
    const repo = await initRepo();
    const { slug } = await seedProject(repo);

    const res = await route.POST(remotesReq("POST", { nope: 1 }), {
      params: Promise.resolve({ slug }),
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("POST push action that fails → 200 + advisory warning, DB never rolled back", async () => {
    const repo = await initRepo();
    const { id, slug } = await seedProject(repo);

    // Add an origin pointing at a non-existent local repo → push fails fast
    // (no network), proving the advisory path. file:// is scheme-allow-listed.
    await route.POST(
      remotesReq("POST", {
        name: "origin",
        url: "file:///nonexistent/maister-remote-xyz.git",
      }),
      { params: Promise.resolve({ slug }) },
    );

    const res = await route.POST(
      remotesReq("POST", { op: "push", name: "origin", branch: "main" }),
      { params: Promise.resolve({ slug }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.warning).toBe("string");

    // The origin add already wrote the cache; the failed push leaves it intact.
    const row = await projectRow(id);

    expect(row.repoUrl).toBe("file:///nonexistent/maister-remote-xyz.git");
  });

  it("POST push without a branch → 422 CONFIG", async () => {
    const repo = await initRepo();
    const { slug } = await seedProject(repo);

    const res = await route.POST(
      remotesReq("POST", { op: "push", name: "origin" }),
      { params: Promise.resolve({ slug }) },
    );
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  // [FIX] Codex F2: an action on an UNKNOWN remote is a 409 PRECONDITION, not a
  // 200 "success with warning" — invalid input must never read as success.
  it("POST push to an unknown remote → 409 PRECONDITION (not an advisory)", async () => {
    const repo = await initRepo();
    const { slug } = await seedProject(repo);

    const res = await route.POST(
      remotesReq("POST", { op: "push", name: "origin", branch: "main" }),
      { params: Promise.resolve({ slug }) },
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
  });

  it("POST fetch on an unknown remote → 409 PRECONDITION", async () => {
    const repo = await initRepo();
    const { slug } = await seedProject(repo);

    const res = await route.POST(
      remotesReq("POST", { op: "fetch", name: "nope" }),
      { params: Promise.resolve({ slug }) },
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
  });

  it("POST push action with an invalid remote name → 409 PRECONDITION", async () => {
    const repo = await initRepo();
    const { slug } = await seedProject(repo);

    const res = await route.POST(
      remotesReq("POST", { op: "push", name: "-bad", branch: "main" }),
      { params: Promise.resolve({ slug }) },
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
  });

  it("GET lists remotes (redacted) and heals the origin cache", async () => {
    const repo = await initRepo();
    const { id, slug } = await seedProject(repo);

    // origin added directly in git (DB cache stays null) → GET heals it.
    await git(repo, [
      "remote",
      "add",
      "origin",
      "https://u:tok@github.com/o/r.git",
    ]);

    const res = await route.GET(remotesReq("GET"), {
      params: Promise.resolve({ slug }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.remotes).toEqual([
      { name: "origin", url: "https://u:***@github.com/o/r.git" },
    ]);
    // Heal-on-read populated the cache.
    expect((await projectRow(id)).repoUrl).toBe(
      "https://u:***@github.com/o/r.git",
    );
  });

  it("PATCH set-url → 200 + redacted echo; DELETE remove → 200 + cache nulled", async () => {
    const repo = await initRepo();
    const { id, slug } = await seedProject(repo);

    await route.POST(
      remotesReq("POST", {
        name: "origin",
        url: "https://github.com/o/old.git",
      }),
      { params: Promise.resolve({ slug }) },
    );

    const patchRes = await route.PATCH(
      remotesReq("PATCH", {
        name: "origin",
        url: "https://github.com/o/new.git",
      }),
      { params: Promise.resolve({ slug }) },
    );
    const patchBody = await patchRes.json();

    expect(patchRes.status).toBe(200);
    expect(patchBody.remote.url).toBe("https://github.com/o/new.git");
    expect((await projectRow(id)).repoUrl).toBe("https://github.com/o/new.git");

    const delRes = await route.DELETE(
      remotesReq("DELETE", { name: "origin" }),
      { params: Promise.resolve({ slug }) },
    );

    expect(delRes.status).toBe(200);
    expect((await projectRow(id)).repoUrl).toBeNull();
  });
});
