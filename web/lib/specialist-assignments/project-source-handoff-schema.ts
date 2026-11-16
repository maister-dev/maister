import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { sql } from "drizzle-orm";

/** Closed source identity stays separate from both the immutable binding snapshot and qualification. */
export function projectSourceHandoffShape(column: AnyPgColumn): SQL {
  return sql`(${column} IS NULL OR (CASE WHEN jsonb_typeof(${column})='object'
    AND jsonb_typeof(${column}->'assignment')='object'
    AND jsonb_typeof(${column}->'source')='object'
    AND jsonb_typeof(${column}->'assignment'->'inputRevision')='number' THEN
    ${column} ?& ARRAY['schemaVersion','assignment','source']
    AND ${column}-ARRAY['schemaVersion','assignment','source']='{}'::jsonb
    AND ${column}->'schemaVersion'='1'::jsonb
    AND (${column}->'assignment') ?& ARRAY['id','inputRevision','inputSha256']
    AND (${column}->'assignment')-ARRAY['id','inputRevision','inputSha256']='{}'::jsonb
    AND jsonb_typeof(${column}->'assignment'->'id')='string'
    AND char_length(${column}->'assignment'->>'id') BETWEEN 1 AND 128
    AND ${column}->'assignment'->>'id' ~ '[^[:space:]]'
    AND (${column}->'assignment'->>'inputRevision')::numeric BETWEEN 1 AND 2147483647
    AND mod((${column}->'assignment'->>'inputRevision')::numeric,1)=0
    AND jsonb_typeof(${column}->'assignment'->'inputSha256')='string'
    AND ${column}->'assignment'->>'inputSha256' ~ '^[a-f0-9]{64}$'
    AND ${column}->'source'->'schemaVersion'='1'::jsonb
    AND (CASE WHEN ${column}->'source'->>'kind'='cron' THEN
      (${column}->'source') ?& ARRAY['schemaVersion','kind','attemptId','scheduleId','runId']
      AND (${column}->'source')-ARRAY['schemaVersion','kind','attemptId','scheduleId','runId']='{}'::jsonb
      WHEN ${column}->'source'->>'kind' IN ('task_comment','event')
        AND jsonb_typeof(${column}->'source'->'eventId')='number' THEN
      (${column}->'source') ?& ARRAY['schemaVersion','kind','attemptId','scheduleId','runId','eventId']
      AND (${column}->'source')-ARRAY['schemaVersion','kind','attemptId','scheduleId','runId','eventId']='{}'::jsonb
      AND (${column}->'source'->>'eventId')::numeric BETWEEN 1 AND 9007199254740991
      AND mod((${column}->'source'->>'eventId')::numeric,1)=0
      ELSE false END)
    AND jsonb_typeof(${column}->'source'->'attemptId')='string'
    AND char_length(${column}->'source'->>'attemptId') BETWEEN 1 AND 128
    AND ${column}->'source'->>'attemptId' ~ '[^[:space:]]'
    AND jsonb_typeof(${column}->'source'->'scheduleId')='string'
    AND char_length(${column}->'source'->>'scheduleId') BETWEEN 1 AND 128
    AND ${column}->'source'->>'scheduleId' ~ '[^[:space:]]'
    AND jsonb_typeof(${column}->'source'->'runId')='string'
    AND char_length(${column}->'source'->>'runId') BETWEEN 1 AND 128
    AND ${column}->'source'->>'runId' ~ '[^[:space:]]'
    AND octet_length(${column}::text)<=2048
    ELSE false END)) IS TRUE`;
}
