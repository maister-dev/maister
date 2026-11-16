ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_company_kind_check";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_operational_cleanup_check";--> statement-breakpoint
DROP INDEX "runs_operational_cleanup_due_idx";--> statement-breakpoint
CREATE INDEX "runs_operational_cleanup_due_idx" ON "runs" USING btree (("operational_cleanup"->>'dueAt'),"id") WHERE ("runs"."agent_kind" = 'operational' OR ("runs"."run_kind"='flow' AND "runs"."company_id" IS NOT NULL AND "runs"."project_id" IS NULL AND "runs"."agent_kind" IS NULL AND "runs"."agent_workspace"='none' AND "runs"."company_execution_snapshot"->>'schemaVersion'='2' AND "runs"."result_contract"->>'kind'='flow_export' AND "runs"."result_contract"->'required'='true'::jsonb)) AND "runs"."operational_cleanup"->>'state' IN ('armed','retry','removed','preserving');--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_company_kind_check" CHECK (("domain_events"."company_id" IS NULL OR ("domain_events"."task_id" IS NULL AND (("domain_events"."kind" IN ('knowledge.record_changed','specialist.assignment_changed') AND "domain_events"."run_id" IS NULL) OR ("domain_events"."kind" IN ('run.done','run.failed','run.crashed','run.abandoned','run.needs_input','run.escalated','run.operational_attention_acknowledged','run.operational_cleanup_changed') AND "domain_events"."run_id" IS NOT NULL)))) IS TRUE);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_operational_cleanup_check" CHECK ("runs"."operational_cleanup" IS NULL OR (("runs"."agent_kind" = 'operational' OR ("runs"."run_kind"='flow' AND "runs"."company_id" IS NOT NULL AND "runs"."project_id" IS NULL AND "runs"."agent_kind" IS NULL AND "runs"."agent_workspace"='none' AND "runs"."company_execution_snapshot"->>'schemaVersion'='2' AND "runs"."result_contract"->>'kind'='flow_export' AND "runs"."result_contract"->'required'='true'::jsonb)) AND jsonb_typeof("runs"."operational_cleanup") = 'object' AND "runs"."operational_cleanup"->'version' = '1'::jsonb AND "runs"."operational_cleanup"->>'state' IN ('retained','armed','preserving','removed','released','retry','exhausted') AND "runs"."operational_cleanup"->>'resourceKind' IN ('worktree','ephemeral_checkout','plain_directory','shared_repository') AND "runs"."operational_cleanup"->>'workspace' IN ('none','repo_read','worktree') AND "runs"."operational_cleanup"->'attempts' IN ('0'::jsonb,'1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb) AND jsonb_typeof("runs"."operational_cleanup"->'revision') = 'number' AND "runs"."operational_cleanup"->>'revision' ~ '^[1-9][0-9]*$' AND jsonb_typeof("runs"."operational_cleanup"->'evidenceIds') = 'array' AND ("runs"."operational_cleanup"->'lease' = 'null'::jsonb OR jsonb_typeof("runs"."operational_cleanup"->'lease') = 'object' AND "runs"."operational_cleanup"->'lease' ?& array['id','owner','expiresAt']) AND ("runs"."operational_cleanup"->>'state' <> 'released' OR jsonb_typeof("runs"."operational_cleanup"->'releasedAt') = 'string') AND ("runs"."operational_cleanup"->>'state' NOT IN ('removed','released') OR jsonb_typeof("runs"."operational_cleanup"->'removedAt') = 'string')) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION check_company_run_domain_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.company_id IS NOT NULL OR NEW.company_id IS NOT NULL) AND
     ROW(NEW.company_id,NEW.project_id,NEW.run_id,NEW.task_id,NEW.kind) IS DISTINCT FROM
     ROW(OLD.company_id,OLD.project_id,OLD.run_id,OLD.task_id,OLD.kind) THEN
    RAISE EXCEPTION 'Company event ownership and kind are immutable'
      USING ERRCODE='23514', CONSTRAINT='domain_events_company_identity_check';
  END IF;
  IF NEW.company_id IS NOT NULL AND NEW.run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runs execution WHERE execution.id=NEW.run_id
      AND execution.company_id=NEW.company_id AND execution.project_id IS NULL
      AND execution.company_execution_snapshot IS NOT NULL
      AND (
        (execution.run_kind='agent' AND execution.agent_kind='operational')
        OR (
          execution.run_kind='flow' AND execution.agent_kind IS NULL
          AND execution.company_execution_snapshot->>'schemaVersion'='2'
          AND execution.company_execution_snapshot->>'executionKind'='flow'
          AND execution.agent_workspace='none' AND execution.persistent=false
          AND execution.task_id IS NULL AND execution.flow_id IS NULL
          AND execution.result_contract->>'kind'='flow_export'
          AND execution.result_contract->'required'='true'::jsonb
          AND execution.result_contract->>'flowRevisionId'=execution.flow_revision_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'Company run facts require the exact retained execution owner'
      USING ERRCODE='23514', CONSTRAINT='domain_events_company_run_reference_check';
  END IF;
  RETURN NEW;
END $$;
