CREATE OR REPLACE FUNCTION public.guard_project_token_run_origin()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.origin_kind IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM runs owner WHERE owner.id=NEW.bound_run_id AND owner.project_id=NEW.project_id
        AND ((NEW.origin_kind='orchestrator_run' AND owner.run_kind='flow')
          OR (NEW.origin_kind='agent_run' AND owner.run_kind='agent' AND owner.agent_id=NEW.agent_id))
    ) THEN
      RAISE EXCEPTION 'Machine token origin must match its actual run'
        USING ERRCODE='23514',CONSTRAINT='project_tokens_run_origin_owner';
    END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.origin_kind,NEW.bound_run_id) IS DISTINCT FROM ROW(OLD.origin_kind,OLD.bound_run_id)
      OR OLD.origin_kind IS NOT NULL AND ROW(NEW.project_id,NEW.token_kind,NEW.agent_id)
        IS DISTINCT FROM ROW(OLD.project_id,OLD.token_kind,OLD.agent_id) THEN
      RAISE EXCEPTION 'Machine token origin is immutable'
        USING ERRCODE='23514',CONSTRAINT='project_tokens_run_origin_immutable';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
      OR OLD.revocation_reason='revoked' AND NEW.revocation_reason IS DISTINCT FROM 'revoked'
      OR OLD.revocation_reason='rotation' AND NEW.revocation_reason IS NULL
      OR OLD.revoked_at IS NOT NULL AND OLD.revocation_reason IS NULL AND NEW.revocation_reason='rotation' THEN
      RAISE EXCEPTION 'Token revocation cannot be restored or reclassified as rotation'
        USING ERRCODE='23514',CONSTRAINT='project_tokens_revocation_monotonic';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
