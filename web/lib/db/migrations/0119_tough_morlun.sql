ALTER TABLE "evaluation_judge_attempts" DROP CONSTRAINT "evaluation_judge_attempts_unique";--> statement-breakpoint
ALTER TABLE "evaluation_judge_attempts" ADD COLUMN "match_a" text;--> statement-breakpoint
ALTER TABLE "evaluation_judge_attempts" ADD COLUMN "match_b" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "evaluation_batch_item_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runs_evaluation_batch_item_uq" ON "runs" USING btree ("evaluation_batch_item_id") WHERE "runs"."evaluation_batch_item_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_judge_attempts" ADD CONSTRAINT "evaluation_judge_attempts_unique" UNIQUE NULLS NOT DISTINCT("execution_id","role","ordinal","retry_ordinal","match_a","match_b");