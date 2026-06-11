import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import {
  ModelAutocomplete,
  type ModelGroup,
} from "@/components/settings/model-autocomplete";

const groups: ModelGroup[] = [
  {
    source: "acp_probe",
    label: "Agent",
    status: "ok",
    models: [{ id: "glm-5.1" }, { id: "glm-5.1-air", displayName: "GLM Air" }],
  },
  {
    source: "curated",
    label: "Curated",
    status: "ok",
    models: [{ id: "claude-sonnet-4-6" }],
  },
];

function render(
  props: Partial<Parameters<typeof ModelAutocomplete>[0]>,
): string {
  return renderToStaticMarkup(
    createElement(ModelAutocomplete, {
      value: "",
      onValueChange() {},
      groups: [],
      loading: false,
      error: false,
      unknownModel: false,
      onRefresh() {},
      label: "fieldModel",
      ...props,
    }),
  );
}

describe("ModelAutocomplete", () => {
  it("renders the model field with its label", () => {
    const markup = render({ groups });

    expect(markup).toContain("fieldModel");
    // a free-text input (any model id is valid) the user types the model id into
    expect(markup).toContain('aria-label="fieldModel"');
    expect(markup).toContain('type="text"');
  });

  it("renders each group's label, model ids, and origin badges from seeded groups", () => {
    const markup = render({ groups });

    expect(markup).toContain("Agent");
    expect(markup).toContain("Curated");
    expect(markup).toContain("glm-5.1");
    expect(markup).toContain("glm-5.1-air");
    expect(markup).toContain("GLM Air");
    expect(markup).toContain("claude-sonnet-4-6");
    // origin badge text appears once per group (the group label is the badge)
    expect(markup.match(/Agent/g)?.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the loading affordance when loading", () => {
    const markup = render({ loading: true });

    expect(markup).toContain("modelSuggestions.loading");
  });

  it("renders the empty affordance when there are no groups and not loading", () => {
    const markup = render({ groups: [], loading: false });

    expect(markup).toContain("modelSuggestions.empty");
  });

  it("renders the error affordance when error", () => {
    const markup = render({ error: true });

    expect(markup).toContain("modelSuggestions.error");
  });

  it("renders the unknown-model advisory hint when unknownModel", () => {
    const markup = render({ value: "my-custom", unknownModel: true });

    expect(markup).toContain("modelSuggestions.unknownModelHint");
  });

  it("renders the refresh affordance", () => {
    const markup = render({ groups });

    expect(markup).toContain("modelSuggestions.refresh");
  });

  it("preserves a custom value in the field", () => {
    const markup = render({ value: "my-custom-model" });

    expect(markup).toContain("my-custom-model");
  });
});
