CREATE TABLE "agent_retry_intents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"project_id" text NOT NULL,
	"source_agent_id" text NOT NULL,
	"source_run_id" text NOT NULL,
	"actor_identity" text NOT NULL,
	"actor_user_id" text,
	"request_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"selected_runner_id" text NOT NULL,
	"recipe" jsonb NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"successor_run_id" text NOT NULL,
	"created_run_id" text,
	"state" text DEFAULT 'accepted' NOT NULL,
	"refusal_reason" text,
	"lease_owner" text,
	"lease_fence" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"allocation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_retry_actor_request_uq" UNIQUE("actor_identity","request_key"),
	CONSTRAINT "agent_retry_successor_uq" UNIQUE("successor_run_id"),
	CONSTRAINT "agent_retry_recipe_check" CHECK ((jsonb_typeof("agent_retry_intents"."recipe") = 'object' AND "agent_retry_intents"."recipe"->'version' = '1'::jsonb AND "agent_retry_intents"."recipe"->>'agentId' = "agent_retry_intents"."source_agent_id" AND "agent_retry_intents"."recipe"->>'projectId' = "agent_retry_intents"."project_id" AND "agent_retry_intents"."request_digest" ~ '^[a-f0-9]{64}$' AND "agent_retry_intents"."preview_fingerprint" ~ '^[a-f0-9]{64}$' AND pg_column_size("agent_retry_intents"."recipe") <= 1048576) IS TRUE),
	CONSTRAINT "agent_retry_state_check" CHECK ("agent_retry_intents"."state" IN ('accepted','launched','refused') AND "agent_retry_intents"."attempts" BETWEEN 0 AND 3 AND "agent_retry_intents"."lease_fence" >= 0 AND (("agent_retry_intents"."lease_owner" IS NULL) = ("agent_retry_intents"."lease_expires_at" IS NULL)) AND ("agent_retry_intents"."state" <> 'refused' OR "agent_retry_intents"."refusal_reason" IS NOT NULL) AND ("agent_retry_intents"."created_run_id" IS NULL OR ("agent_retry_intents"."state" = 'launched' AND "agent_retry_intents"."created_run_id" = "agent_retry_intents"."successor_run_id"))),
	CONSTRAINT "agent_retry_allocation_check" CHECK ("agent_retry_intents"."allocation" IS NULL OR (jsonb_typeof("agent_retry_intents"."allocation") = 'object' AND "agent_retry_intents"."allocation"->'version' = '1'::jsonb AND "agent_retry_intents"."allocation"->>'disposition' IN ('armed','released','exhausted') AND jsonb_typeof("agent_retry_intents"."allocation"->'resources') = 'array' AND pg_column_size("agent_retry_intents"."allocation") <= 1048576) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "retry_of_run_id" text;--> statement-breakpoint
ALTER TABLE "agent_retry_intents" ADD CONSTRAINT "agent_retry_intents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_retry_intents" ADD CONSTRAINT "agent_retry_intents_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_retry_intents" ADD CONSTRAINT "agent_retry_intents_created_run_id_runs_id_fk" FOREIGN KEY ("created_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_retry_source_claim_uq" ON "agent_retry_intents" USING btree ("source_run_id") WHERE "agent_retry_intents"."state" IN ('accepted','launched') OR ("agent_retry_intents"."allocation" IS NOT NULL AND "agent_retry_intents"."allocation"->>'disposition' <> 'released');--> statement-breakpoint
CREATE INDEX "agent_retry_due_idx" ON "agent_retry_intents" USING btree ("due_at","id") WHERE "agent_retry_intents"."state" = 'accepted';--> statement-breakpoint
CREATE INDEX "agent_retry_agent_idx" ON "agent_retry_intents" USING btree ("project_id","source_agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "runs_agent_retry_child_uq" ON "runs" USING btree ("retry_of_run_id") WHERE "runs"."retry_of_run_id" IS NOT NULL;--> statement-breakpoint
CREATE FUNCTION guard_agent_retry_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state IN ('accepted','launched') OR
       (OLD.allocation IS NOT NULL AND OLD.allocation->>'disposition' <> 'released') THEN
      RAISE EXCEPTION 'retry intent retains admission or disposal evidence'
        USING ERRCODE = '23514', CONSTRAINT = 'agent_retry_evidence_protected';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.project_id, NEW.source_agent_id, NEW.source_run_id,
         NEW.actor_identity, NEW.request_key, NEW.request_digest,
         NEW.selected_runner_id, NEW.recipe, NEW.preview_fingerprint, NEW.successor_run_id)
     IS DISTINCT FROM
     ROW(OLD.project_id, OLD.source_agent_id, OLD.source_run_id,
         OLD.actor_identity, OLD.request_key, OLD.request_digest,
         OLD.selected_runner_id, OLD.recipe, OLD.preview_fingerprint, OLD.successor_run_id) THEN
    RAISE EXCEPTION 'accepted retry recipe is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_retry_recipe_immutable';
  END IF;
  IF NEW.lease_fence < OLD.lease_fence OR
     (OLD.state IN ('launched','refused') AND NEW.state <> OLD.state) THEN
    RAISE EXCEPTION 'retry ownership or receipt cannot move backwards'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_retry_receipt_monotonic';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_retry_recipe_immutable BEFORE UPDATE OR DELETE ON agent_retry_intents
FOR EACH ROW EXECUTE FUNCTION guard_agent_retry_intent();
--> statement-breakpoint
CREATE FUNCTION guard_agent_retry_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.retry_of_run_id IS NOT NULL AND NEW.retry_of_run_id IS DISTINCT FROM OLD.retry_of_run_id THEN
    RAISE EXCEPTION 'retry lineage is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'runs_agent_retry_lineage_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runs_agent_retry_lineage_immutable BEFORE UPDATE ON runs
FOR EACH ROW EXECUTE FUNCTION guard_agent_retry_lineage();
