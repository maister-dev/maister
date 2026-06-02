CREATE TABLE IF NOT EXISTS "artifact_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_attempt_id" text,
	"node_id" text,
	"attempt" integer,
	"artifact_def_id" text,
	"kind" text NOT NULL,
	"producer" text NOT NULL,
	"locator" jsonb NOT NULL,
	"uri" text,
	"hash" text,
	"size_bytes" integer,
	"validity" text DEFAULT 'current' NOT NULL,
	"required_for" jsonb,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"retention" text DEFAULT 'run' NOT NULL,
	"monotonic_id" integer,
	"superseded_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifact_projection_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"scope" text NOT NULL,
	"events_log_path" text NOT NULL,
	"last_monotonic_id" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_projection_cursors_run_scope_uq" UNIQUE("run_id","scope")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifact_instances" ADD CONSTRAINT "artifact_instances_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifact_instances" ADD CONSTRAINT "artifact_instances_node_attempt_id_node_attempts_id_fk" FOREIGN KEY ("node_attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifact_instances" ADD CONSTRAINT "artifact_instances_superseded_by_id_artifact_instances_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."artifact_instances"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifact_projection_cursors" ADD CONSTRAINT "artifact_projection_cursors_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_instances_run_idx" ON "artifact_instances" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_instances_node_attempt_idx" ON "artifact_instances" USING btree ("node_attempt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_instances_run_kind_idx" ON "artifact_instances" USING btree ("run_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_instances_run_validity_idx" ON "artifact_instances" USING btree ("run_id","validity");