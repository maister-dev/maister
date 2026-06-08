import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/settings",
}));

import {
  AcpRunnersPanel,
  type RunnerRow,
} from "@/components/settings/acp-runners-panel";

const claudeRunner: RunnerRow = {
  id: "claude-code",
  adapter: "claude",
  capabilityAgent: "claude",
  model: "claude-sonnet-4-6",
  provider: { kind: "anthropic" },
  permissionPolicy: "default",
  sidecarId: null,
  readinessStatus: "Ready",
  readinessReasons: [],
  enabled: true,
};

const codexRunner: RunnerRow = {
  id: "codex-openai",
  adapter: "codex",
  capabilityAgent: "codex",
  model: "gpt-5-codex",
  provider: { kind: "openai" },
  permissionPolicy: "default",
  sidecarId: null,
  readinessStatus: "Ready",
  readinessReasons: [],
  enabled: true,
};

describe("AcpRunnersPanel", () => {
  it("renders a runner table with an add action and per-runner rows", () => {
    const markup = renderToStaticMarkup(
      createElement(AcpRunnersPanel, {
        defaultRunnerId: "claude-code",
        presets: [],
        sidecars: [],
        runners: [claudeRunner, codexRunner],
      }),
    );

    expect(markup).toContain("addRunner");
    expect(markup).toContain("colId");
    expect(markup).toContain("colAdapter");
    expect(markup).toContain("colModel");
    expect(markup).toContain("colReadiness");
    expect(markup).toContain("colActions");
    expect(markup).toContain("platformDefaultRunner");
    expect(markup).toContain("providerPresets");
    expect(markup).toContain("claude-code");
    expect(markup).toContain("codex-openai");
  });
});
