import { describe, expect, it } from "vitest";

import { readSessionModels } from "../session-models";

describe("readSessionModels", () => {
  it("prefers the ACP 1.x model config option over the legacy models field", () => {
    const view = readSessionModels({
      sessionId: "s",
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "agent",
          options: [{ value: "agent", name: "Agent" }],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-6-astra",
          options: [
            { value: "gpt-6-astra", name: "GPT-6 Astra" },
            {
              group: "legacy",
              name: "Legacy",
              options: [{ value: "gpt-5.5", name: "GPT-5.5" }],
            },
          ],
        },
      ],
      models: {
        availableModels: [{ modelId: "gpt-6-astra[xhigh]" }],
        currentModelId: "gpt-6-astra[xhigh]",
      },
    });

    expect(view).toEqual({
      configId: "model",
      currentModelId: "gpt-6-astra",
      availableModels: [
        { modelId: "gpt-6-astra", name: "GPT-6 Astra" },
        { modelId: "gpt-5.5", name: "GPT-5.5" },
      ],
    });
  });

  it("falls back to the legacy models field and drops malformed entries", () => {
    expect(
      readSessionModels({
        sessionId: "s",
        models: {
          availableModels: [
            { modelId: "glm-5.1", name: "GLM-5.1" },
            { bogus: true },
          ],
          currentModelId: "glm-5.1",
        },
      }),
    ).toEqual({
      configId: null,
      currentModelId: "glm-5.1",
      availableModels: [{ modelId: "glm-5.1", name: "GLM-5.1" }],
    });
  });

  it("never throws on malformed input", () => {
    for (const input of [
      null,
      undefined,
      42,
      "x",
      {},
      { configOptions: "nope" },
      {
        configOptions: [
          null,
          { type: "select", category: "model", options: "x" },
        ],
      },
      { models: { availableModels: "glm" } },
    ]) {
      expect(() => readSessionModels(input)).not.toThrow();
    }
    expect(
      readSessionModels({
        configOptions: [{ type: "select", category: "model", options: "x" }],
      }),
    ).toEqual({ configId: null, currentModelId: null, availableModels: [] });
  });
});
