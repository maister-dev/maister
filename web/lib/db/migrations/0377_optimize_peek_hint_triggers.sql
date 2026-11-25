-- Replace to_jsonb() hot-path peek triggers on execution_events and run_messages
-- with direct column comparisons while preserving exact 0212 notification payloads
-- and all 7 trigger names asserted by web/lib/runs/peek-wake.ts.
CREATE OR REPLACE FUNCTION public.maister_execution_events_peek_hint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ingest_disposition IS DISTINCT FROM 'accepted' OR NEW.run_sequence IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE'
    AND OLD.ingest_disposition = 'accepted'
    AND OLD.run_sequence IS NOT DISTINCT FROM NEW.run_sequence
    AND OLD.run_id IS NOT DISTINCT FROM NEW.run_id
  THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify(
    'maister_run_peek',
    jsonb_build_object(
      'source', 'execution_events',
      'topic', 'execution',
      'runId', NEW.run_id,
      'parentRunId', NULL,
      'previousParentRunId', NULL,
      'rootRunId', NULL
    )::text
  );
  IF TG_OP = 'UPDATE' AND OLD.run_id IS NOT NULL AND OLD.run_id IS DISTINCT FROM NEW.run_id THEN
    PERFORM pg_notify(
      'maister_run_peek',
      jsonb_build_object(
        'source', 'execution_events',
        'topic', 'execution',
        'runId', OLD.run_id,
        'parentRunId', NULL,
        'previousParentRunId', NULL,
        'rootRunId', NULL
      )::text
    );
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS execution_events_peek_hint ON public.execution_events;
--> statement-breakpoint
CREATE TRIGGER execution_events_peek_hint
  AFTER INSERT OR UPDATE ON public.execution_events
  FOR EACH ROW
  WHEN (NEW.ingest_disposition = 'accepted' AND NEW.run_sequence IS NOT NULL)
  EXECUTE FUNCTION public.maister_execution_events_peek_hint();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.maister_run_messages_peek_hint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_run_id text;
  previous_run_id text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT (
      OLD.run_id IS DISTINCT FROM NEW.run_id
      OR OLD.node_attempt_id IS DISTINCT FROM NEW.node_attempt_id
      OR OLD.sequence IS DISTINCT FROM NEW.sequence
      OR OLD.role IS DISTINCT FROM NEW.role
      OR OLD.content IS DISTINCT FROM NEW.content
      OR OLD.supervisor_event_id IS DISTINCT FROM NEW.supervisor_event_id
      OR OLD.prompt_dispatch_key IS DISTINCT FROM NEW.prompt_dispatch_key
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
    ) THEN
      RETURN NULL;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    target_run_id := OLD.run_id;
  ELSE
    target_run_id := NEW.run_id;
    IF TG_OP = 'UPDATE' THEN
      previous_run_id := OLD.run_id;
    END IF;
  END IF;
  PERFORM pg_notify(
    'maister_run_peek',
    jsonb_build_object(
      'source', 'run_messages',
      'topic', 'transcript',
      'runId', target_run_id,
      'parentRunId', NULL,
      'previousParentRunId', NULL,
      'rootRunId', NULL
    )::text
  );
  IF previous_run_id IS NOT NULL AND previous_run_id IS DISTINCT FROM target_run_id THEN
    PERFORM pg_notify(
      'maister_run_peek',
      jsonb_build_object(
        'source', 'run_messages',
        'topic', 'transcript',
        'runId', previous_run_id,
        'parentRunId', NULL,
        'previousParentRunId', NULL,
        'rootRunId', NULL
      )::text
    );
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS run_messages_peek_hint ON public.run_messages;
--> statement-breakpoint
CREATE TRIGGER run_messages_peek_hint
  AFTER INSERT OR UPDATE OR DELETE ON public.run_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.maister_run_messages_peek_hint();
