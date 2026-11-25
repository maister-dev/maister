import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPreparedDiffCache,
  DIFF_CACHE_MAX_BYTES,
  getCachedPreparedDiff,
  getPreparedDiffCacheStats,
  setCachedPreparedDiff,
  type PreparedDiffCacheEntry,
} from "@/lib/diff/cache";

const MIB = 1024 * 1024;

function makeEntry(path: string, byteSize: number): PreparedDiffCacheEntry {
  return {
    files: [{ path, status: "M" }],
    prepared: {
      files: [{ path, status: "M", additions: 1, deletions: 0 }],
      perFile: [],
      truncated: false,
    },
    preparedJson: `[{"path":"${path}"}]`,
    byteSize,
  };
}

describe("prepared diff byte-bounded LRU cache", () => {
  beforeEach(() => {
    clearPreparedDiffCache();
  });

  it("promotes recency on hit and returns the identical cached entry", () => {
    const entryA = makeEntry("src/a.ts", 12 * MIB);
    const entryB = makeEntry("src/b.ts", 12 * MIB);
    const entryC = makeEntry("src/c.ts", 12 * MIB);

    setCachedPreparedDiff("sha:/repo:base:a", entryA);
    setCachedPreparedDiff("sha:/repo:base:b", entryB);

    const hitA = getCachedPreparedDiff("sha:/repo:base:a");

    expect(hitA).toBe(entryA);
    expect(hitA).toEqual({
      files: entryA.files,
      prepared: entryA.prepared,
      preparedJson: entryA.preparedJson,
      byteSize: entryA.byteSize,
    });

    // Adding C (12 MiB) pushes total to 36 MiB > 32 MiB; B is now LRU so B
    // must be evicted while the promoted A and new C stay cached.
    setCachedPreparedDiff("sha:/repo:base:c", entryC);

    expect(getCachedPreparedDiff("sha:/repo:base:b")).toBeUndefined();
    expect(getCachedPreparedDiff("sha:/repo:base:a")).toBe(entryA);
    expect(getCachedPreparedDiff("sha:/repo:base:c")).toBe(entryC);
    expect(getPreparedDiffCacheStats()).toEqual({
      entries: 2,
      totalBytes: 24 * MIB,
      maxBytes: DIFF_CACHE_MAX_BYTES,
    });
  });

  it("evicts least-recently-used entries strictly when totalBytes + byteSize exceeds 32 MiB", () => {
    expect(DIFF_CACHE_MAX_BYTES).toBe(32 * MIB);

    const first = makeEntry("src/first.ts", 16 * MIB);
    const second = makeEntry("src/second.ts", 16 * MIB);
    const tiny = makeEntry("src/tiny.ts", 1);

    setCachedPreparedDiff("review:first", first);
    setCachedPreparedDiff("review:second", second);

    // Exactly 32 MiB fits with zero eviction.
    expect(getPreparedDiffCacheStats()).toEqual({
      entries: 2,
      totalBytes: 32 * MIB,
      maxBytes: DIFF_CACHE_MAX_BYTES,
    });

    // Exceeding by 1 byte strictly evicts the oldest entry (`first`).
    setCachedPreparedDiff("review:tiny", tiny);

    expect(getCachedPreparedDiff("review:first")).toBeUndefined();
    expect(getCachedPreparedDiff("review:second")).toBe(second);
    expect(getCachedPreparedDiff("review:tiny")).toBe(tiny);
    expect(getPreparedDiffCacheStats()).toEqual({
      entries: 2,
      totalBytes: 16 * MIB + 1,
      maxBytes: DIFF_CACHE_MAX_BYTES,
    });
  });

  it("bypasses caching a single entry over 16 MiB without evicting healthy entries", () => {
    const healthyOne = makeEntry("src/one.ts", 10 * MIB);
    const healthyTwo = makeEntry("src/two.ts", 10 * MIB);
    const oversize = makeEntry("src/huge.ts", DIFF_CACHE_MAX_BYTES / 2 + 1);

    setCachedPreparedDiff("content:one:false", healthyOne);
    setCachedPreparedDiff("content:two:false", healthyTwo);
    setCachedPreparedDiff("content:huge:false", oversize);

    expect(getCachedPreparedDiff("content:huge:false")).toBeUndefined();
    expect(getCachedPreparedDiff("content:one:false")).toBe(healthyOne);
    expect(getCachedPreparedDiff("content:two:false")).toBe(healthyTwo);
    expect(getPreparedDiffCacheStats()).toEqual({
      entries: 2,
      totalBytes: 20 * MIB,
      maxBytes: DIFF_CACHE_MAX_BYTES,
    });
  });
});
