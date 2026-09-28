ALTER TABLE "project_tokens" ADD COLUMN "librarian_turn_id" text;--> statement-breakpoint
ALTER TABLE "token_audit_log" ADD COLUMN "on_behalf_of_user_id" text;--> statement-breakpoint
ALTER TABLE "token_audit_log" ADD COLUMN "librarian_turn_id" text;--> statement-breakpoint
ALTER TABLE "token_audit_log" ADD COLUMN "operation_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_audit_log" ADD CONSTRAINT "token_audit_log_on_behalf_of_user_id_users_id_fk" FOREIGN KEY ("on_behalf_of_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_tokens_librarian_turn_idx" ON "project_tokens" USING btree ("librarian_turn_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_audit_librarian_turn_idx" ON "token_audit_log" USING btree ("librarian_turn_id");--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_kind_check" CHECK ("project_tokens"."token_kind" IN ('project', 'user', 'agent', 'librarian'));--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_librarian_check" CHECK ("project_tokens"."token_kind" <> 'librarian' OR ("project_tokens"."owner_user_id" IS NOT NULL AND "project_tokens"."project_id" IS NULL AND "project_tokens"."agent_id" IS NULL AND "project_tokens"."librarian_turn_id" IS NOT NULL AND "project_tokens"."expires_at" IS NOT NULL));