CREATE OR REPLACE FUNCTION public.check_specialist_work_enrollment()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  work specialist_work%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='specialist_work' THEN
    SELECT * INTO work FROM specialist_work WHERE id=NEW.id AND work_revision=NEW.work_revision;
  ELSE
    IF NEW.work_witness IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO work FROM specialist_work WHERE id=NEW.work_id AND work_revision=NEW.work_revision;
  END IF;
  IF work.id IS NULL OR NOT EXISTS (
    SELECT 1 FROM specialist_intake_receipts receipt WHERE receipt.work_id=work.id AND receipt.work_revision=work.work_revision
      AND receipt.assignment_id=work.assignment_id AND receipt.input_revision=work.input_revision AND receipt.disposition='delegated'
      AND receipt.source_kind='delegation' AND receipt.source_key=work.source_key AND receipt.request_digest=work.request_sha256 AND receipt.actor=work.actor
  ) THEN
    RAISE EXCEPTION 'Logical work must commit with its exact canonical delegated intake receipt'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_intake_required';
  END IF;
  IF TG_TABLE_NAME='specialist_run_links' THEN
    IF work.child_run_id IS DISTINCT FROM NEW.run_id THEN
      RAISE EXCEPTION 'Native child appointment must commit with its exact bound work execution'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_child_appointment_required';
    END IF;
  END IF;
  IF work.child_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM specialist_run_links link WHERE link.run_id=work.child_run_id AND link.assignment_id=work.assignment_id
      AND link.input_revision=work.input_revision AND link.work_id=work.id AND link.work_revision=work.work_revision AND link.role IN ('child','continuation')
      AND link.work_witness=jsonb_build_object('schemaVersion',1,'id',work.id,'workRevision',work.work_revision,'definitionSha256',work.definition_sha256)
  ) THEN
    RAISE EXCEPTION 'Executed logical work must commit with its exact native child appointment'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_child_appointment_required';
  END IF;
  RETURN NEW;
END;
$function$;
