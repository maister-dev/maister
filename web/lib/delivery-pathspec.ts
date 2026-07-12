export type DeliveryFileStat = {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
};

export type DeliveryDiffStat = {
  files: number;
  additions: number;
  deletions: number;
};

const LOCK_FILES = new Set([
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock",
]);

const EXCLUDED_DIRECTORY_SEGMENTS = new Set([
  ".next",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "vendor",
]);

export const DELIVERY_PATHSPEC = [
  ":(top)**",
  ":(exclude)**/node_modules/**",
  ":(exclude)**/vendor/**",
  ":(exclude)**/generated/**",
  ":(exclude)**/dist/**",
  ":(exclude)**/build/**",
  ":(exclude)**/.next/**",
  ":(exclude)**/coverage/**",
  ":(exclude)pnpm-lock.yaml",
  ":(exclude)package-lock.json",
  ":(exclude)yarn.lock",
  ":(exclude)bun.lockb",
  ":(exclude)Cargo.lock",
  ":(exclude)composer.lock",
  ":(exclude)Gemfile.lock",
  ":(exclude)poetry.lock",
] as const;

function normalizedSegments(filePath: string): string[] {
  return filePath.replaceAll("\\", "/").split("/").filter(Boolean);
}

export function isExcludedDeliveryPath(filePath: string): boolean {
  const segments = normalizedSegments(filePath);
  const basename = segments.at(-1)?.toLowerCase();

  return (
    basename !== undefined &&
    (LOCK_FILES.has(basename) ||
      segments.some((segment) =>
        EXCLUDED_DIRECTORY_SEGMENTS.has(segment.toLowerCase()),
      ))
  );
}

function assertValidStat(entry: DeliveryFileStat): void {
  if (
    !Number.isSafeInteger(entry.additions) ||
    !Number.isSafeInteger(entry.deletions) ||
    entry.additions < 0 ||
    entry.deletions < 0
  ) {
    throw new RangeError(
      "delivery file statistics must be non-negative integers",
    );
  }
}

export function cleanDeliveryStats(
  entries: readonly DeliveryFileStat[],
): DeliveryDiffStat {
  return entries.reduce<DeliveryDiffStat>(
    (total, entry) => {
      assertValidStat(entry);

      if (
        isExcludedDeliveryPath(entry.path) ||
        (entry.oldPath !== undefined && isExcludedDeliveryPath(entry.oldPath))
      ) {
        return total;
      }

      return {
        files: total.files + 1,
        additions: total.additions + (entry.binary ? 0 : entry.additions),
        deletions: total.deletions + (entry.binary ? 0 : entry.deletions),
      };
    },
    { files: 0, additions: 0, deletions: 0 },
  );
}
