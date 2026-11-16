CREATE OR REPLACE FUNCTION public.brain_check_current_revision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE consistent boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM brain_items WHERE id=NEW.id) THEN RETURN NULL; END IF;
  SELECT (i.title=r.title AND i.content=r.assertion AND i.kind=r.kind AND i.source_restrictions IS NOT DISTINCT FROM r.source_restrictions) INTO consistent
  FROM brain_items i JOIN brain_record_revisions r ON r.record_id=i.id AND r.revision=i.current_revision
  WHERE i.id=NEW.id;
  IF consistent IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Knowledge head must match its immutable revision' USING ERRCODE='23514', CONSTRAINT='brain_record_head_matches_revision';
  END IF;
  IF EXISTS (SELECT 1 FROM brain_items i JOIN brain_record_grants g ON g.record_id=i.id WHERE i.id=NEW.id AND i.visibility='owner_grants' AND g.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Narrower record grants require a restricted projection' USING ERRCODE='23514', CONSTRAINT='brain_record_grants_require_restriction';
  END IF;
  RETURN NULL;
END $function$;
