ALTER TABLE "agent_trigger_attempts" DROP CONSTRAINT "agent_trigger_attempt_shape_check";--> statement-breakpoint
ALTER TABLE "agent_trigger_attempts" ADD CONSTRAINT "agent_trigger_attempt_shape_check" CHECK (("agent_trigger_attempts"."fence" > 0 AND "agent_trigger_attempts"."trigger_source" IN ('cron','domain_event') AND "agent_trigger_attempts"."provenance" IN ('claim','legacy_latest') AND jsonb_typeof("agent_trigger_attempts"."binding_snapshot") = 'object' AND (("agent_trigger_attempts"."project_id" IS NOT NULL AND "agent_trigger_attempts"."company_id" IS NULL AND ("agent_trigger_attempts"."binding_snapshot"->'version'='1'::jsonb OR (
      "agent_trigger_attempts"."binding_snapshot"->'version'='3'::jsonb
      AND "agent_trigger_attempts"."binding_snapshot" ?& ARRAY['version','scheduleId','triggerType','cronExpr','timezone','eventKinds','owner','review']
      AND "agent_trigger_attempts"."binding_snapshot"-ARRAY['version','scheduleId','triggerType','cronExpr','timezone','eventKinds','owner','review']='{}'::jsonb
      AND "agent_trigger_attempts"."binding_snapshot"->'owner'=jsonb_build_object('kind','project','projectId',"agent_trigger_attempts"."project_id")
      AND "agent_trigger_attempts"."binding_snapshot"->>'triggerType' IN ('cron','event')
      AND (CASE WHEN jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'review'))='object' AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'review')->'sourceRevision')='number' THEN
    ("agent_trigger_attempts"."binding_snapshot"->'review') ?& ARRAY['schemaVersion','reviewerUserId','reviewedAt','sourceRevision','sourceSha256']
    AND ("agent_trigger_attempts"."binding_snapshot"->'review')-ARRAY['schemaVersion','reviewerUserId','reviewedAt','sourceRevision','sourceSha256']='{}'::jsonb
    AND ("agent_trigger_attempts"."binding_snapshot"->'review')->'schemaVersion'='1'::jsonb
    AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'review')->'reviewerUserId')='string' AND char_length(("agent_trigger_attempts"."binding_snapshot"->'review')->>'reviewerUserId') BETWEEN 1 AND 128
    AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'review')->'reviewedAt')='string' AND ("agent_trigger_attempts"."binding_snapshot"->'review')->>'reviewedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
    AND (("agent_trigger_attempts"."binding_snapshot"->'review')->>'sourceRevision')::numeric BETWEEN 1 AND 2147483647 AND mod((("agent_trigger_attempts"."binding_snapshot"->'review')->>'sourceRevision')::numeric,1)=0
    AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'review')->'sourceSha256')='string' AND ("agent_trigger_attempts"."binding_snapshot"->'review')->>'sourceSha256' ~ '^[a-f0-9]{64}$'
    AND pg_column_size(("agent_trigger_attempts"."binding_snapshot"->'review'))<=2048
    ELSE false END) IS TRUE
      AND jsonb_typeof("agent_trigger_attempts"."binding_snapshot"->'eventKinds')='array'
      AND pg_column_size("agent_trigger_attempts"."binding_snapshot")<=8192)))
    OR ("agent_trigger_attempts"."project_id" IS NULL AND "agent_trigger_attempts"."company_id" IS NOT NULL AND CASE WHEN jsonb_typeof("agent_trigger_attempts"."binding_snapshot")='object' AND jsonb_typeof("agent_trigger_attempts"."binding_snapshot"->'sourceRevision')='number' THEN
      "agent_trigger_attempts"."binding_snapshot"->'version'='2'::jsonb
      AND "agent_trigger_attempts"."binding_snapshot" ?& ARRAY['version','scheduleId','triggerType','cronExpr','timezone','eventKinds','owner','sourceRevision','specialistBinding','coordinatorFlowBinding']
      AND "agent_trigger_attempts"."binding_snapshot"-ARRAY['version','scheduleId','triggerType','cronExpr','timezone','eventKinds','owner','sourceRevision','specialistBinding','coordinatorFlowBinding']='{}'::jsonb
      AND "agent_trigger_attempts"."binding_snapshot"->'owner'=jsonb_build_object('kind','company','companyId',"agent_trigger_attempts"."company_id")
      AND "agent_trigger_attempts"."binding_snapshot"->>'triggerType' IN ('cron','event')
      AND ("agent_trigger_attempts"."binding_snapshot"->>'sourceRevision')::numeric BETWEEN 1 AND 2147483647 AND mod(("agent_trigger_attempts"."binding_snapshot"->>'sourceRevision')::numeric,1)=0
      AND (CASE WHEN jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'specialistBinding'))='object' AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')->'revision')='number' THEN
    ("agent_trigger_attempts"."binding_snapshot"->'specialistBinding') ?& ARRAY['id','revision','snapshotSha256']
    AND ("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')-ARRAY['id','revision','snapshotSha256']='{}'::jsonb
    AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')->'id')='string' AND char_length(("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')->>'id') BETWEEN 1 AND 128
    AND (("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')->>'revision')::numeric,1)=0
    AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')->'snapshotSha256')='string' AND ("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')->>'snapshotSha256' ~ '^[a-f0-9]{64}$'
    ELSE false END) IS TRUE
      AND (("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')='null'::jsonb OR (CASE WHEN jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding'))='object' AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')->'revision')='number' THEN
    ("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding') ?& ARRAY['id','revision','snapshotSha256']
    AND ("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')-ARRAY['id','revision','snapshotSha256']='{}'::jsonb
    AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')->'id')='string' AND char_length(("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')->>'id') BETWEEN 1 AND 128
    AND (("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')->>'revision')::numeric,1)=0
    AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')->'snapshotSha256')='string' AND ("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')->>'snapshotSha256' ~ '^[a-f0-9]{64}$'
    ELSE false END) IS TRUE)
      AND jsonb_typeof("agent_trigger_attempts"."binding_snapshot"->'eventKinds')='array'
      AND pg_column_size("agent_trigger_attempts"."binding_snapshot")<=8192
      ELSE false END)) IS TRUE AND "agent_trigger_attempts"."binding_snapshot"->>'scheduleId' = "agent_trigger_attempts"."schedule_id" AND (("agent_trigger_attempts"."settled_at" IS NULL AND "agent_trigger_attempts"."outcome" IS NULL) OR ("agent_trigger_attempts"."settled_at" IS NOT NULL AND "agent_trigger_attempts"."outcome" IN ('launched','queued','refused','deduplicated','suppressed','failed','unknown'))) AND ("agent_trigger_attempts"."run_id" IS NULL OR "agent_trigger_attempts"."original_run_id" = "agent_trigger_attempts"."run_id")) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION guard_project_reviewed_trigger_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source agent_schedules%ROWTYPE;
BEGIN
  IF NEW.project_id IS NULL OR NEW.company_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT * INTO source FROM agent_schedules WHERE id=NEW.schedule_id FOR SHARE;
  IF NEW.binding_snapshot->'version' IS DISTINCT FROM '3'::jsonb THEN
    IF FOUND AND source.project_source_review IS NOT NULL THEN
      RAISE EXCEPTION 'Reviewed project sources require a version-three invocation' USING ERRCODE='23514',CONSTRAINT='agent_trigger_project_review_reference';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT FOUND OR NEW.provenance<>'claim' OR source.project_id IS NULL OR source.company_id IS NOT NULL
    OR source.project_id IS DISTINCT FROM NEW.project_id OR NEW.company_id IS NOT NULL
    OR source.agent_id IS DISTINCT FROM NEW.source_agent_id OR source.project_source_review IS NULL
    OR NEW.fence IS DISTINCT FROM source.last_attempt_fence
    OR NEW.binding_snapshot->'review' IS DISTINCT FROM source.project_source_review
    OR NEW.binding_snapshot->>'triggerType' IS DISTINCT FROM source.trigger_type
    OR NEW.binding_snapshot->>'cronExpr' IS DISTINCT FROM source.cron_expr
    OR NEW.binding_snapshot->>'timezone' IS DISTINCT FROM source.timezone
    OR NEW.binding_snapshot->'eventKinds' IS DISTINCT FROM COALESCE(source.event_match->'kinds','[]'::jsonb)
    OR NOT source.enabled THEN
    RAISE EXCEPTION 'Reviewed project invocation must match its actual source and review' USING ERRCODE='23514',CONSTRAINT='agent_trigger_project_review_reference';
  END IF;
  IF source.trigger_type='cron' THEN
    IF NEW.trigger_source<>'cron' OR NEW.trigger_event_id IS NOT NULL OR
      NEW.scheduled_request_snapshot IS DISTINCT FROM jsonb_build_object(
        'version',1,'scheduleId',source.id,'triggerAttemptId',NEW.id,'requestAtLaunch',source.request_at_launch) THEN
      RAISE EXCEPTION 'Reviewed project cron must retain its exact recurring request' USING ERRCODE='23514',CONSTRAINT='agent_trigger_project_review_reference';
    END IF;
  ELSIF source.trigger_type='event' THEN
    IF NEW.trigger_source<>'domain_event' OR NEW.scheduled_request_snapshot IS NOT NULL OR NOT EXISTS(
      SELECT 1 FROM domain_events event WHERE event.id=NEW.trigger_event_id AND event.project_id=source.project_id
        AND event.company_id IS NULL AND source.created_at<=event.occurred_at AND source.event_match->'kinds' ? event.kind) THEN
      RAISE EXCEPTION 'Reviewed project event must match its actual owned source event' USING ERRCODE='23514',CONSTRAINT='agent_trigger_project_review_reference';
    END IF;
  ELSE
    RAISE EXCEPTION 'Only cron and event sources can carry project reviews' USING ERRCODE='23514',CONSTRAINT='agent_trigger_project_review_reference';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_trigger_project_review_reference BEFORE INSERT ON agent_trigger_attempts
FOR EACH ROW EXECUTE FUNCTION guard_project_reviewed_trigger_insert();
