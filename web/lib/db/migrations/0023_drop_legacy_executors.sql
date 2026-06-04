ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_executor_id_executors_id_fk";
--> statement-breakpoint
ALTER TABLE "flows" DROP CONSTRAINT IF EXISTS "flows_executor_override_id_executors_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_executor_override_id_executors_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "default_executor_id";
--> statement-breakpoint
ALTER TABLE "flows" DROP COLUMN IF EXISTS "recommended_executor_id";
--> statement-breakpoint
ALTER TABLE "flows" DROP COLUMN IF EXISTS "executor_override_id";
--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "executor_id";
--> statement-breakpoint
DROP TABLE IF EXISTS "executors";
