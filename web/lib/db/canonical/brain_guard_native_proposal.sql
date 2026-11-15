CREATE OR REPLACE FUNCTION public.brain_guard_native_proposal()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.kind NOT IN ('knowledge_add','knowledge_correct') THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=OLD.project_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Native knowledge proposals retain their attributed history' USING ERRCODE='23514', CONSTRAINT='brain_proposal_immutable';
  END IF;
  IF (NEW.project_id,NEW.company_id,NEW.kind,NEW.draft,NEW.actor,NEW.principal_key,NEW.submission_key,NEW.request_digest,NEW.knowledge_attribution,NEW.target_record_id,NEW.expected_record_revision,NEW.source_restrictions,NEW.authority_snapshot->'submit')
    IS DISTINCT FROM (OLD.project_id,OLD.company_id,OLD.kind,OLD.draft,OLD.actor,OLD.principal_key,OLD.submission_key,OLD.request_digest,OLD.knowledge_attribution,OLD.target_record_id,OLD.expected_record_revision,OLD.source_restrictions,OLD.authority_snapshot->'submit') THEN
    RAISE EXCEPTION 'Knowledge proposal input is immutable' USING ERRCODE='23514', CONSTRAINT='brain_proposal_immutable';
  END IF;
  IF OLD.status<>'pending' AND (NEW.status,NEW.revision,NEW.decision_key,NEW.decision_digest,NEW.published_record_id,NEW.published_record_revision,NEW.resolution,NEW.authority_snapshot) IS DISTINCT FROM (OLD.status,OLD.revision,OLD.decision_key,OLD.decision_digest,OLD.published_record_id,OLD.published_record_revision,OLD.resolution,OLD.authority_snapshot) THEN
    RAISE EXCEPTION 'Knowledge proposal decision is immutable' USING ERRCODE='23514', CONSTRAINT='brain_proposal_immutable';
  END IF;
  RETURN NEW;
END $function$;
