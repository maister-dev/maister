CREATE TABLE "agent_preparation_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"assignment_epoch" integer NOT NULL,
	"resource_id" text NOT NULL,
	"incarnation" text NOT NULL,
	"resolved_commit" text,
	"phase" text NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"generation" integer,
	"turn_id" text,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_preparation_phase_check" CHECK ("agent_preparation_operations"."phase" in ('claimed', 'checkout_ready', 'baseline_ready', 'materialized', 'handed_off', 'fenced', 'failed', 'cancelled')),
	CONSTRAINT "agent_preparation_shape_check" CHECK (("agent_preparation_operations"."assignment_epoch" > 0 AND length("agent_preparation_operations"."resource_id") = 64 AND "agent_preparation_operations"."resource_id" ~ '^[0-9a-f]{64}$' AND length("agent_preparation_operations"."incarnation") BETWEEN 1 AND 256 AND ("agent_preparation_operations"."resolved_commit" IS NULL OR "agent_preparation_operations"."resolved_commit" ~ '^[0-9a-f]{40,64}$') AND ("agent_preparation_operations"."generation" IS NULL OR "agent_preparation_operations"."generation" >= 0) AND (("agent_preparation_operations"."phase" IN ('claimed','checkout_ready','baseline_ready','materialized')) = ("agent_preparation_operations"."lease_expires_at" IS NOT NULL)) AND ("agent_preparation_operations"."phase" NOT IN ('baseline_ready','materialized','handed_off') OR "agent_preparation_operations"."generation" IS NOT NULL) AND ("agent_preparation_operations"."phase" <> 'handed_off' OR "agent_preparation_operations"."turn_id" IS NOT NULL)) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "agent_preparation_operations" ADD CONSTRAINT "agent_preparation_operations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_preparation_operations" ADD CONSTRAINT "agent_preparation_operations_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_preparation_active_resource_uq" ON "agent_preparation_operations" USING btree ("resource_id") WHERE "agent_preparation_operations"."phase" IN ('claimed','checkout_ready','baseline_ready','materialized');--> statement-breakpoint
CREATE INDEX "agent_preparation_run_idx" ON "agent_preparation_operations" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE FUNCTION guard_agent_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner execution_assignments%ROWTYPE; target runs%ROWTYPE;
BEGIN
  IF current_setting('maister.agent_preparation_writer',true) IS DISTINCT FROM 'v1' THEN
    RAISE EXCEPTION 'Agent preparation writer v1 required; stop incompatible writers under upgrade maintenance'
      USING ERRCODE='23514',CONSTRAINT='agent_preparation_writer_capability';
  END IF;
  IF TG_OP='UPDATE' AND NEW.phase IN ('claimed','checkout_ready','baseline_ready','materialized','handed_off') AND
    (OLD.lease_expires_at <= clock_timestamp() OR
      array_position(ARRAY['claimed','checkout_ready','baseline_ready','materialized','handed_off'],NEW.phase)
      < array_position(ARRAY['claimed','checkout_ready','baseline_ready','materialized','handed_off'],OLD.phase)) THEN
    RAISE EXCEPTION 'Expired or regressing preparation cannot publish'
      USING ERRCODE='23514',CONSTRAINT='agent_preparation_progress_fenced';
  END IF;
  IF TG_OP='UPDATE' AND (ROW(OLD.id,OLD.run_id,OLD.assignment_id,OLD.assignment_epoch,OLD.resource_id,OLD.incarnation,OLD.created_at)
      IS DISTINCT FROM ROW(NEW.id,NEW.run_id,NEW.assignment_id,NEW.assignment_epoch,NEW.resource_id,NEW.incarnation,NEW.created_at)
      OR OLD.resolved_commit IS NOT NULL AND OLD.resolved_commit IS DISTINCT FROM NEW.resolved_commit
      OR OLD.failure IS NOT NULL AND OLD.failure IS DISTINCT FROM NEW.failure
      OR OLD.phase IN ('handed_off','fenced','failed','cancelled')) THEN
    RAISE EXCEPTION 'Preparation identity and closed receipts are immutable'
      USING ERRCODE='23514',CONSTRAINT='agent_preparation_identity_immutable';
  END IF;
  IF NEW.phase IN ('claimed','checkout_ready','baseline_ready','materialized','handed_off') THEN
    IF NEW.phase<>'handed_off' AND NOT (NEW.lease_expires_at > clock_timestamp()
        AND NEW.lease_expires_at <= clock_timestamp() + interval '61 seconds') IS TRUE THEN
      RAISE EXCEPTION 'Active preparation requires a bounded current lease'
        USING ERRCODE='23514',CONSTRAINT='agent_preparation_lease_required';
    END IF;
    SELECT * INTO owner FROM execution_assignments WHERE id=NEW.assignment_id;
    SELECT * INTO target FROM runs WHERE id=NEW.run_id;
    IF NOT (owner.run_id=NEW.run_id AND owner.epoch=NEW.assignment_epoch AND owner.state='active'
        AND target.execution_assignment_id=owner.id AND target.status='Running') IS TRUE THEN
      RAISE EXCEPTION 'Preparation assignment has been fenced'
        USING ERRCODE='23514',CONSTRAINT='agent_preparation_assignment_required';
    END IF;
    IF NEW.phase IN ('baseline_ready','materialized','handed_off') AND NOT
      (target.operational_integrity_baseline IS NOT NULL AND (target.operational_integrity_baseline->>'generation')::int=NEW.generation) IS TRUE THEN
      RAISE EXCEPTION 'Preparation must reference a captured baseline generation'
        USING ERRCODE='23514',CONSTRAINT='agent_preparation_baseline_required';
    END IF;
    IF NEW.phase='handed_off' AND NOT EXISTS(SELECT 1 FROM agent_turns WHERE id=NEW.turn_id AND run_id=NEW.run_id
        AND execution_assignment_id=NEW.assignment_id AND assignment_epoch=NEW.assignment_epoch) THEN
      RAISE EXCEPTION 'Preparation handoff requires an owned generation turn'
        USING ERRCODE='23514',CONSTRAINT='agent_preparation_handoff_required';
    END IF;
    IF NEW.phase IN ('materialized','handed_off') AND NOT (NEW.generation > 0) IS TRUE THEN
      RAISE EXCEPTION 'Materialized preparation requires a trusted positive generation'
        USING ERRCODE='23514',CONSTRAINT='agent_preparation_generation_required';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_preparation_guard BEFORE INSERT OR UPDATE ON agent_preparation_operations
  FOR EACH ROW EXECUTE FUNCTION guard_agent_preparation();
--> statement-breakpoint
CREATE FUNCTION invalidate_agent_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='runs' THEN
    IF NEW.status NOT IN ('Running','NeedsInput') OR NEW.execution_assignment_id IS DISTINCT FROM OLD.execution_assignment_id THEN
      UPDATE agent_preparation_operations SET phase=CASE WHEN NEW.status IN ('Done','Failed','Crashed','Abandoned') THEN 'cancelled' ELSE 'fenced' END,
        lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE run_id=NEW.id AND phase IN ('claimed','checkout_ready','baseline_ready','materialized');
    END IF;
  ELSIF NEW.state<>'active' THEN
    UPDATE agent_preparation_operations SET phase='fenced',lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE assignment_id=NEW.id AND phase IN ('claimed','checkout_ready','baseline_ready','materialized');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_preparation_invalidation AFTER UPDATE OF status,execution_assignment_id ON runs
  FOR EACH ROW EXECUTE FUNCTION invalidate_agent_preparation();
--> statement-breakpoint
CREATE TRIGGER assignments_preparation_invalidation AFTER UPDATE OF state ON execution_assignments
  FOR EACH ROW EXECUTE FUNCTION invalidate_agent_preparation();
--> statement-breakpoint
CREATE FUNCTION guard_agent_preparation_writer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_kind='operational' AND NEW.status IN ('Pending','Running')
      AND current_setting('maister.agent_preparation_writer',true) IS DISTINCT FROM 'v1' THEN
    RAISE EXCEPTION 'Agent preparation writer v1 required; stop incompatible writers under upgrade maintenance'
      USING ERRCODE='23514',CONSTRAINT='agent_preparation_writer_capability';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_agent_preparation_writer BEFORE INSERT OR UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION guard_agent_preparation_writer();
