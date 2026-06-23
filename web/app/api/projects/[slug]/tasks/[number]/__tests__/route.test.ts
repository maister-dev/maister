import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  requireActiveSession,
  requireProjectAction,
  type ProjectAccess,
} from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { updateTask } from "@/lib/services/tasks";
import { resolveProjectTaskByNumber } from "@/lib/social/task-lookup";

const projectAccess = vi.hoisted(
  (): ProjectAccess => ({
    user: { id: "user-1", role: "admin" } as ProjectAccess["user"],
    role: "owner",
  }),
);

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({ id: "user-1" })),
  requireProjectAction: vi.fn(async () => projectAccess),
}));

vi.mock("@/lib/social/task-lookup", () => ({
  resolveProjectTaskByNumber: vi.fn(async () => ({
    project: { id: "project-1" },
    task: { id: "task-1" },
  })),
}));

vi.mock("@/lib/services/tasks", () => ({
  updateTask: vi.fn(async () => undefined),
}));

async function invokePatch(body: unknown): Promise<Response> {
  const { PATCH } = await import("../route");
  const req = new NextRequest(
    new Request("http://localhost/api/projects/demo/tasks/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  return PATCH(req, {
    params: Promise.resolve({ slug: "demo", number: "1" }),
  });
}

async function invokePut(body: unknown): Promise<Response> {
  const { PUT } = await import("../route");
  const req = new NextRequest(
    new Request("http://localhost/api/projects/demo/tasks/1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  return PUT(req, {
    params: Promise.resolve({ slug: "demo", number: "1" }),
  });
}

beforeEach(() => {
  vi.mocked(requireActiveSession)
    .mockReset()
    .mockResolvedValue({
      id: "user-1",
    } as never);
  vi.mocked(requireProjectAction).mockReset().mockResolvedValue(projectAccess);
  vi.mocked(resolveProjectTaskByNumber)
    .mockReset()
    .mockResolvedValue({
      project: { id: "project-1" },
      task: { id: "task-1" },
    } as never);
  vi.mocked(updateTask)
    .mockReset()
    .mockResolvedValue(undefined as never);
});

describe("PATCH /api/projects/[slug]/tasks/[number]", () => {
  it("checks project authorization before body validation", async () => {
    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "project access denied"),
    );

    const res = await invokePatch("not-an-object");

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("UNAUTHORIZED");
    expect(resolveProjectTaskByNumber).toHaveBeenCalledWith("demo", 1);
    expect(requireProjectAction).toHaveBeenCalledWith("project-1", "editTask");
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("patches inline content fields through the task service", async () => {
    const res = await invokePatch({
      title: "Updated title",
      prompt: "Updated prompt",
    });

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith("task-1", "project-1", {
      title: "Updated title",
      prompt: "Updated prompt",
    });
  });
});

describe("PUT /api/projects/[slug]/tasks/[number]", () => {
  it("replaces first-level editable card fields through the task service", async () => {
    const body = {
      title: "Full card title",
      prompt: "Full card prompt",
      flowId: "flow-1",
      runnerId: "claude-default",
      targetBranch: "main",
      promotionMode: "pull_request",
      executionPolicy: {
        preset: "assisted",
        overrides: { promotion: "auto_on_ready" },
      },
    };

    const res = await invokePut(body);

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith("task-1", "project-1", body);
  });
});
