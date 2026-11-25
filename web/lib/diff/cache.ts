import "server-only";

import type { DiffPrepResult } from "@/lib/diff/prepare";
import type { DiffFileEntry } from "@/lib/worktree";

import pino from "pino";

const log = pino({
  name: "diff-cache",
  level: process.env.LOG_LEVEL ?? "info",
});

export const DIFF_CACHE_MAX_BYTES = 32 * 1024 * 1024;

const MAX_SINGLE_ENTRY_BYTES = DIFF_CACHE_MAX_BYTES / 2;

export type PreparedDiffCacheEntry = {
  files: DiffFileEntry[];
  prepared: DiffPrepResult;
  preparedJson: string;
  byteSize: number;
};

export type PreparedDiffCacheStats = {
  entries: number;
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
): PreparedDiffCacheEntry | undefined {
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
): void {
  if (!Number.isFinite(entry.byteSize) || entry.byteSize < 0) return;

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

  const existing = cache.get(key);

  if (existing) {
    totalBytes -= existing.byteSize;
    cache.delete(key);
  }

  while (totalBytes + entry.byteSize > DIFF_CACHE_MAX_BYTES && cache.size > 0) {
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
    totalBytes,
    maxBytes: DIFF_CACHE_MAX_BYTES,
  };
}
