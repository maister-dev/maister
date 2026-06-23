import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { applyTriageVerdict, validateVerdictRefs } from "@/lib/services/triage";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";
import { socialActorForToken } from "@/lib/tokens/verify";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { tasks } = schemaModule as unknown as Record<string, any>;

const ENDPOINT_TRIAGE =
  "POST /api/v1/ext/projects/[slug]/tasks/[taskId]/triage";

// ADR-089 D8: set-only verdict — at least one field; the op ALWAYS stamps
// triage_status='triaged'. Every provided id is allow-list validated.
const postBodySchema = z
  .object({
    flowId: z.string().min(1).optional(),
    runnerId: z.string().min(1).optional(),
    targetBranch: z.string().min(1).max(255).optional(),
    promotionMode: z.enum(["local_merge", "pull_request"]).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one verdict field is required",
  });

type RouteParams = { params: Promise<{ slug: string; taskId: string }> };
type TransactionalDb = {
  transaction<T>(scope: (tx: unknown) => Promise<T>): Promise<T>;
};

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, taskId } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "tasks:triage",
      endpoint: ENDPOINT_TRIAGE,
      method: "POST",
      successAuditInWork: true,
      db,
    },
    async (ctx) => {
      let body: z.infer<typeof postBodySchema>;

      try {
        body = postBodySchema.parse(await req.json());
      } catch (err) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `invalid body: ${(err as Error).message}`,
          },
          { status: 422 },
        );
      }

      // taskId ownership re-validated against the token's project (ext
      // idiom — cross-project access hides existence with 404).
      const taskRows = await (db as { select: any })
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId)));

      if (taskRows.length === 0) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "task not found" },
          { status: 404 },
        );
      }

      try {
        await validateVerdictRefs(ctx.projectId, body, db);

        const actor = socialActorForToken(ctx.actor);

        await (db as TransactionalDb).transaction(async (tx) => {
          await applyTriageVerdict(tx, {
            taskId,
            projectId: ctx.projectId,
            verdict: body,
            actor,
          });

          await recordRequiredTokenAudit(
            {
              tokenId: ctx.actor.tokenId,
              projectId: ctx.projectId,
              actorLabel: ctx.actor.actorLabel,
              scopeUsed: "tasks:triage",
              endpoint: ENDPOINT_TRIAGE,
              method: "POST",
              result: "ok",
              statusCode: 200,
            },
            tx,
          );
        });

        return NextResponse.json(
          { ok: true, triageStatus: "triaged" },
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
