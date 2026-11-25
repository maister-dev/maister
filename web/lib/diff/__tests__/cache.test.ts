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
    files: [{ path, status: "M", additions: 1, deletions: 0 }],
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

  it("evicts an existing entry when overwritten with an oversize entry for the same key", () => {
    const small = makeEntry("src/a.ts", 4 * MIB);
    const healthy = makeEntry("src/b.ts", 6 * MIB);
    const oversize = makeEntry("src/a.ts", DIFF_CACHE_MAX_BYTES / 2 + 1);

    setCachedPreparedDiff("sha:/repo:base:a", small);
    setCachedPreparedDiff("sha:/repo:base:b", healthy);
    setCachedPreparedDiff("sha:/repo:base:a", oversize);

    expect(getCachedPreparedDiff("sha:/repo:base:a")).toBeUndefined();
    expect(getCachedPreparedDiff("sha:/repo:base:b")).toBe(healthy);
    expect(getPreparedDiffCacheStats()).toEqual({
      entries: 1,
      totalBytes: 6 * MIB,
      maxBytes: DIFF_CACHE_MAX_BYTES,
    });
  });

  it("rejects invalid or negative byteSize values without corrupting cache state", () => {
    const healthy = makeEntry("src/ok.ts", 2 * MIB);

    setCachedPreparedDiff("sha:/repo:base:ok", healthy);

    for (const badSize of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      setCachedPreparedDiff(
        "sha:/repo:base:bad",
        makeEntry("src/bad.ts", badSize),
      );
      expect(getCachedPreparedDiff("sha:/repo:base:bad")).toBeUndefined();
    }

    expect(getCachedPreparedDiff("sha:/repo:base:ok")).toBe(healthy);
    expect(getPreparedDiffCacheStats()).toEqual({
      entries: 1,
      totalBytes: 2 * MIB,
      maxBytes: DIFF_CACHE_MAX_BYTES,
    });
  });

  it("evicts multiple LRU entries to make room for a larger entry", () => {
    const e1 = makeEntry("src/1.ts", 8 * MIB);
    const e2 = makeEntry("src/2.ts", 8 * MIB);
    const e3 = makeEntry("src/3.ts", 8 * MIB);
    const e4 = makeEntry("src/4.ts", 8 * MIB);
    const big = makeEntry("src/big.ts", 14 * MIB);

    setCachedPreparedDiff("sha:1", e1);
    setCachedPreparedDiff("sha:2", e2);
    setCachedPreparedDiff("sha:3", e3);
    setCachedPreparedDiff("sha:4", e4);
    setCachedPreparedDiff("sha:big", big);

    expect(getCachedPreparedDiff("sha:1")).toBeUndefined();
    expect(getCachedPreparedDiff("sha:2")).toBeUndefined();
    expect(getCachedPreparedDiff("sha:3")).toBe(e3);
    expect(getCachedPreparedDiff("sha:4")).toBe(e4);
    expect(getCachedPreparedDiff("sha:big")).toBe(big);
    expect(getPreparedDiffCacheStats()).toEqual({
      entries: 3,
      totalBytes: 30 * MIB,
      maxBytes: DIFF_CACHE_MAX_BYTES,
    });
  });
});
