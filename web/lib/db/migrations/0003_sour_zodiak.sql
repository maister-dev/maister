ALTER TABLE "flows" ADD COLUMN "revision" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "flow_revision" text DEFAULT 'unknown' NOT NULL;