import { afterEach, describe, expect, it, vi } from "vitest";

const MAX_CHUNKS_ENV = "MAISTER_BRAIN_MAX_CHUNKS_PER_JOB";
const MAX_SEGMENTS_ENV = "MAISTER_BRAIN_MAX_EMBEDDING_SEGMENTS_PER_JOB";

async function loadLimits(): Promise<{
  chunks: number;
  segments: number;
}> {
  vi.resetModules();

  const mod = await import("@/lib/brain/indexer");

  return {
    chunks: mod.BRAIN_SOURCE_MAX_CHUNKS_PER_JOB,
    segments: mod.BRAIN_SOURCE_MAX_EMBEDDING_SEGMENTS_PER_JOB,
  };
}

describe("Project Brain source indexer env limits", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses default source-indexer limits when env is unset", async () => {
    expect(await loadLimits()).toEqual({ chunks: 1_000, segments: 2_000 });
  });

  it("uses positive integer env overrides", async () => {
    vi.stubEnv(MAX_CHUNKS_ENV, "5000");
    vi.stubEnv(MAX_SEGMENTS_ENV, "7000");

    expect(await loadLimits()).toEqual({ chunks: 5_000, segments: 7_000 });
  });

  it("falls back to defaults for invalid env overrides", async () => {
    vi.stubEnv(MAX_CHUNKS_ENV, "0");
    vi.stubEnv(MAX_SEGMENTS_ENV, "not-a-number");

    expect(await loadLimits()).toEqual({ chunks: 1_000, segments: 2_000 });
  });
});
