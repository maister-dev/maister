SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_kind_check";--> statement-breakpoint
ALTER TABLE "domain_events" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_events" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "knowledge_access" jsonb;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_events_company_kind_id_idx" ON "domain_events" USING btree ("company_id","kind","id") WHERE "domain_events"."company_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_owner_check" CHECK (("domain_events"."project_id" IS NULL) <> ("domain_events"."company_id" IS NULL));--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_company_kind_check" CHECK ("domain_events"."company_id" IS NULL OR ("domain_events"."kind"='knowledge.record_changed' AND "domain_events"."task_id" IS NULL AND "domain_events"."run_id" IS NULL));--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_kind_check" CHECK ("domain_events"."kind" in ('knowledge.record_changed', 'agent.activity_changed', 'agent.incident_changed', 'task.qualification_changed', 'task.created', 'task.comment_added', 'task.triage_requeued', 'task.clarification_requested', 'task.clarification_answered', 'task.clarification_cancelled', 'run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'run.review', 'run.review_opened', 'run.needs_input', 'run.escalated', 'run.rework_claimed', 'run.rework_returned', 'gate.failed', 'run.operational_attention_acknowledged', 'run.operational_cleanup_changed'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_knowledge_access_check" CHECK ("runs"."knowledge_access" IS NULL OR (jsonb_typeof("runs"."knowledge_access")='object' AND "runs"."knowledge_access"->'schemaVersion'='1'::jsonb AND "runs"."knowledge_access"->>'state' IN ('capturing','complete','unknown') AND jsonb_typeof("runs"."knowledge_access"->'generation')='number' AND "runs"."knowledge_access"->>'generation' ~ '^[1-9][0-9]*$' AND jsonb_typeof("runs"."knowledge_access"->'restrictions')='array') IS TRUE);