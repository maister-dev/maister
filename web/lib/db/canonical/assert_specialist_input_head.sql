CREATE OR REPLACE FUNCTION public.assert_specialist_input_head()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS(SELECT 1 FROM specialist_assignments WHERE id=NEW.id)
    AND NOT EXISTS(SELECT 1 FROM specialist_input_revisions WHERE assignment_id=NEW.id AND revision=NEW.input_revision) THEN
    RAISE EXCEPTION 'An assignment head must reference its retained input revision'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_input_head';
  END IF;
  RETURN NULL;
END;
$function$;
