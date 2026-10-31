CREATE TABLE "agent_incident_episodes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"project_id" text NOT NULL,
	"source_agent_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"scope_kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"reason_code" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"attention_revision" integer DEFAULT 1 NOT NULL,
	"content_revision" integer DEFAULT 1 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"recovery_run_id" text,
	CONSTRAINT "agent_incident_state_check" CHECK ("agent_incident_episodes"."state" IN ('open','resolved') AND "agent_incident_episodes"."scope_kind" IN ('business','infrastructure','unknown') AND "agent_incident_episodes"."attention_revision" > 0 AND "agent_incident_episodes"."content_revision" > 0 AND "agent_incident_episodes"."last_at" >= "agent_incident_episodes"."first_at" AND (("agent_incident_episodes"."state" = 'open' AND "agent_incident_episodes"."resolved_at" IS NULL) OR ("agent_incident_episodes"."state" = 'resolved' AND "agent_incident_episodes"."resolved_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "agent_incident_occurrences" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"episode_id" text NOT NULL,
	"source_fact_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"run_id" text,
	"original_run_id" text,
	"channel" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"reason_code" text,
	"source_resolved_at" timestamp with time zone,
	CONSTRAINT "agent_incident_occurrence_fact_uq" UNIQUE("source_fact_key","fingerprint"),
	CONSTRAINT "agent_incident_occurrence_channel_check" CHECK ("agent_incident_occurrences"."channel" IN ('operational_terminal','execution_failure','admission_refusal','cleanup') AND ("agent_incident_occurrences"."run_id" IS NULL OR "agent_incident_occurrences"."original_run_id" = "agent_incident_occurrences"."run_id"))
);
--> statement-breakpoint
CREATE TABLE "agent_incident_reader_states" (
	"user_id" text NOT NULL,
	"episode_id" text NOT NULL,
	"attention_revision" integer NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"notification_recorded_at" timestamp with time zone,
	"notification_mode" text,
	"notification_event_id" text,
	CONSTRAINT "agent_incident_reader_states_user_id_episode_id_attention_revision_pk" PRIMARY KEY("user_id","episode_id","attention_revision"),
	CONSTRAINT "agent_incident_reader_receipt_check" CHECK ("agent_incident_reader_states"."attention_revision" > 0 AND (("agent_incident_reader_states"."notification_recorded_at" IS NULL AND "agent_incident_reader_states"."notification_mode" IS NULL AND "agent_incident_reader_states"."notification_event_id" IS NULL) OR ("agent_incident_reader_states"."notification_recorded_at" IS NOT NULL AND "agent_incident_reader_states"."notification_mode" IN ('published','baseline') AND ("agent_incident_reader_states"."notification_mode" <> 'published' OR "agent_incident_reader_states"."notification_event_id" IS NOT NULL))))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "source_agent_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "launched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "activity_sort_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "activity_timestamp_provenance" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_activity_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "agent_incident_episodes" ADD CONSTRAINT "agent_incident_episodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_incident_episodes" ADD CONSTRAINT "agent_incident_episodes_recovery_run_id_runs_id_fk" FOREIGN KEY ("recovery_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_incident_occurrences" ADD CONSTRAINT "agent_incident_occurrences_episode_id_agent_incident_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."agent_incident_episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_incident_occurrences" ADD CONSTRAINT "agent_incident_occurrences_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_incident_reader_states" ADD CONSTRAINT "agent_incident_reader_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_incident_reader_states" ADD CONSTRAINT "agent_incident_reader_states_episode_id_agent_incident_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."agent_incident_episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_incident_open_cause_uq" ON "agent_incident_episodes" USING btree ("project_id","source_agent_id","scope_key","fingerprint") WHERE "agent_incident_episodes"."state" = 'open';--> statement-breakpoint
CREATE INDEX "agent_incident_agent_idx" ON "agent_incident_episodes" USING btree ("project_id","source_agent_id","last_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "agent_incident_occurrence_episode_idx" ON "agent_incident_occurrences" USING btree ("episode_id","observed_at","id");--> statement-breakpoint
CREATE INDEX "agent_incident_occurrence_run_idx" ON "agent_incident_occurrences" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_agent_activity_history_idx" ON "runs" USING btree ("project_id","source_agent_id","activity_sort_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "runs"."source_agent_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_activity_snapshot_check" CHECK (("runs"."source_agent_id" IS NULL AND "runs"."agent_activity_snapshot" IS NULL AND "runs"."activity_sort_at" IS NULL AND "runs"."activity_timestamp_provenance" IS NULL) OR ("runs"."source_agent_id" IS NOT NULL AND "runs"."activity_sort_at" IS NOT NULL AND "runs"."activity_timestamp_provenance" IN ('launch','verified_creation','legacy_estimate','migration_estimate') AND ("runs"."activity_timestamp_provenance" <> 'launch' OR "runs"."launched_at" IS NOT NULL) AND ("runs"."agent_activity_snapshot" IS NULL OR (jsonb_typeof("runs"."agent_activity_snapshot") = 'object' AND "runs"."agent_activity_snapshot"->'version' = '1'::jsonb AND "runs"."agent_activity_snapshot"->>'agentId' = "runs"."source_agent_id" AND "runs"."agent_activity_snapshot"->>'definitionSha256' ~ '^[a-f0-9]{64}$'))) IS TRUE);--> statement-breakpoint
CREATE FUNCTION guard_agent_activity_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_agent_id IS NOT NULL AND
     ROW(NEW.source_agent_id, NEW.launched_at, NEW.activity_sort_at,
         NEW.activity_timestamp_provenance, NEW.agent_activity_snapshot)
       IS DISTINCT FROM
     ROW(OLD.source_agent_id, OLD.launched_at, OLD.activity_sort_at,
         OLD.activity_timestamp_provenance, OLD.agent_activity_snapshot) THEN
    RAISE EXCEPTION 'agent activity snapshot is immutable for run %', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'runs_agent_activity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runs_agent_activity_immutable BEFORE UPDATE ON runs
FOR EACH ROW EXECUTE FUNCTION guard_agent_activity_snapshot();
