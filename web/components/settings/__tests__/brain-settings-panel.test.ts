import type { BrainSettings } from "@/lib/brain/settings";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

import { BrainSettingsPanel } from "@/components/settings/brain-settings-panel";

const EMPTY: BrainSettings = {
  embeddingBaseUrl: null,
  embeddingModel: null,
  embeddingDimensions: null,
  embeddingApiKeyRef: null,
  distillModel: null,
};

function render(settings: BrainSettings): string {
  return renderToStaticMarkup(createElement(BrainSettingsPanel, { settings }));
}

describe("BrainSettingsPanel (admin platform)", () => {
  it("renders the section title and all five config fields", () => {
    const html = render(EMPTY);

    expect(html).toContain("settings.brainTitle");
    expect(html).toContain("settings.brainBaseUrl");
    expect(html).toContain("settings.brainModel");
    expect(html).toContain("settings.brainDimensions");
    expect(html).toContain("settings.brainApiKeyRef");
    expect(html).toContain("settings.brainDistillModel");
    // A save affordance, and no success glyph before any save.
    expect(html).toContain("settings.save");
    expect(html).not.toContain("settings.brainSaved");
  });

  it("hydrates the inputs from the stored settings (model + dimensions)", () => {
    const html = render({
      ...EMPTY,
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      embeddingApiKeyRef: "env:EMBEDDING_API_KEY",
    });

    expect(html).toContain('value="text-embedding-3-small"');
    expect(html).toContain('value="1536"');
    // The API key REFERENCE (env:NAME) is shown — it is not a secret.
    expect(html).toContain('value="env:EMBEDDING_API_KEY"');
  });
});
