-- Project Brain (ADR-122, Sub-project A) — brain lineage migration 0001.
-- HAND-AUTHORED (no db:generate:brain). Runs AFTER the main lineage; brain FKs
-- reference projects/runs/node_attempts/domain_events. Requires a pgvector image.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "brain_items" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"tier" text DEFAULT 'owned' NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"reinforcement_count" integer DEFAULT 0 NOT NULL,
	"last_reinforced_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"content_hash" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_run_id" text,
	"source_node_attempt_id" text,
	"source_domain_event_id" bigint,
	"source_gate_kind" text,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("content", ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_items_kind_check" CHECK ("kind" IN ('lesson', 'observation', 'state_fact')),
	CONSTRAINT "brain_items_status_check" CHECK ("status" IN ('active', 'expired', 'superseded')),
	CONSTRAINT "brain_items_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "brain_embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"split_ordinal" integer DEFAULT 0 NOT NULL,
	"vector" vector NOT NULL,
	"embedding_provider" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_dimensions" integer NOT NULL,
	"embedding_version" text NOT NULL,
	"source_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"node_attempt_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"trigger" text NOT NULL,
	"query" text NOT NULL,
	"query_hash" text NOT NULL,
	"embedding_model" text NOT NULL,
	"returned_items" jsonb NOT NULL,
	"ranker_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_snapshots_actor_type_check" CHECK ("actor_type" IN ('user', 'agent', 'system')),
	CONSTRAINT "brain_snapshots_trigger_check" CHECK ("trigger" IN ('ambient', 'explicit'))
);
--> statement-breakpoint
CREATE TABLE "brain_index_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"resumable_cursor" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_index_jobs_reason_check" CHECK ("reason" IN ('model_switch', 'manual')),
	CONSTRAINT "brain_index_jobs_status_check" CHECK ("status" IN ('queued', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "brain_items" ADD CONSTRAINT "brain_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_items" ADD CONSTRAINT "brain_items_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_items" ADD CONSTRAINT "brain_items_source_node_attempt_id_node_attempts_id_fk" FOREIGN KEY ("source_node_attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_items" ADD CONSTRAINT "brain_items_source_domain_event_id_domain_events_id_fk" FOREIGN KEY ("source_domain_event_id") REFERENCES "public"."domain_events"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_embeddings" ADD CONSTRAINT "brain_embeddings_item_id_brain_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."brain_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_snapshots" ADD CONSTRAINT "brain_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_snapshots" ADD CONSTRAINT "brain_snapshots_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_snapshots" ADD CONSTRAINT "brain_snapshots_node_attempt_id_node_attempts_id_fk" FOREIGN KEY ("node_attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_index_jobs" ADD CONSTRAINT "brain_index_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "brain_items_tsv_gin" ON "brain_items" USING gin ("tsv");
--> statement-breakpoint
CREATE INDEX "brain_items_recall_idx" ON "brain_items" USING btree ("project_id", "status", "expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "brain_items_event_uq" ON "brain_items" USING btree ("project_id", "source_domain_event_id") WHERE "source_domain_event_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "brain_items_active_hash_uq" ON "brain_items" USING btree ("project_id", "content_hash") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "brain_embeddings_item_idx" ON "brain_embeddings" USING btree ("item_id", "embedding_model", "embedding_dimensions");
--> statement-breakpoint
CREATE INDEX "brain_snapshots_run_idx" ON "brain_snapshots" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "brain_index_jobs_claim_idx" ON "brain_index_jobs" USING btree ("status", "created_at");
