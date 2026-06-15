import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

const getPlatformFlowsMock = vi.hoisted(() => vi.fn());
const requireSessionMock = vi.hoisted(() => vi.fn());
const redirectMock = vi.hoisted(() => vi.fn());

vi.mock("next-intl/server", () => ({
  getTranslations:
    async () => (key: string, values?: Record<string, unknown>) =>
      translate(key, values),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("@/lib/authz", () => ({
  requireSession: requireSessionMock,
}));

vi.mock("@/lib/queries/platform-flows", () => ({
  getPlatformFlows: getPlatformFlowsMock,
  parsePlatformFlowSearchParams: () => ({ project: "all", status: "all" }),
}));

describe("platform Flows page contracts", () => {
  beforeEach(() => {
    getPlatformFlowsMock.mockReset();
    requireSessionMock.mockReset();
    redirectMock.mockReset();
    requireSessionMock.mockResolvedValue({
      id: "user-1",
      role: "member",
    });
    getPlatformFlowsMock.mockResolvedValue(platformFlowsView());
  });

  it("allows a global member with project manageCatalog access to open the new page", async () => {
    const { default: NewFlowPage } = await import("../new/page");

    const html = renderToStaticMarkup(await NewFlowPage());

    expect(redirectMock).not.toHaveBeenCalled();
    expect(html).toContain("Demo Project");
    expect(html).toContain("Create draft");
  });

  it("defines EN and RU labels for every visible Flow state enum", () => {
    const requiredKeys = [
      "enablement.Disabled",
      "enablement.Enabled",
      "enablement.Failed",
      "enablement.Deprecated",
      "enablement.Installed",
      "enablement.UpdateAvailable",
      "lifecycle.ARCHIVED",
      "lifecycle.DRAFT",
      "lifecycle.PUBLISHED",
      "packageStatus.Discovered",
      "packageStatus.Failed",
      "packageStatus.Installing",
      "packageStatus.Installed",
      "packageStatus.Removed",
      "setup.done",
      "setup.failed",
      "setup.not_required",
      "setup.pending",
      "trust.trusted",
      "trust.trusted_by_policy",
      "trust.untrusted",
      "validation.invalid",
      "validation.unknown",
      "validation.valid",
    ];

    for (const key of requiredKeys) {
      expect(messageAt(en.flows, key), `en.flows.${key}`).toEqual(
        expect.any(String),
      );
      expect(messageAt(ru.flows, key), `ru.flows.${key}`).toEqual(
        expect.any(String),
      );
    }
  });
});

function platformFlowsView(): unknown {
  return {
    projects: [
      {
        id: "project-1",
        slug: "demo",
        name: "Demo Project",
        canManageCatalog: true,
      },
    ],
    authored: [
      {
        id: "cap-1",
        projectSlug: "demo",
        projectName: "Demo Project",
        slug: "release-review",
        title: "Release review",
        lifecycle: "DRAFT",
        draftVersion: 1,
        currentDraftRevisionId: "rev-draft",
        currentPublishedRevisionId: null,
        draftContentHash: "abcdef1234567890",
        publishedContentHash: null,
        updatedAt: new Date("2026-06-08T00:00:00.000Z"),
      },
    ],
    installed: [
      {
        id: "flow-1",
        projectSlug: "demo",
        projectName: "Demo Project",
        ref: "aif",
        source: "file:///repo/plugins/aif",
        version: "local-dev",
        revision: "abc123",
        enablementState: "Installed",
        trustStatus: "trusted_by_policy",
        enabledRevisionId: "flow-rev-1",
        enabledVersionLabel: "local-dev",
        enabledResolvedRevision: "abc123",
        packageStatus: "Installing",
        setupStatus: "done",
      },
    ],
    filters: {
      project: "all",
      status: "all",
    },
  };
}

function translate(
  key: string,
  values: Record<string, unknown> | undefined,
): string {
  const messages: Record<string, string> = {
    authored: "Authored",
    authoredCount: `${String(values?.count ?? 0)} local`,
    authoredEmpty: "No authored Flow drafts yet.",
    authoredTitle: "Authored Flow drafts",
    backToFlows: "Back to Flows",
    cancel: "Cancel",
    createDraft: "Create draft",
    draftVersion: "Draft version",
    eyebrow: "Platform package workbench",
    flowTitle: "Flow title",
    hash: "Hash",
    installed: "Installed",
    installedCount: `${String(values?.count ?? 0)} attached`,
    installedEmpty:
      "No executable Flow packages are installed for visible projects.",
    installedTitle: "Installed package attachments",
    newEyebrow: "Local catalog draft",
    newFlow: "New Flow",
    newSub: "Start with a portable flow.yaml draft.",
    newTitle: "New authored Flow",
    project: "Project",
    projects: "Projects",
    source: "Source",
    sub: "Create local Flow drafts.",
    title: "Flows",
    titlePlaceholder: "Release review",
    trust: "Trust",
    version: "Version",
    "enablement.Deprecated": "Deprecated",
    "enablement.Disabled": "Disabled",
    "enablement.Enabled": "Enabled",
    "enablement.Failed": "Failed",
    "enablement.Installed": "Installed",
    "enablement.UpdateAvailable": "Update available",
    "lifecycle.ARCHIVED": "Archived",
    "lifecycle.DRAFT": "Draft",
    "lifecycle.PUBLISHED": "Published",
    "packageStatus.Discovered": "Discovered",
    "packageStatus.Failed": "Failed",
    "packageStatus.Installing": "Installing",
    "packageStatus.Installed": "Installed",
    "packageStatus.Removed": "Removed",
    "setup.done": "Done",
    "trust.trusted_by_policy": "Trusted by policy",
  };

  return messages[key] ?? key;
}

function messageAt(messages: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined,
      messages,
    );
}
