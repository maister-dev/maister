CREATE TABLE IF NOT EXISTS "flow_assistant_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"local_package_id" text NOT NULL,
	"lock_generation" text NOT NULL,
	"message_id" text NOT NULL,
	"action" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "flow_assistant_actions_message_uq" UNIQUE("message_id"),
	CONSTRAINT "flow_assistant_actions_state_check" CHECK ("flow_assistant_actions"."state" IN ('pending', 'applied', 'rejected', 'skipped')
      AND (("flow_assistant_actions"."completed_at" IS NOT NULL) = ("flow_assistant_actions"."state" <> 'pending'))
      AND length("flow_assistant_actions"."lock_generation") BETWEEN 1 AND 128)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flow_assistant_actions" ADD CONSTRAINT "flow_assistant_actions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flow_assistant_actions" ADD CONSTRAINT "flow_assistant_actions_local_package_id_local_packages_id_fk" FOREIGN KEY ("local_package_id") REFERENCES "public"."local_packages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flow_assistant_actions" ADD CONSTRAINT "flow_assistant_actions_message_id_run_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."run_messages"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flow_assistant_actions_due_idx" ON "flow_assistant_actions" USING btree ("created_at","run_id") WHERE "flow_assistant_actions"."state" = 'pending';