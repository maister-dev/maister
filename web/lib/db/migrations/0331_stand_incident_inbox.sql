ALTER TABLE "inbox_items" DROP CONSTRAINT "inbox_items_owner_check";--> statement-breakpoint
ALTER TABLE "inbox_items" DROP CONSTRAINT "inbox_items_event_kind_check";--> statement-breakpoint
ALTER TABLE "inbox_items" ADD COLUMN "stand_incident_id" text;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_stand_incident_id_stand_incident_episodes_id_fk" FOREIGN KEY ("stand_incident_id") REFERENCES "public"."stand_incident_episodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_stand_incident_transition_uq" UNIQUE("stand_incident_id","recipient_id","event_kind");--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_owner_check" CHECK ((CASE WHEN "inbox_items"."stand_incident_id" IS NOT NULL THEN
        "inbox_items"."assignment_delivery_id" IS NULL AND "inbox_items"."recipient_type"='user' AND "inbox_items"."task_id" IS NULL
        AND ("inbox_items"."company_id" IS NULL)<>("inbox_items"."project_id" IS NULL)
        AND "inbox_items"."event_kind" IN ('stand_incident_opened','stand_incident_resolved')
      ELSE (("inbox_items"."assignment_delivery_id" IS NULL AND "inbox_items"."company_id" IS NULL
        AND "inbox_items"."project_id" IS NOT NULL AND "inbox_items"."task_id" IS NOT NULL
        AND "inbox_items"."event_kind" NOT IN ('assignment_result_available','stand_incident_opened','stand_incident_resolved'))
        OR ("inbox_items"."assignment_delivery_id" IS NOT NULL AND "inbox_items"."event_kind"='assignment_result_available'
        AND "inbox_items"."recipient_type"='user' AND (("inbox_items"."company_id" IS NOT NULL AND "inbox_items"."project_id" IS NULL AND "inbox_items"."task_id" IS NULL)
        OR ("inbox_items"."company_id" IS NULL AND "inbox_items"."project_id" IS NOT NULL)))) END) IS TRUE);--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_event_kind_check" CHECK ("inbox_items"."event_kind" in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched', 'triage_set', 'triage_requeued', 'agent_quarantined', 'experiment_concluded', 'run_pr_merged', 'clarification_requested', 'assignment_result_available', 'stand_incident_opened', 'stand_incident_resolved'));--> statement-breakpoint
CREATE FUNCTION guard_stand_incident_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.stand_incident_id IS NOT NULL OR NEW.stand_incident_id IS NOT NULL) THEN
    IF (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') THEN
      RAISE EXCEPTION 'Stand incident Inbox routing and evidence are immutable'
        USING ERRCODE='23514',CONSTRAINT='stand_incident_inbox_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.stand_incident_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM stand_incident_episodes episode
    LEFT JOIN stand_verifications recovery ON recovery.id=episode.recovery_verification_id
    JOIN stand_operations operation ON operation.id=CASE NEW.event_kind
      WHEN 'stand_incident_opened' THEN episode.first_operation_id
      WHEN 'stand_incident_resolved' THEN recovery.operation_id END
      AND operation.resource_key=episode.resource_key
    JOIN specialist_assignments subject ON subject.id=operation.assignment_id
    WHERE episode.id=NEW.stand_incident_id
      AND ((NEW.event_kind='stand_incident_opened' AND episode.state='open')
        OR (NEW.event_kind='stand_incident_resolved' AND episode.state='resolved' AND recovery.state='healthy'))
      AND subject.requester->>'kind'='user' AND subject.requester->>'id'=NEW.recipient_id
      AND subject.company_id IS NOT DISTINCT FROM NEW.company_id AND subject.project_id IS NOT DISTINCT FROM NEW.project_id
      AND NEW.source_ref=jsonb_build_object('kind','stand_incident',
        'incidentId',episode.id,'operationId',operation.id,'assignmentId',subject.id)
  ) THEN
    RAISE EXCEPTION 'Stand incident Inbox requires the exact transition and assignment requester'
      USING ERRCODE='23514',CONSTRAINT='stand_incident_inbox_reference';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stand_incident_inbox_guard BEFORE INSERT OR UPDATE ON inbox_items
FOR EACH ROW EXECUTE FUNCTION guard_stand_incident_inbox();
