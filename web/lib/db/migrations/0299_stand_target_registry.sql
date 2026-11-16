CREATE TABLE "stand_components" (
	"target_id" text NOT NULL,
	"config_revision" integer NOT NULL,
	"component_id" text NOT NULL,
	"canonical_resource_key" text NOT NULL,
	"config" jsonb NOT NULL,
	"runbook_sha256" text NOT NULL,
	CONSTRAINT "stand_components_target_id_config_revision_component_id_pk" PRIMARY KEY("target_id","config_revision","component_id"),
	CONSTRAINT "stand_components_shape_check" CHECK (("stand_components"."component_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND "stand_components"."canonical_resource_key" ~ '^[a-f0-9]{64}$' AND "stand_components"."runbook_sha256" ~ '^[a-f0-9]{64}$' AND "stand_components"."config"->>'id'="stand_components"."component_id") IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "stand_target_revisions" (
	"target_id" text NOT NULL,
	"revision" integer NOT NULL,
	"enabled" boolean NOT NULL,
	"connection" jsonb NOT NULL,
	"component_ids" jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"authority" jsonb NOT NULL,
	"delivery_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stand_target_revisions_target_id_revision_pk" PRIMARY KEY("target_id","revision"),
	CONSTRAINT "stand_target_revisions_actor_delivery_unique" UNIQUE("actor_id","delivery_key"),
	CONSTRAINT "stand_target_revisions_shape_check" CHECK ("stand_target_revisions"."revision">0 AND "stand_target_revisions"."request_digest" ~ '^[a-f0-9]{64}$' AND "stand_target_revisions"."delivery_key" ~ '^[A-Za-z0-9._:-]{8,128}$' AND jsonb_typeof("stand_target_revisions"."connection")='object' AND jsonb_typeof("stand_target_revisions"."authority")='object' AND jsonb_typeof("stand_target_revisions"."component_ids")='array' AND jsonb_array_length("stand_target_revisions"."component_ids") BETWEEN 1 AND 32)
);
--> statement-breakpoint
CREATE TABLE "stand_targets" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"company_id" text NOT NULL,
	"incarnation_id" text NOT NULL,
	"config_revision" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stand_targets_company_incarnation_unique" UNIQUE("company_id","incarnation_id"),
	CONSTRAINT "stand_targets_revision_check" CHECK ("stand_targets"."config_revision">0),
	CONSTRAINT "stand_targets_incarnation_check" CHECK ("stand_targets"."incarnation_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
--> statement-breakpoint
ALTER TABLE "stand_components" ADD CONSTRAINT "stand_components_target_revision_fk" FOREIGN KEY ("target_id","config_revision") REFERENCES "public"."stand_target_revisions"("target_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_target_revisions" ADD CONSTRAINT "stand_target_revisions_target_id_stand_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."stand_targets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_target_revisions" ADD CONSTRAINT "stand_target_revisions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_targets" ADD CONSTRAINT "stand_targets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stand_targets_company_created_idx" ON "stand_targets" USING btree ("company_id","created_at","id");