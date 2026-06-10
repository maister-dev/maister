CREATE TABLE "review_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL REFERENCES "runs"("id") ON DELETE cascade,
	"hitl_request_id" text NOT NULL REFERENCES "hitl_requests"("id") ON DELETE cascade,
	"node_id" text NOT NULL,
	"gate_attempt" integer NOT NULL,
	"parent_id" text REFERENCES "review_comments"("id") ON DELETE cascade,
	"author_user_id" text REFERENCES "users"("id") ON DELETE set null,
	"author_label" text NOT NULL,
	"file_path" text,
	"side" text,
	"line" integer,
	"line_content" text,
	"body" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by_user_id" text REFERENCES "users"("id") ON DELETE set null,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "review_comments_anchor_root_check" CHECK (("parent_id" is null and "file_path" is not null and "side" is not null and "line" is not null and "line_content" is not null) or ("parent_id" is not null and "file_path" is null and "side" is null and "line" is null and "line_content" is null)),
	CONSTRAINT "review_comments_side_check" CHECK ("side" in ('old', 'new')),
	CONSTRAINT "review_comments_status_check" CHECK ("status" in ('open', 'resolved'))
);
--> statement-breakpoint
CREATE INDEX "review_comments_run_created_idx" ON "review_comments" ("run_id","created_at");
--> statement-breakpoint
CREATE INDEX "review_comments_run_status_idx" ON "review_comments" ("run_id","status");
--> statement-breakpoint
CREATE INDEX "review_comments_hitl_request_idx" ON "review_comments" ("hitl_request_id");
--> statement-breakpoint
CREATE INDEX "review_comments_parent_idx" ON "review_comments" ("parent_id");
