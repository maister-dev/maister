import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import { getStudyForProject } from "@/lib/evaluations/studies";
import {
  createControlledLaunchBatch,
  runControlledLaunchBatch,
} from "@/lib/evaluations/launch-batch";
import { createControlledRecipe } from "@/lib/evaluations/recipes";
import { defaultLaunchRunSeam } from "@/lib/evaluations/launch-seam";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseEvalJson,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-launch-batches",
  level: process.env.LOG_LEVEL ?? "info",
});

const itemSchema = z
  .object({
    recipeId: z.string().min(1).optional(),
    definition: z.unknown().optional(),
    replicateCount: z.number().int().min(1).max(32).optional(),
  })
  .strict()
  .refine((i) => (i.recipeId ? !i.definition : !!i.definition), {
    message: "each item carries exactly one of recipeId or definition",
  });

const bodySchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200).optional(),
    items: z.array(itemSchema).min(1).max(32),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string; studyId: string }> };

// POST — create a controlled-launch batch and kick its drive (launchEvaluationRuns).
// Two-phase by contract: the durable batch intent commits BEFORE any launch side
// effect; the drive runs post-commit with the default seam. Returns 201 with the
// batchId even when the drive then halts (kill switch) — items stay queued.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const session = await requireActiveSession();

    const { slug, studyId } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "launchEvaluationRuns");
    await getStudyForProject({ studyId, projectId: project.id });

    const parsed = bodySchema.safeParse(await parseEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    // D3: an item may carry a recipe definition to create inline in the study
    // first. Each inline recipe gets a unique key; a bad definition refuses the
    // whole request (CONFIG) before any batch write.
    const items: Array<{ recipeId: string; replicateCount?: number }> = [];

    for (const [index, item] of parsed.data.items.entries()) {
      if (item.recipeId) {
        items.push({
          recipeId: item.recipeId,
          ...(item.replicateCount ? { replicateCount: item.replicateCount } : {}),
        });

        continue;
      }

      const created = await createControlledRecipe({
        studyId,
        projectId: project.id,
        key: `inline-${Date.now()}-${index}`,
        label: `Variant ${index + 1}`,
        definition: item.definition,
      });

      items.push({
        recipeId: created.id as string,
        ...(item.replicateCount ? { replicateCount: item.replicateCount } : {}),
      });
    }

    const result = await createControlledLaunchBatch({
      studyId,
      projectId: project.id,
      requestedByUserId: session.id,
      idempotencyKey: parsed.data.idempotencyKey ?? null,
      items,
    });

    // Kick the drive AFTER the intent has committed (two-phase). A drive failure
    // never fails the create response — items stay durable and re-drivable.
    if (!result.deduped) {
      void runControlledLaunchBatch(
        result.batchId,
        defaultLaunchRunSeam({ actorUserId: session.id, authorize: async () => {} }),
      ).catch((err: unknown) =>
        log.error(
          { batchId: result.batchId, err: (err as Error).message },
          "controlled launch batch drive failed (items remain re-drivable)",
        ),
      );
    }

    log.info(
      { studyId, batchId: result.batchId, deduped: result.deduped },
      "controlled launch batch created",
    );

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
