CREATE TABLE IF NOT EXISTS "agent_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"variant" text NOT NULL,
	"logical_key" text NOT NULL,
	"prompt" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"execution_assignment_id" text,
	"assignment_epoch" integer,
	"run_session_id" text,
	"incarnation_id" text,
	"command_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_turns_run_ordinal_uq" UNIQUE("run_id","ordinal"),
	CONSTRAINT "agent_turns_run_logical_key_uq" UNIQUE("run_id","logical_key"),
	CONSTRAINT "agent_turns_command_uq" UNIQUE("command_id"),
	CONSTRAINT "agent_turns_source_check" CHECK ("agent_turns"."ordinal" >= 0
      AND "agent_turns"."variant" IN ('initial', 'resume', 'rework', 'live_message', 'persistent_message')
      AND length("agent_turns"."logical_key") BETWEEN 1 AND 256 AND length("agent_turns"."prompt") BETWEEN 1 AND 1000000),
	CONSTRAINT "agent_turns_state_check" CHECK ("agent_turns"."state" IN ('queued', 'claimed', 'dispatched', 'applied', 'superseded')
      AND (("agent_turns"."completed_at" IS NOT NULL) = ("agent_turns"."state" IN ('applied', 'superseded')))
      AND ((num_nonnulls("agent_turns"."execution_assignment_id", "agent_turns"."assignment_epoch", "agent_turns"."run_session_id") = 0)
        OR (num_nonnulls("agent_turns"."execution_assignment_id", "agent_turns"."assignment_epoch", "agent_turns"."run_session_id") = 3 AND "agent_turns"."assignment_epoch" > 0))
      AND num_nonnulls("agent_turns"."incarnation_id", "agent_turns"."command_id") IN (0, 2)
      AND ("agent_turns"."command_id" IS NULL OR "agent_turns"."execution_assignment_id" IS NOT NULL)
      AND ("agent_turns"."state" = 'superseded'
        OR ("agent_turns"."state" = 'queued' AND "agent_turns"."execution_assignment_id" IS NULL AND "agent_turns"."command_id" IS NULL)
        OR ("agent_turns"."state" = 'claimed' AND "agent_turns"."execution_assignment_id" IS NOT NULL AND "agent_turns"."command_id" IS NULL)
        OR ("agent_turns"."state" IN ('dispatched', 'applied') AND "agent_turns"."execution_assignment_id" IS NOT NULL AND "agent_turns"."command_id" IS NOT NULL)))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_execution_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("execution_assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_run_session_id_run_sessions_id_fk" FOREIGN KEY ("run_session_id") REFERENCES "public"."run_sessions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_incarnation_id_run_session_incarnations_id_fk" FOREIGN KEY ("incarnation_id") REFERENCES "public"."run_session_incarnations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_command_id_execution_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."execution_commands"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_turns_active_run_uq" ON "agent_turns" USING btree ("run_id") WHERE "agent_turns"."state" IN ('claimed', 'dispatched');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_turns_due_idx" ON "agent_turns" USING btree ("state","created_at","run_id") WHERE "agent_turns"."state" IN ('queued', 'claimed', 'dispatched');
--> statement-breakpoint
CREATE FUNCTION guard_agent_turn_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM runs WHERE id = NEW.run_id AND run_kind = 'agent') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_agent_run',
      MESSAGE = 'agent turn requires its agent run';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.run_id, NEW.ordinal, NEW.variant, NEW.logical_key, NEW.prompt, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.run_id, OLD.ordinal, OLD.variant, OLD.logical_key, OLD.prompt, OLD.created_at)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_source_immutable',
        MESSAGE = 'accepted agent turn source is immutable';
    END IF;
    IF (OLD.execution_assignment_id IS NOT NULL AND
        ROW(NEW.execution_assignment_id, NEW.assignment_epoch, NEW.run_session_id)
          IS DISTINCT FROM ROW(OLD.execution_assignment_id, OLD.assignment_epoch, OLD.run_session_id))
      OR (OLD.command_id IS NOT NULL AND
        ROW(NEW.incarnation_id, NEW.command_id) IS DISTINCT FROM ROW(OLD.incarnation_id, OLD.command_id))
      OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_binding_immutable',
        MESSAGE = 'bound agent turn identity is immutable';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'queued' AND NEW.state IN ('claimed', 'superseded')) OR
      (OLD.state = 'claimed' AND NEW.state IN ('dispatched', 'superseded')) OR
      (OLD.state = 'dispatched' AND NEW.state IN ('applied', 'superseded'))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_transition_check',
        MESSAGE = 'agent turn transition is not allowed';
    END IF;
  END IF;
  IF NEW.execution_assignment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM execution_assignments a JOIN run_sessions s ON s.run_id = a.run_id
    WHERE a.id = NEW.execution_assignment_id AND a.run_id = NEW.run_id
      AND a.epoch = NEW.assignment_epoch AND s.id = NEW.run_session_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_binding_scope',
      MESSAGE = 'agent turn binding must belong to its run and assignment epoch';
  END IF;
  IF NEW.command_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM execution_commands c JOIN run_session_incarnations i
      ON i.id = NEW.incarnation_id AND i.run_session_id = NEW.run_session_id
    WHERE c.id = NEW.command_id AND c.run_id = NEW.run_id
      AND c.kind = 'session.prompt' AND c.owner_kind = 'agent_turn'
      AND c.execution_assignment_id = NEW.execution_assignment_id
      AND c.assignment_epoch = NEW.assignment_epoch
      AND i.execution_assignment_id = NEW.execution_assignment_id
      AND i.assignment_epoch = NEW.assignment_epoch
      AND i.host_session_id = c.target_session_id
      AND c.owner_ref->>'turnId' = NEW.id
      AND c.owner_ref->>'variant' = NEW.variant
      AND c.owner_ref->'promptOrdinal' = to_jsonb(NEW.ordinal)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_command_scope',
      MESSAGE = 'agent turn command must retain its exact source and incarnation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_turns_guard_source BEFORE INSERT OR UPDATE ON agent_turns
FOR EACH ROW EXECUTE FUNCTION guard_agent_turn_source();
