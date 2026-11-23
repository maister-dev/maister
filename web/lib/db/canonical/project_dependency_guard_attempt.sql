CREATE OR REPLACE FUNCTION public.project_dependency_guard_attempt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM id FROM project_dependency_declarations
      WHERE id = NEW.declaration_id AND project_id = NEW.project_id AND generation = NEW.generation AND desired = NEW.desired
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Dependency attempt does not match its current declaration' USING ERRCODE = '23514';
    END IF;
  ELSIF ROW(NEW.id,NEW.project_id,NEW.declaration_id,NEW.generation,NEW.attempt_no,NEW.desired,NEW.actor_user_id,NEW.retry_of_attempt_id,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.declaration_id,OLD.generation,OLD.attempt_no,OLD.desired,OLD.actor_user_id,OLD.retry_of_attempt_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Dependency attempt authorization and input are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
