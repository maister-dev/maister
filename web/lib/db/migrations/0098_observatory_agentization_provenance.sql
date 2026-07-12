CREATE TABLE IF NOT EXISTS "repo_delivery_rollups" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"branch" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"bucket_end" timestamp with time zone NOT NULL,
	"commits" integer DEFAULT 0 NOT NULL,
	"merge_pr_units" integer DEFAULT 0 NOT NULL,
	"additions" bigint DEFAULT 0 NOT NULL,
	"deletions" bigint DEFAULT 0 NOT NULL,
	"delivery_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_complete" boolean DEFAULT true NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"head_sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_delivery_rollups_project_branch_bucket_uq" UNIQUE("project_id","branch","bucket_start","bucket_end"),
	CONSTRAINT "repo_delivery_rollups_non_negative_check" CHECK ("repo_delivery_rollups"."commits" >= 0 AND "repo_delivery_rollups"."merge_pr_units" >= 0 AND "repo_delivery_rollups"."additions" >= 0 AND "repo_delivery_rollups"."deletions" >= 0),
	CONSTRAINT "repo_delivery_rollups_bucket_order_check" CHECK ("repo_delivery_rollups"."bucket_end" > "repo_delivery_rollups"."bucket_start")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "promoted_head_sha" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "merge_commit_sha" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "diff_stat" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_promoted_head_sha_idx" ON "runs" USING btree ("promoted_head_sha") WHERE "runs"."promoted_head_sha" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_merge_commit_sha_idx" ON "runs" USING btree ("merge_commit_sha") WHERE "runs"."merge_commit_sha" IS NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "repo_delivery_rollups" ADD CONSTRAINT "repo_delivery_rollups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_delivery_rollups_project_branch_bucket_idx" ON "repo_delivery_rollups" USING btree ("project_id","branch","bucket_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_delivery_rollups_project_fetched_idx" ON "repo_delivery_rollups" USING btree ("project_id","fetched_at");
