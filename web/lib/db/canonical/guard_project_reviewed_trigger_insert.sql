CREATE OR REPLACE FUNCTION public.guard_project_reviewed_trigger_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
    IF source.project_source_review->'schemaVersion' IS DISTINCT FROM '2'::jsonb OR NEW.trigger_source<>'domain_event' OR NEW.scheduled_request_snapshot IS NOT NULL OR NOT EXISTS(
      SELECT 1 FROM domain_events event WHERE event.id=NEW.trigger_event_id AND event.project_id=source.project_id
        AND event.company_id IS NULL AND event.id>(source.project_source_review->>'eventCursor')::bigint AND source.created_at<=event.created_at AND source.event_match->'kinds' ? event.kind) THEN
      RAISE EXCEPTION 'Reviewed project event must match its actual owned source event' USING ERRCODE='23514',CONSTRAINT='agent_trigger_project_review_reference';
    END IF;
  ELSE
    RAISE EXCEPTION 'Only cron and event sources can carry project reviews' USING ERRCODE='23514',CONSTRAINT='agent_trigger_project_review_reference';
  END IF;
  RETURN NEW;
END $function$;
