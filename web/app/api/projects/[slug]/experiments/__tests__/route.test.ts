import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors-core";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  resolveProject: vi.fn(),
  listProjectExperiments: vi.fn(),
  createExperiment: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));

vi.mock("@/lib/api/project-route-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/project-route-helpers")>()),
  resolveProject: mocks.resolveProject,
}));

vi.mock("@/lib/experiments/service", () => ({
  listProjectExperiments: mocks.listProjectExperiments,
  createExperiment: mocks.createExperiment,
}));

type RouteModule = typeof import("../route");

let route: RouteModule;

function request(method: string, body?: Record<string, unknown>): NextRequest {
  return new Request("http://x/api/projects/demo/experiments", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as NextRequest;
}

function params(slug = "demo") {
  return { params: Promise.resolve({ slug }) };
}

const variantA = {
  key: "claude",
  label: "Claude",
  config: { runnerId: "runner-claude" },
};
const variantB = {
  key: "codex",
  label: "Codex",
  config: { runnerId: "runner-codex" },
};

beforeEach(async () => {
  mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  mocks.requireProjectAction.mockResolvedValue({ role: "member" });
  mocks.resolveProject.mockResolvedValue({ id: "project-1" });
  mocks.listProjectExperiments.mockResolvedValue([
    {
      id: "exp-1",
      title: "Compare runners",
      taskId: "task-1",
      taskNumber: 7,
      status: "draft",
      variantsCount: 2,
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      createdAt: "2026-07-03T10:00:00.000Z",
      winnerVariantKey: null,
      verdictOutcome: null,
    },
  ]);
  mocks.createExperiment.mockResolvedValue({
    id: "exp-1",
    projectId: "project-1",
    taskId: "task-1",
    title: "Compare runners",
    description: null,
    status: "draft",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    variants: [variantA, variantB],
    rubric: { criteria: [] },
    verdict: null,
    createdAt: "2026-07-03T10:00:00.000Z",
    launchedAt: null,
    comparableAt: null,
    concludedAt: null,
    abandonedAt: null,
  });

  route = await import("../route");
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("GET /api/projects/[slug]/experiments", () => {
  it("requires readExperiments and returns explicit list DTOs", async () => {
    const res = await route.GET(request("GET"), params());
    const body = (await res.json()) as { experiments: Array<unknown> };

    expect(res.status).toBe(200);
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "readExperiments",
    );
    expect(mocks.listProjectExperiments).toHaveBeenCalledWith("project-1");
    expect(body.experiments).toHaveLength(1);
    expect(Object.keys(body.experiments[0] as Record<string, unknown>).sort())
      .toEqual([
        "baseBranch",
        "baseCommit",
        "createdAt",
        "id",
        "status",
        "taskId",
        "taskNumber",
        "title",
        "variantsCount",
        "verdictOutcome",
        "winnerVariantKey",
      ]);
  });
});

describe("POST /api/projects/[slug]/experiments", () => {
  it("checks manageExperiments before body validation or service writes", async () => {
    mocks.requireProjectAction.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "member role required"),
    );

    const res = await route.POST(request("POST", { invalid: true }), params());
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "manageExperiments",
    );
    expect(mocks.createExperiment).not.toHaveBeenCalled();
  });

  it("creates an experiment through the service after authz and body parsing", async () => {
    const body = {
      taskId: "task-1",
      title: "Compare runners",
      baseBranch: "main",
      variants: [variantA, variantB],
    };

    const res = await route.POST(request("POST", body), params());
    const payload = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(mocks.createExperiment).toHaveBeenCalledWith({
      projectId: "project-1",
      slug: "demo",
      actorUserId: "user-1",
      input: body,
    });
    expect(Object.keys(payload).sort()).toEqual([
      "abandonedAt",
      "baseBranch",
      "baseCommit",
      "comparableAt",
      "concludedAt",
      "createdAt",
      "description",
      "id",
      "launchedAt",
      "projectId",
      "rubric",
      "status",
      "taskId",
      "title",
      "variants",
      "verdict",
    ]);
  });

  it("returns 422 CONFIG for invalid body shape after authz", async () => {
    const res = await route.POST(request("POST", { taskId: "task-1" }), params());
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    expect(mocks.createExperiment).not.toHaveBeenCalled();
  });
});
