ALTER TABLE "agent_retry_intents" DROP CONSTRAINT "agent_retry_recipe_check";--> statement-breakpoint
ALTER TABLE "agent_retry_intents" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_retry_intents" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "agent_retry_intents" ADD CONSTRAINT "agent_retry_intents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_retry_company_idx" ON "agent_retry_intents" USING btree ("company_id","source_agent_id","created_at" DESC NULLS LAST) WHERE "agent_retry_intents"."company_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_retry_intents" ADD CONSTRAINT "agent_retry_owner_check" CHECK ((("agent_retry_intents"."project_id" IS NOT NULL AND "agent_retry_intents"."company_id" IS NULL) OR ("agent_retry_intents"."project_id" IS NULL AND "agent_retry_intents"."company_id" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "agent_retry_intents" ADD CONSTRAINT "agent_retry_recipe_check" CHECK ((jsonb_typeof("agent_retry_intents"."recipe")='object'
    AND "agent_retry_intents"."recipe"->>'agentId'="agent_retry_intents"."source_agent_id"
    AND "agent_retry_intents"."request_digest" ~ '^[a-f0-9]{64}$' AND "agent_retry_intents"."preview_fingerprint" ~ '^[a-f0-9]{64}$'
    AND pg_column_size("agent_retry_intents"."recipe")<=1048576
    AND (("agent_retry_intents"."project_id" IS NOT NULL AND "agent_retry_intents"."company_id" IS NULL
      AND "agent_retry_intents"."recipe"->'version' IN ('1'::jsonb,'2'::jsonb)
      AND ("agent_retry_intents"."recipe"->'version'='1'::jsonb OR "agent_retry_intents"."recipe"->>'strategy' IN ('pre_work_retry','fresh_qualification'))
      AND "agent_retry_intents"."recipe"->>'projectId'="agent_retry_intents"."project_id")
    OR ("agent_retry_intents"."project_id" IS NULL AND "agent_retry_intents"."company_id" IS NOT NULL
      AND "agent_retry_intents"."recipe"->'version'='3'::jsonb AND "agent_retry_intents"."recipe"->>'strategy'='pre_work_retry'
      AND "agent_retry_intents"."recipe"->'owner'=jsonb_build_object('kind','company','companyId',"agent_retry_intents"."company_id")
      AND "agent_retry_intents"."recipe" ?& ARRAY['version','strategy','owner','projectId','taskId','taskRevision','project','agentId','definition','configuration','trigger','runner','policy','contextDigest','specialistBinding','coordinatorFlowBinding','assignment']
      AND "agent_retry_intents"."recipe"-ARRAY['version','strategy','owner','projectId','taskId','taskRevision','project','agentId','definition','configuration','trigger','runner','policy','contextDigest','specialistBinding','coordinatorFlowBinding','assignment','scheduledRequestSnapshot']='{}'::jsonb
      AND "agent_retry_intents"."recipe"->'projectId'='null'::jsonb AND "agent_retry_intents"."recipe"->'project'='null'::jsonb
      AND "agent_retry_intents"."recipe"->'taskId'='null'::jsonb AND "agent_retry_intents"."recipe"->'taskRevision'='null'::jsonb
      AND "agent_retry_intents"."recipe"->>'contextDigest' ~ '^[a-f0-9]{64}$'
      AND (CASE WHEN jsonb_typeof(("agent_retry_intents"."recipe"->'specialistBinding'))='object' AND jsonb_typeof(("agent_retry_intents"."recipe"->'specialistBinding')->'revision')='number' THEN
    ("agent_retry_intents"."recipe"->'specialistBinding') ?& ARRAY['id','revision','snapshotSha256']
    AND ("agent_retry_intents"."recipe"->'specialistBinding')-ARRAY['id','revision','snapshotSha256']='{}'::jsonb
    AND jsonb_typeof(("agent_retry_intents"."recipe"->'specialistBinding')->'id')='string' AND char_length(("agent_retry_intents"."recipe"->'specialistBinding')->>'id') BETWEEN 1 AND 128
    AND (("agent_retry_intents"."recipe"->'specialistBinding')->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((("agent_retry_intents"."recipe"->'specialistBinding')->>'revision')::numeric,1)=0
    AND jsonb_typeof(("agent_retry_intents"."recipe"->'specialistBinding')->'snapshotSha256')='string' AND ("agent_retry_intents"."recipe"->'specialistBinding')->>'snapshotSha256' ~ '^[a-f0-9]{64}$'
    ELSE false END) IS TRUE
      AND (("agent_retry_intents"."recipe"->'coordinatorFlowBinding')='null'::jsonb OR (CASE WHEN jsonb_typeof(("agent_retry_intents"."recipe"->'coordinatorFlowBinding'))='object' AND jsonb_typeof(("agent_retry_intents"."recipe"->'coordinatorFlowBinding')->'revision')='number' THEN
    ("agent_retry_intents"."recipe"->'coordinatorFlowBinding') ?& ARRAY['id','revision','snapshotSha256']
    AND ("agent_retry_intents"."recipe"->'coordinatorFlowBinding')-ARRAY['id','revision','snapshotSha256']='{}'::jsonb
    AND jsonb_typeof(("agent_retry_intents"."recipe"->'coordinatorFlowBinding')->'id')='string' AND char_length(("agent_retry_intents"."recipe"->'coordinatorFlowBinding')->>'id') BETWEEN 1 AND 128
    AND (("agent_retry_intents"."recipe"->'coordinatorFlowBinding')->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((("agent_retry_intents"."recipe"->'coordinatorFlowBinding')->>'revision')::numeric,1)=0
    AND jsonb_typeof(("agent_retry_intents"."recipe"->'coordinatorFlowBinding')->'snapshotSha256')='string' AND ("agent_retry_intents"."recipe"->'coordinatorFlowBinding')->>'snapshotSha256' ~ '^[a-f0-9]{64}$'
    ELSE false END) IS TRUE)
      AND CASE WHEN jsonb_typeof(("agent_retry_intents"."recipe"->'assignment'))='object' AND jsonb_typeof(("agent_retry_intents"."recipe"->'assignment')->'inputRevision')='number' THEN
        ("agent_retry_intents"."recipe"->'assignment') ?& ARRAY['id','inputRevision','inputSha256']
        AND ("agent_retry_intents"."recipe"->'assignment')-ARRAY['id','inputRevision','inputSha256']='{}'::jsonb
        AND jsonb_typeof(("agent_retry_intents"."recipe"->'assignment')->'id')='string' AND char_length(("agent_retry_intents"."recipe"->'assignment')->>'id') BETWEEN 1 AND 128
        AND (("agent_retry_intents"."recipe"->'assignment')->>'inputRevision')::numeric BETWEEN 1 AND 2147483647 AND mod((("agent_retry_intents"."recipe"->'assignment')->>'inputRevision')::numeric,1)=0
        AND ("agent_retry_intents"."recipe"->'assignment')->>'inputSha256' ~ '^[a-f0-9]{64}$'
        ELSE false END))) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_agent_retry_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state IN ('accepted','launched') OR
       (OLD.allocation IS NOT NULL AND OLD.allocation->>'disposition' <> 'released') THEN
      RAISE EXCEPTION 'retry intent retains admission or disposal evidence'
        USING ERRCODE = '23514', CONSTRAINT = 'agent_retry_evidence_protected';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.company_id, NEW.project_id, NEW.source_agent_id, NEW.source_run_id,
         NEW.actor_identity, NEW.request_key, NEW.request_digest,
         NEW.selected_runner_id, NEW.recipe, NEW.preview_fingerprint, NEW.successor_run_id)
     IS DISTINCT FROM
     ROW(OLD.company_id, OLD.project_id, OLD.source_agent_id, OLD.source_run_id,
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
CREATE FUNCTION check_company_retry_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_id IS NULL THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.recipe->'specialistBinding'->'revision') IS DISTINCT FROM 'number' OR
     jsonb_typeof(NEW.recipe->'assignment'->'inputRevision') IS DISTINCT FROM 'number' OR
     (NEW.recipe->'coordinatorFlowBinding'<>'null'::jsonb AND jsonb_typeof(NEW.recipe->'coordinatorFlowBinding'->'revision') IS DISTINCT FROM 'number') THEN
    RAISE EXCEPTION 'company retry configuration and input revisions must be numbers'
      USING ERRCODE='23514', CONSTRAINT='company_retry_reference_check';
  END IF;
  IF NEW.actor_user_id IS NULL OR NEW.actor_identity <> 'user:' || NEW.actor_user_id OR NOT EXISTS (
    SELECT 1 FROM company_specialist_bindings b
    JOIN company_specialist_binding_revisions r ON r.binding_id=b.id
      AND r.revision::numeric=(NEW.recipe->'specialistBinding'->>'revision')::numeric
    JOIN specialist_assignments a ON a.id=NEW.recipe->'assignment'->>'id'
      AND a.company_id=b.company_id AND a.project_id IS NULL AND a.specialist_binding_id=b.id
    JOIN specialist_input_revisions i ON i.assignment_id=a.id
      AND i.revision::numeric=(NEW.recipe->'assignment'->>'inputRevision')::numeric
    WHERE b.id=NEW.recipe->'specialistBinding'->>'id' AND b.company_id=NEW.company_id
      AND b.agent_id=NEW.source_agent_id AND r.snapshot_digest=NEW.recipe->'specialistBinding'->>'snapshotSha256'
      AND i.digest=NEW.recipe->'assignment'->>'inputSha256'
      AND r.snapshot->'definition'=NEW.recipe->'definition'->'parsed'
      AND r.snapshot->>'packageInstallId'=NEW.recipe->'definition'->>'packageInstallId'
      AND r.snapshot->>'packageRevision'=NEW.recipe->'definition'->>'resolvedRevision'
      AND r.snapshot->'effectiveConfiguration'=NEW.recipe->'configuration'
      AND i.standing_definition->'definition'=r.snapshot->'definition'
      AND i.scheduled_request IS NOT DISTINCT FROM NULLIF(NEW.recipe->'scheduledRequestSnapshot','null'::jsonb)
  ) THEN
    RAISE EXCEPTION 'company retry must retain its owned exact specialist configuration and assignment input'
      USING ERRCODE='23514', CONSTRAINT='company_retry_reference_check';
  END IF;
  IF NEW.recipe->'coordinatorFlowBinding'<>'null'::jsonb AND NOT EXISTS (
    SELECT 1 FROM company_flow_bindings b JOIN company_flow_binding_revisions r ON r.binding_id=b.id
      AND r.revision::numeric=(NEW.recipe->'coordinatorFlowBinding'->>'revision')::numeric
    WHERE b.id=NEW.recipe->'coordinatorFlowBinding'->>'id' AND b.company_id=NEW.company_id
      AND r.snapshot_digest=NEW.recipe->'coordinatorFlowBinding'->>'snapshotSha256'
      AND r.snapshot->>'specialistBindingId'=NEW.recipe->'specialistBinding'->>'id'
      AND (r.snapshot->>'specialistRevision')::numeric=(NEW.recipe->'specialistBinding'->>'revision')::numeric
  ) THEN
    RAISE EXCEPTION 'company retry must retain its owned exact coordinator configuration'
      USING ERRCODE='23514', CONSTRAINT='company_retry_coordinator_reference_check';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER company_retry_scope_guard BEFORE INSERT ON agent_retry_intents
FOR EACH ROW EXECUTE FUNCTION check_company_retry_scope();
