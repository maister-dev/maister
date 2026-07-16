CREATE TABLE IF NOT EXISTS "evaluation_launch_batch_items" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"replicate_ordinal" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_id" text,
	"participant_id" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_launch_batch_items_item_uq" UNIQUE("batch_id","recipe_id","replicate_ordinal"),
	CONSTRAINT "evaluation_launch_batch_items_status_check" CHECK ("evaluation_launch_batch_items"."status" in ('queued', 'launching', 'launched', 'failed')),
	CONSTRAINT "evaluation_launch_batch_items_replicate_positive_check" CHECK ("evaluation_launch_batch_items"."replicate_ordinal" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_launch_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text,
	"requested_by_user_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "evaluation_launch_batches_idempotency_uq" UNIQUE("idempotency_key"),
	CONSTRAINT "evaluation_launch_batches_status_check" CHECK ("evaluation_launch_batches"."status" in ('queued', 'launching', 'completed', 'partial', 'failed'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_launch_batch_items" ADD CONSTRAINT "evaluation_launch_batch_items_batch_id_evaluation_launch_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."evaluation_launch_batches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_launch_batch_items" ADD CONSTRAINT "evaluation_launch_batch_items_recipe_id_evaluation_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."evaluation_recipes"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_launch_batch_items" ADD CONSTRAINT "evaluation_launch_batch_items_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_launch_batch_items" ADD CONSTRAINT "evaluation_launch_batch_items_participant_id_evaluation_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."evaluation_participants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_launch_batches" ADD CONSTRAINT "evaluation_launch_batches_study_id_evaluation_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."evaluation_studies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_launch_batches" ADD CONSTRAINT "evaluation_launch_batches_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_launch_batch_items_batch_idx" ON "evaluation_launch_batch_items" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_launch_batch_items_status_idx" ON "evaluation_launch_batch_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_launch_batches_study_idx" ON "evaluation_launch_batches" USING btree ("study_id");