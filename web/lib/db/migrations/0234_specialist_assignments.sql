CREATE TABLE "specialist_assignments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"company_id" text,
	"project_id" text,
	"specialist_binding_id" text NOT NULL,
	"requester" jsonb NOT NULL,
	"responsible" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"input_revision" integer DEFAULT 1 NOT NULL,
	"context_revision" integer DEFAULT 0 NOT NULL,
	"origin" jsonb NOT NULL,
	"destination" jsonb NOT NULL,
	"blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acceptance_id" text,
	"terminal_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_assignments_owner_check" CHECK (("specialist_assignments"."company_id" IS NOT NULL AND "specialist_assignments"."project_id" IS NULL) OR ("specialist_assignments"."company_id" IS NULL AND "specialist_assignments"."project_id" IS NOT NULL)),
	CONSTRAINT "specialist_assignments_revision_check" CHECK ("specialist_assignments"."revision">0 AND "specialist_assignments"."input_revision">0 AND "specialist_assignments"."context_revision">=0),
	CONSTRAINT "specialist_assignments_state_check" CHECK ("specialist_assignments"."status" IN ('queued','active','waiting_input','waiting_children','waiting_resource','reconciling','awaiting_acceptance','completed','failed','cancelled')),
	CONSTRAINT "specialist_assignments_requester_check" CHECK ((CASE WHEN jsonb_typeof("specialist_assignments"."requester")='object' THEN
    "specialist_assignments"."requester" ?& ARRAY['kind','id','runId','attemptId']
    AND "specialist_assignments"."requester" - ARRAY['kind','id','runId','attemptId']='{}'::jsonb
    AND "specialist_assignments"."requester"->>'kind' IN ('user','agent','system')
    AND jsonb_typeof("specialist_assignments"."requester"->'id')='string'
    AND char_length("specialist_assignments"."requester"->>'id') BETWEEN 1 AND 192
    AND ("specialist_assignments"."requester"->'runId'='null'::jsonb OR (jsonb_typeof("specialist_assignments"."requester"->'runId')='string' AND char_length("specialist_assignments"."requester"->>'runId') BETWEEN 1 AND 128))
    AND ("specialist_assignments"."requester"->'attemptId'='null'::jsonb OR (jsonb_typeof("specialist_assignments"."requester"->'attemptId')='string' AND char_length("specialist_assignments"."requester"->>'attemptId') BETWEEN 1 AND 128))
    ELSE false END) IS TRUE),
	CONSTRAINT "specialist_assignments_responsible_check" CHECK ((CASE WHEN jsonb_typeof("specialist_assignments"."responsible")='object' THEN
    "specialist_assignments"."responsible" ?& ARRAY['kind','id','runId','attemptId']
    AND "specialist_assignments"."responsible" - ARRAY['kind','id','runId','attemptId']='{}'::jsonb
    AND "specialist_assignments"."responsible"->>'kind' IN ('user','agent','system')
    AND jsonb_typeof("specialist_assignments"."responsible"->'id')='string'
    AND char_length("specialist_assignments"."responsible"->>'id') BETWEEN 1 AND 192
    AND ("specialist_assignments"."responsible"->'runId'='null'::jsonb OR (jsonb_typeof("specialist_assignments"."responsible"->'runId')='string' AND char_length("specialist_assignments"."responsible"->>'runId') BETWEEN 1 AND 128))
    AND ("specialist_assignments"."responsible"->'attemptId'='null'::jsonb OR (jsonb_typeof("specialist_assignments"."responsible"->'attemptId')='string' AND char_length("specialist_assignments"."responsible"->>'attemptId') BETWEEN 1 AND 128))
    ELSE false END) IS TRUE AND "specialist_assignments"."responsible"->>'kind'='agent' AND "specialist_assignments"."responsible"->'runId'='null'::jsonb AND "specialist_assignments"."responsible"->'attemptId'='null'::jsonb),
	CONSTRAINT "specialist_assignments_binding_check" CHECK (char_length("specialist_assignments"."specialist_binding_id") BETWEEN 1 AND 128),
	CONSTRAINT "specialist_assignments_metadata_check" CHECK ((jsonb_typeof("specialist_assignments"."origin")='object' AND jsonb_typeof("specialist_assignments"."destination")='object' AND jsonb_typeof("specialist_assignments"."blockers")='array' AND pg_column_size("specialist_assignments"."origin")<=8192 AND pg_column_size("specialist_assignments"."destination")<=8192 AND pg_column_size("specialist_assignments"."blockers")<=131072) IS TRUE),
	CONSTRAINT "specialist_assignments_terminal_check" CHECK ((("specialist_assignments"."status"='completed' AND "specialist_assignments"."acceptance_id" IS NOT NULL AND "specialist_assignments"."completed_at" IS NOT NULL AND "specialist_assignments"."terminal_reason" IS NULL) OR ("specialist_assignments"."status" IN ('failed','cancelled') AND "specialist_assignments"."acceptance_id" IS NULL AND "specialist_assignments"."completed_at" IS NULL AND "specialist_assignments"."terminal_reason" ~ '[^[:space:]]' AND char_length("specialist_assignments"."terminal_reason")<=2000) OR ("specialist_assignments"."status" NOT IN ('completed','failed','cancelled') AND "specialist_assignments"."acceptance_id" IS NULL AND "specialist_assignments"."completed_at" IS NULL AND "specialist_assignments"."terminal_reason" IS NULL)) IS TRUE),
	CONSTRAINT "specialist_assignments_completion_unavailable_check" CHECK ("specialist_assignments"."status"<>'completed')
);
--> statement-breakpoint
CREATE TABLE "specialist_input_revisions" (
	"assignment_id" text NOT NULL,
	"revision" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"objective_input" jsonb NOT NULL,
	"standing_definition" jsonb NOT NULL,
	"scheduled_request" jsonb,
	"authority_snapshot" jsonb NOT NULL,
	"source_restrictions" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_input_revisions_assignment_id_revision_pk" PRIMARY KEY("assignment_id","revision"),
	CONSTRAINT "specialist_input_revisions_version_check" CHECK ("specialist_input_revisions"."revision">0 AND "specialist_input_revisions"."schema_version"=1),
	CONSTRAINT "specialist_input_revisions_planes_check" CHECK ((
    jsonb_typeof("specialist_input_revisions"."objective_input")='object'
    AND "specialist_input_revisions"."objective_input" ?& ARRAY['objective','expectedOutcome','input','targetIds','inputRefs','constraints','expectedResult','verification']
    AND "specialist_input_revisions"."objective_input" - ARRAY['objective','expectedOutcome','input','targetIds','inputRefs','constraints','expectedResult','verification']='{}'::jsonb
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'objective')='string'
    AND char_length("specialist_input_revisions"."objective_input"->>'objective') BETWEEN 1 AND 8000
    AND "specialist_input_revisions"."objective_input"->>'objective' ~ '[^[:space:]]'
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'expectedOutcome')='string'
    AND char_length("specialist_input_revisions"."objective_input"->>'expectedOutcome') BETWEEN 1 AND 4000
    AND "specialist_input_revisions"."objective_input"->>'expectedOutcome' ~ '[^[:space:]]'
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'input')='string'
    AND char_length("specialist_input_revisions"."objective_input"->>'input')<=8000
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'targetIds')='array'
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'inputRefs')='array'
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'constraints')='array'
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'expectedResult')='object'
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'verification')='array'
    AND pg_column_size("specialist_input_revisions"."objective_input")<=262144
    AND jsonb_typeof("specialist_input_revisions"."standing_definition")='object' AND "specialist_input_revisions"."standing_definition"->'schemaVersion'='1'::jsonb
    AND jsonb_typeof("specialist_input_revisions"."standing_definition"->'definition')='object'
    AND jsonb_typeof("specialist_input_revisions"."standing_definition"->'agentId')='string'
    AND jsonb_typeof("specialist_input_revisions"."standing_definition"->'packageInstallId')='string'
    AND jsonb_typeof("specialist_input_revisions"."standing_definition"->'packageRevision')='string'
    AND "specialist_input_revisions"."standing_definition"->>'definitionSha256' ~ '^[a-f0-9]{64}$'
    AND pg_column_size("specialist_input_revisions"."standing_definition")<=2097152
    AND jsonb_typeof("specialist_input_revisions"."authority_snapshot")='object' AND "specialist_input_revisions"."authority_snapshot"->'schemaVersion'='1'::jsonb
    AND jsonb_typeof("specialist_input_revisions"."authority_snapshot"->'actor')='object'
    AND jsonb_typeof("specialist_input_revisions"."authority_snapshot"->'witnesses')='array'
    AND jsonb_typeof("specialist_input_revisions"."authority_snapshot"->'executionPolicy')='object'
    AND pg_column_size("specialist_input_revisions"."authority_snapshot")<=262144
    AND jsonb_typeof("specialist_input_revisions"."source_restrictions")='array' AND pg_column_size("specialist_input_revisions"."source_restrictions")<=131072
  ) IS TRUE),
	CONSTRAINT "specialist_input_revisions_actor_check" CHECK ((CASE WHEN jsonb_typeof("specialist_input_revisions"."actor")='object' THEN
    "specialist_input_revisions"."actor" ?& ARRAY['kind','id','runId','attemptId']
    AND "specialist_input_revisions"."actor" - ARRAY['kind','id','runId','attemptId']='{}'::jsonb
    AND "specialist_input_revisions"."actor"->>'kind' IN ('user','agent','system')
    AND jsonb_typeof("specialist_input_revisions"."actor"->'id')='string'
    AND char_length("specialist_input_revisions"."actor"->>'id') BETWEEN 1 AND 192
    AND ("specialist_input_revisions"."actor"->'runId'='null'::jsonb OR (jsonb_typeof("specialist_input_revisions"."actor"->'runId')='string' AND char_length("specialist_input_revisions"."actor"->>'runId') BETWEEN 1 AND 128))
    AND ("specialist_input_revisions"."actor"->'attemptId'='null'::jsonb OR (jsonb_typeof("specialist_input_revisions"."actor"->'attemptId')='string' AND char_length("specialist_input_revisions"."actor"->>'attemptId') BETWEEN 1 AND 128))
    ELSE false END) IS TRUE),
	CONSTRAINT "specialist_input_revisions_digest_check" CHECK ("specialist_input_revisions"."digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "specialist_input_revisions_scheduled_check" CHECK (("specialist_input_revisions"."scheduled_request" IS NULL OR CASE WHEN jsonb_typeof("specialist_input_revisions"."scheduled_request") = 'object' THEN (
    "specialist_input_revisions"."scheduled_request" ?& ARRAY['version','scheduleId','triggerAttemptId','requestAtLaunch']
    AND "specialist_input_revisions"."scheduled_request" - ARRAY['version','scheduleId','triggerAttemptId','requestAtLaunch'] = '{}'::jsonb
    AND "specialist_input_revisions"."scheduled_request"->'version' = '1'::jsonb
    AND jsonb_typeof("specialist_input_revisions"."scheduled_request"->'scheduleId') = 'string'
    AND char_length("specialist_input_revisions"."scheduled_request"->>'scheduleId') BETWEEN 1 AND 256
    AND jsonb_typeof("specialist_input_revisions"."scheduled_request"->'triggerAttemptId') = 'string'
    AND char_length("specialist_input_revisions"."scheduled_request"->>'triggerAttemptId') BETWEEN 1 AND 256
    AND ("specialist_input_revisions"."scheduled_request"->'requestAtLaunch' = 'null'::jsonb OR (
      jsonb_typeof("specialist_input_revisions"."scheduled_request"->'requestAtLaunch') = 'string'
      AND char_length("specialist_input_revisions"."scheduled_request"->>'requestAtLaunch') BETWEEN 1 AND 8000
    ))) ELSE false END) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "specialist_run_links" (
	"assignment_id" text NOT NULL,
	"run_id" text NOT NULL,
	"input_revision" integer NOT NULL,
	"role" text NOT NULL,
	"work_id" text,
	"work_revision" integer,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_run_links_assignment_id_run_id_pk" PRIMARY KEY("assignment_id","run_id"),
	CONSTRAINT "specialist_run_links_run_uq" UNIQUE("run_id"),
	CONSTRAINT "specialist_run_links_shape_check" CHECK (("specialist_run_links"."input_revision">0 AND "specialist_run_links"."role" IN ('coordinator','specialist','child','continuation') AND (("specialist_run_links"."work_id" IS NULL AND "specialist_run_links"."work_revision" IS NULL) OR ("specialist_run_links"."work_id" IS NOT NULL AND "specialist_run_links"."work_revision" IS NOT NULL AND char_length("specialist_run_links"."work_id") BETWEEN 1 AND 128 AND "specialist_run_links"."work_revision">0))) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_kind_check";--> statement-breakpoint
ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_company_kind_check";--> statement-breakpoint
ALTER TABLE "specialist_assignments" ADD CONSTRAINT "specialist_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_assignments" ADD CONSTRAINT "specialist_assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_input_revisions" ADD CONSTRAINT "specialist_input_revisions_assignment_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."specialist_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_run_links" ADD CONSTRAINT "specialist_run_links_assignment_id_specialist_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."specialist_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_run_links" ADD CONSTRAINT "specialist_run_links_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_run_links" ADD CONSTRAINT "specialist_run_links_input_fk" FOREIGN KEY ("assignment_id","input_revision") REFERENCES "public"."specialist_input_revisions"("assignment_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "specialist_assignments_company_status_idx" ON "specialist_assignments" USING btree ("company_id","status","updated_at","id");--> statement-breakpoint
CREATE INDEX "specialist_assignments_project_status_idx" ON "specialist_assignments" USING btree ("project_id","status","updated_at","id");--> statement-breakpoint
CREATE INDEX "specialist_assignments_responsible_idx" ON "specialist_assignments" USING btree (("responsible"->>'id'),"updated_at","id");--> statement-breakpoint
CREATE INDEX "specialist_run_links_input_idx" ON "specialist_run_links" USING btree ("assignment_id","input_revision","linked_at","run_id");--> statement-breakpoint
CREATE INDEX "domain_events_specialist_assignment_idx" ON "domain_events" USING btree (("payload"->>'assignmentId'),"id") WHERE "domain_events"."kind"='specialist.assignment_changed';--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_kind_check" CHECK ("domain_events"."kind" in ('knowledge.record_changed', 'specialist.assignment_changed', 'agent.activity_changed', 'agent.incident_changed', 'task.qualification_changed', 'task.created', 'task.comment_added', 'task.triage_requeued', 'task.clarification_requested', 'task.clarification_answered', 'task.clarification_cancelled', 'run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'run.review', 'run.review_opened', 'run.needs_input', 'run.escalated', 'run.rework_claimed', 'run.rework_returned', 'gate.failed', 'run.operational_attention_acknowledged', 'run.operational_cleanup_changed'));--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_company_kind_check" CHECK ("domain_events"."company_id" IS NULL OR ("domain_events"."kind" IN ('knowledge.record_changed','specialist.assignment_changed') AND "domain_events"."task_id" IS NULL AND "domain_events"."run_id" IS NULL));
--> statement-breakpoint
CREATE FUNCTION guard_specialist_input_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Specialist input snapshots are immutable; append a new input revision'
    USING ERRCODE='23514', CONSTRAINT='specialist_input_revisions_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER specialist_input_revisions_immutable
BEFORE UPDATE OR DELETE ON specialist_input_revisions
FOR EACH ROW EXECUTE FUNCTION guard_specialist_input_history();
--> statement-breakpoint
CREATE FUNCTION guard_specialist_assignment_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.company_id,NEW.project_id,NEW.specialist_binding_id,NEW.requester,NEW.responsible,NEW.origin,NEW.destination,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.project_id,OLD.specialist_binding_id,OLD.requester,OLD.responsible,OLD.origin,OLD.destination,OLD.created_at) THEN
    RAISE EXCEPTION 'Assignment ownership, responsibility, origin and destination are immutable'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_identity_immutable';
  END IF;
  IF NEW.revision<>OLD.revision+1
    OR NEW.input_revision NOT IN (OLD.input_revision,OLD.input_revision+1)
    OR NEW.context_revision NOT IN (OLD.context_revision,OLD.context_revision+1) THEN
    RAISE EXCEPTION 'Assignment changes require the next business revision and coherent input/context heads'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_head_revision';
  END IF;
  IF OLD.status='completed' THEN
    RAISE EXCEPTION 'A completed assignment cannot be changed; submit independent work'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_completed_immutable';
  END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='queued' AND NEW.status IN ('active','waiting_input','failed','cancelled'))
    OR (OLD.status='active' AND NEW.status IN ('waiting_input','waiting_children','waiting_resource','reconciling','awaiting_acceptance','failed','cancelled'))
    OR (OLD.status='waiting_input' AND NEW.status IN ('queued','failed','cancelled'))
    OR (OLD.status='waiting_children' AND NEW.status IN ('queued','failed','cancelled'))
    OR (OLD.status='waiting_resource' AND NEW.status IN ('queued','reconciling','failed','cancelled'))
    OR (OLD.status='reconciling' AND NEW.status IN ('queued','awaiting_acceptance','failed','cancelled'))
    OR (OLD.status='awaiting_acceptance' AND NEW.status IN ('queued','completed','failed','cancelled'))
    OR (OLD.status IN ('failed','cancelled') AND NEW.status IN ('queued','reconciling'))
  ) THEN
    RAISE EXCEPTION 'The requested assignment state transition is not allowed'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER specialist_assignments_head_guard
BEFORE UPDATE ON specialist_assignments
FOR EACH ROW EXECUTE FUNCTION guard_specialist_assignment_head();
--> statement-breakpoint
CREATE FUNCTION assert_specialist_input_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM specialist_assignments WHERE id=NEW.id)
    AND NOT EXISTS(SELECT 1 FROM specialist_input_revisions WHERE assignment_id=NEW.id AND revision=NEW.input_revision) THEN
    RAISE EXCEPTION 'An assignment head must reference its retained input revision'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_input_head';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER specialist_assignments_input_head
AFTER INSERT OR UPDATE ON specialist_assignments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_specialist_input_head();
--> statement-breakpoint
CREATE FUNCTION guard_specialist_run_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Assignment execution links are immutable; retain the existing run and input identity'
    USING ERRCODE='23514', CONSTRAINT='specialist_run_links_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER specialist_run_links_immutable
BEFORE UPDATE OR DELETE ON specialist_run_links
FOR EACH ROW EXECUTE FUNCTION guard_specialist_run_link();
