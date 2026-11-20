CREATE TABLE "agent_continuation_episodes" (
	"run_id" text NOT NULL,
	"logical_key" text NOT NULL,
	"assignment_id" text NOT NULL,
	"assignment_epoch" integer NOT NULL,
	"preparation_id" text,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"first_failure_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"claim_token" text,
	"claim_expires_at" timestamp with time zone,
	"failure" jsonb,
	"settlement_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_continuation_episodes_run_id_logical_key_pk" PRIMARY KEY("run_id","logical_key"),
	CONSTRAINT "agent_continuation_state_check" CHECK ("agent_continuation_episodes"."state" in ('eligible', 'claimed', 'backoff', 'settlement', 'attention', 'closed')),
	CONSTRAINT "agent_continuation_shape_check" CHECK ((length("agent_continuation_episodes"."logical_key") BETWEEN 1 AND 256
        AND "agent_continuation_episodes"."assignment_epoch" > 0
        AND "agent_continuation_episodes"."attempts" BETWEEN 0 AND 5
        AND "agent_continuation_episodes"."settlement_attempts" BETWEEN 0 AND 5
        AND (("agent_continuation_episodes"."claim_token" IS NULL) = ("agent_continuation_episodes"."claim_expires_at" IS NULL))
        AND ("agent_continuation_episodes"."state" <> 'claimed' OR "agent_continuation_episodes"."claim_token" IS NOT NULL)
        AND ("agent_continuation_episodes"."state" IN ('claimed','settlement') OR "agent_continuation_episodes"."claim_token" IS NULL)
        AND (("agent_continuation_episodes"."state" IN ('backoff','settlement')) = ("agent_continuation_episodes"."due_at" IS NOT NULL))
        AND ("agent_continuation_episodes"."state" NOT IN ('backoff','settlement','attention') OR "agent_continuation_episodes"."failure" IS NOT NULL)
        AND ("agent_continuation_episodes"."failure" IS NULL OR (
          jsonb_typeof("agent_continuation_episodes"."failure") = 'object'
          AND "agent_continuation_episodes"."failure"->>'code' ~ '^[A-Z_]{1,64}$'
          AND "agent_continuation_episodes"."failure"->>'reason' ~ '^[a-z_]{1,128}$'
          AND pg_column_size("agent_continuation_episodes"."failure") <= 4096
        ) IS TRUE)) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "agent_continuation_episodes" ADD CONSTRAINT "agent_continuation_episodes_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_continuation_episodes" ADD CONSTRAINT "agent_continuation_episodes_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_continuation_episodes" ADD CONSTRAINT "agent_continuation_episodes_preparation_id_agent_preparation_operations_id_fk" FOREIGN KEY ("preparation_id") REFERENCES "public"."agent_preparation_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_continuation_open_run_uq" ON "agent_continuation_episodes" USING btree ("run_id") WHERE "agent_continuation_episodes"."state" <> 'closed';--> statement-breakpoint
CREATE INDEX "agent_continuation_due_idx" ON "agent_continuation_episodes" USING btree ("due_at","run_id") WHERE "agent_continuation_episodes"."state" IN ('backoff','settlement');
--> statement-breakpoint
CREATE FUNCTION public.guard_agent_continuation_episode() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT FROM execution_assignments a
    JOIN runs r ON r.id = a.run_id
    WHERE a.id = NEW.assignment_id AND a.run_id = NEW.run_id
      AND a.epoch = NEW.assignment_epoch AND r.agent_kind = 'operational'
  ) OR (NEW.preparation_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM agent_preparation_operations p
    WHERE p.id = NEW.preparation_id AND p.run_id = NEW.run_id
      AND p.assignment_id = NEW.assignment_id AND p.assignment_epoch = NEW.assignment_epoch
  )) THEN
    RAISE EXCEPTION 'Continuation episode requires the exact operational assignment and preparation'
      USING ERRCODE='23514', CONSTRAINT='agent_continuation_owner';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    ROW(OLD.run_id, OLD.logical_key, OLD.created_at) IS DISTINCT FROM ROW(NEW.run_id, NEW.logical_key, NEW.created_at)
    OR NEW.attempts < OLD.attempts OR NEW.settlement_attempts < OLD.settlement_attempts
    OR OLD.state = 'closed'
    OR (OLD.state = 'attention' AND NEW.state NOT IN ('attention', 'settlement', 'closed'))
    OR (OLD.state = 'settlement' AND NEW.state NOT IN ('settlement', 'attention', 'closed'))
  ) THEN
    RAISE EXCEPTION 'Continuation episode cannot regress or rewrite a closed receipt'
      USING ERRCODE='23514', CONSTRAINT='agent_continuation_transition';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER agent_continuation_episode_guard
BEFORE INSERT OR UPDATE ON agent_continuation_episodes
FOR EACH ROW EXECUTE FUNCTION guard_agent_continuation_episode();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_agent_preparation_writer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.agent_kind='operational' AND NEW.status IN ('Pending','Running')
      AND current_setting('maister.agent_preparation_writer',true) IS DISTINCT FROM 'v2' THEN
    RAISE EXCEPTION 'Agent preparation writer v2 required; stop incompatible writers under upgrade maintenance'
      USING ERRCODE='23514',CONSTRAINT='agent_preparation_writer_capability';
  END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_agent_preparation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE owner execution_assignments%ROWTYPE; target runs%ROWTYPE;
BEGIN
  IF current_setting('maister.agent_preparation_writer',true) IS DISTINCT FROM 'v2' THEN
    RAISE EXCEPTION 'Agent preparation writer v2 required; stop incompatible writers under upgrade maintenance'
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
END $function$;
--> statement-breakpoint
