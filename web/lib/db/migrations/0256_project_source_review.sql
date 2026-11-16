ALTER TABLE "agent_schedules" ADD COLUMN "project_source_review" jsonb;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_project_review_check" CHECK (("agent_schedules"."project_source_review" IS NULL OR ("agent_schedules"."project_id" IS NOT NULL AND "agent_schedules"."company_id" IS NULL AND "agent_schedules"."trigger_type" IN ('cron','event') AND (CASE WHEN jsonb_typeof("agent_schedules"."project_source_review")='object' AND jsonb_typeof("agent_schedules"."project_source_review"->'sourceRevision')='number' THEN
    "agent_schedules"."project_source_review" ?& ARRAY['schemaVersion','reviewerUserId','reviewedAt','sourceRevision','sourceSha256']
    AND "agent_schedules"."project_source_review"-ARRAY['schemaVersion','reviewerUserId','reviewedAt','sourceRevision','sourceSha256']='{}'::jsonb
    AND "agent_schedules"."project_source_review"->'schemaVersion'='1'::jsonb
    AND jsonb_typeof("agent_schedules"."project_source_review"->'reviewerUserId')='string' AND char_length("agent_schedules"."project_source_review"->>'reviewerUserId') BETWEEN 1 AND 128
    AND jsonb_typeof("agent_schedules"."project_source_review"->'reviewedAt')='string' AND "agent_schedules"."project_source_review"->>'reviewedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
    AND ("agent_schedules"."project_source_review"->>'sourceRevision')::numeric BETWEEN 1 AND 2147483647 AND mod(("agent_schedules"."project_source_review"->>'sourceRevision')::numeric,1)=0
    AND jsonb_typeof("agent_schedules"."project_source_review"->'sourceSha256')='string' AND "agent_schedules"."project_source_review"->>'sourceSha256' ~ '^[a-f0-9]{64}$'
    AND pg_column_size("agent_schedules"."project_source_review")<=2048
    ELSE false END) IS TRUE)) IS TRUE);