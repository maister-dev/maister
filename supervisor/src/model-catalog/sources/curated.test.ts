import type { ModelCatalogDraft, ResolveContext } from "../types";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { createCuratedSource } from "./curated";

const ctx: ResolveContext = { logger: pino({ level: "silent" }) };

function draftWith(provider: ModelCatalogDraft["provider"]): ModelCatalogDraft {
  return { adapter: "claude", provider };
}

describe("createCuratedSource", () => {
  it("declares kind 'curated'", () => {
    expect(createCuratedSource().kind).toBe("curated");
  });

  it("supports only anthropic_compatible", () => {
    const source = createCuratedSource();

    expect(source.supports(draftWith({ kind: "anthropic_compatible" }))).toBe(
      true,
    );
    expect(source.supports(draftWith({ kind: "anthropic" }))).toBe(false);
    expect(source.supports(draftWith({ kind: "openai" }))).toBe(false);
    expect(source.supports(draftWith({ kind: "openai_compatible" }))).toBe(
      false,
    );
  });

  it("returns the five curated GLM models with origins ['curated'] and ok status count 5", async () => {
    const source = createCuratedSource();

    const { models, status } = await source.resolve(
      draftWith({ kind: "anthropic_compatible" }),
      ctx,
    );

    expect(status).toEqual({ kind: "curated", status: "ok", count: 5 });
    expect(models).toEqual([
      { id: "glm-5.1", displayName: "GLM-5.1", origins: ["curated"] },
      { id: "glm-5", displayName: "GLM-5", origins: ["curated"] },
      { id: "glm-5-turbo", displayName: "GLM-5-Turbo", origins: ["curated"] },
      { id: "glm-4.7", displayName: "GLM-4.7", origins: ["curated"] },
      { id: "glm-4.5-air", displayName: "GLM-4.5-air", origins: ["curated"] },
    ]);
  });

  it("never throws regardless of provider kind passed to resolve", async () => {
    const source = createCuratedSource();

    await expect(
      source.resolve(draftWith({ kind: "anthropic" }), ctx),
    ).resolves.toBeDefined();
  });

  it("returns a fresh models array on each call (no shared mutable state)", async () => {
    const source = createCuratedSource();
    const first = await source.resolve(
      draftWith({ kind: "anthropic_compatible" }),
      ctx,
    );
    const second = await source.resolve(
      draftWith({ kind: "anthropic_compatible" }),
      ctx,
    );

    expect(first.models).not.toBe(second.models);
    first.models[0].origins.push("provider_api");
    expect(second.models[0].origins).toEqual(["curated"]);
  });
});
