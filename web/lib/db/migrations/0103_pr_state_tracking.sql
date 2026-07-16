ALTER TABLE "inbox_items" DROP CONSTRAINT "inbox_items_event_kind_check";--> statement-breakpoint
ALTER TABLE "task_activity" DROP CONSTRAINT "task_activity_event_kind_check";--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "pr_state" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "pr_has_conflicts" boolean;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "pr_merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "pr_merge_commit_sha" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_pr_state_scan_idx" ON "workspaces" USING btree ("project_id") WHERE "workspaces"."pr_url" is not null and ("workspaces"."pr_state" is null or "workspaces"."pr_state" = 'open');--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_event_kind_check" CHECK ("inbox_items"."event_kind" in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched', 'triage_set', 'triage_requeued', 'agent_quarantined', 'experiment_concluded', 'run_pr_merged'));--> statement-breakpoint
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_event_kind_check" CHECK ("task_activity"."event_kind" in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched', 'triage_set', 'triage_requeued', 'agent_quarantined', 'experiment_concluded', 'run_pr_merged'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_pr_state_check" CHECK ("workspaces"."pr_state" in ('open', 'merged', 'closed'));