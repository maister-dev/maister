-- Project Brain (ADR-128, Sub-project C) — self-improvement proposal bridge.
-- HAND-AUTHORED (no db:generate:brain). Proposals are reviewable state only:
-- they never publish catalog content or write repo files directly.
CREATE TABLE "brain_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"evidence_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"blast_radius" text DEFAULT 'low' NOT NULL,
	"autonomy_decision" text DEFAULT 'manual' NOT NULL,
	"cluster_hash" text,
	"actor" jsonb NOT NULL,
	"resolution" jsonb,
	"authored_draft_id" text,
	"task_id" text,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	CONSTRAINT "brain_proposals_kind_check" CHECK ("kind" IN ('rule', 'skill', 'flow', 'adr', 'roadmap', 'state')),
	CONSTRAINT "brain_proposals_status_check" CHECK ("status" IN ('pending', 'accepted', 'rejected', 'applied')),
	CONSTRAINT "brain_proposals_blast_radius_check" CHECK ("blast_radius" IN ('low', 'medium', 'high')),
	CONSTRAINT "brain_proposals_autonomy_decision_check" CHECK ("autonomy_decision" IN ('manual', 'auto_draft'))
);
--> statement-breakpoint
ALTER TABLE "brain_proposals" ADD CONSTRAINT "brain_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_proposals" ADD CONSTRAINT "brain_proposals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "brain_proposals" ADD CONSTRAINT "brain_proposals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "brain_proposals_cluster_hash_uq" ON "brain_proposals" USING btree ("project_id", "cluster_hash") WHERE "cluster_hash" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "brain_proposals_project_status_idx" ON "brain_proposals" USING btree ("project_id", "status", "created_at");
