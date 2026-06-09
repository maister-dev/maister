import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const publishAuthoredCapabilityLocalMock = vi.hoisted(() => vi.fn());
const authorizeCatalogRouteProjectMock = vi.hoisted(() => vi.fn());
const bridgePublishedAuthoredFlowMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/catalog/authored-service", () => ({
  publishAuthoredCapabilityLocal: publishAuthoredCapabilityLocalMock,
}));
vi.mock("@/lib/catalog/route-auth", () => ({
  authorizeCatalogRouteProject: authorizeCatalogRouteProjectMock,
}));
vi.mock("@/lib/flows/authored-bridge", () => ({
  bridgePublishedAuthoredFlow: bridgePublishedAuthoredFlowMock,
}));

describe("/api/projects/[slug]/catalog/caps/[capId]/publish-local", () => {
  beforeEach(() => {
    vi.resetModules();
    publishAuthoredCapabilityLocalMock.mockReset();
    authorizeCatalogRouteProjectMock.mockReset();
    bridgePublishedAuthoredFlowMock.mockReset();
    authorizeCatalogRouteProjectMock.mockResolvedValue({
      projectId: "project-demo",
    });
    bridgePublishedAuthoredFlowMock.mockResolvedValue({
      flowRowId: "flow-row-1",
      revisionId: "bridge-rev-1",
    });
  });

  it("publishes locally without mutating flow package rows", async () => {
    publishAuthoredCapabilityLocalMock.mockResolvedValue({
      revision: { id: "rev-1", kind: "flow", lifecycle: "PUBLISHED" },
      materializedRecordId: "record-1",
    });
    const { POST } = await import("../route");

    const response = await POST(
      new NextRequest(
        "http://localhost/api/projects/demo/catalog/caps/cap-1/publish-local",
        { method: "POST" },
      ),
      { params: Promise.resolve({ slug: "demo", capId: "cap-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(authorizeCatalogRouteProjectMock).toHaveBeenCalledWith("demo");
    expect(publishAuthoredCapabilityLocalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectSlug: "demo",
        capId: "cap-1",
        validateDraftRevision: expect.any(Function),
      }),
    );
    expect(body).toMatchObject({ id: "rev-1", lifecycle: "PUBLISHED" });
    expect(body.materializedRecordId).toBeUndefined();
  });

  it("refuses API publish when the authored Flow package draft is invalid", async () => {
    publishAuthoredCapabilityLocalMock.mockImplementation(async (args) => {
      args.validateDraftRevision({
        id: "rev-1",
        capabilityId: "cap-1",
        projectId: "project-demo",
        kind: "flow",
        revisionNumber: 1,
        lifecycle: "DRAFT",
        draftVersion: 1,
        title: "Broken Flow",
        body: { flowYaml: "foo: bar\n" },
        manifest: null,
        schemaVersion: 1,
        contentHash: "hash",
        publishedAt: null,
        archivedAt: null,
        createdAt: new Date(),
      });

      return {
        revision: { id: "rev-1", kind: "flow", lifecycle: "PUBLISHED" },
        materializedRecordId: null,
      };
    });
    const { POST } = await import("../route");

    const response = await POST(
      new NextRequest(
        "http://localhost/api/projects/demo/catalog/caps/cap-1/publish-local",
        { method: "POST" },
      ),
      { params: Promise.resolve({ slug: "demo", capId: "cap-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("rejects body-controlled publish payloads", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      new NextRequest(
        "http://localhost/api/projects/demo/catalog/caps/cap-1/publish-local",
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
    expect(publishAuthoredCapabilityLocalMock).not.toHaveBeenCalled();
  });

  it("rejects malformed publish payloads", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      new NextRequest(
        "http://localhost/api/projects/demo/catalog/caps/cap-1/publish-local",
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
    expect(publishAuthoredCapabilityLocalMock).not.toHaveBeenCalled();
  });
});
