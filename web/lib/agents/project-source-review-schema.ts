import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";

/** Closed bounded JSON; no user FK may rewrite or prevent inspection of an old reviewer witness. */
export function projectSourceReviewShape(value: SQL): SQL {
  return sql`(CASE WHEN jsonb_typeof(${value})='object' AND jsonb_typeof(${value}->'sourceRevision')='number' THEN
    ${value} ?& ARRAY['schemaVersion','reviewerUserId','reviewedAt','sourceRevision','sourceSha256']
    AND ${value}-ARRAY['schemaVersion','reviewerUserId','reviewedAt','sourceRevision','sourceSha256']='{}'::jsonb
    AND ${value}->'schemaVersion'='1'::jsonb
    AND jsonb_typeof(${value}->'reviewerUserId')='string' AND char_length(${value}->>'reviewerUserId') BETWEEN 1 AND 128
    AND jsonb_typeof(${value}->'reviewedAt')='string' AND ${value}->>'reviewedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
    AND (${value}->>'sourceRevision')::numeric BETWEEN 1 AND 2147483647 AND mod((${value}->>'sourceRevision')::numeric,1)=0
    AND jsonb_typeof(${value}->'sourceSha256')='string' AND ${value}->>'sourceSha256' ~ '^[a-f0-9]{64}$'
    AND pg_column_size(${value})<=2048
    ELSE false END) IS TRUE`;
}
