import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { reworkChildRun } from "@/lib/agents/launch";
import { reserveCompanyDelegatedAgentRun } from "@/lib/agents/company-agent-launch";
import { reserveCompanyDelegatedFlowRun } from "@/lib/agents/company-flow-launch";
import { captureNativeChildInput } from "@/lib/orchestrator/native-child-input";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { resolveActiveBoundRun } from "@/lib/runs/bound-run";
import { cooperationScope } from "@/lib/specialist-assignments/cooperation-scope";
import { prepareDelegatedWorkRework } from "@/lib/specialist-assignments/delegated-intake";
import { dispatchProjectAssignmentRework } from "@/lib/specialist-assignments/project-child-dispatch";
import { assignmentWorkReworkSchema } from "@/lib/specialist-assignments/work-types";
import { postgresTextSchema } from "@/lib/text-schema";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/rework";

const bodySchema = z
  .object({
    childRunId: z.string().guid({ error: "Invalid uuid" }),
    prompt: z.string().min(1).max(1_000_000),
    assignmentWork: assignmentWorkReworkSchema.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.assignmentWork === undefined ||
      (body.prompt.trim().length > 0 &&
        postgresTextSchema.min(1).max(8000).safeParse(body.prompt).success),
    {
      message: "Native work rework requires a bounded prompt",
      path: ["prompt"],
    },
  );

type ReworkBody = z.infer<typeof bodySchema>;

async function reworkNativeChild(
  db: Db,
  tokenId: string,
  body: ReworkBody,
): Promise<NextResponse> {
  if (body.assignmentWork === undefined)
    return NextResponse.json(
      {
        code: "CONFIG",
        message: "Native rework requires an exact work and result selector",
      },
      { status: 422 },
    );

  try {
    const request = await prepareDelegatedWorkRework(db, {
      childRunId: body.childRunId,
      prompt: body.prompt,
      tokenId,
      decision: body.assignmentWork,
    });
    const { kind } = request.prepared.target;
    const reserve =
      kind === "project_agent"
        ? dispatchProjectAssignmentRework
        : kind === "company_flow"
          ? reserveCompanyDelegatedFlowRun
          : reserveCompanyDelegatedAgentRun;
    const result = await reserve(db, request);

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    if (!isMaisterError(err)) throw err;
    const reason = err.details?.reason;

    return NextResponse.json(
      {
        code: err.code,
        message: err.message,
        ...(typeof reason === "string" ? { details: { reason } } : {}),
      },
      { status: httpStatusForExtCode(err.code) },
    );
  }
}

export async function POST(
  req: NextRequest,
  _routeCtx: object,
): Promise<NextResponse> {
  const db = getDb() as Db;

  // M37 (ADR-100): re-open a reviewed child for another turn. Reuses the
  // runs:delegate scope — a run-bound orchestrator addressing its own child.
  return handleExt(
    req,
    {
      scopeLabel: "runs:delegate",
      endpoint: ENDPOINT,
      method: "POST",
      allowCompanyActorWithoutProject: true,
      resolveScopeLabel: async ({ actor, db }) =>
        cooperationScope(db, actor, "runs:delegate"),
      db,
    },
    async (ctx) => {
      let body: ReworkBody;

      try {
        body = bodySchema.parse(await req.json());
      } catch (err) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `invalid body: ${(err as Error).message}`,
          },
          { status: 422 },
        );
      }

      const parentRunId = ctx.actor.boundRunId;

      if (!parentRunId) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: "rework requires a run-bound orchestrator token",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      if (
        body.assignmentWork !== undefined ||
        ctx.scopeLabel === "assignments:update"
      )
        return reworkNativeChild(db, ctx.actor.tokenId, body);

      // Finding 1 (Codex adversarial review): fail closed if the bound
      // orchestrator has terminalized — a stale run-bound token must not rework
      // children under a terminal tree.
      const boundRes = await resolveActiveBoundRun(
        db,
        parentRunId,
        ctx.projectId,
      );

      if (!boundRes.ok) {
        return NextResponse.json(
          { code: boundRes.code, message: boundRes.message },
          { status: httpStatusForExtCode(boundRes.code) },
        );
      }

      // Only a direct child of the bound orchestrator, in the token's project,
      // and currently in Review may be reworked.
      const rows = await db
        .select({ id: runs.id, status: runs.status, runKind: runs.runKind })
        .from(runs)
        .where(
          and(
            eq(runs.id, body.childRunId),
            eq(runs.parentRunId, parentRunId),
            eq(runs.projectId, ctx.projectId),
          ),
        );
      const child = rows[0];

      if (!child) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: "run is not a child of the bound orchestrator run",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      // ADR-163 D2: `run_rework` does NOT apply to a FLOW child. A flow child
      // owns its own `human`/`rework` loop, and grafting the coordinator's
      // prompt onto it would need a re-entry contract that overlaps ADR-160's
      // rework claim. Refused HERE, before dispatch, so the child is provably
      // untouched — `reworkChildRun`'s own `runKind !== "agent"` guard stays as
      // defence in depth, but a route that reached it would already have
      // committed to a kind-specific path. Branch on run_kind BEFORE calling a
      // kind-specific mechanism (skill-context rule 207).
      if (child.runKind !== "agent") {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message:
              "run_rework is not supported for flow children — promote or cancel it, or resolve it through its own review loop",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      if (child.status !== "Review") {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: `child run is not in Review (status=${child.status})`,
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      try {
        await captureNativeChildInput(
          db,
          { kind: "token", tokenId: ctx.actor.tokenId },
          { sourceRunId: parentRunId, childRunId: child.id },
        );
        const result = await reworkChildRun(body.childRunId, body.prompt, {
          db,
        });

        return NextResponse.json(
          { childRunId: result.childRunId, status: result.status },
          { status: 200 },
        );
      } catch (err) {
        if (isMaisterError(err)) {
          const reason = err.details?.reason;

          return NextResponse.json(
            {
              code: err.code,
              message: err.message,
              ...(typeof reason === "string" &&
              [
                "knowledge_reference_unavailable",
                "knowledge_capture_profile_required",
                "native_input_target_required",
              ].includes(reason)
                ? { details: { reason } }
                : {}),
            },
            { status: httpStatusForExtCode(err.code) },
          );
        }

        throw err;
      }
    },
  );
}
