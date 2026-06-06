import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const archiveAuthoredCapabilityMock = vi.hoisted(() => vi.fn());
const authorizeCatalogRouteProjectMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/catalog/authored-service", () => ({
  archiveAuthoredCapability: archiveAuthoredCapabilityMock,
}));
vi.mock("@/lib/catalog/route-auth", () => ({
  authorizeCatalogRouteProject: authorizeCatalogRouteProjectMock,
}));

describe("/api/projects/[slug]/catalog/caps/[capId]/archive", () => {
  beforeEach(() => {
    vi.resetModules();
    archiveAuthoredCapabilityMock.mockReset();
    authorizeCatalogRouteProjectMock.mockReset();
    authorizeCatalogRouteProjectMock.mockResolvedValue({
      projectId: "project-demo",
    });
  });

  it("archives using URL-derived project and cap identifiers", async () => {
    archiveAuthoredCapabilityMock.mockResolvedValue({
      id: "cap-1",
      lifecycle: "ARCHIVED",
      archivedAt: new Date("2026-06-05T00:00:00.000Z"),
    });
    const { POST } = await import("../route");

    const response = await POST(
      new NextRequest(
        "http://localhost/api/projects/demo/catalog/caps/cap-1/archive",
        { method: "POST" },
      ),
      { params: Promise.resolve({ slug: "demo", capId: "cap-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: "cap-1", lifecycle: "ARCHIVED" });
    expect(authorizeCatalogRouteProjectMock).toHaveBeenCalledWith("demo");
    expect(archiveAuthoredCapabilityMock).toHaveBeenCalledWith({
      projectSlug: "demo",
      capId: "cap-1",
    });
  });

  it("rejects body-controlled archive payloads", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      new NextRequest(
        "http://localhost/api/projects/demo/catalog/caps/cap-1/archive",
        {
          method: "POST",
          body: JSON.stringify({
            projectSlug: "evil",
            capId: "evil",
            source: "project",
          }),
        },
      ),
      { params: Promise.resolve({ slug: "demo", capId: "cap-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    expect(archiveAuthoredCapabilityMock).not.toHaveBeenCalled();
  });

  it("rejects malformed archive payloads", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      new NextRequest(
        "http://localhost/api/projects/demo/catalog/caps/cap-1/archive",
        {
          method: "POST",
          body: "{",
        },
      ),
      { params: Promise.resolve({ slug: "demo", capId: "cap-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    expect(archiveAuthoredCapabilityMock).not.toHaveBeenCalled();
  });
});
