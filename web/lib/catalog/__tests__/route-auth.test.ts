import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

const executeMock = vi.hoisted(() => vi.fn());
const getDbMock = vi.hoisted(() =>
  vi.fn(() => ({
    execute: executeMock,
  })),
);
const requireActiveSessionMock = vi.hoisted(() => vi.fn());
const requireProjectActionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  getDb: getDbMock,
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: requireActiveSessionMock,
  requireProjectAction: requireProjectActionMock,
}));

describe("authorizeCatalogRouteProject", () => {
  beforeEach(() => {
    executeMock.mockReset();
    getDbMock.mockClear();
    requireActiveSessionMock.mockReset();
    requireProjectActionMock.mockReset();
    requireActiveSessionMock.mockResolvedValue({ id: "user-1" });
    requireProjectActionMock.mockResolvedValue(undefined);
    executeMock.mockResolvedValue({
      rows: [{ id: "project-1", archived_at: null }],
    });
  });

  it("requires an active session before resolving the project slug", async () => {
    requireActiveSessionMock.mockRejectedValue(
      new MaisterError("UNAUTHENTICATED", "sign in required"),
    );
    const { authorizeCatalogRouteProject } = await import("../route-auth");

    await expect(authorizeCatalogRouteProject("demo")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(getDbMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(requireProjectActionMock).not.toHaveBeenCalled();
  });

  it("requires manageCatalog permission for the resolved project", async () => {
    const { authorizeCatalogRouteProject } = await import("../route-auth");

    await expect(authorizeCatalogRouteProject("demo")).resolves.toEqual({
      projectId: "project-1",
    });

    expect(requireProjectActionMock).toHaveBeenCalledWith(
      "project-1",
      "manageCatalog",
    );
  });

  it("does not authorize a missing or archived project", async () => {
    executeMock.mockResolvedValue({ rows: [] });
    const { authorizeCatalogRouteProject } = await import("../route-auth");

    await expect(authorizeCatalogRouteProject("missing")).rejects.toMatchObject(
      { code: "PRECONDITION" },
    );
    expect(requireProjectActionMock).not.toHaveBeenCalled();
  });
});
