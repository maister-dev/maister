import "server-only";

import pino from "pino";
import { after, NextRequest, NextResponse } from "next/server";

import { readBoundedJson } from "@/lib/http/bounded-json";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  SCOPED_HUMAN_ASK_MAX_BYTES,
  scopedHumanAskBodySchema,
} from "@/lib/services/agent-question-contract";
import { createExecutionHosts } from "@/lib/execution-host/client";
import {
  activateFlowNodeQuestionOnHostEvents,
  requestFlowNodeQuestion,
} from "@/lib/services/flow-node-question";
import { httpStatusForExtCode } from "@/lib/tokens/ext-handler";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

const log = pino({ name: "flow-node-question-api" });

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    {
      scopeLabel: "hitl:request",
      method: "POST",
      endpoint: "POST /api/v1/ext/flow-node/human-asks",
    },
    async ({ actor }) => {
      const body = scopedHumanAskBodySchema.safeParse(
        await readBoundedJson(request, SCOPED_HUMAN_ASK_MAX_BYTES),
      );

      if (!body.success)
        throw new MaisterError("CONFIG", "Invalid scoped Flow question");
      const receipt = await requestFlowNodeQuestion(
        getDb(),
        actor.tokenId,
        body.data,
      );

      if (receipt.state === "checkpoint_pending")
        after(async () => {
          try {
            const db = getDb();

            await activateFlowNodeQuestionOnHostEvents(
              db,
              createExecutionHosts({ db }),
              receipt.questionId,
            );
          } catch (error) {
            log.warn(
              {
                questionId: receipt.questionId,
                code: isMaisterError(error) ? error.code : "INTERNAL",
              },
              "Question retained for checkpoint reconciliation",
            );
          }
        });

      return NextResponse.json(receipt, {
        status: receipt.state === "checkpoint_pending" ? 202 : 200,
      });
    },
    (error) => {
      if (!isMaisterError(error)) throw error;

      return NextResponse.json(
        { code: error.code, message: error.message },
        {
          status:
            error.details?.reason === "json_body_too_large"
              ? 413
              : httpStatusForExtCode(error.code),
        },
      );
    },
  );
}
