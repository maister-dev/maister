import type { ActivitySalience } from "@/lib/ext-activity/types";

const SALIENCE_RANK: Record<ActivitySalience, number> = {
  low: 1,
  normal: 2,
  high: 3,
};

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
