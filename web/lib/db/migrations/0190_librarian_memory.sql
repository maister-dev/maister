CREATE TABLE IF NOT EXISTS "librarian_memory_item_revisions" (
	"item_id" text NOT NULL,
	"revision" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "librarian_memory_item_revisions_item_id_revision_pk" PRIMARY KEY("item_id","revision"),
	CONSTRAINT "librarian_memory_item_revisions_revision_check" CHECK ("librarian_memory_item_revisions"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "librarian_memory_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"scope" text NOT NULL,
	"project_id" text,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_project_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"origin" text NOT NULL,
	"valid_until" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"forgotten_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "librarian_memory_items_kind_check" CHECK ("librarian_memory_items"."kind" IN ('preference', 'goal', 'commitment', 'fact')),
	CONSTRAINT "librarian_memory_items_scope_check" CHECK ("librarian_memory_items"."scope" IN ('general', 'project')),
	CONSTRAINT "librarian_memory_items_origin_check" CHECK ("librarian_memory_items"."origin" IN ('explicit', 'accepted_suggestion')),
	CONSTRAINT "librarian_memory_items_revision_check" CHECK ("librarian_memory_items"."revision" >= 1),
	CONSTRAINT "librarian_memory_items_project_scope_check" CHECK (("librarian_memory_items"."scope" = 'project') = ("librarian_memory_items"."project_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "librarian_memory_tombstones" (
	"user_id" text NOT NULL,
	"content_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "librarian_memory_tombstones_user_id_content_digest_pk" PRIMARY KEY("user_id","content_digest")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "librarian_segment_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"segment_id" text NOT NULL,
	"revision" integer NOT NULL,
	"from_seq" bigint NOT NULL,
	"to_seq" bigint NOT NULL,
	"content" jsonb NOT NULL,
	"source_project_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"forget_generation" integer NOT NULL,
	"history_generation" integer NOT NULL,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "librarian_segment_summaries_revision_uq" UNIQUE("segment_id","revision"),
	CONSTRAINT "librarian_segment_summaries_range_check" CHECK ("librarian_segment_summaries"."from_seq" <= "librarian_segment_summaries"."to_seq")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_memory_item_revisions" ADD CONSTRAINT "librarian_memory_item_revisions_item_id_librarian_memory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."librarian_memory_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_memory_items" ADD CONSTRAINT "librarian_memory_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_memory_items" ADD CONSTRAINT "librarian_memory_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_memory_tombstones" ADD CONSTRAINT "librarian_memory_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_segment_summaries" ADD CONSTRAINT "librarian_segment_summaries_segment_id_librarian_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."librarian_segments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "librarian_memory_items_user_active_idx" ON "librarian_memory_items" USING btree ("user_id") WHERE "librarian_memory_items"."forgotten_at" IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION librarian_memory_items_content_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'librarian_memory_items_content_immutable',
      MESSAGE = 'memory content is immutable; insert a revision instead';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER librarian_memory_items_content_immutable
BEFORE UPDATE OF content ON librarian_memory_items
FOR EACH ROW EXECUTE FUNCTION librarian_memory_items_content_immutable();
