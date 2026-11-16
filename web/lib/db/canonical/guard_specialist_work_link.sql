CREATE OR REPLACE FUNCTION public.guard_specialist_work_link()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='UPDATE' AND NEW.work_witness IS DISTINCT FROM OLD.work_witness THEN
    RAISE EXCEPTION 'A historical work label cannot acquire native appointment authority'
      USING ERRCODE='23514',CONSTRAINT='specialist_run_links_work_witness_immutable';
  END IF;
  IF NEW.work_witness IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM specialist_work work JOIN runs child ON child.id=NEW.run_id
    WHERE work.id=NEW.work_id AND work.work_revision=NEW.work_revision AND work.assignment_id=NEW.assignment_id AND work.input_revision=NEW.input_revision
      AND work.reserved_run_id=NEW.run_id AND (work.child_run_id IS NULL OR work.child_run_id=NEW.run_id)
      AND child.parent_run_id=work.parent_run_id AND NEW.role IN ('child','continuation')
      AND NEW.work_witness=jsonb_build_object('schemaVersion',1,'id',work.id,'workRevision',work.work_revision,'definitionSha256',work.definition_sha256)
  ) THEN
    RAISE EXCEPTION 'Native child appointment must name its exact retained work and reserved execution'
      USING ERRCODE='23514',CONSTRAINT='specialist_run_links_work_binding';
  END IF;
  RETURN NEW;
END;
$function$;
