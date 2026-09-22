import "server-only";

import type {
  HitlAnswerState,
  HitlStoredResponse,
} from "@/lib/hitl-response-contract";
import type { JsonValue } from "@/lib/hitl-response-contract";

import {
  isConsensusResolutionSchema,
  isReviewSchema,
} from "@/lib/flows/hitl-validate";

export type HitlAnswerView = {
  answerState: HitlAnswerState;
  storedResponse: HitlStoredResponse | null;
};

function containsPrivateKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateKey);
  if (value === null || typeof value !== "object") return false;

  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => key.startsWith("_") || containsPrivateKey(child),
  );
}

export function projectHitlAnswer(input: {
  kind: string;
  response: unknown;
  responseIsNotNull: boolean;
  respondedAt: Date | null;
  confidence?: number | null;
  schema?: unknown;
}): HitlAnswerView {
  if (input.respondedAt !== null || !input.responseIsNotNull) {
    return { answerState: "open", storedResponse: null };
  }

  if (input.kind === "permission") {
    const optionId =
      input.response !== null && typeof input.response === "object"
        ? (input.response as { optionId?: unknown }).optionId
        : undefined;

    return {
      answerState: "answer_stored",
      storedResponse:
        typeof optionId === "string" && optionId.length > 0
          ? { optionId }
          : null,
    };
  }

  if (
    input.kind !== "form" &&
    input.kind !== "human" &&
    input.kind !== "agent_question"
  ) {
    return { answerState: "answer_stored", storedResponse: null };
  }

  if (
    isReviewSchema(input.schema) ||
    isConsensusResolutionSchema(input.schema)
  ) {
    return { answerState: "answer_stored", storedResponse: null };
  }

  if (containsPrivateKey(input.response)) {
    return { answerState: "answer_stored", storedResponse: null };
  }

  if (
    input.confidence !== undefined &&
    input.confidence !== null &&
    input.response !== null &&
    typeof input.response === "object" &&
    !Array.isArray(input.response) &&
    (input.response as Record<string, unknown>).confidence !== input.confidence
  ) {
    return { answerState: "answer_stored", storedResponse: null };
  }

  return {
    answerState: "answer_stored",
    storedResponse: {
      response: input.response as JsonValue,
      ...(input.confidence !== undefined && input.confidence !== null
        ? { confidence: input.confidence }
        : {}),
    },
  };
}
