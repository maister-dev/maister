import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

const requireActiveSessionMock = vi.hoisted(() => vi.fn());
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
  requireActiveSession: requireActiveSessionMock,
}));

describe("platform Flows page contracts", () => {
  beforeEach(() => {
    requireActiveSessionMock.mockReset();
    redirectMock.mockReset();
    requireActiveSessionMock.mockResolvedValue({
      id: "user-1",
      role: "member",
    });
  });

  it("redirects authenticated users from the retired authored-draft route to the canonical Studio wizard", async () => {
    const { default: NewFlowPage } = await import("../new/page");

    await NewFlowPage();

    expect(requireActiveSessionMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/studio/packages?create=flow");
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
