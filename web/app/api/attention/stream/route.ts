import "server-only";

/**
 * `GET /api/attention/stream` — the user-scoped attention stream (ADR-170,
 * `ATN-11`, `EDGE-ATN-04`).
 *
 * ONE connection per reader, addressed by the session user rather than by a run
 * or a project, because a reader of `/work` or `/activity` watches n runs across
 * m projects and that set changes while they watch (D1).
 *
 * It is a server-side poll of DURABLE read models pushed as SSE (D2) — the same
 * side of the house rule the evaluation-study stream sits on. It never writes
 * run state, never resolves a HITL deferred and never advances a read cursor;
 * it is a read path that happens to push.
 *
 * Frames are TICKS, not a log (D3): "these projects moved, and here are the two
 * counters as of now". The client refetches; it never accumulates frames.
 */

import { type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import pino from "pino";

import { ATTENTION_EVENT_KINDS } from "@/lib/domain-events/taxonomy";
import { computeDecisionsQueue } from "@/lib/queries/decisions";
import { getDb } from "@/lib/db/client";
import { getUpdatesCount } from "@/lib/queries/updates";
import { getVisibleProjectIds } from "@/lib/queries/visible-projects";
import { isMaisterError } from "@/lib/errors";
import { requireActiveSession } from "@/lib/authz";
import { SSE_STREAM_HEADERS, sseFrame } from "@/lib/sse/frame";

const log = pino({
  name: "api-attention-stream",
  level: process.env.LOG_LEVEL ?? "info",
});

// D5: bounds are module constants, not environment variables — an env var
// nobody asked for is a dev/prod skew surface.
const POLL_INTERVAL_MS = 2000;
/**
 * The counters can move with no new activity row at all (a HITL request opens, a
 * notification is read), so they are re-read on this slower beat as well as
 * whenever content changes. It doubles as the heartbeat cadence: an idle stream
 * pays one counter pass per beat instead of a bare comment.
 */
const COUNTER_INTERVAL_MS = 15_000;
/** A genuinely quiet stream is closed rather than held open forever. */
const MAX_QUIET_MS = 5 * 60 * 1000;

/**
 * The wire shape is fixed by `docs/api/async/attention-stream.asyncapi.yaml`
 * (`additionalProperties: false`), so this interface is the contract, not a
 * convenience. `changed` names the regions the client should refetch; the
 * connect-time snapshot carries an EMPTY `changed` because nothing moved — it
 * describes the state the page was already rendered from.
 */
export const ATTENTION_REGIONS = ["decisions", "work", "activity"] as const;

export type AttentionRegion = (typeof ATTENTION_REGIONS)[number];

export interface AttentionTickEvent {
  type: "attention.tick";
  /** The exclusive replay cursor, as a canonical decimal string. */
  id: string;
  occurredAt: string;
  decisions: number;
  updates: number;
  changed: AttentionRegion[];
  projectIds: string[];
}

interface ChangedProject {
  projectId: string;
  /** The exact Postgres timestamp, as text — see `scanChangedProjects`. */
  at: string;
  atMs: number;
}

/**
 * `EDGE-ATN-04`. A valid id resumes the tail strictly after it, so nothing
 * already delivered repeats. A negative, non-numeric, zero or overlong id is NOT
 * an error: for a tick stream the "full replay" is the current state, which the
 * caller sends as one snapshot frame.
 */
const CURSOR_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/;

function parseLastEventId(req: NextRequest): number | null {
  const raw =
    req.headers.get("last-event-id") ??
    new URL(req.url).searchParams.get("lastEventId");

  if (!raw || !CURSOR_PATTERN.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);

  return parsed > 0 ? parsed : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The four durable sources a cross-project surface renders from, scanned in ONE
 * statement. Array interpolations render as a parenthesised parameter list, so
 * they are spelled `in ${...}` — `= any(${...}::text[])` would try to cast a
 * record to an array and fail at runtime, inside the loop, as a logged warning. `domain_events` is restricted to `ATTENTION_EVENT_KINDS` for the
 * same reason the feed and the counter are: three of its kinds are twins of a
 * `task_activity` row already covered by the first branch.
 *
 * The watermark travels as TEXT, not as a JS `Date`. A `timestamptz` carries
 * microseconds; round-tripping it through `Date` floors to milliseconds, and a
 * floored watermark is still strictly LESS than the row it came from — so
 * `ts > watermark` re-reports that row on every poll, forever. The millisecond
 * form is derived alongside it purely as the SSE id, where a coarse resume can
 * only cost one duplicate tick.
 */
async function scanChangedProjects(
  projectIds: string[],
  since: string,
): Promise<ChangedProject[]> {
  const client = getDb();
  const kinds = [...ATTENTION_EVENT_KINDS];
  const result = await client.execute(sql`
    select
      project_id,
      max(ts)::text as ts_text,
      (floor(extract(epoch from max(ts)) * 1000))::bigint as ts_ms
    from (
      select project_id, created_at as ts
        from task_activity
       where project_id in ${projectIds} and created_at > ${since}::timestamptz
      union all
      select project_id, occurred_at
        from domain_events
       where project_id in ${projectIds} and occurred_at > ${since}::timestamptz
         and kind in ${kinds}
      union all
      select project_id, promoted_at
        from workspaces
       where project_id in ${projectIds} and promoted_at > ${since}::timestamptz
      union all
      select e.project_id, d.updated_at
        from webhook_deliveries d
        join webhook_events e on e.id = d.event_id
       where e.project_id in ${projectIds} and d.updated_at > ${since}::timestamptz
         and d.status in ('delivered', 'dead')
    ) moved
    group by project_id
  `);
  const rows = (
    result as unknown as {
      rows: Array<{ project_id: string; ts_text: string; ts_ms: string }>;
    }
  ).rows;

  return rows.map((row) => ({
    projectId: row.project_id,
    at: row.ts_text,
    atMs: Number(row.ts_ms),
  }));
}

export async function GET(req: NextRequest): Promise<Response> {
  let user: { id: string; role: Parameters<typeof getUpdatesCount>[1] };

  try {
    const session = await requireActiveSession();

    user = { id: session.id, role: session.role };
  } catch (err) {
    const status =
      isMaisterError(err) && err.code === "UNAUTHENTICATED" ? 401 : 403;

    return new Response(
      JSON.stringify({
        code: isMaisterError(err) ? err.code : "CRASH",
        message: isMaisterError(err) ? err.message : "internal error",
      }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  }

  const resumeFrom = parseLastEventId(req);
  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let watermarkMs = resumeFrom ?? Date.now();
      let watermark = new Date(watermarkMs).toISOString();
      // Sentinel rather than `null`: a count is never negative, so "-1" reads
      // as "not sent yet" without a nullable that has to be re-narrowed on
      // every comparison.
      let sentDecisions = -1;
      let sentUpdates = -1;
      let lastCounterCheckAt = 0;
      let lastChangeAt = Date.now();
      let closed = false;

      const close = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* a stream aborted mid-enqueue is already closed */
        }
      };

      req.signal.addEventListener("abort", close);

      const counters = async (): Promise<{
        decisions: number;
        updates: number;
      }> => {
        // `computeDecisionsQueue`, NOT the React-cached `getDecisionsQueue`: a
        // request-scoped memo would freeze this loop's counter at the value it
        // had when the connection opened.
        const [queue, updates] = await Promise.all([
          computeDecisionsQueue(user.id, user.role),
          getUpdatesCount(user.id, user.role),
        ]);

        lastCounterCheckAt = Date.now();

        return { decisions: queue.count, updates };
      };

      const emitTick = (
        changed: AttentionRegion[],
        projectIds: string[],
        current: { decisions: number; updates: number },
      ): void => {
        const frame: AttentionTickEvent = {
          type: "attention.tick",
          id: String(watermarkMs),
          occurredAt: new Date().toISOString(),
          decisions: current.decisions,
          updates: current.updates,
          // Fixed region order keeps the array deterministic and unique.
          changed: ATTENTION_REGIONS.filter((region) =>
            changed.includes(region),
          ),
          projectIds,
        };

        controller.enqueue(
          encoder.encode(
            sseFrame({
              id: watermarkMs,
              event: "attention.tick",
              data: frame,
            }),
          ),
        );
        sentDecisions = current.decisions;
        sentUpdates = current.updates;
      };

      try {
        if (resumeFrom === null) {
          emitTick([], [], await counters());
        }

        while (!req.signal.aborted && !closed) {
          // D6: RBAC is re-established every iteration, so a project that
          // leaves the reader's visibility mid-stream stops producing frames
          // without a reconnect.
          const projectIds = await getVisibleProjectIds(user.id, user.role);
          const changed =
            projectIds.length === 0
              ? []
              : await scanChangedProjects(projectIds, watermark);
          const dueCounters =
            sentDecisions < 0 ||
            Date.now() - lastCounterCheckAt >= COUNTER_INTERVAL_MS;

          if (changed.length > 0) {
            const current = await counters();

            const newest = changed.reduce((best, row) =>
              row.atMs >= best.atMs ? row : best,
            );

            watermark = newest.at;
            watermarkMs = newest.atMs;
            // A moved row changes what both cross-project surfaces render; the
            // decision queue only when its own count moved.
            emitTick(
              current.decisions === sentDecisions
                ? ["work", "activity"]
                : ["decisions", "work", "activity"],
              changed.map((row) => row.projectId),
              current,
            );
            lastChangeAt = Date.now();
          } else if (dueCounters) {
            const current = await counters();

            if (
              current.decisions !== sentDecisions ||
              current.updates !== sentUpdates
            ) {
              // The watermark deliberately does NOT advance here: nothing was
              // scanned past it, and moving it to "now" would skip a row
              // written while the scan was in flight.
              const moved: AttentionRegion[] = [];

              if (current.decisions !== sentDecisions) moved.push("decisions");
              if (current.updates !== sentUpdates) moved.push("activity");
              emitTick(moved, [], current);
              lastChangeAt = Date.now();
            } else {
              controller.enqueue(
                encoder.encode(
                  sseFrame({
                    event: "attention.heartbeat",
                    data: { type: "attention.heartbeat" },
                  }),
                ),
              );
            }
          }

          if (Date.now() - lastChangeAt > MAX_QUIET_MS) {
            controller.enqueue(
              encoder.encode(
                sseFrame({
                  event: "attention.stream_timeout",
                  data: {
                    type: "attention.stream_timeout",
                    reason: "quiet_cap",
                  },
                }),
              ),
            );
            break;
          }

          await delay(POLL_INTERVAL_MS);
        }
      } catch (err) {
        log.warn(
          {
            userId: user.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "attention stream loop error",
        );
      } finally {
        close();
        log.info(
          {
            userId: user.id,
            durationMs: Date.now() - startedAt,
            watermarkMs,
          },
          "attention stream disconnect",
        );
      }
    },
  });

  return new Response(stream, { headers: SSE_STREAM_HEADERS });
}
