import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateAuthoredDraftMock = vi.hoisted(() => vi.fn());
const authorizeCatalogRouteProjectMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/catalog/authored-service", () => ({
  updateAuthoredDraft: updateAuthoredDraftMock,
}));
vi.mock("@/lib/catalog/route-auth", () => ({
  authorizeCatalogRouteProject: authorizeCatalogRouteProjectMock,
}));

describe("/api/projects/[slug]/catalog/caps/[capId]/draft", () => {
  beforeEach(() => {
    vi.resetModules();
    updateAuthoredDraftMock.mockReset();
    authorizeCatalogRouteProjectMock.mockReset();
    authorizeCatalogRouteProjectMock.mockResolvedValue({
      projectId: "project-demo",
    });
  });

  it("passes expected draft version for optimistic concurrency", async () => {
    updateAuthoredDraftMock.mockResolvedValue({
      id: "rev-3",
      lifecycle: "DRAFT",
      draftVersion: 3,
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      new NextRequest(
        "http://localhost/api/projects/demo/catalog/caps/cap-1/draft",
        {
          method: "PATCH",
          body: JSON.stringify({
            title: "Updated",
            body: { content: "New text" },
            expectedDraftVersion: 2,
          }),
        },
      ),
      { params: Promise.resolve({ slug: "demo", capId: "cap-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: "rev-3", draftVersion: 3 });
    expect(authorizeCatalogRouteProjectMock).toHaveBeenCalledWith("demo");
    expect(updateAuthoredDraftMock).toHaveBeenCalledWith({
      projectSlug: "demo",
      capId: "cap-1",
      input: {
        title: "Updated",
        body: { content: "New text" },
        expectedDraftVersion: 2,
      },
    });
  });

  it("rejects stale-unsafe draft updates without expectedDraftVersion", async () => {
    const { PATCH } = await import("../route");

    const response = await PATCH(
      new NextRequest(
        "http://localhost/api/projects/demo/catalog/caps/cap-1/draft",
        {
          method: "PATCH",
          body: JSON.stringify({ title: "Updated" }),
        },
      ),
      { params: Promise.resolve({ slug: "demo", capId: "cap-1" }) },
    );

    expect(response.status).toBe(422);
    expect(updateAuthoredDraftMock).not.toHaveBeenCalled();
  });
});
