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
  env: { ANTHROPIC_MODEL: "env:CLAUDE_MODEL_ENV" },
};

const geminiVertexRunner: RunnerRow = {
  id: "gemini-vertex",
  adapter: "gemini",
  capabilityAgent: "gemini",
  model: "gemini-2.5-pro",
  provider: {
    kind: "google_vertex",
    projectId: "maister-prod",
    location: "us-central1",
    apiKey: "env:GOOGLE_API_KEY",
  },
  permissionPolicy: "default",
  sidecarId: null,
  readinessStatus: "NotReady",
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
    expect(markup).toContain('value="gemini"');
    expect(markup).toContain('value="opencode"');
    // the model field is the discovery-backed input + suggestion affordances
    expect(markup).toContain('aria-label="fieldModel"');
    expect(markup).toContain("modelSuggestions.refresh");
  });

  it("prefills the create form from initialPresetId (Use-prefill)", () => {
    const markup = renderToStaticMarkup(
      createElement(AcpRunnerModal, {
        mode: "create",
        sidecars: [],
        presets: [codexPreset],
        initialPresetId: "codex-openai",
        onClose() {},
        onSaved() {},
      }),
    );

    // Model seeded from the preset (empty without prefill).
    expect(markup).toContain("gpt-5-codex");
    // The openai provider-kind option only exists for the codex adapter, so
    // its presence proves the adapter was seeded to codex.
    expect(markup).toContain('value="openai"');
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
    expect(markup).toContain("fieldEnv");
    expect(markup).toContain("fieldEnvHint");
    expect(markup).toContain("ANTHROPIC_MODEL");
    expect(markup).toContain("env:CLAUDE_MODEL_ENV");
  });

  it("renders Gemini provider fields without Claude/Codex-only assumptions", () => {
    const markup = renderToStaticMarkup(
      createElement(AcpRunnerModal, {
        mode: "edit",
        runner: geminiVertexRunner,
        sidecars: [],
        presets: [],
        onClose() {},
        onSaved() {},
      }),
    );

    expect(markup).toContain("gemini-vertex");
    expect(markup).toContain("google_vertex");
    expect(markup).toContain("fieldProjectId");
    expect(markup).toContain("fieldLocation");
    expect(markup).toContain("maister-prod");
    expect(markup).toContain("us-central1");
    expect(markup).toContain("env:GOOGLE_API_KEY");
  });
});
