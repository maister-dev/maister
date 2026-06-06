CREATE TABLE IF NOT EXISTS "authored_capabilities" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "lifecycle" text DEFAULT 'DRAFT' NOT NULL,
  "draft_version" integer DEFAULT 1 NOT NULL,
  "current_draft_revision_id" text,
  "current_published_revision_id" text,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "authored_capabilities_project_kind_slug_uq" ON "authored_capabilities" ("project_id","kind","slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "authored_capabilities_project_kind_idx" ON "authored_capabilities" ("project_id","kind");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "authored_capability_revisions" (
  "id" text PRIMARY KEY NOT NULL,
  "capability_id" text NOT NULL REFERENCES "authored_capabilities"("id") ON DELETE cascade,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "revision_number" integer NOT NULL,
  "lifecycle" text DEFAULT 'DRAFT' NOT NULL,
  "draft_version" integer NOT NULL,
  "title" text NOT NULL,
  "body" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "manifest" jsonb,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "content_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp with time zone,
  "archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "authored_capability_revisions_capability_revision_uq" ON "authored_capability_revisions" ("capability_id","revision_number");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "authored_capability_revisions_active_draft_uq" ON "authored_capability_revisions" ("capability_id") WHERE "lifecycle" = 'DRAFT';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "authored_capability_revisions_capability_lifecycle_idx" ON "authored_capability_revisions" ("capability_id","lifecycle");
