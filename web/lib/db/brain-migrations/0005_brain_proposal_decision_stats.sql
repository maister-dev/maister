-- Project Brain (ADR-128, Sub-project C) — proposal graduation analytics.
-- Hand-authored Brain-lineage table. Counts review decisions by proposal
-- kind/blast radius so autonomy can graduate from evidence, not anecdotes.
CREATE TABLE "brain_proposal_decision_stats" (
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"blast_radius" text NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"auto_drafted_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_proposal_decision_stats_pk" PRIMARY KEY ("project_id", "kind", "blast_radius"),
	CONSTRAINT "brain_proposal_decision_stats_kind_check" CHECK ("kind" IN ('rule', 'skill', 'flow', 'adr', 'roadmap', 'state')),
	CONSTRAINT "brain_proposal_decision_stats_blast_radius_check" CHECK ("blast_radius" IN ('low', 'medium', 'high')),
	CONSTRAINT "brain_proposal_decision_stats_nonnegative_check" CHECK ("accepted_count" >= 0 AND "rejected_count" >= 0 AND "auto_drafted_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "brain_proposal_decision_stats" ADD CONSTRAINT "brain_proposal_decision_stats_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
