import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAuthoredCapabilityMock = vi.hoisted(() => vi.fn());
const capabilityExistsInProjectMock = vi.hoisted(() => vi.fn());
const authorizeCatalogRouteProjectMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/catalog/authored-service", () => ({
  getAuthoredCapability: getAuthoredCapabilityMock,
  capabilityExistsInProject: capabilityExistsInProjectMock,
}));
vi.mock("@/lib/catalog/route-auth", () => ({
  authorizeCatalogRouteProject: authorizeCatalogRouteProjectMock,
}));

describe("/api/projects/[slug]/catalog/caps/[capId]", () => {
  beforeEach(() => {
    vi.resetModules();
    getAuthoredCapabilityMock.mockReset();
    authorizeCatalogRouteProjectMock.mockReset();
    capabilityExistsInProjectMock.mockReset();
    capabilityExistsInProjectMock.mockResolvedValue(true);
    authorizeCatalogRouteProjectMock.mockResolvedValue({
      projectId: "project-demo",
    });
  });

  it("reads a capability using URL-derived project and cap identifiers", async () => {
    getAuthoredCapabilityMock.mockResolvedValue({
      capability: {
        id: "cap-1",
        kind: "rule",
        slug: "review",
      },
      draft: null,
      published: { id: "rev-1", lifecycle: "PUBLISHED" },
      revisions: [{ id: "rev-1", lifecycle: "PUBLISHED" }],
    });
    const { GET } = await import("../route");

    const response = await GET(
      new NextRequest("http://localhost/api/projects/demo/catalog/caps/cap-1"),
      { params: Promise.resolve({ slug: "demo", capId: "cap-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      capability: { id: "cap-1" },
      published: { id: "rev-1" },
      revisions: [{ id: "rev-1" }],
    });
    expect(authorizeCatalogRouteProjectMock).toHaveBeenCalledWith("demo");
    expect(getAuthoredCapabilityMock).toHaveBeenCalledWith({
      projectSlug: "demo",
      capId: "cap-1",
    });
  });

  it("returns 404 when the capability is missing or belongs to another project", async () => {
    capabilityExistsInProjectMock.mockResolvedValue(false);
    const { GET } = await import("../route");

    const response = await GET(
      new NextRequest("http://localhost/api/projects/demo/catalog/caps/cap-x"),
      { params: Promise.resolve({ slug: "demo", capId: "cap-x" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
    expect(getAuthoredCapabilityMock).not.toHaveBeenCalled();
  });
});
