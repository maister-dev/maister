import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import { getStudyForProject } from "@/lib/evaluations/studies";
import {
  getLaunchBatchForStudy,
  retryFailedBatchItems,
  runControlledLaunchBatch,
} from "@/lib/evaluations/launch-batch";
import { defaultLaunchRunSeam } from "@/lib/evaluations/launch-seam";
import { evalErrorResponse } from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-launch-batch-retry",
  level: process.env.LOG_LEVEL ?? "info",
});

// The per-item attempt budget. `retryFailedBatchItems` has no default (the route
// is its only production caller), so the route supplies it; `attempt` is bumped
// ONLY on a seam failure, so governance-terminalized items never consume it.
const CONTROLLED_LAUNCH_MAX_ATTEMPTS = 3;

type RouteParams = {
  params: Promise<{ slug: string; studyId: string; batchId: string }>;
};

// POST — re-queue a batch's failed items and re-drive (launchEvaluationRuns).
// Refuses softly (200, requeued: 0) on a kill switch / non-launchable study.
export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const session = await requireActiveSession();

    const { slug, studyId, batchId } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "launchEvaluationRuns");
    await getStudyForProject({ studyId, projectId: project.id });

    // Ownership guard: a cross-study batchId is a 404 before any retry write.
    await getLaunchBatchForStudy({ studyId, batchId });

    const result = await retryFailedBatchItems(
      batchId,
      CONTROLLED_LAUNCH_MAX_ATTEMPTS,
    );

    if (result.requeued > 0) {
      void runControlledLaunchBatch(
        batchId,
        defaultLaunchRunSeam({
          actorUserId: session.id,
          authorize: async () => {},
        }),
      ).catch((err: unknown) =>
        log.error(
          { batchId, err: (err as Error).message },
          "controlled launch batch retry drive failed",
        ),
      );
    }

    log.info(
      { studyId, batchId, requeued: result.requeued },
      "launch batch retry",
    );

    return NextResponse.json(result);
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
