ALTER TABLE "agent_trigger_attempts" DROP CONSTRAINT "agent_trigger_attempt_shape_check";--> statement-breakpoint
ALTER TABLE "agent_schedules" DROP CONSTRAINT "agent_schedules_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_schedules" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_trigger_attempts" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "project_agent_id" text GENERATED ALWAYS AS (CASE WHEN project_id IS NOT NULL THEN agent_id ELSE NULL END) STORED;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "company_specialist_binding_id" text;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "company_flow_binding_id" text;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "company_config_revision" integer;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "creation_key" text;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "creation_digest" text;--> statement-breakpoint
ALTER TABLE "agent_trigger_attempts" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_project_agent_fk" FOREIGN KEY ("project_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_company_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_company_specialist_fk" FOREIGN KEY ("company_specialist_binding_id") REFERENCES "public"."company_specialist_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_company_flow_fk" FOREIGN KEY ("company_flow_binding_id") REFERENCES "public"."company_flow_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_trigger_attempts" ADD CONSTRAINT "agent_trigger_attempts_company_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_schedules_company_creation_uq" ON "agent_schedules" USING btree ("company_id","created_by","creation_key") WHERE "agent_schedules"."company_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_schedules_company_agent_idx" ON "agent_schedules" USING btree ("company_id","agent_id","id");--> statement-breakpoint
CREATE INDEX "agent_schedules_project_due_idx" ON "agent_schedules" USING btree ("next_fire_at","id") WHERE "agent_schedules"."project_id" IS NOT NULL AND "agent_schedules"."trigger_type"='cron' AND "agent_schedules"."enabled"=true;--> statement-breakpoint
CREATE INDEX "agent_schedules_company_due_idx" ON "agent_schedules" USING btree ("company_id","next_fire_at","id") WHERE "agent_schedules"."company_id" IS NOT NULL AND "agent_schedules"."trigger_type"='cron' AND "agent_schedules"."enabled"=true;--> statement-breakpoint
CREATE INDEX "agent_trigger_attempt_company_history_idx" ON "agent_trigger_attempts" USING btree ("company_id","source_agent_id","claimed_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "agent_trigger_attempts"."company_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_trigger_attempt_project_due_idx" ON "agent_trigger_attempts" USING btree ("due_at","id") WHERE "agent_trigger_attempts"."project_id" IS NOT NULL AND ("agent_trigger_attempts"."outcome" IS NULL OR "agent_trigger_attempts"."outcome"='unknown');--> statement-breakpoint
CREATE INDEX "agent_trigger_attempt_company_due_idx" ON "agent_trigger_attempts" USING btree ("company_id","due_at","id") WHERE "agent_trigger_attempts"."company_id" IS NOT NULL AND ("agent_trigger_attempts"."outcome" IS NULL OR "agent_trigger_attempts"."outcome"='unknown');--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_owner_check" CHECK ((("agent_schedules"."project_id" IS NOT NULL AND "agent_schedules"."company_id" IS NULL AND "agent_schedules"."company_specialist_binding_id" IS NULL AND "agent_schedules"."company_flow_binding_id" IS NULL AND "agent_schedules"."company_config_revision" IS NULL AND "agent_schedules"."created_by" IS NULL AND "agent_schedules"."creation_key" IS NULL AND "agent_schedules"."creation_digest" IS NULL) OR ("agent_schedules"."project_id" IS NULL AND "agent_schedules"."company_id" IS NOT NULL AND "agent_schedules"."company_specialist_binding_id" IS NOT NULL AND "agent_schedules"."company_config_revision">0 AND char_length("agent_schedules"."created_by") BETWEEN 1 AND 192 AND "agent_schedules"."creation_key" ~ '^[A-Za-z0-9._:-]{8,128}$' AND "agent_schedules"."creation_digest" ~ '^[a-f0-9]{64}$' AND "agent_schedules"."trigger_type" IN ('cron','event'))) IS TRUE);--> statement-breakpoint
ALTER TABLE "agent_trigger_attempts" ADD CONSTRAINT "agent_trigger_attempt_shape_check" CHECK (("agent_trigger_attempts"."fence" > 0 AND "agent_trigger_attempts"."trigger_source" IN ('cron','domain_event') AND "agent_trigger_attempts"."provenance" IN ('claim','legacy_latest') AND jsonb_typeof("agent_trigger_attempts"."binding_snapshot") = 'object' AND (("agent_trigger_attempts"."project_id" IS NOT NULL AND "agent_trigger_attempts"."company_id" IS NULL AND "agent_trigger_attempts"."binding_snapshot"->'version'='1'::jsonb)
    OR ("agent_trigger_attempts"."project_id" IS NULL AND "agent_trigger_attempts"."company_id" IS NOT NULL AND CASE WHEN jsonb_typeof("agent_trigger_attempts"."binding_snapshot")='object' AND jsonb_typeof("agent_trigger_attempts"."binding_snapshot"->'sourceRevision')='number' THEN
      "agent_trigger_attempts"."binding_snapshot"->'version'='2'::jsonb
      AND "agent_trigger_attempts"."binding_snapshot" ?& ARRAY['version','scheduleId','triggerType','cronExpr','timezone','eventKinds','owner','sourceRevision','specialistBinding','coordinatorFlowBinding']
      AND "agent_trigger_attempts"."binding_snapshot"-ARRAY['version','scheduleId','triggerType','cronExpr','timezone','eventKinds','owner','sourceRevision','specialistBinding','coordinatorFlowBinding']='{}'::jsonb
      AND "agent_trigger_attempts"."binding_snapshot"->'owner'=jsonb_build_object('kind','company','companyId',"agent_trigger_attempts"."company_id")
      AND "agent_trigger_attempts"."binding_snapshot"->>'triggerType' IN ('cron','event')
      AND ("agent_trigger_attempts"."binding_snapshot"->>'sourceRevision')::numeric BETWEEN 1 AND 2147483647 AND mod(("agent_trigger_attempts"."binding_snapshot"->>'sourceRevision')::numeric,1)=0
      AND (CASE WHEN jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'specialistBinding'))='object' AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')->'revision')='number' THEN
    ("agent_trigger_attempts"."binding_snapshot"->'specialistBinding') ?& ARRAY['id','revision','snapshotSha256']
    AND ("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')-ARRAY['id','revision','snapshotSha256']='{}'::jsonb
    AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')->'id')='string' AND char_length(("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')->>'id') BETWEEN 1 AND 128
    AND (("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')->>'revision')::numeric,1)=0
    AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')->'snapshotSha256')='string' AND ("agent_trigger_attempts"."binding_snapshot"->'specialistBinding')->>'snapshotSha256' ~ '^[a-f0-9]{64}$'
    ELSE false END) IS TRUE
      AND (("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')='null'::jsonb OR (CASE WHEN jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding'))='object' AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')->'revision')='number' THEN
    ("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding') ?& ARRAY['id','revision','snapshotSha256']
    AND ("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')-ARRAY['id','revision','snapshotSha256']='{}'::jsonb
    AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')->'id')='string' AND char_length(("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')->>'id') BETWEEN 1 AND 128
    AND (("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')->>'revision')::numeric,1)=0
    AND jsonb_typeof(("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')->'snapshotSha256')='string' AND ("agent_trigger_attempts"."binding_snapshot"->'coordinatorFlowBinding')->>'snapshotSha256' ~ '^[a-f0-9]{64}$'
    ELSE false END) IS TRUE)
      AND jsonb_typeof("agent_trigger_attempts"."binding_snapshot"->'eventKinds')='array'
      AND pg_column_size("agent_trigger_attempts"."binding_snapshot")<=8192
      ELSE false END)) IS TRUE AND "agent_trigger_attempts"."binding_snapshot"->>'scheduleId' = "agent_trigger_attempts"."schedule_id" AND (("agent_trigger_attempts"."settled_at" IS NULL AND "agent_trigger_attempts"."outcome" IS NULL) OR ("agent_trigger_attempts"."settled_at" IS NOT NULL AND "agent_trigger_attempts"."outcome" IN ('launched','queued','refused','deduplicated','suppressed','failed','unknown'))) AND ("agent_trigger_attempts"."run_id" IS NULL OR "agent_trigger_attempts"."original_run_id" = "agent_trigger_attempts"."run_id")) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION guard_agent_schedule_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE role company_specialist_bindings;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.company_id IS NOT NULL THEN
      RAISE EXCEPTION 'Disable a company source while retaining its creation receipt and invocation identity' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.id,NEW.project_id,NEW.company_id,NEW.created_by,NEW.creation_key,NEW.creation_digest,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.project_id,OLD.company_id,OLD.created_by,OLD.creation_key,OLD.creation_digest,OLD.created_at) THEN
    RAISE EXCEPTION 'Agent schedule ownership and original creation receipt are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.company_id IS NOT NULL THEN
    IF TG_OP='INSERT' AND NEW.company_config_revision<>1 THEN
      RAISE EXCEPTION 'Company source configuration starts at revision one' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' THEN
      IF (NEW.agent_id,NEW.company_specialist_binding_id,NEW.company_flow_binding_id,NEW.trigger_type,NEW.request_at_launch,NEW.cron_expr,NEW.timezone,NEW.event_match,NEW.enabled)
        IS DISTINCT FROM (OLD.agent_id,OLD.company_specialist_binding_id,OLD.company_flow_binding_id,OLD.trigger_type,OLD.request_at_launch,OLD.cron_expr,OLD.timezone,OLD.event_match,OLD.enabled) THEN
        IF NEW.company_config_revision<>OLD.company_config_revision+1 THEN
          RAISE EXCEPTION 'Company source input changes require one configuration revision; telemetry has its own fence' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.company_config_revision IS DISTINCT FROM OLD.company_config_revision THEN
        RAISE EXCEPTION 'Company source telemetry cannot advance configuration revision' USING ERRCODE='23514';
      END IF;
    END IF;
    SELECT * INTO role FROM company_specialist_bindings WHERE id=NEW.company_specialist_binding_id;
    IF role.id IS NULL OR role.company_id IS DISTINCT FROM NEW.company_id OR role.agent_id IS DISTINCT FROM NEW.agent_id THEN
      RAISE EXCEPTION 'Company source specialist must match its explicit company and professional role' USING ERRCODE='23514';
    END IF;
    IF NEW.company_flow_binding_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company_flow_bindings f WHERE f.id=NEW.company_flow_binding_id AND f.company_id=NEW.company_id) THEN
      RAISE EXCEPTION 'Company source coordinator must have the same owner' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_schedule_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_schedules FOR EACH ROW EXECUTE FUNCTION guard_agent_schedule_scope();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_agent_trigger_attempt_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.project_id,NEW.company_id,NEW.source_agent_id,NEW.schedule_id,NEW.binding_snapshot,
         NEW.fence,NEW.delivery_key,NEW.trigger_source,NEW.trigger_event_id,
         NEW.provenance,NEW.reserved_run_id,NEW.claimed_at,NEW.scheduled_request_snapshot)
     IS DISTINCT FROM
     ROW(OLD.project_id,OLD.company_id,OLD.source_agent_id,OLD.schedule_id,OLD.binding_snapshot,
         OLD.fence,OLD.delivery_key,OLD.trigger_source,OLD.trigger_event_id,
         OLD.provenance,OLD.reserved_run_id,OLD.claimed_at,OLD.scheduled_request_snapshot) THEN
    RAISE EXCEPTION 'agent trigger attempt identity is immutable for %', OLD.id
      USING ERRCODE='23514', CONSTRAINT='agent_trigger_attempt_identity_immutable';
  END IF;
  IF OLD.outcome IS NOT NULL AND OLD.outcome<>'unknown' AND
     ROW(NEW.outcome,NEW.settled_at,NEW.original_run_id,NEW.reason_code)
       IS DISTINCT FROM ROW(OLD.outcome,OLD.settled_at,OLD.original_run_id,OLD.reason_code) THEN
    RAISE EXCEPTION 'settled agent trigger attempt is immutable for %', OLD.id
      USING ERRCODE='23514', CONSTRAINT='agent_trigger_attempt_settlement_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION check_company_trigger_attempt_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source agent_schedules;
BEGIN
  IF NEW.company_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO source FROM agent_schedules WHERE id=NEW.schedule_id;
  IF source.id IS NULL OR source.project_id IS NOT NULL OR source.company_id IS DISTINCT FROM NEW.company_id OR source.agent_id IS DISTINCT FROM NEW.source_agent_id OR source.last_attempt_fence IS DISTINCT FROM NEW.fence OR
     NEW.binding_snapshot->>'triggerType' IS DISTINCT FROM source.trigger_type OR
     (NEW.binding_snapshot->>'sourceRevision')::numeric IS DISTINCT FROM source.company_config_revision::numeric OR
     NEW.binding_snapshot->'specialistBinding'->>'id' IS DISTINCT FROM source.company_specialist_binding_id OR
     NEW.binding_snapshot->'coordinatorFlowBinding'->>'id' IS DISTINCT FROM source.company_flow_binding_id OR
     NEW.binding_snapshot->>'cronExpr' IS DISTINCT FROM source.cron_expr OR
     NEW.binding_snapshot->>'timezone' IS DISTINCT FROM source.timezone OR
     NEW.binding_snapshot->'eventKinds' IS DISTINCT FROM COALESCE(source.event_match->'kinds','[]'::jsonb) OR
     (source.trigger_type='cron') IS DISTINCT FROM (NEW.trigger_source='cron') OR
     (source.trigger_type='cron') IS DISTINCT FROM (NEW.trigger_event_id IS NULL) THEN
    RAISE EXCEPTION 'Company invocation must preserve its exact source identity and configuration' USING ERRCODE='23514';
  END IF;
  IF source.trigger_type='cron' AND (NEW.scheduled_request_snapshot IS NULL OR NEW.scheduled_request_snapshot->>'requestAtLaunch' IS DISTINCT FROM source.request_at_launch) THEN
    RAISE EXCEPTION 'Company cron invocation must retain its actual version-one request input' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM company_specialist_binding_revisions r JOIN company_specialist_bindings b ON b.id=r.binding_id
    WHERE b.id=source.company_specialist_binding_id AND b.company_id=NEW.company_id AND b.agent_id=NEW.source_agent_id
      AND r.revision::numeric=(NEW.binding_snapshot->'specialistBinding'->>'revision')::numeric
      AND r.snapshot_digest=NEW.binding_snapshot->'specialistBinding'->>'snapshotSha256') THEN
    RAISE EXCEPTION 'Company invocation professional configuration witness is unavailable' USING ERRCODE='23514';
  END IF;
  IF source.company_flow_binding_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company_flow_binding_revisions r JOIN company_flow_bindings b ON b.id=r.binding_id
    WHERE b.id=source.company_flow_binding_id AND b.company_id=NEW.company_id
      AND r.revision::numeric=(NEW.binding_snapshot->'coordinatorFlowBinding'->>'revision')::numeric
      AND r.snapshot_digest=NEW.binding_snapshot->'coordinatorFlowBinding'->>'snapshotSha256') THEN
    RAISE EXCEPTION 'Company invocation coordinator configuration witness is unavailable' USING ERRCODE='23514';
  END IF;
  IF NEW.trigger_source='domain_event' AND NOT EXISTS(SELECT 1 FROM domain_events e WHERE e.id=NEW.trigger_event_id AND e.company_id=NEW.company_id AND e.project_id IS NULL) THEN
    RAISE EXCEPTION 'Company invocation event must have the same explicit owner' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER company_trigger_attempt_scope_guard BEFORE INSERT ON agent_trigger_attempts FOR EACH ROW EXECUTE FUNCTION check_company_trigger_attempt_scope();
