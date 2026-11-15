CREATE OR REPLACE FUNCTION public.brain_capture_legacy_revision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('maister.knowledge_writer',true) = 'native_v1' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.current_revision=OLD.current_revision THEN RETURN NULL; END IF;
  INSERT INTO brain_record_revisions(record_id,revision,assertion,title,kind,basis,content_sha256,attribution,freshness,limitations,provenance,source_restrictions)
  VALUES (NEW.id,NEW.current_revision,NEW.content,NEW.title,NEW.kind,'unknown',encode(sha256(convert_to(NEW.content,'UTF8')),'hex'),
    jsonb_build_object('kind','legacy_unknown','id',NULL,'runId',NEW.source_run_id,'attemptId',NEW.source_node_attempt_id),
    jsonb_build_object('state','unknown','applicability','unknown','observedAt',NULL,'sourceAt',NULL,'capturedAt',now()),
    '["Legacy writer metadata does not establish submitting identity, observation time or confirmation."]'::jsonb,'legacy_writer',NEW.source_restrictions);
  RETURN NULL;
END $function$;
