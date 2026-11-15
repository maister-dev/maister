CREATE TABLE "task_external_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_instance" text NOT NULL,
	"scope_key" text NOT NULL,
	"external_id" text NOT NULL,
	"external_key" text,
	"external_url" text,
	"origin" text NOT NULL,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_external_sources_identity_uq" UNIQUE("project_id","source_kind","source_instance","external_id"),
	CONSTRAINT "task_external_sources_task_uq" UNIQUE("task_id"),
	CONSTRAINT "task_external_sources_shape_check" CHECK (("task_external_sources"."source_kind" ~ '^[a-z][a-z0-9_-]{1,31}$' AND length("task_external_sources"."source_instance") BETWEEN 1 AND 253 AND "task_external_sources"."source_instance" ~ '^[a-z0-9][a-z0-9._-]*$' AND length("task_external_sources"."scope_key") BETWEEN 1 AND 256 AND length("task_external_sources"."external_id") BETWEEN 1 AND 256 AND ("task_external_sources"."external_key" IS NULL OR length("task_external_sources"."external_key") BETWEEN 1 AND 64) AND ("task_external_sources"."external_url" IS NULL OR (length("task_external_sources"."external_url") <= 2048 AND "task_external_sources"."external_url" ~ '^https://[^/@[:space:]]+(/|$)')) AND "task_external_sources"."origin" IN ('import','backfill','manual') AND "task_external_sources"."created_by_actor_type" IN ('user','agent','system')) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "task_external_sources" ADD CONSTRAINT "task_external_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_external_sources" ADD CONSTRAINT "task_external_sources_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;