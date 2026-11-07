import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { isMaisterError } from "@/lib/errors";

const log = pino({
  name: "human-assessment-http",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Human authoring exposes actionable field keys, never Git/SQL causes or evidence contents. */
export function humanAssessmentErrorResponse(error: unknown): NextResponse {
  if (isMaisterError(error)) {
    const reason =
      typeof error.details?.reason === "string"
        ? error.details.reason
        : "human_assessment_unavailable";
    const status = [
      "qualification_not_found",
      "human_assessment_evidence_unavailable",
    ].includes(reason)
      ? 404
      : error.code === "UNAUTHENTICATED"
        ? 401
        : [
              "UNAUTHORIZED",
              "ACCOUNT_INACTIVE",
              "PASSWORD_CHANGE_REQUIRED",
            ].includes(error.code)
          ? 403
          : error.code === "CONFIG"
            ? 400
            : 409;
    const issues = Array.isArray(error.details?.issues)
      ? error.details.issues
          .filter(
            (issue): issue is { path: string; key: string } =>
              typeof issue === "object" &&
              issue !== null &&
              typeof issue.path === "string" &&
              typeof issue.key === "string",
          )
          .map(({ path, key }) => ({ path, key }))
      : [];

    log.warn(
      { code: error.code, reason, status, issues },
      "human-assessment-http-refused",
    );

    return NextResponse.json(
      {
        code: error.code,
        message: "Review the assessment and selected evidence",
        reason,
        issues,
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
  log.error(
    { errorType: error instanceof Error ? error.name : "unknown" },
    "human-assessment-http-failed",
  );

  return NextResponse.json(
    {
      code: "CRASH",
      message: "Assessment could not be recorded",
      reason: "human_assessment_unavailable",
      issues: [],
    },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
