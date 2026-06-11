CREATE TABLE IF NOT EXISTS "domain_event_consumers" (
	"consumer_id" text PRIMARY KEY NOT NULL,
	"cursor_event_id" bigint DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_dispatched_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "domain_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "domain_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text,
	"run_id" text,
	"actor_type" text,
	"actor_id" text,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tx_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "domain_events_kind_check" CHECK ("domain_events"."kind" in ('task.created', 'task.comment_added', 'task.triage_requeued', 'run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'gate.failed')),
	CONSTRAINT "domain_events_actor_type_check" CHECK ("domain_events"."actor_type" in ('user', 'system', 'agent'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
