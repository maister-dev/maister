import { describe, expect, it } from "vitest";

import { canShowProjectBrainTab } from "@/lib/brain/availability";

describe("canShowProjectBrainTab", () => {
  it("requires a project opt-in, Brain schema, and embedding configuration", () => {
    expect(
      canShowProjectBrainTab({
        brainEnabled: true,
        brainSchemaApplied: true,
        embeddingConfigured: true,
      }),
    ).toBe(true);
    expect(
      canShowProjectBrainTab({
        brainEnabled: false,
        brainSchemaApplied: true,
        embeddingConfigured: true,
      }),
    ).toBe(false);
    expect(
      canShowProjectBrainTab({
        brainEnabled: true,
        brainSchemaApplied: false,
        embeddingConfigured: true,
      }),
    ).toBe(false);
    expect(
      canShowProjectBrainTab({
        brainEnabled: true,
        brainSchemaApplied: true,
        embeddingConfigured: false,
      }),
    ).toBe(false);
  });
});
