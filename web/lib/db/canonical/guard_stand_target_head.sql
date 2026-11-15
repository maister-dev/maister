CREATE OR REPLACE FUNCTION public.guard_stand_target_head()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Disable the stand without deleting its retained identity' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.config_revision<>1 THEN
      RAISE EXCEPTION 'Stand configuration begins at revision one' USING ERRCODE='23514';
    END IF;
  ELSIF (NEW.id,NEW.company_id,NEW.incarnation_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.company_id,OLD.incarnation_id,OLD.created_at)
     OR NEW.config_revision<>OLD.config_revision+1 THEN
    RAISE EXCEPTION 'Stand identity is immutable and configuration revisions advance once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
