ALTER TABLE "flows" ADD COLUMN "executor_override_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flows" ADD CONSTRAINT "flows_executor_override_id_executors_id_fk" FOREIGN KEY ("executor_override_id") REFERENCES "public"."executors"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
