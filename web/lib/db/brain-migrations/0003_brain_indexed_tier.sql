-- Project Brain (ADR-127, Sub-project B) — indexed Consultant tier.
-- HAND-AUTHORED (no db:generate:brain). Runs AFTER 0001/0002 and after the
-- main lineage because project/source FKs reference shared tables.
CREATE TABLE "brain_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"source_hash" text,
	"chunker_id" text NOT NULL,
	"chunker_version" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_indexed_at" timestamp with time zone,
	"last_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_sources_kind_check" CHECK ("kind" IN ('repo_file', 'markdown', 'html', 'openapi', 'asyncapi', 'sql', 'flow_yaml', 'package_yaml', 'agent_md', 'code', 'text'))
);
--> statement-breakpoint
CREATE TABLE "brain_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"project_id" text NOT NULL,
	"stable_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"path" text NOT NULL,
	"symbol" text,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_range" jsonb,
	"content_hash" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("content", ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"from_ref" jsonb NOT NULL,
	"to_ref" jsonb NOT NULL,
	"relation" text NOT NULL,
	"confidence" numeric(4, 3) DEFAULT 1 NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_edges_relation_check" CHECK ("relation" IN ('supports', 'contradicts', 'derived_from', 'refines', 'references')),
	CONSTRAINT "brain_edges_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "brain_project_config" (
	"project_id" text PRIMARY KEY NOT NULL,
	"home_resolution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"projection_flow_id" text,
	"autonomy_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brain_sources" ADD CONSTRAINT "brain_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_chunks" ADD CONSTRAINT "brain_chunks_source_id_brain_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."brain_sources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_chunks" ADD CONSTRAINT "brain_chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_edges" ADD CONSTRAINT "brain_edges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_project_config" ADD CONSTRAINT "brain_project_config_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_project_config" ADD CONSTRAINT "brain_project_config_projection_flow_id_flows_id_fk" FOREIGN KEY ("projection_flow_id") REFERENCES "public"."flows"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_items" DROP CONSTRAINT "brain_items_kind_check";
--> statement-breakpoint
ALTER TABLE "brain_items" ADD COLUMN "source_ref" jsonb;
--> statement-breakpoint
ALTER TABLE "brain_items" ADD CONSTRAINT "brain_items_kind_check" CHECK ("kind" IN ('lesson', 'observation', 'state_fact', 'decision', 'direction'));
--> statement-breakpoint
ALTER TABLE "brain_embeddings" ALTER COLUMN "item_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "brain_embeddings" ADD COLUMN "chunk_id" text;
--> statement-breakpoint
ALTER TABLE "brain_embeddings" ADD COLUMN "chunker_id" text;
--> statement-breakpoint
ALTER TABLE "brain_embeddings" ADD COLUMN "chunker_version" text;
--> statement-breakpoint
ALTER TABLE "brain_embeddings" ADD CONSTRAINT "brain_embeddings_chunk_id_brain_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."brain_chunks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_embeddings" ADD CONSTRAINT "brain_embeddings_target_one_check" CHECK ((("item_id" IS NOT NULL AND "chunk_id" IS NULL) OR ("item_id" IS NULL AND "chunk_id" IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE "brain_index_jobs" ADD COLUMN "source_id" text;
--> statement-breakpoint
ALTER TABLE "brain_index_jobs" ADD CONSTRAINT "brain_index_jobs_source_id_brain_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."brain_sources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_index_jobs" DROP CONSTRAINT "brain_index_jobs_reason_check";
--> statement-breakpoint
ALTER TABLE "brain_index_jobs" ADD CONSTRAINT "brain_index_jobs_reason_check" CHECK ("reason" IN ('model_switch', 'manual', 'event', 'chunker_upgrade'));
--> statement-breakpoint
CREATE UNIQUE INDEX "brain_sources_project_kind_path_uq" ON "brain_sources" USING btree ("project_id", "kind", "path");
--> statement-breakpoint
CREATE INDEX "brain_sources_project_idx" ON "brain_sources" USING btree ("project_id", "enabled");
--> statement-breakpoint
CREATE UNIQUE INDEX "brain_chunks_source_stable_uq" ON "brain_chunks" USING btree ("source_id", "stable_id");
--> statement-breakpoint
CREATE INDEX "brain_chunks_project_idx" ON "brain_chunks" USING btree ("project_id", "path");
--> statement-breakpoint
CREATE INDEX "brain_chunks_tsv_gin" ON "brain_chunks" USING gin ("tsv");
--> statement-breakpoint
CREATE INDEX "brain_embeddings_chunk_idx" ON "brain_embeddings" USING btree ("chunk_id", "embedding_model", "embedding_dimensions");
--> statement-breakpoint
CREATE UNIQUE INDEX "brain_embeddings_chunk_generation_uq" ON "brain_embeddings" USING btree ("chunk_id", "split_ordinal", "embedding_model", "embedding_dimensions", "chunker_id", "chunker_version") WHERE "chunk_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "brain_edges_project_idx" ON "brain_edges" USING btree ("project_id", "degraded");
