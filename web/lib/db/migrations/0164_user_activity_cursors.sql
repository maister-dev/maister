CREATE TABLE IF NOT EXISTS "user_activity_cursors" (
	"user_id" text PRIMARY KEY NOT NULL,
	"seen_through" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_activity_cursors" ADD CONSTRAINT "user_activity_cursors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
