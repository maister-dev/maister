import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { launchAgentRun } from "@/lib/agents/launch";
import { isMaisterError } from "@/lib/errors";
import { handleExt } from "@/lib/tokens/ext-handler";

// ADR-088: bounded inbound payload — stored verbatim on
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

// The inbound webhook trigger (ADR-088) — the only token-authenticated
// route outside /api/v1/ext. The project derives from the TOKEN
// (auth-context) and the agent must be attached to it; there is no
// body-controlled project identifier.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { agentId } = await params;

  return handleExt(
    req,
    {
      scopeLabel: "agents:trigger",
      endpoint: `POST /api/agents/[agentId]/event`,
      method: "POST",
    },
    async (ctx) => {
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
        const result = await launchAgentRun({
          agentId,
          projectId: ctx.actor.projectId,
          trigger: { source: "webhook", payload },
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
          // Existence-hide: an unknown/unattached agent reads as 404 to the
          // token holder, mirroring the ext cross-project convention.
          if (
            err.code === "PRECONDITION" &&
            /is not registered|not attached/.test(err.message)
          ) {
            return NextResponse.json(
              { code: "PRECONDITION", message: "agent not found" },
              { status: 404 },
            );
          }

          return NextResponse.json(
            { code: err.code, message: err.message },
            { status: statusForCode(err.code) },
          );
        }
        throw err;
      }
    },
  );
}
