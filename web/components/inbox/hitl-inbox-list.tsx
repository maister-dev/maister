import type { HitlItem } from "@/lib/queries/hitl";
import type { CrossProjectHitlItem } from "@/lib/queries/portfolio";
import type { ReactElement } from "react";

import { FolderIcon } from "@heroicons/react/24/outline";
import { getTranslations } from "next-intl/server";

import { HitlCard } from "@/components/inbox/hitl-card";

interface GridProps {
  items: HitlItem[];
  canAct: boolean;
  currentUserId: string;
}

// Responsive grid of unified HITL cards — two columns on wide screens, one
// otherwise. Used directly by the per-project board (single project, no group
// header) and per group by the cross-project list below.
export function HitlInboxGrid({
  items,
  canAct,
  currentUserId,
}: GridProps): ReactElement {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {items.map((item) => (
        <HitlCard
          key={item.hitlRequestId}
          canAct={canAct}
          currentUserId={currentUserId}
          item={item}
        />
      ))}
    </div>
  );
}

interface ListProps {
  items: CrossProjectHitlItem[];
  canAct: boolean;
  currentUserId: string;
}

// Cross-project inbox: HITL cards grouped by project (a `project · N waiting`
// header per group), preserving the criticality-then-age order within a project.
export async function HitlInboxList({
  items,
  canAct,
  currentUserId,
}: ListProps): Promise<ReactElement> {
  const t = await getTranslations("inbox");

  const groups: { id: string; name: string; items: CrossProjectHitlItem[] }[] =
    [];
  const byId = new Map<string, (typeof groups)[number]>();

  for (const item of items) {
    let group = byId.get(item.projectId);

    if (!group) {
      group = { id: item.projectId, name: item.projectName, items: [] };
      byId.set(item.projectId, group);
      groups.push(group);
    }

    group.items.push(item);
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.id} aria-label={group.name}>
          <div className="mb-2.5 flex items-center gap-2 px-0.5">
            <FolderIcon className="h-4 w-4 flex-none text-mute" />
            <span className="text-[13.5px] font-semibold text-ink">
              {group.name}
            </span>
            <span className="font-mono text-[11px] text-mute">
              · {t("waiting", { count: group.items.length })}
            </span>
          </div>
          <HitlInboxGrid
            canAct={canAct}
            currentUserId={currentUserId}
            items={group.items}
          />
        </section>
      ))}
    </div>
  );
}
