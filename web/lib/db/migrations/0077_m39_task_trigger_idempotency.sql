ALTER TABLE "tasks" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "trigger_event_id" bigint;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_agent_trigger_event_uq" ON "tasks" USING btree ("agent_id","trigger_event_id") WHERE "tasks"."trigger_event_id" IS NOT NULL;