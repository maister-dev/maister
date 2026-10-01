ALTER TABLE "scratch_runs" ADD COLUMN "active_prompt_intent" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scratch_runs_running_intent_sweep_idx" ON "scratch_runs" USING btree ("updated_at","run_id") WHERE "scratch_runs"."dialog_status" = 'Running';--> statement-breakpoint
ALTER TABLE "scratch_runs" ADD CONSTRAINT "scratch_runs_prompt_intent_shape_check" CHECK ("scratch_runs"."active_prompt_intent" IS NULL OR coalesce((
        jsonb_typeof("scratch_runs"."active_prompt_intent") = 'object'
        AND "scratch_runs"."active_prompt_intent"->'version' = '1'::jsonb
        AND octet_length("scratch_runs"."active_prompt_intent"::text) <= 4194304
      ), false));
