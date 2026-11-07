import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { sql } from "drizzle-orm";

/** New assignment attribution is recorded by the server; legacy unknown is not a new actor. */
export function specialistActorShape(column: AnyPgColumn): SQL {
  return sql`(CASE WHEN jsonb_typeof(${column})='object' THEN
    ${column} ?& ARRAY['kind','id','runId','attemptId']
    AND ${column} - ARRAY['kind','id','runId','attemptId']='{}'::jsonb
    AND ${column}->>'kind' IN ('user','agent','system')
    AND jsonb_typeof(${column}->'id')='string'
    AND char_length(${column}->>'id') BETWEEN 1 AND 192
    AND (${column}->'runId'='null'::jsonb OR (jsonb_typeof(${column}->'runId')='string' AND char_length(${column}->>'runId') BETWEEN 1 AND 128))
    AND (${column}->'attemptId'='null'::jsonb OR (jsonb_typeof(${column}->'attemptId')='string' AND char_length(${column}->>'attemptId') BETWEEN 1 AND 128))
    ELSE false END) IS TRUE`;
}

/** Source classification is explicit, including the valid empty set; omission is never classified. */
export function specialistInputPlanesShape(
  objective: AnyPgColumn,
  standing: AnyPgColumn,
  authority: AnyPgColumn,
  restrictions: AnyPgColumn,
): SQL {
  return sql`(
    jsonb_typeof(${objective})='object'
    AND ${objective} ?& ARRAY['objective','expectedOutcome','input','targetIds','inputRefs','constraints','expectedResult','verification']
    AND ${objective} - ARRAY['objective','expectedOutcome','input','targetIds','inputRefs','constraints','expectedResult','verification']='{}'::jsonb
    AND jsonb_typeof(${objective}->'objective')='string'
    AND char_length(${objective}->>'objective') BETWEEN 1 AND 8000
    AND ${objective}->>'objective' ~ '[^[:space:]]'
    AND jsonb_typeof(${objective}->'expectedOutcome')='string'
    AND char_length(${objective}->>'expectedOutcome') BETWEEN 1 AND 4000
    AND ${objective}->>'expectedOutcome' ~ '[^[:space:]]'
    AND jsonb_typeof(${objective}->'input')='string'
    AND char_length(${objective}->>'input')<=8000
    AND jsonb_typeof(${objective}->'targetIds')='array'
    AND jsonb_typeof(${objective}->'inputRefs')='array'
    AND jsonb_typeof(${objective}->'constraints')='array'
    AND jsonb_typeof(${objective}->'expectedResult')='object'
    AND jsonb_typeof(${objective}->'verification')='array'
    AND pg_column_size(${objective})<=262144
    AND jsonb_typeof(${standing})='object' AND ${standing}->'schemaVersion' IN ('1'::jsonb,'2'::jsonb)
    AND jsonb_typeof(${standing}->'definition')='object'
    AND jsonb_typeof(${standing}->'agentId')='string'
    AND jsonb_typeof(${standing}->'packageInstallId')='string'
    AND jsonb_typeof(${standing}->'packageRevision')='string'
    AND ${standing}->>'definitionSha256' ~ '^[a-f0-9]{64}$'
    AND (CASE WHEN ${standing}->'schemaVersion'='2'::jsonb THEN
      jsonb_typeof(${standing}->'coordinatorFlow')='object'
      AND ${standing}->'coordinatorFlow' ?& ARRAY['flowId','flowRefId','flowRevisionId','resolvedRevision','manifestSha256']
      AND (${standing}->'coordinatorFlow')-ARRAY['flowId','flowRefId','flowRevisionId','resolvedRevision','manifestSha256']='{}'::jsonb
      AND jsonb_typeof(${standing}->'coordinatorFlow'->'flowId')='string'
      AND char_length(${standing}->'coordinatorFlow'->>'flowId') BETWEEN 1 AND 128
      AND jsonb_typeof(${standing}->'coordinatorFlow'->'flowRefId')='string'
      AND char_length(${standing}->'coordinatorFlow'->>'flowRefId') BETWEEN 1 AND 128
      AND jsonb_typeof(${standing}->'coordinatorFlow'->'flowRevisionId')='string'
      AND char_length(${standing}->'coordinatorFlow'->>'flowRevisionId') BETWEEN 1 AND 128
      AND jsonb_typeof(${standing}->'coordinatorFlow'->'resolvedRevision')='string'
      AND char_length(${standing}->'coordinatorFlow'->>'resolvedRevision') BETWEEN 1 AND 192
      AND ${standing}->'coordinatorFlow'->>'manifestSha256' ~ '^[a-f0-9]{64}$'
      AND ${standing}->'coordinatorFlow'->>'flowRefId'=${standing}->'definition'->>'flow'
      ELSE true END)
    AND pg_column_size(${standing})<=2097152
    AND jsonb_typeof(${authority})='object' AND ${authority}->'schemaVersion'='1'::jsonb
    AND jsonb_typeof(${authority}->'actor')='object'
    AND jsonb_typeof(${authority}->'witnesses')='array'
    AND jsonb_typeof(${authority}->'executionPolicy')='object'
    AND pg_column_size(${authority})<=262144
    AND jsonb_typeof(${restrictions})='array' AND pg_column_size(${restrictions})<=131072
  ) IS TRUE`;
}
