import { describe, expect, it } from "vitest";

import {
  filterPlatformFlows,
  parsePlatformFlowSearchParams,
} from "@/lib/queries/platform-flows";

describe("platform Flow query contracts", () => {
  it("parses URL-synced project and status filters", () => {
    expect(
      parsePlatformFlowSearchParams({
        project: " demo ",
        status: "published",
      }),
    ).toEqual({ project: "demo", status: "published" });

    expect(
      parsePlatformFlowSearchParams({
        project: ["demo", "other"],
        status: "not-a-status",
      }),
    ).toEqual({ project: "demo", status: "all" });

    expect(
      parsePlatformFlowSearchParams({
        project: "demo",
        status: "installing",
      }),
    ).toEqual({ project: "demo", status: "installing" });
  });

  it("filters authored and installed rows without changing source data", () => {
    const view = {
      projects: [
        {
          id: "project-1",
          slug: "demo",
          name: "Demo",
          canManageCatalog: true,
        },
        {
          id: "project-2",
          slug: "ops",
          name: "Ops",
          canManageCatalog: false,
        },
      ],
      authored: [
        authoredFlow("cap-draft", "demo", "DRAFT"),
        authoredFlow("cap-published", "demo", "PUBLISHED"),
        authoredFlow("cap-other", "ops", "DRAFT"),
      ],
      installed: [
        installedFlow("flow-enabled", "demo", "Enabled"),
        installedFlow("flow-disabled", "demo", "Disabled"),
        {
          ...installedFlow("flow-installing", "demo", "Installed"),
          packageStatus: "Installing",
        },
        installedFlow("flow-other", "ops", "Enabled"),
      ],
    };

    const filtered = filterPlatformFlows(view, {
      project: "demo",
      status: "published",
    });

    expect(filtered.authored.map((flow) => flow.id)).toEqual(["cap-published"]);
    expect(filtered.installed).toHaveLength(0);
    expect(view.authored).toHaveLength(3);

    const installing = filterPlatformFlows(view, {
      project: "demo",
      status: "installing",
    });

    expect(installing.installed.map((flow) => flow.id)).toEqual([
      "flow-installing",
    ]);
  });
});

function authoredFlow(
  id: string,
  projectSlug: string,
  lifecycle: "DRAFT" | "PUBLISHED" | "ARCHIVED",
) {
  return {
    id,
    projectSlug,
    projectName: projectSlug,
    slug: id,
    title: id,
    lifecycle,
    draftVersion: 1,
    currentDraftRevisionId: null,
    currentPublishedRevisionId: null,
    draftContentHash: null,
    publishedContentHash: null,
    updatedAt: new Date("2026-06-08T00:00:00.000Z"),
  };
}

function installedFlow(
  id: string,
  projectSlug: string,
  enablementState: string,
) {
  return {
    id,
    projectSlug,
    projectName: projectSlug,
    ref: id,
    source: "file:///flow",
    version: "local-dev",
    revision: "abc123",
    enablementState,
    trustStatus: "trusted_by_policy",
    enabledRevisionId: "rev-1",
    enabledVersionLabel: "local-dev",
    enabledResolvedRevision: "abc123",
    packageStatus: "Installed",
    setupStatus: "done",
  };
}
