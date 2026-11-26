CREATE FUNCTION public.maister_flow_question_prompt_hint() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  run_key text;
BEGIN
  IF TG_TABLE_NAME = 'project_tokens' THEN
    run_key := NEW.bound_run_id;
  ELSE
    run_key := NEW.run_id;
  END IF;

  PERFORM pg_notify('maister_flow_question_prompt', jsonb_build_object(
    'source', TG_TABLE_NAME, 'runId', run_key, 'id', NEW.id
  )::text);
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER flow_question_command_hint
AFTER UPDATE OF state, completed_at, retired_at, application_state, application_error ON public.execution_commands
FOR EACH ROW WHEN (
  NEW.kind = 'session.prompt' AND NEW.owner_kind = 'flow_node_attempt'
  AND OLD.state IN ('delivering', 'accepted')
  AND (OLD.state IS DISTINCT FROM NEW.state
    OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
    OR OLD.retired_at IS DISTINCT FROM NEW.retired_at
    OR OLD.application_state IS DISTINCT FROM NEW.application_state
    OR OLD.application_error IS DISTINCT FROM NEW.application_error)
) EXECUTE FUNCTION public.maister_flow_question_prompt_hint();
--> statement-breakpoint
CREATE TRIGGER flow_question_incarnation_hint
AFTER UPDATE OF state, ended_at ON public.run_session_incarnations
FOR EACH ROW WHEN (
  OLD.state IN ('created', 'active')
  AND (OLD.state IS DISTINCT FROM NEW.state OR OLD.ended_at IS DISTINCT FROM NEW.ended_at)
) EXECUTE FUNCTION public.maister_flow_question_prompt_hint();
--> statement-breakpoint
CREATE TRIGGER flow_question_token_hint
AFTER UPDATE OF revoked_at ON public.project_tokens
FOR EACH ROW WHEN (
  NEW.bound_run_id IS NOT NULL AND NEW.origin_kind = 'orchestrator_run'
  AND NEW.scopes ? 'hitl:request'
  AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
) EXECUTE FUNCTION public.maister_flow_question_prompt_hint();
