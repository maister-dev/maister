CREATE TABLE "attention_publication_states" (
	"owner_user_id" text PRIMARY KEY NOT NULL,
	"projection_version" integer DEFAULT 1 NOT NULL,
	"decisions" integer NOT NULL,
	"ordinary_decisions" integer NOT NULL,
	"notification_event_id" text,
	"initialized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attention_publication_state_check" CHECK ("attention_publication_states"."projection_version" = 1 AND "attention_publication_states"."decisions" >= 0 AND "attention_publication_states"."ordinary_decisions" >= 0 AND "attention_publication_states"."ordinary_decisions" <= "attention_publication_states"."decisions")
);
--> statement-breakpoint
ALTER TABLE "attention_publication_states" ADD CONSTRAINT "attention_publication_states_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- An empty installation has no project-scoped attention to reclassify. Seed its
-- bootstrap readers at zero in the migration transaction; existing projects
-- still require the fenced, canonical backfill owner.
INSERT INTO attention_publication_states(owner_user_id,decisions,ordinary_decisions)
SELECT id,0,0 FROM users WHERE NOT EXISTS(SELECT 1 FROM projects)
ON CONFLICT(owner_user_id) DO NOTHING;
--> statement-breakpoint
-- One projection fact for every agent lifecycle writer, including direct scheduler/park/recovery transitions.
CREATE FUNCTION maister_emit_agent_activity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS NOT NULL AND (NEW.run_kind='agent' OR NEW.source_agent_id IS NOT NULL)
    AND (TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.checkpoint_at IS DISTINCT FROM OLD.checkpoint_at
      OR NEW.execution_assignment_id IS DISTINCT FROM OLD.execution_assignment_id) THEN
    INSERT INTO domain_events(kind,project_id,run_id,actor_type,occurred_at,payload)
    VALUES ('agent.activity_changed',NEW.project_id,NEW.id,'system',clock_timestamp(),
      jsonb_build_object('projectId',NEW.project_id,'agentId',NEW.source_agent_id,
        'runId',NEW.id,'status',NEW.status));
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_agent_activity_changed AFTER INSERT OR UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION maister_emit_agent_activity_change();
