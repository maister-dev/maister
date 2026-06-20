ALTER TABLE "task_relations" DROP CONSTRAINT "task_relations_kind_check";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "parent_run_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "root_run_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "delegation_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "launch_mode" text;--> statement-breakpoint
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
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_kind_check" CHECK ("task_relations"."kind" in ('blocks', 'depends_on', 'parent_of', 'requires'));