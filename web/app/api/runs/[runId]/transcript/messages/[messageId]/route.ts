import "server-only";

import type { NextRequest } from "next/server";

import pino from "pino";

import { requireActiveSession } from "@/lib/authz";
import { safeDownloadHeaders } from "@/lib/http/safe-download";
import { parsePeekRunId, peekFailure, peekQuery } from "@/lib/runs/peek-http";
import { openTranscriptMessageContent } from "@/lib/runs/transcript-message-content";

const log = pino({
  name: "api-transcript-message",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string; messageId: string }> },
): Promise<Response> {
  const { runId, messageId } = await params;

  try {
    const user = await requireActiveSession();
    const query = peekQuery(request, ["attempt"]);
    const download = await openTranscriptMessageContent({
      userId: user.id,
      runId: parsePeekRunId(runId),
      messageId,
      attempt: query.attempt,
      signal: request.signal,
      onError: (error) =>
        log.error(
          { runId, messageId, err: error },
          "[FIX:run-transcript-loading] message download failed",
        ),
    });
    const json = download.role === "tool" || download.role === "system";

    log.debug(
      { runId, messageId, bytes: download.bytes },
      "[FIX:run-transcript-loading] message download opened",
    );

    return new Response(download.body, {
      headers: {
        ...safeDownloadHeaders({
          fileName: `transcript-message.${json ? "json" : "txt"}`,
          mediaClass: json ? "json" : "text",
        }),
        "Content-Length": String(download.bytes),
      },
    });
  } catch (error) {
    return peekFailure(error, {
      requestId: `${runId}:${messageId}`,
      operation: "transcript-message",
    });
  }
}
