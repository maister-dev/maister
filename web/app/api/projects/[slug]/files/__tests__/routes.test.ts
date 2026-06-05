// M22 Phase 4a (RED): failing unit tests for the project-repo file routes.
//
// Contract (NOT yet built — RED on the missing `../route` + `../content/route`):
//   GET /api/projects/[slug]/files          (list)
//   GET /api/projects/[slug]/files/content  (content)
//
// Flow (both routes), mirror of the run file routes but keyed by slug:
//   requireActiveSession()
//   project = getProjectBySlug(slug);
//     !project || project.archivedAt → bare 404 {message}
//   requireProjectAction(project.id, "readRepoFiles")
//   read ?path; list default "", content REQUIRED (missing → 400 CONFIG)
//   non-empty path → repoRelPathSchema (reject → 400 {code:"CONFIG"})
//   list:    listTree({repo: project.repoPath, ref: project.mainBranch, dir: path})
//              → null → 404 ; else 200 {path, entries}
//   content: readBlob({repo: project.repoPath, ref: project.mainBranch, path,
//              maxBytes: workbenchMaxFileBytes()})
//              not-found → 404; too-large → 413; binary → 415; text → 200.
//
// authz / queries / instance-config mocked at the module boundary; the REAL
// repoRelPathSchema is kept so a `../` path 400s BEFORE listTree/readBlob.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { getProjectBySlug } from "@/lib/queries/project";
import { listTree, readBlob } from "@/lib/worktree";

const SLUG = "demo";
const PROJECT_ID = "project-1";
const REPO_PATH = "/repos/demo";
const MAIN_BRANCH = "main";

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    slug: SLUG,
    name: "Demo",
    repoPath: REPO_PATH,
    mainBranch: MAIN_BRANCH,
    archivedAt: null,
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof getProjectBySlug>>;
}

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => ({
    user: {
      id: "user-1",
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "member",
  })),
}));

vi.mock("@/lib/queries/project", () => ({
  getProjectBySlug: vi.fn(),
}));

vi.mock("@/lib/worktree", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/worktree")>("@/lib/worktree");

  return {
    repoRelPathSchema: actual.repoRelPathSchema,
    listTree: vi.fn(),
    readBlob: vi.fn(),
  };
});

vi.mock("@/lib/instance-config", () => ({
  workbenchMaxFileBytes: vi.fn(() => 524288),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireActiveSession).mockResolvedValue({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  });
  vi.mocked(requireProjectAction).mockResolvedValue({
    user: {
      id: "user-1",
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "member",
  });
  vi.mocked(getProjectBySlug).mockResolvedValue(projectRow());
});

async function invokeList(slug: string, path?: string) {
  const { GET } = await import("../route");
  const url =
    path === undefined
      ? `http://localhost/api/projects/${slug}/files`
      : `http://localhost/api/projects/${slug}/files?path=${encodeURIComponent(path)}`;
  const req = new NextRequest(new Request(url, { method: "GET" }));

  return GET(req, { params: Promise.resolve({ slug }) });
}

async function invokeContent(slug: string, path?: string) {
  const { GET } = await import("../content/route");
  const url =
    path === undefined
      ? `http://localhost/api/projects/${slug}/files/content`
      : `http://localhost/api/projects/${slug}/files/content?path=${encodeURIComponent(path)}`;
  const req = new NextRequest(new Request(url, { method: "GET" }));

  return GET(req, { params: Promise.resolve({ slug }) });
}

describe("GET /api/projects/[slug]/files (list)", () => {
  it("returns 200 {path, entries} and calls listTree with project repo+mainBranch", async () => {
    vi.mocked(listTree).mockResolvedValue({
      path: "",
      entries: [
        { name: "src", type: "dir" },
        { name: "README.md", type: "file" },
      ],
    });

    const res = await invokeList(SLUG);
    const body = (await res.json()) as {
      path: string;
      entries: { name: string; type: string }[];
    };

    expect(res.status).toBe(200);
    expect(listTree).toHaveBeenCalledWith({
      repo: REPO_PATH,
      ref: MAIN_BRANCH,
      dir: "",
    });
    expect(body.entries).toHaveLength(2);
  });

  it("returns 404 when the project does not exist", async () => {
    vi.mocked(getProjectBySlug).mockResolvedValue(null);

    const res = await invokeList(SLUG);

    expect(res.status).toBe(404);
    expect(listTree).not.toHaveBeenCalled();
  });

  it("returns 404 when the project is archived", async () => {
    vi.mocked(getProjectBySlug).mockResolvedValue(
      projectRow({ archivedAt: new Date() }),
    );

    const res = await invokeList(SLUG);

    expect(res.status).toBe(404);
    expect(listTree).not.toHaveBeenCalled();
  });

  it("returns 404 when listTree resolves null (dir not in the tracked tree)", async () => {
    vi.mocked(listTree).mockResolvedValue(null);

    const res = await invokeList(SLUG, ".git");

    expect(res.status).toBe(404);
  });

  it("returns 403 when a viewer is denied (requireProjectAction UNAUTHORIZED)", async () => {
    vi.mocked(requireProjectAction).mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "not a project member"),
    );

    const res = await invokeList(SLUG);

    expect(res.status).toBe(403);
    expect(listTree).not.toHaveBeenCalled();
  });

  it("returns 401 when requireActiveSession rejects UNAUTHENTICATED", async () => {
    vi.mocked(requireActiveSession).mockRejectedValue(
      new MaisterError("UNAUTHENTICATED", "no session"),
    );

    const res = await invokeList(SLUG);

    expect(res.status).toBe(401);
    expect(listTree).not.toHaveBeenCalled();
  });

  it("returns 400 CONFIG for a `../` traversal path before listTree", async () => {
    const res = await invokeList(SLUG, "../etc");
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("CONFIG");
    expect(listTree).not.toHaveBeenCalled();
  });

  it("authorizes with (project.id, 'readRepoFiles')", async () => {
    vi.mocked(listTree).mockResolvedValue({ path: "", entries: [] });

    await invokeList(SLUG);

    expect(requireProjectAction).toHaveBeenCalledWith(
      PROJECT_ID,
      "readRepoFiles",
    );
  });
});

describe("GET /api/projects/[slug]/files/content", () => {
  it("returns 200 {kind:'text',content} and calls readBlob with project repo+mainBranch", async () => {
    vi.mocked(readBlob).mockResolvedValue({
      kind: "text",
      content: "# Demo\n",
    });

    const res = await invokeContent(SLUG, "README.md");
    const body = (await res.json()) as { kind: string; content: string };

    expect(res.status).toBe(200);
    expect(readBlob).toHaveBeenCalledWith({
      repo: REPO_PATH,
      ref: MAIN_BRANCH,
      path: "README.md",
      maxBytes: 524288,
    });
    expect(body.kind).toBe("text");
    expect(body.content).toBe("# Demo\n");
  });

  it("returns 404 when readBlob resolves not-found", async () => {
    vi.mocked(readBlob).mockResolvedValue({ kind: "not-found" });

    const res = await invokeContent(SLUG, "missing.txt");

    expect(res.status).toBe(404);
  });

  it("returns 413 {kind:'too-large',size} when the blob is over the cap", async () => {
    vi.mocked(readBlob).mockResolvedValue({ kind: "too-large", size: 700000 });

    const res = await invokeContent(SLUG, "big.bin");
    const body = (await res.json()) as { kind: string; size: number };

    expect(res.status).toBe(413);
    expect(body.kind).toBe("too-large");
    expect(body.size).toBe(700000);
  });

  it("returns 415 {kind:'binary'} for a binary blob", async () => {
    vi.mocked(readBlob).mockResolvedValue({ kind: "binary" });

    const res = await invokeContent(SLUG, "logo.png");
    const body = (await res.json()) as { kind: string };

    expect(res.status).toBe(415);
    expect(body.kind).toBe("binary");
  });

  it("returns 400 CONFIG when ?path is missing (content requires a path)", async () => {
    const res = await invokeContent(SLUG);
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("CONFIG");
    expect(readBlob).not.toHaveBeenCalled();
  });

  it("returns 400 CONFIG for a `../` traversal path before readBlob", async () => {
    const res = await invokeContent(SLUG, "../secret");
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("CONFIG");
    expect(readBlob).not.toHaveBeenCalled();
  });

  it("returns 403 when a viewer is denied (requireProjectAction UNAUTHORIZED)", async () => {
    vi.mocked(requireProjectAction).mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "not a project member"),
    );

    const res = await invokeContent(SLUG, "README.md");

    expect(res.status).toBe(403);
    expect(readBlob).not.toHaveBeenCalled();
  });

  it("returns 404 when the project does not exist", async () => {
    vi.mocked(getProjectBySlug).mockResolvedValue(null);

    const res = await invokeContent(SLUG, "README.md");

    expect(res.status).toBe(404);
    expect(readBlob).not.toHaveBeenCalled();
  });

  it("returns 404 when the project is archived", async () => {
    vi.mocked(getProjectBySlug).mockResolvedValue(
      projectRow({ archivedAt: new Date() }),
    );

    const res = await invokeContent(SLUG, "README.md");

    expect(res.status).toBe(404);
    expect(readBlob).not.toHaveBeenCalled();
  });

  it("authorizes with (project.id, 'readRepoFiles')", async () => {
    vi.mocked(readBlob).mockResolvedValue({ kind: "text", content: "x" });

    await invokeContent(SLUG, "a.txt");

    expect(requireProjectAction).toHaveBeenCalledWith(
      PROJECT_ID,
      "readRepoFiles",
    );
  });
});
