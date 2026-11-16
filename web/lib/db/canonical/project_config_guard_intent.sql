CREATE OR REPLACE FUNCTION public.project_config_guard_intent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  allowed boolean;
BEGIN
  IF ROW(NEW.id, NEW.project_id, NEW.actor_user_id, NEW.snapshot, NEW.snapshot_digest, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.project_id, OLD.actor_user_id, OLD.snapshot, OLD.snapshot_digest, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'project configuration review is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
    RAISE EXCEPTION 'accepted configuration intent is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'project_config_persist_operations' THEN
    IF NEW.repository_key IS DISTINCT FROM OLD.repository_key
       OR (OLD.prepared_sha IS NOT NULL AND NEW.prepared_sha IS DISTINCT FROM OLD.prepared_sha)
       OR (OLD.committed_sha IS NOT NULL AND NEW.committed_sha IS DISTINCT FROM OLD.committed_sha) THEN
      RAISE EXCEPTION 'project configuration provenance is immutable' USING ERRCODE = '23514';
    END IF;
    allowed := NEW.state = OLD.state OR CASE OLD.state
      WHEN 'previewed' THEN NEW.state IN ('preparing','noop','stale','failed')
      WHEN 'preparing' THEN NEW.state IN ('prepared','failed','stale','recovery_required')
      WHEN 'prepared' THEN NEW.state IN ('publishing','stale','recovery_required')
      WHEN 'publishing' THEN NEW.state IN ('committed','recovery_required')
      WHEN 'recovery_required' THEN NEW.state IN ('prepared','publishing','committed','failed','stale')
      ELSE false END;
  ELSE
    IF NEW.operation_id IS DISTINCT FROM OLD.operation_id THEN
      RAISE EXCEPTION 'project configuration push parent is immutable' USING ERRCODE = '23514';
    END IF;
    allowed := NEW.state = OLD.state OR CASE OLD.state
      WHEN 'previewed' THEN NEW.state IN ('pending','stale')
      WHEN 'pending' THEN NEW.state IN ('succeeded','failed','unknown')
      WHEN 'unknown' THEN NEW.state IN ('succeeded','failed','stale')
      ELSE false END;
  END IF;
  IF NOT allowed THEN
    RAISE EXCEPTION 'project configuration transition % -> % is not allowed', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
