import "server-only";

import type { DiffPrepResult } from "@/lib/diff/prepare";

import pino from "pino";

const log = pino({
  name: "diff-cache",
  level: process.env.LOG_LEVEL ?? "info",
});

// `DIFF_CACHE_MAX_BYTES` (32 MiB), `MAX_SINGLE_ENTRY_BYTES` (16 MiB), and
// `DIFF_CACHE_MAX_ENTRIES` (256) bound both UTF-8 JSON bytes and Map entry
// count (preventing unbounded growth from empty `"[]"` entries).
export const DIFF_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const DIFF_CACHE_MAX_ENTRIES = 256;

const MAX_SINGLE_ENTRY_BYTES = DIFF_CACHE_MAX_BYTES / 2;

export type DiffNameStatusEntry = {
  path: string;
  status: string;
  oldPath?: string;
};

export type CachedDiffFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

export type PreparedDiffCacheEntry = {
  files: CachedDiffFile[];
  prepared: DiffPrepResult;
  preparedJson: string;
  byteSize: number;
};

export function enrichCachedDiffFiles(
  nameStatus: readonly DiffNameStatusEntry[],
  prepared: DiffPrepResult,
): CachedDiffFile[] {
  const countsByPath = new Map(prepared.files.map((f) => [f.path, f]));

  return nameStatus.map((entry) => {
    const counts = countsByPath.get(entry.path);

    return {
      path: entry.path,
      status: entry.status,
      additions: counts?.additions ?? 0,
      deletions: counts?.deletions ?? 0,
    };
  });
}

export function buildPreparedDiffCacheEntry(input: {
  nameStatus: readonly DiffNameStatusEntry[];
  prepared: DiffPrepResult;
}): PreparedDiffCacheEntry {
  const files = enrichCachedDiffFiles(input.nameStatus, input.prepared);
  const preparedJson = JSON.stringify(input.prepared.perFile);

  return {
    files,
    prepared: input.prepared,
    preparedJson,
    byteSize: Buffer.byteLength(preparedJson, "utf8"),
  };
}

export type PreparedDiffCacheStats = {
  entries: number;
  maxEntries: number;
  totalBytes: number;
  maxBytes: number;
};

const cache = new Map<string, PreparedDiffCacheEntry>();
let totalBytes = 0;

function keyKindOf(key: string): string {
  const sep = key.indexOf(":");

  return sep > 0 ? key.slice(0, sep) : "other";
}

export function getCachedPreparedDiff(
  key: string,
): Readonly<PreparedDiffCacheEntry> | undefined {
  const entry = cache.get(key);

  if (!entry) {
    log.debug(
      {
        keyKind: keyKindOf(key),
        byteSize: 0,
        totalBytes,
        entries: cache.size,
      },
      "diff cache miss",
    );

    return undefined;
  }

  // Re-insert to promote recency in Map iteration order (head = LRU, tail = MRU).
  cache.delete(key);
  cache.set(key, entry);

  log.debug(
    {
      keyKind: keyKindOf(key),
      byteSize: entry.byteSize,
      totalBytes,
      entries: cache.size,
    },
    "diff cache hit",
  );

  return entry;
}

export function setCachedPreparedDiff(
  key: string,
  entry: PreparedDiffCacheEntry,
  options?: { maxEntries?: number },
): void {
  if (!Number.isFinite(entry.byteSize) || entry.byteSize < 0) return;

  const maxEntries = options?.maxEntries ?? DIFF_CACHE_MAX_ENTRIES;

  if (!Number.isInteger(maxEntries) || maxEntries < 1) return;

  const existing = cache.get(key);

  if (existing) {
    totalBytes -= existing.byteSize;
    cache.delete(key);
  }

  if (entry.byteSize > MAX_SINGLE_ENTRY_BYTES) {
    log.debug(
      {
        keyKind: keyKindOf(key),
        byteSize: entry.byteSize,
        totalBytes,
        entries: cache.size,
      },
      "diff cache oversize-skip",
    );

    return;
  }

  while (
    cache.size > 0 &&
    (totalBytes + entry.byteSize > DIFF_CACHE_MAX_BYTES ||
      cache.size >= maxEntries)
  ) {
    const oldestKey = cache.keys().next().value;

    if (oldestKey === undefined) break;

    const oldest = cache.get(oldestKey);

    cache.delete(oldestKey);
    if (oldest) {
      totalBytes -= oldest.byteSize;
      log.debug(
        {
          keyKind: keyKindOf(oldestKey),
          byteSize: oldest.byteSize,
          totalBytes,
          entries: cache.size,
        },
        "diff cache evict",
      );
    }
  }

  cache.set(key, entry);
  totalBytes += entry.byteSize;
}

export function clearPreparedDiffCache(): void {
  cache.clear();
  totalBytes = 0;
}

export function getPreparedDiffCacheStats(): PreparedDiffCacheStats {
  return {
    entries: cache.size,
    maxEntries: DIFF_CACHE_MAX_ENTRIES,
    totalBytes,
    maxBytes: DIFF_CACHE_MAX_BYTES,
  };
}
