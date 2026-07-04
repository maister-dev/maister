import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import {
  createBrainSource,
  enqueueAllBrainSourcesReindex,
  listBrainSources,
} from "@/lib/brain/sources";
import { MaisterError } from "@/lib/errors";
import { getProjectBySlug } from "@/lib/queries/project";

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

vi.mock("@/lib/brain/sources", () => ({
  listBrainSources: vi.fn(),
  createBrainSource: vi.fn(),
  enqueueAllBrainSourcesReindex: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(() => ({ execute: vi.fn() })),
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
  vi.mocked(listBrainSources).mockResolvedValue([]);
  vi.mocked(createBrainSource).mockResolvedValue({
    id: "source-1",
    kind: "markdown",
    path: "docs/README.md",
    chunkerId: "markdown",
    chunkerVersion: "1",
    enabled: true,
    sourceHash: null,
    lastIndexedAt: null,
    lastError: null,
    chunkCount: 0,
  });
  vi.mocked(enqueueAllBrainSourcesReindex).mockResolvedValue(["job-1"]);
});

async function invokeGet(slug = SLUG) {
  const { GET } = await import("../route");
  const req = new NextRequest(
    new Request(`http://localhost/api/projects/${slug}/brain/sources`),
  );

  return GET(req, { params: Promise.resolve({ slug }) });
}

async function invokePost(body: unknown, slug = SLUG) {
  const { POST } = await import("../route");
  const req = new NextRequest(
    new Request(`http://localhost/api/projects/${slug}/brain/sources`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

  return POST(req, { params: Promise.resolve({ slug }) });
}

async function invokeReindexAll(slug = SLUG) {
  const { POST } = await import("../reindex/route");
  const req = new NextRequest(
    new Request(`http://localhost/api/projects/${slug}/brain/sources/reindex`, {
      method: "POST",
    }),
  );

  return POST(req, { params: Promise.resolve({ slug }) });
}

describe("Project Brain source routes", () => {
  it("lists source metadata behind readBrain", async () => {
    const res = await invokeGet();

    expect(res.status).toBe(200);
    expect(requireProjectAction).toHaveBeenCalledWith(PROJECT_ID, "readBrain");
    expect(listBrainSources).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
    );
  });

  it("creates a source behind editSettings using server-derived project repo state", async () => {
    const res = await invokePost({
      path: "docs/README.md",
      repoPath: "/body/must-not-win",
      mainBranch: "body-branch",
    });

    expect(res.status).toBe(201);
    expect(requireProjectAction).toHaveBeenCalledWith(
      PROJECT_ID,
      "editSettings",
    );
    expect(createBrainSource).toHaveBeenCalledWith(expect.anything(), {
      projectId: PROJECT_ID,
      repoPath: REPO_PATH,
      mainBranch: MAIN_BRANCH,
      input: { path: "docs/README.md" },
    });
  });

  it("authenticates before body parsing", async () => {
    vi.mocked(requireActiveSession).mockRejectedValue(
      new MaisterError("UNAUTHENTICATED", "no session"),
    );

    const res = await invokePost("{");

    expect(res.status).toBe(401);
    expect(createBrainSource).not.toHaveBeenCalled();
  });

  it("returns a PRECONDITION body for unreadable source inputs", async () => {
    vi.mocked(createBrainSource).mockRejectedValue(
      new MaisterError("PRECONDITION", "Brain source glob is too broad"),
    );

    const res = await invokePost({ path: "many/**/*.md" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toMatchObject({
      code: "PRECONDITION",
      message: "Brain source glob is too broad",
    });
  });

  it("enqueues all enabled sources behind editSettings", async () => {
    const res = await invokeReindexAll();
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.jobIds).toEqual(["job-1"]);
    expect(requireProjectAction).toHaveBeenCalledWith(
      PROJECT_ID,
      "editSettings",
    );
    expect(enqueueAllBrainSourcesReindex).toHaveBeenCalledWith(
      expect.anything(),
      {
        projectId: PROJECT_ID,
        reason: "manual",
      },
    );
  });

  it("returns 404 for an archived project before source service calls", async () => {
    vi.mocked(getProjectBySlug).mockResolvedValue(
      projectRow({ archivedAt: new Date() }),
    );

    const res = await invokeGet();
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toMatchObject({ code: "PRECONDITION" });
    expect(listBrainSources).not.toHaveBeenCalled();
  });
});
