CREATE OR REPLACE FUNCTION public.brain_legacy_revision_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE old_provenance text;
BEGIN
  -- Only trusted native services set this transaction-local writer declaration.
  IF current_setting('maister.knowledge_writer',true) = 'native_v1' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.current_revision <> OLD.current_revision THEN
      RAISE EXCEPTION 'Native revision authority is required' USING ERRCODE='23514', CONSTRAINT='brain_record_native_writer_required';
    END IF;
    IF NEW.title IS NOT DISTINCT FROM OLD.title AND NEW.content IS NOT DISTINCT FROM OLD.content AND NEW.kind IS NOT DISTINCT FROM OLD.kind THEN RETURN NEW; END IF;
    SELECT provenance INTO old_provenance FROM brain_record_revisions WHERE record_id=OLD.id AND revision=OLD.current_revision;
    IF old_provenance='submitted' THEN
      RAISE EXCEPTION 'Structured assertions require an attributed correction' USING ERRCODE='23514', CONSTRAINT='brain_record_native_writer_required';
    END IF;
    NEW.current_revision := OLD.current_revision + 1;
  END IF;
  RETURN NEW;
END $function$;
