ALTER TABLE "execution_commands" DROP CONSTRAINT "execution_commands_terminal_evidence_check";--> statement-breakpoint
ALTER TABLE "execution_commands" ADD COLUMN "settled_from" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_commands_host_span_settled_idx" ON "execution_commands" USING btree ("execution_host_id","completed_at") WHERE "execution_commands"."settled_from" = 'host_span';--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_settled_from_check" CHECK ("execution_commands"."settled_from" IS NULL OR ("execution_commands"."settled_from" in ('canonical', 'host_span') AND "execution_commands"."terminal_evidence_sha256" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_terminal_evidence_check" CHECK ("execution_commands"."terminal_evidence_sha256" IS NULL OR ("execution_commands"."terminal_evidence_sha256" ~ '^[a-f0-9]{64}$' AND ("execution_commands"."terminal_event_id" IS NOT NULL OR "execution_commands"."settled_from" IS NOT DISTINCT FROM 'host_span') AND ("execution_commands"."receipt_evidence" IS NOT NULL OR "execution_commands"."retired_at" IS NOT NULL)));--> statement-breakpoint
--> statement-breakpoint
-- ADR-167 D5 amendment (2026-09-23): a prompt may settle from the host's
-- verified event span before its canonical terminal event is ingested, so the
-- digest may precede `terminal_event_id` on a `host_span` row (CHECK above).
-- `settled_from` records the first feed and is immutable once written; every
-- other clause is the 0175 body verbatim.
CREATE OR REPLACE FUNCTION guard_prompt_terminal_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  retiring boolean := OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL;
BEGIN
  IF (OLD.receipt_evidence IS NOT NULL
      AND NEW.receipt_evidence IS DISTINCT FROM OLD.receipt_evidence
      AND NOT (retiring AND NEW.receipt_evidence IS NULL))
    OR (OLD.terminal_event_id IS NOT NULL AND NEW.terminal_event_id IS DISTINCT FROM OLD.terminal_event_id)
    OR (OLD.settled_from IS NOT NULL AND NEW.settled_from IS DISTINCT FROM OLD.settled_from)
    OR (OLD.terminal_evidence_sha256 IS NOT NULL AND (
      ROW(NEW.terminal_evidence_sha256, NEW.state, NEW.completed_at)
        IS DISTINCT FROM ROW(OLD.terminal_evidence_sha256, OLD.state, OLD.completed_at)
      OR (NEW.result IS DISTINCT FROM OLD.result AND NOT (retiring AND NEW.result IS NULL))
      OR (NEW.last_error IS DISTINCT FROM OLD.last_error AND NOT (retiring AND NEW.last_error IS NULL))
      OR (OLD.retired_at IS NOT NULL AND NEW.receipt_evidence IS DISTINCT FROM OLD.receipt_evidence)))
  THEN
    RAISE EXCEPTION 'verified prompt evidence is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'execution_commands_immutable_terminal_evidence';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS execution_commands_immutable_terminal_evidence ON execution_commands;
--> statement-breakpoint
CREATE TRIGGER execution_commands_immutable_terminal_evidence
BEFORE UPDATE OF receipt_evidence, terminal_event_id, terminal_evidence_sha256, settled_from, state, result, last_error, completed_at
ON execution_commands FOR EACH ROW EXECUTE FUNCTION guard_prompt_terminal_evidence();
