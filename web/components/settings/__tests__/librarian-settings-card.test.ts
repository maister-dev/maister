import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { LibrarianSettingsCard } from "@/components/settings/librarian-settings-card";
import { librarianSettingsView } from "@/lib/librarian/settings-view";

// ADR-183 (T2.13): the librarian card says why a runner cannot be chosen and
// what the resulting readiness is, in the admin's language.

const runner = (overrides: Record<string, unknown>) => ({
  id: "claude-code",
  capabilityAgent: "claude",
  model: "claude-sonnet-4-6",
  permissionPolicy: "default",
  env: {},
  enabled: true,
  readinessStatus: "Ready",
  ...overrides,
});

function render(view: ReturnType<typeof librarianSettingsView>): string {
  return renderToStaticMarkup(createElement(LibrarianSettingsCard, { view }));
}

describe("librarian settings card", () => {
  it("shows the readiness of an enabled, ready configuration", () => {
    const markup = render(
      librarianSettingsView(
        { librarianEnabled: true, librarianRunnerId: "claude-code" },
        [runner({})],
      ),
    );

    expect(markup).toContain("librarianReadiness_ready");
    expect(markup).not.toContain("librarian-no-eligible");
  });

  it("names each disabled reason on its runner option", () => {
    const markup = render(
      librarianSettingsView(
        { librarianEnabled: true, librarianRunnerId: null },
        [
          runner({ id: "gemini", capabilityAgent: "gemini" }),
          runner({ id: "codex", capabilityAgent: "codex" }),
          runner({
            id: "skipper",
            permissionPolicy: "dangerously_skip_permissions",
          }),
          runner({ id: "homed", env: { HOME: "/tmp/x" } }),
          runner({ id: "off", enabled: false }),
        ],
      ),
    );

    expect(markup).toContain("librarianIneligible_capability_not_supported");
    expect(markup).toContain("librarianIneligible_builtin_denial_unverified");
    expect(markup).toContain("librarianIneligible_skips_permissions");
    expect(markup).toContain("librarianIneligible_reserved_env");
    expect(markup).toContain("librarianIneligible_disabled");
    expect(markup).toContain("librarian-no-eligible");
    expect(markup).toContain("librarianReadiness_not_configured");
  });

  it("reports a disabled librarian and a not-ready runner", () => {
    expect(
      render(
        librarianSettingsView(
          { librarianEnabled: false, librarianRunnerId: "claude-code" },
          [runner({})],
        ),
      ),
    ).toContain("librarianReadiness_disabled");
    const notReady = render(
      librarianSettingsView(
        { librarianEnabled: true, librarianRunnerId: "claude-code" },
        [runner({ readinessStatus: "NotReady" })],
      ),
    );

    expect(notReady).toContain("librarianReadiness_runner_not_ready");
    expect(notReady).toContain("librarianRunnerNotReady");
  });
});
