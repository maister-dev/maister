ALTER TABLE "hitl_requests" ADD COLUMN "parent_hitl_request_id" text;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "source_artifact_id" text;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "decision_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_requests_parent_hitl_request_id_hitl_requests_id_fk" FOREIGN KEY ("parent_hitl_request_id") REFERENCES "public"."hitl_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_requests_source_artifact_id_artifact_instances_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."artifact_instances"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hitl_requests_decision_request_uq" ON "hitl_requests" USING btree ("run_id","source_artifact_id","decision_id") WHERE "hitl_requests"."kind" = 'decision_request';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_requests_pending_decision_idx" ON "hitl_requests" USING btree ("parent_hitl_request_id","responded_at","created_at") WHERE "hitl_requests"."kind" = 'decision_request';--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_requests_decision_request_shape_check" CHECK ((
        "hitl_requests"."kind" = 'decision_request'
        AND "hitl_requests"."parent_hitl_request_id" IS NOT NULL
        AND "hitl_requests"."source_artifact_id" IS NOT NULL
        AND "hitl_requests"."decision_id" IS NOT NULL
        AND "hitl_requests"."schema" IS NOT NULL
      ) OR (
        "hitl_requests"."kind" <> 'decision_request'
        AND "hitl_requests"."parent_hitl_request_id" IS NULL
        AND "hitl_requests"."source_artifact_id" IS NULL
        AND "hitl_requests"."decision_id" IS NULL
      ));