import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { getWorkTable, type WorkTableRow } from "@/lib/queries/work-table";
import { handleExt } from "@/lib/tokens/ext-handler";
import { personalOwner } from "@/lib/tokens/personal-actor";

const ENDPOINT = "GET /api/v1/ext/work";
const log = pino({
  name: "ext-work-route",
  level: process.env.LOG_LEVEL ?? "info",
});

// Explicit wire projection of one `/work` row — never a spread.
function workRowDTO(row: WorkTableRow) {
  return {
    taskId: row.taskId,
    key: row.keyRef,
    number: row.number,
    title: row.title,
    projectId: row.projectId,
    projectSlug: row.projectSlug,
    projectName: row.projectName,
    stage: row.stage,
    blocked: row.blocked,
    promotedKind: row.promotedKind,
    progress: row.progress,
    runId: row.runId,
    runStatus: row.runStatus,
    readiness: row.readiness,
    waitingOn: row.waitingOn
      ? {
          kind: row.waitingOn.kind,
          name: row.waitingOn.name,
          since: row.waitingOn.since.toISOString(),
        }
      : null,
    blockers: row.blockers.map((blocker) => ({
      taskId: blocker.taskId,
      key: blocker.keyRef,
    })),
    lastActivityAt: row.lastActivityAt.toISOString(),
  };
}

// ADR-186: the owner's cross-project work table (`/work`), computed over the
// owner's visible projects only.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    req,
    {
      scopeLabel: "work:read",
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

      const table = await getWorkTable(owner.user);

      log.debug(
        {
          route: ENDPOINT,
          visibleProjects: table.projectCount,
          rows: table.rows.length,
        },
        "served work table",
      );

      return NextResponse.json(
        { rows: table.rows.map(workRowDTO), projectCount: table.projectCount },
        { status: 200 },
      );
    },
  );
}
