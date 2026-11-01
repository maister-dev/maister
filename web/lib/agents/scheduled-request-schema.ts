import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";

export function scheduledRequestShape(column: AnyPgColumn): SQL {
  return sql`(${column} IS NULL OR CASE WHEN jsonb_typeof(${column}) = 'object' THEN (
    ${column} ?& ARRAY['version','scheduleId','triggerAttemptId','requestAtLaunch']
    AND ${column} - ARRAY['version','scheduleId','triggerAttemptId','requestAtLaunch'] = '{}'::jsonb
    AND ${column}->'version' = '1'::jsonb
    AND jsonb_typeof(${column}->'scheduleId') = 'string'
    AND char_length(${column}->>'scheduleId') BETWEEN 1 AND 256
    AND jsonb_typeof(${column}->'triggerAttemptId') = 'string'
    AND char_length(${column}->>'triggerAttemptId') BETWEEN 1 AND 256
    AND (${column}->'requestAtLaunch' = 'null'::jsonb OR (
      jsonb_typeof(${column}->'requestAtLaunch') = 'string'
      AND char_length(${column}->>'requestAtLaunch') BETWEEN 1 AND 8000
    ))) ELSE false END) IS TRUE`;
}
