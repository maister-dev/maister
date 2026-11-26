ALTER TABLE "execution_event_skips" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_event_skips" ADD COLUMN "workspace_command_id" text;--> statement-breakpoint
ALTER TABLE "execution_event_skips" ADD COLUMN "envelope_sha256" text;--> statement-breakpoint
ALTER TABLE "execution_event_skips" ADD CONSTRAINT "execution_event_skips_owner_shape_check" CHECK ((
      ("execution_event_skips"."reason" = 'workspace_owner_unverified' AND "execution_event_skips"."run_id" IS NULL
        AND "execution_event_skips"."workspace_command_id" IS NOT NULL AND "execution_event_skips"."envelope_sha256" ~ '^[a-f0-9]{64}$'
        AND "execution_event_skips"."envelope_sha256" IS NOT NULL)
      OR ("execution_event_skips"."reason" <> 'workspace_owner_unverified' AND "execution_event_skips"."run_id" IS NOT NULL
        AND "execution_event_skips"."workspace_command_id" IS NULL AND "execution_event_skips"."envelope_sha256" IS NULL)
    ));