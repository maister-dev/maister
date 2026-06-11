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
  AcpRunnerModal,
  type PresetRow,
  type RunnerRow,
} from "@/components/settings/acp-runner-modal";

const codexPreset: PresetRow = {
  id: "codex-openai",
  adapter: "codex",
  model: "gpt-5-codex",
  provider: { kind: "openai" },
  permissionPolicy: "default",
};

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

describe("AcpRunnerModal", () => {
  it("renders the create form with id/model fields and a preset picker", () => {
    const markup = renderToStaticMarkup(
      createElement(AcpRunnerModal, {
        mode: "create",
        sidecars: [],
        presets: [codexPreset],
        onClose() {},
        onSaved() {},
      }),
    );

    expect(markup).toContain("createRunnerTitle");
    expect(markup).toContain("fieldId");
    expect(markup).toContain("fieldModel");
    expect(markup).toContain("fromPreset");
    // the model field is the discovery-backed input + suggestion affordances
    expect(markup).toContain('aria-label="fieldModel"');
    expect(markup).toContain("modelSuggestions.refresh");
  });

  it("renders the edit form with delete affordance and the runner's values", () => {
    const markup = renderToStaticMarkup(
      createElement(AcpRunnerModal, {
        mode: "edit",
        runner: claudeRunner,
        sidecars: [],
        presets: [],
        onClose() {},
        onSaved() {},
      }),
    );

    expect(markup).toContain("editRunnerTitle");
    expect(markup).toContain("deleteRunner");
    expect(markup).toContain("claude-sonnet-4-6");
    expect(markup).toContain("claude-code");
  });
});
