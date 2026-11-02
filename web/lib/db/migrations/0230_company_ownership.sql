SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"installation_singleton" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_installation_singleton_unique" UNIQUE("installation_singleton"),
	CONSTRAINT "companies_singleton_check" CHECK ("companies"."installation_singleton" = true)
);
--> statement-breakpoint
CREATE TABLE "company_grants" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"company_id" text NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"action" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"confirmation_classes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "company_grants_principal_check" CHECK ("company_grants"."principal_type" IN ('user','agent','system') AND length("company_grants"."principal_id") BETWEEN 1 AND 128),
	CONSTRAINT "company_grants_action_check" CHECK ("company_grants"."action" IN ('knowledge:read', 'knowledge:propose', 'knowledge:review', 'knowledge:confirm', 'knowledge:manage', 'specialists:read', 'specialists:manage', 'assignments:read', 'assignments:submit', 'assignments:update', 'assignments:answer', 'assignments:accept', 'assignments:cancel', 'assignments:recover', 'assignments:delegate', 'targets:read', 'targets:logs', 'targets:restart', 'targets:recover', 'targets:manage')),
	CONSTRAINT "company_grants_revision_check" CHECK ("company_grants"."revision" > 0),
	CONSTRAINT "company_grants_confirmation_check" CHECK (jsonb_typeof("company_grants"."confirmation_classes") = 'array' AND "company_grants"."confirmation_classes" <@ '["assertion","observation","decision","procedure"]'::jsonb AND ("company_grants"."action" = 'knowledge:confirm' OR "company_grants"."confirmation_classes" = '[]'::jsonb))
);
--> statement-breakpoint
ALTER TABLE "company_grants" ADD CONSTRAINT "company_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_grants" ADD CONSTRAINT "company_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_grants_live_principal_action_unique" ON "company_grants" USING btree ("company_id","principal_type","principal_id","action") WHERE "company_grants"."revoked_at" IS NULL;
--> statement-breakpoint
-- Installation identity is repository-independent; no content access is seeded.
INSERT INTO companies (installation_singleton) VALUES (true) ON CONFLICT (installation_singleton) DO NOTHING;
