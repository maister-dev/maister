import "server-only";

import { MaisterError } from "@/lib/errors";
import {
  isHitlRespondReason,
  type HitlRespondReason,
} from "@/lib/hitl-response-contract";

export type PublicHitlRespondDetails = {
  reason: HitlRespondReason;
  causeCode?: string;
};

const CAUSE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function publicHitlRespondDetails(
  details: Record<string, unknown> | undefined,
): PublicHitlRespondDetails | undefined {
  if (!isHitlRespondReason(details?.reason)) return undefined;

  const result: PublicHitlRespondDetails = { reason: details.reason };

  if (
    (details.reason === "prompt_owner_deferred" ||
      details.reason === "prompt_owner_invariant") &&
    typeof details.causeCode === "string" &&
    CAUSE_CODE.test(details.causeCode)
  ) {
    result.causeCode = details.causeCode;
  }

  return result;
}

export function publicHitlRespondError(error: MaisterError): {
  code: MaisterError["code"];
  message: string;
  details?: PublicHitlRespondDetails;
} {
  const details = publicHitlRespondDetails(error.details);

  return {
    code: error.code,
    message: error.message,
    ...(details ? { details } : {}),
  };
}
