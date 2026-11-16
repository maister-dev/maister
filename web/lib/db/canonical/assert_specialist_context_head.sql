CREATE OR REPLACE FUNCTION public.assert_specialist_context_head()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE assignment_key text;
DECLARE current_revision integer;
DECLARE latest_revision integer;
BEGIN
  IF TG_TABLE_NAME='specialist_assignments' THEN assignment_key:=NEW.id;
  ELSE assignment_key:=NEW.assignment_id; END IF;
  SELECT context_revision INTO current_revision FROM specialist_assignments WHERE id=assignment_key;
  SELECT max(revision) INTO latest_revision FROM specialist_context_revisions WHERE assignment_id=assignment_key;
  IF current_revision IS NULL OR current_revision<>COALESCE(latest_revision,0) THEN
    RAISE EXCEPTION 'A context head must reference its exact latest immutable revision in the same transaction'
      USING ERRCODE='23514',CONSTRAINT='specialist_context_head_reference';
  END IF;
  RETURN NULL;
END $function$;
