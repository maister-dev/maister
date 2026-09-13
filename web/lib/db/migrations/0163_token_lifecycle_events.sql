CREATE TABLE IF NOT EXISTS "token_lifecycle_events" (
	"id" text PRIMARY KEY NOT NULL,
	"token_id" text NOT NULL,
	"project_id" text,
	"event" text NOT NULL,
	"actor_user_id" text,
	"actor_label" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_lifecycle_events" ADD CONSTRAINT "token_lifecycle_events_token_id_project_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."project_tokens"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_lifecycle_events" ADD CONSTRAINT "token_lifecycle_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_lifecycle_events" ADD CONSTRAINT "token_lifecycle_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_lifecycle_token_created_idx" ON "token_lifecycle_events" USING btree ("token_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_lifecycle_project_created_idx" ON "token_lifecycle_events" USING btree ("project_id","created_at");