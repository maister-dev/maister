CREATE TABLE IF NOT EXISTS "project_flow_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"role_ref" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"source" text DEFAULT 'config' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_flow_roles_project_key_uq" UNIQUE("project_id","role_ref")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "actor_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"user_id" text,
	"token_id" text,
	"internal_agent_ref" text,
	"system_key" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_identities_project_user_uq" UNIQUE("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text,
	"node_id" text,
	"step_id" text,
	"hitl_request_id" text,
	"node_attempt_id" text,
	"action_kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"role_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title" text NOT NULL,
	"assignee_actor_id" text,
	"created_by_actor_id" text,
	"completed_by_actor_id" text,
	"evidence_artifact_id" text,
	"branch" text,
	"ref" text,
	"sla_hours" integer,
	"stale_evidence_summary" jsonb,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignments_hitl_request_uq" UNIQUE("hitl_request_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assignment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"event_kind" text NOT NULL,
	"actor_id" text,
	"from_status" text,
	"to_status" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_flow_roles" ADD CONSTRAINT "project_flow_roles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "actor_identities" ADD CONSTRAINT "actor_identities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "actor_identities" ADD CONSTRAINT "actor_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignments" ADD CONSTRAINT "assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignments" ADD CONSTRAINT "assignments_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignments" ADD CONSTRAINT "assignments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignments" ADD CONSTRAINT "assignments_hitl_request_id_hitl_requests_id_fk" FOREIGN KEY ("hitl_request_id") REFERENCES "public"."hitl_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignments" ADD CONSTRAINT "assignments_node_attempt_id_node_attempts_id_fk" FOREIGN KEY ("node_attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignments" ADD CONSTRAINT "assignments_assignee_actor_id_actor_identities_id_fk" FOREIGN KEY ("assignee_actor_id") REFERENCES "public"."actor_identities"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignments" ADD CONSTRAINT "assignments_created_by_actor_id_actor_identities_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actor_identities"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignments" ADD CONSTRAINT "assignments_completed_by_actor_id_actor_identities_id_fk" FOREIGN KEY ("completed_by_actor_id") REFERENCES "public"."actor_identities"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignments" ADD CONSTRAINT "assignments_evidence_artifact_id_artifact_instances_id_fk" FOREIGN KEY ("evidence_artifact_id") REFERENCES "public"."artifact_instances"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_actor_id_actor_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actor_identities"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_flow_roles_project_idx" ON "project_flow_roles" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actor_identities_project_idx" ON "actor_identities" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignments_project_status_idx" ON "assignments" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignments_run_status_idx" ON "assignments" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignments_current_actor_idx" ON "assignments" USING btree ("assignee_actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignments_hitl_request_idx" ON "assignments" USING btree ("hitl_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignment_events_assignment_idx" ON "assignment_events" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignment_events_project_created_idx" ON "assignment_events" USING btree ("project_id","created_at");
