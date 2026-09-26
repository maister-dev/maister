import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { librarianTurns } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  librarianCardProposalSchema,
  proposeLibrarianCard,
} from "@/lib/librarian/cards";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";

const ENDPOINT = "POST /api/v1/ext/librarian/cards";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    req,
    {
      scopeLabel: "librarian:cards",
      endpoint: ENDPOINT,
      method: "POST",
      allowGlobalActorWithoutProject: true,
      admitLibrarian: true,
      successAuditInWork: true,
      idempotency: {
        kind: "card_propose",
        target: { route: "/api/v1/ext/librarian/cards" },
        parseBody: async (request) =>
          librarianCardProposalSchema.parse(await request.json()),
      },
      db,
    },
    async (ctx) => {
      if (
        ctx.actor.tokenKind !== "librarian" ||
        !ctx.actor.ownerUserId ||
        !ctx.actor.librarianTurnId
      ) {
        return NextResponse.json(
          {
            code: "UNAUTHORIZED",
            message: "only a running librarian turn can propose a card",
          },
          { status: 403 },
        );
      }

      try {
        const proposal = librarianCardProposalSchema.parse(await req.json());
        const [turn] = await db
          .select({
            conversationId: librarianTurns.conversationId,
            segmentId: librarianTurns.segmentId,
          })
          .from(librarianTurns)
          .where(eq(librarianTurns.id, ctx.actor.librarianTurnId));

        if (!turn) {
          return NextResponse.json(
            { code: "PRECONDITION", message: "librarian turn is unavailable" },
            { status: 409 },
          );
        }

        const result = await proposeLibrarianCard(
          {
            conversationId: turn.conversationId,
            segmentId: turn.segmentId,
            ownerUserId: ctx.actor.ownerUserId,
            proposal,
            recordCreated: async (tx, cardId) => {
              const receipt = { cardId, status: "pending" };

              await recordRequiredTokenAudit(
                {
                  ...tokenAuditIdentity(ctx.actor),
                  projectId: null,
                  scopeUsed: "librarian:cards",
                  endpoint: ENDPOINT,
                  method: "POST",
                  result: "ok",
                  statusCode: 201,
                  operationId: ctx.operationId,
                  operation: ctx.operationId
                    ? {
                        id: ctx.operationId,
                        result: { statusCode: 201, body: receipt },
                      }
                    : undefined,
                },
                tx,
              );
            },
          },
          db,
        );

        return NextResponse.json(
          { cardId: result.cardId, status: "pending" },
          { status: 201 },
        );
      } catch (err) {
        if (!isMaisterError(err)) throw err;

        return NextResponse.json(
          { code: err.code, message: err.message, details: err.details },
          {
            status: httpStatusForExtCode(err.code),
          },
        );
      }
    },
  );
}
