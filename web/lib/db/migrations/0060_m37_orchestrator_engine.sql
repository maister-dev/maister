ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_kind_check";--> statement-breakpoint
ALTER TABLE "task_relations" DROP CONSTRAINT "task_relations_kind_check";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "parent_run_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "root_run_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "delegation_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "launch_mode" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "persistent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "addressable_key" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "workspace_mode" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "launch_mode" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "delegation_spec" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_root_run_id_runs_id_fk" FOREIGN KEY ("root_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_parent_run_id_idx" ON "runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_root_run_id_idx" ON "runs" USING btree ("root_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runs_root_addressable_key_uq" ON "runs" USING btree ("root_run_id","addressable_key") WHERE "runs"."persistent" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runs_auto_task_uq" ON "runs" USING btree ("task_id") WHERE "runs"."launch_mode" = 'auto';--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_kind_check" CHECK ("domain_events"."kind" in ('task.created', 'task.comment_added', 'task.triage_requeued', 'run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'run.review', 'run.escalated', 'gate.failed'));--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_kind_check" CHECK ("task_relations"."kind" in ('blocks', 'depends_on', 'parent_of', 'requires'));