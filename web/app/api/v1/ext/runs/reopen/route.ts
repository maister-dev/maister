import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { socialActorForToken } from "@/lib/tokens/verify";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { reopenRun, type ReopenActor } from "@/lib/runs/reopen";
import { handleExt, httpStatusForExtCode, unknownLibrarianEffectResponse } from "@/lib/tokens/ext-handler";
import { recordRequiredTokenAudit } from "@/lib/tokens/ext-handler";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import { runProjectResolver } from "@/lib/tokens/run-project";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/reopen";
const SCOPE = "runs:sync";

const bodySchema = z
  .object({
    runId: z.string().min(1),
  })
  .strict();

type ReopenBody = z.infer<typeof bodySchema>;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const db = getDb() as Db;

  // AUTH FIRST — see the note in the sibling sync route: keying
  // `resolveProjectId` off a body field forced the parse above `handleExt`, so a
  // valid token sending a malformed body was answered 422 with NO
  // `token_audit_log` row. The project comes from the TOKEN, and the run is
  // existence-hidden against it below.
  return handleExt(
    req,
    {
      scopeLabel: SCOPE,
      admitLibrarian: true,
      endpoint: ENDPOINT,
      method: "POST",
      requireScope: true,
      successAuditInWork: true,
      resolveLibrarianProjectId: async (handlerCtx) => {
        const parsed = bodySchema.safeParse(await req.clone().json().catch(() => null));

        return parsed.success ? runProjectResolver(parsed.data.runId)(handlerCtx) : null;
      },
      idempotency: {
        kind: "run_reopen",
        target: { route: "/api/v1/ext/runs/reopen" },
        parseBody: async (request) => bodySchema.parse(await request.json()),
      },
      db,
    },
    async (ctx) => {
      let body: ReopenBody;

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

      // Load-bearing, NOT belt-and-braces: `reopenRun` takes no projectId, so
      // this is the ONLY thing standing between a project-A token and a run in
      // project B. A foreign run is existence-hidden as 404.
      const rows = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, body.runId), eq(runs.projectId, ctx.projectId)));

      if (rows.length === 0) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "run not found" },
          { status: 404 },
        );
      }

      // Canonical mapper — see the note in the sibling sync route: a hand-rolled
      // mapping records an ownerless PROJECT token as `{user, id: null}` rather
      // than `{system, null}`, corrupting the lifecycle-op audit trail.
      const actor: ReopenActor = socialActorForToken(ctx.actor);

      try {
        const result = await reopenRun({ runId: body.runId, actor, db });
        const receipt = { runId: body.runId, status: result.status };

        await db.transaction(async (tx: Db) => {
          await recordRequiredTokenAudit({
            ...tokenAuditIdentity(ctx.actor),
            projectId: ctx.projectId,
            scopeUsed: SCOPE,
            endpoint: ENDPOINT,
            method: "POST",
            result: "ok",
            statusCode: 200,
            operationId: ctx.operationId,
            operation: ctx.operationId
              ? { id: ctx.operationId, result: { statusCode: 200, body: receipt } }
              : undefined,
          }, tx);
        });

        return NextResponse.json(
          receipt,
          { status: 200 },
        );
      } catch (err) {
        if (ctx.operationId) {
          return unknownLibrarianEffectResponse({
            actor: ctx.actor,
            projectId: ctx.projectId,
            operationId: ctx.operationId,
            scopeLabel: SCOPE,
            endpoint: ENDPOINT,
            method: "POST",
            error: err,
          }, db);
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
