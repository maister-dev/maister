CREATE OR REPLACE FUNCTION public.guard_company_flow_binding_head()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Retire company Flow bindings without deleting accepted history' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.detached_at IS NOT NULL THEN
      RAISE EXCEPTION 'Company Flow bindings begin at live configuration revision one' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.company_id,NEW.flow_ref_id,NEW.created_by,NEW.creation_key,NEW.creation_digest,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.company_id,OLD.flow_ref_id,OLD.created_by,OLD.creation_key,OLD.creation_digest,OLD.created_at)
    OR NEW.revision<>OLD.revision+1 OR OLD.detached_at IS NOT NULL THEN
    RAISE EXCEPTION 'Company Flow identity is immutable and revisions advance once before retirement' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
