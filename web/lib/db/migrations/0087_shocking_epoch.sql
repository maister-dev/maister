ALTER TABLE "projects" ADD COLUMN "task_queue_settings" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "resume_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "queue_admitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "triage_confidence" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "queue_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "queue_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_priority_check" CHECK ("tasks"."priority" in ('low', 'normal', 'high', 'urgent'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_triage_confidence_check" CHECK ("tasks"."triage_confidence" is null or ("tasks"."triage_confidence" >= 0 and "tasks"."triage_confidence" <= 1));