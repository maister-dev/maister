import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import {
  getCrossProjectActivityFeed,
  isActivityFeedKind,
  type ActivityFeedRow,
} from "@/lib/queries/activity-feed";
import { handleExt } from "@/lib/tokens/ext-handler";
import { personalOwner } from "@/lib/tokens/personal-actor";

const ENDPOINT = "GET /api/v1/ext/activity/feed";
const log = pino({
  name: "ext-activity-feed-route",
  level: process.env.LOG_LEVEL ?? "info",
});

function feedRowDTO(row: ActivityFeedRow) {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    occurredAt: row.occurredAt.toISOString(),
    projectId: row.projectId,
    projectSlug: row.projectSlug,
    projectName: row.projectName,
    actor: row.actor
      ? { type: row.actor.type, id: row.actor.id, label: row.actor.label }
      : null,
    taskId: row.taskId,
    taskKey: row.taskKey,
    taskNumber: row.taskNumber,
    taskTitle: row.taskTitle,
    runId: row.runId,
    gateId: row.gateId,
    hitlRequestId: row.hitlRequestId,
  };
}

// ADR-186: the owner's cross-project activity feed. A `project` filter naming a
// project the owner cannot see intersects to nothing (never refused, so its
// existence is not revealed).
export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    req,
    {
      scopeLabel: "activity:read",
      endpoint: ENDPOINT,
      method: "GET",
      allowGlobalActorWithoutProject: true,
      admitLibrarian: true,
      auditProjectId: null,
      db,
    },
    async (ctx) => {
      const owner = await personalOwner(ctx.actor);

      if (!owner.ok) return owner.response;

      const params = req.nextUrl.searchParams;
      const kind = params.get("kind");
      const limitParam = Number(params.get("limit"));
      const feed = await getCrossProjectActivityFeed(owner.user, {
        projectId: params.get("projectId"),
        kind: kind && isActivityFeedKind(kind) ? kind : null,
        limit:
          Number.isFinite(limitParam) && limitParam > 0
            ? limitParam
            : undefined,
      });

      log.debug(
        {
          route: ENDPOINT,
          visibleProjects: feed.projectCount,
          rows: feed.rows.length,
          truncated: feed.hasMore,
        },
        "served activity feed",
      );

      return NextResponse.json(
        { rows: feed.rows.map(feedRowDTO), hasMore: feed.hasMore },
        { status: 200 },
      );
    },
  );
}
