CREATE OR REPLACE FUNCTION public.guard_task_launch_dispatch_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='INSERT' AND NEW.dispatch_receipt IS NOT NULL THEN
    RAISE EXCEPTION 'A new accepted launch has not dispatched'
      USING ERRCODE='23514',CONSTRAINT='task_launch_dispatch_receipt_initial';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.dispatch_receipt IS NOT NULL AND OLD.dispatch_receipt IS DISTINCT FROM NEW.dispatch_receipt THEN
      RAISE EXCEPTION 'First dispatch receipt is immutable across continuation epochs'
        USING ERRCODE='23514',CONSTRAINT='task_launch_dispatch_receipt_immutable';
    END IF;
    IF OLD.dispatch_receipt IS NULL AND NEW.dispatch_receipt IS NOT NULL THEN
      IF OLD.dispatch_committed_at IS NOT NULL OR OLD.state<>'run_bound' OR NEW.state<>'run_bound'
        OR NOT (
          jsonb_typeof(NEW.dispatch_receipt)='object' AND NEW.dispatch_receipt->'version'='1'::jsonb
          AND NEW.dispatch_receipt->>'runId'=NEW.run_id
          AND NEW.dispatch_receipt->>'inputDigest'=NEW.input_digest
          AND NEW.dispatch_receipt->>'settingsDigest'=NEW.settings_digest
          AND (NEW.dispatch_receipt->>'committedAt')::timestamptz=NEW.dispatch_committed_at
          AND NEW.dispatch_receipt-ARRAY['version','runId','assignmentId','assignmentEpoch','inputDigest','settingsDigest','committedAt','preparation']='{}'::jsonb
          AND (NEW.settings_snapshot->>'kind'='flow' AND NOT NEW.dispatch_receipt ? 'preparation'
            OR NEW.settings_snapshot->>'kind'='agent' AND jsonb_typeof(NEW.dispatch_receipt->'preparation')='object'
              AND NEW.dispatch_receipt->'preparation'->>'baselineDigest' ~ '^[0-9a-f]{64}$'
              AND NEW.dispatch_receipt->'preparation'->>'materializationDigest' ~ '^[0-9a-f]{64}$'
              AND EXISTS(SELECT 1 FROM agent_preparation_operations preparation JOIN runs prepared_run ON prepared_run.id=preparation.run_id
                WHERE preparation.id=NEW.dispatch_receipt->'preparation'->>'id' AND preparation.run_id=NEW.run_id
                  AND preparation.assignment_id=NEW.dispatch_receipt->>'assignmentId' AND to_jsonb(preparation.assignment_epoch)=NEW.dispatch_receipt->'assignmentEpoch'
                  AND preparation.phase='materialized' AND preparation.lease_expires_at>clock_timestamp()
                  AND preparation.resource_id=NEW.dispatch_receipt->'preparation'->>'resourceId'
                  AND preparation.incarnation=NEW.dispatch_receipt->'preparation'->>'incarnation'
                  AND to_jsonb(preparation.generation)=NEW.dispatch_receipt->'preparation'->'generation'
                  AND prepared_run.operational_integrity_baseline->'generation'=to_jsonb(preparation.generation)))
          AND octet_length(NEW.dispatch_receipt::text)<=8192
          AND EXISTS(SELECT 1 FROM execution_assignments assignment
            WHERE assignment.id=NEW.dispatch_receipt->>'assignmentId' AND assignment.run_id=NEW.run_id
              AND assignment.state='active' AND to_jsonb(assignment.epoch)=NEW.dispatch_receipt->'assignmentEpoch'
              AND EXISTS(SELECT 1 FROM runs owner_run WHERE owner_run.id=NEW.run_id AND owner_run.execution_assignment_id=assignment.id))
        ) IS TRUE THEN
        RAISE EXCEPTION 'First dispatch must bind its current run assignment and exact accepted request'
          USING ERRCODE='23514',CONSTRAINT='task_launch_dispatch_receipt_owner';
      END IF;
    END IF;
    IF OLD.dispatch_committed_at IS NULL AND NEW.dispatch_committed_at IS NOT NULL AND NEW.dispatch_receipt IS NULL THEN
      RAISE EXCEPTION 'A timestamp alone cannot establish execution commitment'
        USING ERRCODE='23514',CONSTRAINT='task_launch_dispatch_receipt_required';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
