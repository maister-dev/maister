ALTER TABLE "project_tokens" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "token_audit_log" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "token_audit_log" DROP CONSTRAINT IF EXISTS "token_audit_log_project_id_projects_id_fk";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_audit_log" ADD CONSTRAINT "token_audit_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_tokens_owner_created_idx" ON "project_tokens" USING btree ("owner_user_id","created_at");--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_project_kind_project_check" CHECK ("token_kind" != 'project' OR "project_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_agent_project_check" CHECK ("token_kind" != 'agent' OR ("project_id" IS NOT NULL AND "agent_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_user_owner_check" CHECK ("token_kind" != 'user' OR "owner_user_id" IS NOT NULL);
