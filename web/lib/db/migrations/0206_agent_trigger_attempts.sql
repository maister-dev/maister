CREATE TABLE "agent_activity_cutovers" (
	"version" integer PRIMARY KEY NOT NULL,
	"phase" text NOT NULL,
	"after_run_id" text,
	"after_schedule_id" text,
	"after_episode_id" text,
	"processed" integer DEFAULT 0 NOT NULL,
	"unresolved" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_activity_cutover_shape_check" CHECK ("agent_activity_cutovers"."version" = 1 AND "agent_activity_cutovers"."phase" IN ('identity','facts','schedules','baseline','complete') AND "agent_activity_cutovers"."processed" >= 0 AND "agent_activity_cutovers"."unresolved" >= 0 AND (("agent_activity_cutovers"."phase" = 'complete') = ("agent_activity_cutovers"."completed_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "agent_incident_occurrence_readers" (
	"occurrence_id" text NOT NULL,
	"user_id" text NOT NULL,
	"acknowledged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_incident_occurrence_readers_occurrence_id_user_id_pk" PRIMARY KEY("occurrence_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "agent_trigger_attempts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"project_id" text NOT NULL,
	"source_agent_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"binding_snapshot" jsonb NOT NULL,
	"fence" integer NOT NULL,
	"delivery_key" text NOT NULL,
	"trigger_source" text NOT NULL,
	"trigger_event_id" bigint,
	"provenance" text DEFAULT 'claim' NOT NULL,
	"reserved_run_id" text NOT NULL,
	"run_id" text,
	"original_run_id" text,
	"claimed_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"outcome" text,
	"reason_code" text,
	"scope_key" text DEFAULT 'unknown' NOT NULL,
	CONSTRAINT "agent_trigger_attempt_delivery_uq" UNIQUE("schedule_id","delivery_key"),
	CONSTRAINT "agent_trigger_attempt_fence_uq" UNIQUE("schedule_id","fence"),
	CONSTRAINT "agent_trigger_attempt_reserved_run_uq" UNIQUE("reserved_run_id"),
	CONSTRAINT "agent_trigger_attempt_shape_check" CHECK (("agent_trigger_attempts"."fence" > 0 AND "agent_trigger_attempts"."trigger_source" IN ('cron','domain_event') AND "agent_trigger_attempts"."provenance" IN ('claim','legacy_latest') AND jsonb_typeof("agent_trigger_attempts"."binding_snapshot") = 'object' AND "agent_trigger_attempts"."binding_snapshot"->'version' = '1'::jsonb AND "agent_trigger_attempts"."binding_snapshot"->>'scheduleId' = "agent_trigger_attempts"."schedule_id" AND (("agent_trigger_attempts"."settled_at" IS NULL AND "agent_trigger_attempts"."outcome" IS NULL) OR ("agent_trigger_attempts"."settled_at" IS NOT NULL AND "agent_trigger_attempts"."outcome" IN ('launched','queued','refused','deduplicated','suppressed','failed','unknown'))) AND ("agent_trigger_attempts"."run_id" IS NULL OR "agent_trigger_attempts"."original_run_id" = "agent_trigger_attempts"."run_id")) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_kind_check";--> statement-breakpoint
ALTER TABLE "agent_incident_occurrence_readers" ADD CONSTRAINT "agent_incident_occurrence_readers_occurrence_id_agent_incident_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."agent_incident_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_incident_occurrence_readers" ADD CONSTRAINT "agent_incident_occurrence_readers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_trigger_attempts" ADD CONSTRAINT "agent_trigger_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_trigger_attempts" ADD CONSTRAINT "agent_trigger_attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_trigger_attempt_history_idx" ON "agent_trigger_attempts" USING btree ("project_id","source_agent_id","claimed_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_trigger_attempt_due_idx" ON "agent_trigger_attempts" USING btree ("due_at") WHERE "agent_trigger_attempts"."outcome" IS NULL OR "agent_trigger_attempts"."outcome" = 'unknown';--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_kind_check" CHECK ("domain_events"."kind" in ('agent.activity_changed', 'agent.incident_changed', 'task.qualification_changed', 'task.created', 'task.comment_added', 'task.triage_requeued', 'task.clarification_requested', 'task.clarification_answered', 'task.clarification_cancelled', 'run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'run.review', 'run.review_opened', 'run.needs_input', 'run.escalated', 'run.rework_claimed', 'run.rework_returned', 'gate.failed', 'run.operational_attention_acknowledged', 'run.operational_cleanup_changed'));--> statement-breakpoint
CREATE FUNCTION guard_agent_trigger_attempt_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.project_id, NEW.source_agent_id, NEW.schedule_id, NEW.binding_snapshot,
         NEW.fence, NEW.delivery_key, NEW.trigger_source, NEW.trigger_event_id,
         NEW.provenance, NEW.reserved_run_id, NEW.claimed_at)
     IS DISTINCT FROM
     ROW(OLD.project_id, OLD.source_agent_id, OLD.schedule_id, OLD.binding_snapshot,
         OLD.fence, OLD.delivery_key, OLD.trigger_source, OLD.trigger_event_id,
         OLD.provenance, OLD.reserved_run_id, OLD.claimed_at) THEN
    RAISE EXCEPTION 'agent trigger attempt identity is immutable for %', OLD.id
      USING ERRCODE='23514', CONSTRAINT='agent_trigger_attempt_identity_immutable';
  END IF;
  IF OLD.outcome IS NOT NULL AND OLD.outcome <> 'unknown' AND
     ROW(NEW.outcome, NEW.settled_at, NEW.original_run_id, NEW.reason_code)
       IS DISTINCT FROM ROW(OLD.outcome, OLD.settled_at, OLD.original_run_id, OLD.reason_code) THEN
    RAISE EXCEPTION 'settled agent trigger attempt is immutable for %', OLD.id
      USING ERRCODE='23514', CONSTRAINT='agent_trigger_attempt_settlement_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_trigger_attempt_identity_guard BEFORE UPDATE ON agent_trigger_attempts
FOR EACH ROW EXECUTE FUNCTION guard_agent_trigger_attempt_identity();
