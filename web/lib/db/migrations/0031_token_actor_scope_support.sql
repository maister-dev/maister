-- Token actor/scope support: user-owned project tokens, task attribution, and
-- owner lookup for token-management/audit surfaces.
ALTER TABLE "project_tokens" ADD COLUMN IF NOT EXISTS "token_kind" text DEFAULT 'project' NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN IF NOT EXISTS "owner_user_id" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "actor_identities" DROP CONSTRAINT IF EXISTS "actor_identities_project_user_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "actor_identities_project_user_uq" ON "actor_identities" USING btree ("project_id","user_id") WHERE "actor_identities"."kind" = 'user';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_tokens_owner_idx" ON "project_tokens" USING btree ("owner_user_id");
