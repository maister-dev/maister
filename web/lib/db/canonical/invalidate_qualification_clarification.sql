CREATE OR REPLACE FUNCTION public.invalidate_qualification_clarification()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT NEW.blocking THEN RETURN NEW; END IF;
  ELSIF ROW(NEW.blocking,NEW.status,NEW.answer,NEW.answered_at,NEW.superseded_at) IS NOT DISTINCT FROM ROW(OLD.blocking,OLD.status,OLD.answer,OLD.answered_at,OLD.superseded_at) OR NOT (NEW.blocking OR OLD.blocking) THEN RETURN NEW;
  END IF;
  UPDATE tasks SET qualification_input_revision=qualification_input_revision+1 WHERE id=NEW.task_id AND qualification_mode<>'legacy';
  RETURN NEW;
END $function$;
