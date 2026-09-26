import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { librarianTurns } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  listPersonalMemory,
  memoryDraftSchema,
  rememberFromLibrarianTurn,
} from "@/lib/librarian/memory";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";

const ENDPOINT = "POST /api/v1/ext/librarian/memory";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    request,
    {
      scopeLabel: "librarian:memory",
      endpoint: ENDPOINT,
      method: "POST",
      allowGlobalActorWithoutProject: true,
      admitLibrarian: true,
      successAuditInWork: true,
      idempotency: {
        kind: "memory_remember",
        target: { route: "/api/v1/ext/librarian/memory" },
        parseBody: async (req) => memoryDraftSchema.parse(await req.json()),
      },
      db,
    },
    async (ctx) => {
      if (
        ctx.actor.tokenKind !== "librarian" ||
        !ctx.actor.ownerUserId ||
        !ctx.actor.librarianTurnId
      )
        return NextResponse.json(
          {
            code: "UNAUTHORIZED",
            message: "only a running librarian turn can remember memory",
          },
          { status: 403 },
        );
      const [turn] = await db
        .select({ variant: librarianTurns.variant })
        .from(librarianTurns)
        .where(eq(librarianTurns.id, ctx.actor.librarianTurnId));

      if (turn?.variant !== "owner_message")
        return NextResponse.json(
          {
            code: "UNAUTHORIZED",
            message: "only an owner-message turn can remember memory",
          },
          { status: 403 },
        );
      try {
        const draft = memoryDraftSchema.parse(await request.json());
        const itemId = await rememberFromLibrarianTurn(
          ctx.actor.ownerUserId,
          ctx.actor.librarianTurnId,
          draft,
          async (tx, createdId) => {
            await recordRequiredTokenAudit(
              {
                ...tokenAuditIdentity(ctx.actor),
                projectId: null,
                scopeUsed: "librarian:memory",
                endpoint: ENDPOINT,
                method: "POST",
                result: "ok",
                statusCode: 201,
                operationId: ctx.operationId,
                operation: ctx.operationId
                  ? {
                      id: ctx.operationId,
                      result: { statusCode: 201, body: { itemId: createdId } },
                    }
                  : undefined,
              },
              tx,
            );
          },
          db,
        );
        const view = await listPersonalMemory(ctx.actor.ownerUserId, db);
        const item = view.items.find((entry) => entry.id === itemId);

        if (!item)
          throw new Error(`new librarian memory item ${itemId} missing`);

        return NextResponse.json({ item }, { status: 201 });
      } catch (error) {
        if (!isMaisterError(error)) throw error;

        return NextResponse.json(
          { code: error.code, message: error.message, details: error.details },
          { status: httpStatusForExtCode(error.code) },
        );
      }
    },
  );
}
