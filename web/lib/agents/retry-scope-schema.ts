import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";

import { configurationReferenceShape } from "./trigger-scope-schema";

/** Existing v1/v2 project shapes remain unchanged; the company v3 branch is exclusive and closed. */
export function agentRetryRecipeScopeShape(
  recipe: AnyPgColumn,
  projectId: AnyPgColumn,
  companyId: AnyPgColumn,
  agentId: AnyPgColumn,
  requestDigest: AnyPgColumn,
  previewFingerprint: AnyPgColumn,
): SQL {
  const specialist = sql`(${recipe}->'specialistBinding')`;
  const coordinator = sql`(${recipe}->'coordinatorFlowBinding')`;
  const assignment = sql`(${recipe}->'assignment')`;

  return sql`(jsonb_typeof(${recipe})='object'
    AND ${recipe}->>'agentId'=${agentId}
    AND ${requestDigest} ~ '^[a-f0-9]{64}$' AND ${previewFingerprint} ~ '^[a-f0-9]{64}$'
    AND pg_column_size(${recipe})<=1048576
    AND ((${projectId} IS NOT NULL AND ${companyId} IS NULL
      AND ${recipe}->'version' IN ('1'::jsonb,'2'::jsonb)
      AND (${recipe}->'version'='1'::jsonb OR ${recipe}->>'strategy' IN ('pre_work_retry','fresh_qualification'))
      AND ${recipe}->>'projectId'=${projectId})
    OR (${projectId} IS NULL AND ${companyId} IS NOT NULL
      AND ${recipe}->'version'='3'::jsonb AND ${recipe}->>'strategy'='pre_work_retry'
      AND ${recipe}->'owner'=jsonb_build_object('kind','company','companyId',${companyId})
      AND ${recipe} ?& ARRAY['version','strategy','owner','projectId','taskId','taskRevision','project','agentId','definition','configuration','trigger','runner','policy','contextDigest','specialistBinding','coordinatorFlowBinding','assignment']
      AND ${recipe}-ARRAY['version','strategy','owner','projectId','taskId','taskRevision','project','agentId','definition','configuration','trigger','runner','policy','contextDigest','specialistBinding','coordinatorFlowBinding','assignment','scheduledRequestSnapshot']='{}'::jsonb
      AND ${recipe}->'projectId'='null'::jsonb AND ${recipe}->'project'='null'::jsonb
      AND ${recipe}->'taskId'='null'::jsonb AND ${recipe}->'taskRevision'='null'::jsonb
      AND ${recipe}->>'contextDigest' ~ '^[a-f0-9]{64}$'
      AND ${configurationReferenceShape(specialist)}
      AND (${coordinator}='null'::jsonb OR ${configurationReferenceShape(coordinator)})
      AND CASE WHEN jsonb_typeof(${assignment})='object' AND jsonb_typeof(${assignment}->'inputRevision')='number' THEN
        ${assignment} ?& ARRAY['id','inputRevision','inputSha256']
        AND ${assignment}-ARRAY['id','inputRevision','inputSha256']='{}'::jsonb
        AND jsonb_typeof(${assignment}->'id')='string' AND char_length(${assignment}->>'id') BETWEEN 1 AND 128
        AND (${assignment}->>'inputRevision')::numeric BETWEEN 1 AND 2147483647 AND mod((${assignment}->>'inputRevision')::numeric,1)=0
        AND ${assignment}->>'inputSha256' ~ '^[a-f0-9]{64}$'
        ELSE false END))) IS TRUE`;
}
