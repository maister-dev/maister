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
    expect(markup).toContain("providerPresetsReference");
    expect(markup).toContain("claude-code");
    expect(markup).toContain("codex-openai");
  });

  it("renders icon action buttons (edit, enable/disable, remove) with accessible labels", () => {
    const markup = renderToStaticMarkup(
      createElement(AcpRunnersPanel, {
        defaultRunnerId: "claude-code",
        presets: [],
        sidecars: [],
        runners: [codexRunner],
      }),
    );

    // Row actions are icon buttons carrying the action as an accessible name.
    expect(markup).toContain('aria-label="editAction"');
    expect(markup).toContain('aria-label="deleteRunner"');
    // codexRunner is enabled → the toggle offers the disable action.
    expect(markup).toContain("disable");
    // Glyphs, not text-only labels.
    expect(markup).toContain("<svg");
  });

  it("renders the provider presets as a collapsed reference list with Use buttons", () => {
    const preset = {
      id: "codex-zai-glm",
      adapter: "codex" as const,
      model: "glm-5.1",
      provider: { kind: "openai_compatible" },
      permissionPolicy: "default" as const,
      sidecarId: null,
      readinessStatus: "NotReady" as const,
      readinessReasons: [] as readonly string[],
    };
    const markup = renderToStaticMarkup(
      createElement(AcpRunnersPanel, {
        defaultRunnerId: "claude-code",
        presets: [preset],
        sidecars: [],
        runners: [claudeRunner],
      }),
    );

    expect(markup).toContain("<details");
    expect(markup).toContain("providerPresetsReference");
    expect(markup).toContain("codex-zai-glm");
    expect(markup).toContain("usePreset");
    // Reference list shows no readiness badge text.
    expect(markup).not.toContain("NotReady");
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
