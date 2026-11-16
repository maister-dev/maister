CREATE OR REPLACE FUNCTION guard_stand_recovery_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'A retained stand recovery decision is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM stand_operations operation
    JOIN stand_targets target ON target.id=operation.target_id
    JOIN stand_resource_claims claim ON claim.operation_id=operation.id AND claim.canonical_resource_key=operation.resource_key
    JOIN company_grants grant_row ON grant_row.company_id=target.company_id
      AND grant_row.principal_type='user' AND grant_row.principal_id=NEW.actor_id
      AND grant_row.action='targets:recover' AND grant_row.revoked_at IS NULL
    WHERE operation.id=NEW.operation_id AND operation.action='restart'
      AND operation.effect_state='unknown' AND operation.disposition<>'authorized_successor'
      AND operation.revision+1=NEW.operation_revision AND claim.unresolved
      AND NEW.authority->>'kind'='company_grant'
      AND NEW.authority->>'action'=grant_row.action AND NEW.authority->>'authorityId'=grant_row.id
      AND NEW.authority->>'revision'=grant_row.revision::text
      AND NEW.authority->'owner'->>'companyId'=target.company_id
      AND (
        (NEW.decision='hold' AND NEW.inspection_ids='[]'::jsonb)
        OR (
          NEW.decision='authorize_successor' AND jsonb_array_length(NEW.inspection_ids)=1
          AND target.enabled AND target.config_revision=operation.config_revision
          AND claim.expires_at<=clock_timestamp()-interval '5 seconds'
          AND EXISTS (
            SELECT 1 FROM company_grants restart
            WHERE restart.company_id=target.company_id AND restart.principal_type='user'
              AND restart.principal_id=NEW.actor_id AND restart.action='targets:restart' AND restart.revoked_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM stand_operation_observations inspection
            WHERE inspection.id=NEW.inspection_ids->>0 AND inspection.operation_id=operation.id
              AND inspection.recovery_revision=operation.revision AND inspection.observed_state='active'
              AND inspection.invocation_id ~ '^[a-f0-9]{32}$'
              AND inspection.received_at>=clock_timestamp()-interval '5 minutes'
              AND NOT EXISTS (
                SELECT 1 FROM stand_operation_observations newer
                WHERE newer.operation_id=operation.id AND newer.target_sequence>inspection.target_sequence
              )
          )
          AND EXISTS (
            SELECT 1 FROM stand_operations successor
            WHERE successor.predecessor_id=operation.id AND successor.target_id=operation.target_id
              AND successor.target_incarnation=operation.target_incarnation
              AND successor.config_revision=operation.config_revision AND successor.component_id=operation.component_id
              AND successor.resource_key=operation.resource_key AND successor.action='restart'
              AND successor.effect_state='not_dispatched' AND successor.initiating_user_id=NEW.actor_id
              AND successor.delivery_key=NEW.delivery_key
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'A stand recovery decision requires the current unknown restart, resource and authority' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_stand_recovery_disposition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (
    OLD.disposition='authorized_successor'
    OR (NEW.disposition IN ('unresolved_hold','authorized_successor') AND NOT EXISTS (
      SELECT 1 FROM stand_recovery_decisions decision
      WHERE decision.operation_id=NEW.id AND decision.operation_revision=NEW.revision
        AND decision.decision=CASE NEW.disposition WHEN 'unresolved_hold' THEN 'hold' ELSE 'authorize_successor' END
    ))
  ) THEN
    RAISE EXCEPTION 'A stand recovery disposition requires its exact retained decision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION check_stand_successor_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM stand_operations predecessor JOIN stand_operations successor ON successor.predecessor_id=predecessor.id
    JOIN stand_resource_claims claim ON claim.operation_id=successor.id AND claim.canonical_resource_key=successor.resource_key
    WHERE predecessor.id=NEW.id AND predecessor.effect_state='unknown'
      AND successor.effect_state='not_dispatched' AND claim.unresolved
  ) THEN
    RAISE EXCEPTION 'A stand successor decision must transfer the unresolved resource claim' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER stand_successor_transfer_check AFTER UPDATE ON stand_operations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.disposition='authorized_successor' AND OLD.disposition IS DISTINCT FROM NEW.disposition)
EXECUTE FUNCTION check_stand_successor_transfer();
