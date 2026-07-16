import "server-only";

import { type NextRequest } from "next/server";
import pino from "pino";

import { requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import {
  formatSseFrame,
  readEvaluationEvents,
} from "@/lib/evaluations/dispatcher/events";
import { evalErrorResponse } from "@/lib/evaluations/route-helpers";
import { getStudyForProject } from "@/lib/evaluations/studies";

const log = pino({
  name: "api-project-eval-stream",
  level: process.env.LOG_LEVEL ?? "info",
});

// Server-side read-model poll of the DURABLE evaluation_events log (NOT a
// state-transition trigger — the FSM is CAS-driven by the dispatcher). The client
// holds one EventSource and reconnects with Last-Event-ID; the server replays the
// tail from the DB and pushes new frames, so no client polling and no in-memory
// replay state (D17).
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_MS = 15_000;
const MAX_QUIET_MS = 5 * 60 * 1000;

type RouteParams = { params: Promise<{ slug: string; studyId: string }> };

function parseLastEventId(req: NextRequest): number {
  const header = req.headers.get("last-event-id");
  const query = new URL(req.url).searchParams.get("lastEventId");
  const raw = header ?? query;

  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);

  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  let studyId: string;

  try {
    const resolved = await params;

    studyId = resolved.studyId;
    const project = await resolveProject(resolved.slug);

    await requireProjectAction(project.id, "readEvaluationStudies");
    // Ownership guard: a cross-project studyId is hidden as 404 before streaming.
    await getStudyForProject({ studyId, projectId: project.id });
  } catch (err) {
    return evalErrorResponse(err, log);
  }

  const lastEventId = parseLastEventId(req);
  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastSeen = lastEventId;
      let lastActivity = Date.now();
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* ignore double-close */
        }
      };

      req.signal.addEventListener("abort", close);

      try {
        while (!req.signal.aborted && !closed) {
          const events = await readEvaluationEvents({
            studyId,
            afterSequence: lastSeen,
          });

          if (events.length > 0) {
            for (const event of events) {
              controller.enqueue(encoder.encode(formatSseFrame(event)));
              lastSeen = event.sequence;
            }
            lastActivity = Date.now();
          } else if (Date.now() - lastActivity >= HEARTBEAT_MS) {
            // A comment frame keeps the connection warm without advancing
            // Last-Event-ID (no `id:` line).
            controller.enqueue(encoder.encode(`: heartbeat\n\n`));
            lastActivity = Date.now();
          }

          if (Date.now() - startedAt > MAX_QUIET_MS) {
            controller.enqueue(
              encoder.encode(
                `event: stream_timeout\ndata: {"reason":"max-duration"}\n\n`,
              ),
            );
            break;
          }

          await delay(POLL_INTERVAL_MS);
        }
      } catch (err) {
        log.warn(
          { studyId, err: err instanceof Error ? err.message : String(err) },
          "evaluation stream loop error",
        );
      } finally {
        close();
        log.info(
          { studyId, durationMs: Date.now() - startedAt, lastSeen },
          "evaluation stream disconnect",
        );
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
