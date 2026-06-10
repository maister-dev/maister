import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors-core";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  projectRows: [] as unknown[],
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  getScheduleForProject: vi.fn(),
  listProjectSchedules: vi.fn(),
  getProjectScheduleDTO: vi.fn(),
  dispatchScheduleNow: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: async () => mocks.projectRows }),
    }),
  }),
}));
vi.mock("@/lib/run-schedules/service", () => ({
  createSchedule: mocks.createSchedule,
  updateSchedule: mocks.updateSchedule,
  deleteSchedule: mocks.deleteSchedule,
  getScheduleForProject: mocks.getScheduleForProject,
}));
vi.mock("@/lib/run-schedules/queries", () => ({
  listProjectSchedules: mocks.listProjectSchedules,
  getProjectScheduleDTO: mocks.getProjectScheduleDTO,
}));
vi.mock("@/lib/run-schedules/dispatch", () => ({
  dispatchScheduleNow: mocks.dispatchScheduleNow,
}));

const params = <T extends Record<string, string>>(extra?: T) => ({
  params: Promise.resolve({ slug: "proj", ...(extra ?? ({} as T)) }),
});

function jsonRequest(
  method: string,
  body?: Record<string, unknown>,
): NextRequest {
  return new Request("http://x/api/projects/proj/schedules", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as NextRequest;
}

const validPost = {
  name: "nightly",
  taskId: "task-1",
  cronExpr: "0 3 * * *",
  timezone: "UTC",
};

const dto = { id: "sched-1", name: "nightly" };

let collection: typeof import("../route");
let item: typeof import("../[scheduleId]/route");
let trigger: typeof import("../[scheduleId]/trigger/route");

beforeEach(async () => {
  mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  mocks.requireProjectAction.mockResolvedValue({ role: "member" });
  mocks.projectRows = [{ id: "project-1", archivedAt: null }];
  mocks.createSchedule.mockResolvedValue({ id: "sched-1" });
  mocks.updateSchedule.mockResolvedValue({ id: "sched-1" });
  mocks.deleteSchedule.mockResolvedValue(true);
  mocks.getScheduleForProject.mockResolvedValue({ id: "sched-1" });
  mocks.listProjectSchedules.mockResolvedValue([dto]);
  mocks.getProjectScheduleDTO.mockResolvedValue(dto);
  mocks.dispatchScheduleNow.mockResolvedValue({
    outcome: "launched",
    runId: "run-1",
  });

  collection = await import("../route");
  item = await import("../[scheduleId]/route");
  trigger = await import("../[scheduleId]/trigger/route");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/projects/[slug]/schedules", () => {
  it("lists schedules for readBoard members", async () => {
    const res = await collection.GET(jsonRequest("GET"), params());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ schedules: [dto] });
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "readBoard",
    );
  });

  it("returns 401 unauthenticated before probing the project", async () => {
    mocks.requireActiveSession.mockRejectedValue(
      new MaisterError("UNAUTHENTICATED", "no session"),
    );

    const res = await collection.GET(jsonRequest("GET"), params());

    expect(res.status).toBe(401);
  });

  it("returns 409 PRECONDITION for an unknown or archived project", async () => {
    mocks.projectRows = [];

    const res = await collection.GET(jsonRequest("GET"), params());

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PRECONDITION");
  });
});

describe("POST /api/projects/[slug]/schedules", () => {
  it("creates a schedule and returns the DTO with 201", async () => {
    const res = await collection.POST(jsonRequest("POST", validPost), params());

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ schedule: dto });
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "manageSchedules",
    );
    expect(mocks.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        taskId: "task-1",
        actorUserId: "user-1",
      }),
    );
  });

  it("refuses a viewer with 403", async () => {
    mocks.requireProjectAction.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "requires member"),
    );

    const res = await collection.POST(jsonRequest("POST", validPost), params());

    expect(res.status).toBe(403);
    expect(mocks.createSchedule).not.toHaveBeenCalled();
  });

  it("maps a cross-project taskId refusal to 409", async () => {
    mocks.createSchedule.mockRejectedValue(
      new MaisterError("PRECONDITION", "Task not found in project: task-1"),
    );

    const res = await collection.POST(jsonRequest("POST", validPost), params());

    expect(res.status).toBe(409);
  });

  it("maps unknown runnerId / bad cron / bad timezone (CONFIG) to 400", async () => {
    mocks.createSchedule.mockRejectedValue(
      new MaisterError("CONFIG", "Unknown runner: r-1"),
    );

    const res = await collection.POST(
      jsonRequest("POST", { ...validPost, runnerId: "r-1" }),
      params(),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONFIG");
  });

  it("rejects an invalid body shape with 400 before auth side effects", async () => {
    const res = await collection.POST(
      jsonRequest("POST", { ...validPost, unknownField: 1 }),
      params(),
    );

    expect(res.status).toBe(400);
    expect(mocks.createSchedule).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/projects/[slug]/schedules/[scheduleId]", () => {
  it("applies an aggregate patch and returns the DTO", async () => {
    const res = await item.PATCH(
      jsonRequest("PATCH", { name: "renamed", enabled: false }),
      params({ scheduleId: "sched-1" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ schedule: dto });
    expect(mocks.updateSchedule).toHaveBeenCalledWith(
      "project-1",
      "sched-1",
      { name: "renamed", enabled: false },
      { actorUserId: "user-1" },
    );
  });

  it("rejects an empty PATCH body with 400 CONFIG", async () => {
    const res = await item.PATCH(
      jsonRequest("PATCH", {}),
      params({ scheduleId: "sched-1" }),
    );

    expect(res.status).toBe(400);
    expect(mocks.updateSchedule).not.toHaveBeenCalled();
  });

  it("returns a bare 404 for a schedule outside this project", async () => {
    mocks.updateSchedule.mockResolvedValue(null);

    const res = await item.PATCH(
      jsonRequest("PATCH", { name: "x" }),
      params({ scheduleId: "foreign" }),
    );

    expect(res.status).toBe(404);
  });

  it("passes runnerId: null through (CLEAR semantics)", async () => {
    await item.PATCH(
      jsonRequest("PATCH", { runnerId: null }),
      params({ scheduleId: "sched-1" }),
    );

    expect(mocks.updateSchedule).toHaveBeenCalledWith(
      "project-1",
      "sched-1",
      { runnerId: null },
      { actorUserId: "user-1" },
    );
  });
});

describe("DELETE /api/projects/[slug]/schedules/[scheduleId]", () => {
  it("hard-deletes and returns ok", async () => {
    const res = await item.DELETE(
      jsonRequest("DELETE"),
      params({ scheduleId: "sched-1" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 404 when nothing was deleted", async () => {
    mocks.deleteSchedule.mockResolvedValue(false);

    const res = await item.DELETE(
      jsonRequest("DELETE"),
      params({ scheduleId: "foreign" }),
    );

    expect(res.status).toBe(404);
  });

  it("refuses a viewer with 403", async () => {
    mocks.requireProjectAction.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "requires member"),
    );

    const res = await item.DELETE(
      jsonRequest("DELETE"),
      params({ scheduleId: "sched-1" }),
    );

    expect(res.status).toBe(403);
    expect(mocks.deleteSchedule).not.toHaveBeenCalled();
  });
});

describe("POST /api/projects/[slug]/schedules/[scheduleId]/trigger", () => {
  it("passes the dispatch outcome through with the clicking user's id", async () => {
    const res = await trigger.POST(
      jsonRequest("POST"),
      params({ scheduleId: "sched-1" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "launched", runId: "run-1" });
    expect(mocks.dispatchScheduleNow).toHaveBeenCalledWith("sched-1", {
      actorUserId: "user-1",
    });
  });

  it("returns 200 with outcome launch_failed (the dispatch itself succeeded)", async () => {
    mocks.dispatchScheduleNow.mockResolvedValue({
      outcome: "launch_failed",
      errorCode: "EXECUTOR_UNAVAILABLE",
    });

    const res = await trigger.POST(
      jsonRequest("POST"),
      params({ scheduleId: "sched-1" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: "launch_failed",
      errorCode: "EXECUTOR_UNAVAILABLE",
    });
  });

  it("maps a busy row (CONFLICT) to 409", async () => {
    mocks.dispatchScheduleNow.mockRejectedValue(
      new MaisterError("CONFLICT", "schedule dispatch in progress"),
    );

    const res = await trigger.POST(
      jsonRequest("POST"),
      params({ scheduleId: "sched-1" }),
    );

    expect(res.status).toBe(409);
  });

  it("returns 404 for a schedule outside this project without dispatching", async () => {
    mocks.getScheduleForProject.mockResolvedValue(null);

    const res = await trigger.POST(
      jsonRequest("POST"),
      params({ scheduleId: "foreign" }),
    );

    expect(res.status).toBe(404);
    expect(mocks.dispatchScheduleNow).not.toHaveBeenCalled();
  });

  it("requires manageSchedules (viewer → 403)", async () => {
    mocks.requireProjectAction.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "requires member"),
    );

    const res = await trigger.POST(
      jsonRequest("POST"),
      params({ scheduleId: "sched-1" }),
    );

    expect(res.status).toBe(403);
    expect(mocks.dispatchScheduleNow).not.toHaveBeenCalled();
  });
});
