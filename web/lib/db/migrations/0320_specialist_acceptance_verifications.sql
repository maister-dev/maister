ALTER TABLE "specialist_acceptances" DROP CONSTRAINT "specialist_acceptances_shape_check";--> statement-breakpoint
ALTER TABLE "specialist_acceptances" ADD CONSTRAINT "specialist_acceptances_shape_check" CHECK ((
        "specialist_acceptances"."expected_revision">0 AND "specialist_acceptances"."input_revision">0 AND "specialist_acceptances"."context_revision">=0 AND "specialist_acceptances"."result_revision">0
        AND (CASE WHEN jsonb_typeof("specialist_acceptances"."actor")='object' THEN
    "specialist_acceptances"."actor" ?& ARRAY['kind','id','runId','attemptId']
    AND "specialist_acceptances"."actor" - ARRAY['kind','id','runId','attemptId']='{}'::jsonb
    AND "specialist_acceptances"."actor"->>'kind' IN ('user','agent','system')
    AND jsonb_typeof("specialist_acceptances"."actor"->'id')='string'
    AND char_length("specialist_acceptances"."actor"->>'id') BETWEEN 1 AND 192
    AND ("specialist_acceptances"."actor"->'runId'='null'::jsonb OR (jsonb_typeof("specialist_acceptances"."actor"->'runId')='string' AND char_length("specialist_acceptances"."actor"->>'runId') BETWEEN 1 AND 128))
    AND ("specialist_acceptances"."actor"->'attemptId'='null'::jsonb OR (jsonb_typeof("specialist_acceptances"."actor"->'attemptId')='string' AND char_length("specialist_acceptances"."actor"->>'attemptId') BETWEEN 1 AND 128))
    ELSE false END) IS TRUE AND "specialist_acceptances"."actor"->>'kind'='user'
        AND "specialist_acceptances"."actor"->'runId'='null'::jsonb AND "specialist_acceptances"."actor"->'attemptId'='null'::jsonb
        AND "specialist_acceptances"."authority_snapshot"->'schemaVersion'='1'::jsonb AND "specialist_acceptances"."authority_snapshot"->'actor'="specialist_acceptances"."actor"
        AND pg_column_size("specialist_acceptances"."authority_snapshot")<=32768
        AND (CASE WHEN jsonb_typeof("specialist_acceptances"."verification_ids")='array' THEN jsonb_array_length("specialist_acceptances"."verification_ids")<=16 ELSE false END)
        AND "specialist_acceptances"."request_key" ~ '^[A-Za-z0-9._:-]{8,128}$' AND "specialist_acceptances"."request_sha256" ~ '^[a-f0-9]{64}$'
        AND char_length("specialist_acceptances"."reason") BETWEEN 1 AND 2000
      ) IS TRUE);