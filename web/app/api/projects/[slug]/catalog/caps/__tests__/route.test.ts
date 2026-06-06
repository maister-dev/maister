import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createAuthoredCapabilityMock = vi.hoisted(() => vi.fn());
const listAuthoredCapabilitiesMock = vi.hoisted(() => vi.fn());
const authorizeCatalogRouteProjectMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/catalog/authored-service", () => ({
  createAuthoredCapability: createAuthoredCapabilityMock,
  listAuthoredCapabilities: listAuthoredCapabilitiesMock,
}));
vi.mock("@/lib/catalog/route-auth", () => ({
  authorizeCatalogRouteProject: authorizeCatalogRouteProjectMock,
}));

describe("/api/projects/[slug]/catalog/caps", () => {
  beforeEach(() => {
    vi.resetModules();
    createAuthoredCapabilityMock.mockReset();
    listAuthoredCapabilitiesMock.mockReset();
    authorizeCatalogRouteProjectMock.mockReset();
    authorizeCatalogRouteProjectMock.mockResolvedValue({
      projectId: "project-demo",
    });
  });

  it("lists authored capabilities for a project", async () => {
    listAuthoredCapabilitiesMock.mockResolvedValue([]);
    const { GET } = await import("../route");

    const response = await GET(
      new NextRequest("http://localhost/api/projects/demo/catalog/caps"),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(response.status).toBe(200);
    expect(authorizeCatalogRouteProjectMock).toHaveBeenCalledWith("demo");
    expect(listAuthoredCapabilitiesMock).toHaveBeenCalledWith({
      projectSlug: "demo",
    });
  });

  it("creates a draft authored capability", async () => {
    createAuthoredCapabilityMock.mockResolvedValue({
      capability: {
        id: "cap-1",
        kind: "rule",
        slug: "review",
        lifecycle: "DRAFT",
      },
      draft: { id: "rev-1", lifecycle: "DRAFT", draftVersion: 1 },
    });
    const { POST } = await import("../route");

    const response = await POST(
      new NextRequest("http://localhost/api/projects/demo/catalog/caps", {
        method: "POST",
        body: JSON.stringify({ kind: "rule", slug: "review", title: "Review" }),
      }),
      { params: Promise.resolve({ slug: "demo" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      capability: { id: "cap-1" },
      draft: { id: "rev-1" },
    });
    expect(authorizeCatalogRouteProjectMock).toHaveBeenCalledWith("demo");
    expect(createAuthoredCapabilityMock).toHaveBeenCalledWith({
      projectSlug: "demo",
      input: { kind: "rule", slug: "review", title: "Review" },
    });
  });

  it("rejects malformed create bodies and does not call the service", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      new NextRequest("http://localhost/api/projects/demo/catalog/caps", {
        method: "POST",
        body: JSON.stringify({ kind: "rule", slug: "review" }),
      }),
      { params: Promise.resolve({ slug: "demo" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    expect(createAuthoredCapabilityMock).not.toHaveBeenCalled();
  });

  it("rejects body-controlled project identifiers", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      new NextRequest("http://localhost/api/projects/demo/catalog/caps", {
        method: "POST",
        body: JSON.stringify({
          projectSlug: "evil",
          kind: "rule",
          slug: "review",
          title: "Review",
        }),
      }),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(response.status).toBe(422);
    expect(createAuthoredCapabilityMock).not.toHaveBeenCalled();
  });
});
