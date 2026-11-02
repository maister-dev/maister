ALTER TABLE "run_messages" ADD COLUMN "first_supervisor_event_id" text;--> statement-breakpoint
CREATE INDEX "run_messages_peek_node_creation_order_idx" ON "run_messages" USING btree ("run_id","node_attempt_id",(coalesce("first_supervisor_event_id", "supervisor_event_id", '0')::bigint),("prompt_dispatch_key" IS NOT NULL),"sequence","id") WHERE "run_messages"."node_attempt_id" IS NOT NULL;
--> statement-breakpoint
-- Retained rows begin with their current observed anchor. Future coalescing
-- updates only supervisor_event_id, preserving this upgrade-time position.
UPDATE "run_messages"
SET "first_supervisor_event_id" = "supervisor_event_id"
WHERE "node_attempt_id" IS NOT NULL
  AND "prompt_dispatch_key" IS NULL;
