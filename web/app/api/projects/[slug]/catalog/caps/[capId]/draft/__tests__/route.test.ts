import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateAuthoredDraftMock = vi.hoisted(() => vi.fn());
const capabilityExistsInProjectMock = vi.hoisted(() => vi.fn());
const authorizeCatalogRouteProjectMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/catalog/authored-service", () => ({
  updateAuthoredDraft: updateAuthoredDraftMock,
  capabilityExistsInProject: capabilityExistsInProjectMock,
}));
vi.mock("@/lib/catalog/route-auth", () => ({
  authorizeCatalogRouteProject: authorizeCatalogRouteProjectMock,
}));

describe("/api/projects/[slug]/catalog/caps/[capId]/draft", () => {
  beforeEach(() => {
    vi.resetModules();
    updateAuthoredDraftMock.mockReset();
    authorizeCatalogRouteProjectMock.mockReset();
    capabilityExistsInProjectMock.mockReset();
    capabilityExistsInProjectMock.mockResolvedValue(true);
    authorizeCatalogRouteProjectMock.mockResolvedValue({
      projectId: "project-demo",
      userId: "user-1",
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
      editor: { sessionId: undefined, userId: "user-1" },
    });
  });

  it("forwards an optional editor sessionId without leaking it into the draft input", async () => {
    updateAuthoredDraftMock.mockResolvedValue({
      id: "rev-4",
      lifecycle: "DRAFT",
      draftVersion: 4,
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      new NextRequest(
        "http://localhost/api/projects/demo/catalog/caps/cap-1/draft",
        {
          method: "PATCH",
          body: JSON.stringify({
            title: "Updated",
            expectedDraftVersion: 3,
            sessionId: "s1",
          }),
        },
      ),
      { params: Promise.resolve({ slug: "demo", capId: "cap-1" }) },
    );

    expect(response.status).toBe(200);
    expect(updateAuthoredDraftMock).toHaveBeenCalledWith({
      projectSlug: "demo",
      capId: "cap-1",
      input: { title: "Updated", expectedDraftVersion: 3 },
      editor: { sessionId: "s1", userId: "user-1" },
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

  it("returns 404 when the capability is missing or belongs to another project", async () => {
    capabilityExistsInProjectMock.mockResolvedValue(false);
    const { PATCH } = await import("../route");

    const response = await PATCH(
      new NextRequest(
        "http://localhost/api/projects/demo/catalog/caps/cap-x/draft",
        {
          method: "PATCH",
          body: JSON.stringify({ title: "T", expectedDraftVersion: 1 }),
          headers: { "content-type": "application/json" },
        },
      ),
      { params: Promise.resolve({ slug: "demo", capId: "cap-x" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
    expect(capabilityExistsInProjectMock).toHaveBeenCalledWith(
      "project-demo",
      "cap-x",
    );
    expect(updateAuthoredDraftMock).not.toHaveBeenCalled();
  });
});
