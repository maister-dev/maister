import type { RunnerDraft } from "@/lib/acp-runners/runner-form";

import { describe, expect, it } from "vitest";

import { buildModelSuggestionRequestBody } from "@/components/settings/use-model-suggestions";

function draft(overrides: Partial<RunnerDraft>): RunnerDraft {
  return {
    id: "runner",
    adapter: "claude",
    model: "model",
    providerKind: "anthropic",
    permissionPolicy: "default",
    sidecarId: null,
    enabled: true,
    ...overrides,
  };
}

describe("buildModelSuggestionRequestBody", () => {
  it("sends Gemini provider fields without falling back to Anthropic", () => {
    expect(
      buildModelSuggestionRequestBody(
        draft({
          adapter: "gemini",
          providerKind: "google_vertex",
          projectId: "maister-prod",
          location: "us-central1",
          apiKey: "env:GOOGLE_API_KEY",
        }),
        false,
      ),
    ).toEqual({
      adapter: "gemini",
      provider: {
        kind: "google_vertex",
        projectId: "maister-prod",
        location: "us-central1",
        apiKey: "env:GOOGLE_API_KEY",
      },
    });
  });

  it("sends OpenCode native provider drafts without foreign provider defaults", () => {
    expect(
      buildModelSuggestionRequestBody(
        draft({ adapter: "opencode", providerKind: "agent_native" }),
        true,
      ),
    ).toEqual({
      adapter: "opencode",
      provider: { kind: "agent_native" },
      force: true,
    });
  });

  it("sends MiMo native provider drafts without OpenCode aliasing", () => {
    expect(
      buildModelSuggestionRequestBody(
        draft({ adapter: "mimo", providerKind: "agent_native" }),
        true,
      ),
    ).toEqual({
      adapter: "mimo",
      provider: { kind: "agent_native" },
      force: true,
    });
  });
});
