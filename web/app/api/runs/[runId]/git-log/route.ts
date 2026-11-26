import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  errorResponse,
  type RouteParams,
} from "../workbench-lifecycle/route-utils";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { assertRunKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
import { getDb } from "@/lib/db/client";
import { runs, workspaces } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { readAddressedWorkspaceHistory } from "@/lib/execution-host/workspace-review";

const pageQuery = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9][0-9]?|100)$/)
      .transform(Number)
      .optional(),
  })
  .strict();

/** Read history for a retained addressed workspace under the Run's current content grant. */
export async function GET(
  request: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;
  try {
    const user = await requireActiveSession();
    const db = getDb();
    const [row] = await db
      .select({ workspace: workspaces, runKind: runs.runKind })
      .from(runs)
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.runId, runs.id),
          eq(workspaces.projectId, runs.projectId),
        ),
      )
      .where(
        and(
          eq(runs.id, runId),
          eq(workspaces.ownershipKind, "host_owned"),
          isNull(workspaces.removedAt),
        ),
      );
    if (!row || !row.workspace.projectId)
      throw new MaisterError("PRECONDITION", "Run history is unavailable", {
        details: { reason: "run_not_found" },
      });

    const { workspace, runKind } = row;
    const projectId = row.workspace.projectId;
    const authorize = async (): Promise<void> => {
      await requireProjectAction(
        projectId,
        runKind === "scratch" ? "readScratchRun" : "readBoard",
      );
      await requireProjectAction(projectId, "readRepoFiles");
      await assertRunKnowledgeDisclosure(
        db,
        { kind: "user", userId: user.id },
        runId,
      );
    };
    await authorize();
    const search = new URL(request.url).searchParams;
    const page = pageQuery.safeParse(Object.fromEntries(search));
    if (
      !page.success ||
      [...search.keys()].some((key) => search.getAll(key).length !== 1)
    )
      throw new MaisterError("CONFIG", "Git log page parameters are invalid", {
        details: { reason: "invalid_request" },
      });

    const log = await readAddressedWorkspaceHistory({
      db,
      workspace,
      page: page.data,
      signal: request.signal,
    });
    await authorize();

    return NextResponse.json(log, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error, {
      runId,
      route: "GET /api/runs/[runId]/git-log",
    });
  }
}
