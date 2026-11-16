CREATE OR REPLACE FUNCTION public.guard_native_assignment_inbox()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE receipt specialist_delivery_receipts%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.assignment_delivery_id IS NOT NULL OR NEW.assignment_delivery_id IS NOT NULL) THEN
    IF ROW(NEW.id,NEW.recipient_type,NEW.recipient_id,NEW.company_id,NEW.project_id,NEW.task_id,NEW.assignment_delivery_id,NEW.event_kind,NEW.source_ref,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.recipient_type,OLD.recipient_id,OLD.company_id,OLD.project_id,OLD.task_id,OLD.assignment_delivery_id,OLD.event_kind,OLD.source_ref,OLD.created_at) THEN
      RAISE EXCEPTION 'Native Inbox routing and result evidence are immutable'
        USING ERRCODE='23514',CONSTRAINT='native_assignment_inbox_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.assignment_delivery_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO receipt FROM specialist_delivery_receipts WHERE id=NEW.assignment_delivery_id FOR SHARE;
  IF NOT FOUND OR receipt.snapshot->'destination'->>'kind' IS DISTINCT FROM 'inbox'
    OR NEW.id IS DISTINCT FROM receipt.id OR NEW.recipient_id IS DISTINCT FROM receipt.snapshot->>'requesterUserId'
    OR NEW.source_ref IS DISTINCT FROM jsonb_build_object('kind','assignment_delivery','assignmentId',receipt.assignment_id,'deliveryId',receipt.id,'runId',receipt.run_id,'resultRevision',receipt.result_revision)
    OR (receipt.snapshot->'owner'->>'kind'='company' AND (NEW.company_id IS DISTINCT FROM receipt.snapshot->'owner'->>'companyId' OR NEW.project_id IS NOT NULL OR NEW.task_id IS NOT NULL))
    OR (receipt.snapshot->'owner'->>'kind'='project' AND (NEW.project_id IS DISTINCT FROM receipt.snapshot->'owner'->>'projectId' OR NEW.company_id IS NOT NULL
      OR NEW.task_id IS DISTINCT FROM (SELECT project_task_id FROM specialist_assignments WHERE id=receipt.assignment_id))) THEN
    RAISE EXCEPTION 'Native Inbox requires its exact private recipient, owner and result receipt'
      USING ERRCODE='23514',CONSTRAINT='native_assignment_inbox_reference';
  END IF;
  RETURN NEW;
END $function$;
