import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { NextResponse, type NextRequest } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { librarianErrorResponse, parseSeq } from "@/lib/librarian/http";
import { librarianStreamFrames } from "@/lib/librarian/stream";

// ADR-185 (LCV-12): the caller's conversation stream. The session check is
// the FIRST await; the stream addresses the session user and nothing else.

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  let ownerId: string;

  try {
    ownerId = (await requireActiveSession()).id;
  } catch (err) {
    return librarianErrorResponse(err, "GET /api/librarian/stream");
  }
  const cursor = parseSeq(
    request.headers.get("last-event-id") ??
      request.nextUrl.searchParams.get("lastEventId"),
  );
  const abort = new AbortController();

  request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const encoder = new TextEncoder();
  const frames = librarianStreamFrames({
    db: getDb() as unknown as Db,
    ownerId,
    cursor,
    signal: abort.signal,
  });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await frames.next();

        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      abort.abort();
      await frames.return(undefined);
    },
  });

  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
