import "server-only";

import type { NextResponse } from "next/server";
import type { AssignmentQuestionReceipt } from "./question-types";

import { NextResponse as Response } from "next/server";

import {
  knowledgeErrorResponse,
  knowledgeJson,
} from "@/lib/brain/knowledge-http";
import { isMaisterError, MaisterError } from "@/lib/errors";

export function assignmentQuestionJson(
  receipt: AssignmentQuestionReceipt,
): NextResponse {
  if (receipt.activationState === "failed")
    throw new MaisterError(
      "CONFLICT",
      "The retained question requires recovery before activation",
    );

  return knowledgeJson(
    receipt,
    receipt.activationState === "pending_termination"
      ? 202
      : receipt.created
        ? 201
        : 200,
  );
}

export function assignmentQuestionError(
  error: unknown,
  endpoint: string,
): NextResponse {
  if (isMaisterError(error) && error.code === "NEEDS_INPUT")
    return knowledgeJson(
      {
        code: error.code,
        message: error.message,
        ...(typeof error.details?.reason === "string"
          ? { details: { reason: error.details.reason } }
          : {}),
      },
      422,
    );

  return knowledgeErrorResponse(error, endpoint);
}

export function assignmentQuestionExternalError(
  error: unknown,
  endpoint: string,
): NextResponse {
  const response = assignmentQuestionError(error, endpoint);

  return response.status === 400
    ? new Response(response.body, { status: 422, headers: response.headers })
    : response;
}
