import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { submitBoundJudgeResult } from "@/lib/evaluations/judges/seal";
import { evaluatorErrorResponse } from "@/lib/evaluations/judges/route-error";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT = "POST /api/v1/ext/evaluations/result";

// The strict submission envelope. Per-criterion strictness (unknown/out-of-range/
// missing-required) is enforced by validateJudgeResult against the method — this
// schema only guards the wire shape. `.strict()` rejects extra keys so a client
// can never smuggle server-derived attribution (attemptId/agentRunId/etc.).
const submissionSchema = z
  .object({
    criteria: z
      .array(
        z
          .object({
            criterionId: z.string().min(1),
            state: z
              .enum(["scored", "insufficient_evidence", "not_applicable"])
              .optional(),
            score: z.number().nullable().optional(),
            rationale: z.string().nullable().optional(),
            confidence: z.number().nullable().optional(),
            evidenceRefs: z.array(z.string()).optional(),
            objectiveRefs: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

function bodyError(message: string): NextResponse {
  return NextResponse.json({ code: "CONFIG", message }, { status: 422 });
}

// Submit a strict judge result for the token-bound attempt (ADR-142 D12).
// Attribution is entirely server-derived; the body carries only the per-criterion
// scores. Requires evaluations:result:submit.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    req,
    {
      scopeLabel: "evaluations:result:submit",
      endpoint: ENDPOINT,
      method: "POST",
      db,
    },
    async (ctx) => {
      let body: unknown;

      try {
        body = await req.json();
      } catch (err) {
        if (err instanceof SyntaxError)
          return bodyError(`invalid body: ${err.message}`);

        throw err;
      }

      const parsed = submissionSchema.safeParse(body);

      if (!parsed.success) {
        return bodyError(`invalid body: ${parsed.error.message}`);
      }

      try {
        const outcome = await submitBoundJudgeResult(
          ctx.actor,
          {
            criteria: parsed.data.criteria.map((c) => ({
              criterionId: c.criterionId,
              state: c.state,
              score: c.score,
              rationale: c.rationale,
              confidence: c.confidence,
              evidenceRefs: c.evidenceRefs,
              objectiveRefs: c.objectiveRefs,
            })),
          },
          db,
        );

        return NextResponse.json(outcome);
      } catch (err) {
        const resp = evaluatorErrorResponse(err);

        if (resp) return resp;

        throw err;
      }
    },
  );
}
