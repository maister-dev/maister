import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { launchRun } from "@/lib/services/runs";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";
import { actorUserIdForToken, TokenAuthError } from "@/lib/tokens/verify";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { tasks } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants — `.select` on the union of
// node-postgres + better-sqlite3 handles is not call-compatible.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs";

const postBodySchema = z
  .object({
    taskId: z.string().min(1),
    runnerId: z.string().min(1).optional(),
    executorOverrideId: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    targetBranch: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.runnerId === undefined ||
      body.executorOverrideId === undefined ||
      body.runnerId === body.executorOverrideId,
    {
      message: "runnerId and executorOverrideId must match when both are set",
      path: ["executorOverrideId"],
    },
  );

export async function POST(
  req: NextRequest,
  _routeCtx: object,
): Promise<NextResponse> {
  const db = getDb() as Db;

  return handleExt(
    req,
    {
      scopeLabel: "runs:launch",
      endpoint: ENDPOINT,
      method: "POST",
      successAuditInWork: true,
      db,
    },
    async (ctx) => {
      // Authenticate first (handleExt above), then validate the body — an
      // unauthenticated caller cannot probe the body schema.
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

      // Existence-hide: a task outside the token's project (or absent) returns a
      // uniform 404 — indistinguishable from a missing task — BEFORE launchRun
      // (which resolves the task project-unscoped) can leak a state-specific 409
      // for a cross-project task. Mirrors the task GET/PATCH + gate-report routes.
      const scopedTask = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(eq(tasks.id, body.taskId), eq(tasks.projectId, ctx.projectId)),
        );

      if (scopedTask.length === 0) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "task not found" },
          { status: 404 },
        );
      }

      try {
        const result = await launchRun(
          {
            taskId: body.taskId,
            runnerId: body.runnerId ?? body.executorOverrideId,
            baseBranch: body.baseBranch,
            targetBranch: body.targetBranch,
          },
          {
            actorUserId: actorUserIdForToken(ctx.actor),
            authorize: async (projectId: string) => {
              if (projectId !== ctx.projectId) {
                throw new TokenAuthError("wrong-project");
              }
            },
            recordSuccessAudit: (tx) =>
              recordRequiredTokenAudit(
                {
                  tokenId: ctx.actor.tokenId,
                  projectId: ctx.projectId,
                  actorLabel: ctx.actor.actorLabel,
                  scopeUsed: "runs:launch",
                  endpoint: ENDPOINT,
                  method: "POST",
                  result: "ok",
                  statusCode: 202,
                },
                tx,
              ),
          },
          db,
        );

        return NextResponse.json(result, { status: 202 });
      } catch (err) {
        // TokenAuthError("wrong-project") from authorize → re-throw so handleExt maps it to 404.
        if (err instanceof TokenAuthError) {
          throw err;
        }

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
