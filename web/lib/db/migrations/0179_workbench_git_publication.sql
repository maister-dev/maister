-- ADR-181: the run git panel's publication record and public-name template.
--
-- `workspaces.published_branch` / `published_remote` / `published_at` record
-- the name the internal branch carries on a remote. They are written ONLY after
-- a successful push, by one writer; the CHECK makes a half-written publication
-- unrepresentable (all three set, or all three null).
--
-- `projects.public_branch_template` is a POLICY, not a computed per-row marker:
-- the constant default IS the intended value for every pre-migration project,
-- so no backfill, no abort guard. Live-data premise: every statement is
-- additive — existing workspaces stay unpublished (NULL), existing projects get
-- the default template.

ALTER TABLE "projects" ADD COLUMN "public_branch_template" text DEFAULT 'feature/{task_key}-{slug}' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "published_branch" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "published_remote" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_published_shape_check" CHECK (("workspaces"."published_branch" IS NULL) = ("workspaces"."published_remote" IS NULL) AND ("workspaces"."published_branch" IS NULL) = ("workspaces"."published_at" IS NULL));