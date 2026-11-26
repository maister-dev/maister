import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { readBoundedJson } from "@/lib/http/bounded-json";
import { requireActiveSession } from "@/lib/authz";
import { queryErrorDiagnostics } from "@/lib/db/pg-error";
import { isMaisterError } from "@/lib/errors";
import { admitNextLibrarianTurn } from "@/lib/librarian/admission";
import { invalidBody, librarianErrorResponse } from "@/lib/librarian/http";
import { SCOPED_HUMAN_ASK_MAX_BYTES } from "@/lib/services/agent-question-contract";
import { answerPrivateQuestion } from "@/lib/librarian/questions";

const bodySchema = z.strictObject({
  answer: z.record(z.string(), z.unknown()),
});

const log = pino({
  name: "librarian.question-answer",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ cardId: string }> },
): Promise<NextResponse> {
  try {
    const owner = await requireActiveSession();
    const { cardId } = await params;
    const input = bodySchema.safeParse(
      await readBoundedJson(request, SCOPED_HUMAN_ASK_MAX_BYTES),
    );

    if (!input.success) return invalidBody("Invalid answer");
    const result = await answerPrivateQuestion(
      owner.id,
      cardId,
      input.data.answer,
    );

    if (result.state === "accepted") {
      try {
        await admitNextLibrarianTurn(result.conversationId);
      } catch (error) {
        // The answer already committed. The librarian sweep retries admission.
        log.warn(
          {
            questionId: result.questionId,
            conversationId: result.conversationId,
            ...(isMaisterError(error)
              ? { code: error.code, reason: error.details?.reason }
              : queryErrorDiagnostics(error)),
          },
          "private answer continuation admission deferred",
        );
      }
    }

    return NextResponse.json(
      { questionId: result.questionId, state: result.state },
      { status: result.state === "delivered" ? 200 : 202 },
    );
  } catch (error) {
    return librarianErrorResponse(
      error,
      "POST /api/librarian/cards/[cardId]/answer",
    );
  }
}
