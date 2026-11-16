CREATE OR REPLACE FUNCTION public.guard_agent_turn_user_source()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.requested_by_user_id IS NOT NULL
    AND NEW.variant NOT IN ('live_message', 'persistent_message', 'steer') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_user_source_check',
      MESSAGE = 'a user-sourced agent turn must be a message or steer';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_user_source_immutable',
      MESSAGE = 'an accepted agent turn user source is immutable';
  END IF;
  RETURN NEW;
END $function$;
