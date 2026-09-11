/**
 * The activity-row label set, built once for both surfaces that render activity
 * rows: `/activity` and the Desk (ADR-171 D1).
 *
 * Pure, for the same reason as `buildWorkRowsLabels`. The kind catalog is keyed
 * by the RAW kind for the client, while the message catalog keys the
 * underscored form — next-intl reads a dot as a namespace separator.
 */

import type { ActivityFeedKind } from "@/lib/queries/activity-feed";
import type { ActivityRowLabels } from "@/components/activity/activity-row-list";

import { activityKindKey } from "@/lib/activity/activity-view";

type Translate = (key: string) => string;

export function buildActivityRowLabels(
  t: Translate,
  kinds: readonly ActivityFeedKind[],
): ActivityRowLabels {
  return {
    kinds: Object.fromEntries(
      kinds.map((kind) => [kind, t(`kinds.${activityKindKey(kind)}`)]),
    ),
    divider: t("divider"),
    openTask: t("openTask"),
    openRun: t("openRun"),
    openProject: t("openProject"),
    webhookAttempts: t("webhookAttempts"),
  };
}
