import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { sendAgentMessage, sendDelegatedAgentSteer } from "@/lib/agents/launch";
import { captureNativeChildInput } from "@/lib/orchestrator/native-child-input";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { resolveActiveBoundRun } from "@/lib/runs/bound-run";
import { cooperationScope } from "@/lib/specialist-assignments/cooperation-scope";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/message";

const bodySchema = z
  .object({
    addressableKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
    childRunId: z.string().guid({ error: "Invalid uuid" }).optional(),
    prompt: z.string().min(1).max(1_000_000),
    requestKey: z.string().min(1).max(128).optional(),
    // ADR-182: `steer` reaches the child's running turn when it can.
    mode: z.enum(["steer", "queue"]).optional(),
  })
  .strict()
  .refine(
    (b) => (b.addressableKey !== undefined) !== (b.childRunId !== undefined),
    {
      message: "exactly one of addressableKey or childRunId is required",
      path: ["addressableKey"],
    },
  );

type MessageBody = z.infer<typeof bodySchema>;

async function messageDelegatedChild(
  db: Db,
  body: MessageBody,
  sourceRunId: string,
  tokenId: string,
): Promise<NextResponse> {
  if (!body.childRunId || body.mode !== "steer" || !body.requestKey)
    return NextResponse.json(
      {
        code: "CONFIG",
        message:
          "A delegated clarification requires childRunId, mode steer and requestKey",
      },
      { status: 422 },
    );

  try {
    const result = await sendDelegatedAgentSteer(
      db,
      body.childRunId,
      body.prompt,
      { sourceRunId, tokenId },
      body.requestKey,
    );

    return NextResponse.json(result);
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

  // M37 Phase 8 (ADR-099): re-message reuses the runs:delegate scope — a
  // run-bound orchestrator token addressing its own swarm member.
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
      let body: MessageBody;

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

      // The orchestrator runId is the token's run binding — never a body field.
      const callerRunId = ctx.actor.boundRunId;

      if (!callerRunId) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: "re-message requires a run-bound orchestrator token",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }
      if (ctx.actor.companyId !== undefined)
        return messageDelegatedChild(db, body, callerRunId, ctx.actor.tokenId);

      // Finding 1 (Codex adversarial review): resolve the caller orchestrator
      // scoped to the token's project AND fail closed if it is missing or has
      // terminalized — a stale run-bound token must not re-message children under
      // a terminal tree. Addressing is SCOPED to the caller's own tree (root_run_id,
      // else its own id) — a persistent child in another tree is invisible.
      const boundRes = await resolveActiveBoundRun(
        db,
        callerRunId,
        ctx.projectId,
      );

      if (!boundRes.ok) {
        return NextResponse.json(
          { code: boundRes.code, message: boundRes.message },
          { status: httpStatusForExtCode(boundRes.code) },
        );
      }

      const caller = boundRes.run;
      const treeRoot = caller.rootRunId ?? caller.id;

      // Resolve the child by key OR id, within the caller's tree and project.
      //
      // ADR-163: the `persistent` filter moved OUT of the WHERE and into an
      // explicit branch below. Filtering on it made every non-persistent target
      // — including a FLOW child, which can never be persistent — answer "no
      // such child", which is false and unactionable: the child exists, it just
      // cannot be messaged. Selection is unchanged (persistent first), so every
      // case that resolves today resolves to the same row; only the refusals
      // get sharper.
      const childRows = await db
        .select({
          id: runs.id,
          runKind: runs.runKind,
          persistent: runs.persistent,
          delegated: sql<boolean>`EXISTS (
            SELECT 1 FROM specialist_work work WHERE work.reserved_run_id=runs.id
          )`,
        })
        .from(runs)
        .where(
          and(
            eq(runs.rootRunId, treeRoot),
            eq(runs.projectId, ctx.projectId),
            body.addressableKey !== undefined
              ? eq(runs.addressableKey, body.addressableKey)
              : eq(runs.id, body.childRunId as string),
          ),
        )
        .orderBy(desc(runs.persistent));
      const child = childRows[0];

      if (!child) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message:
              "no child with that addressableKey/childRunId in this orchestrator tree",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }
      if (child.delegated)
        return messageDelegatedChild(db, body, callerRunId, ctx.actor.tokenId);
      if (ctx.scopeLabel === "assignments:update")
        return NextResponse.json(
          {
            code: "UNAUTHORIZED",
            message: "Assignment-scoped messaging requires exact native work",
          },
          { status: 403 },
        );

      // ADR-163 D2: branch on run_kind BEFORE the persistent check, so a flow
      // child gets the reason that actually applies to it — a flow child has no
      // addressable agent session to message at all, persistent or not.
      if (child.runKind !== "agent") {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message:
              "run_message is not supported for flow children — a flow child has no addressable agent session; use run_collect / run_promote / run_cancel",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      if (!child.persistent) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message:
              "child is not a persistent addressable agent — only a persistent child can be re-messaged",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      try {
        await captureNativeChildInput(
          db,
          { kind: "token", tokenId: ctx.actor.tokenId },
          { sourceRunId: callerRunId, childRunId: child.id },
        );
        const result = await sendAgentMessage(child.id, body.prompt, {
          db,
          requestKey: body.requestKey,
          mode: body.mode ?? "queue",
        });

        return NextResponse.json(result, { status: 200 });
      } catch (err) {
        if (isMaisterError(err)) {
          const reason = err.details?.reason;

          return NextResponse.json(
            {
              code: err.code,
              message: err.message,
              ...(typeof reason === "string" &&
              [
                "native_steer_reconciliation_required",
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
