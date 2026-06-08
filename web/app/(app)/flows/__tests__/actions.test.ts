import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

const authorizeCatalogRouteProjectMock = vi.hoisted(() => vi.fn());
const createAuthoredCapabilityMock = vi.hoisted(() => vi.fn());
const getAuthoredCapabilityMock = vi.hoisted(() => vi.fn());
const publishAuthoredCapabilityLocalMock = vi.hoisted(() => vi.fn());
const revalidatePathMock = vi.hoisted(() => vi.fn());
const redirectMock = vi.hoisted(() => vi.fn());
const updateAuthoredDraftMock = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("@/lib/catalog/authored-service", () => ({
  createAuthoredCapability: createAuthoredCapabilityMock,
  getAuthoredCapability: getAuthoredCapabilityMock,
  publishAuthoredCapabilityLocal: publishAuthoredCapabilityLocalMock,
  updateAuthoredDraft: updateAuthoredDraftMock,
}));

vi.mock("@/lib/catalog/route-auth", () => ({
  authorizeCatalogRouteProject: authorizeCatalogRouteProjectMock,
}));

describe("authored Flow server actions", () => {
  beforeEach(() => {
    authorizeCatalogRouteProjectMock.mockReset();
    createAuthoredCapabilityMock.mockReset();
    getAuthoredCapabilityMock.mockReset();
    publishAuthoredCapabilityLocalMock.mockReset();
    revalidatePathMock.mockReset();
    redirectMock.mockReset();
    updateAuthoredDraftMock.mockReset();
    authorizeCatalogRouteProjectMock.mockResolvedValue({
      projectId: "project-demo",
    });
    getAuthoredCapabilityMock.mockResolvedValue({
      capability: {
        id: "cap-1",
        slug: "release-review",
        title: "Release review",
      },
    });
  });

  it("authorizes update before parsing user-supplied YAML", async () => {
    authorizeCatalogRouteProjectMock.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "manageCatalog required"),
    );
    const { updateAuthoredFlowAction } = await import("../actions");

    await expect(
      updateAuthoredFlowAction(
        formDataOf({
          projectSlug: "demo",
          capId: "cap-1",
          title: "Unsafe",
          flowYaml: "{",
          packageFilesJson: "{",
          expectedDraftVersion: "1",
        }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(authorizeCatalogRouteProjectMock).toHaveBeenCalledWith("demo");
    expect(updateAuthoredDraftMock).not.toHaveBeenCalled();
  });

  it("bubbles optimistic-lock conflicts without overwriting the draft", async () => {
    updateAuthoredDraftMock.mockRejectedValue(
      new MaisterError("CONFLICT", "stale draft version"),
    );
    const { updateAuthoredFlowAction } = await import("../actions");

    await expect(
      updateAuthoredFlowAction(
        formDataOf({
          projectSlug: "demo",
          capId: "cap-1",
          capabilitySlug: "tampered-release",
          title: "Review",
          flowYaml: validFlowYaml(),
          expectedDraftVersion: "2",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(updateAuthoredDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({
        capId: "cap-1",
        input: expect.objectContaining({
          body: expect.objectContaining({
            packageMetadata: expect.objectContaining({
              slug: "release-review",
            }),
          }),
          expectedDraftVersion: 2,
        }),
      }),
    );
  });

  it("stores update package metadata from server-owned capability state", async () => {
    const { updateAuthoredFlowAction } = await import("../actions");

    await updateAuthoredFlowAction(
      formDataOf({
        projectSlug: "demo",
        capId: "cap-1",
        capabilitySlug: "tampered-release",
        title: "Review",
        flowYaml: validFlowYaml(),
        expectedDraftVersion: "1",
      }),
    );

    expect(getAuthoredCapabilityMock).toHaveBeenCalledWith({
      projectSlug: "demo",
      capId: "cap-1",
    });
    expect(updateAuthoredDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          body: expect.objectContaining({
            packageMetadata: expect.objectContaining({
              slug: "release-review",
              name: "Review",
            }),
          }),
        }),
      }),
    );
  });

  it("normalizes unsupported package file kinds before saving invalid drafts", async () => {
    const { updateAuthoredFlowAction } = await import("../actions");

    await updateAuthoredFlowAction(
      formDataOf({
        projectSlug: "demo",
        capId: "cap-1",
        title: "Review",
        flowYaml: validFlowYaml(),
        expectedDraftVersion: "1",
        packageFilesJson: JSON.stringify([
          {
            kind: "bogus",
            path: "adapters/codex.json",
            content: "{}\n",
          },
        ]),
      }),
    );

    expect(updateAuthoredDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          body: expect.objectContaining({
            files: [
              {
                kind: "asset",
                path: "adapters/codex.json",
                content: "{}\n",
              },
            ],
            validation: expect.objectContaining({
              status: "invalid",
              issues: expect.arrayContaining([
                expect.objectContaining({ code: "unsupported_kind" }),
              ]),
            }),
          }),
        }),
      }),
    );
  });

  it("saves empty YAML as an invalid authored draft after project authorization", async () => {
    const { updateAuthoredFlowAction } = await import("../actions");

    await updateAuthoredFlowAction(
      formDataOf({
        projectSlug: "demo",
        capId: "cap-1",
        title: "Review",
        flowYaml: "",
        expectedDraftVersion: "1",
      }),
    );

    expect(authorizeCatalogRouteProjectMock).toHaveBeenCalledWith("demo");
    expect(updateAuthoredDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          body: expect.objectContaining({
            flowYaml: "",
            validation: expect.objectContaining({
              status: "invalid",
              issues: expect.arrayContaining([
                expect.objectContaining({ code: "schema" }),
              ]),
            }),
          }),
        }),
      }),
    );
  });

  it("preserves raw authored YAML text when saving drafts", async () => {
    const rawYaml = `${validFlowYaml()}\n\n`;
    const { updateAuthoredFlowAction } = await import("../actions");

    await updateAuthoredFlowAction(
      formDataOf({
        projectSlug: "demo",
        capId: "cap-1",
        title: "Review",
        flowYaml: rawYaml,
        expectedDraftVersion: "1",
      }),
    );

    expect(updateAuthoredDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          body: expect.objectContaining({
            flowYaml: rawYaml,
          }),
        }),
      }),
    );
  });

  it("refuses to publish schema-invalid authored Flow YAML", async () => {
    mockPublishRevisionBody({ flowYaml: "foo: bar\n" });
    const { publishAuthoredFlowAction } = await import("../actions");

    await expect(
      publishAuthoredFlowAction(
        formDataOf({
          projectSlug: "demo",
          capId: "cap-1",
          expectedDraftVersion: "1",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    expect(authorizeCatalogRouteProjectMock).toHaveBeenCalledWith("demo");
    expect(publishAuthoredCapabilityLocalMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedDraftVersion: 1 }),
    );
  });

  it("refuses to publish graph-invalid authored Flow YAML", async () => {
    mockPublishRevisionBody({ flowYaml: graphInvalidFlowYaml() });
    const { publishAuthoredFlowAction } = await import("../actions");

    await expect(
      publishAuthoredFlowAction(
        formDataOf({
          projectSlug: "demo",
          capId: "cap-1",
          expectedDraftVersion: "1",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    expect(publishAuthoredCapabilityLocalMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedDraftVersion: 1 }),
    );
  });

  it("refuses to publish package-invalid authored Flow drafts", async () => {
    mockPublishRevisionBody({
      flowYaml: validFlowYaml(),
      packageMetadata: { slug: "review", name: "Review" },
      files: [
        {
          kind: "script",
          path: "../escape.sh",
          content: "#!/usr/bin/env bash\nexit 0\n",
        },
      ],
      validation: { status: "unknown", issueCount: 0, issues: [] },
    });
    const { publishAuthoredFlowAction } = await import("../actions");

    await expect(
      publishAuthoredFlowAction(
        formDataOf({
          projectSlug: "demo",
          capId: "cap-1",
          expectedDraftVersion: "1",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    expect(publishAuthoredCapabilityLocalMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedDraftVersion: 1 }),
    );
  });

  it("bubbles stale publish conflicts without revalidating a different draft", async () => {
    publishAuthoredCapabilityLocalMock.mockRejectedValue(
      new MaisterError("CONFLICT", "stale draft publish"),
    );
    const { publishAuthoredFlowAction } = await import("../actions");

    await expect(
      publishAuthoredFlowAction(
        formDataOf({
          projectSlug: "demo",
          capId: "cap-1",
          expectedDraftVersion: "3",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(publishAuthoredCapabilityLocalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        capId: "cap-1",
        expectedDraftVersion: 3,
        validateDraftRevision: expect.any(Function),
      }),
    );
  });

  it("passes a transaction-local publish validator to the catalog service", async () => {
    mockPublishRevisionBody({
      flowYaml: validFlowYaml(),
      packageMetadata: { slug: "review", name: "Review" },
      files: [],
      validation: { status: "valid", issueCount: 0, issues: [] },
    });
    const { publishAuthoredFlowAction } = await import("../actions");

    await publishAuthoredFlowAction(
      formDataOf({
        projectSlug: "demo",
        capId: "cap-1",
        expectedDraftVersion: "2",
      }),
    );

    expect(publishAuthoredCapabilityLocalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectSlug: "demo",
        capId: "cap-1",
        expectedDraftVersion: 2,
        validateDraftRevision: expect.any(Function),
      }),
    );
  });

  it("requires publish optimistic-lock version", async () => {
    const { publishAuthoredFlowAction } = await import("../actions");

    await expect(
      publishAuthoredFlowAction(
        formDataOf({ projectSlug: "demo", capId: "cap-1" }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    expect(publishAuthoredCapabilityLocalMock).not.toHaveBeenCalled();
  });

  it("creates drafts through project manageCatalog authorization", async () => {
    createAuthoredCapabilityMock.mockResolvedValue({
      capability: { id: "cap-1" },
    });
    redirectMock.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
    const { createAuthoredFlowAction } = await import("../actions");

    await expect(
      createAuthoredFlowAction(
        formDataOf({
          projectSlug: "demo",
          slug: "release-review",
          title: "Release review",
        }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(authorizeCatalogRouteProjectMock).toHaveBeenCalledWith("demo");
    expect(createAuthoredCapabilityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectSlug: "demo",
        input: expect.objectContaining({ kind: "flow" }),
      }),
    );
  });

  it("rejects unsafe create slugs before storing a draft", async () => {
    const { createAuthoredFlowAction } = await import("../actions");

    await expect(
      createAuthoredFlowAction(
        formDataOf({
          projectSlug: "demo",
          slug: "release-review\nnodes: []",
          title: "Release review",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    expect(createAuthoredCapabilityMock).not.toHaveBeenCalled();
  });
});

function mockPublishRevisionBody(body: Record<string, unknown>): void {
  publishAuthoredCapabilityLocalMock.mockImplementation(async (args) => {
    args.validateDraftRevision({
      id: "rev-draft",
      capabilityId: "cap-1",
      projectId: "project-demo",
      kind: "flow",
      revisionNumber: 1,
      lifecycle: "DRAFT",
      draftVersion: args.expectedDraftVersion,
      title: "Review",
      body,
      manifest: null,
      schemaVersion: 1,
      contentHash: "hash",
      publishedAt: null,
      archivedAt: null,
      createdAt: new Date(),
    });

    return {
      revision: {
        id: "rev-draft",
        capabilityId: "cap-1",
        projectId: "project-demo",
        kind: "flow",
        revisionNumber: 1,
        lifecycle: "PUBLISHED",
        draftVersion: args.expectedDraftVersion,
        title: "Review",
        body,
        manifest: null,
        schemaVersion: 1,
        contentHash: "hash",
        publishedAt: new Date(),
        archivedAt: null,
        createdAt: new Date(),
      },
      materializedRecordId: null,
    };
  });
}

function formDataOf(values: Record<string, string>): FormData {
  const formData = new FormData();

  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }

  return formData;
}

function validFlowYaml(): string {
  return [
    "schemaVersion: 1",
    "name: review",
    "compat:",
    "  engine_min: 1.1.0",
    "nodes:",
    "  - id: plan",
    "    type: ai_coding",
    "    action:",
    "      prompt: Plan",
    "    transitions:",
    "      success: done",
    "",
  ].join("\n");
}

function graphInvalidFlowYaml(): string {
  return [
    "schemaVersion: 1",
    "name: review",
    "compat:",
    "  engine_min: 1.1.0",
    "nodes:",
    "  - id: plan",
    "    type: ai_coding",
    "    action:",
    "      prompt: Plan",
    "    transitions:",
    "      success: missing",
    "",
  ].join("\n");
}
