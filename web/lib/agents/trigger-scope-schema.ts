import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { sql } from "drizzle-orm";

function configurationReferenceShape(value: SQL): SQL {
  return sql`(CASE WHEN jsonb_typeof(${value})='object' AND jsonb_typeof(${value}->'revision')='number' THEN
    ${value} ?& ARRAY['id','revision','snapshotSha256']
    AND ${value}-ARRAY['id','revision','snapshotSha256']='{}'::jsonb
    AND jsonb_typeof(${value}->'id')='string' AND char_length(${value}->>'id') BETWEEN 1 AND 128
    AND (${value}->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((${value}->>'revision')::numeric,1)=0
    AND jsonb_typeof(${value}->'snapshotSha256')='string' AND ${value}->>'snapshotSha256' ~ '^[a-f0-9]{64}$'
    ELSE false END) IS TRUE`;
}

/** Project v1 bytes keep their existing admission shape; company v2 cannot masquerade as a project. */
export function triggerBindingScopeShape(
  snapshot: AnyPgColumn,
  projectId: AnyPgColumn,
  companyId: AnyPgColumn,
): SQL {
  const specialist = sql`(${snapshot}->'specialistBinding')`;
  const coordinator = sql`(${snapshot}->'coordinatorFlowBinding')`;

  return sql`((${projectId} IS NOT NULL AND ${companyId} IS NULL AND ${snapshot}->'version'='1'::jsonb)
    OR (${projectId} IS NULL AND ${companyId} IS NOT NULL AND CASE WHEN jsonb_typeof(${snapshot})='object' AND jsonb_typeof(${snapshot}->'sourceRevision')='number' THEN
      ${snapshot}->'version'='2'::jsonb
      AND ${snapshot} ?& ARRAY['version','scheduleId','triggerType','cronExpr','timezone','eventKinds','owner','sourceRevision','specialistBinding','coordinatorFlowBinding']
      AND ${snapshot}-ARRAY['version','scheduleId','triggerType','cronExpr','timezone','eventKinds','owner','sourceRevision','specialistBinding','coordinatorFlowBinding']='{}'::jsonb
      AND ${snapshot}->'owner'=jsonb_build_object('kind','company','companyId',${companyId})
      AND ${snapshot}->>'triggerType' IN ('cron','event')
      AND (${snapshot}->>'sourceRevision')::numeric BETWEEN 1 AND 2147483647 AND mod((${snapshot}->>'sourceRevision')::numeric,1)=0
      AND ${configurationReferenceShape(specialist)}
      AND (${coordinator}='null'::jsonb OR ${configurationReferenceShape(coordinator)})
      AND jsonb_typeof(${snapshot}->'eventKinds')='array'
      AND pg_column_size(${snapshot})<=8192
      ELSE false END)) IS TRUE`;
}
