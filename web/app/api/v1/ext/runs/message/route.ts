import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { sendAgentMessage } from "@/lib/agents/launch";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
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
    childRunId: z.string().min(1).optional(),
    prompt: z.string().min(1),
  })
  .strict()
  .refine((b) => b.addressableKey !== undefined || b.childRunId !== undefined, {
    message: "one of addressableKey or childRunId is required",
    path: ["addressableKey"],
  });

type MessageBody = z.infer<typeof bodySchema>;

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

      // Derive the caller orchestrator's tree root (root_run_id, else its own
      // id). Addressing is SCOPED to the caller's own tree — a persistent child
      // in another tree is invisible (resolved to PRECONDITION below).
      const callerRows = await db
        .select({ id: runs.id, rootRunId: runs.rootRunId })
        .from(runs)
        .where(
          and(eq(runs.id, callerRunId), eq(runs.projectId, ctx.projectId)),
        );
      const caller = callerRows[0];

      if (!caller) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: "bound orchestrator run not found in project",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      const treeRoot = caller.rootRunId ?? caller.id;

      // Resolve the persistent child by key OR id, within the caller's tree and
      // project. addressable_key is unique per tree, so this matches at most one.
      const childRows = await db
        .select({ id: runs.id, runKind: runs.runKind })
        .from(runs)
        .where(
          and(
            eq(runs.rootRunId, treeRoot),
            eq(runs.persistent, true),
            eq(runs.projectId, ctx.projectId),
            body.addressableKey !== undefined
              ? eq(runs.addressableKey, body.addressableKey)
              : eq(runs.id, body.childRunId as string),
          ),
        );
      const child = childRows[0];

      if (!child) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message:
              "no persistent child with that addressableKey/childRunId in this orchestrator tree",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      if (child.runKind !== "agent") {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: "re-message targets an agent child only",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      try {
        const result = await sendAgentMessage(child.id, body.prompt, { db });

        return NextResponse.json(
          { childRunId: result.childRunId, status: result.status },
          { status: 200 },
        );
      } catch (err) {
        if (isMaisterError(err)) {
          return NextResponse.json(
            { code: err.code, message: err.message },
            { status: httpStatusForExtCode(err.code) },
          );
        }

        throw err;
      }
    },
  );
}
