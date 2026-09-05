import type { ActivitySalience } from "@/lib/ext-activity/types";

import { MaisterError } from "@/lib/errors";

const SALIENCE_RANK: Record<ActivitySalience, number> = {
  low: 1,
  normal: 2,
  high: 3,
};

const DEFAULT_ACTIVITY_SALIENCE: ActivitySalience = "low";

export function parseActivitySalience(raw?: string | null): ActivitySalience {
  if (raw == null || raw.length === 0) return DEFAULT_ACTIVITY_SALIENCE;
  if (raw === "high" || raw === "normal" || raw === "low") return raw;

  throw new MaisterError("CONFIG", "invalid activity salience");
}

export function salienceRank(salience: ActivitySalience): number {
  return SALIENCE_RANK[salience];
}

export function meetsSalience(
  itemSalience: ActivitySalience,
  minSalience: ActivitySalience,
): boolean {
  return salienceRank(itemSalience) >= salienceRank(minSalience);
}

export function filterBySalience<T extends { salience: ActivitySalience }>(
  items: readonly T[],
  minSalience: ActivitySalience,
): T[] {
  return items.filter((item) => meetsSalience(item.salience, minSalience));
}
