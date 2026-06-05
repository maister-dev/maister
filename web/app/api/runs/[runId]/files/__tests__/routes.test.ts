// M22 Phase 4a (RED): failing unit tests for the run-workbench file routes.
//
// Contract (NOT yet built — RED on the missing `../route` + `../content/route`):
//   GET /api/runs/[runId]/files          (list)
//   GET /api/runs/[runId]/files/content  (content)
//
// Flow (both routes):
//   requireActiveSession()
//   detail = getRunDetail(runId); !detail → bare 404 {message}
//   requireProjectAction(detail.projectId, "readRepoFiles")
//   read ?path from new URL(req.url).searchParams.get("path")
//     - list:    default ""    (root)
//     - content: REQUIRED      (missing → 400 CONFIG)
//   non-empty path → repoRelPathSchema (reject → 400 {code:"CONFIG"})
//   list:    listTree({repo: detail.worktreePath, ref: detail.branch, dir: path})
//              → null → 404 ; else 200 {path, entries}
//   content: readBlob({repo: detail.worktreePath, ref: detail.branch, path,
//              maxBytes: workbenchMaxFileBytes()})
//              not-found → 404 {message}; too-large → 413 {kind,size};
//              binary → 415 {kind}; text → 200 {kind:"text",content}
//   local httpStatusForCode: CONFIG→400, UNAUTHENTICATED→401,
//     UNAUTHORIZED/PASSWORD_CHANGE_REQUIRED/ACCOUNT_INACTIVE→403, else 500.
//
// authz / queries / instance-config are mocked at the module boundary; the REAL
// repoRelPathSchema is kept so a `../` path is rejected 400 BEFORE listTree/
// readBlob are reached.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { getRunDetail } from "@/lib/queries/run";
import { listTree, readBlob } from "@/lib/worktree";

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

// Keep the REAL repoRelPathSchema (so a `../` path 400s before listTree/readBlob);
// stub only the two git readers.
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

async function invokeContent(runId: string, path?: string) {
  const { GET } = await import("../content/route");
  const url =
    path === undefined
      ? `http://localhost/api/runs/${runId}/files/content`
      : `http://localhost/api/runs/${runId}/files/content?path=${encodeURIComponent(path)}`;
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

describe("GET /api/runs/[runId]/files/content", () => {
  it("returns 200 {kind:'text',content} and calls readBlob with server-state repo+ref", async () => {
    vi.mocked(readBlob).mockResolvedValue({
      kind: "text",
      content: "export const x = 1;\n",
    });

    const res = await invokeContent(RUN_ID, "src/index.ts");
    const body = (await res.json()) as { kind: string; content: string };

    expect(res.status).toBe(200);
    expect(readBlob).toHaveBeenCalledWith({
      repo: WORKTREE_PATH,
      ref: BRANCH,
      path: "src/index.ts",
      maxBytes: 524288,
    });
    expect(body.kind).toBe("text");
    expect(body.content).toBe("export const x = 1;\n");
  });

  it("returns 404 when readBlob resolves not-found", async () => {
    vi.mocked(readBlob).mockResolvedValue({ kind: "not-found" });

    const res = await invokeContent(RUN_ID, "missing.txt");

    expect(res.status).toBe(404);
  });

  it("returns 413 {kind:'too-large',size} when the blob is over the cap", async () => {
    vi.mocked(readBlob).mockResolvedValue({ kind: "too-large", size: 999999 });

    const res = await invokeContent(RUN_ID, "big.bin");
    const body = (await res.json()) as { kind: string; size: number };

    expect(res.status).toBe(413);
    expect(body.kind).toBe("too-large");
    expect(body.size).toBe(999999);
  });

  it("returns 415 {kind:'binary'} for a binary blob", async () => {
    vi.mocked(readBlob).mockResolvedValue({ kind: "binary" });

    const res = await invokeContent(RUN_ID, "logo.png");
    const body = (await res.json()) as { kind: string };

    expect(res.status).toBe(415);
    expect(body.kind).toBe("binary");
  });

  it("returns 400 CONFIG when ?path is missing (content requires a path)", async () => {
    const res = await invokeContent(RUN_ID);
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("CONFIG");
    expect(readBlob).not.toHaveBeenCalled();
  });

  it("returns 400 CONFIG for a `../` traversal path before readBlob", async () => {
    const res = await invokeContent(RUN_ID, "../secret");
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("CONFIG");
    expect(readBlob).not.toHaveBeenCalled();
  });

  it("returns 403 when a viewer is denied (requireProjectAction UNAUTHORIZED)", async () => {
    vi.mocked(requireProjectAction).mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "not a project member"),
    );

    const res = await invokeContent(RUN_ID, "src/index.ts");

    expect(res.status).toBe(403);
    expect(readBlob).not.toHaveBeenCalled();
  });

  it("returns 404 when the run does not exist", async () => {
    vi.mocked(getRunDetail).mockResolvedValue(null);

    const res = await invokeContent(RUN_ID, "src/index.ts");

    expect(res.status).toBe(404);
    expect(readBlob).not.toHaveBeenCalled();
  });

  it("authorizes with (detail.projectId, 'readRepoFiles')", async () => {
    vi.mocked(readBlob).mockResolvedValue({ kind: "text", content: "x" });

    await invokeContent(RUN_ID, "a.txt");

    expect(requireProjectAction).toHaveBeenCalledWith(
      PROJECT_ID,
      "readRepoFiles",
    );
  });
});
