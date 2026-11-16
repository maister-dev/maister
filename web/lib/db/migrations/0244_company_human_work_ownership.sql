ALTER TABLE "actor_identities" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assignment_events" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assignments" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "actor_identities" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "assignment_events" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "actor_identities" ADD CONSTRAINT "actor_identities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "actor_identities_company_user_uq" ON "actor_identities" USING btree ("company_id","user_id") WHERE "actor_identities"."company_id" IS NOT NULL AND "actor_identities"."kind"='user';--> statement-breakpoint
CREATE UNIQUE INDEX "actor_identities_company_system_uq" ON "actor_identities" USING btree ("company_id","system_key") WHERE "actor_identities"."company_id" IS NOT NULL AND "actor_identities"."kind"='system';--> statement-breakpoint
CREATE INDEX "actor_identities_company_idx" ON "actor_identities" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "assignment_events_company_created_idx" ON "assignment_events" USING btree ("company_id","created_at","id") WHERE "assignment_events"."company_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "assignments_company_status_idx" ON "assignments" USING btree ("company_id","status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "assignments"."company_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "actor_identities" ADD CONSTRAINT "actor_identities_owner_shape" CHECK (("actor_identities"."project_id" IS NOT NULL) <> ("actor_identities"."company_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "actor_identities" ADD CONSTRAINT "actor_identities_company_kind" CHECK ("actor_identities"."company_id" IS NULL OR "actor_identities"."kind" IN ('user','system'));--> statement-breakpoint
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_owner_shape" CHECK (("assignment_events"."project_id" IS NOT NULL) <> ("assignment_events"."company_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_owner_shape" CHECK (("assignments"."project_id" IS NOT NULL) <> ("assignments"."company_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_company_shape" CHECK ("assignments"."company_id" IS NULL OR ("assignments"."task_id" IS NULL AND "assignments"."branch" IS NULL AND "assignments"."ref" IS NULL));