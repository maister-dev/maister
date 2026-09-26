ALTER TABLE "tasks" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "statement_revision" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "launch_intent" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "created_via_operation_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_via_operation_uq" UNIQUE("created_via_operation_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_launch_intent_check" CHECK ("tasks"."launch_intent" IS NULL OR "tasks"."launch_intent" IN ('none', 'triage_only', 'triage_then_launch'));