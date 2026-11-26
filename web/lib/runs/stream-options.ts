import "server-only";

import type { AnyColumn, SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";

const LIVE_REPLAY_VALUES = new Set(["0", "false", "live"]);

export function shouldReplayRunStream(url: string): boolean {
  const value = new URL(url, "http://localhost").searchParams.get("replay");

  return value ? !LIVE_REPLAY_VALUES.has(value.toLowerCase()) : true;
}

export function streamReadyEvent(): {
  type: "session.stream_ready";
  replay: false;
} {
  return { type: "session.stream_ready", replay: false };
}

export function contextUsageOnlySql(refs: {
  eventType: AnyColumn | SQL;
  payload: AnyColumn | SQL;
}): SQL<boolean> {
  return sql<boolean>`COALESCE(CASE
    WHEN ${refs.eventType} = 'session.update' THEN
      jsonb_typeof(${refs.payload}) = 'object'
      AND (
        ${refs.payload}->>'contextType' = 'usage_update'
        OR (
          jsonb_typeof(${refs.payload}->'update') = 'object'
          AND ${refs.payload}->'update'->>'sessionUpdate' = 'usage_update'
        )
      )
    WHEN ${refs.eventType} = 'session.line' THEN
      jsonb_typeof(${refs.payload}) = 'object'
      AND ${refs.payload}->'contextUsageOnly' = 'true'::jsonb
    ELSE false
  END, false)`;
}
