ALTER TABLE "run_messages" ADD COLUMN "prompt_dispatch_key" text;--> statement-breakpoint
--> NULLS NOT DISTINCT is load-bearing and is NOT expressible in drizzle's
--> `uniqueIndex` DSL (it offers the option only on `unique()` constraints,
--> which cannot be partial). A standalone agent's rows carry
--> `node_attempt_id = NULL`; under the default NULLS DISTINCT every one of
--> them would be unique regardless of its dispatch key, silently disabling
--> this index for exactly the rows EDGE-TRC-03 covers. Regenerating this
--> file from schema.ts alone will drop the clause — re-add it.
CREATE UNIQUE INDEX IF NOT EXISTS "run_messages_prompt_dispatch_key_uq" ON "run_messages" USING btree ("run_id","node_attempt_id","prompt_dispatch_key") NULLS NOT DISTINCT WHERE "run_messages"."prompt_dispatch_key" IS NOT NULL;
