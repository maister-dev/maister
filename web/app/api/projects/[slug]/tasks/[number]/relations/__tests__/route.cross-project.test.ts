// ADR-155 route contract for POST|DELETE
// /api/projects/{slug}/tasks/{number}/relations: the toNumber XOR toTaskKey
// body rule and the dual-RBAC gate on the RESOLVED target project.
//
// This file MUST live under __tests__/ — the unit project globs
// `app/**/__tests__/**`, so a sibling of route.ts is never collected (M10).

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, POST } from "../route";

import { MaisterError } from "@/lib/errors";

const requireActiveSessionSpy = vi.fn();
const requireProjectActionSpy = vi.fn();
const resolveByNumberSpy = vi.fn();
const resolveByKeyRefSpy = vi.fn();
const addTaskRelationSpy = vi.fn();
const removeTaskRelationSpy = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireActiveSession: (...a: unknown[]) => requireActiveSessionSpy(...a),
  requireProjectAction: (...a: unknown[]) => requireProjectActionSpy(...a),
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));

vi.mock("@/lib/social/task-lookup", () => ({
  resolveProjectTaskByNumber: (...a: unknown[]) => resolveByNumberSpy(...a),
  resolveTaskByKeyRef: (...a: unknown[]) => resolveByKeyRefSpy(...a),
}));

vi.mock("@/lib/social/relations", () => ({
  addTaskRelation: (...a: unknown[]) => addTaskRelationSpy(...a),
  removeTaskRelation: (...a: unknown[]) => removeTaskRelationSpy(...a),
}));

function routeParams() {
  return { params: Promise.resolve({ slug: "alpha", number: "1" }) };
}

function req(body: unknown, method: "POST" | "DELETE" = "POST"): NextRequest {
  return new NextRequest(
    "http://localhost/api/projects/alpha/tasks/1/relations",
    {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function resolved(projectId: string, taskId: string, taskKey: string) {
  return {
    project: { id: projectId, slug: "x", taskKey, archivedAt: null },
    task: {
      id: taskId,
      projectId,
      number: 1,
      title: "t",
      status: "Backlog",
      createdByUserId: null,
    },
  };
}

const FROM = resolved("proj-alpha", "task-from", "ALPHA");
const SIBLING = resolved("proj-beta", "task-to", "BETA");

beforeEach(() => {
  requireActiveSessionSpy.mockReset().mockResolvedValue({ id: "u1" });
  requireProjectActionSpy.mockReset().mockResolvedValue({ role: "admin" });
  resolveByNumberSpy.mockReset().mockResolvedValue(FROM);
  resolveByKeyRefSpy.mockReset().mockResolvedValue(SIBLING);
  addTaskRelationSpy.mockReset().mockResolvedValue({ created: true });
  removeTaskRelationSpy.mockReset().mockResolvedValue({ removed: true });
});

describe("relations route — toNumber XOR toTaskKey (ADR-155)", () => {
  it("refuses CONFIG/400 when BOTH target forms are supplied", async () => {
    const res = await POST(
      req({ kind: "blocks", toNumber: 5, toTaskKey: "BETA-7" }),
      routeParams(),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "CONFIG" });
    expect(addTaskRelationSpy).not.toHaveBeenCalled();
  });

  it("refuses CONFIG/400 when NEITHER target form is supplied", async () => {
    const res = await POST(req({ kind: "blocks" }), routeParams());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "CONFIG" });
    expect(addTaskRelationSpy).not.toHaveBeenCalled();
  });

  it("resolves toTaskKey globally rather than within the URL project", async () => {
    const res = await POST(
      req({ kind: "blocks", toTaskKey: "BETA-7" }),
      routeParams(),
    );

    expect(res.status).toBe(200);
    expect(resolveByKeyRefSpy).toHaveBeenCalledWith("BETA-7");
    expect(addTaskRelationSpy).toHaveBeenCalledTimes(1);
    // The row stays owned by the FROM-task's project.
    expect(addTaskRelationSpy.mock.calls[0][0]).toMatchObject({
      projectId: "proj-alpha",
      toTaskId: "task-to",
    });
  });

  it("404s when toTaskKey resolves into an ARCHIVED project", async () => {
    resolveByKeyRefSpy.mockResolvedValue({
      ...SIBLING,
      project: { ...SIBLING.project, archivedAt: new Date() },
    });

    const res = await POST(
      req({ kind: "blocks", toTaskKey: "BETA-7" }),
      routeParams(),
    );

    expect(res.status).toBe(404);
    expect(addTaskRelationSpy).not.toHaveBeenCalled();
  });
});

describe("relations route — dual RBAC on the resolved target (ADR-155 D3)", () => {
  function denyTargetProject() {
    requireProjectActionSpy.mockImplementation(async (projectId: string) => {
      if (projectId === "proj-beta") {
        throw new MaisterError("UNAUTHORIZED", "forbidden");
      }

      return { role: "admin" };
    });
  }

  it("403s on POST when the caller lacks manageTaskRelations on the TARGET project", async () => {
    denyTargetProject();

    const res = await POST(
      req({ kind: "blocks", toTaskKey: "BETA-7" }),
      routeParams(),
    );

    expect(res.status).toBe(403);
    expect(addTaskRelationSpy).not.toHaveBeenCalled();
    expect(requireProjectActionSpy).toHaveBeenCalledWith(
      "proj-beta",
      "manageTaskRelations",
    );
  });

  // POST and DELETE share one handler; assert it rather than assuming it.
  it("403s on DELETE too — the shared handler must gate both verbs", async () => {
    denyTargetProject();

    const res = await DELETE(
      req({ kind: "blocks", toTaskKey: "BETA-7" }, "DELETE"),
      routeParams(),
    );

    expect(res.status).toBe(403);
    expect(removeTaskRelationSpy).not.toHaveBeenCalled();
  });

  it("does NOT re-check the target when it is the same project", async () => {
    resolveByKeyRefSpy.mockResolvedValue(
      resolved("proj-alpha", "task-sibling", "ALPHA"),
    );

    const res = await POST(
      req({ kind: "blocks", toTaskKey: "ALPHA-9" }),
      routeParams(),
    );

    expect(res.status).toBe(200);
    expect(requireProjectActionSpy).toHaveBeenCalledTimes(1);
  });
});
