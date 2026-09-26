ALTER TABLE "agent_turns" DROP CONSTRAINT "agent_turns_source_check";--> statement-breakpoint
ALTER TABLE "execution_commands" DROP CONSTRAINT "execution_commands_kind_check";--> statement-breakpoint
DROP INDEX IF EXISTS "agent_turns_active_run_uq";--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "parent_turn_id" text;--> statement-breakpoint
ALTER TABLE "run_messages" ADD COLUMN "delivery" text;--> statement-breakpoint
ALTER TABLE "run_messages" ADD COLUMN "steer_command_id" text;--> statement-breakpoint
ALTER TABLE "run_session_incarnations" ADD COLUMN "steering_supported" boolean;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_parent_turn_id_agent_turns_id_fk" FOREIGN KEY ("parent_turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_steer_command_id_execution_commands_id_fk" FOREIGN KEY ("steer_command_id") REFERENCES "public"."execution_commands"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_messages_queued_idx" ON "run_messages" USING btree ("run_id","sequence") WHERE "run_messages"."delivery" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_messages_steer_command_uq" ON "run_messages" USING btree ("steer_command_id") WHERE "run_messages"."steer_command_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_turns_active_run_uq" ON "agent_turns" USING btree ("run_id") WHERE "agent_turns"."state" IN ('claimed', 'dispatched') AND "agent_turns"."variant" <> 'steer';--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_steer_parent_check" CHECK (("agent_turns"."variant" = 'steer') = ("agent_turns"."parent_turn_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_source_check" CHECK ("agent_turns"."ordinal" >= 0
      AND "agent_turns"."variant" IN ('initial', 'resume', 'rework', 'live_message', 'persistent_message', 'consensus_draft', 'steer')
      AND length("agent_turns"."logical_key") BETWEEN 1 AND 256 AND length("agent_turns"."prompt") BETWEEN 1 AND 1000000);--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_kind_check" CHECK ("execution_commands"."kind" in ('workspace.adopt', 'workspace.release', 'session.create', 'session.prompt', 'session.input', 'session.steer', 'session.cancel', 'session.checkpoint', 'session.delete', 'runtime_object.reserve', 'runtime_object.upload', 'runtime_object.delete'));--> statement-breakpoint
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_delivery_check" CHECK ("run_messages"."delivery" IS NULL OR ("run_messages"."role" = 'user' AND "run_messages"."delivery" IN ('queued', 'prompted', 'steered')));--> statement-breakpoint
-- ADR-182 (hand-written; drizzle does not model triggers). A steer row names a
-- non-steer parent turn of the same run, carries that parent's assignment and
-- incarnation, and binds a `session.steer` command that owns no prompt and
-- names the parent's command. Every other variant keeps the 0153 rule: an
-- agent-turn-owned `session.prompt`.
CREATE OR REPLACE FUNCTION guard_agent_turn_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM runs WHERE id = NEW.run_id AND run_kind = 'agent') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_agent_run',
      MESSAGE = 'agent turn requires its agent run';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.run_id, NEW.ordinal, NEW.variant, NEW.logical_key, NEW.prompt, NEW.created_at, NEW.parent_turn_id)
      IS DISTINCT FROM ROW(OLD.id, OLD.run_id, OLD.ordinal, OLD.variant, OLD.logical_key, OLD.prompt, OLD.created_at, OLD.parent_turn_id)
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
  IF NEW.parent_turn_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_turns p
    WHERE p.id = NEW.parent_turn_id AND p.run_id = NEW.run_id AND p.variant <> 'steer'
      AND (NEW.variant <> 'steer' OR (
        p.execution_assignment_id IS NOT DISTINCT FROM NEW.execution_assignment_id
        AND p.incarnation_id IS NOT DISTINCT FROM NEW.incarnation_id))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_steer_parent_scope',
      MESSAGE = 'a steer must name a non-steer turn of its own run, on that turn''s assignment and incarnation';
  END IF;
  IF NEW.execution_assignment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM execution_assignments a JOIN run_sessions s ON s.run_id = a.run_id
    WHERE a.id = NEW.execution_assignment_id AND a.run_id = NEW.run_id
      AND a.epoch = NEW.assignment_epoch AND s.id = NEW.run_session_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_binding_scope',
      MESSAGE = 'agent turn binding must belong to its run and assignment epoch';
  END IF;
  IF NEW.command_id IS NOT NULL AND NEW.variant = 'steer' AND NOT EXISTS (
    SELECT 1 FROM execution_commands c JOIN run_session_incarnations i
      ON i.id = NEW.incarnation_id AND i.run_session_id = NEW.run_session_id
    WHERE c.id = NEW.command_id AND c.run_id = NEW.run_id
      AND c.kind = 'session.steer' AND c.owner_kind IS NULL
      AND (NEW.parent_turn_id IS NULL OR c.payload->>'parentCommandId' = (
        SELECT p.command_id FROM agent_turns p WHERE p.id = NEW.parent_turn_id
      ))
      AND c.execution_assignment_id = NEW.execution_assignment_id
      AND c.assignment_epoch = NEW.assignment_epoch
      AND i.execution_assignment_id = NEW.execution_assignment_id
      AND i.assignment_epoch = NEW.assignment_epoch
      AND i.host_session_id = c.target_session_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_command_scope',
      MESSAGE = 'agent steer command must be an owner-less session.steer naming its parent command, on its parent incarnation';
  END IF;
  IF NEW.command_id IS NOT NULL AND NEW.variant <> 'steer' AND NOT EXISTS (
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
