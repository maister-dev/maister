// M22 Phase 4a: unit tests for the run-workbench file (dir-listing) route.
// (ADR-066 / T1.6b retired the sibling `…/files/content` route — its blob read
// moved into the run-detail RSC `?file=` page — so the content-route tests are
// gone; the dir-listing route still backs the client file tree.)
//
// Contract:
//   GET /api/runs/[runId]/files          (list)
//
// Flow:
//   requireActiveSession()
//   detail = getRunDetail(runId); !detail → bare 404 {message}
//   requireProjectAction(detail.projectId, "readRepoFiles")
//   read ?path from new URL(req.url).searchParams.get("path") (default "" root)
//   non-empty path → repoRelPathSchema (reject → 400 {code:"CONFIG"})
//   listTree({repo: detail.worktreePath, ref: detail.branch, dir: path})
//              → null → 404 ; else 200 {path, entries}
//   local httpStatusForCode: CONFIG→400, UNAUTHENTICATED→401,
//     UNAUTHORIZED/PASSWORD_CHANGE_REQUIRED/ACCOUNT_INACTIVE→403, else 500.
//
// authz / queries / instance-config are mocked at the module boundary; the REAL
// repoRelPathSchema is kept so a `../` path is rejected 400 BEFORE listTree is
// reached.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { getRunDetail } from "@/lib/queries/run";
import { listTree } from "@/lib/worktree";

const RUN_ID = "run-files-1";
const PROJECT_ID = "project-1";
const WORKTREE_PATH = "/repos/demo/.maister/worktrees/run-files-1";
const BRANCH = "maister/task-1-attempt-1";

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

vi.mock("@/lib/queries/run", () => ({
  getRunDetail: vi.fn(async () => ({
    runId: RUN_ID,
    projectId: PROJECT_ID,
    projectSlug: "demo",
    status: "Running",
    currentStepId: null,
    branch: BRANCH,
    worktreePath: WORKTREE_PATH,
    agent: "claude",
  })),
}));

// Keep the REAL repoRelPathSchema (so a `../` path 400s before listTree);
// stub only the git tree reader.
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
  vi.mocked(getRunDetail).mockResolvedValue({
    runId: RUN_ID,
    projectId: PROJECT_ID,
    projectSlug: "demo",
    status: "Running",
    currentStepId: null,
    branch: BRANCH,
    worktreePath: WORKTREE_PATH,
    agent: "claude",
  } as unknown as Awaited<ReturnType<typeof getRunDetail>>);
});

async function invokeList(runId: string, path?: string) {
  const { GET } = await import("../route");
  const url =
    path === undefined
      ? `http://localhost/api/runs/${runId}/files`
      : `http://localhost/api/runs/${runId}/files?path=${encodeURIComponent(path)}`;
  const req = new NextRequest(new Request(url, { method: "GET" }));

  return GET(req, { params: Promise.resolve({ runId }) });
}

describe("GET /api/runs/[runId]/files (list)", () => {
  it("returns 200 {path, entries} and calls listTree with server-state repo+ref", async () => {
    vi.mocked(listTree).mockResolvedValue({
      path: "src",
      entries: [
        { name: "lib", type: "dir" },
        { name: "index.ts", type: "file" },
      ],
    });

    const res = await invokeList(RUN_ID, "src");
    const body = (await res.json()) as {
      path: string;
      entries: { name: string; type: string }[];
    };

    expect(res.status).toBe(200);
    expect(listTree).toHaveBeenCalledWith({
      repo: WORKTREE_PATH,
      ref: BRANCH,
      dir: "src",
    });
    expect(body.path).toBe("src");
    expect(body.entries).toHaveLength(2);
  });

  it("defaults to the repo root (dir: '') when ?path is absent", async () => {
    vi.mocked(listTree).mockResolvedValue({ path: "", entries: [] });

    const res = await invokeList(RUN_ID);

    expect(res.status).toBe(200);
    expect(listTree).toHaveBeenCalledWith({
      repo: WORKTREE_PATH,
      ref: BRANCH,
      dir: "",
    });
  });

  it("returns 404 when the run does not exist", async () => {
    vi.mocked(getRunDetail).mockResolvedValue(null);

    const res = await invokeList(RUN_ID, "src");

    expect(res.status).toBe(404);
    expect(listTree).not.toHaveBeenCalled();
  });

  it("returns 404 when listTree resolves null (dir not in the tracked tree)", async () => {
    vi.mocked(listTree).mockResolvedValue(null);

    const res = await invokeList(RUN_ID, ".git");

    expect(res.status).toBe(404);
  });

  it("returns 403 when requireProjectAction rejects UNAUTHORIZED (viewer denied)", async () => {
    vi.mocked(requireProjectAction).mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "not a project member"),
    );

    const res = await invokeList(RUN_ID, "src");

    expect(res.status).toBe(403);
    expect(listTree).not.toHaveBeenCalled();
  });

  it("returns 401 when requireActiveSession rejects UNAUTHENTICATED", async () => {
    vi.mocked(requireActiveSession).mockRejectedValue(
      new MaisterError("UNAUTHENTICATED", "no session"),
    );

    const res = await invokeList(RUN_ID, "src");

    expect(res.status).toBe(401);
    expect(listTree).not.toHaveBeenCalled();
  });

  it("returns 400 CONFIG for a `../` traversal path before listTree", async () => {
    const res = await invokeList(RUN_ID, "../etc");
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("CONFIG");
    expect(listTree).not.toHaveBeenCalled();
  });

  it("authorizes with (detail.projectId, 'readRepoFiles')", async () => {
    vi.mocked(listTree).mockResolvedValue({ path: "", entries: [] });

    await invokeList(RUN_ID);

    expect(requireProjectAction).toHaveBeenCalledWith(
      PROJECT_ID,
      "readRepoFiles",
    );
  });
});
