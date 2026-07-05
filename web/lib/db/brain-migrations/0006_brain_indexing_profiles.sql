-- Project Brain indexing profiles and managed source rows.
ALTER TABLE "brain_project_config"
  ADD COLUMN "indexing_profile" text DEFAULT 'docs' NOT NULL;
--> statement-breakpoint
ALTER TABLE "brain_project_config"
  ADD CONSTRAINT "brain_project_config_indexing_profile_check"
  CHECK ("indexing_profile" IN ('docs', 'docs_source', 'all'));
--> statement-breakpoint
ALTER TABLE "brain_sources"
  ADD COLUMN "profile_managed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "brain_sources"
SET "profile_managed" = true
WHERE "path" IN (
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/**/*.md',
  'docs/decisions.md',
  'docs/ROADMAP.md',
  '.ai-factory/ROADMAP.md',
  'docs/api/*.yaml',
  'maister.yaml'
);
--> statement-breakpoint
CREATE INDEX "brain_sources_project_profile_idx"
  ON "brain_sources" USING btree ("project_id", "profile_managed", "enabled");
