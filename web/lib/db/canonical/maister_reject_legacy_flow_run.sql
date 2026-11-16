CREATE OR REPLACE FUNCTION public.maister_reject_legacy_flow_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.run_kind <> 'flow' THEN
    RETURN NEW;
  END IF;

  IF NEW.flow_revision_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM flow_revisions fr
    WHERE fr.id = NEW.flow_revision_id
      AND fr.manifest ? 'steps'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '0094 graph-only cut-over rejected a legacy steps[] Flow run';
  END IF;

  IF NEW.flow_revision_id IS NULL AND NEW.flow_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM flows f
    WHERE f.id = NEW.flow_id
      AND f.manifest ? 'steps'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '0094 graph-only cut-over rejected a legacy steps[] Flow run';
  END IF;

  RETURN NEW;
END;
$function$;
