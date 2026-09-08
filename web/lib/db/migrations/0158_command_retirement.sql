ALTER TABLE "execution_commands" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_commands_retirement_idx" ON "execution_commands" USING btree ("completed_at","id") WHERE "execution_commands"."retired_at" IS NULL AND "execution_commands"."state" in ('succeeded', 'failed', 'fenced');--> statement-breakpoint
CREATE FUNCTION maister_guard_protected_command_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  protected_id text;
BEGIN
  SELECT c.id INTO protected_id FROM execution_commands c
  WHERE c.retired_at IS NULL
    AND CASE TG_TABLE_NAME
      WHEN 'runs' THEN c.run_id = OLD.id
      ELSE c.execution_assignment_id = OLD.id
    END
  LIMIT 1;
  IF protected_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'execution_commands_protected_evidence',
      MESSAGE = 'protected execution command evidence blocks deletion',
      DETAIL = protected_id;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER runs_guard_protected_command_evidence
BEFORE DELETE ON runs
FOR EACH ROW EXECUTE FUNCTION maister_guard_protected_command_evidence();--> statement-breakpoint
CREATE TRIGGER execution_assignments_guard_protected_command_evidence
BEFORE DELETE ON execution_assignments
FOR EACH ROW EXECUTE FUNCTION maister_guard_protected_command_evidence();
