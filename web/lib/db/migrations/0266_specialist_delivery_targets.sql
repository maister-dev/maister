ALTER TABLE "inbox_items" DROP CONSTRAINT "inbox_items_event_kind_check";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_one_target";--> statement-breakpoint
ALTER TABLE "inbox_items" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_items" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD COLUMN "assignment_delivery_id" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "specialist_delivery_id" text;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_assignment_delivery_id_specialist_delivery_receipts_id_fk" FOREIGN KEY ("assignment_delivery_id") REFERENCES "public"."specialist_delivery_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_specialist_delivery_id_specialist_delivery_receipts_id_fk" FOREIGN KEY ("specialist_delivery_id") REFERENCES "public"."specialist_delivery_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_assignment_delivery_uq" UNIQUE("assignment_delivery_id");--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_specialist_target_uq" UNIQUE("specialist_delivery_id");--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_owner_check" CHECK ((( "inbox_items"."assignment_delivery_id" IS NULL AND "inbox_items"."company_id" IS NULL AND "inbox_items"."project_id" IS NOT NULL AND "inbox_items"."task_id" IS NOT NULL AND "inbox_items"."event_kind"<>'assignment_result_available') OR ("inbox_items"."assignment_delivery_id" IS NOT NULL AND "inbox_items"."event_kind"='assignment_result_available' AND "inbox_items"."recipient_type"='user' AND (("inbox_items"."company_id" IS NOT NULL AND "inbox_items"."project_id" IS NULL AND "inbox_items"."task_id" IS NULL) OR ("inbox_items"."company_id" IS NULL AND "inbox_items"."project_id" IS NOT NULL)))) IS TRUE);--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_event_kind_check" CHECK ("inbox_items"."event_kind" in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched', 'triage_set', 'triage_requeued', 'agent_quarantined', 'experiment_concluded', 'run_pr_merged', 'clarification_requested', 'assignment_result_available'));--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_one_target" CHECK (num_nonnulls("webhook_deliveries"."subscription_id","webhook_deliveries"."push_subscription_id","webhook_deliveries"."specialist_delivery_id")=1);--> statement-breakpoint
CREATE FUNCTION guard_native_assignment_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
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
END $$;
--> statement-breakpoint
CREATE TRIGGER native_assignment_inbox_guard BEFORE INSERT OR UPDATE ON inbox_items
FOR EACH ROW EXECUTE FUNCTION guard_native_assignment_inbox();
--> statement-breakpoint
CREATE FUNCTION guard_native_assignment_transport() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt specialist_delivery_receipts%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.specialist_delivery_id IS NOT NULL OR NEW.specialist_delivery_id IS NOT NULL) THEN
    IF ROW(NEW.id,NEW.event_id,NEW.subscription_id,NEW.push_subscription_id,NEW.specialist_delivery_id,NEW.idempotency_key,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.event_id,OLD.subscription_id,OLD.push_subscription_id,OLD.specialist_delivery_id,OLD.idempotency_key,OLD.created_at) THEN
      RAISE EXCEPTION 'Native transport identity and target are immutable'
        USING ERRCODE='23514',CONSTRAINT='native_assignment_transport_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.specialist_delivery_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO receipt FROM specialist_delivery_receipts WHERE id=NEW.specialist_delivery_id FOR SHARE;
  IF NOT FOUND OR NEW.event_id IS DISTINCT FROM receipt.outbox_event_id THEN
    RAISE EXCEPTION 'Native transport requires its exact frozen origin delivery intent'
      USING ERRCODE='23514',CONSTRAINT='native_assignment_transport_reference';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER native_assignment_transport_guard BEFORE INSERT OR UPDATE ON webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION guard_native_assignment_transport();
