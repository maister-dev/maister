CREATE TABLE IF NOT EXISTS "execution_projection_backfills" (
	"consumer_name" text PRIMARY KEY NOT NULL,
	"after_run_id" text,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_event_consumers" ADD COLUMN "last_served_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_event_consumers_service_idx" ON "execution_event_consumers" USING btree ("last_served_at" NULLS FIRST,"run_id","consumer_name") WHERE "execution_event_consumers"."state" <> 'poisoned';