import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { readBoundedJson } from "@/lib/http/bounded-json";
import { requireActiveSession } from "@/lib/authz";
import { admitNextLibrarianTurn } from "@/lib/librarian/admission";
import { invalidBody, librarianErrorResponse } from "@/lib/librarian/http";
import { SCOPED_HUMAN_ASK_MAX_BYTES } from "@/lib/services/agent-question-contract";
import { answerPrivateQuestion } from "@/lib/librarian/questions";

const bodySchema = z.strictObject({
  answer: z.record(z.string(), z.unknown()),
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

    if (result.state === "accepted")
      await admitNextLibrarianTurn(result.conversationId);

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
