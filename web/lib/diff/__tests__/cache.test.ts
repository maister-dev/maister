import { beforeEach, describe, expect, it } from "vitest";

import {
  buildPreparedDiffCacheEntry,
  clearPreparedDiffCache,
  DIFF_CACHE_MAX_BYTES,
  DIFF_CACHE_MAX_ENTRIES,
  enrichCachedDiffFiles,
  getCachedPreparedDiff,
  getPreparedDiffCacheStats,
  setCachedPreparedDiff,
  type PreparedDiffCacheEntry,
} from "@/lib/diff/cache";
import { prepareDiff } from "@/lib/diff/prepare";

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
      maxEntries: DIFF_CACHE_MAX_ENTRIES,
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
      maxEntries: DIFF_CACHE_MAX_ENTRIES,
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
      maxEntries: DIFF_CACHE_MAX_ENTRIES,
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
      maxEntries: DIFF_CACHE_MAX_ENTRIES,
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
      maxEntries: DIFF_CACHE_MAX_ENTRIES,
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
      maxEntries: DIFF_CACHE_MAX_ENTRIES,
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
      maxEntries: DIFF_CACHE_MAX_ENTRIES,
      totalBytes: 30 * MIB,
      maxBytes: DIFF_CACHE_MAX_BYTES,
    });
  });

  it("caps total entries at DIFF_CACHE_MAX_ENTRIES for empty ('[]') entries and evicts LRU", () => {
    expect(DIFF_CACHE_MAX_ENTRIES).toBe(256);

    const makeEmptyEntry = (): PreparedDiffCacheEntry => ({
      files: [],
      prepared: { files: [], perFile: [], truncated: false },
      preparedJson: "[]",
      byteSize: 2,
    });

    for (let i = 0; i < DIFF_CACHE_MAX_ENTRIES; i += 1) {
      setCachedPreparedDiff(`sha:/repo:base:${i}`, makeEmptyEntry());
    }

    // Promote key 0 so key 1 becomes the LRU victim.
    expect(getCachedPreparedDiff("sha:/repo:base:0")).toBeDefined();

    // Updating an existing key at capacity does not evict any sibling.
    setCachedPreparedDiff("sha:/repo:base:2", makeEmptyEntry());
    expect(getPreparedDiffCacheStats().entries).toBe(DIFF_CACHE_MAX_ENTRIES);
    expect(getCachedPreparedDiff("sha:/repo:base:1")).toBeDefined();

    // Now key 3 is the oldest unpromoted entry (0, 2, 1 were touched in order).
    // Inserting 4 more keys evicts keys 3, 4, 5, 6 and preserves the 256 cap.
    for (let i = 0; i < 4; i += 1) {
      setCachedPreparedDiff(`sha:/repo:extra:${i}`, makeEmptyEntry());
    }

    expect(getPreparedDiffCacheStats()).toEqual({
      entries: DIFF_CACHE_MAX_ENTRIES,
      maxEntries: DIFF_CACHE_MAX_ENTRIES,
      totalBytes: DIFF_CACHE_MAX_ENTRIES * 2,
      maxBytes: DIFF_CACHE_MAX_BYTES,
    });
    expect(getCachedPreparedDiff("sha:/repo:base:0")).toBeDefined();
    expect(getCachedPreparedDiff("sha:/repo:base:1")).toBeDefined();
    expect(getCachedPreparedDiff("sha:/repo:base:3")).toBeUndefined();
    expect(getCachedPreparedDiff("sha:/repo:base:6")).toBeUndefined();
    expect(getCachedPreparedDiff("sha:/repo:extra:3")).toBeDefined();
  });

  it("enriches name-status entries and builds cross-producer compatible cache entries", async () => {
    const rawDiff = [
      "diff --git a/src/greet.ts b/src/greet.ts",
      "index 1111111..2222222 100644",
      "--- a/src/greet.ts",
      "+++ b/src/greet.ts",
      "@@ -1,2 +1,3 @@",
      "-export const msg = 'hi';",
      "+export const msg = 'привет';",
      "+export const extra = 1;",
      " export const keep = true;",
      "diff --git a/src/added.ts b/src/added.ts",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/src/added.ts",
      "@@ -0,0 +1,1 @@",
      "+export const added = true;",
    ].join("\n");
    const nameStatus = [
      { path: "src/greet.ts", status: "M" },
      { path: "src/added.ts", status: "A" },
      { path: "assets/logo.png", status: "A" },
    ];
    const prepared = await prepareDiff(rawDiff, false);

    expect(enrichCachedDiffFiles(nameStatus, prepared)).toEqual([
      { path: "src/greet.ts", status: "M", additions: 2, deletions: 1 },
      { path: "src/added.ts", status: "A", additions: 1, deletions: 0 },
      { path: "assets/logo.png", status: "A", additions: 0, deletions: 0 },
    ]);

    const entry = buildPreparedDiffCacheEntry({ nameStatus, prepared });

    expect(entry.files).toEqual([
      { path: "src/greet.ts", status: "M", additions: 2, deletions: 1 },
      { path: "src/added.ts", status: "A", additions: 1, deletions: 0 },
      { path: "assets/logo.png", status: "A", additions: 0, deletions: 0 },
    ]);
    expect(entry.prepared).toBe(prepared);
    expect(entry.preparedJson).toBe(JSON.stringify(prepared.perFile));
    expect(entry.byteSize).toBe(Buffer.byteLength(entry.preparedJson, "utf8"));
    expect(entry.byteSize).toBeGreaterThan(entry.preparedJson.length);

    setCachedPreparedDiff("sha:/repo:base:head", entry);

    const hit = getCachedPreparedDiff("sha:/repo:base:head");

    expect(hit).toBe(entry);
    expect(JSON.parse(hit!.preparedJson)).toEqual(prepared.perFile);
  });
});
