CREATE TABLE IF NOT EXISTS "project_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '["*"]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"token_id" text NOT NULL,
	"project_id" text NOT NULL,
	"actor_label" text NOT NULL,
	"scope_used" text NOT NULL,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"result" text NOT NULL,
	"status_code" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_audit_log" ADD CONSTRAINT "token_audit_log_token_id_project_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."project_tokens"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_audit_log" ADD CONSTRAINT "token_audit_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_tokens_prefix_idx" ON "project_tokens" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_tokens_project_idx" ON "project_tokens" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_audit_token_idx" ON "token_audit_log" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_audit_project_created_idx" ON "token_audit_log" USING btree ("project_id","created_at");