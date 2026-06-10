import type {
  ModelCatalogDraft,
  ModelEntry,
  ModelSource,
  SourceKind,
} from "./types";

import { describe, expect, it } from "vitest";

import { ModelSourceRegistry } from "./registry";

function fakeSource(
  kind: SourceKind,
  supports: boolean,
  models: ModelEntry[] = [],
): ModelSource {
  return {
    kind,
    supports: () => supports,
    resolve: async () => ({
      models,
      status: { kind, status: "ok", count: models.length },
    }),
  };
}

const draft: ModelCatalogDraft = {
  adapter: "claude",
  provider: { kind: "anthropic" },
};

describe("ModelSourceRegistry", () => {
  it("list() returns sources in registration order", () => {
    const a = fakeSource("acp_probe", true);
    const b = fakeSource("provider_api", true);
    const registry = new ModelSourceRegistry([a]);

    registry.register(b);

    expect(registry.list()).toEqual([a, b]);
  });

  it("register() appends to the end", () => {
    const a = fakeSource("acp_probe", true);
    const b = fakeSource("curated", true);
    const c = fakeSource("ccr", true);
    const registry = new ModelSourceRegistry([a, b]);

    registry.register(c);

    expect(registry.list()).toEqual([a, b, c]);
  });

  it("supporting() returns only sources whose supports() is true, in registration order", () => {
    const a = fakeSource("acp_probe", true);
    const skip = fakeSource("provider_api", false);
    const b = fakeSource("curated", true);
    const registry = new ModelSourceRegistry([a, skip, b]);

    expect(registry.supporting(draft)).toEqual([a, b]);
  });

  it("supporting() is empty when no source supports the draft", () => {
    const registry = new ModelSourceRegistry([
      fakeSource("acp_probe", false),
      fakeSource("ccr", false),
    ]);

    expect(registry.supporting(draft)).toEqual([]);
  });

  it("defaults to an empty registry when no sources are passed", () => {
    const registry = new ModelSourceRegistry();

    expect(registry.list()).toEqual([]);
    expect(registry.supporting(draft)).toEqual([]);
  });
});
