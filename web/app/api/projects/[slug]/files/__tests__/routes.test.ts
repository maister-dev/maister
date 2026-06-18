// M22 Phase 4a: unit tests for the project-repo file (dir-listing) route.
// (ADR-066 / T1.6b retired the sibling `…/files/content` route — its blob read
// moved into the project-board RSC `?file=` pane — so the content-route tests
// are gone; the dir-listing route still backs the client file tree.)
//
// Contract:
//   GET /api/projects/[slug]/files          (list)
//
// Flow, mirror of the run file route but keyed by slug:
//   requireActiveSession()
//   project = getProjectBySlug(slug);
//     !project || project.archivedAt → bare 404 {message}
//   requireProjectAction(project.id, "readRepoFiles")
//   read ?path (default "" root) and ?ref (default project.mainBranch)
//   non-empty path → repoRelPathSchema (reject → 400 {code:"CONFIG"})
//   listTree({repo: project.repoPath, ref, dir: path})
//              → null → 404 ; else 200 {path, entries}
//
// authz / queries / instance-config mocked at the module boundary; the REAL
// repoRelPathSchema is kept so a `../` path 400s BEFORE listTree.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { getProjectBySlug } from "@/lib/queries/project";
import { listTree } from "@/lib/worktree";

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

async function invokeList(slug: string, path?: string, ref?: string) {
  const { GET } = await import("../route");
  const params = new URLSearchParams();

  if (path !== undefined) params.set("path", path);
  if (ref !== undefined) params.set("ref", ref);
  const query = params.toString();
  const url = query
    ? `http://localhost/api/projects/${slug}/files?${query}`
    : `http://localhost/api/projects/${slug}/files`;
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

  it("passes ?ref through to listTree (browse a non-default branch)", async () => {
    vi.mocked(listTree).mockResolvedValue({ path: "", entries: [] });

    await invokeList(SLUG, undefined, "feature-x");

    expect(listTree).toHaveBeenCalledWith({
      repo: REPO_PATH,
      ref: "feature-x",
      dir: "",
    });
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
