CREATE OR REPLACE FUNCTION guard_stand_authorization_permit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  effect text;
  action text;
  target_enabled boolean;
  claim stand_resource_claims%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Stand authorization permits are immutable' USING ERRCODE='23514';
  END IF;
  SELECT operation.effect_state,operation.action,target.enabled INTO effect,action,target_enabled
    FROM stand_operations operation JOIN stand_targets target ON target.id=operation.target_id
    WHERE operation.id=NEW.operation_id AND target.config_revision=operation.config_revision
      AND target.incarnation_id=operation.target_incarnation FOR SHARE OF operation,target;
  IF NOT FOUND OR NOT target_enabled OR NEW.issued_at>clock_timestamp()
      OR NEW.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Stand authorization requires the exact current target and an unexpired permit' USING ERRCODE='23514';
  END IF;
  IF NEW.purpose='dispatch' THEN
    SELECT * INTO claim FROM stand_resource_claims WHERE operation_id=NEW.operation_id FOR SHARE;
    IF NOT FOUND OR action<>'restart' OR effect<>'dispatching' OR NOT claim.unresolved
        OR claim.owner_epoch<>NEW.owner_epoch
        OR claim.expires_at<=clock_timestamp()
        OR NOT EXISTS (
          SELECT 1 FROM execution_commands command JOIN execution_assignments placement
            ON placement.id=command.execution_assignment_id AND placement.run_id=command.run_id
            AND placement.epoch=command.assignment_epoch AND placement.state='active'
          JOIN runs execution ON execution.id=command.run_id
            AND execution.execution_assignment_id=placement.id AND execution.status='Running'
            AND execution.company_cancellation_intent IS NULL AND execution.budget_state->'termination' IS NULL
          JOIN specialist_run_links link ON link.run_id=execution.id
          JOIN stand_operations operation ON operation.id=NEW.operation_id
            AND operation.assignment_id=link.assignment_id
          JOIN specialist_assignments subject ON subject.id=link.assignment_id AND subject.input_revision=operation.input_revision
            AND subject.status IN ('active','waiting_children')
          WHERE command.id=claim.owner_id AND command.kind='stand.dispatch'
            AND command.state IN ('delivering','accepted')
            AND command.payload->>'operationId'=operation.id
            AND command.payload->>'requestDigest'=operation.request_digest
            AND command.payload->>'resourceKey'=operation.resource_key
            AND command.payload->>'ownerEpoch'=NEW.owner_epoch::text
            AND specialist_run_has_input(execution.id,subject.id,operation.input_revision,operation.input_sha256)
            AND command.payload->>'businessOwnerEpoch'=specialist_execution_owner_epoch(execution.id)::text
            AND specialist_execution_owner_epoch(execution.id)>0
        )
        OR NOT EXISTS (
          SELECT 1 FROM stand_restart_approvals approval JOIN stand_operations operation ON operation.id=approval.operation_id
          JOIN company_grants grant_row ON grant_row.id=approval.authority->>'authorityId'
            AND grant_row.revision::text=approval.authority->>'revision'
            AND grant_row.principal_type='user' AND grant_row.principal_id=approval.approved_by
            AND grant_row.action='targets:restart' AND grant_row.revoked_at IS NULL
          WHERE approval.operation_id=NEW.operation_id AND approval.request_digest=operation.request_digest
        ) THEN
      RAISE EXCEPTION 'Stand dispatch permit requires an approved effect and its current resource owner' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM stand_read_claims read_claim
    JOIN stand_operations operation ON operation.id=read_claim.operation_id
    JOIN stand_targets target ON target.id=operation.target_id
    JOIN users actor ON actor.id=read_claim.actor_id AND actor.account_status='active'
    JOIN company_grants grant_row ON grant_row.company_id=target.company_id
      AND grant_row.principal_type='user' AND grant_row.principal_id=actor.id
      AND grant_row.id=read_claim.authority->>'authorityId'
      AND grant_row.revision::text=read_claim.authority->>'revision'
      AND grant_row.revoked_at IS NULL
    WHERE operation.id=NEW.operation_id AND read_claim.purpose=NEW.purpose
      AND read_claim.owner_epoch=NEW.owner_epoch AND read_claim.expires_at>clock_timestamp()
      AND grant_row.action=CASE
        WHEN NEW.purpose='logs' THEN 'targets:logs'
        WHEN NEW.purpose='reconcile' AND effect<>'not_dispatched' THEN 'targets:recover'
        ELSE 'targets:read' END
      AND (NEW.purpose<>'verify' OR effect='confirmed_applied')
      AND EXISTS (
        SELECT 1 FROM company_grants read_grant WHERE read_grant.company_id=target.company_id
          AND read_grant.principal_type='user' AND read_grant.principal_id=actor.id
          AND read_grant.action='targets:read' AND read_grant.revoked_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'Stand read permit requires the current operation read owner and grant' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
