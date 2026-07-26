import "server-only";

import type { HitlItem } from "@/lib/queries/hitl";
import type { NeedsYouItem } from "@/lib/ext-activity/types";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/lib/db/schema";
import { getHitlInbox } from "@/lib/queries/hitl";

type Db = NodePgDatabase<typeof schema>;

function mapHitlItemToNeedsYouItem(item: HitlItem): NeedsYouItem {
  return {
    runId: item.runId,
    taskId: null,
    taskKey: item.taskRef,
    taskTitle: item.taskTitle,
    hitlRequestId: item.hitlRequestId,
    kind: item.kind,
    title: item.taskTitle ?? item.prompt,
    summary: item.prompt,
    requestedAt: new Date(item.createdAt),
    criticality: item.criticality,
  };
}

export async function listProjectNeedsYou(
  projectId: string,
  deps?: { db?: Db },
): Promise<NeedsYouItem[]> {
  const inbox = await getHitlInbox(projectId, deps);

  return inbox.items.map(mapHitlItemToNeedsYouItem);
}
