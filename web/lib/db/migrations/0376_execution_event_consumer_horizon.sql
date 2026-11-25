ALTER TABLE "execution_event_consumers" ADD COLUMN "max_available_sequence" bigint DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_event_consumers" ADD CONSTRAINT "execution_event_consumers_max_available_sequence_check" CHECK ("execution_event_consumers"."max_available_sequence" >= -1);--> statement-breakpoint
UPDATE "execution_event_consumers" AS c
SET "max_available_sequence" = GREATEST(
  c."max_available_sequence",
  COALESCE(
    (
      SELECT MAX(e."run_sequence")
      FROM "execution_events" AS e
      WHERE e."run_id" = c."run_id"
        AND e."ingest_disposition" = 'accepted'
        AND e."run_sequence" IS NOT NULL
    ),
    -1
  )
);--> statement-breakpoint
CREATE INDEX "execution_event_consumers_due_service_idx" ON "execution_event_consumers" USING btree ("last_served_at" NULLS FIRST,"run_id","consumer_name") WHERE "execution_event_consumers"."state" <> 'poisoned' AND "execution_event_consumers"."max_available_sequence" > COALESCE("execution_event_consumers"."last_run_sequence", -1);
