ALTER TABLE "stand_verifications" ALTER COLUMN "effect_receipt_id" DROP NOT NULL;
--> statement-breakpoint
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
      AND (NEW.purpose<>'verify' OR effect='confirmed_applied'
        OR (operation.action='inspect' AND effect='not_dispatched'))
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_stand_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'A stand verification is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM stand_operations operation
    LEFT JOIN stand_operation_receipts effect ON effect.operation_id=operation.id AND effect.id=NEW.effect_receipt_id
    JOIN stand_read_claims claim ON claim.operation_id=operation.id AND claim.purpose='verify'
    WHERE operation.id=NEW.operation_id AND NEW.issued_at<=clock_timestamp()
      AND (
        (operation.action='restart' AND operation.effect_state='confirmed_applied'
          AND effect.receipt->>'effectState'='confirmed_applied'
          AND NEW.target_sequence>effect.target_sequence
          AND NEW.issued_at>=date_trunc('milliseconds',effect.received_at))
        OR (operation.action='inspect' AND operation.effect_state='not_dispatched' AND NEW.effect_receipt_id IS NULL
          AND NEW.issued_at>=date_trunc('milliseconds',operation.created_at))
      )
      AND claim.owner_epoch=NEW.owner_epoch AND claim.actor_id=NEW.actor_id AND claim.expires_at>clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM stand_verifications previous
        WHERE previous.operation_id=operation.id AND previous.target_sequence>=NEW.target_sequence)
  ) THEN
    RAISE EXCEPTION 'A stand verification requires a current owner and a later probe than the applied effect' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_stand_verification_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT ((NEW.action='restart' AND NEW.effect_state='confirmed_applied') OR
    (NEW.action='inspect' AND NEW.effect_state='not_dispatched')) OR NOT EXISTS (
    SELECT 1 FROM (
      SELECT state FROM stand_verifications
      WHERE operation_id=NEW.id ORDER BY target_sequence DESC LIMIT 1
    ) latest WHERE latest.state=NEW.verification_state
  ) THEN
    RAISE EXCEPTION 'A stand verification projection requires its latest retained probe' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION specialist_stand_requirement_met(subject_id text, selected_input integer, selected_digest text,
  objective jsonb, result_value jsonb, requirement_kind text, reference_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT result_value->>'outcome'='success' AND EXISTS (
    SELECT 1 FROM stand_operations operation
    LEFT JOIN stand_operation_receipts effect ON effect.operation_id=operation.id
      AND effect.receipt->>'effectState'='confirmed_applied'
    WHERE operation.assignment_id=subject_id AND operation.input_revision=selected_input
      AND operation.input_sha256=selected_digest
      AND ((operation.action='restart' AND operation.effect_state='confirmed_applied' AND effect.id IS NOT NULL)
        OR (requirement_kind='health' AND operation.action='inspect' AND operation.effect_state='not_dispatched'))
      AND (objective->'targetIds') ? operation.target_id
      AND jsonb_typeof(result_value->'operationIds')='array'
      AND (result_value->'operationIds') ? operation.id
      AND (
        (requirement_kind='effect' AND (reference_id IS NULL OR reference_id IN (operation.id,operation.target_id)))
        OR (requirement_kind='health' AND EXISTS (
          SELECT 1 FROM stand_verifications probe WHERE probe.effect_receipt_id IS NOT DISTINCT FROM effect.id
            AND probe.operation_id=operation.id AND probe.state='healthy'
            AND jsonb_typeof(result_value->'verificationIds')='array'
            AND (result_value->'verificationIds') ? probe.id
            AND (reference_id IS NULL OR reference_id IN (probe.id,operation.id,operation.target_id))
            AND NOT EXISTS (SELECT 1 FROM stand_verifications newer
              WHERE newer.operation_id=probe.operation_id AND newer.target_sequence>probe.target_sequence)
        ))
      )
  )
$$;
--> statement-breakpoint
CREATE FUNCTION guard_scheduled_stand_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM specialist_assignments subject
    JOIN agent_trigger_attempts invocation ON invocation.id=subject.origin->>'triggerAttemptId'
      AND invocation.schedule_id=subject.origin->>'scheduleId'
    WHERE subject.id=NEW.assignment_id AND subject.origin->>'kind'='schedule'
      AND invocation.stand_inspection IS NOT NULL
      AND (NEW.action<>'inspect' OR NEW.target_id<>invocation.stand_inspection->>'targetId'
        OR NEW.component_id<>invocation.stand_inspection->>'componentId'
        OR to_jsonb(NEW.config_revision)<>invocation.stand_inspection->'configRevision'
        OR NEW.target_incarnation<>invocation.stand_inspection->>'incarnationId')
  ) THEN
    RAISE EXCEPTION 'A scheduled stand operation must be a read of the exact appointed component'
      USING ERRCODE='23514',CONSTRAINT='stand_operations_scheduled_appointment';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER stand_operations_scheduled_appointment_guard BEFORE INSERT ON stand_operations
  FOR EACH ROW EXECUTE FUNCTION guard_scheduled_stand_operation();
