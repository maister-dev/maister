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

  it("renders a good-tone dot with the ambient-credentials tooltip for a Ready native runner", () => {
    const markup = renderToStaticMarkup(
      createElement(AcpRunnersPanel, {
        defaultRunnerId: "claude-code",
        presets: [],
        sidecars: [],
        runners: [claudeRunner],
      }),
    );

    expect(markup).toContain("bg-good");
    expect(markup).toContain('title="readinessAmbient"');
  });

  it("renders an attention-tone dot whose tooltip carries the readiness reasons for a NotReady runner", () => {
    const notReady: RunnerRow = {
      ...codexRunner,
      id: "codex-zai-glm",
      readinessStatus: "NotReady",
      readinessReasons: ["adapter binary is unavailable: codex"],
    };
    const markup = renderToStaticMarkup(
      createElement(AcpRunnersPanel, {
        defaultRunnerId: "claude-code",
        presets: [],
        sidecars: [],
        runners: [notReady],
      }),
    );

    expect(markup).toContain("bg-attention");
    expect(markup).toContain("adapter binary is unavailable: codex");
  });

  it("renders a muted dot for an Unknown runner", () => {
    const unknown: RunnerRow = {
      ...codexRunner,
      id: "pending-runner",
      readinessStatus: "Unknown",
      readinessReasons: [],
    };
    const markup = renderToStaticMarkup(
      createElement(AcpRunnersPanel, {
        defaultRunnerId: "claude-code",
        presets: [],
        sidecars: [],
        runners: [unknown],
      }),
    );

    expect(markup).toContain("bg-mute");
    expect(markup).toContain('title="readinessUnknown"');
  });
});
