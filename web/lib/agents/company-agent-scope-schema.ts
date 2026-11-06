import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { sql } from "drizzle-orm";

import { configurationReferenceShape } from "./trigger-scope-schema";

/** Legacy owner bytes remain unknown; new company agent receipts cannot carry repository ownership. */
export function companyAgentSnapshotShape(
  snapshot: AnyPgColumn,
  companyId: AnyPgColumn,
): SQL {
  const assignment = sql`(${snapshot}->'assignment')`;
  const authority = sql`(${snapshot}->'authority')`;
  const actor = sql`(${snapshot}->'authority'->'actor')`;
  const witness = sql`(${snapshot}->'authority'->'witness')`;

  return sql`(jsonb_typeof(${snapshot})='object' AND ${snapshot}->'schemaVersion'='1'::jsonb
    AND ${snapshot} ?& ARRAY['schemaVersion','owner','assignmentRevision','assignment','specialistBinding','authority']
    AND ${snapshot}-ARRAY['schemaVersion','owner','assignmentRevision','assignment','specialistBinding','authority']='{}'::jsonb
    AND ${snapshot}->'owner'=jsonb_build_object('kind','company','companyId',${companyId})
    AND CASE WHEN jsonb_typeof(${snapshot}->'assignmentRevision')='number' AND jsonb_typeof(${assignment}->'inputRevision')='number' THEN
      (${snapshot}->>'assignmentRevision')::numeric BETWEEN 1 AND 2147483647 AND mod((${snapshot}->>'assignmentRevision')::numeric,1)=0
      AND ${assignment} ?& ARRAY['id','inputRevision','inputSha256']
      AND ${assignment}-ARRAY['id','inputRevision','inputSha256']='{}'::jsonb
      AND jsonb_typeof(${assignment}->'id')='string' AND char_length(${assignment}->>'id') BETWEEN 1 AND 128
      AND (${assignment}->>'inputRevision')::numeric BETWEEN 1 AND 2147483647 AND mod((${assignment}->>'inputRevision')::numeric,1)=0
      AND ${assignment}->>'inputSha256' ~ '^[a-f0-9]{64}$'
      ELSE false END
    AND ${configurationReferenceShape(sql`(${snapshot}->'specialistBinding')`)}
    AND ${authority} ?& ARRAY['actor','witness'] AND ${authority}-ARRAY['actor','witness']='{}'::jsonb
    AND ${actor} ?& ARRAY['kind','id','runId','attemptId'] AND ${actor}-ARRAY['kind','id','runId','attemptId']='{}'::jsonb
    AND ${actor}->>'kind'='user' AND jsonb_typeof(${actor}->'id')='string' AND char_length(${actor}->>'id') BETWEEN 1 AND 192
    AND ${actor}->'runId'='null'::jsonb AND ${actor}->'attemptId'='null'::jsonb
    AND ${witness} ?& ARRAY['kind','owner','authorityId','revision','action'] AND ${witness}-ARRAY['kind','owner','authorityId','revision','action']='{}'::jsonb
    AND ${witness}->>'kind'='company_grant' AND ${witness}->'owner'=${snapshot}->'owner' AND ${witness}->>'action'='assignments:update'
    AND jsonb_typeof(${witness}->'authorityId')='string' AND char_length(${witness}->>'authorityId') BETWEEN 1 AND 128
    AND CASE WHEN jsonb_typeof(${witness}->'revision')='number' THEN (${witness}->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((${witness}->>'revision')::numeric,1)=0 ELSE false END
    AND pg_column_size(${snapshot})<=32768) IS TRUE`;
}
