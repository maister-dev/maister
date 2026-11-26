import { NextResponse } from "next/server";

import { readBoundedJson } from "@/lib/http/bounded-json";
import { MaisterError } from "@/lib/errors";
import { invalidBody, librarianErrorResponse } from "@/lib/librarian/http";
import { openPrivateQuestion } from "@/lib/librarian/questions";
import {
  SCOPED_HUMAN_ASK_MAX_BYTES,
  scopedHumanAskBodySchema,
} from "@/lib/services/agent-question-contract";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

const endpoint = "POST /api/v1/ext/librarian/human-asks";

export async function POST(request: Request): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    {
      scopeLabel: "librarian:cards",
      endpoint,
      method: "POST",
      admitLibrarian: true,
    },
    async ({ actor }) => {
      if (actor.tokenKind !== "librarian")
        throw new MaisterError(
          "UNAUTHORIZED",
          "A private conversation turn is required",
        );
      const body = scopedHumanAskBodySchema.safeParse(
        await readBoundedJson(request, SCOPED_HUMAN_ASK_MAX_BYTES),
      );

      if (!body.success) return invalidBody("Invalid private question");
      const receipt = await openPrivateQuestion(actor.tokenId, body.data);

      return NextResponse.json(receipt, {
        status: receipt.state === "checkpoint_pending" ? 202 : 200,
      });
    },
    (error) => librarianErrorResponse(error, endpoint),
  );
}
