ALTER TABLE "execution_commands" ADD COLUMN "receipt_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD COLUMN "terminal_event_id" text;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD COLUMN "terminal_evidence_sha256" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_terminal_event_id_execution_events_id_fk" FOREIGN KEY ("terminal_event_id") REFERENCES "public"."execution_events"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_commands_terminal_event_idx" ON "execution_commands" USING btree ("terminal_event_id") WHERE "execution_commands"."terminal_event_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_terminal_evidence_check" CHECK ("execution_commands"."terminal_evidence_sha256" IS NULL OR ("execution_commands"."terminal_evidence_sha256" ~ '^[a-f0-9]{64}$' AND "execution_commands"."terminal_event_id" IS NOT NULL AND "execution_commands"."receipt_evidence" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_receipt_evidence_check" CHECK ("execution_commands"."receipt_evidence" IS NULL OR (jsonb_typeof("execution_commands"."receipt_evidence") = 'object' AND "execution_commands"."receipt_evidence"->>'commandId' = "execution_commands"."id" AND "execution_commands"."receipt_evidence"->>'runId' = "execution_commands"."run_id" AND "execution_commands"."receipt_evidence"->>'kind' = "execution_commands"."kind" AND "execution_commands"."receipt_evidence"->>'assignmentEpoch' = "execution_commands"."assignment_epoch"::text AND "execution_commands"."receipt_evidence"->>'phase' IN ('completed', 'rejected')) IS TRUE);--> statement-breakpoint
CREATE FUNCTION guard_prompt_terminal_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.receipt_evidence IS NOT NULL AND NEW.receipt_evidence IS DISTINCT FROM OLD.receipt_evidence)
    OR (OLD.terminal_event_id IS NOT NULL AND NEW.terminal_event_id IS DISTINCT FROM OLD.terminal_event_id)
    OR (OLD.terminal_evidence_sha256 IS NOT NULL AND ROW(NEW.terminal_evidence_sha256, NEW.state, NEW.result, NEW.last_error, NEW.completed_at)
      IS DISTINCT FROM ROW(OLD.terminal_evidence_sha256, OLD.state, OLD.result, OLD.last_error, OLD.completed_at))
  THEN
    RAISE EXCEPTION 'verified prompt evidence is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'execution_commands_immutable_terminal_evidence';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER execution_commands_immutable_terminal_evidence
BEFORE UPDATE OF receipt_evidence, terminal_event_id, terminal_evidence_sha256, state, result, last_error, completed_at
ON execution_commands FOR EACH ROW EXECUTE FUNCTION guard_prompt_terminal_evidence();
