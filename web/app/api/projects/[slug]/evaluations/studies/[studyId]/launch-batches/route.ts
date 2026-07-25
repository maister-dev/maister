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
import { defaultLaunchRunSeam } from "@/lib/evaluations/launch-seam";
import { livePreflightLoaders } from "@/lib/evaluations/preflight-loaders";
import {
  createControlledRecipe,
  preflightStudyRecipe,
} from "@/lib/evaluations/recipes";
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

    // M1 (ADR-150): the launch path ENFORCES preflight. Every inline recipe is
    // preflit against the live contracts; any hard refusal (untrusted /
    // unlaunchable flow, unavailable runner, uncovered artifact, contract drift,
    // unknown overlay) blocks the launch BEFORE any recipe/batch write, so a
    // caller that skipped the advisory preview cannot launch an un-vetted
    // variant. Warnings never block. recipeId items reference recipes already
    // vetted at their own inline creation.
    const loaders = livePreflightLoaders();

    for (const [index, item] of parsed.data.items.entries()) {
      if (item.definition === undefined) continue;

      const verdict = await preflightStudyRecipe(
        { studyId, projectId: project.id, definition: item.definition },
        loaders,
      );

      if (!verdict.ok) {
        throw new MaisterError(
          "CONFIG",
          `inline recipe #${index + 1} failed preflight: ${verdict.refusals
            .map((r) => r.code)
            .join(", ")}`,
        );
      }
    }

    // D3: an item may carry a recipe definition to create inline in the study
    // first. M2 (ADR-150): the inline key is DETERMINISTIC per
    // (idempotencyKey, index) — an idempotent retry re-derives the same key and
    // `returnExistingOnKeyConflict` resolves it to the same recipeId, so the
    // batch's request digest matches (`deduped: true`) instead of leaking a
    // duplicate recipe + a 409 on digest mismatch. Absent an idempotency key
    // there is no retry contract, so a unique key is minted.
    const items: Array<{ recipeId: string; replicateCount?: number }> = [];

    for (const [index, item] of parsed.data.items.entries()) {
      if (item.recipeId) {
        items.push({
          recipeId: item.recipeId,
          ...(item.replicateCount
            ? { replicateCount: item.replicateCount }
            : {}),
        });

        continue;
      }

      const created = await createControlledRecipe({
        studyId,
        projectId: project.id,
        key: parsed.data.idempotencyKey
          ? `inline-${parsed.data.idempotencyKey}-${index}`
          : `inline-${Date.now()}-${index}`,
        label: `Variant ${index + 1}`,
        definition: item.definition,
        returnExistingOnKeyConflict: true,
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
        defaultLaunchRunSeam({
          actorUserId: session.id,
          authorize: async () => {},
        }),
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
