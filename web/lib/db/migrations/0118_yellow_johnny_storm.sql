ALTER TABLE "authored_capabilities" ADD COLUMN "locked_by_user_id" text;--> statement-breakpoint
ALTER TABLE "authored_capabilities" ADD COLUMN "locked_by_session" text;--> statement-breakpoint
ALTER TABLE "authored_capabilities" ADD COLUMN "lock_expires_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "authored_capabilities" ADD CONSTRAINT "authored_capabilities_locked_by_user_id_users_id_fk" FOREIGN KEY ("locked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
