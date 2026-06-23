import "server-only";

import { NextRequest, NextResponse } from "next/server";

import {
  hidesAgentExistenceForLaunch,
  isAgentLaunchError,
  launchAgentRun,
  publicAgentLaunchMessage,
} from "@/lib/agents/launch";
import { isMaisterError } from "@/lib/errors";
import { decodeRouteParam } from "@/lib/route-params";
import { handleExt } from "@/lib/tokens/ext-handler";

// ADR-089: bounded inbound payload — stored verbatim on
// runs.trigger_payload and appended to the agent's prompt context.
const MAX_PAYLOAD_BYTES = 32 * 1024;

type RouteParams = { params: Promise<{ agentId: string }> };

function statusForCode(code: string): number {
  switch (code) {
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    case "CONFIG":
      return 422;
    default:
      return 500;
  }
}

function hasOversizedContentLength(req: NextRequest): boolean {
  const raw = req.headers.get("content-length");

  if (raw === null) return false;

  const bytes = Number.parseInt(raw, 10);

  return Number.isInteger(bytes) && bytes > MAX_PAYLOAD_BYTES;
}

function parseTriggerEventId(req: NextRequest): number | null {
  const raw = req.headers.get("x-maister-trigger-event-id");

  if (raw === null || raw.trim() === "") return null;

  const trimmed = raw.trim();
  const parsed = Number.parseInt(trimmed, 10);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    String(parsed) !== trimmed
  ) {
    throw new Error("X-Maister-Trigger-Event-Id must be a positive integer");
  }

  return parsed;
}

// The inbound webhook trigger (ADR-089) — the only token-authenticated
// route outside /api/v1/ext. The project derives from the TOKEN
// (auth-context) and the agent must be attached to it; there is no
// body-controlled project identifier.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { agentId: rawAgentId } = await params;

  return handleExt(
    req,
    {
      scopeLabel: "agents:trigger",
      endpoint: `POST /api/agents/[agentId]/event`,
      method: "POST",
    },
    async (ctx) => {
      let agentId: string;

      try {
        agentId = decodeRouteParam(rawAgentId, "agentId");
      } catch (err) {
        if (isMaisterError(err)) {
          return NextResponse.json(
            { code: err.code, message: err.message },
            { status: statusForCode(err.code) },
          );
        }
        throw err;
      }

      if (hasOversizedContentLength(req)) {
        return NextResponse.json(
          { code: "CONFIG", message: "payload exceeds 32 KB" },
          { status: 413 },
        );
      }

      const raw = await req.text();

      if (Buffer.byteLength(raw, "utf8") > MAX_PAYLOAD_BYTES) {
        return NextResponse.json(
          { code: "CONFIG", message: "payload exceeds 32 KB" },
          { status: 413 },
        );
      }

      let payload: Record<string, unknown> = {};

      if (raw.trim() !== "") {
        let parsed: unknown;

        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          return NextResponse.json(
            {
              code: "CONFIG",
              message: `invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`,
            },
            { status: 422 },
          );
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          return NextResponse.json(
            { code: "CONFIG", message: "payload must be a JSON object" },
            { status: 422 },
          );
        }
        payload = parsed as Record<string, unknown>;
      }

      try {
        let triggerEventId: number | null;

        try {
          triggerEventId = parseTriggerEventId(req);
        } catch (err) {
          return NextResponse.json(
            {
              code: "CONFIG",
              message: err instanceof Error ? err.message : String(err),
            },
            { status: 422 },
          );
        }

        const result = await launchAgentRun({
          agentId,
          projectId: ctx.projectId,
          trigger: {
            source: "webhook",
            eventId: triggerEventId,
            payload,
          },
        });

        if ("deduped" in result) {
          return NextResponse.json(
            { code: "CONFLICT", message: "trigger already claimed" },
            { status: 409 },
          );
        }

        return NextResponse.json(
          {
            runId: result.runId,
            status: result.status,
            ...(result.queuePosition !== undefined
              ? { queuePosition: result.queuePosition }
              : {}),
          },
          { status: 202 },
        );
      } catch (err) {
        if (isMaisterError(err)) {
          if (hidesAgentExistenceForLaunch(err)) {
            return NextResponse.json(
              { code: "PRECONDITION", message: "agent not found" },
              { status: 404 },
            );
          }

          return NextResponse.json(
            {
              code: err.code,
              message: isAgentLaunchError(err)
                ? publicAgentLaunchMessage(err)
                : err.message,
            },
            { status: statusForCode(err.code) },
          );
        }
        throw err;
      }
    },
  );
}
