CREATE OR REPLACE FUNCTION public.guard_stand_restart_approval()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'A retained stand restart approval is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM stand_operations operation JOIN stand_targets target ON target.id=operation.target_id
    WHERE operation.id=NEW.operation_id AND operation.action='restart' AND operation.effect_state='not_dispatched'
      AND operation.request_digest=NEW.request_digest AND operation.revision=NEW.operation_revision
      AND target.enabled AND target.config_revision=operation.config_revision
      AND EXISTS (
        SELECT 1 FROM company_grants grant_row
        WHERE grant_row.company_id=target.company_id AND grant_row.principal_type='user'
          AND grant_row.principal_id=NEW.approved_by AND grant_row.action='targets:restart' AND grant_row.revoked_at IS NULL
          AND NEW.authority->>'kind'='company_grant' AND NEW.authority->>'action'=grant_row.action
          AND NEW.authority->>'authorityId'=grant_row.id AND NEW.authority->>'revision'=grant_row.revision::text
          AND NEW.authority->'owner'->>'companyId'=target.company_id
      )
  ) THEN
    RAISE EXCEPTION 'A stand restart approval requires its exact current intent and authority' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
