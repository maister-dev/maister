ALTER TABLE "run_messages" ADD COLUMN "prompt_dispatch_key" text;--> statement-breakpoint
--> NULLS NOT DISTINCT is load-bearing and is NOT expressible in drizzle's
--> `uniqueIndex` DSL (it offers the option only on `unique()` constraints,
--> which cannot be partial). It keeps this index in step with the sequence
--> key: under the default NULLS DISTINCT a row whose `node_attempt_id` is
--> NULL would be unique regardless of its dispatch key, silently exempting
--> it. Only the flow dispatcher records prompts today and it always names an
--> attempt, so no such row exists yet — the clause is what keeps that from
--> becoming a hole the day one does (EDGE-TRC-03). Regenerating this file
--> from schema.ts alone will drop the clause — re-add it.
CREATE UNIQUE INDEX IF NOT EXISTS "run_messages_prompt_dispatch_key_uq" ON "run_messages" USING btree ("run_id","node_attempt_id","prompt_dispatch_key") NULLS NOT DISTINCT WHERE "run_messages"."prompt_dispatch_key" IS NOT NULL;
