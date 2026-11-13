CREATE FUNCTION guard_stand_recovery_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'A retained stand recovery decision is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.decision<>'hold' OR NEW.inspection_ids<>'[]'::jsonb OR NOT EXISTS (
    SELECT 1
    FROM stand_operations operation
    JOIN stand_targets target ON target.id=operation.target_id
    JOIN stand_resource_claims claim ON claim.operation_id=operation.id
      AND claim.canonical_resource_key=operation.resource_key
    JOIN company_grants grant_row ON grant_row.company_id=target.company_id
      AND grant_row.principal_type='user' AND grant_row.principal_id=NEW.actor_id
      AND grant_row.action='targets:recover' AND grant_row.revoked_at IS NULL
    WHERE operation.id=NEW.operation_id AND operation.action='restart'
      AND operation.effect_state='unknown' AND operation.revision+1=NEW.operation_revision
      AND claim.unresolved AND NEW.authority->>'kind'='company_grant'
      AND NEW.authority->>'action'=grant_row.action AND NEW.authority->>'authorityId'=grant_row.id
      AND NEW.authority->>'revision'=grant_row.revision::text
      AND NEW.authority->'owner'->>'companyId'=target.company_id
  ) THEN
    RAISE EXCEPTION 'A stand recovery hold requires the current unknown restart, resource claim and authority' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stand_recovery_decision_guard BEFORE INSERT OR UPDATE OR DELETE ON stand_recovery_decisions FOR EACH ROW EXECUTE FUNCTION guard_stand_recovery_decision();
--> statement-breakpoint
CREATE FUNCTION guard_stand_recovery_disposition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.disposition='authorized_successor' OR (
    NEW.disposition='unresolved_hold' AND NOT EXISTS (
      SELECT 1 FROM stand_recovery_decisions decision
      WHERE decision.operation_id=NEW.id AND decision.operation_revision=NEW.revision
        AND decision.decision='hold'
    )
  ) THEN
    RAISE EXCEPTION 'A stand recovery disposition requires its exact retained decision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stand_recovery_disposition_guard BEFORE UPDATE ON stand_operations FOR EACH ROW
WHEN (OLD.disposition IS DISTINCT FROM NEW.disposition OR OLD.revision IS DISTINCT FROM NEW.revision)
EXECUTE FUNCTION guard_stand_recovery_disposition();
